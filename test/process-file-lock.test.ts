import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { acquireProcessFileLock } from '../src/storage/process-file-lock.ts';

test('a live process keeps its lock and abrupt termination permits journal reconciliation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'qbf-process-lock-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const extension = import.meta.url.endsWith('.js') ? 'js' : 'ts';
  const child = spawn(process.execPath, [fileURLToPath(new URL(`./fixtures/process-lock-holder.${extension}`, import.meta.url)), directory],
    { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await once(child.stdout!, 'data');
  await assert.rejects(acquireProcessFileLock(directory, 'operation.lock'), /process_lock_busy/);
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  const release = await acquireProcessFileLock(directory, 'operation.lock');
  await assert.rejects(acquireProcessFileLock(directory, 'operation.lock'), /process_lock_busy/);
  await release();
  await (await acquireProcessFileLock(directory, 'operation.lock'))();
});
