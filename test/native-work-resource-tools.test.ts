import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inspectWorkPath } from '../packages/dsh-bridge-plugin/src/work-path.ts';
import { createSqliteStore } from '../src/storage/sqlite.ts';
import { createNativeWorkAssets } from '../src/host/native-work-assets.ts';
import { createNativeWorkEffects, NATIVE_WORK_TOOLS } from '../src/host/native-work-tools.ts';
import { createDshWorkPort } from '../src/adapters/dsh-work.ts';
import type { NativeMessageSourceReader } from '../src/host/native-message-sources.ts';
import type { EffectRequest } from '../src/core/types.ts';

test('registered chat resolver accepts only a resource ID and supplies real scope, releases channel and preserves unknown evidence', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'work-resolver-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'workspace'); await mkdir(root); const path = join(root, 'file'); await writeFile(path, 'small');
  const descriptor = await inspectWorkPath({ path, roots: [root], signal: t.signal });
  const store = createSqliteStore({ filename: ':memory:' }); t.after(() => store.close());
  const address = { issuerEpoch: 'epoch', id: 'work', parentSessionId: 'parent', childId: 'child', generation: 1 };
  const asset = { type: 'media-reference' as const, storage: 'path' as const, kind: 'file' as const,
    attachmentId: `work-path-ref-${'a'.repeat(64)}`, name: 'file', bytes: 5 };
  let remote = false; let released = false;
  const releases: unknown[] = [];
  const port = { ...createDshWorkPort(async () => { throw new Error('No byte RPC'); }),
    async readPath() { assert(!released); await inspectWorkPath({ path, roots: [root], expected: descriptor, signal: t.signal });
      return { asset, descriptor, ...(remote ? { file: `https://example.invalid/qbf-work-stream/${'b'.repeat(64)}` } : {}) }; },
    async releasePath(request: { keepRegistration?: boolean }) { releases.push(request); if (!request.keepRegistration) released = true; } };
  const resources = createNativeWorkAssets({ directory, store, port, accountId: 'account', parent: () => ({ conversationId: 'private:123', generation: 1 }), authorize: async () => {} });
  t.after(() => resources.close());
  const content = await resources.register({ address, asset, signal: t.signal }); assert('assetId' in content);
  const tool = NATIVE_WORK_TOOLS.find(t => t.definition.name === 'qbf_work_resolve'); assert(tool);
  assert.deepEqual(tool.definition.parameters.required, ['resourceId']);
  assert.throws(() => tool.validate({ resourceId: content.assetId, sessionId: 'borrowed' }));
  let sourceChecks = 0;
  const effects = createNativeWorkEffects({ executor: () => undefined, resources: () => resources,
    sources: () => ({ async lookup() { sourceChecks++; } }) as unknown as NativeMessageSourceReader });
  const request: EffectRequest = { scope: { conversationId: 'private:123', sessionId: 'parent', generation: 1, eventId: 'source', featureId: 'framework-tools', version: '1.0.0' },
    input: { resourceId: content.assetId }, signal: t.signal };
  const result = await effects['native.work.resolve'].execute(request);
  assert.deepEqual(result, { resourceId: content.assetId, assetId: content.assetId, channel: { kind: 'path', path } });
  assert.equal(sourceChecks, 1);
  await assert.rejects(async () => effects['native.work.resolve'].execute({ ...request, scope: { ...request.scope, conversationId: 'group:999' } }));
  remote = true; await effects['native.work.resolve'].execute(request);
  await resources.closeToolChannels({ conversationId: 'private:123', sessionId: 'parent', generation: 1 });
  assert.equal((releases.at(-1) as { keepRegistration: boolean }).keepRegistration, true);
  assert(store.read('native-work.paths', content.assetId), 'Unknown/unused result retains its scoped identity');
  await resources.delivered(content, t.signal);
  assert(released); assert.equal(store.list('native-work.paths').length, 0);
  await assert.rejects(async () => effects['native.work.resolve'].execute(request), /文件已失效/);
});

test('raw image ID is resolved from its registered type before final result and network/invalidated causes survive discovery', async t => {
  const { DshAdapterError } = await import('../src/adapters/dsh.ts');
  const directory = await mkdtemp(join(tmpdir(), 'work-image-resolver-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'image.png'); const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHd8AAAAASUVORK5CYII=', 'base64'); await writeFile(path, image);
  const descriptor = await inspectWorkPath({ path, roots: [directory], signal: t.signal });
  const store = createSqliteStore({ filename: ':memory:' }); t.after(() => store.close());
  store.write('native-work.executions', 'work', { parentSessionId: 'parent', childId: 'child', conversationId: 'private:123', generation: 1 });
  const asset = { type: 'media-reference' as const, storage: 'path' as const, kind: 'image' as const,
    attachmentId: `work-path-ref-${'e'.repeat(64)}`, bytes: image.length, name: 'image.png', mediaType: 'image/png' as const };
  let fault: string | null = null; let reads = 0;
  const port = { ...createDshWorkPort(async () => { throw new Error('Unexpected'); }),
    async readPath(request: { kind: 'file' | 'image' }) {
      reads++; if (fault) throw new DshAdapterError(fault, fault === 'WORK_PATH_INVALIDATED' ? '文件已失效' : 'Network unavailable');
      if (request.kind !== 'image') throw new DshAdapterError('WORK_PATH_NOT_THIS_WORK', 'Different kind');
      return { asset, descriptor };
    } };
  const resources = createNativeWorkAssets({ directory, store, port, accountId: 'account', authorize: async () => {}, parent: () => ({ conversationId: 'private:123', generation: 1 }) });
  t.after(() => resources.close());
  const scope = { conversationId: 'private:123', sessionId: 'parent', generation: 1, eventId: 'actual-source', featureId: 'framework-tools', version: '1.0.0' };
  const resolved = await resources.resolveResource(asset.attachmentId, scope, t.signal);
  assert.deepEqual(resolved.channel, { kind: 'path', path }); assert.equal(reads, 4);
  await assert.rejects(resources.resolveResource(asset.attachmentId, { ...scope, conversationId: 'group:999' }, t.signal), { code: 'WORK_ASSET_SCOPE_MISMATCH' });
  for (const code of ['DSH_TIMEOUT', 'WORK_PATH_INVALIDATED']) {
    store.delete('native-work.paths', resolved.assetId); fault = code; reads = 0;
    await assert.rejects(resources.resolveResource(asset.attachmentId, scope, t.signal), { code }); assert.equal(reads, 1);
  }
});
