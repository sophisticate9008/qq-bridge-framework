import { randomUUID } from 'node:crypto';
import { lstat, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isRecord } from '../contracts/values.ts';
import { chatRepairProcessAlive, chatRepairProcessStart } from '../storage/chat-repair.ts';
import { ensurePrivateDirectory } from '../storage/private-json.ts';

async function existing(filename: string) {
  try {
    const metadata = await lstat(filename);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 1024) throw new Error('framework_process_lock_invalid');
    const value: unknown = JSON.parse(await readFile(filename, 'utf8'));
    if (!isRecord(value) || !Number.isSafeInteger(value.pid) || Number(value.pid) < 1 || typeof value.id !== 'string'
      || value.started !== null && (typeof value.started !== 'string' || !/^\d+$/.test(value.started))) throw new Error('framework_process_lock_invalid');
    return { metadata, value: { pid: Number(value.pid), started: value.started as string | null, id: value.id } };
  } catch (error) { if (isRecord(error) && error.code === 'ENOENT') return null; throw error; }
}
export async function assertFrameworkProcessStopped(root: string, includeSupervisor = false): Promise<void> {
  const lease = await existing(join(root, 'data/framework-runtime.lock'));
  if (lease && await chatRepairProcessAlive(lease.value)) throw new Error('update_runtime_still_running');
  if (includeSupervisor) {
    const supervisor = await existing(join(root, 'data/framework-supervisor.lock'));
    if (supervisor && await chatRepairProcessAlive(supervisor.value)) throw new Error('update_supervisor_still_running');
  }
}
export async function acquireFrameworkProcessLease(root: string, kind: 'runtime' | 'supervisor'): Promise<() => Promise<void>> {
  await ensurePrivateDirectory(join(root, 'data'));
  const filename = join(root, `data/framework-${kind}.lock`);
  const previous = await existing(filename);
  if (previous) {
    if (await chatRepairProcessAlive(previous.value)) throw new Error('framework_already_running');
    const current = await lstat(filename);
    if (current.ino !== previous.metadata.ino || current.dev !== previous.metadata.dev || current.mtimeMs !== previous.metadata.mtimeMs) throw new Error('framework_process_lock_changed');
    await unlink(filename);
  }
  const id = randomUUID();
  await writeFile(filename, JSON.stringify({ id, pid: process.pid, started: await chatRepairProcessStart(process.pid) }), { flag: 'wx', mode: 0o600 });
  return async () => { if ((await existing(filename))?.value.id === id) await unlink(filename); };
}
