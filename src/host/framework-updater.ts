import { createHash, randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, realpath, rename, rm, writeFile, chmod } from 'node:fs/promises';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { MAX_DISTRIBUTION_BYTES, parseFrameworkDistribution, type FrameworkDistribution } from '../contracts/framework-distribution.ts';
import { compareReleaseVersions, releaseVersion } from '../contracts/framework-release.ts';
import { isRecord } from '../contracts/values.ts';
import { assertFrameworkProcessStopped } from './framework-process-lease.ts';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) { if (isRecord(error) && error.code === 'ENOENT') return false; throw error; }
}
/** Never follow an existing installation symlink, including parent directories. */
async function safePath(root: string, relative: string): Promise<string> {
  let path = root;
  for (const part of relative.split('/')) {
    path = join(path, part);
    if (await exists(path) && (await lstat(path)).isSymbolicLink()) throw new Error('update_symlink_rejected');
  }
  return path;
}
export async function verifyFrameworkDistribution(root: string): Promise<FrameworkDistribution> {
  const filename = await safePath(root, 'distribution.json');
  const metadata = await lstat(filename);
  if (!metadata.isFile() || metadata.size > MAX_DISTRIBUTION_BYTES) throw new Error('update_distribution_invalid');
  const distribution = parseFrameworkDistribution(JSON.parse(await readFile(filename, 'utf8')));
  if (!distribution) throw new Error('update_distribution_invalid');
  for (const file of distribution.files) {
    const path = await safePath(root, file.path), metadata = await lstat(path);
    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size !== file.size || hash(await readFile(path)) !== file.sha256) throw new Error('update_file_checksum_invalid');
  }
  const manifest: unknown = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (!isRecord(manifest) || manifest.name !== 'qq-bridge-framework' || manifest.version !== distribution.version) throw new Error('update_version_mismatch');
  return distribution;
}
interface UpdateEntry { readonly path: string; readonly existed: boolean }
interface UpdateJournal { readonly schema: 1; readonly id: string; readonly from: string; readonly to: string;
  readonly state: 'applying' | 'applied' | 'rolled-back'; readonly entries: readonly UpdateEntry[] }
async function journalWrite(directory: string, journal: UpdateJournal) {
  const temporary = join(directory, `journal-${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(journal) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(temporary, join(directory, 'journal.json'));
}
export async function rollbackFrameworkUpdate(target: string, id: string): Promise<void> {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('update_id_invalid');
  const root = await realpath(target);
  await assertFrameworkProcessStopped(root);
  const lock = join(root, '.framework-update.lock');
  if (await exists(lock) && (await readFile(lock, 'utf8')) !== id) throw new Error('update_lock_conflict');
  const directory = await safePath(root, `runtime/framework-updates/${id}`);
  const value: unknown = JSON.parse(await readFile(await safePath(directory, 'journal.json'), 'utf8'));
  if (!isRecord(value) || value.schema !== 1 || value.id !== id || !releaseVersion(value.from) || !releaseVersion(value.to)
    || !['applying', 'applied', 'rolled-back'].includes(String(value.state)) || !Array.isArray(value.entries) || value.entries.length > 40_002) throw new Error('update_journal_invalid');
  const allowed = (await import('../contracts/framework-distribution.ts')).isDistributionPath;
  for (const entry of value.entries) if (!isRecord(entry) || typeof entry.existed !== 'boolean'
    || !allowed(entry.path) && entry.path !== 'distribution.json' && entry.path !== 'node_modules') throw new Error('update_journal_invalid');
  const journal = value as unknown as UpdateJournal;
  if (journal.state === 'rolled-back') return;
  if (journal.state === 'applied') {
    const current: unknown = JSON.parse(await readFile(await safePath(root, 'package.json'), 'utf8'));
    if (!isRecord(current) || current.version !== journal.to) throw new Error('update_rollback_version_conflict');
  }
  for (const entry of [...journal.entries].reverse()) {
    const path = await safePath(root, entry.path), backup = await safePath(directory, `backup/${entry.path}`);
    if (await exists(backup)) {
      await rm(path, { recursive: true, force: true });
      await mkdir(dirname(path), { recursive: true });
      await rename(backup, path);
    } else if (!entry.existed) await rm(path, { recursive: true, force: true });
  }
  await journalWrite(directory, { ...journal, state: 'rolled-back' });
  await rm(join(root, '.framework-update.lock'), { force: true });
}

/** Caller stops the runtime and prepares production dependencies before entering this transaction. */
export async function applyFrameworkUpdate(options: { readonly source: string; readonly target: string;
  readonly allowMajor?: boolean; readonly allowSameVersion?: boolean; readonly dependencies?: boolean; readonly retainLock?: boolean }): Promise<string> {
  const source = await realpath(options.source), target = await realpath(options.target);
  const contains = (parent: string, child: string) => { const path = relative(parent, child); return !path || !path.startsWith('..') && !isAbsolute(path); };
  if (contains(source, target) || contains(target, source)) throw new Error('update_directories_overlap');
  if (await exists(join(target, '.git'))) throw new Error('update_source_checkout_unsupported');
  const distribution = await verifyFrameworkDistribution(source);
  const oldManifest: unknown = JSON.parse(await readFile(await safePath(target, 'package.json'), 'utf8'));
  if (!isRecord(oldManifest) || oldManifest.name !== 'qq-bridge-framework' || !releaseVersion(oldManifest.version)) throw new Error('update_target_invalid');
  const comparison = compareReleaseVersions(distribution.version, oldManifest.version);
  if (comparison < 0 || comparison === 0 && !options.allowSameVersion) throw new Error('update_not_newer');
  if (distribution.version.split('.')[0] !== oldManifest.version.split('.')[0] && !options.allowMajor) throw new Error('update_major_requires_migration');
  const oldValue: unknown = JSON.parse(await readFile(await safePath(target, 'distribution.json'), 'utf8'));
  if (!isRecord(oldValue) || oldValue.schema !== 1 || oldValue.kind !== 'framework-runtime' || oldValue.version !== oldManifest.version) throw new Error('update_target_invalid');
  const old = parseFrameworkDistribution(oldValue);
  if (oldValue.files !== undefined && !old) throw new Error('update_target_inventory_invalid');
  const paths = [...new Set([...distribution.files.map(file => file.path), ...old?.files.map(file => file.path) ?? [], 'distribution.json',
    ...(options.dependencies ? ['node_modules'] : [])])];
  const id = randomUUID();
  const directory = await safePath(target, `runtime/framework-updates/${id}`);
  // Complete preflight before taking ownership of any public file.
  const entries: UpdateEntry[] = [];
  for (const path of paths) {
    const filename = await safePath(target, path), existed = await exists(filename);
    if (existed && !(path === 'node_modules' ? (await lstat(filename)).isDirectory() : (await lstat(filename)).isFile())) throw new Error('update_path_conflict');
    entries.push({ path, existed });
  }
  if (options.dependencies && !(await lstat(await safePath(source, 'node_modules'))).isDirectory()) throw new Error('update_dependencies_missing');
  await writeFile(join(target, '.framework-update.lock'), id, { flag: 'wx', mode: 0o600 });
  try { await assertFrameworkProcessStopped(target); }
  catch (error) { await rm(join(target, '.framework-update.lock')); throw error; }
  const journal: UpdateJournal = { schema: 1, id, from: oldManifest.version, to: distribution.version, state: 'applying', entries };
  let recorded = false;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await journalWrite(directory, journal);
    recorded = true;
    const newFiles = new Map(distribution.files.map(file => [file.path, file]));
    for (const entry of entries) {
      const path = await safePath(target, entry.path);
      if (entry.existed) {
        const backup = join(directory, 'backup', entry.path);
        await mkdir(dirname(backup), { recursive: true });
        await rename(path, backup);
      }
      if (entry.path === 'node_modules') await rename(join(source, 'node_modules'), path);
      else if (entry.path === 'distribution.json' || newFiles.has(entry.path)) {
        await mkdir(dirname(path), { recursive: true });
        await copyFile(join(source, entry.path), path);
        await chmod(path, newFiles.get(entry.path)?.executable ? 0o755 : 0o644);
      }
    }
    await journalWrite(directory, { ...journal, state: 'applied' });
    if (!options.retainLock) await rm(join(target, '.framework-update.lock'));
    return id;
  } catch (error) {
    // If rollback fails, the lock remains and startup refuses the partial installation.
    if (recorded) await rollbackFrameworkUpdate(target, id);
    else await rm(join(target, '.framework-update.lock'), { force: true });
    throw error;
  }
}
