import assert from 'node:assert/strict';
import test from 'node:test';
import { createSqliteStore } from '../src/storage/sqlite.ts';
import { createNativeWorkAssets } from '../src/host/native-work-assets.ts';
import { createDshWorkPort } from '../src/adapters/dsh-work.ts';
test('legacy byte metadata remains readable but cannot be resent or silently converted', async t => {
  const store = createSqliteStore({ filename: ':memory:' }); t.after(() => store.close());
  const port = createDshWorkPort(async () => { throw new Error('No bytes'); });
  const registry = createNativeWorkAssets({ directory: '/unused', store, accountId: 'account', port,
    parent: () => ({ conversationId: 'private:123', generation: 1 }), authorize: async () => {} });
  t.after(() => registry.close());
  const asset = { type: 'media-reference' as const, kind: 'file' as const, attachmentId: 'old', name: 'old.txt', bytes: 14 };
  await assert.rejects(registry.register({ address: { issuerEpoch: 'epoch', id: 'work', childId: 'child', parentSessionId: 'parent', generation: 1 }, asset, signal: t.signal }),
    { code: 'WORK_BYTE_ATTACHMENTS_REMOVED' });
  await assert.rejects(registry.resolve({ assetId: `work-asset-${'a'.repeat(64)}`, type: 'file', conversationId: 'private:123', sessionId: 'parent', generation: 1, signal: t.signal }),
    { code: 'WORK_BYTE_ATTACHMENTS_REMOVED' });
});
