/**
 * cloudflared 快速隧道（Quick Tunnel）的生命周期管理。
 *
 * ## 为什么用快速隧道
 *
 * 免账号、免域名、免证书，`trycloudflare.com` 的随机子域名开箱即用。
 * 代价是**域名每次启动都变**，而且官方明确不支持 SSE、单隧道最多 200 个并发请求、
 * 没有可用性保证——所以这里做三件事：解析地址、崩溃重启、状态可查。
 *
 * 域名变化不需要用户关心：地址一旦拿到就上报给 rendezvous，手机端自己会跟上。
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { STATE_DIR, wireLog } from './log.js';

/**
 * 从 cloudflared 输出里抓随机域名。
 *
 * `(?!api\.)` 不是多余的：cloudflared 在**请求隧道失败**时会打印
 * `ERR Failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": ...`，
 * 这一行同样以 `.trycloudflare.com` 结尾。不加排除就会把 API 端点当成隧道地址
 * 上报给中转，手机端拿到它必然 `fetch failed`——而且界面看起来一切正常，
 * 极难查。这个坑真的踩了。
 */
export const URL_PATTERN = /https:\/\/(?!api\.)[a-z0-9][a-z0-9-]*\.trycloudflare\.com/;

/** 重启退避上限。 */
const RESTART_MAX_MS = 30_000;

/**
 * 管理一个快速隧道进程。
 */
export class QuickTunnel {
	/**
	 * @param {{command?: string, localUrl: string, onUrl?: (url: string) => void, onFailure?: (reason: string) => void, onUnverified?: (url: string) => void, onOutput?: (text: string) => void}} options
	 *   `command` 是 cloudflared 可执行文件路径（默认走 PATH）。
	 */
	constructor(options) {
		this.command = options.command ?? 'cloudflared';
		// 空配置文件：用来把 cloudflared 从用户的全局配置里隔离出来（原因见 spawnOnce）。
		this.isolatedConfig = join(STATE_DIR, 'cloudflared-quick.yml');
		try {
			mkdirSync(STATE_DIR, { recursive: true });
			writeFileSync(
				this.isolatedConfig,
				'# dsh-wire 生成：刻意留空，强制 cloudflared 走快速隧道，不受全局配置影响\n',
				{ mode: 0o600 }
			);
		} catch (error) {
			wireLog(`[tunnel] 写隔离配置失败: ${error?.message ?? error}`);
		}
		this.localUrl = options.localUrl;
		this.onUrl = options.onUrl;
		this.onFailure = options.onFailure;
		this.onUnverified = options.onUnverified;
		this.onOutput = options.onOutput;
		this.url = undefined;
		/** @type {import('node:child_process').ChildProcess | null} */
		this.child = null;
		this.stopped = false;
		this.attempt = 0;
		/** 自检重试次数与间隔。做成属性是为了测试能调小，不用等 30 秒。 */
		this.verifyAttempts = 6;
		this.verifyDelayMs = 5_000;
		/**
		 * cloudflared 最近说的话（截断保存）。
		 *
		 * 出问题的时候，"它到底说了什么"是唯一能定位的东西，而之前的实现
		 * 只扫地址、把其余输出全丢了——用户在界面上看到「还没建立」，
		 * 我在日志里也什么都看不到。现在留着，失败时一并写进日志。
		 */
		this.recentOutput = '';
		/** 平台。做成属性是为了测试能模拟 Windows 的 .cmd 场景。 */
		this.platform = process.platform;
		/** 隧道传输协议。http2 走 TCP 443，比默认的 QUIC（UDP）抗封得多。 */
		this.protocol = 'http2';
		/** 启动后多久还没拿到地址就认为失败。 */
		this.startupTimeoutMs = 30_000;
		/** 有新的输出就叫一声，让界面能实时看到 cloudflared 在做什么。 */
		this.onOutput = null;
		/** 上次上报输出的时间，用来节流。 */
		this.lastOutputAt = 0;
		/** @type {NodeJS.Timeout | null} */
		this.startupTimer = null;
		/** @type {NodeJS.Timeout | null} */
		this.restartTimer = null;
	}

	/**
	 * 启动隧道。失败会按退避自动重试，调用方不需要自己重试。
	 * @returns {void}
	 */
	start() {
		this.stopped = false;
		this.spawnOnce();
	}

	/** 拉起一次进程。 */
	spawnOnce() {
		if (this.stopped) return;
		wireLog(`[tunnel] 启动 ${this.command} tunnel --url ${this.localUrl} --protocol ${this.protocol}`);
		let child;
		try {
			// `--config` 指向一个空文件是**故意的**，不是冗余参数：
		// 用户机器上如果存在全局 cloudflared 配置（/etc/cloudflared/config.yml 或 ~/.cloudflared/），
		// `tunnel --url` 会被那份配置接管，转而去连命名隧道——进程照样打印一个
		// trycloudflare.com 地址、照样显示"连接成功"，但那个地址指向别人的隧道，访问一律 404。
		// 这个失败方式极其隐蔽（我在这台机器上就被坑了一次），所以这里强制隔离。
		// 默认走 http2（443/TCP），不用 cloudflared 默认的 QUIC（UDP）。
		//
		// QUIC 在很多网络上会被静默丢弃——尤其是国内家宽、公司网、校园网。
		// 这种丢包的失败方式特别坑人：进程活着、不报错、地址永远不出现，
		// 界面上就停在「还没建立」，用户和开发者都看不出发生了什么。
		// 而 cloudflared 自己的 auto 回退可能要等很久才动。
		// 443/TCP 的 http2 几乎不会被拦，代价只是稍微慢一点。
		child = spawn(
			this.command,
			[
				'tunnel',
				'--url',
				this.localUrl,
				'--no-autoupdate',
				'--protocol',
				this.protocol,
				// 默认它会去听 20242，而那个端口被别的程序占着时会直接启动失败。
				// 交给系统分配一个空闲端口，我们自己不看 metrics。
				'--metrics',
				'127.0.0.1:0',
				'--config',
				this.isolatedConfig
			],
			{
				stdio: ['ignore', 'pipe', 'pipe'],
				// 只有 Windows 上第一次直接启动失败（多半是 .cmd 包装脚本）才打开 shell。
				// 平时不开，免得参数里的特殊字符被 shell 解释。
				shell: this.shellRetry === true
			}
		);
		} catch (error) {
			wireLog(`[tunnel] 启动失败: ${error?.message ?? error}`);
			this.scheduleRestart();
			return;
		}
		this.child = child;

		// cloudflared 把横幅打在 stderr，两个流都扫一遍，免得版本差异导致抓不到。
		const scan = (chunk) => {
			const text = chunk.toString('utf8');
			this.recentOutput = (this.recentOutput + text).slice(-4_000);
			// 用户在等的时候最想知道的就是"它到底在干什么"。节流到一秒一次，
			// 避免云家的日志刷屏把状态推送打爆。
			const now = Date.now();
			if (now - this.lastOutputAt > 1_000) {
				this.lastOutputAt = now;
				try {
					this.onOutput?.(this.recentOutput.trim().slice(-600));
				} catch {
					// 忽略
				}
			}
			// 失败原因也要带出来：否则界面上只有「还没建立」，用户无从下手。
			const failure = /ERR\s+Failed to request quick Tunnel:?\s*(.+)/i.exec(text);
			if (failure !== null) {
				const reason = failure[1].trim().slice(0, 200);
				wireLog(`[tunnel] cloudflared 报告失败: ${reason}`);
				try {
					this.onFailure?.(reason);
				} catch {
					// 上报失败不影响主流程
				}
			}
			const match = URL_PATTERN.exec(text);
			if (match === null || match[0] === this.url) return;
			const candidate = match[0];
			wireLog(`[tunnel] 拿到地址 ${candidate}，先确认能连通`);
			void this.confirm(candidate);
		};
		child.stdout?.on('data', scan);
		child.stderr?.on('data', scan);

		// 起了但迟迟不出地址：这个状态最坑人，界面上只会显示「还没建立」，
		// 用户不知道是在建、还是已经废了。给个明确的时限。
		if (this.startupTimer !== null) clearTimeout(this.startupTimer);
		this.startupTimer = setTimeout(() => {
			this.startupTimer = null;
			if (this.stopped || this.url !== undefined) return;
			const tail = this.recentOutput.trim().split('\n').slice(-4).join(' / ');
			wireLog(`[tunnel] ${Math.round(this.startupTimeoutMs / 1000)} 秒没拿到地址，cloudflared 最近的输出：${tail || '（没有任何输出）'}`);
			try {
				this.onFailure?.(
					`cloudflared 已经启动，但 ${Math.round(this.startupTimeoutMs / 1000)} 秒内没拿到隧道地址` +
						(tail === '' ? '（它没有任何输出）' : `。它说的是：${tail.slice(0, 180)}`)
				);
			} catch {
				// 忽略上报失败
			}
		}, this.startupTimeoutMs);
		this.startupTimer.unref?.();

		child.on('error', (error) => {
			const message = error?.message ?? String(error);
			wireLog(`[tunnel] 进程错误: ${message}`);
			// Windows 上如果 cloudflared 是通过包管理器装的，PATH 里可能是
			// cloudflared.cmd 而不是 .exe。spawn 不带 shell 时无法执行 .cmd，
			// 直接 ENOENT——而探测（spawnSync --version）有时又能过，于是界面
			// 显示「已找到」，隧道却永远起不来。这里用 shell 再试一次。
			if (this.platform === 'win32' && this.shellRetry !== true && /ENOENT|EACCES/i.test(message)) {
				this.shellRetry = true;
				wireLog('[tunnel] Windows 上直接启动失败，改用 shell 重试一次');
				this.child = null;
				this.spawnOnce();
				return;
			}
			try {
				this.onFailure?.(`启动 cloudflared 失败：${message}`);
			} catch {
				// 忽略
			}
		});
		child.on('exit', (code, signal) => {
			this.child = null;
			this.url = undefined;
			if (this.startupTimer !== null) {
				clearTimeout(this.startupTimer);
				this.startupTimer = null;
			}
			wireLog(`[tunnel] 退出 code=${code} signal=${signal}`);
			if (!this.stopped) this.scheduleRestart();
		});
	}

	/**
	 * 确认这个地址真的通了，再上报。
	 *
	 * cloudflared 打出来的地址是「刚分配」的，官方文档明说 "it may take some time
	 * to be reachable"。直接上报的话，手机端可能比隧道先到位，于是第一次配对
	 * 就吃一个 `fetch failed`。这里等它真能响应再交出去。
	 *
	 * 判断标准是「拿到了 HTTP 响应」而不是「200」：cloudflared 在回源失败时返回
	 * 502，那也说明隧道本身是通的。
	 *
	 * @param {string} url 候选地址。
	 * @returns {Promise<void>} 完成。
	 */
	async confirm(url) {
		if (this.stopped) return;
		for (let i = 0; i < this.verifyAttempts; i += 1) {
			if (this.stopped || this.url === url) return;
			try {
				const response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
				await response.body?.cancel?.();
				if (this.stopped || this.url === url) return;
				this.url = url;
				this.attempt = 0;
				if (this.startupTimer !== null) {
					clearTimeout(this.startupTimer);
					this.startupTimer = null;
				}
				wireLog(`[tunnel] 确认可用 ${url}`);
				try {
					this.onUrl?.(url);
				} catch (error) {
					wireLog(`[tunnel] 上报地址失败: ${error?.message ?? error}`);
				}
				return;
			} catch {
				// 还没就绪，继续等。
			}
			// 最后一次不用再等：等完也不会再试，只会让调用方多挂一段时间。
			if (i === this.verifyAttempts - 1) break;
			await new Promise((resolve) => {
				const timer = setTimeout(resolve, this.verifyDelayMs);
				timer.unref?.();
			});
		}
		// 自检失败**不等于**这条隧道不能用。
		//
		// 它只能说明"本机自己连不上自己"，而本机的网络（尤其是国内的家宽、
		// 公司网）和手机走的路由完全不同：本机连不通、手机连得通是很常见的。
		// 早先的版本在这里直接放弃，结果是用户一个地址都拿不到——比给一个
		// 可能不通的地址糟得多，因为后者至少还能试。
		//
		// 所以照常上报，只是标记成"没验证过"，让界面把话说清楚。
		wireLog(`[tunnel] ${url} 自检没通过（本机连不上），仍然交给手机去试`);
		this.url = url;
		this.attempt = 0;
		try {
			this.onUrl?.(url);
			this.onUnverified?.(url);
		} catch (error) {
			wireLog(`[tunnel] 上报地址失败: ${error?.message ?? error}`);
		}
	}

	/** 按指数退避安排重启。 */
	scheduleRestart() {
		if (this.stopped || this.restartTimer !== null) return;
		this.attempt += 1;
		const delay = Math.min(1_000 * 2 ** (this.attempt - 1), RESTART_MAX_MS);
		wireLog(`[tunnel] ${delay}ms 后第 ${this.attempt} 次重启`);
		this.restartTimer = setTimeout(() => {
			this.restartTimer = null;
			this.spawnOnce();
		}, delay);
		this.restartTimer.unref?.();
	}

	/**
	 * 当前状态，供界面展示。
	 * @returns {{running: boolean, url?: string, attempts: number}} 状态快照。
	 */
	status() {
		return { running: this.child !== null, url: this.url, attempts: this.attempt };
	}

	/** 停止隧道并取消所有重试。 */
	stop() {
		this.stopped = true;
		if (this.restartTimer !== null) {
			clearTimeout(this.restartTimer);
			this.restartTimer = null;
		}
		const child = this.child;
		this.child = null;
		this.url = undefined;
		if (child === null || child.exitCode !== null) return;
		// cloudflared 收到 SIGTERM 不一定立刻退；退不掉就会变成一个还在往中转
		// 上报旧地址的孤儿进程（实测过：新隧道建好了，手机却连到上一个）。
		// 所以先礼后兵：3 秒还不走就 SIGKILL。
		child.kill('SIGTERM');
		const escalate = setTimeout(() => {
			if (child.exitCode === null) {
				try {
					child.kill('SIGKILL');
				} catch {
					// 已经没了就算了
				}
			}
		}, 3000);
		// 别让这个计时器把进程留住。
		escalate.unref?.();
		child.once('exit', () => clearTimeout(escalate));
	}
}
