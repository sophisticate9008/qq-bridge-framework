import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkAddress } from './work.js';
import { inspectWorkPath, validWorkPath, type WorkPathDescriptor } from './work-path.js';

function scope(address: WorkAddress): string {
  return createHash('sha256').update(JSON.stringify([address.id, address.parentSessionId, address.childId, address.generation])).digest('hex');
}
/** Only operator-admitted work leases call register; RPC resolves opaque IDs only. */
export function createWorkPathRegistry(directory: string, roots: readonly string[] | (() => readonly string[]), clock = Date.now) {
  let tail: Promise<unknown> = Promise.resolve();
  let closed = false;
  function enqueue<T>(run: () => Promise<T>): Promise<T> {
    const next = tail.catch(() => {}).then(() => { if (closed) throw new TypeError('WORK_PATH_CLOSED'); return run(); }); tail = next; return next;
  }
  async function ready() {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(directory) !== directory
      || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700) throw new TypeError('WORK_PATH_STORAGE_UNSAFE');
  }
  async function read(id: string) {
    if (!/^work-path-ref-[a-f0-9]{64}$/.test(id)) throw new TypeError('WORK_PATH_REFERENCE_INVALID');
    const handle = await open(join(directory, id), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 65536 || stat.uid !== process.getuid?.()
        || (stat.mode & 0o777) !== 0o600) throw new TypeError('WORK_PATH_STORAGE_UNSAFE');
      const value: unknown = JSON.parse(await handle.readFile('utf8'));
      if (!value || typeof value !== 'object' || !('scope' in value) || typeof value.scope !== 'string'
        || !('descriptor' in value) || !validWorkPath(value.descriptor)) throw new TypeError('WORK_PATH_RECORD_INVALID');
      return { scope: value.scope, descriptor: value.descriptor };
    } finally { await handle.close(); }
  }
  async function maintenance() {
    await ready();
    const names = await readdir(directory);
    if (names.length > 512) throw new TypeError('WORK_PATH_CAPACITY');
    const live: { id: string; scope: string; descriptor: WorkPathDescriptor }[] = [];
    for (const id of names) {
      const value = await read(id);
      if (value.descriptor.expiresAt <= clock()) await unlink(join(directory, id));
      else live.push({ id, ...value });
    }
    return live;
  }
  return Object.freeze({
    maintenance: () => enqueue(async () => (await maintenance()).length),
    async close() { closed = true; await Promise.allSettled([tail]); },
    register: (address: WorkAddress, path: string, signal: AbortSignal) => enqueue(async () => {
      const live = await maintenance();
      const descriptor = await inspectWorkPath({ path, roots: typeof roots === 'function' ? roots() : roots, signal, now: clock() });
      const identity = (value: WorkPathDescriptor) => {
        const { createdAt: _createdAt, expiresAt: _expiresAt, ...metadata } = value;
        return JSON.stringify(metadata);
      };
      const prior = live.find(value => value.scope === scope(address) && identity(value.descriptor) === identity(descriptor));
      if (prior) return { id: prior.id, descriptor: prior.descriptor };
      if (live.length >= 512) throw new TypeError('WORK_PATH_CAPACITY');
      // A new explicit registration after expiry gets a fresh ID; an old reference never revives.
      const id = `work-path-ref-${randomBytes(32).toString('hex')}`;
      const text = JSON.stringify({ scope: scope(address), descriptor });
      if (Buffer.byteLength(text) > 65536) throw new TypeError('WORK_PATH_RECORD_TOO_LARGE');
      const handle = await open(join(directory, id), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(text); await handle.sync(); }
      finally { await handle.close(); }
      return { id, descriptor };
    }),
    resolve: (address: WorkAddress, id: string, signal: AbortSignal) => enqueue(async (): Promise<WorkPathDescriptor> => {
      await ready();
      const value = await read(id);
      if (value.scope !== scope(address) || value.descriptor.expiresAt <= clock()) throw new TypeError('WORK_PATH_SCOPE_OR_TTL');
      return inspectWorkPath({ path: value.descriptor.path, roots: typeof roots === 'function' ? roots() : roots, expected: value.descriptor, signal, now: clock() });
    }),
  });
}
