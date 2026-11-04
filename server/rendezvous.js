/**
 * dsh-wire rendezvous 服务。
 *
 * ## 它是什么
 *
 * 一台极小的固定地址服务，只做一件事：记住「每台电脑当前的隧道地址」，
 * 让手机能在隧道域名变化后找到它。**不转发、不存储、不解析任何会话内容。**
 *
 * ## 为什么它必须独立于插件
 *
 * 快速隧道的域名每次启动都变，手机不能把地址写死。而这个服务又必须有一个
 * 永不变的地址，所以它只能跑在用户自己的固定服务器上。
 *
 * ## 部署
 *
 * ```sh
 * node server/rendezvous.js --port 18907 --data /var/lib/dsh-wire
 * ```
 *
 * 前面套一层 nginx / Caddy 提供 TLS，建议限制请求体大小并开启访问日志。
 */

import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';

/** 配对码有效期。 */
const PAIR_TTL_MS = 5 * 60 * 1000;

/** 多久没有心跳就认为设备离线。 */
const STALE_MS = 5 * 60 * 1000;

/** 每 IP 每分钟允许的解析次数，防止暴力猜配对码。 */
const RESOLVE_PER_MINUTE = 20;

/** 允许的配对码字符集（与客户端 `makePairCode()` 保持一致）。 */
const PAIR_CODE_PATTERN = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;

/**
 * 解析命令行参数。
 * @param {string[]} argv 参数数组。
 * @returns {{port: number, dataDir: string}} 配置。
 */
function parseArgs(argv) {
	const result = { port: 18907, dataDir: '/var/lib/dsh-wire' };
	for (let index = 0; index < argv.length; index += 1) {
		const flag = argv[index];
		if (flag === '--port') result.port = Number(argv[index + 1]);
		else if (flag === '--data') result.dataDir = argv[index + 1];
	}
	return result;
}

/**
 * 生成随机令牌。
 * @returns {string} 十六进制令牌。
 */
function makeToken() {
	return randomBytes(32).toString('hex');
}

/**
 * 生成配对码，排除易混字符。
 * @returns {string} 6 位配对码。
 */
function makePairCode() {
	const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
	const bytes = randomBytes(6);
	return [...bytes].map((byte) => alphabet[byte % alphabet.length]).join('');
}

/**
 * 令牌摘要。落盘只存摘要，明文只在签发时出现一次。
 * @param {string} token 明文令牌。
 * @returns {string} sha256 摘要。
 */
function hashToken(token) {
	return createHash('sha256').update(token).digest('hex');
}

/**
 * 创建服务。
 * @param {{dataDir: string}} config 配置。
 * @returns {{server: http.Server, close: Function}} 服务实例。
 */
export function createRendezvous(config) {
	/** @type {Map<string, {tokenHash: string, url: string, label: string, updatedAt: number}>} 设备表 */
	const devices = new Map();
	/** @type {Map<string, {deviceId: string, expiresAt: number}>} 配对码表 */
	const codes = new Map();
	/** @type {Map<string, {count: number, resetAt: number}>} 限速表 */
	const limits = new Map();

	const dataFile = join(config.dataDir, 'devices.json');

	/** 从磁盘恢复（重启不丢配对关系）。 */
	function load() {
		try {
			const raw = JSON.parse(readFileSync(dataFile, 'utf8'));
			for (const [deviceId, record] of Object.entries(raw.devices ?? {})) devices.set(deviceId, record);
			const now = Date.now();
			for (const [code, record] of Object.entries(raw.codes ?? {})) {
				if (record.expiresAt > now) codes.set(code, record);
			}
		} catch {
			/* 首次启动没有文件很正常 */
		}
	}

	/** 落盘。 */
	function save() {
		try {
			mkdirSync(config.dataDir, { recursive: true });
			writeFileSync(
				dataFile,
				JSON.stringify({ devices: Object.fromEntries(devices), codes: Object.fromEntries(codes) }, null, '\t'),
				{ encoding: 'utf8', mode: 0o600 }
			);
		} catch (error) {
			console.error('[rendezvous] 落盘失败:', error.message);
		}
	}

	load();
	// 定期清理过期配对码与离线设备，同时刷盘。
	const janitor = setInterval(() => {
		const now = Date.now();
		for (const [code, record] of codes) {
			if (record.expiresAt <= now) codes.delete(code);
		}
		for (const [deviceId, record] of devices) {
			if (now - record.updatedAt > STALE_MS * 12) devices.delete(deviceId);
		}
		save();
	}, 60_000);
	janitor.unref();

	/**
	 * 限速检查。
	 * @param {string} ip 来源地址。
	 * @returns {boolean} 是否放行。
	 */
	function allowed(ip) {
		const now = Date.now();
		const record = limits.get(ip);
		if (record === undefined || record.resetAt <= now) {
			limits.set(ip, { count: 1, resetAt: now + 60_000 });
			return true;
		}
		record.count += 1;
		return record.count <= RESOLVE_PER_MINUTE;
	}

	/**
	 * 读请求体。
	 * @param {http.IncomingMessage} req 请求。
	 * @returns {Promise<any>} 解析结果。
	 */
	function readBody(req) {
		return new Promise((resolve, reject) => {
			/**
			 * @type {Buffer[]}
			 */
			const chunks = [];
			let size = 0;
			req.on('data', (chunk) => {
				size += chunk.length;
				if (size > 64 * 1024) {
					reject(new Error('请求体过大'));
					req.destroy();
					return;
				}
				chunks.push(chunk);
			});
			req.on('end', () => {
				const raw = Buffer.concat(chunks).toString('utf8');
				try {
					resolve(raw === '' ? {} : JSON.parse(raw));
				} catch (error) {
					reject(error);
				}
			});
			req.on('error', reject);
		});
	}

	/**
	 * 写响应。
	 * @param {http.ServerResponse} res 响应。
	 * @param {number} status 状态码。
	 * @param {any} body 内容。
	 * @returns {void}
	 */
	function send(res, status, body) {
		const payload = Buffer.from(JSON.stringify(body), 'utf8');
		res.writeHead(status, {
			'content-type': 'application/json; charset=utf-8',
			'content-length': String(payload.length),
			'cache-control': 'no-store'
		});
		res.end(payload);
	}

	const server = http.createServer(async (req, res) => {
		const ip = req.socket.remoteAddress ?? 'unknown';
		const url = new URL(req.url ?? '/', 'http://localhost');
		try {
			if (req.method === 'GET' && url.pathname === '/health') {
				send(res, 200, { ok: true, devices: devices.size, version: 1 });
				return;
			}
			if (req.method !== 'POST') {
				send(res, 405, { ok: false, code: 'method', message: '只接受 POST' });
				return;
			}
			const body = await readBody(req);

			if (url.pathname === '/register') {
				const deviceId = typeof body.deviceId === 'string' && body.deviceId !== ''
					? body.deviceId
					: `dev-${randomBytes(16).toString('hex')}`;
				const token = makeToken();
				const pairCode = makePairCode();
				devices.set(deviceId, {
					tokenHash: hashToken(token),
					url: String(body.url ?? ''),
					accessToken: String(body.accessToken ?? ''),
					label: String(body.label ?? '电脑'),
					updatedAt: Date.now()
				});
				codes.set(pairCode, { deviceId, expiresAt: Date.now() + PAIR_TTL_MS });
				save();
				console.log(`[rendezvous] 登记 ${deviceId} 配对码 ${pairCode}`);
				send(res, 200, { ok: true, deviceId, deviceToken: token, pairCode, expiresIn: PAIR_TTL_MS / 1000 });
				return;
			}

			if (url.pathname === '/resolve') {
				if (!allowed(ip)) {
					send(res, 429, { ok: false, code: 'rate-limited', message: '太频繁了' });
					return;
				}
				// ① 用配对码换（首次配对）
				if (typeof body.pairCode === 'string' && body.pairCode !== '') {
					const code = body.pairCode.toUpperCase();
					if (!PAIR_CODE_PATTERN.test(code)) {
						send(res, 400, { ok: false, code: 'bad-code', message: '配对码格式不对' });
						return;
					}
					const record = codes.get(code);
					if (record === undefined || record.expiresAt <= Date.now()) {
						send(res, 404, { ok: false, code: 'code-expired', message: '配对码无效或已过期' });
						return;
					}
					const device = devices.get(record.deviceId);
					if (device === undefined) {
						send(res, 404, { ok: false, code: 'device-gone', message: '设备已下线' });
						return;
					}
					// 配对码一次性：用过即焚，并换发新令牌（旧令牌作废）。
					codes.delete(code);
					const token = makeToken();
					device.tokenHash = hashToken(token);
					device.updatedAt = Date.now();
					save();
					send(res, 200, {
						ok: true,
						deviceId: record.deviceId,
						deviceToken: token,
						url: device.url,
						accessToken: device.accessToken,
						label: device.label
					});
					return;
				}
				// ② 用设备凭据换（之后每次启动）
				const device = devices.get(String(body.deviceId ?? ''));
				if (device === undefined) {
					send(res, 404, { ok: false, code: 'unknown-device', message: '未知设备' });
					return;
				}
				if (device.tokenHash !== hashToken(String(body.deviceToken ?? ''))) {
					send(res, 403, { ok: false, code: 'bad-token', message: '设备令牌无效' });
					return;
				}
				send(res, 200, {
					ok: true,
					deviceId: body.deviceId,
					url: device.url,
					accessToken: device.accessToken,
					label: device.label
				});
				return;
			}

			if (url.pathname === '/renew' || url.pathname === '/heartbeat') {
				const device = devices.get(String(body.deviceId ?? ''));
				if (device === undefined) {
					send(res, 404, { ok: false, code: 'unknown-device', message: '未知设备' });
					return;
				}
				if (device.tokenHash !== hashToken(String(body.deviceToken ?? ''))) {
					send(res, 403, { ok: false, code: 'bad-token', message: '设备令牌无效' });
					return;
				}
				if (url.pathname === '/renew' && typeof body.url === 'string' && body.url !== '') {
					device.url = body.url;
					console.log(`[rendezvous] ${body.deviceId} 地址更新为 ${body.url}`);
				}
				if (url.pathname === '/renew' && typeof body.accessToken === 'string' && body.accessToken !== '') {
					device.accessToken = body.accessToken;
				}
				device.updatedAt = Date.now();
				save();
				send(res, 200, { ok: true });
				return;
			}

			send(res, 404, { ok: false, code: 'not-found', message: '未知端点' });
		} catch (error) {
			send(res, 400, { ok: false, code: 'bad-request', message: error.message });
		}
	});

	return {
		server,
		close() {
			clearInterval(janitor);
			save();
			return new Promise((resolve) => server.close(() => resolve()));
		}
	};
}

// 直接执行时启动服务。
if (import.meta.url === `file://${process.argv[1]}`) {
	const config = parseArgs(process.argv.slice(2));
	const service = createRendezvous({ dataDir: config.dataDir });
	service.server.listen(config.port, '127.0.0.1', () => {
		console.log(`[rendezvous] 监听 127.0.0.1:${config.port}，数据目录 ${config.dataDir}`);
	});
}
