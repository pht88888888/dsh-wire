// dsh-wire — 远程配对设置页（browser half）
//
// 由 dsh-client-modules 作为 /plugins/dsh-wire/client.js 加载，走 vendored cordis
// Loader 的 lazy-CJS 模块表（window.__ModuleLoader__.load）。
//
// 与 host 半只通过同源 fetch 通信：
//   GET  /dsh-wire-admin/state     当前状态
//   POST /dsh-wire-admin/pair      { pairCode } 手机端提交配对码（保存后立即重连）
//   POST /dsh-wire-admin/refresh   电脑端重新生成配对码
//
// 设计取向：**一屏看完全部状态**，不需要用户去翻日志。
//   · 电脑端：配对码大字 + 倒计时 + 隧道地址 + 手机是否在线
//   · 手机端：一个输入框填 6 位码，连不上时直接显示原因
window.__ModuleLoader__.load({
	id: 'dsh-wire',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
		var React = require('react');
		var h = React.createElement;

		var BASE = '/dsh-wire-admin';
		var POLL_MS = 2000;

		/**
		 * 取一次状态。
		 * @returns {Promise<any>} 状态对象；失败时带 error。
		 */
		function fetchState() {
			return fetch(BASE + '/state', { headers: { accept: 'application/json' } })
				.then(function (r) { return r.json(); })
				.catch(function (error) { return { ok: false, error: String(error && error.message || error) }; });
		}

		/**
		 * 发一个 POST。
		 * @param {string} path 路径。
		 * @param {any} body 请求体。
		 * @returns {Promise<any>} 响应对象。
		 */
		function post(path, body) {
			return fetch(BASE + path, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body || {})
			})
				.then(function (r) { return r.json(); })
				.catch(function (error) { return { ok: false, message: String(error && error.message || error) }; });
		}


		// ---------- 提问浮层（手机端）----------
		//
		// DSH 自带的提问卡片绑在会话上，而手机端不持有会话，所以那条路走不通
		// （`answerQuestion` 里 `sessions.scopeOf(owner)` 拿不到就直接 next）。
		// 这里用自绘浮层展示：轮询队列，有问题就盖一层，答完回传。
		var ASK_POLL_MS = 1500;

		/**
		 * 把一条提问渲染成浮层。
		 * @param {any} ask 提问。
		 * @param {HTMLElement} host 容器。
		 * @param {Function} onAnswer 提交答案。
		 * @returns {void}
		 */
		function renderAsk(ask, host, onAnswer) {
			host.innerHTML = '';

			var mask = document.createElement('div');
			mask.className = 'dw-ask-mask';

			var card = document.createElement('div');
			card.className = 'dw-ask-card';

			// 顶部小横条：手机上这个形状一眼就是"可以往下推走"的面板
			var grip = document.createElement('div');
			grip.className = 'dw-ask-grip';
			card.appendChild(grip);

			// 顶部：类型 + 来源。手机上看不到电脑的标签页，来源是唯一的线索。
			var head = document.createElement('div');
			head.className = 'dw-ask-head';
			var badge = document.createElement('span');
			badge.className = 'dw-ask-badge';
			badge.textContent = ask.kind === 'approval' ? '权限申请' : '选择';
			head.appendChild(badge);
			// 题数。内容长的时候要滚动才看得到后面的题，先告诉用户一共有几道，
			// 免得他只答了第一道就以为完事了。
			var total = Array.isArray(ask.questions) ? ask.questions.length : 0;
			if (total > 1) {
				var count = document.createElement('span');
				count.className = 'dw-ask-count';
				count.textContent = '共 ' + total + ' 题';
				head.appendChild(count);
			}
			var src = ask.source && (ask.source.title || ask.source.sessionId);
			if (src) {
				var from = document.createElement('span');
				from.className = 'dw-ask-from';
				from.textContent = '来自 ' + src;
				from.title = ask.source.sessionId || '';
				head.appendChild(from);
			}
			card.appendChild(head);

			var body = document.createElement('div');
			body.className = 'dw-ask-body';
			card.appendChild(body);

			var actions = document.createElement('div');
			actions.className = 'dw-ask-actions';
			card.appendChild(actions);

			if (ask.kind === 'approval') {
				renderApproval(ask, body, actions, onAnswer);
			} else {
				renderQuestions(ask, body, actions, onAnswer);
			}

			mask.appendChild(card);
			host.appendChild(mask);
		}

		/**
		 * 审批形态：工具名 + 理由，两个按钮。
		 * @param {any} ask 审批。
		 * @param {HTMLElement} body 正文容器。
		 * @param {HTMLElement} actions 按钮容器。
		 * @param {Function} onAnswer 提交。
		 * @returns {void}
		 */
		function renderApproval(ask, body, actions, onAnswer) {
			var tool = document.createElement('div');
			tool.className = 'dw-ask-tool';
			tool.textContent = ask.toolName || '未知工具';
			body.appendChild(tool);

			if (ask.reason) {
				var why = document.createElement('div');
				why.className = 'dw-ask-reason';
				why.textContent = ask.reason;
				body.appendChild(why);
			}

			var note = document.createElement('div');
			note.className = 'dw-ask-note';
			note.textContent = '允许只会生效这一次。';
			body.appendChild(note);

			var allow = document.createElement('button');
			allow.className = 'dw-btn dw-btn-primary';
			allow.textContent = '允许一次';
			allow.addEventListener('click', function () {
				onAnswer(ask.id, { outcome: 'allowed-once' });
				document.querySelectorAll('.dw-ask-mask').forEach(function (n) { n.remove(); });
			});
			actions.appendChild(allow);

			var deny = document.createElement('button');
			deny.className = 'dw-btn';
			deny.textContent = '拒绝';
			deny.addEventListener('click', function () {
				onAnswer(ask.id, { outcome: 'rejected' });
				document.querySelectorAll('.dw-ask-mask').forEach(function (n) { n.remove(); });
			});
			actions.appendChild(deny);
		}

		/**
		 * 提问形态：选项 + 「其他」输入。
		 *
		 * 「其他」不是额外功能——DSh 的答案项本来就有 `custom`，很多问题只有
		 * 选不到合适答案时才能推进，所以每道题都留一个自由输入。
		 *
		 * @param {any} ask 提问。
		 * @param {HTMLElement} body 正文容器。
		 * @param {HTMLElement} actions 按钮容器。
		 * @param {Function} onAnswer 提交。
		 * @returns {void}
		 */
		/**
		 * 切换一个选项的选中态（含勾选标记）。
		 * @param {HTMLElement} btn 选项按钮。
		 * @param {boolean} on 是否选中。
		 * @returns {void}
		 */
		function setOn(btn, on) {
			btn.classList.toggle('dw-ask-opt-on', on);
			var label = btn.getAttribute('data-label') || '';
			btn.textContent = (on ? '\u2713 ' : '') + label;
		}

		function renderQuestions(ask, body, actions, onAnswer) {
			/** @type {Object<string, {selected: string[], custom: string}>} */
			var picked = {};

			var questions = ask.questions || [];
			questions.forEach(function (q) {
				picked[q.id] = { selected: [], custom: '' };

				var block = document.createElement('div');
				block.className = 'dw-ask-block';

				if (q.header) {
					var hd = document.createElement('div');
					hd.className = 'dw-ask-qhead';
					hd.textContent = q.header;
					block.appendChild(hd);
				}
				var text = document.createElement('div');
				text.className = 'dw-ask-q';
				text.textContent = q.question || '';
				block.appendChild(text);
				if (q.detail) {
					var detail = document.createElement('div');
					detail.className = 'dw-ask-note';
					detail.textContent = q.detail;
					block.appendChild(detail);
				}

				var opts = q.options || [];
				opts.forEach(function (opt) {
					var btn = document.createElement('button');
					btn.type = 'button';
					btn.className = 'dw-ask-opt';
					btn.setAttribute('data-label', opt.label || '');
					btn.textContent = opt.label || '';
					if (opt.description) btn.title = opt.description;
					btn.addEventListener('click', function () {
						var state = picked[q.id];
						var label = opt.label || '';
						if (q.multiSelect) {
							var at = state.selected.indexOf(label);
							if (at >= 0) { state.selected.splice(at, 1); setOn(btn, false); }
							else { state.selected.push(label); setOn(btn, true); }
						} else {
							state.selected = [label];
							Array.prototype.forEach.call(block.querySelectorAll('.dw-ask-opt'), function (b) {
								setOn(b, b === btn);
							});
						}
						if (customInput) customInput.value = '';
					});
					block.appendChild(btn);
				});

				// 「其他」：和选项并列的一个自由输入框。
				var otherRow = document.createElement('div');
				otherRow.className = 'dw-ask-other';
				var otherLabel = document.createElement('span');
				otherLabel.className = 'dw-ask-note';
				otherLabel.textContent = opts.length > 0 ? '其他：' : '回答：';
				otherRow.appendChild(otherLabel);
				var customInput = document.createElement('input');
				customInput.type = 'text';
				customInput.className = 'dw-ask-input';
				customInput.placeholder = opts.length > 0 ? '不在上面就写这里' : '输入回答';
				customInput.addEventListener('input', function () {
					var state = picked[q.id];
					state.custom = customInput.value;
					if (customInput.value !== '' && !q.multiSelect) {
						state.selected = [];
						Array.prototype.forEach.call(block.querySelectorAll('.dw-ask-opt'), function (b) {
							setOn(b, false);
						});
					}
				});
				otherRow.appendChild(customInput);
				block.appendChild(otherRow);

				body.appendChild(block);
			});

			var send = document.createElement('button');
			send.className = 'dw-btn dw-btn-primary';
			send.textContent = '提交';
			// "跳过"给不想答的人一条立刻脱身的出路：
			// 不发答案而是声明放弃，电脑端马上交回本机前端，不必干等 60 秒。
			var skip = document.createElement('button');
			skip.className = 'dw-btn';
			skip.textContent = '跳过';
			// 和 DSH 原生 Skip 完全一致：每道题回一个空选择，模型据此跳过本题继续干活。
			//
			// 这里绝不能"交回电脑端"——用户在手机上远程操作，电脑本来就不在身边，
			// 交回去等于让模型干等着，远程操控就断了。
			skip.addEventListener('click', function () {
				var answers = questions.map(function (q) {
					return { id: q.id, selected: [] };
				});
				onAnswer(ask.id, { answers: answers });
				document.querySelectorAll('.dw-ask-mask').forEach(function (n) { n.remove(); });
			});
			actions.appendChild(skip);

			send.addEventListener('click', function () {
				var answers = questions.map(function (q) {
					var state = picked[q.id];
					var item = { id: q.id, selected: state.selected.slice() };
					if (state.custom !== '') item.custom = state.custom;
					return item;
				});
				onAnswer(ask.id, { answers: answers });
				document.querySelectorAll('.dw-ask-mask').forEach(function (n) { n.remove(); });
			});
			actions.appendChild(send);
		}

		/**
		 * 挂上浮层并开始轮询。
		 * @returns {() => void} 卸载函数。
		 */
		function mountAskOverlay() {
			var host = document.createElement('div');
			host.setAttribute('data-dsh-wire-ask', '1');
			document.body.appendChild(host);
			var current = null;

			function onAnswer(askId, payload) {
				current = null;
				fetch(BASE + '/ask-answer', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(Object.assign({ askId: askId }, payload || {}))
				}).catch(function () {});
			}

			/**
			 * 拉一次待决项。
			 *
			 * 用 setTimeout 链而不是 setInterval：手机锁屏或切到后台时，
			 * 浏览器会把定时器压到一分钟一次甚至暂停，回来时 setInterval
			 * 还会把积压的几次一口气补上。自排链没有这个问题。
			 */
			var stopped = false;
			var timer = null;
			function pump() {
				if (stopped) return;
				fetch(BASE + '/pending', { headers: { accept: 'application/json' } })
					.then(function (r) { return r.json(); })
					.then(function (data) {
						var ask = data && Array.isArray(data.asks) ? data.asks[0] : null;
						if (!ask) {
							if (current !== null) { current = null; host.innerHTML = ''; }
							return;
						}
						if (current !== null && current.id === ask.id) return;
						current = ask;
						renderAsk(ask, host, onAnswer);
					})
					.catch(function () {})
					.then(function () {
						if (stopped) return;
						timer = setTimeout(pump, ASK_POLL_MS);
					});
			}

			/**
			 * 页面重新可见时立刻拉一次。
			 *
			 * 用户锁屏期间电脑端可能已经提过问，等他解锁回来，靠下一轮定时器
			 * 还要再等一个周期才看得到。这里直接戳一下，卡片立刻出现。
			 */
			function onVisible() {
				if (document.visibilityState !== 'visible') return;
				if (stopped) return;
				clearTimeout(timer);
				pump();
			}

			pump();
			document.addEventListener('visibilitychange', onVisible);
			window.addEventListener('pageshow', onVisible);

			return function () {
				stopped = true;
				clearTimeout(timer);
				document.removeEventListener('visibilitychange', onVisible);
				window.removeEventListener('pageshow', onVisible);
				host.remove();
			};
		}

		function copy(text) {
			if (navigator.clipboard && navigator.clipboard.writeText) {
				navigator.clipboard.writeText(text).catch(function () {});
			}
		}

		// ---------- 样式（全部走主题 token，亮/暗通用）----------
		var CSS =
			'.dw-page{display:flex;flex-direction:column;gap:14px;padding:4px 2px 28px;max-width:720px;width:100%;box-sizing:border-box}' +
			'.dw-page *{box-sizing:border-box}' +
			'.dw-card{border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.18));border-radius:13px;padding:14px 16px;background:var(--dsw-alias-bg-layer-1,transparent)}' +
			'.dw-label{font-size:10.5px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--dsw-alias-label-secondary,inherit);opacity:.85}' +
			'.dw-code{font-size:34px;line-height:1.15;font-weight:700;letter-spacing:.16em;font-variant-numeric:tabular-nums;margin-top:6px;color:var(--dsw-alias-label-primary,inherit)}' +
			'.dw-hint{font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-secondary,inherit);margin-top:6px;overflow-wrap:anywhere}' +
			'.dw-ask-mask{position:fixed;inset:0;z-index:9999;display:flex;align-items:flex-end;justify-content:center;padding:12px 12px calc(12px + env(safe-area-inset-bottom,0px));background:rgba(0,0,0,.45);animation:dw-fade .14s ease-out}' +
			'@keyframes dw-fade{from{opacity:0}to{opacity:1}}' +
			'@keyframes dw-rise{from{transform:translateY(14px);opacity:0}to{transform:none;opacity:1}}' +
			'.dw-ask-card{width:100%;max-width:440px;max-height:82vh;display:flex;flex-direction:column;box-sizing:border-box;border-radius:18px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#111);box-shadow:0 18px 56px rgba(0,0,0,.34),0 2px 8px rgba(0,0,0,.12);animation:dw-rise .2s cubic-bezier(.22,1,.36,1);overflow:hidden}' +
			'.dw-ask-grip{flex:none;width:38px;height:4px;border-radius:999px;background:currentColor;opacity:.16;margin:8px auto 2px}' +
			'.dw-ask-head{display:flex;align-items:center;gap:8px;padding:6px 18px 12px;flex-wrap:wrap}' +
			'.dw-ask-badge{flex:none;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600;background:var(--dsw-alias-brand-primary,#4d6bfe);color:#fff}' +
			'.dw-ask-count{flex:none;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:500;background:rgba(127,127,127,.12);opacity:.75}' +
			'.dw-ask-from{font-size:12px;opacity:.62;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}' +
			'.dw-ask-body{padding:0 18px;overflow-y:auto;flex:1 1 auto;-webkit-overflow-scrolling:touch}' +
			'.dw-ask-actions{display:flex;gap:10px;justify-content:flex-end;padding:12px 18px 16px;flex:none;border-top:1px solid rgba(127,127,127,.12);margin-top:4px}' +
			'.dw-ask-mask .dw-ask-actions .dw-btn{min-height:38px;flex:none;width:auto;padding:0 18px;font-size:13.5px;font-weight:500;border-radius:10px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));background:transparent;color:inherit;cursor:pointer;-webkit-tap-highlight-color:transparent}' +
			'.dw-ask-mask .dw-ask-actions .dw-btn-primary{border-color:transparent;background:var(--dsw-alias-brand-primary,#4d6bfe);color:#fff}' +
			'.dw-ask-mask .dw-ask-actions .dw-btn:active{transform:scale(.98)}' +
			'.dw-ask-block{margin-bottom:14px}' +
			'.dw-ask-qhead{font-size:11px;opacity:.6;margin-bottom:4px}' +
			'.dw-ask-q{font-size:14.5px;line-height:1.5;margin-bottom:8px}' +
			'.dw-ask-note{font-size:11.5px;line-height:1.5;opacity:.6;margin:4px 0}' +
			'.dw-ask-tool{font-family:var(--dsw-font-mono,monospace);font-size:13px;padding:8px 10px;border-radius:8px;background:rgba(127,127,127,.12);margin-bottom:8px;overflow-wrap:anywhere}' +
			'.dw-ask-reason{font-size:13px;line-height:1.55;margin-bottom:6px}' +
			'.dw-ask-opt{display:block;width:100%;text-align:left;box-sizing:border-box;margin:7px 0;padding:12px 14px;font-size:14px;line-height:1.4;border-radius:11px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));background:transparent;color:inherit;cursor:pointer;transition:border-color .14s,box-shadow .14s,background .14s;-webkit-tap-highlight-color:transparent}' +
			'.dw-ask-opt:active{transform:scale(.99)}' +
			'.dw-ask-opt-on{border-color:var(--dsw-alias-brand-primary,#4d6bfe);background:rgba(77,107,254,.07);box-shadow:inset 0 0 0 1px var(--dsw-alias-brand-primary,#4d6bfe);font-weight:500}' +
			'.dw-ask-other{display:flex;align-items:center;gap:8px;margin-top:8px}' +
			'.dw-ask-input{flex:1 1 auto;min-width:0;box-sizing:border-box;padding:9px 11px;font-size:13.5px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));background:transparent;color:inherit;outline:none}' +
			'.dw-ask-input:focus{border-color:var(--dsw-alias-brand-primary,#4d6bfe)}' +
			'.dw-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:10px}' +
			'.dw-dot{width:8px;height:8px;border-radius:50%;flex:none}' +
			'.dw-btn{appearance:none;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.3));background:transparent;color:inherit;font:inherit;font-size:12.5px;padding:6px 13px;border-radius:8px;cursor:pointer}' +
			'.dw-btn:hover{background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.12))}' +
			'.dw-btn:disabled{opacity:.45;cursor:default}' +
			'.dw-btn-primary{background:var(--dsw-alias-brand-primary,#3b6cf6);border-color:transparent;color:#fff}' +
			'.dw-input{font:inherit;font-size:19px;letter-spacing:.2em;text-transform:uppercase;width:100%;padding:11px 13px;border-radius:9px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.3));background:transparent;color:inherit;outline:none}' +
			'.dw-input:focus{border-color:var(--dsw-alias-brand-primary,#3b6cf6)}' +
			'.dw-err{font-size:12px;line-height:1.5;color:#d33;margin-top:8px;overflow-wrap:anywhere}' +
			'.dw-ok{font-size:12px;line-height:1.5;color:#189f5b;margin-top:8px}' +
			'.dw-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;overflow-wrap:anywhere}' +
			'.dw-tap{font-size:11.5px;color:var(--dsw-alias-label-secondary,inherit);cursor:pointer;text-decoration:underline;text-underline-offset:2px}';

		/**
		 * 设置页主体。
		 * @returns {any} React 节点。
		 */
		function WireSettings() {
			var state = React.useState(null);
			var st = state[0], setSt = state[1];
			var input = React.useState('');
			var code = input[0], setCode = input[1];
			var busy = React.useState('');
			var busyKind = busy[0], setBusy = busy[1];
			var notice = React.useState('');
			var msg = notice[0], setMsg = notice[1];

			React.useEffect(function () {
				var alive = true;
				var tick = function () {
					fetchState().then(function (next) { if (alive) setSt(next); });
				};
				tick();
				var timer = setInterval(tick, POLL_MS);
				return function () { alive = false; clearInterval(timer); };
			}, []);

			if (st === null) {
				return h('div', { className: 'dw-page' },
					h('div', { className: 'dw-card' }, h('div', { className: 'dw-hint' }, '正在读取状态…')));
			}

			var isDesktop = st.role === 'desktop';
			var connected = isDesktop ? st.phoneOnline === true : st.connected === true;

			var statusText;
			if (isDesktop) statusText = st.phoneOnline ? '手机已连接' : '手机未连接';
			else if (st.connected) statusText = '已连上电脑';
			else statusText = '尚未连上电脑';

			var dotColor = connected ? '#189f5b' : (st.error ? '#d33' : 'var(--dsw-alias-label-secondary,#999)');

			/**
			 * 电脑端：重新生成配对码。
			 * @returns {Promise<void>} 完成。
			 */
			var onRefresh = function () {
				setBusy('refresh');
				setMsg('');
				post('/refresh', {}).then(function (r) {
					setBusy('');
					if (r && r.ok) setSt(r);
					else setMsg((r && r.message) || '生成失败');
				});
			};

			/**
			 * 手机端：提交配对码。
			 * @returns {Promise<void>} 完成。
			 */
			var onPair = function () {
				setBusy('pair');
				setMsg('');
				post('/pair', { pairCode: code }).then(function (r) {
					setBusy('');
					if (r && r.ok && r.connected) {
						setSt(r);
						setMsg('已连上电脑');
					} else if (r && r.ok) {
						setSt(r);
						setMsg((r && r.message) || '配对码已保存，但还没连上，确认电脑端是否在线');
					} else {
						setMsg((r && r.message) || '配对失败');
					}
				});
			};

			var children = [];

			// ── 状态条 ──
			children.push(
				h('div', { className: 'dw-card', key: 'status' },
					h('div', { className: 'dw-row', style: { marginTop: 0 } },
						h('span', { className: 'dw-dot', style: { background: dotColor } }),
						h('span', { style: { fontSize: 13.5, fontWeight: 600 } }, statusText),
						h('span', { className: 'dw-hint', style: { marginTop: 0, marginLeft: 'auto' } }, 'v' + st.version)
					),
					st.error ? h('div', { className: 'dw-err' }, st.error) : null,
					msg ? h('div', { className: 'dw-ok' }, msg) : null
				)
			);

			// ── 电脑端：配对码 ──
			if (isDesktop) {
				var codeBlock;
				if (st.pairCode) {
					var secs = st.pairCodeExpiresIn;
					codeBlock = h('div', { key: 'code' },
						h('div', { className: 'dw-label' }, '手机配对码'),
						h('div', {
							className: 'dw-code',
							title: '点击复制',
							style: { cursor: 'pointer' },
							onClick: function () { copy(st.pairCode); setMsg('已复制配对码'); }
						}, st.pairCode),
						h('div', { className: 'dw-hint' },
							secs !== null && secs > 0
								? '在手机端 DSH 的这个设置页里输入它，' + Math.floor(secs / 60) + ' 分 ' + (secs % 60) + ' 秒内有效'
								: '这个码已经过期了，点下面「重新生成」')
					);
				} else {
					codeBlock = h('div', { key: 'code' },
						h('div', { className: 'dw-label' }, '手机配对码'),
						h('div', { className: 'dw-hint', style: { marginTop: 8 } },
							st.rendezvous
								? '还没有配对码。隧道就绪后会自动出现；没有的话点「重新生成」。'
								: '还没配置中转地址，手机找不到这台电脑。')
					);
				}
				children.push(
					h('div', { className: 'dw-card', key: 'pair' },
						codeBlock,
						h('div', { className: 'dw-row' },
							h('button', {
								className: 'dw-btn',
								disabled: busyKind === 'refresh',
								onClick: onRefresh
							}, busyKind === 'refresh' ? '生成中…' : '重新生成配对码')
						)
					)
				);

				// ── 电脑端：地址信息 ──
				children.push(
					h('div', { className: 'dw-card', key: 'addr' },
						h('div', { className: 'dw-label' }, '连接信息'),
						h('div', { className: 'dw-hint', style: { marginTop: 8 } },
							h('span', null, '隧道地址：'),
							h('span', { className: 'dw-mono' }, st.tunnelUrl || '（还没建立）')
						),
						h('div', { className: 'dw-hint' },
							h('span', null, '中转服务：'),
							h('span', { className: 'dw-mono' }, st.rendezvous || '（未配置）')
						),
						h('div', { className: 'dw-hint' },
							h('span', null, '本机端口：'),
							h('span', { className: 'dw-mono' }, st.localOrigin || '（未监听）')
						)
					)
				);
			} else {
				// ── 手机端：填配对码 ──
				children.push(
					h('div', { className: 'dw-card', key: 'pair' },
						h('div', { className: 'dw-label' }, '输入电脑上显示的 6 位配对码'),
						h('div', { style: { marginTop: 9 } },
							h('input', {
								className: 'dw-input',
								value: code,
								maxLength: 6,
								placeholder: 'ABC123',
								autoComplete: 'off',
								spellCheck: false,
								onChange: function (e) { setCode(String(e.target.value || '').toUpperCase().replace(/[^A-Z0-9]/g, '')); },
								onKeyDown: function (e) { if (e.key === 'Enter' && code.length === 6) onPair(); }
							})
						),
						h('div', { className: 'dw-row' },
							h('button', {
								className: 'dw-btn dw-btn-primary',
								disabled: busyKind === 'pair' || code.length !== 6,
								onClick: onPair
							}, busyKind === 'pair' ? '连接中…' : '连接')
						),
						h('div', { className: 'dw-hint' },
							'电脑端打开 DSH 的这个设置页就能看到配对码。填好后点连接，不用重启。')
					)
				);

				children.push(
					h('div', { className: 'dw-card', key: 'addr' },
						h('div', { className: 'dw-label' }, '连接信息'),
						h('div', { className: 'dw-hint', style: { marginTop: 8 } },
							h('span', null, '电脑地址：'),
							h('span', { className: 'dw-mono' }, st.desktopOrigin || '（还没拿到）')
						),
						h('div', { className: 'dw-hint' },
							h('span', null, '中转服务：'),
							h('span', { className: 'dw-mono' }, st.rendezvous || '（未配置）')
						)
					)
				);
			}

			return h('div', { className: 'dw-page' }, children);
		}

		exports.inject = ['slots'];
		exports.apply = function apply(ctx) {
			var slots = ctx.get('slots');
			if (slots === undefined) return;

			ctx.effect(function () {
				var style = document.createElement('style');
				style.setAttribute('data-dsh-wire', '1');
				style.textContent = CSS;
				document.head.appendChild(style);
				return function () { style.remove(); };
			}, 'dsh-wire: settings styles');

			// 提问浮层：不依赖任何 slot，直接挂在 body 上，
			// 这样无论用户停在哪个页面都能看到电脑端发来的提问。
			ctx.effect(function () { return mountAskOverlay(); }, 'dsh-wire: 提问浮层');

			ctx.effect(function () {
				return slots.inject('settings.section', function () {
					return slots.register(
						{ name: 'settings.section', id: 'dsh-wire', order: 19, label: '远程配对' },
						WireSettings
					);
				});
			}, 'dsh-wire: 远程配对设置页');
		};

		return module.exports;
	}
});
