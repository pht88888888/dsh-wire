/**
 * 配置读取。
 *
 * 两处来源，后者覆盖前者：
 * 1. `~/.dsh/dsh-wire/config.json` —— 手写或界面写入，跨重启保留
 * 2. 插件加载时传入的 `config` —— DSH 插件配置里的优先级更高
 *
 * 这样既能"装完就配一次"，也能临时用插件配置覆盖，不用改文件。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { STATE_DIR, wireLog } from './log.js';

/** 配置文件路径。 */
export const CONFIG_PATH = join(STATE_DIR, 'config.json');

/**
 * 读配置文件，失败返回空对象。
 * @returns {any} 配置。
 */
function readFile() {
	try {
		const parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
		return parsed !== null && typeof parsed === 'object' ? parsed : {};
	} catch {
		return {};
	}
}

/**
 * 合并两层配置。
 * @param {any} inline 插件内联配置。
 * @returns {any} 合并结果。
 */
export function loadConfig(inline = {}) {
	const merged = { ...readFile(), ...(inline ?? {}) };
	return merged;
}

/**
 * 写回配置文件（供界面或命令行写配对码等）。
 * @param {any} patch 增量。
 * @returns {void}
 */
export function saveConfig(patch) {
	try {
		mkdirSync(STATE_DIR, { recursive: true });
		const next = { ...readFile(), ...patch };
		writeFileSync(CONFIG_PATH, JSON.stringify(next, null, '\t'), { encoding: 'utf8', mode: 0o600 });
	} catch (error) {
		wireLog(`[config] 写入失败: ${error?.message ?? error}`);
	}
}

/**
 * 把配对信息写到单独文件，供界面读取展示。
 * @param {{pairCode: string, url: string, deviceId: string}} pairing 配对信息。
 * @returns {void}
 */
export function writePairing(pairing) {
	try {
		mkdirSync(STATE_DIR, { recursive: true });
		writeFileSync(join(STATE_DIR, 'pairing.json'), JSON.stringify(pairing, null, '\t'), {
			encoding: 'utf8',
			mode: 0o600
		});
	} catch (error) {
		wireLog(`[config] 写配对信息失败: ${error?.message ?? error}`);
	}
}
