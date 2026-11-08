import assert from 'node:assert/strict';
import test from 'node:test';
import { createSqliteStore } from '../src/storage/sqlite.ts';
import { createNativeWorkDelivery } from '../src/host/native-work-delivery.ts';
import type { createBridgeHost } from '../src/host/bridge.ts';

test('confirmed outbox receipt survives cleanup failure and never triggers a second send', async t => {
  const store = createSqliteStore({ filename: ':memory:' }); t.after(() => store.close());
  const result = { id: 'work', resultId: 'result', deliveryId: 'delivery', childId: 'child', parentSessionId: 'parent',
    conversationId: 'private:123', generation: 1, stopReason: 'completed',
    output: [{ type: 'file' as const, assetId: `work-path-${'a'.repeat(64)}`, name: 'file' }] };
  store.write('native-work.executions', 'work', { deliveryId: 'delivery', resultId: 'result', delivery: 'delivering',
    ownerId: '123', parentSessionId: 'parent', conversationId: 'private:123', generation: 1 });
  let sends = 0; const faults: string[] = [];
  const receipt = { status: 'confirmed' as const, kind: 'file-upload' as const, fileId: 'fixture-file-id', name: 'file' };
  const host = { policy: { describe: () => ({ grants: [] }), grant() {}, reserve() { return {}; }, begin() {}, revoke() {} },
    sessions: { get: () => ({ sessionId: 'parent', generation: 1 }) }, outbox: { async send() { sends++; return receipt; } } } as unknown as ReturnType<typeof createBridgeHost>;
  const deliver = createNativeWorkDelivery({ host, store, persona: { id: 'fixture', version: '1' },
    guard: async () => {}, owner: () => '123', delivered: async () => { throw new Error('metadata write unavailable'); }, onCleanupFault: code => faults.push(code) });
  assert.deepEqual(await deliver(result, t.signal), receipt);
  assert.equal(sends, 1); assert.deepEqual(faults, ['WORK_PATH_CLEANUP_FAILED']);
  const deliveries = store.list('native-work.deliveries'); assert.equal(deliveries.length, 1);
  assert.equal((deliveries[0].value as { receipt: { status: string } }).receipt.status, 'confirmed');
});
