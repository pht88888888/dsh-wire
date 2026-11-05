/**
 * 「手机上新建的会话会自动升级成电脑上的会话」这条行为的测试。
 *
 * 关键是分寸：空会话可以挪（电脑按同一个 id 建一个），
 * 有真实内容的绝对不能挪——挪了用户会看到内容凭空少一截。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { installMobileProxy } from '../lib/mobile.js';

/**
 * 造一个最小的手机端上下文。
 *
 * @param {any[]} localEvents 这个本地会话已有的事件。
 * @param {{listFails?: boolean}} [options] 让远程列表请求失败。
 * @returns {{ctx: any, calls: any}} 上下文与调用记录。
 */
function makeCtx(localEvents, options = {}) {
	const calls = { localPrompt: [], remotePrompt: [] };
	const ctx = {
		sessionController: {
			async prompt(request) {
				calls.localPrompt.push(request);
				return { accepted: true, local: true };
			},
			async list() {
				return [];
			},
			async create() {
				return 'x';
			}
		},
		sessionQuery: {
			async readSession() {
				return { header: { id: 'new-1' }, events: localEvents };
			},
			async listSessions() {
				return [];
			}
		}
	};
	const wire = {
		async list() {
			if (options.listFails === true) throw new Error('连不上');
			return { sessions: [] };
		},
		async prompt(sessionId, text) {
			calls.remotePrompt.push({ sessionId, text });
			return { result: { ok: true } };
		},
		async read() {
			throw new Error('不该被调用');
		}
	};
	const off = installMobileProxy(ctx, wire, undefined, () => {});
	calls.off = off;
	return { ctx, calls };
}

const SETUP_ONLY = [
	{ type: 'permission/preset' },
	{ type: 'sandbox/mode' },
	{ type: 'approval/policy' }
];

test('只有初始化事件的空会话会被升级成远程，消息转发电脑', async () => {
	const { ctx, calls } = makeCtx(SETUP_ONLY);
	await ctx.sessionController.prompt({
		sessionId: 'new-1',
		content: [{ type: 'text', text: '你好' }]
	});
	assert.equal(calls.remotePrompt.length, 1, '应该转发到电脑');
	assert.equal(calls.remotePrompt[0].text, '你好');
	assert.equal(calls.localPrompt.length, 0, '不应该在本地跑');
	calls.off();
});

test('已经聊过的本地会话不会被挪走', async () => {
	const { ctx, calls } = makeCtx([...SETUP_ONLY, { type: 'message', role: 'user' }]);
	await ctx.sessionController.prompt({
		sessionId: 'new-1',
		content: [{ type: 'text', text: '继续' }]
	});
	assert.equal(calls.remotePrompt.length, 0, '不该转发');
	assert.equal(calls.localPrompt.length, 1, '应该走本地');
	calls.off();
});

test('电脑连不上时空会话也留在本地，不会发不出去', async () => {
	const { ctx, calls } = makeCtx(SETUP_ONLY, { listFails: true });
	await ctx.sessionController.prompt({
		sessionId: 'new-1',
		content: [{ type: 'text', text: '你好' }]
	});
	assert.equal(calls.remotePrompt.length, 0);
	assert.equal(calls.localPrompt.length, 1, '至少要能在本地发出去');
	calls.off();
});
