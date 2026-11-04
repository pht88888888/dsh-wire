/**
 * 电脑端服务的集成测试。
 *
 * 用一个"假引擎"（只实现被调用到的几个方法）驱动真实 HTTP 服务，
 * 因此测的是 `server.js` 的真实行为：路由、鉴权、序列化、长轮询唤醒。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDesktopServer, generateToken } from '../lib/server.js';

/**
 * 造一个最小引擎。
 *
 * `sessions` 里的每一项代表一个"活会话"，`seq` 变化就是有新事件。
 *
 * @param {Map<string, any>} sessions 会话表。
 * @param {string[]} prompts 收到 prompt 的记录，供断言。
 * @returns {any} 假上下文。
 */
function makeCtx(sessions, prompts) {
	return {
		sessions: {
			get: (id) => sessions.get(id)
		},
		sessionController: {
			async list() {
				return [...sessions.keys()].map((id) => ({ sessionId: id, updatedAt: 1 }));
			},
			async prompt(request, source) {
				prompts.push({ request, source });
				return { accepted: true };
			}
		},
		sessionQuery: {
			async readSession(sessionId) {
				const live = sessions.get(sessionId);
				if (live === undefined) throw new Error(`no session ${sessionId}`);
				return {
					session: { id: sessionId, cwd: '/work' },
					events: live.events,
					inheritedEventCount: 0
				};
			}
		},
		get: () => undefined
	};
}

/**
 * 起一个服务并返回调用工具。
 * @param {any} ctx 假上下文。
 * @returns {Promise<{origin: string, token: string, post: Function, close: Function}>} 工具集。
 */
async function start(ctx) {
	const token = generateToken();
	const server = createDesktopServer(ctx, { token, port: 0 });
	const origin = await server.listen();
	return {
		origin,
		token,
		/**
		 * 发一个请求。
		 * @param {string} path 端点。
		 * @param {any} body 请求体。
		 * @param {string} [auth] 令牌。
		 * @returns {Promise<{status: number, body: any}>} 响应。
		 */
		async post(path, body, auth = token) {
			const response = await fetch(`${origin}/dsh-wire${path}`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					...(auth === null ? {} : { authorization: `Bearer ${auth}` })
				},
				body: JSON.stringify(body ?? {})
			});
			const text = await response.text();
			return { status: response.status, body: text === '' ? {} : JSON.parse(text) };
		},
		close: () => server.close()
	};
}

test('没有令牌一律 401', async () => {
	const io = await start(makeCtx(new Map(), []));
	try {
		const response = await io.post('/hello', {}, null);
		assert.equal(response.status, 401);
		assert.equal(response.body.code, 'unauthorized');
	} finally {
		await io.close();
	}
});

test('错误令牌同样 401', async () => {
	const io = await start(makeCtx(new Map(), []));
	try {
		const response = await io.post('/hello', {}, 'x'.repeat(64));
		assert.equal(response.status, 401);
	} finally {
		await io.close();
	}
});

test('hello 返回协议版本', async () => {
	const io = await start(makeCtx(new Map(), []));
	try {
		const response = await io.post('/hello', {});
		assert.equal(response.status, 200);
		assert.equal(response.body.ok, true);
		assert.equal(response.body.role, 'desktop');
		assert.equal(typeof response.body.version, 'number');
	} finally {
		await io.close();
	}
});

test('list 直接转发引擎的会话摘要', async () => {
	const sessions = new Map([['s1', { seq: 0, events: [] }]]);
	const io = await start(makeCtx(sessions, []));
	try {
		const response = await io.post('/list', {});
		assert.equal(response.status, 200);
		assert.equal(response.body.sessions.length, 1);
		assert.equal(response.body.sessions[0].sessionId, 's1');
	} finally {
		await io.close();
	}
});

test('read 返回 header/events/cursor', async () => {
	const events = [
		{ seq: 0, type: 'turn/start' },
		{ seq: 1, type: 'message' }
	];
	const sessions = new Map([['s1', { seq: 1, events }]]);
	const io = await start(makeCtx(sessions, []));
	try {
		const response = await io.post('/read', { sessionId: 's1' });
		assert.equal(response.status, 200);
		assert.equal(response.body.header.id, 's1');
		assert.equal(response.body.events.length, 2);
		assert.equal(response.body.cursor, 1);
	} finally {
		await io.close();
	}
});

test('read 缺 sessionId 时报 500 且带稳定 code', async () => {
	const io = await start(makeCtx(new Map(), []));
	try {
		const response = await io.post('/read', {});
		assert.equal(response.status, 500);
		assert.equal(response.body.code, 'bad-request');
	} finally {
		await io.close();
	}
});

test('poll 立刻返回已有事件（不空等）', async () => {
	const events = [{ seq: 0, type: 'a' }, { seq: 1, type: 'b' }];
	const sessions = new Map([['s1', { seq: 1, events }]]);
	const io = await start(makeCtx(sessions, []));
	try {
		const started = Date.now();
		const response = await io.post('/poll', { watch: [{ sessionId: 's1', cursor: -1 }] });
		assert.equal(response.status, 200);
		assert.equal(response.body.updates.length, 1);
		assert.equal(response.body.updates[0].events.length, 2);
		assert.equal(response.body.updates[0].cursor, 1);
		// 有数据必须立即返回，不能把 25 秒挂满。
		assert.ok(Date.now() - started < 5_000, '有事件时不应等待超时');
	} finally {
		await io.close();
	}
});

test('poll 在会话无变化时挂起，变化后立刻返回增量', async () => {
	const events = [{ seq: 0, type: 'a' }];
	const sessions = new Map([['s1', { seq: 0, events }]]);
	const io = await start(makeCtx(sessions, []));
	try {
		const pending = io.post('/poll', { watch: [{ sessionId: 's1', cursor: 0 }] });
		// 挂起期间给"引擎"追加一个事件。
		await new Promise((resolve) => setTimeout(resolve, 300));
		events.push({ seq: 1, type: 'b' });
		sessions.set('s1', { seq: 1, events });
		const response = await pending;
		assert.equal(response.body.updates.length, 1);
		assert.equal(response.body.updates[0].events.length, 1);
		assert.equal(response.body.updates[0].events[0].seq, 1);
	} finally {
		await io.close();
	}
});

test('prompt 构造出引擎要求的 request 形状', async () => {
	const prompts = [];
	const sessions = new Map([['s1', { seq: 0, events: [] }]]);
	const io = await start(makeCtx(sessions, prompts));
	try {
		const response = await io.post('/prompt', { sessionId: 's1', text: '你好' });
		assert.equal(response.status, 200);
		assert.equal(prompts.length, 1);
		const { request, source } = prompts[0];
		assert.equal(request.sessionId, 's1');
		assert.equal(request.mode, 'followup');
		assert.deepEqual(request.content, [{ type: 'text', text: '你好' }]);
		assert.equal(typeof request.requestId, 'string');
		assert.ok(request.requestId.length > 0);
		// 第二个参数必须是 AbortSignal。以前传的是字符串 'user-rpc'，
		// DSH 内部 signal.throwIfAborted() 直接炸，消息发不出去。
		assert.equal(typeof source?.throwIfAborted, 'function');
		assert.equal(source?.aborted, false);
	} finally {
		await io.close();
	}
});

test('未知路径返回 404 而不是崩溃', async () => {
	const io = await start(makeCtx(new Map(), []));
	try {
		const response = await io.post('/nope', {});
		assert.equal(response.status, 404);
		assert.equal(response.body.code, 'not-found');
	} finally {
		await io.close();
	}
});
