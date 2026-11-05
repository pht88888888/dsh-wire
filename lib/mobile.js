/**
 * 手机端（mobile role）：把「远程会话」透明地接到本机的会话服务上。
 *
 * ## 关键约束
 *
 * **这里不创建本地会话、不写会话日志、不复制事件到磁盘。**
 * 所有数据现取现用：前端要列表就转发 `list`，要内容就转发 `read`，要发消息就转发 `prompt`。
 *
 * 旧方案之所以要维护 seq 校准、turn 闭合这些东西，是因为它在本地存了一份副本，
 * 副本必须和源逐字段一致；这里没有副本，那些问题就不存在。
 *
 * ## 为什么包装的是服务方法而不是 RPC
 *
 * 前端最终都要经过 `sessionController` / `sessionQuery` 取数据。在服务层拦截，
 * 不需要知道 RPC 端点的命名空间，也不用猜测 gateway 的仲裁顺序，行为更可预期。
 */

import { homedir } from 'node:os';
import { wireLog } from './log.js';

/** 会话打开期间的刷新间隔。quick tunnel 没有 SSE，只能定时拉。 */
const WATCH_POLL_MS = 5_000;

/** 探测失败结果的缓存时间：这段时间内同一个 id 不再重复问电脑。 */
const PROBE_TTL_MS = 30_000;

/** 连续失败几次就认为电脑地址已经变了。5 次 × 2 秒 = 10 秒。 */
const STALE_AFTER_FAILURES = 5;

/**
 * 从电脑返回的数据造一个 observation。
 *
 * 形状必须与 `sessionQuery.read()` 的返回值一致，前端才会照常渲染：
 * `{source, header, inheritedEventCount, events, cursor, retain, [Symbol.dispose]}`。
 *
 * `events` 用 getter：长轮询把新事件写进 `liveEvents` 后，前端再读就是最新的。
 *
 * @param {any} payload 电脑端返回的快照。
 * @param {() => any[]} liveEvents 返回当前事件数组的函数。
 * @returns {any} 可交给前端的 observation。
 */
function makeObservation(payload, liveEvents) {
	const lease = () => ({
		source: 'prepared',
		header: payload.header,
		inheritedEventCount: payload.inheritedEventCount ?? 0,
		get events() {
			return liveEvents();
		},
		cursor: payload.cursor,
		retain: () => lease(),
		[Symbol.dispose]: () => {}
	});
	return lease();
}

/**
 * 安装手机端代理。
 *
 * @param {any} ctx 插件上下文。
 * @param {import('./client.js').WireClient} wire 电脑端客户端。
 * @returns {() => void} 卸载函数（恢复被包装的方法）。
 */
export function installMobileProxy(ctx, wire, askQueue, onStale) {
	/** @type {Set<string>} 已知的远程会话 id */
	const remoteIds = new Set();
	/** 电脑是不是连上了。只在配对/重连成功后置位，用来决定新建会话往哪边放。 */
	let linked = false;
	/** 新建会话时 DSH 会先写这几类事件，除此之外都不算"空"。 */
	const INIT_ONLY_TYPES = new Set(['permission/preset', 'sandbox/mode', 'approval/policy']);
	// 远程会话要挂到一个**真实存在**的工作区上。伪造一个 id 塞进 baseline 是不行的：
	// 客户端会拿它去建会话，服务端反手就是 workspace/not-found。
	let remoteWorkspaceId = null;
	/** @type {Map<string, {header: any, events: any[], cursor: number, inheritedEventCount: number}>} 远程会话的内存快照 */
	const snapshots = new Map();
	/** @type {Map<string, {remote: boolean, until: number}>} 探测结果负缓存，防止重复试探本地 id */
	const probes = new Map();
	const restores = [];

	/**
	 * 判断一个 id 是否属于远程。
	 *
	 * 三级判定，顺序不能变：
	 * 1. 已知远程 → 是（最常见路径，零开销）
	 * 2. 本地活会话里有 → 不是（绝不抢本地会话）
	 * 3. 都不确定 → 向电脑探一次。前端可能按 id 直接打开（深链、恢复上次会话），
	 *    此时它还没经过 `list`，不探测的话会被误判成本地而报"会话不存在"。
	 *
	 * 探测结果进负缓存，避免前端连续尝试一堆本地 id 时把电脑打爆。
	 *
	 * @param {string} sessionId 会话 id。
	 * @returns {Promise<boolean>} 是否远程。
	 */
	async function isRemote(sessionId) {
		if (remoteIds.has(sessionId)) return true;
		if (ctx.sessions?.get?.(sessionId) !== undefined) return false;

		const probe = probes.get(sessionId);
		if (probe !== undefined && probe.until > Date.now()) return probe.remote;

		try {
			await refresh(sessionId);
			probes.delete(sessionId);
			return true;
		} catch {
			probes.set(sessionId, { remote: false, until: Date.now() + PROBE_TTL_MS });
			return false;
		}
	}

	/**
	 * 刷新远程会话的内存快照。
	 * @param {string} sessionId 会话 id。
	 * @returns {Promise<any>} 快照。
	 */
	async function refresh(sessionId) {
		const payload = await wire.read(sessionId);
		const snapshot = {
			header: payload.header,
			events: Array.isArray(payload.events) ? payload.events : [],
			cursor: typeof payload.cursor === 'number' ? payload.cursor : -1,
			inheritedEventCount: payload.inheritedEventCount ?? 0,
			projections: payload.projections
		};
		snapshots.set(sessionId, snapshot);
		remoteIds.add(sessionId);
		linked = true;
		return snapshot;
	}

	/**
	 * 把 `list()` 的返回值统一成摘要数组。
	 *
	 * 真实引擎返回的是分页对象 `{items: [...]}`（实测），而单元测试里的假实现
	 * 返回裸数组。两种都得认——只认一种的话，`.map` 会直接抛异常，
	 * 连本地会话都一起消失，症状是"整个会话列表空了"。
	 *
	 * @param {any} value 原返回值。
	 * @returns {any[]} 摘要数组。
	 */
	function toItems(value) {
		if (Array.isArray(value)) return value;
		if (Array.isArray(value?.items)) return value.items;
		return [];
	}

	/**
	 * 把合并后的数组装回原返回值的形状，保持对外契约不变。
	 *
	 * @param {any} original 原返回值。
	 * @param {any[]} items 合并后的摘要。
	 * @returns {any} 与 `original` 同形状的结果。
	 */
	function withItems(original, items) {
		if (Array.isArray(original)) return items;
		if (original !== null && typeof original === 'object') return { ...original, items };
		return items;
	}

	/**
	 * 从调用方参数里取出真正的 AbortSignal。
	 *
	 * 实测：`sessionController.list()` 的入参是 options 对象而不是裸 `AbortSignal`。
	 * 把对象直接当 signal 传给 `fetch` 会报
	 * `options.signal?.addEventListener is not a function`，表现为"远程列表永远拉不到"。
	 *
	 * @param {any} value 调用方传入的参数。
	 * @returns {AbortSignal | undefined} 可用的信号。
	 */
	function pickSignal(value) {
		if (value instanceof AbortSignal) return value;
		const candidate = value?.signal;
		return candidate instanceof AbortSignal ? candidate : undefined;
	}

	/** 包装 `sessionController.list`：本地结果 + 远程摘要。 */
	function wrapList() {
		const controller = ctx.sessionController;
		if (controller === undefined || typeof controller.list !== 'function') return;
		const original = controller.list.bind(controller);
		controller.list = async (options) => {
			const local = await original(options);
			let remote = [];
			try {
				remote = await wire.list(pickSignal(options));
			} catch (error) {
				// 电脑不可达时，列表仍然要能打开——只是少了远程那部分。
				wireLog(`[mobile] 拉远程列表失败: ${error?.message ?? error}`);
			}
			const localItems = toItems(local);
			const localIds = new Set(localItems.map((item) => item?.sessionId));
			const merged = [...localItems];
			for (const item of remote) {
				if (item?.sessionId === undefined || localIds.has(item.sessionId)) continue;
				remoteIds.add(item.sessionId);
				merged.push(item);
			}
			wireLog(`[mobile] list: 本地 ${localItems.length} 条，远程 ${remote.length} 条，合计 ${merged.length} 条`);
			return withItems(local, merged);
		};
		restores.push(() => {
			controller.list = original;
		});
	}

	/** 包装 `sessionQuery.read` 与 `observeSession`：远程 id 转发电脑。 */
	function wrapQuery() {
		const query = ctx.sessionQuery;
		if (query === undefined) return;
		if (typeof query.read === 'function') {
			const original = query.read.bind(query);
			query.read = async (sessionId, options = {}) => {
				if (!(await isRemote(sessionId))) return original(sessionId, options);
				const snapshot = await refresh(sessionId);
				return makeObservation(snapshot, () => snapshot.events);
			};
			restores.push(() => {
				query.read = original;
			});
		}
		if (typeof query.observeSession === 'function') {
			const original = query.observeSession.bind(query);
			query.observeSession = async (sessionId, options = {}) => {
				if (!(await isRemote(sessionId))) return original(sessionId, options);
				const snapshot = await refresh(sessionId);
				const lease = makeObservation(snapshot, () => {
					// 每次都取最新快照，而不是打开那一刻的那份——否则界面上
					// 永远停在最初的内容上，用户在手机里看不到 agent 在干活。
					const latest = snapshots.get(sessionId);
					return latest?.events ?? snapshot.events;
				});
				// quick tunnel 上没有 SSE，只能自己定时拉。间隔取 5 秒：
				// 再密就是白烧手机流量，再稀用户会觉得"卡住了"。
				// 注意：拉回来的新内容能不能自动显示，取决于 DSH 前端会不会
				// 重新读这个 observation。万一没自动更新，用户退出会话再点进来
				// 一定能看到最新内容——这一点写进 README 了。
				const timer = setInterval(() => {
					void refresh(sessionId).catch(() => {});
				}, WATCH_POLL_MS);
				timer.unref?.();
				lease[Symbol.dispose] = () => {
					clearInterval(timer);
				};
				return lease;
			};
			restores.push(() => {
				query.observeSession = original;
			});
		}
		if (typeof query.listSessions === 'function') {
			const original = query.listSessions.bind(query);
			query.listSessions = async (signal) => {
				// 直接把远程会话伪装成"持久化记录"，让上层 list() 能枚举到它们。
				const raw = await original(signal);
				const records = toItems(raw);
				const extra = [];
				for (const sessionId of remoteIds) {
					if (records.some((record) => record?.header?.id === sessionId)) continue;
					const snapshot = snapshots.get(sessionId);
					if (snapshot === undefined) continue;
					extra.push({ header: snapshot.header, formatStatus: 'current' });
				}
				return withItems(raw, [...records, ...extra]);
			};
			restores.push(() => {
				query.listSessions = original;
			});
		}
	}

	/**
	 * 把远程会话 id 塞进工作区基线里。
	 *
	 * 优先挂到已有工作区上，这样前端把它当成普通会话处理；一个工作区都没有时
	 * 才造一个代表"电脑"的入口。
	 *
	 * @param {any} value baseline 的 value。
	 * @param {string[]} remoteSessionIds 远程会话 id。
	 * @returns {any} 新的 value。
	 */
	function injectIntoBaseline(value, remoteSessionIds, workspaceId) {
		const items = Array.isArray(value?.items) ? value.items : [];
		if (items.length === 0) {
			// 一个工作区都没有，而远程会话已经有了：这里必须让服务端真正建一个，
			// 否则客户端拿着编出来的 id 去操作，只会得到 workspace/not-found。
			if (workspaceId === null) return value;
			const stamp = new Date().toISOString();
			return {
				...value,
				items: [
					{
						workspaceId,
						path: '',
						title: '电脑',
						sessionIds: [...remoteSessionIds],
						createdAt: stamp,
						updatedAt: stamp
					}
				]
			};
		}
		const [first, ...rest] = items;
		return {
			...value,
			items: [
				{ ...first, sessionIds: mergeIds(first.sessionIds, remoteSessionIds) },
				...rest
			]
		};
	}

	/**
	 * 合并会话 id 并去重。
	 *
	 * 工作区后续的 upsert 可能已经带上我们注入过的 id，无脑追加会重复。
	 *
	 * @param {string[]} existing 原有 id。
	 * @param {string[]} extra 追加 id。
	 * @returns {string[]} 去重后的 id。
	 */
	function mergeIds(existing, extra) {
		const seen = new Set(Array.isArray(existing) ? existing : []);
		for (const id of extra) seen.add(id);
		return [...seen];
	}

	/**
	 * 包装 `workspace.follow`：让远程会话出现在侧边栏的会话列表里。
	 *
	 * 这是前端会话列表的**真正数据源**（实测抓包确认：`workspace/follow` 的 baseline，
	 * 每个工作区的 `sessionIds` 决定该组下显示哪些会话），只包装
	 * `sessionController.list` 是不够的——那条路径前端只在别处用。
	 *
	 * 注入发生在引擎完成 `access.allows` 过滤**之后**，所以不会被权限判断丢掉。
	 *
	 * 注意：**每一帧都要注入**。新建会话、工作区增删都会推新的 baseline/upsert，
	 * 只在第一帧注入的话，用户一新建会话、远程会话就会从列表里消失。
	 */
	function wrapWorkspace() {
		const workspace = ctx.workspaceController;
		if (workspace === undefined || typeof workspace.follow !== 'function') {
			wireLog('[mobile] 没有 workspace.follow，远程会话将不会出现在侧边栏');
			return;
		}
		const original = workspace.follow.bind(workspace);
		workspace.follow = async function* (signal) {
			// 还没有远程 id 时才去问电脑；有就不再等这一下，免得拖慢首屏。
			if (remoteIds.size === 0) {
				try {
					const timeout = AbortSignal.timeout(3_000);
					const base = pickSignal(signal);
					const items = await wire.list(base === undefined ? timeout : AbortSignal.any([base, timeout]));
					for (const item of items) {
						if (item?.sessionId !== undefined) remoteIds.add(item.sessionId);
					}
				} catch (error) {
					wireLog(`[mobile] follow 前拉远程列表失败: ${error?.message ?? error}`);
				}
			}
			for await (const frame of original(signal)) {
				const remoteSessionIds = [...remoteIds];
				// 远程会话为空也**不能**早退：电脑上还没建过会话时，如果这里直接
				// 把 frame 原样放过去，新用户第一次打开手机端只会看到
				// 「Choose workspace」——一个工作区都没有，连输入框都不出现，
				// 完全不知道连上没有。所以要继续往下走，把「电脑」工作区建出来。
				if (frame?.type === 'baseline' || frame?.type === 'replace') {
					const rawValue = frame.value ?? {};
					const rawItems = Array.isArray(rawValue.items) ? rawValue.items : [];
					if (rawItems.length === 0 && remoteWorkspaceId === null) {
						// 手机端还一个工作区都没有。远程会话总得有地方挂，
						// 就在本机 HOME 上建一个真工作区——同一目录重复调用会复用，不会越建越多。
						try {
							const created = await ctx.workspaceController?.create?.({ path: homedir() });
							if (typeof created?.workspace?.workspaceId === 'string') {
								remoteWorkspaceId = created.workspace.workspaceId;
								// create() 只认路径，标题会变成目录名（真机上是 /data/data/... 的最后一级）。
								// 这个工作区里装的全是电脑上的会话，统一叫「电脑」更说得清。
								// 只改我们自己建的那个。用户本来就有这个目录登记成工作区的话，
								// 那是他的东西，别动名字。
								if (created.created === true && created.workspace.title !== '电脑') {
									await ctx.workspaceController?.rename?.({
										workspaceId: remoteWorkspaceId,
										title: '电脑'
									}).catch?.((error) => {
										wireLog(`[mobile] 工作区改名失败（不影响使用）: ${error?.message ?? error}`);
									});
								}
								wireLog(`[mobile] 已就绪远程工作区 ${remoteWorkspaceId}`);
							}
						} catch (error) {
							wireLog(`[mobile] 建远程工作区失败: ${error?.message ?? error}`);
						}
					}
					yield {
						type: frame.type,
						value: injectIntoBaseline(rawValue, remoteSessionIds, remoteWorkspaceId)
					};
					continue;
				}
				if (frame?.type === 'upsert' && frame.workspace !== undefined) {
					yield {
						type: 'upsert',
						workspace: {
							...frame.workspace,
							sessionIds: mergeIds(frame.workspace.sessionIds, remoteSessionIds)
						}
					};
					continue;
				}
				yield frame;
			}
		};
		restores.push(() => {
			workspace.follow = original;
		});
	}

	/**
	 * 把一个空的本地会话升级成远程会话。
	 *
	 * 只对**没有任何本地事件**的会话动手：有历史就不能挪，否则用户看到的内容
	 * 会凭空少一截。空会话升级是安全的——电脑那边会按同一个 id 建一个。
	 * @param {string} sessionId 会话 id。
	 * @returns {Promise<boolean>} 升级成功返回 true。
	 */
	async function promoteIfEmpty(sessionId) {
		if (!linked) {
			// 用户可能刚打开 app，一个会话都还没点开过，所以 linked 还是 false。
			// 这里主动探一次：能拉到远程列表就说明电脑在，可以升级。
			try {
				await wire.list();
				linked = true;
			} catch (error) {
				wireLog(`[mobile] 电脑连不上，新会话只能留在本地: ${error?.message ?? error}`);
				return false;
			}
		}
		try {
			// sessionQuery 上没有 read()，真名是 readSession()。
			const snapshot = await ctx.sessionQuery.readSession(sessionId);
			const events = Array.isArray(snapshot?.events) ? snapshot.events : [];
			// 新建的会话不是"零事件"——DSH 会先写几条初始化配置。
			// 只有这几类可以当空会话处理，出现任何别的类型就说明真有内容了，
			// 那就不能挪（挪了用户会看到内容凭空少一截）。
			const onlySetup = events.every((event) => INIT_ONLY_TYPES.has(event?.type));
			if (!onlySetup) return false;
			remoteIds.add(sessionId);
			wireLog(`[mobile] 本地空会话升级为远程会话: ${sessionId}`);
			return true;
		} catch (error) {
			wireLog(`[mobile] 升级检查失败，按本地处理: ${error?.message ?? error}`);
			return false;
		}
	}

	/** 包装 `sessionController.prompt`：远程 id 转发电脑。 */
	function wrapPrompt() {
		const controller = ctx.sessionController;
		if (controller === undefined || typeof controller.prompt !== 'function') return;
		const original = controller.prompt.bind(controller);
		controller.prompt = async (request, source) => {
			const sessionId = request?.sessionId;
			if (sessionId !== undefined && !(await isRemote(sessionId))) {
				// 用户在手机上点「New Session」得到的是本地会话，发出去只会用手机
				// 自己的模型——手机通常没配 key，表现就是一条莫名其妙的报错，
				// 而电脑那边什么都没发生。既然他开着这个插件，本意就是遥控电脑。
				//
				// 所以：只要电脑连得上，而且这个会话还是空的（没有本地历史，
				// 升级不会丢东西），就把它升级成远程会话，消息交给电脑执行。
				if (await promoteIfEmpty(sessionId)) {
					const text = (request?.content ?? [])
						.filter((part) => part?.type === 'text')
						.map((part) => part.text ?? '')
						.join('');
					const result = await wire.prompt(sessionId, text);
					return { accepted: true, remote: result?.result };
				}
				return original(request, source);
			}
			if (sessionId === undefined) {
				return original(request, source);
			}
			wireLog(`[mobile] 转发消息到电脑: ${sessionId}`);
			const text = (request?.content ?? [])
				.filter((part) => part?.type === 'text')
				.map((part) => part.text ?? '')
				.join('');
			const result = await wire.prompt(sessionId, text);
			return { accepted: true, remote: result?.result };
		};
		restores.push(() => {
			controller.prompt = original;
		});
	}

	/**
	 * 轮询电脑推来的提问，交给本机前端弹卡片。
	 *
	 * 手机端引擎和电脑端是两个进程，前端只认**自己这个引擎**发出的
	 * `user-questions/request`。所以转发分两步：电脑把问题推到线上，
	 * 这里再用本机 `userQuestions.ask()` 触发一次，让手机前端弹出同一张卡片。
	 *
	 * 本机弹不出来（没有前端在听）时立刻 `decline`，把问题交回电脑自己的界面——
	 * 宁可电脑上弹，也不能两边都不弹。
	 *
	 * @returns {() => void} 停止轮询。
	 */
	function startAskLoop() {
		if (askQueue === undefined) {
			wireLog('[mobile] 没有提问队列，提问不会转到手机');
			return () => {};
		}
		const abort = new AbortController();
		/** 已处理过的提问 id，避免重投时重复弹卡片。 */
		const seen = new Set();
		/** 连续失败次数。攒够了就说明电脑端八成换了地址，得重新解析。 */
		let failures = 0;

		(async () => {
			while (!abort.signal.aborted) {
				let batch;
				try {
					batch = await wire.poll([], abort.signal);
				} catch (error) {
					if (abort.signal.aborted) return;
					failures += 1;
					wireLog(`[mobile] 提问轮询失败（第 ${failures} 次）: ${error?.message ?? error}`);
					// 只退避重试是不够的：电脑端重启后会换一条隧道，手机攥着旧地址
					// 会一直撞在死胡同里。连错几次就重新解析一次地址。
					if (failures >= STALE_AFTER_FAILURES && onStale !== undefined) {
						failures = 0;
						wireLog('[mobile] 连续失败太多次，重新解析电脑地址');
						try {
							await onStale();
						} catch (retryError) {
							wireLog(`[mobile] 重新解析失败: ${retryError?.message ?? retryError}`);
						}
						continue;
					}
					await new Promise((done) => setTimeout(done, 2_000));
					continue;
				}
				failures = 0;
				// 电脑端已经在本机处理掉的，从手机队列里剔掉，卡片随之消失。
				if (Array.isArray(batch.alive)) {
					const dropped = askQueue.retain(batch.alive);
					if (dropped > 0) wireLog(`[mobile] 电脑端已处理 ${dropped} 条，收起对应卡片`);
				}
				for (const ask of batch.asks ?? []) {
					if (ask?.id === undefined || seen.has(ask.id)) continue;
					seen.add(ask.id);
					if (seen.size > 256) seen.delete(seen.values().next().value);
					handleAsk(ask, askQueue).catch((error) => {
						wireLog(`[mobile] 处理提问失败: ${error?.message ?? error}`);
					});
				}
			}
		})();

		return () => abort.abort();
	}

	/**
	 * 把一个远程提问变成手机上的卡片，等回答再回传。
	 *
	 * @param {any} ask 电脑推来的提问。
	 * @param {any} questions 本机 userQuestions 服务。
	 * @returns {Promise<void>} 完成。
	 */
	async function handleAsk(ask, queue) {
		if (queue === undefined) {
			// 没有队列（理论上不该发生）：直接交回电脑端，别让提问悬空。
			await wire.answer(ask.id, null);
			return;
		}
		// **不走 `userQuestions.ask()`**：DSH 的提问卡片绑在会话上，
		// 手机端不持有会话，调了也只会拿回 NO_PROVIDER。改由本插件的浮层收集答案。
		const payload = await queue.wait(ask);
		if (payload === undefined) {
			wireLog(`[mobile] 提问 ${ask.id} 在手机上超时未答，交回电脑`);
			await wire.answer(ask.id, null);
			return;
		}
		// 提问回 answers，审批回 outcome，原样透传给电脑端。
		const count = Array.isArray(payload.answers) ? payload.answers.length : 0;
		wireLog(`[mobile] 已回答 ${ask.id}（${count} 项${payload.outcome === undefined ? '' : `，审批 ${payload.outcome}`}）`);
		await wire.answer(ask.id, payload);
	}

	wrapList();
	wrapQuery();
	wrapPrompt();
	wrapWorkspace();
	const stopAskLoop = startAskLoop();

	wireLog(`[mobile] 代理已安装（list/read/observeSession/listSessions/prompt/workspace.follow/ask）`);

	return () => {
		stopAskLoop();
		for (const restore of restores.reverse()) {
			try {
				restore();
			} catch (error) {
				wireLog(`[mobile] 卸载失败: ${error?.message ?? error}`);
			}
		}
	};
}
