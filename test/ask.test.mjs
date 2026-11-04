/**
 * 提问转发的测试。
 *
 * 这段逻辑的要害不是"怎么问"，而是**问不到人时不能把任何一端锁死**：
 * 电脑端在超时/手机答不了时必须回到本机前端。所以下面重点测的是那几条退路。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDesktopServer, generateToken } from '../lib/server.js';

/**
 * 造一个最小引擎。提问链路只用到挂起来的那部分，这里不需要真会话。
 * @returns {any} 假上下文。
 */
function makeCtx() {
	return {
		sessions: { get: () => undefined },
		sessionController: {
			async list() {
				return [];
			},
			async prompt() {
				return { accepted: true };
			}
		},
		sessionQuery: {
			async read() {
				throw new Error('本测试不读会话');
			}
		},
		get: () => undefined
	};
}

/**
 * 起服务并给出发请求的工具。
 * @returns {Promise<{server: any, post: Function, close: Function}>} 工具集。
 */
async function boot() {
	const token = generateToken();
	const server = createDesktopServer(makeCtx(), { token, port: 0 });
	const origin = await server.listen();
	return {
		server,
		/**
		 * 发一个已授权的请求。
		 * @param {string} path 端点。
		 * @param {any} body 请求体。
		 * @returns {Promise<any>} 响应体。
		 */
		async post(path, body) {
			const response = await fetch(`${origin}/dsh-wire${path}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
				body: JSON.stringify(body ?? {})
			});
			const text = await response.text();
			return text === '' ? {} : JSON.parse(text);
		},
		close: () => server.close()
	};
}

test('提问经长轮询送到手机，回答后带回答案', async () => {
	const io = await boot();
	try {
		const waiting = io.server.pushAsk({
			questions: [{ id: 'q1', text: '继续吗？', options: [{ label: '是' }, { label: '否' }] }]
		});
		const batch = await io.post('/poll', { watch: [] });
		assert.equal(batch.asks.length, 1);
		assert.equal(batch.asks[0].questions[0].id, 'q1');
		// 轮询过就说明手机在用——这是电脑端决定要不要把问题发给它的依据。
		assert.equal(io.server.isPhoneOnline(), true);

		const answered = await io.post('/answer', {
			askId: batch.asks[0].id,
			answers: [{ id: 'q1', selected: ['是'] }]
		});
		assert.equal(answered.ok, true);
		assert.deepEqual(await waiting, { answers: [{ id: 'q1', selected: ['是'] }] });
	} finally {
		await io.close();
	}
});

test('没人回答时超时返回 undefined，让调用方交回本机', async () => {
	const io = await boot();
	try {
		assert.equal(await io.server.pushAsk({ questions: [] }, { timeoutMs: 80 }), undefined);
	} finally {
		await io.close();
	}
});

test('手机答不了时 decline，立刻交回本机而不是干等', async () => {
	const io = await boot();
	try {
		const waiting = io.server.pushAsk({ questions: [] }, { timeoutMs: 30_000 });
		const batch = await io.post('/poll', { watch: [] });
		await io.post('/answer', { askId: batch.asks[0].id, decline: true });
		assert.equal(await waiting, undefined);
	} finally {
		await io.close();
	}
});

test('答晚了的回答不算错误', async () => {
	const io = await boot();
	try {
		const result = await io.post('/answer', { askId: 'ask-deadbeef', answers: [] });
		assert.equal(result.ok, true);
		assert.equal(result.expired, true);
	} finally {
		await io.close();
	}
});

test('没轮询过的手机视为离线，电脑端不会把问题发出去', async () => {
	const io = await boot();
	try {
		assert.equal(io.server.isPhoneOnline(), false);
	} finally {
		await io.close();
	}
});
