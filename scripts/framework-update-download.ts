import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { FRAMEWORK_REPOSITORY, releaseVersion } from '../src/contracts/framework-release.ts';
import { isDistributionPath } from '../src/contracts/framework-distribution.ts';
import { verifyFrameworkDistribution } from '../src/host/framework-updater.ts';
import { readFrameworkUpdateState, writeFrameworkUpdateState } from '../src/host/framework-update-state.ts';
import { isNativeApplicationId } from '../src/contracts/native-application.ts';

const run = promisify(execFile);
export const frameworkUpdateStage = (root: string, id: string) => join(dirname(root), `.qbf-update-${id}`);
async function download(url: string, filename: string, limit: number): Promise<void> {
  // Fixed official release URLs only; redirects carry no credentials.
  const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok || !response.body) throw new Error('update_download_failed');
  const handle = await open(filename, 'wx', 0o600), reader = response.body.getReader();
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.byteLength; if (size > limit) throw new Error('update_download_too_large');
      await handle.writeFile(chunk.value);
    }
    await handle.sync();
  } finally { await handle.close(); await reader.cancel().catch(() => undefined); }
}
export async function prepareFrameworkUpdate(root: string, id: string): Promise<void> {
  const state = await readFrameworkUpdateState(root);
  if (!isNativeApplicationId(id) || !state || state.id !== id || state.state !== 'preparing' || !releaseVersion(state.version)) throw new Error('update_request_invalid');
  const stage = frameworkUpdateStage(root, id);
  try {
    await mkdir(stage, { mode: 0o700 });
    const prefix = `qq-bridge-framework-${state.version}`, name = `${prefix}.tar.gz`;
    const url = `https://github.com/${FRAMEWORK_REPOSITORY}/releases/download/v${state.version}`;
    await download(`${url}/SHA256SUMS`, join(stage, 'SHA256SUMS'), 64 * 1024);
    const checksums = (await readFile(join(stage, 'SHA256SUMS'), 'utf8')).trim().split(/\r?\n/);
    const matches = checksums.filter(line => line.endsWith(`  ${name}`));
    if (matches.length !== 1 || !/^[a-f0-9]{64}  /.test(matches[0])) throw new Error('update_checksum_missing');
    const archive = join(stage, name);
    await download(`${url}/${name}`, archive, 256 * 1024 * 1024);
    if (createHash('sha256').update(await readFile(archive)).digest('hex') !== matches[0].slice(0, 64)) throw new Error('update_checksum_invalid');
    const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:/Windows', 'System32/tar.exe') : 'tar';
    const listing = await run(tar, ['-tzf', archive], { maxBuffer: 8 * 1024 * 1024, timeout: 30_000 });
    for (const member of listing.stdout.trim().split(/\r?\n/)) {
      if (!member.startsWith(prefix + '/')) throw new Error('update_archive_path_invalid');
      const path = member.slice(prefix.length + 1).replace(/\/$/, '');
      if (path && path !== 'distribution.json' && !isDistributionPath(path)) throw new Error('update_archive_path_invalid');
    }
    const verbose = await run(tar, ['-tvzf', archive], { maxBuffer: 8 * 1024 * 1024, timeout: 30_000 });
    if (!verbose.stdout.trim().split(/\r?\n/).every(line => line.startsWith('-') || line.startsWith('d'))) throw new Error('update_archive_links_rejected');
    await run(tar, ['-xzf', archive, '-C', stage], { timeout: 60_000 });
    const source = join(stage, prefix);
    if ((await verifyFrameworkDistribution(source)).version !== state.version) throw new Error('update_version_mismatch');
    const npm = process.platform === 'win32' ? process.execPath : 'npm';
    const args = [...(process.platform === 'win32' ? [join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')] : []),
      'ci', '--omit=dev', '--no-audit', '--no-fund'];
    await run(npm, args, { cwd: source, timeout: 300_000, maxBuffer: 1024 * 1024 });
    const latest = await readFrameworkUpdateState(root);
    if (latest?.id !== id || latest.state !== 'preparing') throw new Error('update_request_changed');
    await writeFrameworkUpdateState(root, { ...state, state: 'ready', updatedAt: Date.now() });
  } catch {
    const latest = await readFrameworkUpdateState(root);
    if (latest?.id === id && latest.state === 'preparing') await writeFrameworkUpdateState(root, { ...state, state: 'failed', updatedAt: Date.now(), error: 'update_preparation_failed' });
    await rm(stage, { recursive: true, force: true });
  }
}
if (process.argv[1]?.endsWith('framework-update-download.js') || process.argv[1]?.endsWith('framework-update-download.ts')) {
  const [root, id, ...extra] = process.argv.slice(2);
  if (!root || !id || extra.length) throw new Error('update_arguments_invalid');
  await prepareFrameworkUpdate(root, id);
}
