import assert from 'node:assert/strict';
import { test } from 'node:test';

import { explain } from '../lib/explain.js';

/** 造一个和 Node fetch 失败同形状的错误。 */
function fetchFailed(causeCode, causeMessage) {
	const cause = new Error(causeMessage);
	if (causeCode !== undefined) cause.code = causeCode;
	const error = new TypeError('fetch failed');
	error.cause = cause;
	return error;
}

test('连接被拒绝时告诉用户电脑上的 DSH 可能关了', () => {
	const result = explain(fetchFailed('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:39999'), 'mobile');
	assert.equal(result.code, 'refused');
	assert.match(result.message, /DSH/);
	// 不能把原始错误码丢给用户
	assert.doesNotMatch(result.message, /ECONNREFUSED|fetch failed/);
});

test('隧道失效（HTTP 530）解释成电脑重启过、会自动重新找地址', () => {
	const result = explain(new Error('电脑端返回了非 JSON（HTTP 530）'), 'mobile');
	assert.equal(result.code, 'tunnel-gone');
	assert.match(result.message, /隧道/);
	assert.match(result.message, /自动/);
});

test('401 引导用户重新配对', () => {
	const result = explain(new Error('电脑端 HTTP 401'), 'mobile');
	assert.equal(result.code, 'bad-token');
	assert.match(result.message, /配对/);
});

test('没有错误码的超时也能认出来', () => {
	// Node 的 fetch 超时只有 message，cause 上没有 code。
	const error = new TypeError('The operation was aborted due to timeout');
	assert.equal(explain(error, 'mobile').code, 'timeout');
});

test('域名解析失败提示先确认手机能上网', () => {
	const result = explain(fetchFailed('ENOTFOUND', 'getaddrinfo ENOTFOUND x'), 'mobile');
	assert.equal(result.code, 'dns-failed');
	assert.match(result.message, /没网|上网/);
});

test('电脑端自己报的错原样带出来，不吞掉细节', () => {
	const error = new Error('电脑上的会话不存在');
	error.code = 'remote-failed';
	assert.equal(explain(error, 'mobile').message, '电脑上的会话不存在');
});

test('完全不认识的错误也不会显示成空', () => {
	const result = explain(new Error('某种没见过的故障'), 'mobile');
	assert.equal(result.message, '某种没见过的故障');
	assert.ok(result.code.length > 0);
});
