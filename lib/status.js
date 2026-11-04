/**
 * 运行状态：给设置页看的那一份。
 *
 * 存在的理由：插件跑在不同的两半（host / browser），中间只隔一个同源 fetch。
 * 与其让页面去猜"现在连没连上"，不如让 host 把自己知道的**如实写进这里**，
 * 页面只负责显示。这样出问题时用户看到的是原因，而不是"转圈"。
 *
 * 这里只放**给人看的东西**，不放令牌。
 */

import { downloadSnapshot } from './cloudflared.js';

/** @type {{role: string|null, rendezvous: string|null, pairCode: string|null, pairCodeExpiresAt: number|null, tunnelUrl: string|null, localOrigin: string|null, phoneOnline: boolean, connected: boolean, desktopOrigin: string|null, version: string, error: string|null, errorCode: string|null, updatedAt: number}} */
export const status = {
	role: null,
	rendezvous: null,
	pairCode: null,
	pairCodeExpiresAt: null,
	tunnelUrl: null,
	localOrigin: null,
	/** 局域网地址；手机连同一个 WiFi 时用它直连，绕开隧道。 */
	lanUrl: null,
	lanLink: null,
	lanInterface: null,
	/** cloudflared 二进制的探测结果。 */
	cloudflared: null,
	phoneOnline: false,
	connected: false,
	desktopOrigin: null,
	version: '0.0.0',
	error: null,
	errorCode: null,
	updatedAt: 0
};

/**
 * 合并更新状态。
 *
 * @param {Partial<typeof status>} patch 要改的字段。
 * @returns {void}
 */
export function setStatus(patch) {
	Object.assign(status, patch, { updatedAt: Date.now() });
}

/**
 * 记下一个错误，并清掉"已连接"这类会误导人的状态。
 *
 * @param {string} code 稳定的错误码，供页面分支。
 * @param {string} message 给人看的一句话。
 * @returns {void}
 */
export function setError(code, message) {
	Object.assign(status, {
		error: message,
		errorCode: code,
		phoneOnline: false,
		connected: false,
		updatedAt: Date.now()
	});
}

/**
 * 清掉上一次的错误。
 * @returns {void}
 */
export function clearError() {
	Object.assign(status, { error: null, errorCode: null, updatedAt: Date.now() });
}

/**
 * "手机是否在线"得现算——它是"最近一次轮询距今多久"，不是一次性的结果。
 * 让 runtime 注册一个取值函数，页面每次来问都拿到当前值。
 *
 * @type {() => boolean}
 */
let phoneOnlineProvider = () => false;

/**
 * 注册在线状态的取值函数。
 *
 * @param {() => boolean} provider 返回当前是否在线。
 * @returns {void}
 */
export function setPhoneOnlineProvider(provider) {
	phoneOnlineProvider = provider;
}

/**
 * 给页面用的快照。带一个 `pairCode` 的剩余秒数，省得页面自己算。
 *
 * @returns {any} 只读快照。
 */
export function snapshot() {
	const now = Date.now();
	return {
		role: status.role,
		rendezvous: status.rendezvous,
		pairCode: status.pairCode,
		pairCodeExpiresIn:
			status.pairCodeExpiresAt === null ? null : Math.max(0, Math.round((status.pairCodeExpiresAt - now) / 1000)),
		tunnelUrl: status.tunnelUrl,
		localOrigin: status.localOrigin,
		lanUrl: status.lanUrl,
		lanLink: status.lanLink,
		lanInterface: status.lanInterface,
		cloudflared: status.cloudflared,
		cloudflaredDownload: downloadSnapshot(),
		phoneOnline: phoneOnlineProvider(),
		connected: status.connected,
		desktopOrigin: status.desktopOrigin,
		version: status.version,
		error: status.error,
		errorCode: status.errorCode,
		updatedAt: status.updatedAt
	};
}
