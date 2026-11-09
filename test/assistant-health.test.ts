import assert from 'node:assert/strict';
import test from 'node:test';
import { createAssistantHealthConfirmation } from '../src/admin/assistant-health.ts';
import type { ChatHealthLayer } from '../src/contracts/chat-health.ts';

test('assistant transport checks require repeated failures over fifteen seconds and reset on success or configuration change', () => {
  let at = 1000;
  const confirm = createAssistantHealthConfirmation(() => at);
  const failed: ChatHealthLayer = { id: 'assistant', state: 'unknown', reason: 'assistant_status_timeout' };
  assert.equal(confirm('original', failed).state, 'recovering');
  at += 14_999;
  assert.equal(confirm('original', failed).state, 'recovering');
  at++;
  assert.equal(confirm('original', failed).state, 'unavailable');
  assert.equal(confirm('changed', failed).state, 'recovering');
  at += 20_000;
  assert.equal(confirm('changed', { id: 'assistant', state: 'ready', reason: null }).state, 'ready');
  assert.equal(confirm('changed', failed).state, 'recovering');
  at -= 40_000;
  assert.equal(confirm('changed', failed).state, 'recovering', 'clock rollback starts a fresh confirmation');
});

test('assistant configuration faults remain visible immediately and maintenance is never a restart signal', () => {
  let at = 1000;
  const confirm = createAssistantHealthConfirmation(() => at);
  for (const reason of ['assistant_deployment_not_applied', 'assistant_deployment_configuration_changed',
    'assistant_deployment_reconciliation_required', 'assistant_reasoning_unsupported']) {
    assert.equal(confirm('same', { id: 'assistant', state: 'unavailable', reason }).state, 'unavailable');
  }
  for (let i = 0; i < 3; i++) {
    at += 20_000;
    assert.equal(confirm('same', { id: 'assistant', state: 'unavailable', reason: 'assistant_deployment_busy' }).state, 'recovering');
  }
});

test('temporarily missing loaded presets are rechecked while an unresolved deployment remains explicit', () => {
  let at = 1000;
  const confirm = createAssistantHealthConfirmation(() => at);
  const layer: ChatHealthLayer = { id: 'assistant', state: 'unavailable', reason: 'pending_reload' };
  assert.equal(confirm('same', layer).state, 'recovering');
  at += 15_000;
  assert.equal(confirm('same', layer).state, 'unavailable');
  assert.equal(confirm('same', { ...layer, reason: 'assistant_deployment_reconciliation_required' }).state, 'unavailable');
});
