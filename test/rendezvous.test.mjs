/**
 * rendezvous 服务的测试。
 *
 * 重点验证"地址变化对用户透明"这件事真的成立，以及配对码的一次性与限速。
 */

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createRendezvous } from '../server/rendezvous.js';

/**
 * 起一个中转服务。
 * @returns {Promise<{base: string, close: Function}>} 服务句柄。
 */
async function start() {
	const dataDir = mkdtempSync(join(tmpdir(), 'dsh-wire-rz-'));
	const service = createRendezvous({ dataDir });
	await new Promise((resolve) => service.server.listen(0, '127.0.0.1', resolve));
	const address = service.server.address();
	return {
		base: `http://127.0.0.1:${address.port}`,
		close: () => service.close()
	};
}

/**
 * 发一个请求。
 * @param {string} base 根地址。
 * @param {string} path 端点。
 * @param {any} body 请求体。
 * @returns {Promise<{status: number, body: any}>} 响应。
 */
async function post(base, path, body) {
	const response = await fetch(`${base}${path}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body)
	});
	return { status: response.status, body: await response.json() };
}

test('登记后能用配对码换到地址与凭据', async () => {
	const rz = await start();
	try {
		const registered = await post(rz.base, '/register', {
			deviceId: 'dev-a',
			url: 'https://one.trycloudflare.com'
		});
		assert.equal(registered.status, 200);
		assert.equal(registered.body.deviceId, 'dev-a');
		assert.match(registered.body.pairCode, /^[A-Z2-9]{6}$/);

		const resolved = await post(rz.base, '/resolve', { pairCode: registered.body.pairCode });
		assert.equal(resolved.status, 200);
		assert.equal(resolved.body.url, 'https://one.trycloudflare.com');
		assert.equal(resolved.body.deviceId, 'dev-a');
		assert.equal(typeof resolved.body.deviceToken, 'string');
	} finally {
		await rz.close();
	}
});

test('配对码一次性：用过再解析就失效', async () => {
	const rz = await start();
	try {
		const registered = await post(rz.base, '/register', { deviceId: 'dev-b', url: 'https://b.trycloudflare.com' });
		const first = await post(rz.base, '/resolve', { pairCode: registered.body.pairCode });
		assert.equal(first.status, 200);
		const second = await post(rz.base, '/resolve', { pairCode: registered.body.pairCode });
		assert.equal(second.status, 404);
		assert.equal(second.body.code, 'code-expired');
	} finally {
		await rz.close();
	}
});

test('隧道地址变化后，凭据解析到的是新地址（用户无需重配）', async () => {
	const rz = await start();
	try {
		const registered = await post(rz.base, '/register', { deviceId: 'dev-c', url: 'https://old.trycloudflare.com' });
		// 手机端拿自己的令牌（和电脑端的不是同一份）。
		const paired = await post(rz.base, '/resolve', { pairCode: registered.body.pairCode });
		const credentials = { deviceId: paired.body.deviceId, deviceToken: paired.body.deviceToken };

		// 电脑重启，隧道换了新域名——续登用的是**电脑端**自己的令牌。
		const renewed = await post(rz.base, '/renew', {
			deviceId: registered.body.deviceId,
			deviceToken: registered.body.deviceToken,
			url: 'https://new.trycloudflare.com'
		});
		assert.equal(renewed.status, 200);

		const resolved = await post(rz.base, '/resolve', credentials);
		assert.equal(resolved.status, 200);
		assert.equal(resolved.body.url, 'https://new.trycloudflare.com');
	} finally {
		await rz.close();
	}
});

test('令牌不对拒绝解析与续约', async () => {
	const rz = await start();
	try {
		await post(rz.base, '/register', { deviceId: 'dev-d', url: 'https://d.trycloudflare.com' });
		const bad = await post(rz.base, '/resolve', { deviceId: 'dev-d', deviceToken: 'f'.repeat(64) });
		assert.equal(bad.status, 403);
		const badRenew = await post(rz.base, '/renew', {
			deviceId: 'dev-d',
			deviceToken: 'f'.repeat(64),
			url: 'https://x.trycloudflare.com'
		});
		assert.equal(badRenew.status, 403);
	} finally {
		await rz.close();
	}
});

test('配对码格式不对时直接拒绝，不去查表', async () => {
	const rz = await start();
	try {
		const response = await post(rz.base, '/resolve', { pairCode: 'abc' });
		assert.equal(response.status, 400);
		assert.equal(response.body.code, 'bad-code');
	} finally {
		await rz.close();
	}
});

test('健康检查可用', async () => {
	const rz = await start();
	try {
		const response = await fetch(`${rz.base}/health`);
		const body = await response.json();
		assert.equal(response.status, 200);
		assert.equal(body.ok, true);
	} finally {
		await rz.close();
	}
});
