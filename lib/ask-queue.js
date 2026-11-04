/**
 * 手机上"等用户回答"的提问队列。
 *
 * 为什么需要它：DSH 自带的提问卡片绑在会话上（`answerQuestion` 里
 * `ctx.sessions.scopeOf(owner)` 拿不到会话就 `next()`），而本插件的设计前提是
 * 手机端**不持有会话**，所以那条路必然以 `NO_PROVIDER` 收场。
 *
 * 于是问题不进会话，直接进这里的队列，由本插件自己的浮层展示和收集答案。
 *
 * 三个必须守住的点：
 * 1. 电脑端不能被锁死——超时没答就交回电脑端；
 * 2. 同一提问不能重复弹——按 askId 去重；
 * 3. 前端刷新/掉线不能让提问永久悬空——超时兜底。
 */

/** 一条提问最多等多久（毫秒）。守住"绝不锁死电脑端"。 */
/**
 * 手机上一条提问挂多久。
 *
 * 必须和电脑端「手机不在线时的窗口」同量级：手机端要是先放弃，
 * 电脑端那段等待就白等了——用户明明已经看到卡片，却因为过了 60 秒
 * 而答不进去。用户可能锁屏、切走、过一阵才回来。
 */
export const ASK_WAIT_MS = 10 * 60 * 1000;

/**
 * 提问队列。
 *
 * @returns {{wait: (ask: any) => Promise<any[] | undefined>, list: () => any[], answer: (askId: string, items: any[]) => boolean, size: () => number}} 队列。
 */
export function createAskQueue() {
	/** @type {Map<string, {ask: any, resolve: (value: any[] | undefined) => void, timer: NodeJS.Timeout}>} */
	const pending = new Map();

	/**
	 * 等用户回答。超时返回 undefined（调用方据此交回电脑端）。
	 *
	 * @param {any} ask 电脑推来的提问。
	 * @returns {Promise<any[] | undefined>} 答案项数组，或 undefined 表示没等到。
	 */
	function wait(ask) {
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				pending.delete(ask.id);
				resolve(undefined);
			}, ASK_WAIT_MS);
			// 同一 id 重复推送时以最新一次为准，旧的不留悬挂
			const previous = pending.get(ask.id);
			if (previous !== undefined) {
				clearTimeout(previous.timer);
				previous.resolve(undefined);
			}
			pending.set(ask.id, { ask, resolve, timer });
		});
	}

	/**
	 * 当前待回答的提问（给前端轮询用）。
	 *
	 * @returns {any[]} 提问列表。
	 */
	function list() {
		// 原样回传整条提问：`kind` 决定浮层是"选项"还是"权限申请"，
		// `source` 是"来自哪个对话"，只挑字段会把它们丢掉。
		return [...pending.values()].map((item) => item.ask);
	}

	/**
	 * 只保留还活着的那些待决项。
	 *
	 * 电脑端可能已经在本机把某条处理掉了（用户在电脑前先答了），
	 * 这时要把它从手机队列里剔掉，否则卡片会一直显示，点了也没反应。
	 *
	 * @param {string[]} alive 仍然有效的 id。
	 * @returns {number} 被剔掉的条数。
	 */
	function retain(alive) {
		if (!Array.isArray(alive)) return 0;
		const keep = new Set(alive);
		let dropped = 0;
		for (const [id, item] of pending) {
			if (keep.has(id)) continue;
			pending.delete(id);
			clearTimeout(item.timer);
			item.resolve(undefined);
			dropped += 1;
		}
		return dropped;
	}

	/**
	 * 收下前端给的答案。
	 *
	 * @param {string} askId 提问 id。
	 * @param {any} payload 前端提交的内容（提问是 answers，审批是 outcome）。
	 * @returns {boolean} 是否确实有这条待答提问。
	 */
	function answer(askId, payload) {
		const item = pending.get(askId);
		if (item === undefined) return false;
		clearTimeout(item.timer);
		pending.delete(askId);
		item.resolve(payload);
		return true;
	}

	return { wait, list, retain, answer, size: () => pending.size };
}
