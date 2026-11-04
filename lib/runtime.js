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
import { setError, setPhoneOnlineProvider, setStatus } from './status.js';
import { QuickTunnel } from './tunnel.js';

/**
 * 设置页"重新生成配对码"的实现，由电脑端运行时注册。
 *
 * 用回调而不是直接 import：只有电脑端才有隧道和身份，手机端调用应当明确报错，
 * 而不是悄悄什么都不做。
 *
 * @type {null | (() => Promise<string>)}
 */
let pairRefresher = null;

/**
 * 手机端"保存配对码后立刻重连"的实现，由手机端运行时注册。
 *
 * @type {null | ((patch?: any) => Promise<{ok: boolean, message?: string}>)}
 */
let mobileReconnect = null;

/**
 * 立刻重连（供设置页的接口调用）。
 *
 * @param {any} [patch] 要并进内存配置的字段。
 * @returns {Promise<{ok: boolean, message?: string}>} 结果。
 */
export async function reconnectMobile(patch) {
	if (mobileReconnect === null) throw new Error('当前未在手机端运行，或手机端还没就绪');
	return mobileReconnect(patch);
}

/**
 * 重新生成配对码（供设置页的接口调用）。
 *
 * @returns {Promise<string>} 新的 6 位配对码。
 */
export async function refreshPairCode() {
	if (pairRefresher === null) throw new Error('当前未在电脑端运行，或电脑端还没就绪');
	return pairRefresher();
}

/** 心跳间隔。比中转的过期阈值小一个数量级，避免误判离线。 */const HEARTBEAT_MS = 60_000;

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

		// 把"要人回答的问题"接到手机上。
		//
		// **不用** `user-questions/request` 事件。那个 waterfall 带 agent 作为 thisArg 派发，
		// cordis 会按 scope 逐条过滤监听器（events.js 的 dispatch），插件注册在自己的
		// scope 上会被静默滤掉——实测 handler 一次都进不去，加 global:true、换顶层 ctx、
		// 去掉 effect 包装都救不回来。
		//
		// 改为直接包装 `userQuestions.ask` 方法，和本文件包装 list/read/prompt 是同一套路子：
		// 不经过事件系统，也就没有 scope 过滤这回事。
		//
		// 三条不破坏本机体验的规矩不变：
		// 1. 手机不在线 → 原样调用，电脑上照常弹窗；
		// 2. 手机在线但没答（超时/人走开）→ 也交回原方法，绝不把电脑端锁死；
		// 3. 只有手机真的答了才采用它的答案。
		if (config.forwardAsk !== false) {
			scoped.effect(() => {
				const questions = scoped.userQuestions;
				if (questions === undefined || typeof questions.ask !== 'function') {
					wireLog('[desktop] 本机没有 userQuestions，提问不会转到手机');
					return;
				}
				const original = questions.ask.bind(questions);
				questions.ask = async (request) => {
					if (!server.isPhoneOnline()) return original(request);
					wireLog('[desktop] 手机在线，先把提问推过去');
					const answer = await server.pushAsk(
						{ questions: request?.questions ?? [] },
						request?.signal === undefined ? {} : { signal: request.signal }
					);
					if (answer === undefined) {
						wireLog('[desktop] 手机未作答，交回本机前端');
						return original(request);
					}
					wireLog('[desktop] 手机已作答');
					return answer;
				};
				wireLog('[desktop] 已接管 userQuestions.ask（手机在线时先问手机）');
				return () => {
					questions.ask = original;
				};
			});
		}

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
					setStatus({
						role: 'desktop',
						localOrigin: origin,
						rendezvous: typeof config.rendezvous === 'string' ? config.rendezvous : null
					});
					// 页面上的"手机在线"是现算的，不是某个时刻的快照。
					setPhoneOnlineProvider(() => server.isPhoneOnline());

					if (typeof config.rendezvous !== 'string' || config.rendezvous === '') {
						wireLog('[desktop] 未配置 rendezvous，仅本机/局域网可用');
						setStatus({ error: '未配置中转地址，手机找不到这台电脑', errorCode: 'no-rendezvous' });
						return;
					}

					/**
					 * 把当前隧道地址同步到中转。
					 *
					 * 每次调用都重新读身份：设置页的"重新生成配对码"会先抹掉
					 * `deviceToken`，再走一遍这里，从而让中转重新发一个新码。
					 *
					 * @param {string} url 公网地址。
					 * @returns {Promise<void>} 完成。
					 */
					const announce = async (url, retried = false) => {
						const current = loadIdentity();
						try {
							const result = await publish(config.rendezvous, {
								deviceId: current.deviceId,
								deviceToken: current.deviceToken,
								url,
								accessToken: token
							});
							if (result.pairCode !== undefined) {
								current.deviceToken = result.deviceToken;
								current.pairCode = result.pairCode;
								saveIdentity(current);
								writePairing({ pairCode: result.pairCode, url, deviceId: current.deviceId });
								wireLog(`[desktop] 配对码 ${result.pairCode}（5 分钟内有效）`);
								ctx.logger?.info?.(`dsh-wire: 手机上输入配对码 ${result.pairCode}`);
								setStatus({
									tunnelUrl: url,
									pairCode: result.pairCode,
									pairCodeExpiresAt: Date.now() + 5 * 60 * 1000,
									error: null,
									errorCode: null
								});
							} else {
								wireLog(`[desktop] 地址已同步 ${url}`);
								setStatus({ tunnelUrl: url, error: null, errorCode: null });
							}
						} catch (error) {
							const message = String(error?.message ?? error);
							const code = message.split(':')[0].trim();
							// 中转不认识这台设备（换了中转地址，或中转那边数据被清空/迁移）。
							// 这种情况下干等没用——丢掉本地凭据重新登记一次，顺带拿到新配对码。
							if (!retried && (code === 'bad-token' || code === 'unknown-device' || code === 'no-device')) {
								wireLog('[desktop] 中转不认这台设备，重新登记一次');
								const fresh = loadIdentity();
								delete fresh.deviceToken;
								delete fresh.pairCode;
								saveIdentity(fresh);
								return announce(url, true);
							}
							wireLog(`[desktop] 上报中转失败: ${message}`);
							setError('rendezvous-failed', `上报中转失败：${message}`);
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

					// 设置页的"重新生成配对码"走这里：抹掉本地凭据，让中转当它是新设备，
					// 于是重新发一个 6 位码。隧道地址不变，所以手机端不需要改动别的。
					pairRefresher = async () => {
						if (tunnel?.url === undefined) throw new Error('隧道还没就绪，稍等几秒再试');
						const current = loadIdentity();
						delete current.deviceToken;
						delete current.pairCode;
						saveIdentity(current);
						setStatus({ pairCode: null, pairCodeExpiresAt: null });
						await announce(tunnel.url);
						const fresh = loadIdentity();
						if (fresh.pairCode === undefined) throw new Error('中转没有返回新的配对码');
						return fresh.pairCode;
					};

					heartbeatTimer = setInterval(() => {
						if (tunnel?.url === undefined) return;
						const latest = loadIdentity();
						if (latest.deviceToken === undefined) return;
						void publish(config.rendezvous, {
							deviceId: latest.deviceId,
							deviceToken: latest.deviceToken,
							url: tunnel.url,
							accessToken: token
						}).catch(() => {});
					}, HEARTBEAT_MS);
					heartbeatTimer.unref?.();
				})
				.catch((error) => {
					wireLog(`[desktop] 监听失败: ${error?.message ?? error}`);
					ctx.logger?.warn?.(`dsh-wire desktop 监听失败: ${error?.message ?? error}`);
					setError('listen-failed', `本机端口监听失败：${error?.message ?? error}`);
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
function startMobile(ctx, config, askQueue) {
	// 不再依赖 `userQuestions`：提问走自己的队列，不调 `ask()`。
	// 留成必需依赖的后果很实际——这个服务缺席时 inject 回调永不执行，
	// 表现为插件装上了却什么都不做（状态里 role 一直是 null）。
	ctx.inject(['sessions', 'sessionController', 'sessionQuery', 'workspaceController'], (scoped) => {
		scoped.effect(() => {
			let disposed = false;
			/**
			 * @type {null | (() => void)}
			 */
			let uninstall = null;

			/**
			 * 解析出电脑地址与访问令牌。
			 *
			 * 每次都重新读配置文件：设置页刚写进去的配对码要**立刻**生效，
			 * 不能等到用户下次重启才发现填了没用。
			 *
			 * @returns {Promise<{origin: string, token: string} | null>} 解析结果。
			 */
			const locate = async () => {
				const fresh = { ...loadConfig(config), ...config };
				if (typeof fresh.desktopOrigin === 'string' && fresh.desktopOrigin !== ''
					&& typeof fresh.desktopToken === 'string' && fresh.desktopToken !== '') {
					return { origin: fresh.desktopOrigin, token: fresh.desktopToken };
				}
				if (typeof fresh.rendezvous !== 'string' || fresh.rendezvous === '') return null;

				const identity = loadIdentity();
				const pairCode = typeof fresh.pairCode === 'string' && fresh.pairCode !== ''
					? fresh.pairCode
					: identity.pairCode;
				const result = await resolve(fresh.rendezvous, {
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

			/**
			 * 连一次，重连也走这里。
			 * @returns {Promise<void>} 完成；失败会抛，状态里已写好原因。
			 */
			const connect = async () => {
				// 重连前先拆掉旧包装，否则同一层会被套两次。
				uninstall?.();
				uninstall = null;
				setStatus({ role: 'mobile', connected: false });
				try {
					const target = await locate();
					if (disposed) return;
					if (target === null) {
						wireLog('[mobile] 未配置 desktopOrigin 或 rendezvous，代理不启用');
						ctx.logger?.warn?.('dsh-wire: 手机端需要配置 rendezvous（推荐）或 desktopOrigin');
						setError('not-configured', '还没配对：在设置页输入电脑上显示的 6 位配对码');
						return;
					}
					const wire = new WireClient(target);
					uninstall = installMobileProxy(scoped, wire, askQueue);
					if (disposed) {
						// 定位过程中插件已卸载，立刻回滚，别留下半个包装。
						uninstall();
						uninstall = null;
						return;
					}
					const info = await wire.hello();
					wireLog(`[mobile] 已连上电脑 ${target.origin}，协议 ${info.version}`);
					ctx.logger?.info?.(`dsh-wire: 已连上电脑（协议 ${info.version}）`);
					setStatus({
						connected: true,
						desktopOrigin: target.origin,
						error: null,
						errorCode: null
					});
				} catch (error) {
					wireLog(`[mobile] 连接失败: ${error?.message ?? error}`);
					ctx.logger?.warn?.(`dsh-wire: 连接失败: ${error?.message ?? error}`);
					setError('connect-failed', `连不上电脑：${error?.message ?? error}`);
					throw error;
				}
			};

			setStatus({
				role: 'mobile',
				rendezvous: typeof config.rendezvous === 'string' ? config.rendezvous : null,
				connected: false
			});

			/**
			 * 让设置页保存配对码后**立刻重连**，不用重启 DSH。
			 *
			 * @param {any} [patch] 要并进内存配置的字段（配置文件已由调用方写好）。
			 * @returns {Promise<{ok: boolean, message?: string}>} 结果。
			 */
			mobileReconnect = async (patch) => {
				if (patch !== undefined && patch !== null) Object.assign(config, patch);
				try {
					await connect();
					return { ok: true };
				} catch (error) {
					return { ok: false, message: error?.message ?? String(error) };
				}
			};

			void connect().catch(() => {});

			return () => {
				disposed = true;
				mobileReconnect = null;
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
 * @param {any} [askQueue] 提问队列：手机端用它等人回答。
 * @returns {Promise<void>} 装配完成。
 */
export async function startRuntime(ctx, inlineConfig, role, askQueue) {
	const config = loadConfig(inlineConfig);
	wireLog(`[boot] 角色=${role} 平台=${process.platform} 中转=${config.rendezvous ?? '未配置'}`);
	if (role === 'desktop') startDesktop(ctx, config);
	else startMobile(ctx, config, askQueue);
}
