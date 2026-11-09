import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAutomaticChatRecovery, observeChatRecovery, type RecoveryObservation } from '../src/admin/automatic-chat-recovery.ts';
import { CHAT_HEALTH_LAYERS, type ChatHealth } from '../src/contracts/chat-health.ts';
import { isRecord } from '../src/contracts/values.ts';

const readyStatus = { state: 'running', chatReady: true, canStart: false, missingReasons: [] };
const readyHealth: ChatHealth = { schema: 1, checkedAt: 1000, healthy: true, modelExecutionVerified: false,
  layers: CHAT_HEALTH_LAYERS.map(id => ({ id, state: 'ready', reason: null })) };

test('the watchdog repairs failed console health even when the assembled runtime still reports ready', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qbf-health-recovery-'));
  try {
    let at = 1000, calls = 0;
    let health: ChatHealth = { ...readyHealth, healthy: false,
      layers: readyHealth.layers.map(layer => layer.id === 'dsh' ? { ...layer, state: 'unavailable', reason: 'timeout' } : layer) };
    const recovery = createAutomaticChatRecovery({ directory, now: () => at,
      observe: async () => observeChatRecovery(readyStatus, health, true), repair: async () => { calls++; } });
    await recovery.tick(new AbortController().signal);
    at += 90_000;
    await recovery.tick(new AbortController().signal);
    assert.equal(calls, 1);
    health = readyHealth;
    await recovery.tick(new AbortController().signal);
    const snapshot = await recovery.routes[0].handle();
    assert(isRecord(snapshot) && Array.isArray(snapshot.attempts));
    assert.equal(snapshot.faultSince, null);
    assert.equal(snapshot.attempts.length, 1, 'healthy observations retain the hourly budget');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('lost DSH binding observations can recover but actual configuration, login and maintenance faults cannot', () => {
  const lost = { ...readyStatus, chatReady: false, missingReasons: ['dsh_live_verification_required', 'configuration_changed'],
    configurationImpact: { changedDependencies: ['bindings'] } };
  assert.equal(observeChatRecovery(lost, readyHealth, true).fault, true);
  assert.equal(observeChatRecovery({ ...lost, configurationImpact: { changedDependencies: ['bindings', 'provider'] } }, readyHealth, true).eligible, false);
  for (const reason of ['onebot_account_offline', 'persisted_configuration_unavailable', 'session_migration_reconciliation_required']) {
    assert.equal(observeChatRecovery({ ...readyStatus, chatReady: false, missingReasons: [reason] }, readyHealth, true).eligible, false);
  }
  for (const reason of ['http_account_offline', 'http_identity_mismatch', 'http_authentication_failed']) {
    const health: ChatHealth = { ...readyHealth, healthy: false,
      layers: readyHealth.layers.map(layer => layer.id === 'send' ? { ...layer, state: 'unavailable', reason } : layer) };
    assert.equal(observeChatRecovery(readyStatus, health, true).eligible, false);
  }
  for (const reason of ['http_timeout', 'http_connection_failed']) {
    const health: ChatHealth = { ...readyHealth, healthy: false,
      layers: readyHealth.layers.map(layer => layer.id === 'send' ? { ...layer, state: 'unavailable', reason } : layer) };
    assert.equal(observeChatRecovery(readyStatus, health, true).fault, true);
    assert.equal(observeChatRecovery(readyStatus, health, false).eligible, false);
  }
  const assistant = { id: 'assistant' as const, state: 'recovering' as const, reason: 'assistant_status_timeout' };
  assert.equal(observeChatRecovery(readyStatus, { ...readyHealth, healthy: false, assistant }, true).fault, false);
  assert.equal(observeChatRecovery(readyStatus, { ...readyHealth, healthy: false, assistant: { ...assistant, state: 'unavailable' } }, true).fault, true);
  assert.equal(observeChatRecovery(readyStatus, { ...readyHealth, healthy: false,
    assistant: { ...assistant, state: 'unavailable', reason: 'assistant_deployment_reconciliation_required' } }, true).eligible, false);
});

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
