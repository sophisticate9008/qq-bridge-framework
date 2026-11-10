import assert from 'node:assert/strict';
import test from 'node:test';
import { chatRepairNeedsDshRestart } from '../src/admin/chat-repair-dsh.ts';
import { CHAT_HEALTH_LAYERS, type ChatHealth, type ChatHealthLayer } from '../src/contracts/chat-health.ts';

function health(fault?: ChatHealthLayer): ChatHealth {
  return { schema: 1, checkedAt: Date.now(), healthy: !fault, modelExecutionVerified: false,
    layers: CHAT_HEALTH_LAYERS.map(id => fault?.id === id ? fault : { id, state: 'ready', reason: null }),
    ...(fault?.id === 'assistant' ? { assistant: fault } : {}) };
}
test('shared recovery restarts an unreachable engine or failed DSH channels but preserves healthy and protocol-only engines', () => {
  assert.equal(chatRepairNeedsDshRestart(health()), false);
  assert.equal(chatRepairNeedsDshRestart(null), false);
  for (const reason of ['connection_failed', 'timeout']) {
    assert.equal(chatRepairNeedsDshRestart(health({ id: 'dsh', state: 'unavailable', reason })), true);
  }
  for (const id of ['replies', 'tools', 'interactions'] as const) {
    assert.equal(chatRepairNeedsDshRestart(health({ id, state: 'recovering', reason: 'dsh_transport_unknown' })), true);
  }
  assert.equal(chatRepairNeedsDshRestart(health({ id: 'framework', state: 'unavailable', reason: 'pending_reload' })), true);
  assert.equal(chatRepairNeedsDshRestart(health({ id: 'framework', state: 'unavailable', reason: 'host_not_ready' })), false);
  assert.equal(chatRepairNeedsDshRestart(health({ id: 'send', state: 'unavailable', reason: 'http_account_offline' })), false);
});
test('bad credentials, incompatible components, changed settings and a briefly recovering assistant do not request engine restarts', () => {
  for (const reason of ['authentication_failed', 'credentials_unavailable', 'configuration_missing', 'invalid_response']) {
    const observed = health({ id: 'dsh', state: 'unavailable', reason });
    assert.equal(chatRepairNeedsDshRestart({ ...observed, layers: observed.layers.map(layer => layer.id === 'tools'
      ? { ...layer, state: 'unavailable', reason: 'dsh_transport_unknown' } : layer) }), false);
  }
  for (const state of ['recovering', 'unavailable'] as const) {
    assert.equal(chatRepairNeedsDshRestart(health({ id: 'assistant', state, reason: 'dsh_timeout' })), state === 'unavailable');
  }
  assert.equal(chatRepairNeedsDshRestart(health({ id: 'assistant', state: 'unavailable', reason: 'model_not_found' })), false);
  const changed = health({ id: 'tools', state: 'unavailable', reason: 'dsh_timeout' });
  assert.equal(chatRepairNeedsDshRestart({ ...changed, layers: changed.layers.map(layer => layer.id === 'framework'
    ? { ...layer, state: 'unknown', reason: 'configuration_changed' } : layer) }), false);
});
