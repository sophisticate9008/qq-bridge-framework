import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, open, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const component = process.env.QBF_WORK_PLATFORM_PACKAGE ?? resolve(import.meta.dirname, '..');
const load = (name: string): Promise<unknown> => import(pathToFileURL(join(component, 'dist', `${name}.js`)).href);
const registryModule = await load('work-path-registry') as typeof import('../dist/work-path-registry.js');
const security = await load('file-security') as typeof import('../dist/file-security.js');
const journalModule = await load('work-journal') as typeof import('../dist/work-journal.js');
const address = { issuerEpoch: 'epoch', accountId: 'account', id: 'work', parentSessionId: 'parent', childId: 'child', generation: 1 };

test(`packaged path signer uses native ${process.platform}/${process.arch} private storage, full 100MiB hash and scope`, async t => {
  const directory = await mkdtemp(join(tmpdir(), '工作 附件-platform-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'workspace'); await mkdir(root);
  const path = join(root, '大型 文件.bin'); const file = await open(path, 'wx'); try { await file.truncate(104857600); } finally { await file.close(); }
  const store = join(directory, 'registry'); const registry = registryModule.createWorkPathRegistry(store, [root]); t.after(() => registry.close());
  const signed = await registry.register(address, path, t.signal);
  assert.equal(signed.descriptor.bytes, 104857600);
  assert.equal(signed.descriptor.sha256, '20492a4d0d84f8beb1767f6616229f85d44c2827b64bdbfb260ee12fa1109e0e');
  assert.equal(signed.descriptor.expiresAt, null);
  const restored = registryModule.createWorkPathRegistry(store, [root]); t.after(() => restored.close());
  assert.equal((await restored.resolve(address, signed.id, t.signal)).sha256, signed.descriptor.sha256);
  await assert.rejects(restored.resolve({ ...address, accountId: 'other' }, signed.id, t.signal));
  await assert.rejects(restored.resolve({ ...address, parentSessionId: 'other' }, signed.id, t.signal));
  const outside = join(directory, 'outside'); await mkdir(outside); await writeFile(join(outside, 'private'), 'outside');
  const link = join(root, 'escape'); await symlink(outside, link, 'junction');
  await assert.rejects(registry.register(address, join(link, 'private'), t.signal));
  if (process.platform === 'win32') {
    const metadata = join(store, signed.id);
    await promisify(execFile)('icacls.exe', [metadata, '/grant', '*S-1-1-0:(R)']);
    await assert.rejects(restored.resolve(address, signed.id, t.signal), /STORAGE_UNSAFE/);
    await security.secureNewPath(metadata, 0o600);
  }
  const writer = await open(path, 'r+'); try { await writer.write(Buffer.from('changed'), 0, 7, 104857500); } finally { await writer.close(); }
  await assert.rejects(restored.resolve(address, signed.id, t.signal), /文件已失效/);
  await unlink(path); await assert.rejects(restored.resolve(address, signed.id, t.signal), /文件已失效/);
  await restored.revoke(address, signed.id); assert.equal((await readdir(store)).length, 0);
});

test('packaged work journal reserves, atomically updates and reopens native private records', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'work-journal-platform-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const journal = journalModule.createWorkJournal(join(directory, 'journal'));
  const request = { ...address, modelProvider: 'fixture', model: 'fixture', agentPreset: 'fixture', task: 'platform', context: '', timeoutMs: null };
  const record = { schema: 1 as const, fingerprint: journalModule.workFingerprint(request), address: { id: address.id,
    parentSessionId: address.parentSessionId, childId: address.childId, generation: address.generation },
    target: { accountId: address.accountId, modelProvider: 'fixture', model: 'fixture', agentPreset: 'fixture', timeoutMs: null },
    state: 'running' as const, result: null, error: null, attachments: [], acceptedMessageId: null, followupRequestId: null };
  await journal.reserve(record);
  await journal.write({ ...record, state: 'completed', result: { stopReason: 'completed', output: [{ type: 'text', text: 'done' }] } });
  assert.equal((await journalModule.createWorkJournal(join(directory, 'journal')).read(address.id))?.state, 'completed');
  const manifest = JSON.parse(await readFile(join(component, 'package.json'), 'utf8')) as { version: string };
  const current = JSON.parse(await readFile(resolve(import.meta.dirname, '../package.json'), 'utf8')) as { version: string };
  assert.equal(manifest.version, current.version);
});
