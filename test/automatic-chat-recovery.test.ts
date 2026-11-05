import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAutomaticChatRecovery, type RecoveryObservation } from '../src/admin/automatic-chat-recovery.ts';

test('automatic repair requires sustained faults and keeps its retry budget across restarts and lost responses', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qbf-auto-recovery-'));
  try {
    let at = 1_000_000, calls = 0;
    let observation: RecoveryObservation = { eligible: true, fault: true, reason: 'framework_unavailable' };
    const options = { directory, now: () => at, observe: async () => observation,
      repair: async () => { calls++; throw new Error('response_lost'); } };
    let recovery = createAutomaticChatRecovery(options);
    const tick = () => recovery.tick(AbortSignal.timeout(1000));
    await tick(); at += 89_999; await tick(); assert.equal(calls, 0);
    at++; await assert.rejects(tick); assert.equal(calls, 1);
    recovery = createAutomaticChatRecovery(options);
    at += 299_999; await tick(); assert.equal(calls, 1);
    at++; await assert.rejects(tick); assert.equal(calls, 2);
    at += 900_000; await assert.rejects(tick); assert.equal(calls, 3);
    at += 100_000; await tick(); assert.equal(calls, 3);
    observation = { eligible: false, fault: false, reason: 'explicitly_stopped' };
    at += 3_600_000; await tick(); assert.equal(calls, 3);
    observation = { eligible: true, fault: true, reason: 'framework_unavailable' };
    await tick(); at += 90_000; await assert.rejects(tick); assert.equal(calls, 4);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('transient faults and an aborted observation cannot dispatch recovery', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qbf-auto-recovery-'));
  try {
    let at = 1000, fault = true, calls = 0;
    const controller = new AbortController();
    const recovery = createAutomaticChatRecovery({ directory, now: () => at,
      observe: async () => ({ eligible: true, fault, reason: null }), repair: async () => { calls++; } });
    await recovery.tick(controller.signal); at += 60_000; fault = false;
    await recovery.tick(controller.signal); fault = true; at += 60_000;
    await recovery.tick(controller.signal); at += 90_000; controller.abort();
    await recovery.tick(controller.signal); assert.equal(calls, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
