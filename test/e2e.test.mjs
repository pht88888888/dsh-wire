/**
 * 端到端测试：真实 HTTP 服务 + 真实客户端 + 真实代理层。
 *
 * 单测各自通过不代表拼起来能跑——序列化形状、超时、异常映射都可能在衔接处出问题。
 * 这里用最小代价把两端真的连起来跑一遍。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { WireClient } from '../lib/client.js';
import { installMobileProxy } from '../lib/mobile.js';
import { createDesktopServer, generateToken } from '../lib/server.js';

/**
 * 起一个电脑端。
 * @param {Map<string, any>} sessions 会话表（id → {seq, events}）。
 * @param {any[]} prompts prompt 记录。
 * @returns {Promise<{origin: string, token: string, close: Function}>} 连接信息。
 */
async function startDesktop(sessions, prompts) {
	const ctx = {
		sessions: { get: (id) => sessions.get(id) },
		sessionController: {
			async list() {
				return [...sessions.keys()].map((sessionId) => ({ sessionId }));
			},
			async prompt(request) {
				prompts.push(request);
				return { accepted: true };
			}
		},
		sessionQuery: {
			async readSession(sessionId) {
				const live = sessions.get(sessionId);
				if (live === undefined) throw new Error('not found');
				return {
					session: { id: sessionId, title: '电脑上的会话' },
					events: live.events,
					inheritedEventCount: 0
				};
			}
		},
		get: () => undefined
	};
	const token = generateToken();
	const server = createDesktopServer(ctx, { token, port: 0 });
	const origin = await server.listen();
	return { origin, token, close: () => server.close() };
}

/**
 * 造一个空的手机端上下文（没有本地会话）。
 * @returns {any} 上下文。
 */
function makeMobileCtx() {
	return {
		sessions: { get: () => undefined },
		sessionController: {
			async list() {
				return [];
			},
			async prompt() {
				throw new Error('本地 prompt 不该被调用');
			}
		},
		sessionQuery: {
			async read() {
				throw new Error('本地 read 不该被调用');
			},
			async observeSession() {
				throw new Error('本地 observeSession 不该被调用');
			},
			async listSessions() {
				return [];
			}
		}
	};
}

test('端到端：手机上能看到电脑的会话、内容，并把消息发过去', async () => {
	const prompts = [];
	const sessions = new Map([
		['remote-1', { seq: 1, events: [{ seq: 0, type: 'turn/start' }, { seq: 1, type: 'message' }] }]
	]);
	const desktop = await startDesktop(sessions, prompts);
	try {
		const wire = new WireClient({ origin: desktop.origin, token: desktop.token });
		const hello = await wire.hello();
		assert.equal(hello.role, 'desktop');

		const mobile = makeMobileCtx();
		installMobileProxy(mobile, wire);

		// 1. 列表里出现电脑的会话
		const list = await mobile.sessionController.list();
		assert.equal(list.length, 1);
		assert.equal(list[0].sessionId, 'remote-1');

		// 2. 打开会话能读到电脑的事件
		const observation = await mobile.sessionQuery.read('remote-1');
		assert.equal(observation.header.title, '电脑上的会话');
		assert.equal(observation.events.length, 2);
		assert.equal(observation.cursor, 1);

		// 3. 发消息真的到达电脑
		await mobile.sessionController.prompt({
			sessionId: 'remote-1',
			content: [{ type: 'text', text: '从手机发的' }]
		});
		assert.equal(prompts.length, 1);
		assert.equal(prompts[0].sessionId, 'remote-1');
		assert.deepEqual(prompts[0].content, [{ type: 'text', text: '从手机发的' }]);

		observation[Symbol.dispose]();
	} finally {
		await desktop.close();
	}
});

test('端到端：长轮询能把电脑的新事件增量推给手机', async () => {
	const sessions = new Map([['remote-1', { seq: 0, events: [{ seq: 0, type: 'a' }] }]]);
	const desktop = await startDesktop(sessions, []);
	try {
		const wire = new WireClient({ origin: desktop.origin, token: desktop.token });
		const pending = wire.poll([{ sessionId: 'remote-1', cursor: 0 }], new AbortController().signal);
		await new Promise((resolve) => setTimeout(resolve, 250));
		sessions.set('remote-1', {
			seq: 1,
			events: [{ seq: 0, type: 'a' }, { seq: 1, type: 'b' }]
		});
		const batch = await pending;
		assert.equal(batch.updates.length, 1);
		assert.equal(batch.updates[0].events.length, 1);
		assert.equal(batch.updates[0].events[0].seq, 1);
	} finally {
		await desktop.close();
	}
});

test('端到端：令牌不对时客户端抛出明确错误', async () => {
	const desktop = await startDesktop(new Map(), []);
	try {
		const wire = new WireClient({ origin: desktop.origin, token: 'wrong-token-value' });
		await assert.rejects(() => wire.hello(), (error) => {
			assert.equal(error.code, 'unauthorized');
			return true;
		});
	} finally {
		await desktop.close();
	}
});

test('端到端：电脑不可达时列表不抛，只是少了远程部分', async () => {
	const wire = new WireClient({ origin: 'http://127.0.0.1:1', token: 'x' });
	const mobile = makeMobileCtx();
	installMobileProxy(mobile, wire);
	const list = await mobile.sessionController.list();
	assert.deepEqual(list, []);
});
