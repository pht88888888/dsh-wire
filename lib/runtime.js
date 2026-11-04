/**
 * 按角色装配插件。
 *
 * 这里只做接线，业务逻辑在各自模块里：
 * - 桌面端：`server.js`（对外提供数据）+ `tunnel.js`（可公网访问）+ `rendezvous.js`（让手机找到我）
 * - 手机端：`mobile.js`（把远程会话接到本机服务上）
 *
 * 一条原则贯穿始终：**两端都不复制会话数据**，桌面端现取现发，手机端现取现用。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { WireClient } from './client.js';
import { loadConfig, writePairing } from './config.js';
import { STATE_DIR, wireLog } from './log.js';
import { installMobileProxy } from './mobile.js';
import { loadIdentity, publish, resolve, saveIdentity } from './rendezvous.js';
import { createDesktopServer, generateToken } from './server.js';
import { QuickTunnel } from './tunnel.js';

/** 心跳间隔。比中转的过期阈值小一个数量级，避免误判离线。 */
const HEARTBEAT_MS = 60_000;

/**
 * 读取或创建一个稳定的访问令牌。
 *
 * 令牌要跨重启保持，否则每次重启隧道后手机都要重新配对。落盘权限 600，只有本机用户能读。
 *
 * @returns {string} 令牌。
 */
function loadOrCreateToken() {
	mkdirSync(STATE_DIR, { recursive: true });
	const path = join(STATE_DIR, 'token.txt');
	try {
		const existing = readFileSync(path, 'utf8').trim();
		if (existing.length >= 32) return existing;
	} catch {
		/* 首次运行没有文件，走生成分支 */
	}
	const token = generateToken();
	writeFileSync(path, token, { encoding: 'utf8', mode: 0o600 });
	return token;
}

/**
 * 装配桌面端。
 *
 * @param {any} ctx 插件上下文。
 * @param {any} config 合并后的配置。
 * @returns {void}
 */
function startDesktop(ctx, config) {
	ctx.inject(['sessionQuery', 'sessionController', 'sessions'], (scoped) => {
		const token = typeof config.token === 'string' && config.token.length >= 32
			? config.token
			: loadOrCreateToken();
		const server = createDesktopServer(scoped, {
			token,
			port: typeof config.port === 'number' ? config.port : 0
		});

		/**
		 * @type {QuickTunnel | null}
		 */
		let tunnel = null;
		/**
		 * @type {NodeJS.Timeout | null}
		 */
		let heartbeatTimer = null;

		scoped.effect(() => {
			let closed = false;
			server
				.listen()
				.then(async (origin) => {
					if (closed) return;
					wireLog(`[desktop] 本机就绪 ${origin}`);
					ctx.logger?.info?.(`dsh-wire desktop 已监听 ${origin}`);

					if (typeof config.rendezvous !== 'string' || config.rendezvous === '') {
						wireLog('[desktop] 未配置 rendezvous，仅本机/局域网可用');
						return;
					}

					const identity = loadIdentity();
					/**
					 * 把当前隧道地址同步到中转。
					 * @param {string} url 公网地址。
					 * @returns {Promise<void>} 完成。
					 */
					const announce = async (url) => {
						try {
							const result = await publish(config.rendezvous, {
								deviceId: identity.deviceId,
								deviceToken: identity.deviceToken,
								url,
								accessToken: token
							});
							if (result.pairCode !== undefined) {
								identity.deviceToken = result.deviceToken;
								identity.pairCode = result.pairCode;
								saveIdentity(identity);
								writePairing({ pairCode: result.pairCode, url, deviceId: identity.deviceId });
								wireLog(`[desktop] 配对码 ${result.pairCode}（5 分钟内有效）`);
								ctx.logger?.info?.(`dsh-wire: 手机上输入配对码 ${result.pairCode}`);
							} else {
								wireLog(`[desktop] 地址已同步 ${url}`);
							}
						} catch (error) {
							wireLog(`[desktop] 上报中转失败: ${error?.message ?? error}`);
						}
					};

					tunnel = new QuickTunnel({
						command: typeof config.cloudflared === 'string' ? config.cloudflared : undefined,
						localUrl: origin,
						onUrl: (url) => {
							void announce(url);
						}
					});
					tunnel.start();

					heartbeatTimer = setInterval(() => {
						if (tunnel?.url === undefined || identity.deviceToken === undefined) return;
						void publish(config.rendezvous, {
							deviceId: identity.deviceId,
							deviceToken: identity.deviceToken,
							url: tunnel.url,
							accessToken: token
						}).catch(() => {});
					}, HEARTBEAT_MS);
					heartbeatTimer.unref?.();
				})
				.catch((error) => {
					wireLog(`[desktop] 监听失败: ${error?.message ?? error}`);
					ctx.logger?.warn?.(`dsh-wire desktop 监听失败: ${error?.message ?? error}`);
				});

			return () => {
				closed = true;
				if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
				tunnel?.stop();
				void server.close();
			};
		}, 'dsh-wire: desktop runtime');
	});
}

/**
 * 装配手机端。
 *
 * 地址来源有两种：直接配置 `desktopOrigin`（局域网调试用），或经 rendezvous 解析。
 *
 * @param {any} ctx 插件上下文。
 * @param {any} config 合并后的配置。
 * @returns {void}
 */
function startMobile(ctx, config) {
	ctx.inject(['sessions', 'sessionController', 'sessionQuery'], (scoped) => {
		scoped.effect(() => {
			let disposed = false;
			/**
			 * @type {null | (() => void)}
			 */
			let uninstall = null;

			/**
			 * 解析出电脑地址与访问令牌。
			 * @returns {Promise<{origin: string, token: string} | null>} 解析结果。
			 */
			const locate = async () => {
				if (typeof config.desktopOrigin === 'string' && config.desktopOrigin !== ''
					&& typeof config.desktopToken === 'string' && config.desktopToken !== '') {
					return { origin: config.desktopOrigin, token: config.desktopToken };
				}
				if (typeof config.rendezvous !== 'string' || config.rendezvous === '') return null;

				const identity = loadIdentity();
				const pairCode = typeof config.pairCode === 'string' && config.pairCode !== ''
					? config.pairCode
					: identity.pairCode;
				const result = await resolve(config.rendezvous, {
					deviceId: identity.deviceId,
					deviceToken: identity.deviceToken,
					pairCode
				});
				if (typeof result.deviceToken === 'string') {
					identity.deviceToken = result.deviceToken;
					delete identity.pairCode;
					saveIdentity(identity);
				}
				if (typeof result.url !== 'string' || result.url === '') {
					throw new Error('中转没有返回可用地址（电脑可能还没上线）');
				}
				return { origin: result.url, token: String(result.accessToken ?? '') };
			};

			locate()
				.then(async (target) => {
					if (disposed) return;
					if (target === null) {
						wireLog('[mobile] 未配置 desktopOrigin 或 rendezvous，代理不启用');
						ctx.logger?.warn?.('dsh-wire: 手机端需要配置 rendezvous（推荐）或 desktopOrigin');
						return;
					}
					const wire = new WireClient(target);
					uninstall = installMobileProxy(scoped, wire);
					if (disposed) {
						// 定位过程中插件已卸载，立刻回滚，别留下半个包装。
						uninstall();
						uninstall = null;
						return;
					}
					try {
						const info = await wire.hello();
						wireLog(`[mobile] 已连上电脑 ${target.origin}，协议 ${info.version}`);
						ctx.logger?.info?.(`dsh-wire: 已连上电脑（协议 ${info.version}）`);
					} catch (error) {
						wireLog(`[mobile] 握手失败: ${error?.message ?? error}`);
						ctx.logger?.warn?.(`dsh-wire: 连不上电脑 ${target.origin}: ${error?.message ?? error}`);
					}
				})
				.catch((error) => {
					wireLog(`[mobile] 定位电脑失败: ${error?.message ?? error}`);
					ctx.logger?.warn?.(`dsh-wire: 定位电脑失败: ${error?.message ?? error}`);
				});

			return () => {
				disposed = true;
				uninstall?.();
				uninstall = null;
			};
		}, 'dsh-wire: mobile runtime');
	});
}

/**
 * 入口分流。
 *
 * @param {any} ctx 插件上下文。
 * @param {any} inlineConfig 插件内联配置。
 * @param {'desktop' | 'mobile'} role 角色。
 * @returns {Promise<void>} 装配完成。
 */
export async function startRuntime(ctx, inlineConfig, role) {
	const config = loadConfig(inlineConfig);
	wireLog(`[boot] 角色=${role} 平台=${process.platform} 中转=${config.rendezvous ?? '未配置'}`);
	if (role === 'desktop') startDesktop(ctx, config);
	else startMobile(ctx, config);
}
