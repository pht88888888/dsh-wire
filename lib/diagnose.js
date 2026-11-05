/**
 * 自诊断：把"隧道为什么起不来"从猜测变成一次逐项检查。
 *
 * 起因很直接——用户机器上 cloudflared 探测通过、隧道地址永远不出现、也没有任何
 * 报错，而我在另一台机器上完全复现不了。隔着屏幕猜了三轮都没猜到，这不能继续。
 *
 * 这里的每一项都对应 `docs/failure-modes.md` 里的一条。检查本身要快（每项几秒上限），
 * 因为它会在隧道失败时自动跑，也在用户点「重新检查」时跑。
 *
 * 只使用 Node 内置能力，不引入依赖——插件装在一个跑在手机/桌面上的 Node 里，
 * 能少一个依赖就少一个。
 */

import { lookup } from 'node:dns/promises';
import { connect } from 'node:net';
import { spawnSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';

/** 单项检查的默认超时。 */
const STEP_TIMEOUT_MS = 4_000;

/**
 * 结果状态。
 * @typedef {'ok' | 'warn' | 'bad' | 'skip'} StepStatus
 */

/**
 * @typedef {object} Step
 * @property {string} id 稳定的标识。
 * @property {string} title 给人看的一句话。
 * @property {StepStatus} status 结论。
 * @property {string} detail 看到了什么。
 * @property {string} [hint] 用户该做什么。
 */

/**
 * 给一个 Promise 加超时，超时返回给定的兜底值。
 * @template T
 * @param {Promise<T>} promise 原 Promise。
 * @param {number} ms 毫秒。
 * @param {T} fallback 超时兜底值。
 * @returns {Promise<T>} 结果。
 */
function withTimeout(promise, ms, fallback) {
	let timer;
	const timeout = new Promise((resolve) => {
		timer = setTimeout(() => resolve(fallback), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * 检查 TCP 端口是否连得上。
 * @param {string} host 主机。
 * @param {number} port 端口。
 * @param {number} [timeoutMs] 超时。
 * @returns {Promise<{ok: boolean, reason?: string}>} 结果。
 */
function tcpProbe(host, port, timeoutMs = STEP_TIMEOUT_MS) {
	return new Promise((resolve) => {
		const socket = connect({ host, port });
		let settled = false;
		const done = (result) => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolve(result);
		};
		socket.setTimeout(timeoutMs);
		socket.once('connect', () => done({ ok: true }));
		socket.once('timeout', () => done({ ok: false, reason: '连接超时' }));
		socket.once('error', (error) => done({ ok: false, reason: error?.code ?? error?.message ?? '连接失败' }));
	});
}

/**
 * 找出系统里残留的 cloudflared 进程。
 *
 * 它会让新起的进程和旧进程抢同一条隧道，表现是"有时能连、有时不能"。
 * @returns {Step} 检查结果。
 */
function checkStrayProcesses() {
	const isWindows = process.platform === 'win32';
	const result = isWindows
		? spawnSync('tasklist', ['/FI', 'IMAGENAME eq cloudflared.exe', '/NH'], { encoding: 'utf8', timeout: STEP_TIMEOUT_MS })
		: spawnSync('pgrep', ['-fl', 'cloudflared'], { encoding: 'utf8', timeout: STEP_TIMEOUT_MS });

	const text = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
	if (result.error !== undefined || text === '') {
		return { id: 'stray', title: '残留的 cloudflared 进程', status: 'ok', detail: '没有发现' };
	}
	if (isWindows && /no tasks are running/i.test(text)) {
		return { id: 'stray', title: '残留的 cloudflared 进程', status: 'ok', detail: '没有发现' };
	}
	const lines = text.split('\n').filter((line) => line.trim() !== '').slice(0, 5);
	if (lines.length === 0) {
		return { id: 'stray', title: '残留的 cloudflared 进程', status: 'ok', detail: '没有发现' };
	}
	return {
		id: 'stray',
		title: '残留的 cloudflared 进程',
		status: 'warn',
		detail: `发现 ${lines.length} 个：${lines.join(' / ').slice(0, 160)}`,
		hint: '如果有多个，重启一次 DSH 让它们全部退出，再来一次。'
	};
}

/**
 * 检查系统代理环境变量。
 *
 * cloudflared 自己不走 HTTP 代理，但装了指代软件（Clash、公司代理）的机器上，
 * 这些变量往往意味着整个网络被接管，UDP 更容易被丢。
 * @returns {Step} 检查结果。
 */
function checkProxyEnv() {
	const keys = ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'https_proxy', 'http_proxy', 'all_proxy'];
	const found = keys.filter((key) => {
		const value = process.env[key];
		return typeof value === 'string' && value.trim() !== '';
	});
	if (found.length === 0) {
		return { id: 'proxy', title: '系统代理设置', status: 'ok', detail: '没有设置代理环境变量' };
	}
	return {
		id: 'proxy',
		title: '系统代理设置',
		status: 'warn',
		detail: `检测到 ${found.join('、')}`,
		hint: '如果开着代理/VPN，它可能拦掉 cloudflared 的连接。可以临时关掉再试。'
	};
}

/**
 * 跑一整套诊断。
 *
 * @param {{cloudflared?: {found?: boolean, version?: string, path?: string}, localPort?: number, rendezvous?: string|null, tunnelOutput?: string|null}} input 需要诊断的上下文。
 * @returns {Promise<{steps: Step[], summary: string}>} 诊断结果。
 */
export async function diagnose(input = {}) {
	/** @type {Step[]} */
	const steps = [];

	// ── 1. 二进制 ──
	const cf = input.cloudflared ?? {};
	if (cf.found === true) {
		let runnable = true;
		if (typeof cf.path === 'string' && cf.path.includes('/')) {
			try {
				accessSync(cf.path, constants.X_OK);
			} catch {
				runnable = false;
			}
		}
		steps.push({
			id: 'binary',
			title: 'cloudflared 二进制',
			status: runnable ? 'ok' : 'bad',
			detail: runnable ? `${cf.version ?? '未知版本'}（${cf.path ?? 'PATH'}）` : `${cf.path} 不可执行`,
			hint: runnable ? undefined : '删掉它，用设置页里的「下载 cloudflared」重新装一个。'
		});
	} else {
		steps.push({
			id: 'binary',
			title: 'cloudflared 二进制',
			status: 'bad',
			detail: '没找到',
			hint: '点设置页里的「下载 cloudflared」。或者不用隧道，直接用局域网直连串。'
		});
	}

	// ── 2. 本机服务 ──
	if (typeof input.localPort === 'number') {
		const local = await withTimeout(
			tcpProbe('127.0.0.1', input.localPort, 2_000),
			2_500,
			{ ok: false, reason: '超时' }
		);
		steps.push({
			id: 'local',
			title: '本机服务',
			status: local.ok ? 'ok' : 'bad',
			detail: local.ok ? `127.0.0.1:${input.localPort} 正常响应` : `127.0.0.1:${input.localPort} 连不上（${local.reason}）`,
			hint: local.ok ? undefined : '这是插件自己的服务，连不上说明插件没正常启动，重启一次 DSH。'
		});
	}

	// ── 3. DNS ──
	const dnsHosts = ['region1.v2.argotunnel.com', 'api.trycloudflare.com'];
	const dnsResults = await Promise.all(
		dnsHosts.map(async (host) => {
			try {
				const address = await withTimeout(lookup(host), STEP_TIMEOUT_MS, null);
				return { host, ok: address !== null, address: address?.address };
			} catch {
				return { host, ok: false };
			}
		})
	);
	const dnsFailed = dnsResults.filter((item) => !item.ok);
	steps.push({
		id: 'dns',
		title: 'Cloudflare 域名解析',
		status: dnsFailed.length === 0 ? 'ok' : 'bad',
		detail:
			dnsFailed.length === 0
				? dnsResults.map((item) => `${item.host} → ${item.address}`).join('；')
				: `解析不了的：${dnsFailed.map((item) => item.host).join('、')}`,
		hint:
			dnsFailed.length === 0
				? undefined
				: '把 DNS 换成 223.5.5.5 或 1.1.1.1 再试。公司网/校园网可能拦截。'
	});

	// ── 4. TCP 443（http2 走的就是这条） ──
	const tlsHosts = ['region1.v2.argotunnel.com', 'api.cloudflare.com'];
	const tlsResults = await Promise.all(
		tlsHosts.map(async (host) => ({ host, result: await withTimeout(tcpProbe(host, 443), STEP_TIMEOUT_MS, { ok: false, reason: '超时' }) }))
	);
	const tlsOk = tlsResults.filter((item) => item.result.ok);
	steps.push({
		id: 'tcp443',
		title: '连 Cloudflare 的 443 端口',
		status: tlsOk.length === tlsResults.length ? 'ok' : tlsOk.length === 0 ? 'bad' : 'warn',
		detail: tlsResults
			.map((item) => `${item.host}:443 → ${item.result.ok ? '通' : `不通（${item.result.reason}）`}`)
			.join('；'),
		hint:
			tlsOk.length === tlsResults.length
				? undefined
				: '443 都不通说明这台机器的外网被限制了（公司网/校园网/防火墙）。这种情况下任何隧道方案都不行，只能用局域网直连串。'
	});

	// ── 5. 中转服务 ──
	if (typeof input.rendezvous === 'string' && input.rendezvous !== '') {
		try {
			const base = input.rendezvous.replace(/\/+$/, '');
			const response = await withTimeout(fetch(`${base}/health`), STEP_TIMEOUT_MS, null);
			const ok = response !== null && response.ok;
			steps.push({
				id: 'rendezvous',
				title: '配对中转服务',
				status: ok ? 'ok' : 'bad',
				detail: ok ? `${base} 正常` : `${base} 没响应`,
				hint: ok ? undefined : '中转服务挂了，配对码没法发放。这不是你机器的问题，稍后再试或告诉我。'
			});
		} catch (error) {
			steps.push({
				id: 'rendezvous',
				title: '配对中转服务',
				status: 'bad',
				detail: `连不上：${error?.message ?? error}`,
				hint: '这台机器访问不了中转服务。检查网络，或者直接用局域网直连串（不需要中转）。'
			});
		}
	}

	// ── 6. 代理与残留进程 ──
	steps.push(checkProxyEnv());
	steps.push(checkStrayProcesses());

	// ── 7. 汇总 ──
	const bad = steps.filter((step) => step.status === 'bad');
	const warn = steps.filter((step) => step.status === 'warn');
	let summary;
	if (bad.length === 0 && warn.length === 0) {
		summary = '各项检查都正常。隧道仍然起不来的话，多半是 Cloudflare 那边的临时问题，过几分钟再试。';
	} else if (bad.length > 0) {
		summary = `有 ${bad.length} 项没过：${bad.map((step) => step.title).join('、')}。按每项下面的建议处理。`;
	} else {
		summary = `有 ${warn.length} 项需要注意：${warn.map((step) => step.title).join('、')}。`;
	}

	return { steps, summary };
}
