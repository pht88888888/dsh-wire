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
