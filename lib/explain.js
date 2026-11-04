/**
 * 把网络层的原始异常翻译成用户能看懂、并且能据此行动的一句话。
 *
 * 存在的理由：`fetch failed`、`HTTP 530`、`ECONNREFUSED` 这些是给写代码的人看的，
 * 用户看到只会以为"插件坏了"。真正的信息藏在 `error.cause.code` 里，而它
 * 又不会显示在界面上——结果就是用户只能来问我，而我没法隔着屏幕猜。
 *
 * 这里的每条都尽量回答三件事：**发生了什么、最可能的原因、现在能做什么**。
 */

/**
 * 从各种形状的错误对象里挖出底层的错误码。
 *
 * Node 的 fetch 失败包了一层 `TypeError: fetch failed`，真正的 `ECONNREFUSED`
 * 之类挂在 `cause` 上，有时候还要再往下挖一层。
 *
 * @param {any} error 抛出的东西。
 * @returns {string} 找到的错误码；没有就空串。
 */
function codeOf(error) {
	if (error === null || typeof error !== 'object') return '';
	if (typeof error.code === 'string' && error.code !== '') return error.code;
	if (error.cause !== undefined && error.cause !== null) {
		const inner = codeOf(error.cause);
		if (inner !== '') return inner;
	}
	return '';
}

/**
 * 把底层错误的消息拼起来，用来在拿不到错误码时做关键词判断。
 *
 * 有些失败**没有** `code`：Node 的 fetch 超时只有
 * `cause.message = "The operation was aborted due to timeout"`，
 * 端口非法只有 `"bad port"`。光看 `code` 会把这些当成未知错误。
 *
 * @param {any} error 抛出的东西。
 * @returns {string} 小写后的消息合集。
 */
function textOf(error) {
	const parts = [];
	let cursor = error;
	for (let depth = 0; depth < 4 && cursor !== null && typeof cursor === 'object'; depth += 1) {
		if (typeof cursor.message === 'string') parts.push(cursor.message);
		cursor = cursor.cause;
	}
	return parts.join(' | ').toLowerCase();
}

/**
 * 从消息里抠出 HTTP 状态码。
 * @param {string} message 错误消息。
 * @returns {number|null} 状态码；没有就 null。
 */
function statusOf(message) {
	const match = /HTTP\s+(\d{3})/.exec(message);
	if (match === null) return null;
	const status = Number(match[1]);
	return Number.isFinite(status) ? status : null;
}

/**
 * 翻译一条错误。
 *
 * @param {any} error 抛出的东西。
 * @param {'mobile'|'desktop'} [side] 在哪个端点出的事，影响措辞。
 * @returns {{code: string, message: string}} 稳定的错误码与给人看的一句话。
 */
export function explain(error, side = 'mobile') {
	const raw = String(error?.message ?? error ?? '未知错误');
	const code = codeOf(error);
	const status = statusOf(raw);
	const text = textOf(error);
	const isMobile = side === 'mobile';

	// ── Cloudflare 隧道那一层 ──
	if (status === 530) {
		return {
			code: 'tunnel-gone',
			message: isMobile
				? '电脑的隧道已经失效了（Cloudflare 返回 530）。通常是电脑重启过、或者隧道断了。插件会自动重新找地址，等十几秒再试。'
				: '隧道已失效（Cloudflare 返回 530），手机暂时连不进来。重启一下 DSH 会重建隧道。'
		};
	}
	if (status === 502 || status === 504) {
		return {
			code: 'tunnel-no-backend',
			message: isMobile
				? '隧道还在，但电脑那边没响应。电脑上的 DSH 可能卡住了，去电脑上看看。'
				: '隧道在，但本机服务没响应。'
		};
	}

	// ── 鉴权 ──
	if (status === 401 || status === 403) {
		return {
			code: 'bad-token',
			message: isMobile
				? '令牌对不上了。在设置页重新配对一次就好（配对码在电脑端的设置页里）。'
				: '手机送来的令牌无效，它需要重新配对。'
		};
	}
	if (status === 404) {
		return {
			code: 'wrong-target',
			message: isMobile
				? '这个地址上没有 DSH 的服务。可能是地址填错了，或者连到了别的网站。重新配对一次试试。'
				: '请求的路径不存在。'
		};
	}

	// ── 网络层 ──
	if (code === 'ECONNREFUSED') {
		return {
			code: 'refused',
			message: isMobile
				? '电脑那边直接拒绝了连接。多半是电脑上的 DSH 已经关了。打开它，然后在这里点重连。'
				: '连接被拒绝。'
		};
	}
	if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
		return {
			code: 'dns-failed',
			message: isMobile
				? '找不到电脑的地址，或者手机当前没网。先确认手机能上网，等十几秒插件会自动重新获取地址。'
				: '域名解析失败。'
		};
	}
	// 超时经常没有 code，只能看消息里的关键词。
	if (
		code === 'ETIMEDOUT' ||
		code === 'UND_ERR_CONNECT_TIMEOUT' ||
		code === 'UND_ERR_HEADERS_TIMEOUT' ||
		text.includes('timeout') ||
		text.includes('timed out')
	) {
		return {
			code: 'timeout',
			message: isMobile
				? '连接超时。电脑可能不在线、或者网络不通（比如公司网限制了这类连接）。'
				: '连接超时。'
		};
	}
	if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') {
		return {
			code: 'reset',
			message: isMobile ? '连接被中途断开了，通常是网络抖动。稍等会自动重试。' : '连接被断开。'
		};
	}
	if (code.startsWith('CERT_') || code.startsWith('UNABLE_TO_VERIFY') || code === 'DEPTH_ZERO_SELF_SIGNED_CERT') {
		return {
			code: 'bad-certificate',
			message: isMobile
				? '证书校验没过。如果这台电脑用了公司代理或者自签证书，连接会被拦下来。'
				: '证书校验失败。'
		};
	}

	if (text.includes('bad port')) {
		return {
			code: 'bad-port',
			message: isMobile
				? '这个地址的端口不合法。检查一下粘贴进来的那行地址是不是完整、有没有多余字符。'
				: '端口不合法。'
		};
	}

	// ── 超时与取消 ──
	if (error?.name === 'AbortError' || code === 'ABORT_ERR') {
		return {
			code: 'aborted',
			message: isMobile ? '请求超时了。电脑那边可能正忙，稍等会自动重试。' : '请求被取消。'
		};
	}

	// ── 协议层 ──
	if (code === 'bad-response') {
		return {
			code: 'bad-response',
			message: isMobile
				? '电脑返回的内容看不懂，可能连到了别的服务（而不是 DSH）。检查一下地址对不对。'
				: '对端返回了非 JSON。'
		};
	}
	if (code === 'remote-failed') {
		// 电脑端自己报的错，消息一般已经能看了，原样带出来。
		return { code: 'remote-failed', message: raw };
	}

	return { code: code === '' ? 'unknown' : code, message: raw };
}
