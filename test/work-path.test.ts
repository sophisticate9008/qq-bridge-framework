import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, open, readFile, rename, rm, stat, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectWorkPath, validWorkPath } from '../src/storage/work-path.ts';
import { createNativeWorkAssets } from '../src/host/native-work-assets.ts';
import { createSqliteStore } from '../src/storage/sqlite.ts';
import { createDshWorkPort } from '../src/adapters/dsh-work.ts';
import { isDshWorkOutput, type DshWorkMediaReference } from '../src/contracts/dsh-work.ts';

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'qbf-work-path-'));
  const root = join(directory, 'workspace'); await mkdir(root);
  const signal = t.signal;
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, root, signal };
}

test('path verification streams 100MiB, rejects mutations including restored mtime, escape, symlink and parent replacement', async t => {
  const { root, directory, signal } = await fixture(t);
  const sub = join(root, 'task'); await mkdir(sub);
  const path = join(sub, 'large.bin');
  const handle = await open(path, 'wx', 0o600);
  try { await handle.truncate(100 * 1024 * 1024); } finally { await handle.close(); }
  const registered = await inspectWorkPath({ path, roots: [root], signal });
  assert.equal(registered.bytes, 100 * 1024 * 1024); assert(validWorkPath(registered));
  assert.deepEqual(await inspectWorkPath({ path, roots: [root], expected: registered, signal }), registered);
  const old = await stat(path); const writer = await open(path, 'r+');
  try { await writer.write(Buffer.from('changed'), 0, 7, 1000); } finally { await writer.close(); }
  await utimes(path, old.atime, old.mtime);
  await assert.rejects(inspectWorkPath({ path, roots: [root], expected: registered, signal }));
  const outside = join(directory, 'outside'); await writeFile(outside, 'secret');
  await assert.rejects(inspectWorkPath({ path: outside, roots: [root], signal }));
  const link = join(root, 'link'); await symlink(outside, link);
  await assert.rejects(inspectWorkPath({ path: link, roots: [root], signal }));
  const ordinary = join(sub, 'report'); await writeFile(ordinary, 'result');
  const before = await inspectWorkPath({ path: ordinary, roots: [root], signal });
  await rename(sub, `${sub}-old`); await mkdir(sub); await rename(join(`${sub}-old`, 'report'), ordinary);
  await assert.rejects(inspectWorkPath({ path: ordinary, roots: [root], expected: before, signal }));
  await rm(sub, { recursive: true }); await symlink(`${sub}-old`, sub);
  await assert.rejects(inspectWorkPath({ path, roots: [root], signal }));
  for (const unsafe of ['/', '/root']) await assert.rejects(inspectWorkPath({ path, roots: [unsafe], signal }));
});

test('host path resources survive restart, isolate scope and TTL, avoid byte quota and never remove original files', async t => {
  const { root, directory, signal } = await fixture(t);
  const path = join(root, 'report.bin'); await writeFile(path, 'original result');
  let now = Date.now();
  const descriptor = await inspectWorkPath({ path, roots: [root], signal, now });
  const asset: DshWorkMediaReference = { type: 'media-reference', storage: 'path', kind: 'file',
    attachmentId: `work-path-ref-${'a'.repeat(64)}`, bytes: descriptor.bytes, name: 'report.bin' };
  const store = createSqliteStore({ filename: join(directory, 'state.sqlite'), clock: () => now });
  let generation = 1; let allowed = true; let reads = 0;
  const port = createDshWorkPort(async () => { throw new Error('unexpected byte RPC'); });
  const options = { directory, store, accountId: 'account', port: { ...port,
    async readPath() { reads++; return { asset, descriptor }; },
    async readAsset(): Promise<never> { throw new Error('unexpected byte copy'); } }, clock: () => now,
    parent: () => ({ conversationId: 'private:123', generation }), authorize: async () => { assert(allowed); } };
  const address = { issuerEpoch: 'epoch', id: 'work', childId: 'child', parentSessionId: 'parent', generation: 1 };
  const first = createNativeWorkAssets(options);
  const content = await first.register({ address, asset, signal }); assert('assetId' in content);
  assert.match(content.assetId, /^work-path-/); await first.close();
  const registry = createNativeWorkAssets(options);
  t.after(async () => { await registry.close(); store.close(); });
  const request = { assetId: content.assetId, type: 'file' as const, conversationId: 'private:123', sessionId: 'parent', generation: 1, signal };
  assert.deepEqual(await registry.resolve(request), { file: path });
  assert.equal(store.list('native-work.assets').length, 0);
  assert.equal(reads, 1);
  await assert.rejects(registry.resolve({ ...request, conversationId: 'group:123' }));
  await assert.rejects(registry.resolve({ ...request, sessionId: 'another' }));
  const other = createNativeWorkAssets({ ...options, accountId: 'other' });
  try { await assert.rejects(other.resolve(request)); } finally { await other.close(); }
  generation = 2; await assert.rejects(registry.resolve(request)); generation = 1;
  allowed = false; await assert.rejects(registry.resolve(request)); allowed = true;
  await unlink(path); await symlink(join(directory, 'outside'), path);
  await assert.rejects(registry.resolve(request));
  await unlink(path); await writeFile(path, 'original result');
  now += 86400001; await registry.maintenance();
  await assert.rejects(registry.resolve(request));
  assert.equal(await readFile(path, 'utf8'), 'original result');
  assert.equal(store.list('native-work.paths').length, 0);
});

test('path reference bounds preserve the byte limit and explicit transport negotiation', async () => {
  const signal = new AbortController().signal;
  const address = { issuerEpoch: 'epoch', id: 'work', parentSessionId: 'parent', childId: 'child', generation: 1 };
  const asset = { type: 'media-reference', kind: 'file', storage: 'path', attachmentId: `work-path-ref-${'a'.repeat(64)}`, bytes: 100 * 1024 * 1024, name: 'large.bin' };
  assert(isDshWorkOutput(asset)); assert(!isDshWorkOutput({ ...asset, storage: undefined }));
  assert(!isDshWorkOutput({ ...asset, storage: 'bytes' }));
  for (const sharedFilesystem of [false, true]) {
    let supported = false; let started: unknown;
    const port = createDshWorkPort(async (method, request) => {
      if (method === 'bridgePlugin/verifyWork') return { schema: 1, issuerEpoch: 'epoch', available: true, provider: 'spawn', continuable: true,
        externalToolAuthorizationVerified: false, pathAttachmentsSupported: supported };
      started = request; return { ...address, schema: 1, state: 'running', result: null, error: null };
    }, { sharedFilesystem });
    const target = { issuerEpoch: 'epoch', parentSessionId: 'parent', modelProvider: 'p', model: 'm', agentPreset: 'a' };
    const start = { ...address, ...target, task: 'task', context: '', timeoutMs: null };
    await port.verify(target, signal); await port.start(start, signal);
    assert.equal((started as Record<string, unknown>).attachmentTransport, undefined);
    supported = true; await port.verify(target, signal); await port.start(start, signal);
    assert.equal((started as Record<string, unknown>).attachmentTransport, sharedFilesystem ? 'path-v1' : undefined);
  }
});


test('independently packaged DSH and host use the same path integrity rules', async () => {
  assert.equal(await readFile(new URL('../src/storage/work-path.ts', import.meta.url), 'utf8'),
    await readFile(new URL('../packages/dsh-bridge-plugin/src/work-path.ts', import.meta.url), 'utf8'));
});
