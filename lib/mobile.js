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

import { wireLog } from './log.js';

/** 探测失败结果的缓存时间：这段时间内同一个 id 不再重复问电脑。 */
const PROBE_TTL_MS = 30_000;

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
export function installMobileProxy(ctx, wire) {
	/** @type {Set<string>} 已知的远程会话 id */
	const remoteIds = new Set();
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
		return snapshot;
	}

	/** 包装 `sessionController.list`：本地结果 + 远程摘要。 */
	function wrapList() {
		const controller = ctx.sessionController;
		if (controller === undefined || typeof controller.list !== 'function') return;
		const original = controller.list.bind(controller);
		controller.list = async (signal) => {
			const local = await original(signal);
			let remote = [];
			try {
				remote = await wire.list(signal);
			} catch (error) {
				// 电脑不可达时，列表仍然要能打开——只是少了远程那部分。
				wireLog(`[mobile] 拉远程列表失败: ${error?.message ?? error}`);
			}
			const localIds = new Set((local ?? []).map((item) => item.sessionId));
			const merged = [...(local ?? [])];
			for (const item of remote) {
				if (item?.sessionId === undefined || localIds.has(item.sessionId)) continue;
				remoteIds.add(item.sessionId);
				merged.push(item);
			}
			return merged;
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
				return makeObservation(snapshot, () => snapshot.events);
			};
			restores.push(() => {
				query.observeSession = original;
			});
		}
		if (typeof query.listSessions === 'function') {
			const original = query.listSessions.bind(query);
			query.listSessions = async (signal) => {
				// 直接把远程会话伪装成"持久化记录"，让上层 list() 能枚举到它们。
				const records = await original(signal);
				const extra = [];
				for (const sessionId of remoteIds) {
					if (records.some((record) => record?.header?.id === sessionId)) continue;
					const snapshot = snapshots.get(sessionId);
					if (snapshot === undefined) continue;
					extra.push({ header: snapshot.header, formatStatus: 'current' });
				}
				return [...records, ...extra];
			};
			restores.push(() => {
				query.listSessions = original;
			});
		}
	}

	/** 包装 `sessionController.prompt`：远程 id 转发电脑。 */
	function wrapPrompt() {
		const controller = ctx.sessionController;
		if (controller === undefined || typeof controller.prompt !== 'function') return;
		const original = controller.prompt.bind(controller);
		controller.prompt = async (request, source) => {
			const sessionId = request?.sessionId;
			if (sessionId === undefined || !(await isRemote(sessionId))) {
				return original(request, source);
			}
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

	wrapList();
	wrapQuery();
	wrapPrompt();

	wireLog(`[mobile] 代理已安装（list/read/observeSession/listSessions/prompt）`);

	return () => {
		for (const restore of restores.reverse()) {
			try {
				restore();
			} catch (error) {
				wireLog(`[mobile] 卸载失败: ${error?.message ?? error}`);
			}
		}
	};
}
