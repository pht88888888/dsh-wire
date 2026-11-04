/**
 * 客户端传输层的行为约定。
 *
 * 这里只锁一条：**失败必须抛出去**。
 * 曾经把错误吞成空结果，导致手机端断网时 `while` 循环空转——
 * 1 毫秒内刷几十条日志、CPU 吃满，"重试退避 2 秒"那段代码永远走不到。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { WireClient } from '../lib/client.js';

test('poll 连不上时抛错，而不是返回空结果', async () => {
	const wire = new WireClient({ origin: 'http://127.0.0.1:9', token: 'test-token' });
	// 端口 9 上没有服务，连接会被立刻拒绝
	await assert.rejects(() => wire.poll([], new AbortController().signal));
});

test('poll 被主动取消时同样抛出交给上层判断', async () => {
	const wire = new WireClient({ origin: 'http://127.0.0.1:9', token: 'test-token' });
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(() => wire.poll([], controller.signal));
});
