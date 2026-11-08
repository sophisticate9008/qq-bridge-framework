import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, open, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkPathRegistry } from '../dist/work-path-registry.js';
import { createWorkChannel, type WorkStart } from '../dist/work.js';
import { createWorkJournal } from '../dist/work-journal.js';
import { installWorkAttachmentTool } from '../dist/work-attachments.js';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { SubagentRuntime } from '@deepseek-ai/dsh-subagent';

const address = { issuerEpoch: 'epoch', id: 'work', parentSessionId: 'parent', childId: 'child', generation: 1 };

test('DSH path registration persists scoped metadata, expires and cleans only registrations with separate capacity', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-work-path-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'workspace'); await mkdir(root);
  const path = join(root, 'large.bin'); const handle = await open(path, 'wx', 0o600);
  try { await handle.truncate(100 * 1024 * 1024); } finally { await handle.close(); }
  let now = Date.now(); const store = join(directory, 'registry');
  const first = createWorkPathRegistry(store, [root], () => now);
  const registered = await first.register(address, path, t.signal);
  assert.equal(registered.descriptor.bytes, 100 * 1024 * 1024);
  const restored = createWorkPathRegistry(store, [root], () => now);
  assert.deepEqual(await restored.resolve({ ...address, issuerEpoch: 'restarted' }, registered.id, t.signal), registered.descriptor);
  for (const wrong of [{ id: 'other' }, { childId: 'other' }, { parentSessionId: 'other' }, { generation: 2 }])
    await assert.rejects(restored.resolve({ ...address, ...wrong }, registered.id, t.signal));
  const outside = join(directory, 'outside'); await writeFile(outside, 'private');
  await assert.rejects(first.register(address, outside, t.signal));
  const link = join(root, 'escape'); await symlink(outside, link);
  await assert.rejects(first.register(address, link, t.signal));
  // Fill metadata slots without creating or copying a large source file.
  const raw: unknown = JSON.parse(await readFile(join(store, registered.id), 'utf8'));
  assert(raw && typeof raw === 'object');
  const text = JSON.stringify({ ...raw, scope: 'another-work-scope' });
  for (let index = 1; index < 512; index++) await writeFile(join(store, `work-path-ref-${index.toString(16).padStart(64, '0')}`), text, { mode: 0o600 });
  assert.equal((await first.register(address, path, t.signal)).id, registered.id);
  await assert.rejects(first.register({ ...address, id: 'another' }, path, t.signal), /CAPACITY/);
  now += 86400001; await assert.rejects(restored.resolve(address, registered.id, t.signal));
  assert.equal(await restored.maintenance(), 0); assert.deepEqual(await readdir(store), []);
  const fresh = await restored.register(address, path, t.signal); assert.notEqual(fresh.id, registered.id);
  await assert.rejects(restored.resolve(address, registered.id, t.signal));
  const retained = await open(path, 'r'); try { assert.equal((await retained.stat()).size, 100 * 1024 * 1024); } finally { await retained.close(); }
});

test('attachment tool defaults even small files to paths and security denial never invokes byte fallback', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-work-tool-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'workspace'); await mkdir(root); const path = join(root, 'small.txt'); await writeFile(path, 'small');
  const registry = createWorkPathRegistry(join(directory, 'registry'), [root]);
  let tool: ToolDefinition | undefined; let commits = 0; let byteReads = 0;
  const fs = { async lstat() { return { type: 'file' }; }, async resolve() { return { displayPath: path }; }, processPath: () => path,
    async readBytes() { byteReads++; throw new Error('Unexpected bytes'); } };
  const agent = { ctx: { tools: { register(value: ToolDefinition) { tool = value; return () => {}; } },
    get(name: string) { return name === 'fs' ? fs : name === 'workingDirectory' ? { ensure: async () => root } : name === 'attachments' ? {} : undefined; } } } as unknown as Agent;
  let deny = false;
  installWorkAttachmentTool(agent, { assertLease() {}, pathRegistration: { enabled: () => true,
    async register(target, signal) { if (deny) throw new TypeError('UNSAFE'); return registry.register(address, target, signal); } },
    commit(asset) { assert.equal(asset.storage, 'path'); commits++; } });
  assert(tool);
  const exec = { agent, signal: t.signal } as Parameters<typeof tool.execute>[1];
  const result = await tool.execute({ path, kind: 'file' }, exec);
  assert.equal((result as { storage: string }).storage, 'path'); assert.equal(commits, 1); assert.equal(byteReads, 0);
  deny = true; await assert.rejects(Promise.resolve(tool.execute({ path, kind: 'file' }, exec)), /UNSAFE/);
  assert.equal(commits, 1); assert.equal(byteReads, 0);
});

test('work journal recovery retains opaque path references and read RPC rejects another work and byte downgrade', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-work-recovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'workspace'); await mkdir(root); const path = join(root, 'file'); await writeFile(path, 'content');
  const registry = createWorkPathRegistry(join(directory, 'paths'), [root]);
  const journal = createWorkJournal(join(directory, 'journal'));
  const parent = { session: { id: 'parent' } } as unknown as Agent;
  let finish!: (value: { stopReason: string; output: [] }) => void;
  const result = new Promise<{ stopReason: string; output: [] }>(resolve => { finish = resolve; });
  const runtime = { getProvider: () => ({ prepareContinuable() {}, inheritsParentContext: false, capabilities: { agentOptions: true, agentPreset: true } }),
    async startActivation() { return { childId: 'child', result, async dispose() {} }; } } as unknown as SubagentRuntime;
  const options = { issuerEpoch: 'epoch', journal, getAgent: (id: string) => id === 'parent' ? parent : undefined,
    runtime: () => runtime, hasPreset: async () => true, continuationAvailable: () => true,
    readPath: (a: typeof address, asset: { attachmentId: string }, signal: AbortSignal) => registry.resolve(a, asset.attachmentId, signal),
    readAsset: async () => { throw new Error('No byte downgrade'); } };
  const channel = createWorkChannel(options);
  const start: WorkStart = { ...address, modelProvider: 'p', model: 'm', agentPreset: 'a', task: 'task', context: '', timeoutMs: null, attachmentTransport: 'path-v1' };
  await channel.start(start, t.signal);
  const registered = await registry.register(address, path, t.signal);
  const asset = { type: 'media-reference' as const, storage: 'path' as const, kind: 'file' as const,
    attachmentId: registered.id, bytes: 7, name: 'file' };
  await channel.registerAttachment('child', asset); finish({ stopReason: 'completed', output: [] });
  await new Promise(resolve => setImmediate(resolve)); await channel.inspect(address); await channel.close();
  const restored = createWorkChannel({ ...options, issuerEpoch: 'new-epoch' });
  t.after(() => restored.close());
  const request = { ...address, issuerEpoch: 'new-epoch', kind: 'file' as const, attachmentId: registered.id };
  assert.equal((await restored.readPath(request, t.signal)).descriptor.path, path);
  await assert.rejects(restored.readPath({ ...request, childId: 'wrong' }, t.signal));
  await assert.rejects(restored.readAsset({ ...request, offset: 0, limit: 100 }, t.signal));
});

test('explicit unsupported path transport retains the original small-file byte attachment tool', async t => {
  let tool: ToolDefinition | undefined; let saved = 0;
  const data = Buffer.from('byte compatibility');
  const agent = { ctx: { tools: { register(value: ToolDefinition) { tool = value; return () => {}; } }, get(name: string) {
    if (name === 'workingDirectory') return { ensure: async () => '/controlled/workspace' };
    if (name === 'fs') return { lstat: async () => ({ type: 'file' }), resolve: async () => ({ displayPath: '/controlled/workspace/small.txt' }),
      stat: async () => ({ type: 'file', size: data.length, version: 'same' }), readBytes: async () => data };
    if (name === 'attachments') return { async saveFile() { saved++; return { attachmentId: 'sdk-file', bytes: data.length, name: 'small.txt' }; } };
    return undefined;
  } } } as unknown as Agent;
  installWorkAttachmentTool(agent, { assertLease() {}, pathRegistration: { enabled: () => false,
    async register(): Promise<never> { throw new Error('Path transport was not negotiated'); } },
    commit(asset) { assert.equal(asset.storage, undefined); assert.equal(asset.attachmentId, 'sdk-file'); } });
  assert(tool);
  await tool.execute({ path: 'small.txt', kind: 'file' }, { agent, signal: t.signal } as Parameters<typeof tool.execute>[1]);
  assert.equal(saved, 1);
});
