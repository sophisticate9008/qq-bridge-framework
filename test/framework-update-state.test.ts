import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFrameworkUpdateState, writeFrameworkUpdateState, type FrameworkUpdateState } from '../src/host/framework-update-state.ts';

test('late preparation cannot resurrect a terminal update or overwrite a different admitted operation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qbf-update-state-'));
  try {
    const state: FrameworkUpdateState = { schema: 1, id: randomUUID(), version: '1.12.0', state: 'preparing',
      createdAt: 1000, updatedAt: 1000, error: null, transactionId: null };
    await writeFrameworkUpdateState(root, state, true);
    await writeFrameworkUpdateState(root, { ...state, state: 'failed', updatedAt: 2000 });
    await assert.rejects(writeFrameworkUpdateState(root, { ...state, state: 'ready', updatedAt: 3000 }), /state_conflict/);
    const next = { ...state, id: randomUUID() };
    await writeFrameworkUpdateState(root, next, true);
    await assert.rejects(writeFrameworkUpdateState(root, { ...state, state: 'failed', updatedAt: 4000 }), /state_conflict/);
    assert.equal((await readFrameworkUpdateState(root))?.id, next.id);
  } finally { await rm(root, { recursive: true, force: true }); }
});
