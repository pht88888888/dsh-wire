/**
 * 插件装载测试：验证 `apply()` 这个对外契约本身能用。
 *
 * 前面的测试都是直接调模块函数；这个测试走的是 **DSH 真正加载插件时的那条路**：
 * `inject` 声明 → `apply(ctx, config)` → 运行时接线。契约写错的话，
 * 插件在真机上会「装上了但什么都不发生」，而这种失败没有报错、只能靠这个测试兜住。
 */

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// 状态目录必须在导入插件之前固定下来，否则会写到真实用户的 ~/.dsh 里。
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-wire-home-'));

const plugin = await import('../lib/index.js');

/**
 * 造一个够用的 cordis 上下文。
 *
 * 只实现插件实际用到的三样：`inject`、`effect`、`logger`。
 *
 * @param {any} services 要注入的服务。
 * @returns {{ctx: any, services: any, disposeAll: () => void}} 上下文与清理器。
 */
function makeCtx(services) {
	/** @type {(() => void)[]} */
	const disposers = [];

	/**
	 * 造一个带 effect 的上下文。
	 * @param {any} base 基础对象。
	 * @returns {any} 带 effect 的上下文。
	 */
	const withEffect = (base) => ({
		...base,
		effect(callback) {
			const dispose = callback();
			if (typeof dispose === 'function') disposers.push(dispose);
			return () => dispose?.();
		}
	});

	const ctx = withEffect({
		services,
		logger: { info() {}, warn() {}, error() {} },
		/**
		 * 注入服务后回调，模拟 cordis 的隔离上下文。
		 * @param {string[]} names 服务名。
		 * @param {Function} callback 回调。
		 * @returns {void}
		 */
		inject(names, callback) {
			const scopedServices = {};
			for (const name of names) scopedServices[name] = services[name];
			const scoped = withEffect({ ...ctx, ...scopedServices });
			callback(scoped);
		}
	});
	return { ctx, services, disposeAll: () => disposers.reverse().forEach((dispose) => dispose()) };
}

test('插件导出契约完整', () => {
	assert.equal(plugin.name, 'dsh-wire');
	assert.equal(typeof plugin.apply, 'function');
	assert.equal(typeof plugin.detectRole, 'function');
	assert.equal(typeof plugin.inject, 'object');
	// 全部声明为可选：两端职责不同，写死 required 会让插件在另一半环境里装不上。
	for (const [name, declaration] of Object.entries(plugin.inject)) {
		assert.equal(declaration.required, false, `${name} 应当是可选的`);
	}
});

test('角色判定：显式配置优先于平台推断', () => {
	assert.equal(plugin.detectRole({ role: 'desktop' }), 'desktop');
	assert.equal(plugin.detectRole({ role: 'mobile' }), 'mobile');
});

test('以 desktop 角色装载后确实开始监听', async () => {
	const { ctx, disposeAll } = makeCtx({
		sessions: { get: () => undefined },
		sessionController: { async list() { return []; } },
		sessionQuery: { async read() { throw new Error('unused'); } }
	});
	try {
		plugin.apply(ctx, { role: 'desktop', port: 18099 });
		// apply 内部异步接线，给它一点时间；连不上就一直重试，最多 3 秒。
		let healthy = false;
		for (let attempt = 0; attempt < 30; attempt += 1) {
			try {
				const response = await fetch('http://127.0.0.1:18099/dsh-wire/health');
				if (response.ok) {
					healthy = true;
					break;
				}
			} catch {
				/* 还没监听上，继续等 */
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		assert.ok(healthy, 'desktop 角色应当在本机起 HTTP 服务');
	} finally {
		disposeAll();
	}
});

test('以 mobile 角色装载且未配置地址时，不抛错、只是不启用代理', async () => {
	const { ctx, disposeAll } = makeCtx({
		sessions: { get: () => undefined },
		sessionController: { async list() { return [{ sessionId: 'local-1' }]; } },
		sessionQuery: { async read() { return { header: {}, events: [] }; } }
	});
	try {
		plugin.apply(ctx, { role: 'mobile' });
		await new Promise((resolve) => setTimeout(resolve, 300));
		// 没有配置时应当保持原样，绝不能把本地会话弄坏。
		const list = await ctx.services.sessionController.list();
		assert.equal(list.length, 1);
		assert.equal(list[0].sessionId, 'local-1');
	} finally {
		disposeAll();
	}
});
