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

import { wireLog } from './log.js';

/** 从 cloudflared 输出里抓随机域名。 */
const URL_PATTERN = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/;

/** 重启退避上限。 */
const RESTART_MAX_MS = 30_000;

/**
 * 管理一个快速隧道进程。
 */
export class QuickTunnel {
	/**
	 * @param {{command?: string, localUrl: string, onUrl?: (url: string) => void}} options
	 *   `command` 是 cloudflared 可执行文件路径（默认走 PATH）。
	 */
	constructor(options) {
		this.command = options.command ?? 'cloudflared';
		this.localUrl = options.localUrl;
		this.onUrl = options.onUrl;
		this.url = undefined;
		/** @type {import('node:child_process').ChildProcess | null} */
		this.child = null;
		this.stopped = false;
		this.attempt = 0;
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
		wireLog(`[tunnel] 启动 ${this.command} tunnel --url ${this.localUrl}`);
		let child;
		try {
			child = spawn(this.command, ['tunnel', '--url', this.localUrl, '--no-autoupdate'], {
				stdio: ['ignore', 'pipe', 'pipe']
			});
		} catch (error) {
			wireLog(`[tunnel] 启动失败: ${error?.message ?? error}`);
			this.scheduleRestart();
			return;
		}
		this.child = child;

		// cloudflared 把横幅打在 stderr，两个流都扫一遍，免得版本差异导致抓不到。
		const scan = (chunk) => {
			const text = chunk.toString('utf8');
			const match = URL_PATTERN.exec(text);
			if (match !== null && match[0] !== this.url) {
				this.url = match[0];
				this.attempt = 0;
				wireLog(`[tunnel] 就绪 ${this.url}`);
				try {
					this.onUrl?.(this.url);
				} catch (error) {
					wireLog(`[tunnel] 上报地址失败: ${error?.message ?? error}`);
				}
			}
		};
		child.stdout?.on('data', scan);
		child.stderr?.on('data', scan);

		child.on('error', (error) => {
			wireLog(`[tunnel] 进程错误: ${error?.message ?? error}`);
		});
		child.on('exit', (code, signal) => {
			this.child = null;
			this.url = undefined;
			wireLog(`[tunnel] 退出 code=${code} signal=${signal}`);
			if (!this.stopped) this.scheduleRestart();
		});
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
		this.child?.kill('SIGTERM');
		this.child = null;
		this.url = undefined;
	}
}
