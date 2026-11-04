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

/** 多久没露面就把设备彻底忘掉。宽松一点：设备身份比在线状态重要。 */
/**
 * 多久没有露面就忘掉一台设备。
 *
 * 这条线不能短：一旦忘了，手机端手里的令牌全部失效，用户得重新配对一次。
 * 出差两周、电脑一直关着，回来发现"莫名其妙又要配对"，是最败好感的一种体验。
 * 一条设备记录才几百字节，留 30 天的代价可以忽略。
 */
const FORGET_DEVICE_MS = 30 * 24 * 60 * 60 * 1000;

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
			// 30 天没露面才忘掉这台设备。原来只留 1 小时，导致电脑关机一晚
			// 再开机时记录已被清，只能重新登记换发新令牌，手机那半边立刻失效。
			if (now - record.updatedAt > FORGET_DEVICE_MS) devices.delete(deviceId);
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

				// 这个 id 已经登记过了。
				//
				// 分两种情形，不能一律覆盖：
				// · 带着有效凭据 → 是主人自己回来了，只更新地址，**不换令牌也不发新码**；
				// · 没有凭据 → 别人猜到了 id，拒绝。否则谁都能把别人的设备顶掉。
				//   用户主动"重新生成配对码"时走 reset，那是本人操作。
				const existing = devices.get(deviceId);
				if (existing !== undefined) {
					const presented = hashToken(String(body.deviceToken ?? ''));
					const mine = body.deviceToken !== undefined
						&& (existing.tokenHash === presented || existing.phoneTokenHash === presented);
					if (mine) {
						existing.url = String(body.url ?? existing.url ?? '');
						existing.accessToken = String(body.accessToken ?? existing.accessToken ?? '');
						existing.updatedAt = Date.now();
						save();
						send(res, 200, { ok: true, deviceId, renewed: true });
						return;
					}
					if (body.reset !== true) {
						send(res, 409, {
							ok: false,
							code: 'device-exists',
							message: '这台设备已经登记过，需要凭据才能更新；否则请在电脑端重新生成配对码'
						});
						return;
					}
				}

				const token = makeToken();
				const pairCode = makePairCode();
				// 重新登记要保留手机端已经拿到的令牌，否则电脑端一重启，
				// 手机这半边又得重新配一次对。
				const previous = devices.get(deviceId);
				devices.set(deviceId, {
					tokenHash: hashToken(token),
					phoneTokenHash: previous?.phoneTokenHash,
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
					send(res, 429, {
						ok: false,
						code: 'rate-limited',
						message: '试得太频繁了，等一分钟再试'
					});
					return;
				}
				// ① 先用设备令牌换（老设备重连）。
				//
				// 这个顺序不能反：配对码是"用过即焚"的，而客户端配对成功后
				// config 里往往还留着那个已经作废的码。若先看码，重连会直接
				// 撞上 `code-expired`，永远走不到令牌分支——表现为电脑端重启后
				// 手机再也连不上。
				if (typeof body.deviceId === 'string' && body.deviceId !== ''
					&& typeof body.deviceToken === 'string' && body.deviceToken !== '') {
					const known = devices.get(body.deviceId);
					const presented = hashToken(body.deviceToken);
					const isPhone = known !== undefined && known.phoneTokenHash === presented;
					if (known !== undefined && (known.tokenHash === presented || isPhone)) {
						send(res, 200, {
							ok: true,
							deviceId: body.deviceId,
							url: known.url,
							accessToken: known.accessToken,
							label: known.label
						});
						return;
					}
				}

				// ② 再用配对码换（首次配对）
				if (typeof body.pairCode === 'string' && body.pairCode !== '') {
					const code = body.pairCode.toUpperCase();
					if (!PAIR_CODE_PATTERN.test(code)) {
						send(res, 400, { ok: false, code: 'bad-code', message: '配对码格式不对' });
						return;
					}
					const record = codes.get(code);
					if (record === undefined || record.expiresAt <= Date.now()) {
						send(res, 404, {
							ok: false,
							code: 'code-expired',
							message: '配对码无效或已过期。回电脑端设置页点「重新生成配对码」，用新的那个'
						});
						return;
					}
					const device = devices.get(record.deviceId);
					if (device === undefined) {
						send(res, 404, {
						ok: false,
						code: 'device-gone',
						message: '电脑那边已经下线了。确认它开着、DSH 在运行，再试'
					});
						return;
					}
					// 配对码一次性：用过即焚。
					//
					// 这里换发的是**手机端自己的**令牌，绝不能覆盖电脑端的 tokenHash：
					// 两者共用一份凭据的话，手机一配对就会把电脑端踢成"非法设备"，
					// 电脑端下次续登失败、重新登记、又换新令牌，手机端随之失效——
					// 来回互相作废，永远连不上。
					codes.delete(code);
					const token = makeToken();
					device.phoneTokenHash = hashToken(token);
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
				// 令牌和配对码都不匹配：这台设备从未配对过，也没拿到有效凭据。
				send(res, 403, { ok: false, code: 'bad-token', message: '设备令牌无效，请重新配对' });
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
