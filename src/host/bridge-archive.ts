import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { FRAMEWORK_REPOSITORY, releaseVersion } from '../contracts/framework-release.ts';
import { isRecord } from '../contracts/values.ts';
import { verifyFrameworkDistribution } from './framework-updater.ts';

const limit = 16 * 1024 * 1024;
const missing = (error: unknown) => isRecord(error) && error.code === 'ENOENT';
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export function bridgeArchiveName(version: string): string {
  if (!releaseVersion(version)) throw new Error('bridge_version_invalid');
  return `qq-bridge-framework-dsh-bridge-plugin-${version}.tgz`;
}
async function readRegular(filename: string, maximum: number): Promise<Buffer> {
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > maximum) throw new Error('bridge_archive_file_invalid');
    const bytes = Buffer.alloc(Math.min(maximum, before.size) + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const after = await handle.stat();
    if (bytesRead > maximum || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs || bytesRead !== before.size) throw new Error('bridge_archive_file_changed');
    return bytes.subarray(0, bytesRead);
  } finally { await handle.close(); }
}
async function fetchBytes(url: string, maximum: number, fetcher: typeof fetch, signal: AbortSignal): Promise<Buffer> {
  const response = await fetcher(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(180_000)]) });
  if (!response.ok || !response.body) throw new Error('bridge_download_failed');
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maximum) throw new Error('bridge_download_too_large');
      chunks.push(part.value);
    }
    signal.throwIfAborted();
    return Buffer.concat(chunks);
  } finally { await reader.cancel().catch(() => undefined); }
}
export function bridgeArchiveChecksum(manifest: string, name: string): string {
  const matches = manifest.split(/\r?\n/).filter(line => line.endsWith(`  ${name}`));
  if (matches.length !== 1 || !/^[a-f0-9]{64}  [a-z0-9.-]+$/.test(matches[0]!)) throw new Error('bridge_checksum_missing');
  return matches[0]!.slice(0, 64);
}
async function retainChecksum(filename: string, digest: string): Promise<void> {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(digest); await handle.sync(); } finally { await handle.close(); }
    await link(temporary, filename).catch(async error => {
      if (!isRecord(error) || error.code !== 'EEXIST') throw error;
      if ((await readRegular(filename, 64)).toString('ascii') !== digest) throw new Error('bridge_checksum_invalid');
    });
  } finally { await unlink(temporary).catch(error => { if (!missing(error)) throw error; }); }
}
/** Archives are retained by the DSH installation, independently of framework programs and temporary downloads. */
export async function prepareBridgeArchive(options: { readonly home: string; readonly version: string;
  readonly signal: AbortSignal; readonly offlineRoot?: string; readonly fetch?: typeof fetch }): Promise<string> {
  options.signal.throwIfAborted();
  const name = bridgeArchiveName(options.version);
  if (!isAbsolute(options.home)) throw new Error('bridge_home_invalid');
  const home = await realpath(options.home);
  const directory = join(home, 'packages', 'qq-bridge-framework');
  for (const path of [join(home, 'packages'), directory]) {
    await mkdir(path, { mode: 0o700 }).catch(error => { if (!isRecord(error) || error.code !== 'EEXIST') throw error; });
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== resolve(path)
      || process.getuid && info.uid !== process.getuid()) throw new Error('bridge_archive_directory_invalid');
  }
  const filename = join(directory, name), checksumFile = `${filename}.sha256`;
  let digest: string, bytes: Buffer | undefined;
  if (options.offlineRoot) {
    const distribution = await verifyFrameworkDistribution(options.offlineRoot);
    if (distribution.version !== options.version) throw new Error('bridge_offline_version_mismatch');
    const entry = distribution.files.find(file => file.path === `components/${name}`);
    if (!entry) throw new Error('bridge_offline_component_missing');
    digest = entry.sha256;
    bytes = await readRegular(join(options.offlineRoot, entry.path), limit);
  } else {
    const saved = await readRegular(checksumFile, 64).catch(error => { if (missing(error)) return null; throw error; });
    if (saved) {
      digest = saved.toString('ascii');
      if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('bridge_checksum_invalid');
    } else {
      const url = `https://github.com/${FRAMEWORK_REPOSITORY}/releases/download/v${options.version}`;
      const manifest = await fetchBytes(`${url}/SHA256SUMS`, 64 * 1024, options.fetch ?? fetch, options.signal);
      digest = bridgeArchiveChecksum(manifest.toString('utf8'), name);
    }
  }
  const existing = await readRegular(filename, limit).catch(error => { if (missing(error)) return null; throw error; });
  if (existing) {
    if (hash(existing) !== digest) throw new Error('bridge_archive_checksum_invalid');
    options.signal.throwIfAborted();
    await retainChecksum(checksumFile, digest);
    return filename;
  }
  bytes ??= await fetchBytes(`https://github.com/${FRAMEWORK_REPOSITORY}/releases/download/v${options.version}/${name}`,
    limit, options.fetch ?? fetch, options.signal);
  if (hash(bytes) !== digest) throw new Error('bridge_archive_checksum_invalid');
  const temporary = join(directory, `${randomUUID()}.download`);
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    options.signal.throwIfAborted();
    // Never overwrite another download or a pre-existing package without verifying it.
    await link(temporary, filename).catch(async error => {
      if (!isRecord(error) || error.code !== 'EEXIST') throw error;
      if (hash(await readRegular(filename, limit)) !== digest) throw new Error('bridge_archive_checksum_invalid');
    });
    await unlink(temporary);
    await retainChecksum(checksumFile, digest);
    return filename;
  } finally { await unlink(temporary).catch(error => { if (!missing(error)) throw error; }); }
}
