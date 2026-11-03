import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_CHAT_INPUT_CONFIGURATION } from '../src/contracts/chat-input-configuration.ts';
import { chatInputConfiguration, chatInputForm, parseChatInputSnapshot, parseGroupWakeProbabilityPercent, parseUnreadRetentionMinutes } from '../web/lib/chat-input-ui.ts';

test('trigger form preserves domain defaults and converts seconds without broadening conversation scopes', () => {
  const form = chatInputForm(DEFAULT_CHAT_INPUT_CONFIGURATION);
  assert.deepEqual(chatInputConfiguration(form), DEFAULT_CHAT_INPUT_CONFIGURATION);
  const parsed = chatInputConfiguration({ ...form, nicknames: '鲸鲸\n小鲸鱼', continuationSeconds: '0.001', include: 'group:123', exclude: 'private:456' });
  assert.equal(parsed?.continuationMs, 1); assert.deepEqual(parsed?.scopes.include, ['group:123']); assert.deepEqual(parsed?.scopes.exclude, ['private:456']);
  for (const probability of ['0', '0.001', '0.5', '1', '99.9', '100']) {
    assert.equal(chatInputConfiguration({ ...form, groupWakeProbabilityPercent: probability })?.groupWakeProbabilityPercent, Number(probability));
  }
  for (const patch of [{ continuationSeconds: '301' }, { continuationSeconds: '1e2' }, { nicknames: 'Name\nname' }, { include: '123' },
    { groupWakeProbabilityPercent: '101' }, { groupWakeProbabilityPercent: '-0.5' }, { groupWakeProbabilityPercent: '' }]) {
    assert.equal(chatInputConfiguration({ ...form, ...patch }), null);
  }
});

test('unread minutes default for older forms and preserve custom millisecond values on unrelated saves', () => {
  const form = chatInputForm(DEFAULT_CHAT_INPUT_CONFIGURATION);
  assert.equal(form.unreadRetentionMinutes, '15');
  const { unreadRetentionMinutes: _removed, ...legacy } = form;
  assert.equal(chatInputConfiguration(legacy)?.unreadRetentionMs, 900_000);
  for (const milliseconds of [60_000, 60_001, 90_000, 900_000, 86_399_999, 86_400_000]) {
    const custom = chatInputForm({ ...DEFAULT_CHAT_INPUT_CONFIGURATION, unreadRetentionMs: milliseconds });
    assert.equal(chatInputConfiguration({ ...custom, nicknames: 'New name' })?.unreadRetentionMs, milliseconds);
  }
  assert.equal(parseUnreadRetentionMinutes('1.5'), 90_000);
  for (const value of ['', ' ', '0', '0.999999', '1440.001', '-1', '1e2', 'NaN', 'Infinity', '0x10', '15分钟']) {
    assert.equal(parseUnreadRetentionMinutes(value), null);
    assert.equal(chatInputConfiguration({ ...form, unreadRetentionMinutes: value }), null);
  }
});

test('group wake percentage accepts fractional input without converting it to a ratio', () => {
  assert.equal(parseGroupWakeProbabilityPercent('0.5'), 0.5);
  assert.equal(parseGroupWakeProbabilityPercent('.5'), 0.5);
  for (const value of ['', ' ', '-0.5', '100.01', 'NaN', 'Infinity', '0x10', '0.5%']) {
    assert.equal(parseGroupWakeProbabilityPercent(value), null);
  }
});

test('trigger snapshot decoder requires the installed package identity, CAS and declared live application contract', () => {
  const value = { schema: 1, id: 'chat-input', revision: 'a'.repeat(64), schemaVersion: 1, source: 'default', application: 'live', configuration: DEFAULT_CHAT_INPUT_CONFIGURATION };
  assert.deepEqual(parseChatInputSnapshot(value), value);
  for (const patch of [{ id: 'unknown-package' }, { revision: 'latest' }, { application: 'restart' }, { configuration: { ...DEFAULT_CHAT_INPUT_CONFIGURATION, enabled: 'true' } }]) assert.equal(parseChatInputSnapshot({ ...value, ...patch }), null);
});
