import assert from 'node:assert/strict';
import { test } from 'node:test';

import { diagnose } from '../lib/diagnose.js';

test('没装 cloudflared 时明确指出缺什么、去哪装', async () => {
	const result = await diagnose({ cloudflared: { found: false } });
	const binary = result.steps.find((step) => step.id === 'binary');
	assert.equal(binary.status, 'bad');
	assert.match(binary.hint ?? '', /下载/);
	// 汇总必须是给用户看的结论，不是错误码
	assert.match(result.summary, /没找到|没过/);
});

test('cloudflared 找到了就算正常，并把版本带出来', async () => {
	const result = await diagnose({
		cloudflared: { found: true, version: '2026.10.7', path: 'cloudflared' }
	});
	const binary = result.steps.find((step) => step.id === 'binary');
	assert.equal(binary.status, 'ok');
	assert.match(binary.detail, /2026\.10\.7/);
});

test('设了代理环境变量要提醒可能拦掉连接', async () => {
	const original = process.env.HTTPS_PROXY;
	process.env.HTTPS_PROXY = 'http://127.0.0.1:7890';
	try {
		const result = await diagnose({ cloudflared: { found: true, version: 'x', path: 'cloudflared' } });
		const proxy = result.steps.find((step) => step.id === 'proxy');
		assert.equal(proxy.status, 'warn');
		assert.match(proxy.detail, /HTTPS_PROXY/);
	} finally {
		if (original === undefined) delete process.env.HTTPS_PROXY;
		else process.env.HTTPS_PROXY = original;
	}
});

test('每一项都带标题和结论，不会出现空项', async () => {
	const result = await diagnose({ cloudflared: { found: true, version: 'x', path: 'cloudflared' } });
	for (const step of result.steps) {
		assert.ok(step.id.length > 0, 'id 不能为空');
		assert.ok(step.title.length > 0, '标题不能为空');
		assert.ok(step.detail.length > 0, '详情不能为空');
		assert.ok(['ok', 'warn', 'bad', 'skip'].includes(step.status), `未知状态 ${step.status}`);
	}
	assert.ok(result.steps.length >= 3);
});
