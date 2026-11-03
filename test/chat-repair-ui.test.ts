import assert from 'node:assert/strict';
import test from 'node:test';
import type { ApiClient } from '../web/lib/api.ts';
import { chatRepairPending, chatRepairStore } from '../web/lib/chat-repair.ts';
import { chatApplicationStore } from '../web/lib/chat-application.ts';
import { dshRestartStore } from '../web/lib/dsh-restart.ts';
import type { ChatRepairOperation } from '../src/contracts/chat-repair.ts';
import type { NativeApplicationSnapshot } from '../src/contracts/native-application.ts';

const first = '11111111-1111-4111-8111-111111111111';
const second = '22222222-2222-4222-8222-222222222222';
const client = (): ApiClient => ({ async get() { throw new Error('No read expected'); }, async post() { throw new Error('No write expected'); } });
const repair = (id: string, state: ChatRepairOperation['state']): ChatRepairOperation => ({ id, state, phase: 'verifying', createdAt: 10, updatedAt: 20, reasons: [] });
const application = (): NativeApplicationSnapshot => ({ schema: 1, id: first, state: 'completed', phase: 'start', phaseState: 'confirmed',
  revisions: { plans: 'a'.repeat(64), personas: 'a'.repeat(64), access: 'a'.repeat(64), adapters: 'a'.repeat(64), providers: 'a'.repeat(64),
    authorization: 'a'.repeat(64), deployment: 'a'.repeat(64), execution: 'a'.repeat(64) }, createdAt: 11, updatedAt: 19, reasons: [] });

test('accepting an existing repair that just completed transfers the watched ID and can settle', () => {
  const store = chatRepairStore(client());
  store.observe({ schema: 1, available: true, operation: null });
  assert.equal(store.begin(first), true);
  assert.equal(store.observe({ schema: 1, available: true, operation: repair(second, 'completed'), applicationId: first }, true), true);
  store.finish();
  assert.equal(store.getSnapshot().watchingId, second);
  assert.equal(store.beginSettlement(second), true);
  store.finishSettlement(second, true);
  assert.equal(chatRepairPending(store.getSnapshot()), false);
});

test('historical repair success cannot settle new local locks without a watched running repair', () => {
  const store = chatRepairStore(client());
  store.observe({ schema: 1, available: true, operation: repair(first, 'completed'), applicationId: second });
  assert.equal(store.beginSettlement(first), false);
  assert.equal(chatRepairPending(store.getSnapshot()), false);
});

test('failed watched repair followed by unrelated historical completion leaves recovery usable', () => {
  const store = chatRepairStore(client());
  store.observe({ schema: 1, available: true, operation: repair(first, 'running') });
  store.observe({ schema: 1, available: true, operation: repair(first, 'failed') });
  store.observe({ schema: 1, available: true, operation: repair(second, 'completed') });
  assert.equal(chatRepairPending(store.getSnapshot()), false);
  assert.equal(store.begin(first), true);
});

test('repair completion cannot clear management operations claimed after its ownership boundary', () => {
  const api = client();
  const app = chatApplicationStore(api);
  const maintenance = dshRestartStore(api);
  const appBoundary = app.getOwnershipGeneration();
  const dshBoundary = maintenance.getOwnershipGeneration();
  const token = app.claim();
  assert.equal(maintenance.begin(), true);
  assert.equal(app.acceptChatRepair(application(), appBoundary), false);
  assert.equal(maintenance.acceptChatRepair({ schema: 1, available: true, missingReasons: [], operation: null }, dshBoundary), false);
  assert.equal(app.owns(token), true);
  assert.equal(maintenance.getSnapshot().requestActive, true);
});
