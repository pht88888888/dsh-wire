/**
 * 电脑端（desktop role）：把本机真实的 DSH 会话以 HTTP 暴露出去。
 *
 * 这里**不复制、不改写、不缓存任何会话数据**——每个端点都直接转发到引擎自己的服务，
 * 也就是说远端看到的就是本机看到的那一份。这是整个方案不出现一致性 bug 的根本原因：
 * 手机端没有副本，就没有"副本落后/超前"这回事。
 */

import { randomBytes } from 'node:crypto';
import http from 'node:http';

import { wireLog } from './log.js';
import {
	ENDPOINTS,
	POLL_HOLD_MS,
	PROTO_VERSION,
	ROUTE_PREFIX,
	WireError,
	isId,
	readJsonBody,
	toErrorBody,
	writeJson
} from './proto.js';

/** 长轮询期间检查新事件的间隔。够小以至于感觉是实时，够大以至于不空转 CPU。 */
const POLL_TICK_MS = 120;

/**
 * 把引擎对象里可 JSON 化的部分取出来。
 *
 * `read()` 返回的 observation 带 `projections`，其中可能含函数或循环引用。
 * 直接 `JSON.stringify` 会抛，所以这里逐字段尝试，失败就**丢掉该字段而不是丢掉整个响应**。
 *
 * @param {any} observation `sessionQuery.read()` 的结果。
 * @returns {{header: any, events: any[], cursor: number, inheritedEventCount: number, projections?: any}}
 */
function serializeObservation(observation) {
	const payload = {
		header: observation.header,
		events: observation.events,
		cursor: observation.cursor,
		inheritedEventCount: observation.inheritedEventCount ?? 0
	};
	if (observation.projections !== undefined) {
		try {
			// 探一次：不可序列化就整块不用，别让前端拿到半个 projections。
			JSON.stringify(observation.projections);
			payload.projections = observation.projections;
		} catch {
			/* 丢掉 projections，header + events 足够渲染 */
		}
	}
	return payload;
}

/**
 * 读出某个会话在 `sinceSeq` 之后的事件。
 *
 * 增量靠事件的 `seq` 过滤，不依赖任何本地计数器——`seq` 是引擎自己写的权威值，
 * 我们只读不推算。
 *
 * @param {any} ctx 插件上下文。
 * @param {string} sessionId 会话 id。
 * @param {number} sinceSeq 已经拿到的最后一个 seq。
 * @returns {Promise<{events: any[], cursor: number}>} 增量事件与最新游标。
 */
async function readEventsSince(ctx, sessionId, sinceSeq) {
	const observation = await ctx.sessionQuery.read(sessionId, {
		projectionMode: 'none'
	});
	try {
		const all = observation.events ?? [];
		const events = all.filter((event) => typeof event?.seq === 'number' && event.seq > sinceSeq);
		const last = all.length === 0 ? -1 : (all[all.length - 1].seq ?? -1);
		return { events, cursor: last };
	} finally {
		observation?.[Symbol.dispose]?.();
	}
}

/**
 * 创建一个电脑端服务实例。
 *
 * @param {any} ctx 插件上下文。
 * @param {{token: string, port?: number, bind?: string}} options 令牌与监听参数。
 * @returns {{origin: string, token: string, close: () => Promise<void>, server: http.Server}}
 */
export function createDesktopServer(ctx, options) {
	const token = options.token;
	const bind = options.bind ?? '127.0.0.1';

	/** @type {Map<string, boolean>} 当前被客户端关注的会话，决定长轮询要不要唤醒。 */
	const watched = new Map();

	/** @type {Set<() => void>} 正在挂起的轮询，事件到达时立刻唤醒它们。 */
	const waiters = new Set();

	/** 唤醒所有挂起的轮询。 */
	function wakeAll() {
		for (const wake of [...waiters]) wake();
	}

	/**
	 * 授权检查。没有令牌一律 401——隧道地址暴露在公网，这是唯一一道门。
	 * @param {import('node:http').IncomingMessage} req 请求。
	 * @returns {boolean} 是否放行。
	 */
	function authorized(req) {
		const header = req.headers.authorization ?? '';
		if (!header.startsWith('Bearer ')) return false;
		const given = Buffer.from(header.slice(7));
		const want = Buffer.from(token);
		return given.length === want.length && given.equals(want);
	}

	/**
	 * 处理一个 API 请求。
	 * @param {import('node:http').IncomingMessage} req 请求。
	 * @param {import('node:http').ServerResponse} res 响应。
	 */
	async function handle(req, res) {
		const url = new URL(req.url ?? '/', 'http://localhost');
		const path = url.pathname;

		if (path === `${ROUTE_PREFIX}${ENDPOINTS.health}`) {
			writeJson(res, 200, { ok: true, version: PROTO_VERSION });
			return;
		}
		if (!path.startsWith(ROUTE_PREFIX)) {
			writeJson(res, 404, { ok: false, code: 'not-found', message: '未知路径' });
			return;
		}
		if (!authorized(req)) {
			writeJson(res, 401, { ok: false, code: 'unauthorized', message: '令牌无效' });
			return;
		}

		const action = path.slice(ROUTE_PREFIX.length);
		try {
			switch (action) {
				case ENDPOINTS.hello:
					writeJson(res, 200, { ok: true, version: PROTO_VERSION, role: 'desktop' });
					return;
				case ENDPOINTS.list: {
					const signal = abortSignalFrom(res);
					const sessions = await ctx.sessionController.list(signal);
					writeJson(res, 200, { ok: true, sessions });
					return;
				}
				case ENDPOINTS.read: {
					const body = await readJsonBody(req);
					if (!isId(body.sessionId)) throw new WireError('bad-request', '缺少 sessionId');
					const signal = abortSignalFrom(res);
					const observation = await ctx.sessionQuery.read(body.sessionId, {
						signal,
						projectionMode: 'all'
					});
					try {
						writeJson(res, 200, { ok: true, ...serializeObservation(observation) });
					} finally {
						observation?.[Symbol.dispose]?.();
					}
					return;
				}
				case ENDPOINTS.poll: {
					const body = await readJsonBody(req);
					const resume = await pollOnce(body, res);
					if (!res.writableEnded) writeJson(res, 200, { ok: true, ...resume });
					return;
				}
				case ENDPOINTS.prompt: {
					const body = await readJsonBody(req);
					if (!isId(body.sessionId)) throw new WireError('bad-request', '缺少 sessionId');
					const text = typeof body.text === 'string' ? body.text : '';
					if (text === '' && !Array.isArray(body.content)) {
						throw new WireError('bad-request', 'prompt 内容为空');
					}
					const content = Array.isArray(body.content)
						? body.content
						: [{ type: 'text', text }];
					const result = await ctx.sessionController.prompt(
						{
							sessionId: body.sessionId,
							content,
							mode: body.mode === 'steer' ? 'steer' : 'followup',
							requestId: isId(body.requestId) ? body.requestId : `wire-${randomBytes(8).toString('hex')}`
						},
						'user-rpc'
					);
					writeJson(res, 200, { ok: true, result });
					return;
				}
				case ENDPOINTS.answer: {
					const body = await readJsonBody(req);
					const questions = ctx.get?.('userQuestions');
					if (questions === undefined) {
						throw new WireError('unsupported', '本机没有安装 userQuestions 服务');
					}
					const result = await questions.answer({
						id: body.id,
						selected: Array.isArray(body.selected) ? body.selected : [],
						...(typeof body.custom === 'string' ? { custom: body.custom } : {})
					});
					writeJson(res, 200, { ok: true, result });
					return;
				}
				default:
					writeJson(res, 404, { ok: false, code: 'not-found', message: `未知端点 ${action}` });
					return;
			}
		} catch (error) {
			const body = toErrorBody(error);
			wireLog(`[desktop] ${action} 失败: ${body.code} ${body.message}`);
			if (!res.writableEnded) writeJson(res, 500, body);
		}
	}

	/**
	 * 单次长轮询：等到有新事件、或等到超时、或客户端断开。
	 *
	 * @param {any} body 客户端上报的会话游标列表。
	 * @param {import('node:http').ServerResponse} res 响应。
	 * @returns {Promise<{updates: any[], cursor: Record<string, number>}>} 本批增量。
	 */
	async function pollOnce(body, res) {
		const wanted = Array.isArray(body.watch) ? body.watch : [];
		/** @type {Record<string, number>} 客户端声明的游标 */
		const cursors = {};
		for (const item of wanted) {
			if (!isId(item?.sessionId)) continue;
			cursors[item.sessionId] = typeof item.cursor === 'number' ? item.cursor : -1;
			watched.set(item.sessionId, true);
		}

		const deadline = Date.now() + POLL_HOLD_MS;
		const aborted = new AbortController();
		res.on('close', () => aborted.abort());

		while (Date.now() < deadline && !aborted.signal.aborted) {
			const updates = [];
			for (const [sessionId, since] of Object.entries(cursors)) {
				if (aborted.signal.aborted) break;
				// 先看引擎自己的 seq：没变就立刻跳过，避免每 120ms 全量重读一遍事件。
				// 冷会话不在内存里，`get()` 为 undefined，此时不可能有新事件，同样跳过。
				const liveSeq = ctx.sessions.get(sessionId)?.seq ?? -1;
				if (liveSeq <= since) continue;
				let fresh;
				try {
					fresh = await readEventsSince(ctx, sessionId, since);
				} catch (error) {
					// 会话被删/被换走不是致命错误，跳过它，别让整条长轮询炸掉。
					wireLog(`[desktop] poll 读 ${sessionId} 失败: ${error.message}`);
					continue;
				}
				if (fresh.events.length > 0) {
					cursors[sessionId] = fresh.cursor;
					updates.push({ sessionId, events: fresh.events, cursor: fresh.cursor });
				}
			}
			if (updates.length > 0) return { updates, cursor: cursors };
			await waitForTick(aborted.signal);
		}
		return { updates: [], cursor: cursors };
	}

	/**
	 * 等到下一次检查、或被唤醒、或被中止。
	 * @param {AbortSignal} signal 中止信号。
	 * @returns {Promise<void>} 到时/唤醒/中止时完成。
	 */
	function waitForTick(signal) {
		return new Promise((resolve) => {
			let done = false;
			const finish = () => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				waiters.delete(finish);
				signal.removeEventListener('abort', finish);
				resolve();
			};
			const timer = setTimeout(finish, POLL_TICK_MS);
			waiters.add(finish);
			signal.addEventListener('abort', finish, { once: true });
		});
	}

	const server = http.createServer((req, res) => {
		handle(req, res).catch((error) => {
			wireLog(`[desktop] 未捕获: ${error?.message ?? error}`);
			if (!res.writableEnded) writeJson(res, 500, toErrorBody(error));
		});
	});

	return {
		server,
		token,
		/**
		 * 开始监听。
		 * @returns {Promise<string>} 监听到的 origin。
		 */
		listen() {
			return new Promise((resolve, reject) => {
				server.once('error', reject);
				server.listen(options.port ?? 0, bind, () => {
					const address = server.address();
					const origin = `http://${bind}:${address.port}`;
					wireLog(`[desktop] 监听 ${origin}`);
					resolve(origin);
				});
			});
		},
		/**
		 * 事件到达时主动唤醒挂起的轮询，让推送看起来是即时的。
		 */
		notify() {
			wakeAll();
		},
		/**
		 * 关闭服务。
		 * @returns {Promise<void>} 关闭完成。
		 */
		close() {
			wakeAll();
			return new Promise((resolve) => server.close(() => resolve()));
		}
	};
}

/**
 * 从响应对象派生一个中止信号，客户端断开时通知下游取消。
 * @param {import('node:http').ServerResponse} res 响应。
 * @returns {AbortSignal} 中止信号。
 */
function abortSignalFrom(res) {
	const controller = new AbortController();
	res.on('close', () => controller.abort());
	return controller.signal;
}

/**
 * 生成一个 32 字节的随机令牌（hex）。
 * @returns {string} 令牌。
 */
export function generateToken() {
	return randomBytes(32).toString('hex');
}
