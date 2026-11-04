/**
 * 设置页用的管理接口（host 侧）。
 *
 * 页面和插件之间只隔一个同源 fetch，所以这里就是全部"后端"：
 * - `GET  /state`   现在到底什么状态
 * - `POST /pair`    手机端提交 6 位配对码
 * - `POST /refresh` 电脑端重新生成配对码
 *
 * 设计上刻意做薄：**不在这里存任何东西**，状态由运行时写进 `status.js`，
 * 配置由 `config.js` 落盘。这样页面刷新、插件重载都不会有第二份真相。
 */

import { saveConfig } from './config.js';
import { wireLog } from './log.js';
import { reconnectMobile, refreshPairCode } from './runtime.js';
import { snapshot } from './status.js';

/** 页面请求的前缀。 */
export const ADMIN_PREFIX = '/dsh-wire-admin';

/**
 * 配对码的字符集，与中转生成时用的一致。
 * 去掉容易看错的 I / L / O / 0 / 1。
 */
const PAIR_CODE_PATTERN = /^[A-HJ-KM-NP-Z2-9]{6}$/;

/**
 * 发一个 JSON 响应。
 *
 * @param {import('node:http').ServerResponse} res 响应。
 * @param {number} code HTTP 状态码。
 * @param {any} body 内容。
 * @returns {void}
 */
function sendJson(res, code, body) {
	if (res.writableEnded) return;
	res.writeHead(code, {
		'content-type': 'application/json; charset=utf-8',
		'cache-control': 'no-store'
	});
	res.end(JSON.stringify(body));
}

/**
 * 读完整个请求体。设置页只会发很小的 JSON。
 *
 * @param {import('node:http').IncomingMessage} req 请求。
 * @returns {Promise<any>} 解析后的对象；空体返回 {}。
 */
async function readJson(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		// 请求体只可能是几个字段，超过 8KB 一定是别的什么东西。
		if (size > 8 * 1024) throw new Error('请求体过大');
		chunks.push(chunk);
	}
	if (chunks.length === 0) return {};
	const text = Buffer.concat(chunks).toString('utf8').trim();
	return text === '' ? {} : JSON.parse(text);
}

/**
 * 造一个处理函数给 `webServer.register({kind:'prefix'})` 用。
 *
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>} 处理函数。
 */
export function createAdminHandler(askQueue) {
	return async function handle(req, res) {
		const url = new URL(req.url ?? '/', 'http://localhost');
		const route = url.pathname.slice(ADMIN_PREFIX.length).replace(/\/+$/, '') || '/';
		try {
			if (route === '/state') {
				sendJson(res, 200, { ok: true, ...snapshot() });
				return;
			}

			if (route === '/pair') {
				if (req.method !== 'POST') {
					sendJson(res, 405, { ok: false, message: '请用 POST' });
					return;
				}
				const body = await readJson(req);
				const code = String(body.pairCode ?? '').trim().toUpperCase();
				if (!PAIR_CODE_PATTERN.test(code)) {
					sendJson(res, 400, {
						ok: false,
						code: 'bad-pair-code',
						message: '配对码是 6 位字母数字（不含 I L O 0 1）'
					});
					return;
				}
				saveConfig({ pairCode: code });
				wireLog(`[admin] 已保存配对码 ${code}，开始重连`);
				const result = await reconnectMobile();
				sendJson(res, 200, { ok: true, ...result, ...snapshot() });
				return;
			}

			// 手机上的提问浮层靠这两个接口工作：
			// 电脑推来的问题落进队列，浮层轮询取走，答完再回来交账。
			if (route === '/pending') {
				sendJson(res, 200, { ok: true, asks: askQueue === undefined ? [] : askQueue.list() });
				return;
			}

			if (route === '/ask-answer') {
				if (req.method !== 'POST') {
					sendJson(res, 405, { ok: false, message: '请用 POST' });
					return;
				}
				const body = await readJson(req);
				const askId = String(body.askId ?? '');
				// 用户点了"跳过"：不发答案，直接让电脑端交回本机前端。
				if (body.decline === true) {
					const skipped = askQueue === undefined ? false : askQueue.answer(askId, undefined);
					sendJson(res, 200, { ok: skipped, askId, declined: true });
					return;
				}
				// 提问回 answers，审批回 outcome，两者走同一条路。
				const payload = {
					answers: Array.isArray(body.answers) ? body.answers : [],
					outcome: typeof body.outcome === 'string' ? body.outcome : undefined
				};
				const accepted = askQueue === undefined ? false : askQueue.answer(askId, payload);
				sendJson(res, 200, { ok: accepted, askId });
				return;
			}

			if (route === '/refresh') {
				if (req.method !== 'POST') {
					sendJson(res, 405, { ok: false, message: '请用 POST' });
					return;
				}
				const pairCode = await refreshPairCode();
				sendJson(res, 200, { ok: true, pairCode, ...snapshot() });
				return;
			}

			sendJson(res, 404, { ok: false, message: `未知接口 ${route}` });
		} catch (error) {
			const message = error?.message ?? String(error);
			wireLog(`[admin] ${route} 失败: ${message}`);
			sendJson(res, 500, { ok: false, message });
		}
	};
}
