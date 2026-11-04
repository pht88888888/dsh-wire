/**
 * dsh-wire —— 把电脑上的 DSH 会话接到手机。
 *
 * ## 为什么是「代理」而不是「镜像」
 *
 * 旧做法是在手机上建一份本地会话、把电脑的事件抄进去。那条路必然脆弱：
 * 抄写的一方要额外维护 `seq` 对齐与 turn 闭合，任何一处偏差都会让引擎的
 * v4 校验器拒绝整条日志（`dsh-session-format-v3-to-v4` 对格式错误只重抛、不恢复），
 * 表现就是会话从列表里消失。
 *
 * 这里换一条路：**手机端不持有会话数据**。它只把「读这个会话」的调用转发给电脑，
 * 拿回电脑上的真实数据再交还给前端。没有副本，就没有副本与源不一致的问题。
 *
 * ## 角色
 *
 * 同一个包在两个角色下运行：
 * - `desktop`：在电脑上把真实会话用 HTTP 暴露出去（配 cloudflared 快速隧道）。
 * - `mobile`：在手机上包装本地服务，把对远程会话的访问转发给电脑。
 *
 * 角色由配置显式指定优先，否则按平台推断。
 */

import { readFileSync } from 'node:fs';

import { ADMIN_PREFIX, createAdminHandler } from './admin.js';
import { createAskQueue } from './ask-queue.js';
import { loadConfig } from './config.js';
import { startRuntime } from './runtime.js';
import { setStatus } from './status.js';

export const name = 'dsh-wire';
/**
 * 服务依赖。
 *
 * 全部声明为可选：这个插件在两端职责完全不同，写死 required 会让它在
 * 不需要那一半的环境里装不上（例如手机上根本没有 `webServer` 之外的东西）。
 * 真正缺什么在 `apply()` 里按角色判定并给出明确日志。
 */
export const inject = {
	webServer: { required: false },
	sessions: { required: false },
	sessionController: { required: false },
	sessionQuery: { required: false },
	workspaceController: { required: false },
	userQuestions: { required: false },
	connection: { required: false }
};

/**
 * 判定本进程的角色。
 *
 * 显式配置永远优先——自动化测试和"电脑上模拟手机"都需要这个逃生口。
 *
 * @param {{role?: string}} [config] 插件配置。
 * @returns {'desktop' | 'mobile'} 角色。
 */
export function detectRole(config) {
	const explicit = config?.role;
	if (explicit === 'desktop' || explicit === 'mobile') return explicit;
	return process.platform === 'android' ? 'mobile' : 'desktop';
}

/**
 * 插件入口。
 *
 * @param {any} ctx cordis 上下文。
 * @param {any} [config] 插件配置。
 */
export function apply(ctx, config = {}) {
	// 先合并配置文件再判角色：`role` 写在 `~/.dsh/dsh-wire/config.json` 里必须算数，
	// 否则手机端会按平台推断成 desktop，起隧道、生成配对码，与用户意图完全相反。
	const merged = loadConfig(config);
	const role = detectRole(merged);
	// 设置页上要显示版本号：让人一眼看出装的是哪一版，省得"升级了没生效"互相猜。
	try {
		const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
		setStatus({ version: String(pkg.version ?? '0.0.0') });
	} catch {
		// 读不到就保持默认值，不影响任何主链路。
	}
	// 同步接线：`inject` / `effect` 必须在 apply 返回前注册好，
	// 否则插件被快速卸载时这些注册会漏接，表现为"装上了但没有任何反应"。
	// 提问队列：电脑推来的问题先落在这儿，等手机上的浮层来取。
	// desktop 侧不用它，但同一个入口传下去，免得两套接线。
	const askQueue = createAskQueue();
	startRuntime(ctx, merged, role, askQueue).catch((error) => {
		ctx.logger?.warn?.(`[dsh-wire] 启动失败: ${error?.message ?? error}`);
	});

	// 设置页要的数据接口。
	//
	// `webServer` 是可选依赖：缺席时插件照常工作，只是页面上看不到状态——
	// 这也是为什么状态查询失败不能影响主链路。
	ctx.inject(['webServer'], (scoped) => {
		// 没有 webServer 就没有设置页可挂，主链路照常工作。
		if (scoped.webServer === undefined) return;
		scoped.effect(
			() =>
				scoped.webServer.register({
					kind: 'prefix',
					path: ADMIN_PREFIX,
					handler: createAdminHandler(askQueue)
				}),
			'dsh-wire: 设置页接口'
		);
	});
}
