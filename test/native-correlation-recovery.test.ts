import assert from 'node:assert/strict';
import test from 'node:test';
import { createNativeCorrelationRecovery } from '../src/host/native-correlation-recovery.ts';

test('a transient correlation read outage only resumes the same issuer and never replays business operations', async () => {
  let at = 1000, reads = 0, restored = 0, available = false;
  const recovery = createNativeCorrelationRecovery({ issuerEpoch: 'epoch-1', signal: new AbortController().signal, now: () => at,
    describe: async () => { reads++; if (!available) throw new Error('offline'); return { issuerEpoch: 'epoch-1' }; }, restored: () => { restored++; } });
  recovery.fault(true);
  await recovery.tick(); assert.equal(reads, 0);
  at += 30_000; await recovery.tick(); assert.equal(reads, 1); assert.equal(restored, 0);
  available = true; at += 30_000;
  await Promise.all([recovery.tick(), recovery.tick()]); assert.equal(reads, 2); assert.equal(restored, 1);
  at += 30_000; await recovery.tick(); assert.equal(reads, 2);
});
test('changed epochs, permanent evidence faults, explicit recovery and stopped lifecycles stay blocked', async () => {
  for (const reason of ['epoch', 'permanent', 'explicit', 'abort']) {
    let at = 1000, restored = 0;
    const controller = new AbortController();
    const recovery = createNativeCorrelationRecovery({ issuerEpoch: 'epoch-1', signal: controller.signal, now: () => at,
      describe: async () => ({ issuerEpoch: reason === 'epoch' ? 'epoch-2' : 'epoch-1' }), restored: () => { restored++; } });
    recovery.fault(reason !== 'permanent');
    if (reason === 'explicit') recovery.block();
    if (reason === 'abort') controller.abort();
    at += 30_000; await recovery.tick(); recovery.fault(true); at += 30_000; await recovery.tick();
    assert.equal(restored, 0, reason);
  }
});
