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
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';

import { WireClient } from './client.js';
import { loadConfig, saveConfig, writePairing } from './config.js';
import { STATE_DIR, wireLog } from './log.js';
import { explain } from './explain.js';
import { installMobileProxy } from './mobile.js';
import { loadIdentity, publish, resolve, saveIdentity } from './rendezvous.js';
import { createDesktopServer, generateToken } from './server.js';
import { setError, setPhoneOnlineProvider, setStatus } from './status.js';
import { findCloudflared, installCloudflared } from './cloudflared.js';
import { QuickTunnel } from './tunnel.js';

/** 由电脑端运行时注册的 cloudflared 安装入口；手机端调用应当明确报错。 */
let cloudflaredInstaller = null;

/**
 * 找出本机在局域网里的地址。
 *
 * 手机和电脑连同一个 WiFi 时，用这个地址可以**完全绕开隧道**——不需要
 * cloudflared、不需要公网、不需要中转。这是"无论如何都能用上"的最后一条路，
 * 所以它必须一直可用。
 *
 * @returns {{name: string, address: string}|null} 首选网卡与它的 IPv4；找不到时 null。
 */
function lanAddress() {
	const table = networkInterfaces();
	const candidates = [];
	for (const [name, addresses] of Object.entries(table)) {
		for (const address of addresses ?? []) {
			if (address.family !== 'IPv4' || address.internal) continue;
			// 虚拟网卡手机连不上，排除掉，免得给出一个看起来能用其实不通的地址。
			if (/^(docker|vmnet|vboxnet|br-|virbr|veth|utun|lo)/i.test(name)) continue;
			candidates.push({ name, address: address.address });
		}
	}
	if (candidates.length === 0) return null;
	// 家用/公司网络最常见的就是这两段，优先给它们。
	const preferred = candidates.find(
		(item) => item.address.startsWith('192.168.') || item.address.startsWith('10.')
	);
	return preferred ?? candidates[0];
}

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
/**
 * 下载并安装 cloudflared（设置页按钮调用）。
 * @returns {Promise<{ok: boolean, path?: string, version?: string, message?: string}>} 结果。
 */
export async function installCloudflaredNow() {
	if (cloudflaredInstaller === null) {
		return { ok: false, message: '当前未在电脑端运行，只有电脑端才需要 cloudflared' };
	}
	return cloudflaredInstaller();
}

export async function refreshPairCode() {
	if (pairRefresher === null) throw new Error('当前未在电脑端运行，或电脑端还没就绪');
	return pairRefresher();
}

/** 手机不在线时，提问给它留多久的窗口。本机卡片同时在等，不会拖慢在场的人。 */
const PHONE_AWAY_WINDOW_MS = 10 * 60 * 1000;

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

/**
 * 从 agent 反查它属于哪个对话，供手机端显示来源。
 *
 * 拿不到就返回 undefined：来源只是提示，不能因为它失败就挡住提问本身。
 *
 * @param {any} agent 发起请求的 agent。
 * @returns {{sessionId?: string, title?: string} | undefined} 来源信息。
 */
function describeAgent(agent) {
	try {
		const session = agent?.session;
		if (session === undefined) return undefined;
		const sessionId = typeof session.id === 'string' ? session.id : undefined;
		let title = '';
		try {
			// 标题是会话日志里的 `session/title` 事件，取最近一条。
			const end = typeof session.seq === 'number' ? session.seq : 0;
			for (let seq = end - 1; seq >= 0 && seq > end - 500; seq -= 1) {
				const event = session.eventAt?.(seq);
				if (event?.type === 'session/title') {
					title = String(event.data?.title ?? '');
					break;
				}
			}
		} catch {
			// 读不到标题就只显示 id
		}
		if (sessionId === undefined && title === '') return undefined;
		return { sessionId, title };
	} catch {
		return undefined;
	}
}

function startDesktop(ctx, config) {
	ctx.inject(['sessionQuery', 'sessionController', 'sessions'], (scoped) => {
		const token = typeof config.token === 'string' && config.token.length >= 32
			? config.token
			: loadOrCreateToken();
		const server = createDesktopServer(scoped, {
			token,
			port: typeof config.port === 'number' ? config.port : 0,
			// 监听所有网卡：手机走局域网直连时要能连进来。
			// 鉴权没放松，每个请求仍要带令牌，所以这不等于把服务暴露给任何人。
			bind: '0.0.0.0'
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
				// agent 是**第二个参数**（`ask(request, agent)`），不是 request 上的字段，
				// 漏接就查不到来源，弹窗上"来自哪个对话"会是空的。
				questions.ask = async (request, agent) => {
					const owner = agent ?? request?.agent;

					// 两端同时挂着，谁先答谁算。
					//
					// 以前的分支是"手机不在线就只问本机"，结果是：用户在电脑前发起任务
					// 后离开，agent 提问，本机卡片没人点，用户掏出手机时才发现什么都看不到。
					// 现在两台设备同时等，手机上不管什么时候上线，只要本机还没人回答，
					// 都还来得及接手。
					// 手机不在线时给的等待窗口要长得多：本机卡片同时在等，
					// 用户在场就秒答，压根等不到这个窗口结束；不在场才靠它撑到
					// 用户掏出手机。原来是手机一离线就直接放行，等于把这条路堵死。
					const away = !server.isPhoneOnline();
					/** @type {string | undefined} */
					let phoneAskId;
					const phoneReply = server.pushAsk(
						{
							kind: 'ask',
							source: describeAgent(owner),
							questions: request?.questions ?? []
						},
						{
							...(request?.signal === undefined ? {} : { signal: request.signal }),
							...(away ? { timeoutMs: PHONE_AWAY_WINDOW_MS } : {}),
							onPending: (id) => {
								phoneAskId = id;
							}
						}
					).catch(() => undefined);

					const localReply = original(request, agent).then((value) => ({
						from: 'local',
						value
					}));

					const first = await Promise.race([
						phoneReply.then((value) => ({
							from: 'phone',
							value: value !== undefined && Array.isArray(value.answers) ? value : undefined
						})),
						localReply
					]);

					let picked;
					if (first.from === 'phone' && first.value !== undefined) {
						wireLog('[desktop] 手机已作答');
						picked = { answers: first.value.answers };
					} else {
						if (first.from === 'phone') wireLog('[desktop] 手机未作答，交回本机前端');
						// 本机先答了：把手机上那张卡撤掉，否则它一直挂着，
						// 用户点下去没有任何反应，还会以为插件坏了。
						if (first.from === 'local' && phoneAskId !== undefined) {
							server.cancelAsk(phoneAskId);
							wireLog('[desktop] 本机已作答，撤销手机上的卡片');
						}
						picked = await localReply.then((r) => r.value);
					}

					return picked;
				};
				wireLog('[desktop] 已接管 userQuestions.ask（手机在线时先问手机）');
				return () => {
					questions.ask = original;
				};
			});
		}

		// 权限申请走同一条通道。
		//
		// 包装的是 `decide` 而不是 `request`：`request()` 内部要先写
		// `approval/asked`、拿到结果再写 `approval/decided` 这一对审计事件，
		// 绕过它就没有审计记录了。包装 `decide` 则审计照常写，只是决策来自手机。
		//
		// 同样不能用事件监听：`decide` 里也是 `waterfall(scopeTarget(agent), …)`。
		if (config.forwardApproval !== false) {
			scoped.effect(() => {
				// 用 get 取而不是声明成依赖：服务缺席时 inject 回调会永不执行，
				// 整个插件就"装上了不干活"（这个坑刚踩过）。
				const service = scoped.get?.('approval') ?? scoped.approval;
				if (service === undefined || typeof service.decide !== 'function') {
					wireLog('[desktop] 本机没有 approval 服务，权限申请不会转到手机');
					return;
				}
				const originalDecide = service.decide.bind(service);
				service.decide = async (request, session) => {
					// 和提问一样：两端同时挂起，谁先决定谁算。
					// 权限申请原本还要等本机那张卡——现在手机上后上线也接得住。
					const away = !server.isPhoneOnline();
					/** @type {string | undefined} */
					let phoneAskId;
					const phoneReply = server.pushAsk(
						{
							kind: 'approval',
							source: describeAgent(request?.agent),
							toolName: request?.toolName ?? '',
							reason: request?.reason ?? undefined
						},
						{
							...(request?.signal === undefined ? {} : { signal: request.signal }),
							...(away ? { timeoutMs: PHONE_AWAY_WINDOW_MS } : {}),
							onPending: (id) => {
								phoneAskId = id;
							}
						}
					).catch(() => undefined);

					const localReply = originalDecide(request, session).then((value) => ({
						from: 'local',
						value
					}));

					const first = await Promise.race([
						phoneReply.then((value) => ({
							from: 'phone',
							value: value !== undefined && typeof value.outcome === 'string' ? value : undefined
						})),
						localReply
					]);

					if (first.from === 'phone' && first.value !== undefined) {
						wireLog(`[desktop] 手机已决定：${first.value.outcome}`);
						return first.value.outcome;
					}
					if (first.from === 'phone') wireLog('[desktop] 手机未决定，交回本机');
					if (first.from === 'local' && phoneAskId !== undefined) {
						server.cancelAsk(phoneAskId);
						wireLog('[desktop] 本机已决定，撤销手机上的卡片');
					}
					return localReply.then((r) => r.value);
				};
				return () => {
					service.decide = originalDecide;
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
					const lan = lanAddress();
					const port = Number(new URL(origin).port);
					setStatus({
						role: 'desktop',
						localOrigin: origin,
						lanUrl: lan === null ? null : `http://${lan.address}:${port}`,
						// 一行就能复制走的直连串：手机端粘贴它即可，不用配对码、不用隧道。
						// 里面带令牌，所以只在**本机设置页**展示（页面本身要令牌才能打开）。
						lanLink: lan === null ? null : `http://${lan.address}:${port}/?t=${token}`,
						lanInterface: lan === null ? null : lan.name,
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
					const announce = async (url, retried = false, reset = false) => {
						const current = loadIdentity();
						try {
							const result = await publish(config.rendezvous, {
								deviceId: current.deviceId,
								deviceToken: current.deviceToken,
								reset,
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

					/**
					 * 找一个能跑的 cloudflared，有就起隧道。
					 *
					 * 找不到时**不是**静默失败：隧道是公网访问的前提，缺了它设置页
					 * 会一直显示「还没建立」，用户不知道自己缺一个外部程序。所以这里
					 * 把话说清楚，并保留局域网直连这条路（它不需要 cloudflared）。
					 *
					 * @returns {boolean} 是否成功起了隧道。
					 */
					const startTunnelIfPossible = (overridePath) => {
						// overridePath：刚下好的那份。不能只读 config——那是启动时的快照，
						// 用户点了下载之后它还是旧的，于是"下好了却还是找不到"。
						const configured = typeof config.cloudflared === 'string' ? config.cloudflared : undefined;
						const found = findCloudflared(overridePath ?? configured);
						setStatus({
							cloudflared: {
								found: found.found,
								source: found.source ?? null,
								version: found.version ?? null,
								path: found.path ?? null
							}
						});
						if (!found.found) {
							wireLog('[desktop] 没找到 cloudflared，公网隧道无法启动；局域网直连仍然可用');
							setError(
								'missing-cloudflared',
								'没找到 cloudflared，公网隧道起不来。点下面的「下载 cloudflared」装上，' +
									'或者让手机连同一个 WiFi、直接用上面的局域网地址。'
							);
							return false;
						}
						wireLog(`[desktop] 用 ${found.path}（${found.version ?? '版本未知'}）起隧道`);
						tunnel = new QuickTunnel({
							command: found.path,
							localUrl: origin,
							onUrl: (url) => {
								void announce(url);
							},
							onFailure: (reason) => {
								// cloudflared 自己报的失败（没拿到地址）。这时候确实没有地址可用。
								wireLog(`[desktop] 隧道失败: ${reason}`);
								setStatus({ tunnelUrl: null });
								setError(
									'tunnel-failed',
									`公网隧道没建起来：${reason}。这通常是本机到 Cloudflare 不通，` +
										'和插件本身无关。请改用上面「连接信息」里的局域网直连串。'
								);
							},
							onUnverified: (url) => {
								// 拿到地址了，只是本机自己连不上它。别把地址撤掉——
								// 本机和手机走的网络路径不同，经常是手机能连、本机连不上。
								wireLog(`[desktop] 隧道地址 ${url} 本机自检没通过，但地址已经交出去`);
								setError(
									'tunnel-unverified',
									`隧道建好了（${url}），但这台电脑自己连不上它——本机网络到 Cloudflare 可能不稳。` +
										'手机可以照常试；连不上就用上面「连接信息」里的局域网直连串。'
								);
							}
						});
						tunnel.start();
						return true;
					};

					// 设置页的「下载 cloudflared」走这里：下完立刻起隧道，用户不用重启。
					cloudflaredInstaller = async () => {
						const result = await installCloudflared();
						if (result.ok !== true) return result;
						// 把刚下好的路径写进配置：用户可能配过一条错路径（或者系统里那个
						// 版本跑不起来），不覆盖的话下次还是会找不到，等于白下。
						saveConfig({ cloudflared: result.path });
						if (tunnel === null) startTunnelIfPossible(result.path);
						return result;
					};

					startTunnelIfPossible();

					// 设置页的"重新生成配对码"走这里：抹掉本地凭据，让中转当它是新设备，
					// 于是重新发一个 6 位码。隧道地址不变，所以手机端不需要改动别的。
					pairRefresher = async () => {
						if (tunnel?.url === undefined) throw new Error('隧道还没就绪，稍等几秒再试');
						const current = loadIdentity();
						delete current.deviceToken;
						delete current.pairCode;
						saveIdentity(current);
						setStatus({ pairCode: null, pairCodeExpiresAt: null });
						// reset：本人主动要求换码，允许覆盖已有登记。
						await announce(tunnel.url, false, true);
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
				// **磁盘优先**：设置页刚写进去的东西（尤其是被清空的配对码）
				// 必须盖过启动时读进内存的那份，否则改了配置要重启才生效。
				const fresh = { ...config, ...loadConfig({}) };
				if (typeof fresh.desktopOrigin === 'string' && fresh.desktopOrigin !== ''
					&& typeof fresh.desktopToken === 'string' && fresh.desktopToken !== '') {
					return { origin: fresh.desktopOrigin, token: fresh.desktopToken };
				}
				if (typeof fresh.rendezvous !== 'string' || fresh.rendezvous === '') return null;

				const identity = loadIdentity();
				const pairCode = typeof fresh.pairCode === 'string' && fresh.pairCode !== ''
					? fresh.pairCode
					: identity.pairCode;
				// 一点配对痕迹都没有就别去问中转站了：那边只会回 bad-token，
				// 而「设备令牌无效，请重新配对」会把人引到「我明明还没配对过」的困惑里。
				// 这里直接说「还没配对」。
				//
				// 注意 deviceId 不算痕迹：它是插件启动时随手生成的本地标识，
				// 全新的手机端也会有，拿它去 resolve 一样是 bad-token。
				const hasTrace = (typeof identity.deviceToken === 'string' && identity.deviceToken !== '')
					|| (typeof pairCode === 'string' && pairCode !== '');
				if (!hasTrace) return null;
				const result = await resolve(fresh.rendezvous, {
					deviceId: identity.deviceId,
					deviceToken: identity.deviceToken,
					pairCode
				});
				if (typeof result.deviceToken === 'string') {
					// 令牌是发给**电脑那台设备**的，手机必须连带记住它的 deviceId，
					// 否则下次拿着自己的随机 id 去换，必然对不上（表现为 bad-token）。
					if (typeof result.deviceId === 'string' && result.deviceId !== '') {
						identity.deviceId = result.deviceId;
					}
					identity.deviceToken = result.deviceToken;
					delete identity.pairCode;
					saveIdentity(identity);
					// 配对码是一次性的，用过就作废。config 里还留着它的话，
					// 下次重连会先拿这个死码去试（中转现在虽然先看令牌，
					// 但没有理由把已经没用的东西一直带着）。
					try {
						saveConfig({ pairCode: '' });
					} catch {
						// 配置写不进去不影响这次连接
					}
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
						wireLog('[mobile] 还没配对，等用户在设置页输入配对码');
						ctx.logger?.info?.('dsh-wire: 还没配对，打开设置 → 远程配对，输入电脑上显示的 6 位配对码');
						setError('not-configured', '还没配对：在设置页输入电脑上显示的 6 位配对码');
						return;
					}
					const wire = new WireClient(target);
					uninstall = installMobileProxy(scoped, wire, askQueue, connect);
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
					// 日志留原始的（排查要用），界面给翻成人话的（用户要用）。
					wireLog(`[mobile] 连接失败: ${error?.message ?? error}${error?.cause?.code ? `（${error.cause.code}）` : ''}`);
					ctx.logger?.warn?.(`dsh-wire: 连接失败: ${error?.message ?? error}`);
					const explained = explain(error, 'mobile');
					setError(explained.code, explained.message);
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
					// 设置页上显示的就是这一句，所以这里必须是人话，不能是 fetch failed。
					return { ok: false, message: explain(error, 'mobile').message };
				}
			};

			// ── 连不上就自己接着试 ──
			//
			// 之前这里只有一次 `void connect()`：手机先启动、电脑后开机，
			// 那一次失败之后**再也不会重试**，用户只能自己回设置页点连接。
			// 而"电脑不在身边、手机先开着"恰恰是这个插件最典型的使用场景。
			//
			// 退避从 5 秒起、翻倍到 60 秒封顶，连上就重置。
			// 没配对（locate 返回 null）不算失败，connect 会正常返回，所以不会空转。
			let retryTimer = null;
			let retryDelay = 5_000;

			const scheduleRetry = () => {
				if (disposed || retryTimer !== null) return;
				const delay = retryDelay;
				retryDelay = Math.min(retryDelay * 2, 60_000);
				wireLog(`[mobile] ${Math.round(delay / 1000)} 秒后自动重连`);
				retryTimer = setTimeout(() => {
					retryTimer = null;
					void attempt();
				}, delay);
				retryTimer.unref?.();
			};

			const attempt = async () => {
				if (disposed) return;
				try {
					await connect();
					// 成功了就把退避重置，下次断线还是从 5 秒开始试。
					retryDelay = 5_000;
				} catch {
					// connect() 内部已经把原因写进状态，这里只负责安排下一次。
					scheduleRetry();
				}
			};

			void attempt();

			return () => {
				disposed = true;
				mobileReconnect = null;
				if (retryTimer !== null) {
					clearTimeout(retryTimer);
					retryTimer = null;
				}
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
