/**
 * 落盘日志与状态目录。
 *
 * 为什么必须有落盘日志：真机上 `console.log` 在 App 里根本看不见，
 * 而远程链路的故障（隧道断了、认证失败、代理没生效）全都发生在没有桌面终端的时刻。
 * 没有这条通道，任何一个问题都只能靠"猜"。日志限制大小，避免长期运行撑爆存储。
 */

import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 状态根目录。与原插件（`~/.dsh/dsh-remote`）刻意分开，两者可同机共存。 */
export const STATE_DIR = join(
	process.env.DSH_HOME ?? join(homedir(), '.dsh'),
	'dsh-wire'
);

/** 单文件上限，超过就轮转一次（只保留一份旧文件）。 */
const MAX_LOG_BYTES = 2 * 1024 * 1024;

/** 确保目录存在；失败不抛（日志不该拖垮插件启动）。 */
function ensureDir() {
	try {
		mkdirSync(STATE_DIR, { recursive: true });
	} catch {
		/* 目录不可写时静默降级为无日志，绝不让它影响主流程 */
	}
}

/**
 * 追加一行日志。
 * @param {string} line 内容。
 */
export function wireLog(line) {
	ensureDir();
	const path = join(STATE_DIR, 'wire.log');
	try {
		try {
			if (statSync(path).size > MAX_LOG_BYTES) renameSync(path, `${path}.1`);
		} catch {
			/* 首次写入时文件不存在，正常路径 */
		}
		appendFileSync(path, `${new Date().toISOString()} ${line}\n`, 'utf8');
	} catch {
		/* 落盘失败不影响功能 */
	}
}

/** 日志文件路径，供界面展示。 */
export const LOG_PATH = join(STATE_DIR, 'wire.log');
