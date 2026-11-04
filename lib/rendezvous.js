/**
 * rendezvous 客户端：解决「快速隧道域名每次都会变」这件事。
 *
 * 隧道地址本身是不可预测的随机串，手机不能把它写死。这里让电脑把「我现在的地址」
 * 登记到一台固定的中转服务器上，手机每次只问中转要地址——地址怎么变，手机都不用管。
 *
 * 中转只保存 `设备 → 地址` 的映射，**不经过任何消息内容**。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { STATE_DIR, wireLog } from './log.js';

/** 请求超时。中转不可达时不该把插件卡住。 */
const TIMEOUT_MS = 10_000;

/**
 * 读本机身份，没有就生成一个。
 *
 * `deviceId` 必须稳定：它是中转上那条记录的键，换了就等于换了一台设备。
 *
 * @returns {{deviceId: string, deviceToken?: string, pairCode?: string}} 身份。
 */
export function loadIdentity() {
	const path = join(STATE_DIR, 'device.json');
	try {
		const parsed = JSON.parse(readFileSync(path, 'utf8'));
		if (typeof parsed?.deviceId === 'string' && parsed.deviceId.length > 0) return parsed;
	} catch {
		/* 首次运行或文件损坏，落到生成分支 */
	}
	const deviceId = `dev-${randomId()}`;
	const identity = { deviceId };
	saveIdentity(identity);
	return identity;
}

/**
 * 写回身份。
 * @param {any} identity 身份对象。
 * @returns {void}
 */
export function saveIdentity(identity) {
	try {
		mkdirSync(STATE_DIR, { recursive: true });
		writeFileSync(join(STATE_DIR, 'device.json'), JSON.stringify(identity, null, '\t'), {
			encoding: 'utf8',
			mode: 0o600
		});
	} catch (error) {
		wireLog(`[rendezvous] 保存身份失败: ${error?.message ?? error}`);
	}
}

/**
 * 生成随机 id。
 * @returns {string} 十六进制串。
 */
function randomId() {
	const bytes = new Uint8Array(16);
	globalThis.crypto.getRandomValues(bytes);
	return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * 生成一个 6 位配对码。
 *
 * 排除了容易看错的字符（0/O、1/I/L），因为用户要手输或照着念。
 *
 * @returns {string} 配对码。
 */
export function makePairCode() {
	const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
	const bytes = new Uint8Array(6);
	globalThis.crypto.getRandomValues(bytes);
	return [...bytes].map((byte) => alphabet[byte % alphabet.length]).join('');
}

/**
 * 调一次中转。
 * @param {string} base 中转根地址。
 * @param {string} path 端点。
 * @param {any} body 请求体。
 * @returns {Promise<any>} 响应体。
 */
async function call(base, path, body) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		const response = await fetch(`${base.replace(/\/+$/, '')}${path}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body ?? {}),
			signal: controller.signal
		});
		const text = await response.text();
		const parsed = text === '' ? {} : JSON.parse(text);
		if (parsed.ok === false) throw new Error(`${parsed.code ?? 'failed'}: ${parsed.message ?? ''}`);
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		return parsed;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * 电脑端：把当前隧道地址登记上去。
 *
 * @param {string} base 中转根地址。
 * @param {{deviceId: string, deviceToken?: string, url: string, pairCode?: string}} input 登记内容。
 * @returns {Promise<{pairCode?: string, deviceToken?: string}>} 首次登记会返回配对码与设备令牌。
 */
export async function publish(base, input) {
	if (input.deviceToken === undefined) {
		const result = await call(base, '/register', {
			deviceId: input.deviceId,
			deviceToken: input.deviceToken,
			reset: input.reset === true,
			url: input.url,
			accessToken: input.accessToken,
			pairCode: input.pairCode,
			label: '电脑'
		});
		return { pairCode: result.pairCode, deviceToken: result.deviceToken };
	}
	await call(base, '/renew', {
		deviceId: input.deviceId,
		deviceToken: input.deviceToken,
		url: input.url,
		accessToken: input.accessToken
	});
	return {};
}

/**
 * 手机端：用配对码或设备凭据换取当前地址。
 *
 * @param {string} base 中转根地址。
 * @param {{deviceId?: string, deviceToken?: string, pairCode?: string}} query 查询条件。
 * @returns {Promise<{deviceId: string, deviceToken: string, url: string}>} 解析结果。
 */
export function resolve(base, query) {
	return call(base, '/resolve', query);
}

/**
 * 心跳，让中转知道这台设备还在线。
 * @param {string} base 中转根地址。
 * @param {{deviceId: string, deviceToken: string}} identity 身份。
 * @returns {Promise<void>} 完成。
 */
export async function heartbeat(base, identity) {
	await call(base, '/heartbeat', identity);
}
