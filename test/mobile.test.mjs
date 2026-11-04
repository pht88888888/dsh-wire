/**
 * 手机端代理层的测试。
 *
 * 关注的是"绝不干扰本地会话"这条底线：本地 id 必须原样走原实现，
 * 只有远程 id 才会被转发。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { installMobileProxy } from '../lib/mobile.js';

/**
 * 造一个只有本地会话的假上下文。
 * @returns {any} 上下文，附带断言用的记录数组。
 */
function makeCtx() {
	const live = new Map([['local-1', { seq: 3 }]]);
	const calls = { localRead: [], localPrompt: [], localList: 0 };
	return {
		live,
		calls,
		sessions: { get: (id) => live.get(id) },
		sessionController: {
			async list() {
				calls.localList += 1;
				return [{ sessionId: 'local-1' }];
			},
			async prompt(request) {
				calls.localPrompt.push(request);
				return { accepted: true, local: true };
			}
		},
		sessionQuery: {
			async read(sessionId) {
				calls.localRead.push(sessionId);
				return {
					source: 'live',
					header: { id: sessionId },
					events: [{ seq: 0, type: 'local' }],
					cursor: 0,
					inheritedEventCount: 0,
					retain: () => ({}),
					[Symbol.dispose]: () => {}
				};
			},
			async observeSession(sessionId) {
				return this.read(sessionId);
			},
			async listSessions() {
				return [{ header: { id: 'local-1' } }];
			}
		}
	};
}

/**
 * 造一个假电脑端。
 * @param {Record<string, any>} remote 远程会话表：id → 事件数组。
 * @returns {any} 客户端桩。
 */
function makeWire(remote) {
	const calls = { prompt: [] };
	return {
		calls,
		async list() {
			return Object.keys(remote).map((sessionId) => ({ sessionId }));
		},
		async read(sessionId) {
			if (!(sessionId in remote)) throw new Error(`电脑上没有 ${sessionId}`);
			const events = remote[sessionId];
			return {
				header: { id: sessionId },
				events,
				cursor: events.length === 0 ? -1 : events[events.length - 1].seq,
				inheritedEventCount: 0
			};
		},
		async prompt(sessionId, text) {
			calls.prompt.push({ sessionId, text });
			return { result: { accepted: true } };
		}
	};
}

test('list 合入远程摘要，且本地项不重复', async () => {
	const ctx = makeCtx();
	const wire = makeWire({ 'remote-1': [{ seq: 0 }] });
	installMobileProxy(ctx, wire);

	const result = await ctx.sessionController.list();
	assert.deepEqual(
		result.map((item) => item.sessionId),
		['local-1', 'remote-1']
	);
	assert.equal(ctx.calls.localList, 1);
});

test('本地会话的 read 原样走原实现', async () => {
	const ctx = makeCtx();
	const wire = makeWire({ 'remote-1': [] });
	installMobileProxy(ctx, wire);

	const observation = await ctx.sessionQuery.read('local-1');
	assert.deepEqual(ctx.calls.localRead, ['local-1']);
	assert.equal(observation.source, 'live');
	assert.equal(observation.events[0].type, 'local');
	observation[Symbol.dispose]();
});

test('远程会话的 read 转发电脑，且不写任何本地状态', async () => {
	const ctx = makeCtx();
	const wire = makeWire({ 'remote-1': [{ seq: 0, type: 'a' }, { seq: 1, type: 'b' }] });
	installMobileProxy(ctx, wire);

	const observation = await ctx.sessionQuery.read('remote-1');
	// 关键断言：本地 read 一次都没被调用。
	assert.deepEqual(ctx.calls.localRead, []);
	assert.equal(observation.header.id, 'remote-1');
	assert.equal(observation.events.length, 2);
	assert.equal(observation.cursor, 1);
	assert.equal(observation.source, 'prepared');
	observation[Symbol.dispose]();
});

test('未经 list 直接按 id 打开远程会话也能命中（探测路径）', async () => {
	const ctx = makeCtx();
	const wire = makeWire({ 'remote-9': [{ seq: 0 }] });
	installMobileProxy(ctx, wire);

	const observation = await ctx.sessionQuery.read('remote-9');
	assert.equal(observation.header.id, 'remote-9');
	assert.deepEqual(ctx.calls.localRead, []);
});

test('两端都没有的 id 退回本地实现（不抛）', async () => {
	const ctx = makeCtx();
	const wire = makeWire({});
	installMobileProxy(ctx, wire);

	// 本地实现本身不校验存在性，这里只确认"没有把请求发给电脑后卡住"。
	const observation = await ctx.sessionQuery.read('ghost');
	assert.deepEqual(ctx.calls.localRead, ['ghost']);
	assert.equal(observation.source, 'live');
});

test('远程会话的 prompt 转发电脑，本地 prompt 不受影响', async () => {
	const ctx = makeCtx();
	const wire = makeWire({ 'remote-1': [] });
	installMobileProxy(ctx, wire);
	await ctx.sessionController.list();

	await ctx.sessionController.prompt({
		sessionId: 'remote-1',
		content: [{ type: 'text', text: '你好' }]
	});
	assert.deepEqual(wire.calls.prompt, [{ sessionId: 'remote-1', text: '你好' }]);
	assert.deepEqual(ctx.calls.localPrompt, []);

	await ctx.sessionController.prompt({
		sessionId: 'local-1',
		content: [{ type: 'text', text: '本地' }]
	});
	assert.equal(ctx.calls.localPrompt.length, 1);
	assert.equal(wire.calls.prompt.length, 1);
});

test('listSessions 补出远程记录，让上层能枚举到', async () => {
	const ctx = makeCtx();
	const wire = makeWire({ 'remote-1': [{ seq: 0 }] });
	installMobileProxy(ctx, wire);
	await ctx.sessionController.list();
	await ctx.sessionQuery.read('remote-1');

	const records = await ctx.sessionQuery.listSessions();
	const ids = records.map((record) => record.header.id);
	assert.ok(ids.includes('local-1'));
	assert.ok(ids.includes('remote-1'));
});

test('卸载后所有方法恢复原实现', async () => {
	const ctx = makeCtx();
	const wire = makeWire({ 'remote-1': [] });
	const uninstall = installMobileProxy(ctx, wire);
	uninstall();

	ctx.calls.localList = 0;
	const result = await ctx.sessionController.list();
	assert.equal(result.length, 1);
	assert.equal(result[0].sessionId, 'local-1');
});
