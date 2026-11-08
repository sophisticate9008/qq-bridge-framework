import assert from 'node:assert/strict';
import test from 'node:test';
import { runServiceLifecycle, serviceLifecycleTimeout, SERVICE_START_TIMEOUT_MS, SERVICE_STOP_TIMEOUT_MS } from '../scripts/service-lifecycle.ts';

test('each service keeps its full shutdown and startup allowance after slow predecessors', async context => {
  context.mock.timers.enable({ apis: ['Date'], now: 100_000 });
  const calls: string[] = [];
  await runServiceLifecycle({ action: 'restart', stopTargets: ['admin', 'gateway', 'worker'],
    startTargets: ['worker', 'gateway', 'admin'], report: () => assert.fail('unexpected recovery'),
    async stop(id, deadline) {
      assert.equal(deadline - Date.now(), SERVICE_STOP_TIMEOUT_MS);
      calls.push(`stop:${id}`);
      context.mock.timers.tick(20_000);
    },
    async start(id, deadline) {
      assert.equal(deadline - Date.now(), SERVICE_START_TIMEOUT_MS);
      calls.push(`start:${id}`);
      context.mock.timers.tick(80_000);
    },
  });
  assert.deepEqual(calls, ['stop:admin', 'stop:gateway', 'stop:worker', 'start:worker', 'start:gateway', 'start:admin']);
});

test('failed worker stop restores confirmed framework stops and preserves the original failure', async () => {
  const failure = new Error('worker stop unconfirmed');
  const calls: string[] = [];
  const reports: string[] = [];
  await assert.rejects(runServiceLifecycle({ action: 'restart',
    stopTargets: ['admin', 'gateway', 'worker', 'dsh'], startTargets: ['dsh', 'worker', 'gateway', 'admin'],
    report: message => reports.push(message),
    async stop(id) { calls.push(`stop:${id}`); if (id === 'worker') throw failure; },
    async start(id) { calls.push(`start:${id}`); },
  }), error => error === failure);
  assert.deepEqual(calls, ['stop:admin', 'stop:gateway', 'stop:worker', 'start:gateway', 'start:admin']);
  assert.match(reports.join('\n'), /恢复已确认停止/);
});

test('failure restoring one component does not prevent restoring the management service', async () => {
  const calls: string[] = [];
  const reports: string[] = [];
  await assert.rejects(runServiceLifecycle({ action: 'restart',
    stopTargets: ['admin', 'gateway', 'worker'], startTargets: ['worker', 'gateway', 'admin'],
    report: message => reports.push(message),
    async stop(id) { if (id === 'worker') throw new Error('stop failed'); },
    async start(id) { calls.push(id); if (id === 'gateway') throw new Error('restore failed'); },
  }), /stop failed/);
  assert.deepEqual(calls, ['gateway', 'admin']);
  assert.match(reports.join('\n'), /gateway 恢复失败/);
});

test('restart attempts remaining startups once after an optional service fails', async () => {
  const failure = new Error('worker launch failed');
  const calls: string[] = [];
  await assert.rejects(runServiceLifecycle({ action: 'restart', stopTargets: ['admin', 'worker'],
    startTargets: ['worker', 'admin'], report: () => undefined, stop: async () => undefined,
    async start(id) { calls.push(id); if (id === 'worker') throw failure; },
  }), error => error === failure);
  assert.deepEqual(calls, ['worker', 'admin']);
});

test('explicit stop never starts components after failure; explicit start never stops them', async () => {
  const calls: string[] = [];
  await assert.rejects(runServiceLifecycle({ action: 'stop', stopTargets: ['admin', 'worker'], startTargets: ['admin'],
    report: () => assert.fail('unexpected recovery'),
    async stop(id) { calls.push(`stop:${id}`); if (id === 'worker') throw new Error('stop failed'); },
    async start() { assert.fail('explicit stop must not start services'); },
  }), /stop failed/);
  await runServiceLifecycle({ action: 'start', stopTargets: ['admin'], startTargets: ['admin'],
    report: () => assert.fail('unexpected recovery'),
    async stop() { assert.fail('explicit start must not stop services'); },
    async start(id) { calls.push(`start:${id}`); },
  });
  assert.deepEqual(calls, ['stop:admin', 'stop:worker', 'start:admin']);
});

test('outer lifecycle timeout covers every component plus final account check', () => {
  assert.equal(serviceLifecycleTimeout(1, 1), 300_000);
  assert.equal(serviceLifecycleTimeout(4, 4), 490_000);
  assert.equal(serviceLifecycleTimeout(32, 32), 3_850_000);
});
