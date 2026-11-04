/**
 * dsh-wire 协议层。
 *
 * 设计原则：**线上只跑 JSON**，不做自定义二进制格式。
 * 这样任何一次故障都能用 `curl` 复现，不需要先写一个解码器。
 *
 * 版本协商放在 `hello`：两端协议不一致时**明确拒绝**，而不是"尽力兼容"——
 * 远程链路里最贵的错误是把不兼容当成网络问题，让人去查隧道。
 */

/** 协议版本。任何不兼容的帧结构变化都必须在这里 +1。 */
export const PROTO_VERSION = 1;

/** 所有端点共用的路径前缀。 */
export const ROUTE_PREFIX = '/dsh-wire';

/** 端点表。客户端与服务端共用同一份，避免两边各写一遍字符串。 */
export const ENDPOINTS = {
	hello: '/hello',
	list: '/list',
	read: '/read',
	poll: '/poll',
	prompt: '/prompt',
	answer: '/answer',
	health: '/health'
};

/** 长轮询最长挂起时间。留出余量避开中间层（含 Cloudflare）的空闲超时。 */
export const POLL_HOLD_MS = 25_000;

/** 客户端收到空批后的重连间隔。 */
export const POLL_IDLE_MS = 300;

/** 断线重连退避：从 1 秒起翻倍，封顶 15 秒。 */
export const RETRY_MIN_MS = 1_000;
export const RETRY_MAX_MS = 15_000;

/**
 * 协议错误。带稳定的 `code`，客户端按 code 分流，不靠消息文本匹配。
 */
export class WireError extends Error {
	constructor(code, message, details) {
		super(message);
		this.name = 'WireError';
		this.code = code;
		this.details = details;
	}
}

/**
 * 把一次失败包成线上错误体。
 * @param {unknown} error 任意抛出物。
 * @returns {{ok: false, code: string, message: string}} 可 JSON 化的错误体。
 */
export function toErrorBody(error) {
	if (error instanceof WireError) {
		return { ok: false, code: error.code, message: error.message };
	}
	const message = error instanceof Error ? error.message : String(error);
	return { ok: false, code: 'internal', message };
}

/**
 * 读满一个请求体并解析为 JSON。
 *
 * 有上限：远程链路暴露在公网，不设上限等于把内存交给对面。
 *
 * @param {import('node:http').IncomingMessage} req 请求。
 * @param {number} [limit] 字节上限。
 * @returns {Promise<any>} 解析后的对象；空体返回 `{}`。
 */
export function readJsonBody(req, limit = 4 * 1024 * 1024) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on('data', (chunk) => {
			size += chunk.length;
			if (size > limit) {
				reject(new WireError('body-too-large', `请求体超过 ${limit} 字节`));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => {
			const raw = Buffer.concat(chunks).toString('utf8');
			if (raw.trim() === '') {
				resolve({});
				return;
			}
			try {
				resolve(JSON.parse(raw));
			} catch (error) {
				reject(new WireError('bad-json', `请求体不是合法 JSON：${error.message}`));
			}
		});
		req.on('error', reject);
	});
}

/**
 * 写一个 JSON 响应。
 * @param {import('node:http').ServerResponse} res 响应。
 * @param {number} status HTTP 状态码。
 * @param {unknown} body 响应体。
 */
export function writeJson(res, status, body) {
	const payload = Buffer.from(JSON.stringify(body), 'utf8');
	res.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'content-length': String(payload.length),
		// 远程面板可能被任何来源打开，这里不放行跨域凭据。
		'cache-control': 'no-store'
	});
	res.end(payload);
}

/**
 * 判断一个值是不是非空字符串。协议里所有 id 都必须是。
 * @param {unknown} value 待测值。
 * @returns {boolean} 是否合法 id。
 */
export function isId(value) {
	return typeof value === 'string' && value.length > 0;
}
