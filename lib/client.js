/**
 * 手机端 HTTP 客户端：与电脑端 `server.js` 对话。
 *
 * 这一层刻意做得"笨"：每个方法就是一次请求，没有本地状态机、没有重放队列。
 * 远程链路出问题时，越少的状态越容易定位——失败就是失败，重试就是重试。
 */

import { ROUTE_PREFIX, ENDPOINTS, POLL_HOLD_MS, WireError } from './proto.js';

/** 单次请求超时。长轮询单独放宽，其余按短请求处理。 */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * 与电脑端通信的客户端。
 */
export class WireClient {
	/**
	 * @param {{origin: string, token: string}} options 电脑端地址与令牌。
	 */
	constructor(options) {
		this.origin = options.origin.replace(/\/+$/, '');
		this.token = options.token;
	}

	/**
	 * 发一个请求并解析 JSON。
	 *
	 * @param {string} action 端点名（`ENDPOINTS` 里的键）。
	 * @param {any} body 请求体。
	 * @param {{timeoutMs?: number, signal?: AbortSignal}} [options] 超时与外部取消。
	 * @returns {Promise<any>} 解析后的响应体。
	 */
	async request(action, body, options = {}) {
		const url = `${this.origin}${ROUTE_PREFIX}${ENDPOINTS[action]}`;
		const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
		const controller = new AbortController();
		const onAbort = () => controller.abort();
		options.signal?.addEventListener('abort', onAbort, { once: true });
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const response = await fetch(url, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					authorization: `Bearer ${this.token}`
				},
				body: JSON.stringify(body ?? {}),
				signal: controller.signal
			});
			const text = await response.text();
			let parsed;
			try {
				parsed = text === '' ? {} : JSON.parse(text);
			} catch (error) {
				throw new WireError('bad-response', `电脑端返回了非 JSON（HTTP ${response.status}）`);
			}
			if (parsed.ok === false) {
				throw new WireError(parsed.code ?? 'remote-failed', parsed.message ?? '电脑端返回失败');
			}
			if (!response.ok) {
				throw new WireError('http-error', `电脑端 HTTP ${response.status}`);
			}
			return parsed;
		} finally {
			clearTimeout(timer);
			options.signal?.removeEventListener('abort', onAbort);
		}
	}

	/**
	 * 协议握手，确认两端版本一致。
	 * @returns {Promise<{version: number, role: string}>} 电脑端的握手信息。
	 */
	hello() {
		return this.request('hello', {});
	}

	/**
	 * 取电脑端的会话摘要列表。
	 *
	 * 真实引擎返回的是分页对象 `{items: [...]}` 而不是裸数组（实测确认），
	 * 所以这里两种形状都认——按裸数组写会在真机上静默拿到空列表。
	 *
	 * @param {AbortSignal} [signal] 取消信号。
	 * @returns {Promise<any[]>} 摘要数组。
	 */
	async list(signal) {
		const payload = await this.request('list', {}, { signal });
		const sessions = payload?.sessions;
		if (Array.isArray(sessions)) return sessions;
		if (Array.isArray(sessions?.items)) return sessions.items;
		return [];
	}

	/**
	 * 读一个远程会话的完整快照。
	 * @param {string} sessionId 会话 id。
	 * @param {AbortSignal} [signal] 取消信号。
	 * @returns {Promise<any>} `{header, events, cursor, inheritedEventCount, projections?}`。
	 */
	read(sessionId, signal) {
		return this.request('read', { sessionId }, { signal });
	}

	/**
	 * 往远程会话发一条消息。
	 * @param {string} sessionId 会话 id。
	 * @param {string} text 文本内容。
	 * @returns {Promise<any>} 电脑端的受理结果。
	 */
	prompt(sessionId, text) {
		return this.request('prompt', { sessionId, text });
	}

	/**
	 * 回答一个远程 ask。
	 * @param {{id: string, selected: string[], custom?: string}} answer 答案。
	 * @returns {Promise<any>} 受理结果。
	 */
	answer(answer) {
		return this.request('answer', answer);
	}

	/**
	 * 一次长轮询。服务端最多挂 `POLL_HOLD_MS`，有事件就提前返回。
	 *
	 * @param {{sessionId: string, cursor: number}[]} watch 关注的会话与游标。
	 * @param {AbortSignal} signal 取消信号。
	 * @returns {Promise<{updates: any[], cursor: Record<string, number>, asks: any[]}>} 增量、游标与待回答的提问。
	 */
	async poll(watch, signal) {
		try {
			const payload = await this.request('poll', { watch }, {
				timeoutMs: POLL_HOLD_MS + REQUEST_TIMEOUT_MS,
				signal
			});
			return {
				updates: Array.isArray(payload.updates) ? payload.updates : [],
				cursor: payload.cursor ?? {},
				asks: Array.isArray(payload.asks) ? payload.asks : []
			};
		} catch (error) {
			// 客户端主动取消不是故障，原样抛出交给上层判断。
			if (signal?.aborted) throw error;
			// **这里绝不能吞掉错误**：调用方的退避靠它触发。
			// 曾经吞成空结果，于是断网时 while 循环空转——1 毫秒内刷几十条日志、
			// 把 CPU 吃满，而"重试退避"那两行永远不会执行。
			throw error;
		}
	}

	/**
	 * 回答电脑端推来的提问。
	 *
	 * @param {string} askId 提问 id（来自 poll 的 asks）。
	 * @param {{id: string, selected: string[], custom?: string}[] | null} answers 每个问题一项；传 `null` 表示"本机答不了"。
	 * @param {AbortSignal} [signal] 取消信号。
	 * @returns {Promise<{ok: boolean, expired?: boolean}>} 服务端结果；`expired` 表示答晚了。
	 */
	async answer(askId, payload, signal) {
		// payload 为 null 表示"本机答不了"；否则原样带上（提问是 answers，审批是 outcome）。
		const body = payload === null ? { askId, decline: true } : { askId, ...payload };
		return this.request('answer', body, signal === undefined ? {} : { signal });
	}
}
