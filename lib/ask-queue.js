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
export const ASK_WAIT_MS = 60_000;

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
		return [...pending.values()].map((item) => ({
			id: item.ask?.id,
			questions: item.ask?.questions ?? []
		}));
	}

	/**
	 * 收下前端给的答案。
	 *
	 * @param {string} askId 提问 id。
	 * @param {any[]} items 答案项。
	 * @returns {boolean} 是否确实有这条待答提问。
	 */
	function answer(askId, items) {
		const item = pending.get(askId);
		if (item === undefined) return false;
		clearTimeout(item.timer);
		pending.delete(askId);
		item.resolve(items);
		return true;
	}

	return { wait, list, answer, size: () => pending.size };
}
