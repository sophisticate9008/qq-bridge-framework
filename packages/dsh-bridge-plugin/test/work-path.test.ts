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

test('DSH path registration persists scoped metadata, has no fixed TTL or byte quota', async t => {
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
  now += 30 * 86400000;
  assert.deepEqual(await restored.resolve(address, registered.id, t.signal), registered.descriptor);
  assert.equal((await first.register(address, path, t.signal)).id, registered.id);
  assert.equal(await restored.maintenance(), 1);
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
  const result = await tool.execute({ path, filename: 'named.txt' }, exec);
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

test('unsupported path transport fails explicitly and never saves bytes', async t => {
  let tool: ToolDefinition | undefined;
  const agent = { ctx: { tools: { register(value: ToolDefinition) { tool = value; return () => {}; } }, get(name: string) {
    if (name === 'workingDirectory') return { ensure: async () => '/controlled/workspace' };
    if (name === 'fs') return { lstat: async () => ({ type: 'file' }), resolve: async () => ({ displayPath: '/controlled/workspace/small.txt' }) };
    return undefined;
  } } } as unknown as Agent;
  installWorkAttachmentTool(agent, { assertLease() {}, pathRegistration: { enabled: () => false,
    async register(): Promise<never> { throw new Error('Not negotiated'); } }, commit() { throw new Error('No fallback'); } });
  assert(tool);
  await assert.rejects(Promise.resolve(tool.execute({ path: 'small.txt', kind: 'file' }, { agent, signal: t.signal } as Parameters<typeof tool.execute>[1])), /WORK_PATH_REQUIRED/);
});

test('remote raw HTTP stream delivers and hashes 100MiB with backpressure, consumes tickets and rejects deletion', async t => {
  const { createServer } = await import('node:http');
  const { createHash } = await import('node:crypto');
  const { createWorkStreamChannel } = await import('../dist/work-stream.js');
  const directory = await mkdtemp(join(tmpdir(), 'work-http-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'workspace'); await mkdir(root);
  const path = join(root, 'large.bin'); const handle = await open(path, 'wx');
  try { await handle.truncate(100 * 1024 * 1024); } finally { await handle.close(); }
  const registry = createWorkPathRegistry(join(directory, 'registry'), [root]);
  const registered = await registry.register(address, path, t.signal);
  const channel = createWorkStreamChannel();
  const server = createServer((req, res) => { void channel.handle(req, res); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const bound = server.address(); assert(bound && typeof bound === 'object');
  const base = `http://127.0.0.1:${bound.port}`;
  t.after(async () => { channel.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await registry.close(); });
  let verified = 0;
  const issue = () => channel.issue(registered.descriptor, signal => { verified++; return registry.resolve(address, registered.id, signal); }, registered.id);
  const stale = base + issue();
  const url = base + issue(); assert.equal(channel.pending(), 1);
  assert.equal((await fetch(stale)).status, 410);
  const response = await fetch(url); assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-length'), String(100 * 1024 * 1024));
  assert(response.body);
  await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(verified, 1, 'Paused consumer must apply backpressure before source is exhausted');
  const hash = createHash('sha256'); let size = 0;
  for await (const chunk of response.body) { size += chunk.byteLength; hash.update(chunk); }
  assert.equal(size, registered.descriptor.bytes); assert.equal(hash.digest('hex'), registered.descriptor.sha256);
  assert.equal((await fetch(url)).status, 410);
  assert.equal((await fetch(`${base}/qbf-work-stream/${'a'.repeat(64)}`)).status, 410);
  const interrupted = base + issue(); const reading = await fetch(interrupted); assert(reading.body);
  const reader = reading.body.getReader(); await reader.read(); await reader.cancel();
  for (let i = 0; i < 100 && channel.active(); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(channel.active(), 0); assert.equal((await fetch(interrupted)).status, 410);
  const owner = new AbortController();
  const ownerUrl = base + channel.issue(registered.descriptor, signal => registry.resolve(address, registered.id, signal), registered.id, owner.signal);
  owner.abort(); assert.equal(channel.pending(), 0); assert.equal((await fetch(ownerUrl)).status, 410);
  const cancelled = base + issue(); channel.revoke(registered.id); assert.equal(channel.pending(), 0);
  assert.equal((await fetch(cancelled)).status, 410);
  const corrupt = base + issue(); await writeFile(path, 'changed'); assert.equal((await fetch(corrupt)).status, 410);
  const changedScope = base + channel.issue(registered.descriptor, signal => registry.resolve({ ...address, generation: 2 }, registered.id, signal), registered.id);
  assert.equal((await fetch(changedScope)).status, 410);
  const deleted = base + issue(); await rm(path);
  const missing = await fetch(deleted); assert.equal(missing.status, 410); assert.match(await missing.text(), /文件已失效/);
});

test('account binding, explicit release and legacy TTL never revive a resource', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'work-scope-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'workspace'); await mkdir(root); const path = join(root, 'small'); await writeFile(path, 'small');
  const registry = createWorkPathRegistry(join(directory, 'registry'), [root]); t.after(() => registry.close());
  const owner = { ...address, accountId: 'account-one' };
  const registered = await registry.register(owner, path, t.signal);
  await assert.rejects(registry.resolve({ ...owner, accountId: 'account-two' }, registered.id, t.signal));
  await registry.revoke(owner, registered.id);
  await assert.rejects(registry.resolve(owner, registered.id, t.signal), /文件已失效/);
  assert.equal(await readFile(path, 'utf8'), 'small');
});

test('optional empty/null fields preserve path-only semantics and never require work context', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'work-optional-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'workspace'); await mkdir(root); const path = join(root, 'file'); await writeFile(path, 'small');
  const registry = createWorkPathRegistry(join(directory, 'registry'), [root]); t.after(() => registry.close());
  let tool: ToolDefinition | undefined; let committed = 0;
  const agent = { ctx: { tools: { register(value: ToolDefinition) { tool = value; return () => {}; } },
    get(name: string) { return name === 'fs' ? { lstat: async () => ({ type: 'file' }), resolve: async () => ({ displayPath: path }), processPath: () => path }
      : name === 'workingDirectory' ? { ensure: async () => root } : undefined; } } } as unknown as Agent;
  installWorkAttachmentTool(agent, { assertLease() {}, pathRegistration: { enabled: () => true, register: (target, signal) => registry.register(address, target, signal) },
    commit() { committed++; } }); assert(tool);
  for (const args of [{ path }, { path, kind: 'file' }, { path, filename: '', kind: 'file' }, { path, filename: null, kind: null }, { path, kind: '' }]) {
    const result = await tool.execute(args, { agent, signal: t.signal } as Parameters<typeof tool.execute>[1]);
    assert.equal((result as { registered: boolean }).registered, true);
  }
  assert.equal(committed, 5);
});
