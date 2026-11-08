import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, parse, relative, resolve, sep } from 'node:path';

export interface WorkPathIdentity { readonly path: string; readonly dev: number; readonly ino: number }
export interface WorkPathDescriptor {
  readonly path: string; readonly root: string; readonly bytes: number;
  readonly mtimeMs: number; readonly ctimeMs: number; readonly dev: number; readonly ino: number;
  readonly sha256: string; readonly createdAt: number; readonly expiresAt: number;
  readonly parents: readonly WorkPathIdentity[];
}
export function validWorkPath(value: unknown): value is WorkPathDescriptor {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).sort().join(',') === 'bytes,createdAt,ctimeMs,dev,expiresAt,ino,mtimeMs,parents,path,root,sha256'
    && typeof v.path === 'string' && typeof v.root === 'string' && controlledRoot(v.root)
    && isAbsolute(v.path) && resolve(v.path) === v.path && v.path.length <= 4096 && !/[\x00-\x1f\x7f]/.test(v.path)
    && within(v.root, v.path) && v.path !== v.root
    && ['bytes', 'dev', 'ino', 'createdAt', 'expiresAt'].every(k => Number.isSafeInteger(v[k]) && Number(v[k]) >= 0)
    && Number(v.bytes) > 0 && Number(v.expiresAt) === Number(v.createdAt) + 86400000
    && ['mtimeMs', 'ctimeMs'].every(k => typeof v[k] === 'number' && Number.isFinite(v[k]))
    && typeof v.sha256 === 'string' && /^[a-f0-9]{64}$/.test(v.sha256)
    && Array.isArray(v.parents) && v.parents.length > 0 && v.parents.length <= 128
    && v.parents.every(p => p && typeof p === 'object' && Object.keys(p).sort().join(',') === 'dev,ino,path'
      && typeof p.path === 'string' && Number.isSafeInteger(p.dev) && Number.isSafeInteger(p.ino));
}
export function controlledRoot(root: string): boolean {
  return isAbsolute(root) && resolve(root) === root && root.length <= 4096 && !/[\x00-\x1f\x7f]/.test(root)
    && root !== parse(root).root && root !== dirname(root) && dirname(root) !== parse(root).root;
}
function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
function fail(): never { throw new TypeError('WORK_PATH_CHANGED_OR_UNSAFE'); }
async function parents(root: string, path: string): Promise<WorkPathIdentity[]> {
  if (!controlledRoot(root) || !isAbsolute(path) || resolve(path) !== path || !within(root, path) || root === path
    || await realpath(root) !== root || await realpath(path) !== path) return fail();
  const paths: string[] = [];
  let current = dirname(path);
  while (within(root, current)) {
    paths.unshift(current);
    if (current === root) break;
    current = dirname(current);
  }
  if (paths.length > 128 || paths[0] !== root) return fail();
  const result: WorkPathIdentity[] = [];
  for (const item of paths) {
    const info = await lstat(item);
    if (!info.isDirectory() || info.isSymbolicLink()) return fail();
    result.push({ path: item, dev: info.dev, ino: info.ino });
  }
  return result;
}
/** Bounded memory; full SHA256, no content sampling. No user files are created or removed. */
export async function inspectWorkPath(input: { readonly path: string; readonly roots: readonly string[];
  readonly expected?: WorkPathDescriptor; readonly signal: AbortSignal; readonly now?: number }): Promise<WorkPathDescriptor> {
  input.signal.throwIfAborted();
  const root = input.roots.find(item => controlledRoot(item) && within(item, input.path) && item !== input.path);
  if (!root) return fail();
  const chain = await parents(root, input.path);
  const handle = await open(input.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || !Number.isSafeInteger(before.size) || before.size < 1) return fail();
    const metadata = { path: input.path, root, bytes: before.size, mtimeMs: before.mtimeMs, ctimeMs: before.ctimeMs,
      dev: before.dev, ino: before.ino, parents: chain };
    if (input.expected && (!validWorkPath(input.expected) || input.expected.expiresAt <= (input.now ?? Date.now())
      || Object.entries(metadata).some(([key, value]) => JSON.stringify(value) !== JSON.stringify(input.expected![key as keyof WorkPathDescriptor])))) return fail();
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(256 * 1024);
    let position = 0;
    for (;;) {
      input.signal.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      position += bytesRead;
      if (position > before.size) return fail();
      hash.update(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    const named = await lstat(input.path);
    if (position !== before.size || !named.isFile() || named.isSymbolicLink() || named.nlink !== 1
      || before.dev !== named.dev || before.ino !== named.ino
      || ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'nlink'].some(key => before[key as keyof typeof before] !== after[key as keyof typeof after])
      || JSON.stringify(chain) !== JSON.stringify(await parents(root, input.path))) return fail();
    const sha256 = hash.digest('hex');
    if (input.expected && sha256 !== input.expected.sha256) return fail();
    input.signal.throwIfAborted();
    const createdAt = input.expected?.createdAt ?? input.now ?? Date.now();
    const result = { ...metadata, sha256, createdAt, expiresAt: createdAt + 86400000 };
    if (!validWorkPath(result) || result.expiresAt <= (input.now ?? Date.now())) return fail();
    return result;
  } finally { await handle.close(); }
}
