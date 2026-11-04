import assert from 'node:assert/strict';
import { test } from 'node:test';

import { URL_PATTERN } from '../lib/tunnel.js';

/** 从一段文本里取出第一个匹配，模拟 scan 的行为。 */
function pick(text) {
	// 正则带 g 会记 lastIndex，每次用新的实例。
	const pattern = new RegExp(URL_PATTERN.source);
	const match = pattern.exec(text);
	return match === null ? null : match[0];
}

test('cloudflared 正常输出里的随机域名能被抓到', () => {
	const out = [
		'2026-11-05T01:20:00Z INF Requesting new quick Tunnel on trycloudflare.com...',
		'+--------------------------------------------------------------------------------------------+',
		'|  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |',
		'|  https://brick-metallica-chapel-scores.trycloudflare.com                                    |',
		'+--------------------------------------------------------------------------------------------+'
	].join('\n');
	assert.equal(pick(out), 'https://brick-metallica-chapel-scores.trycloudflare.com');
});

test('请求隧道失败时打印的 API 端点不能被当成隧道地址', () => {
	// 这是真实发生过的线上故障：cloudflared 连不上 Cloudflare 时打印这一行，
	// 旧正则把 api.trycloudflare.com 当成了隧道地址上报给中转，
	// 手机端拿到后必然 fetch failed，而界面看起来一切正常。
	const out =
		'2026-11-05T01:20:00Z ERR Failed to request quick Tunnel: ' +
		'Post "https://api.trycloudflare.com/tunnel": dial tcp: lookup api.trycloudflare.com: no such host';
	assert.equal(pick(out), null);
});

test('api 以外的普通 trycloudflare 域名仍然接受', () => {
	assert.equal(pick('see https://api2.trycloudflare.com'), 'https://api2.trycloudflare.com');
	assert.equal(pick('见 https://ab-cd-ef.trycloudflare.com'), 'https://ab-cd-ef.trycloudflare.com');
});
