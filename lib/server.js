/**
 * 电脑端（desktop role）：把本机真实的 DSH 会话以 HTTP 暴露出去。
 *
 * 这里**不复制、不改写、不缓存任何会话数据**——每个端点都直接转发到引擎自己的服务，
 * 也就是说远端看到的就是本机看到的那一份。这是整个方案不出现一致性 bug 的根本原因：
 * 手机端没有副本，就没有"副本落后/超前"这回事。
 */

import { randomBytes } from 'node:crypto';
import http from 'node:http';

/**
 * 提问等手机回答的默认超时。
 *
 * 60 秒是有意的折中：太短会在用户掏手机时白白弹到电脑上，太长会让电脑端一直干等。
 * 超时**不是错误**，只是把问题交回本机前端。
 */
const ASK_TIMEOUT_MS = 60_000;

/** 同一提问重投间隔：足够手机端去重，又不至于真丢了就没人知道。 */
const ASK_REDELIVER_MS = 3_000;

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
 * @param {any} observation 从 readSession 归一化出来的观察结果。
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
/**
 * 电脑上有没有这个会话。
 *
 * 手机端可能带着一个它自己在本地新建的 id 过来，电脑这边没有。
 * @param {any} ctx 插件上下文。
 * @param {string} sessionId 会话 id。
 * @returns {Promise<boolean>} 存在返回 true。
 */
async function sessionExists(ctx, sessionId) {
	try {
		const loaded = await ctx.sessionQuery.readSession(sessionId);
		return loaded !== undefined && loaded !== null;
	} catch {
		return false;
	}
}

async function readEventsSince(ctx, sessionId, sinceSeq) {
	// sessionQuery 上没有 read()。真实方法 readSession(id) 只吃一个参数，
	// 返回 {session, inheritedEventCount, events}，也没有可 dispose 的租约。
	const loaded = await ctx.sessionQuery.readSession(sessionId);
	const all = Array.isArray(loaded?.events) ? loaded.events : [];
	const events = all.filter((event) => typeof event?.seq === 'number' && event.seq > sinceSeq);
	const last = all.length === 0 ? -1 : (all[all.length - 1].seq ?? -1);
	return { events, cursor: last };
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
	 * 等手机回答的提问。
	 *
	 * 键盘上的人只在一台设备前，所以这里的关键不是"怎么问"，而是**问不到时怎么办**：
	 * `pushAsk()` 超时返回 `undefined`，调用方据此 `next()` 交回本机前端，
	 * 绝不把电脑端也锁死。
	 *
	 * @type {Map<string, { payload: any, settle: (answer: any) => void }>}
	 */
	const pendingAsks = new Map();

	/** 最近一次收到手机轮询的时刻，用来判断"手机是不是真的在用"。 */
	let lastPollAt = 0;

	/** 手机在读的长轮询间隔远小于这个值；超过说明它已经走了。 */
	const PHONE_ONLINE_MS = 60_000;

	/**
	 * 手机现在是否在线。
	 * @returns {boolean} 最近一分钟内有没有轮询过。
	 */
	/**
	 * 撤掉一条还没被回答的待决项。
	 *
	 * 用在"本机先答了"的情形：既然结果已经定了，手机那张卡就该消失，
	 * 否则用户点下去没有任何反应，还会以为插件坏了。
	 *
	 * @param {string} id 待决项 id。
	 * @returns {boolean} 是否真的撤掉了。
	 */
	function cancelAsk(id) {
		const item = pendingAsks.get(id);
		if (item === undefined) return false;
		item.settle(undefined);
		return true;
	}

	function isPhoneOnline() {
		return lastPollAt !== 0 && Date.now() - lastPollAt < PHONE_ONLINE_MS;
	}

	/**
	 * 把一个提问推给手机，等它回答。
	 *
	 * @param {any} payload 要展示的内容（questions 等）。
	 * @param {{ timeoutMs?: number, signal?: AbortSignal }} [options] 超时与取消。
	 * @returns {Promise<any | undefined>} 答案；超时或取消返回 undefined。
	 */
	function pushAsk(payload, options = {}) {
		const id = `ask-${randomBytes(8).toString('hex')}`;
		const timeoutMs = options.timeoutMs ?? ASK_TIMEOUT_MS;
		return new Promise((resolve) => {
			let done = false;
			const finish = (answer) => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				pendingAsks.delete(id);
				options.signal?.removeEventListener?.('abort', onAbort);
				wakeAll();
				resolve(answer);
			};
			const onAbort = () => finish(undefined);
			const timer = setTimeout(() => finish(undefined), timeoutMs);
			options.signal?.addEventListener?.('abort', onAbort, { once: true });
			pendingAsks.set(id, { payload, settle: finish });
			options.onPending?.(id);
			wireLog(`[desktop] 提问待手机回答: ${id}`);
			// 立刻唤醒挂起的长轮询，别等下一个 tick。
			wakeAll();
		});
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
					const loaded = await ctx.sessionQuery.readSession(body.sessionId);
					const events = Array.isArray(loaded?.events) ? loaded.events : [];
					writeJson(res, 200, {
						ok: true,
						...serializeObservation({
							header: loaded?.session,
							events,
							cursor: events.length === 0 ? -1 : (events[events.length - 1].seq ?? -1),
							inheritedEventCount: loaded?.inheritedEventCount ?? 0
						})
					});
					return;
				}
				case ENDPOINTS.poll: {
					const body = await readJsonBody(req);
					lastPollAt = Date.now();
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
					// 手机端在本地新建的会话，电脑这边还不存在。直接 prompt 会抛
					// 「会话不存在」。这里先按它给的 id 建一个——create 支持指定
					// sessionId，两边就能用同一个 id，之后的消息都靠它对上。
					if (!(await sessionExists(ctx, body.sessionId))) {
						wireLog(`[prompt] 电脑上没有 ${body.sessionId}，按这个 id 建一个`);
						await ctx.sessionController.create({ sessionId: body.sessionId });
					}
					// 第二个参数是 AbortSignal，不是来源标记。DSH 内部第一行就是
					// signal.throwIfAborted()，给个字符串会直接抛
					// "signal.throwIfAborted is not a function"——消息根本发不出去。
					const result = await ctx.sessionController.prompt(
						{
							sessionId: body.sessionId,
							content,
							mode: body.mode === 'steer' ? 'steer' : 'followup',
							requestId: isId(body.requestId) ? body.requestId : `wire-${randomBytes(8).toString('hex')}`
						},
						// 给一个永不触发的 signal。别在半路 abort：prompt 返回后
						// agent 还会跑很久，abort 掉可能把正在跑的那一轮掐了。
						new AbortController().signal
					);
					writeJson(res, 200, { ok: true, result });
					return;
				}
				case ENDPOINTS.answer: {
					const body = await readJsonBody(req);
					if (typeof body.askId !== 'string' || body.askId === '') {
						throw new WireError('bad-request', '缺少 askId');
					}
					const pending = pendingAsks.get(body.askId);
					if (pending === undefined) {
						// 超时或已经答过了。手机晚到的回答不该报错——它只是在跟时间赛跑。
						writeJson(res, 200, { ok: true, expired: true });
						return;
					}
					// 手机接了却答不了（本机弹不出卡片）时明确声明，让电脑端立刻交回本机前端，
					// 不必干等到超时。
					if (body.decline === true) {
						pending.settle(undefined);
					} else {
						// 提问和审批共用这条回传通道：提问带 answers，审批带 outcome。
						// 没有的字段不要塞进去，否则调用方分不清"没有"和"空"。
						const settled = { answers: Array.isArray(body.answers) ? body.answers : [] };
						if (typeof body.outcome === 'string') settled.outcome = body.outcome;
						pending.settle(settled);
					}
					writeJson(res, 200, { ok: true });
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
		let lastAlive = [...pendingAsks.keys()].join(',');
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
			const asks = takeUndeliveredAsks();
			// alive：此刻还挂着的待决项。手机端据此清掉已被本机抢先处理掉的卡片，
			// 否则撤销只发生在电脑端，手机上那张卡会一直赖着不动。
			const alive = [...pendingAsks.keys()];
			const aliveKey = alive.join(',');
			// 待决项被撤掉也算一次变化，得立刻告诉手机端，不然卡片会赖着。
			if (updates.length > 0 || asks.length > 0 || aliveKey !== lastAlive) {
				lastAlive = aliveKey;
				return { updates, cursor: cursors, asks, alive };
			}
			await waitForTick(aborted.signal);
		}
		return { updates: [], cursor: cursors, asks: [], alive: [...pendingAsks.keys()] };
	}

	/**
	 * 取出还没投递过的提问。
	 *
	 * 投递过一段时间还没被回答的会**重投**：手机的这次轮询可能半路断掉，
	 * 一次丢了就再也没人问，所以宁可让手机端按 id 去重。
	 *
	 * @returns {any[]} 待投递的提问。
	 */
	function takeUndeliveredAsks() {
		const now = Date.now();
		const out = [];
		for (const [id, entry] of pendingAsks) {
			if (entry.sentAt !== undefined && now - entry.sentAt < ASK_REDELIVER_MS) continue;
			entry.sentAt = now;
			out.push({ id, ...entry.payload });
		}
		return out;
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
					// 监听地址和「本机怎么访问自己」是两回事：绑 0.0.0.0 是为了让
					// 局域网里的手机能连进来，但隧道、本机回连都得走 127.0.0.1——
					// 拿 0.0.0.0 当目标地址连不通。
					const host = bind === '0.0.0.0' || bind === '::' ? '127.0.0.1' : bind;
					const origin = `http://${host}:${address.port}`;
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
		 * 把提问推给手机并等它回答；超时返回 `undefined`，调用方据此交回本机前端。
		 *
		 * @param {any} payload 展示内容。
		 * @param {{ timeoutMs?: number, signal?: AbortSignal }} [askOptions] 超时与取消。
		 * @returns {Promise<any | undefined>} 答案或 undefined。
		 */
		pushAsk,
		/**
		 * 手机是否在线（最近一分钟内有轮询）。
		 * @returns {boolean} 在线为 true。
		 */
		cancelAsk,
		isPhoneOnline,
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
