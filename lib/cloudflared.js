/**
 * cloudflared 可执行文件的「查找 / 下载 / 校验」。
 *
 * 为什么需要这一层：快速隧道靠 cloudflared 这个独立二进制跑起来，它不是
 * Node 依赖，npm 装插件不会带上它。用户机器上没有它的时候，spawn 只在日志里
 * 留一句 ENOENT，界面上表现为「隧道地址一直是（还没建立）」，点重新生成配对码
 * 也没有任何反应——因为这个码要靠隧道地址上报给中转才会出现。
 *
 * 所以这里做三件事：
 *   1. 先看插件自己下过的（状态目录里那份，跨版本复用）；
 *   2. 再看系统 PATH 里有没有；
 *   3. 都没有就提供一个能点的下载入口，下到状态目录，不污染系统。
 *
 * 下载**不自动**进行：几 MB 的外网流量应该由用户决定什么时候开始，
 * 而不是一装插件就悄悄发起。界面上给出明确按钮，点了才下。
 */

import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { get } from 'node:https';
import { join } from 'node:path';

import { STATE_DIR, wireLog } from './log.js';

/** 存放插件自己下载的二进制。 */
export const BIN_DIR = join(STATE_DIR, 'bin');

/** 官方 release 的固定前缀。 */
const RELEASE_BASE = 'https://github.com/cloudflare/cloudflared/releases/latest/download/';

/**
 * 按平台给出下载文件名。
 *
 * @param {string} platform `process.platform`。
 * @param {string} arch `process.arch`。
 * @returns {{file: string, executable: string, archive: boolean}|null} 下载信息；不支持时 null。
 */
export function artifactFor(platform, arch) {
	const arm = arch === 'arm64';
	const x64 = arch === 'x64';
	if (platform === 'linux' && (x64 || arm)) {
		const file = `cloudflared-linux-${arm ? 'arm64' : 'amd64'}`;
		return { file, executable: file, archive: false };
	}
	if (platform === 'win32' && (x64 || arm)) {
		const file = `cloudflared-windows-${arm ? 'arm64' : 'amd64'}.exe`;
		return { file, executable: 'cloudflared.exe', archive: false };
	}
	if (platform === 'darwin' && (x64 || arm)) {
		// macOS 的产物是 .tgz，里面才是可执行文件。
		const file = `cloudflared-darwin-${arm ? 'arm64' : 'amd64'}.tgz`;
		return { file, executable: 'cloudflared', archive: true };
	}
	return null;
}

/**
 * 当前平台对应的可执行文件名。
 * @returns {string} 文件名。
 */
function executableName() {
	return process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
}

/** 插件自己下载的那份的路径。 */
export function managedPath() {
	return join(BIN_DIR, executableName());
}

/**
 * 试跑一次 `--version`，确认这个路径真的能跑。
 *
 * 光看文件存在不够：下到一半中断、或者 chmod 没生效，都会得到一个
 * 「有文件但跑不起来」的假阳性，那比没有更糟。
 *
 * @param {string} command 可执行文件路径或命令名。
 * @returns {{ok: boolean, version?: string}} 探测结果。
 */
export function probe(command) {
	try {
		const result = spawnSync(command, ['--version'], { timeout: 5_000, encoding: 'utf8' });
		if (result.error !== undefined || result.status !== 0) {
			return { ok: false };
		}
		const text = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
		const match = /cloudflared version ([0-9][^\s]*)/i.exec(text);
		return { ok: true, version: match === null ? text.split('\n')[0] : match[1] };
	} catch {
		return { ok: false };
	}
}

/**
 * 找一份可用的 cloudflared。
 *
 * 顺序是「自己下过的 → PATH」。前者优先，是因为用户点了下载按钮之后，
 * 就应该立刻用上它，不该被系统里一个更老的版本抢走。
 *
 * @param {string|undefined} configured 配置里显式指定的路径；给了就只认它。
 * @returns {{found: boolean, path?: string, source?: 'configured'|'managed'|'path', version?: string}} 查找结果。
 */
export function findCloudflared(configured) {
	if (typeof configured === 'string' && configured.trim() !== '') {
		const hit = probe(configured.trim());
		return hit.ok
			? { found: true, path: configured.trim(), source: 'configured', version: hit.version }
			: { found: false };
	}
	const managed = managedPath();
	if (existsSync(managed)) {
		const hit = probe(managed);
		if (hit.ok) return { found: true, path: managed, source: 'managed', version: hit.version };
	}
	const hit = probe('cloudflared');
	if (hit.ok) return { found: true, path: 'cloudflared', source: 'path', version: hit.version };
	return { found: false };
}

/** 下载进度，供设置页轮询。 */
export const downloadState = {
	/** @type {'idle'|'downloading'|'done'|'failed'} */
	phase: 'idle',
	/** 已下载字节数。 */
	received: 0,
	/** 总字节数；服务端没给 Content-Length 时是 0。 */
	total: 0,
	/** @type {string|null} */
	message: null,
	/** @type {string|null} */
	path: null
};

/**
 * 把一个 URL 下载到文件，边下边记进度。
 *
 * @param {string} url 下载地址。
 * @param {string} destination 目标文件。
 * @param {number} [redirectsLeft] 剩余重定向次数。
 * @returns {Promise<void>} 完成即写入完毕。
 */
function downloadTo(url, destination, redirectsLeft = 5) {
	return new Promise((resolve, reject) => {
		const request = get(url, { headers: { 'user-agent': 'dsh-wire' } }, (response) => {
			const status = response.statusCode ?? 0;
			if (status >= 300 && status < 400 && typeof response.headers.location === 'string') {
				response.resume();
				if (redirectsLeft <= 0) {
					reject(new Error('重定向次数过多'));
					return;
				}
				resolve(downloadTo(response.headers.location, destination, redirectsLeft - 1));
				return;
			}
			if (status !== 200) {
				response.resume();
				reject(new Error(`下载失败：HTTP ${status}`));
				return;
			}
			const total = Number(response.headers['content-length'] ?? 0);
			downloadState.total = Number.isFinite(total) ? total : 0;
			downloadState.received = 0;
			const chunks = [];
			response.on('data', (chunk) => {
				chunks.push(chunk);
				downloadState.received += chunk.length;
			});
			response.on('end', () => {
				try {
					const buffer = Buffer.concat(chunks);
					if (buffer.length === 0) {
						reject(new Error('下载到的内容是空的'));
						return;
					}
					writeFileSync(destination, buffer);
					resolve();
				} catch (error) {
					reject(error);
				}
			});
			response.on('error', reject);
		});
		request.on('error', reject);
		request.setTimeout(120_000, () => {
			request.destroy(new Error('下载超时'));
		});
	});
}

/**
 * macOS 的产物是 .tgz，用系统自带的 tar 解开。
 *
 * @param {string} archive 压缩包路径。
 * @param {string} directory 解到哪个目录。
 * @returns {void}
 */
function extractTgz(archive, directory) {
	const result = spawnSync('tar', ['-xzf', archive, '-C', directory], { encoding: 'utf8' });
	if (result.error !== undefined || result.status !== 0) {
		throw new Error(`解压失败：${result.error?.message ?? result.stderr ?? '未知原因'}`);
	}
}

/**
 * 下载并安装 cloudflared 到状态目录。
 *
 * @returns {Promise<{ok: boolean, path?: string, version?: string, message?: string}>} 结果。
 */
export async function installCloudflared() {
	if (downloadState.phase === 'downloading') {
		return { ok: false, message: '正在下载中' };
	}
	const artifact = artifactFor(process.platform, process.arch);
	if (artifact === null) {
		return {
			ok: false,
			message: `这个平台还没有自动下载（${process.platform}/${process.arch}），请手动装 cloudflared`
		};
	}

	downloadState.phase = 'downloading';
	downloadState.received = 0;
	downloadState.total = 0;
	downloadState.message = null;
	downloadState.path = null;

	const staging = join(BIN_DIR, `.download-${Date.now()}`);
	try {
		mkdirSync(BIN_DIR, { recursive: true });
		wireLog(`[cloudflared] 开始下载 ${artifact.file}`);
		await downloadTo(RELEASE_BASE + artifact.file, staging);

		let produced = staging;
		if (artifact.archive) {
			extractTgz(staging, BIN_DIR);
			produced = join(BIN_DIR, artifact.executable);
			rmSync(staging, { force: true });
			if (!existsSync(produced)) {
				// 有的包里可执行文件放在子目录，兜一下。
				const found = readdirSync(BIN_DIR).find((name) => name === artifact.executable);
				if (found === undefined) throw new Error('压缩包解开后没找到 cloudflared');
				produced = join(BIN_DIR, found);
			}
		} else {
			const target = managedPath();
			rmSync(target, { force: true });
			renameSync(staging, target);
			produced = target;
		}

		chmodSync(produced, 0o755);
		const size = statSync(produced).size;
		if (size < 1_000_000) {
			// 正常的 cloudflared 是几十 MB；太小多半是错误页或残缺文件。
			rmSync(produced, { force: true });
			throw new Error(`下到的文件只有 ${size} 字节，不像可执行文件`);
		}

		const hit = probe(produced);
		if (!hit.ok) {
			rmSync(produced, { force: true });
			throw new Error('下载完成但跑不起来（可能是平台不匹配或权限问题）');
		}

		downloadState.phase = 'done';
		downloadState.path = produced;
		downloadState.message = null;
		wireLog(`[cloudflared] 就绪 ${produced}（${hit.version ?? '版本未知'}，${Math.round(size / 1024 / 1024)}MB）`);
		return { ok: true, path: produced, version: hit.version };
	} catch (error) {
		rmSync(staging, { force: true });
		const message = error?.message ?? String(error);
		downloadState.phase = 'failed';
		downloadState.message = message;
		wireLog(`[cloudflared] 下载失败: ${message}`);
		return { ok: false, message };
	}
}

/**
 * 供设置页展示的下载进度快照。
 * @returns {{phase: string, received: number, total: number, message: string|null}} 快照。
 */
export function downloadSnapshot() {
	return {
		phase: downloadState.phase,
		received: downloadState.received,
		total: downloadState.total,
		message: downloadState.message
	};
}
