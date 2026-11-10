import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { isRecord } from '../contracts/values.ts';
import { privatePermissions, securePermissions } from './file-security.ts';
import { chatRepairProcessAlive as processAlive, chatRepairProcessStart as processStart } from './chat-repair.ts';

/** Complete process identity is published atomically; only a proved-dead owner permits recovery. */
export async function acquireProcessFileLock(directory: string, name: string): Promise<() => Promise<void>> {
  if (!/^[a-z][a-z0-9.-]{0,63}$/.test(name)) throw new Error('process_lock_name_invalid');
  const filename = join(directory, name);
  for (let attempt = 0; attempt < 3; attempt++) {
    const temporary = join(directory, `.lock-${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        securePermissions(temporary, 0o600);
        await handle.writeFile(JSON.stringify({ pid: process.pid, started: await processStart(process.pid) }));
        await handle.sync();
        await link(temporary, filename);
        const owned = await handle.stat();
        return async () => {
          const current = await lstat(filename).catch(error => {
            if (isRecord(error) && error.code === 'ENOENT') return null;
            throw error;
          });
          if (current?.dev === owned.dev && current.ino === owned.ino) await unlink(filename);
        };
      } finally { await handle.close(); }
    } catch (error) {
      if (!isRecord(error) || error.code !== 'EEXIST') throw error;
      const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const info = await handle.stat();
        if (!info.isFile() || ![1, 2].includes(info.nlink) || info.size > 1024
          || !privatePermissions(filename, info, 0o600) || process.getuid && info.uid !== process.getuid()) throw new Error('process_lock_invalid');
        const owner: unknown = JSON.parse(await handle.readFile('utf8'));
        if (!isRecord(owner) || typeof owner.pid !== 'number' || !Number.isSafeInteger(owner.pid) || owner.pid < 1
          || owner.started !== null && (typeof owner.started !== 'string' || !/^\d+$/.test(owner.started))) throw new Error('process_lock_invalid');
        if (await processAlive({ pid: owner.pid, started: owner.started as string | null })) throw new Error('process_lock_busy');
        const current = await lstat(filename);
        if (current.ino !== info.ino || current.dev !== info.dev || current.mtimeMs !== info.mtimeMs) throw new Error('process_lock_busy');
        await unlink(filename);
      } finally { await handle.close(); }
    } finally {
      await unlink(temporary).catch(error => { if (!isRecord(error) || error.code !== 'ENOENT') throw error; });
    }
  }
  throw new Error('process_lock_busy');
}
