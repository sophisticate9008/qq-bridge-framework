import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { probeDshHealth } from '../src/adapters/dsh-health.ts';
import { createNativeDshHealthRoutes } from '../src/admin/native-dsh-health.ts';
import { parseDshHealth } from '../src/contracts/dsh-health.ts';
import { dshHealthLabel } from '../web/lib/dsh-health.ts';
import { serviceArguments } from '../scripts/cli.ts';
import { readNativeRuntimeLease } from '../src/host/native-runtime-lease.ts';

test('DSH health verifies only its authenticated API and never starts chat or invokes a model', async t => {
  const methods: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, options?: RequestInit) => {
    const url = new URL(String(input));
    methods.push(url.pathname);
    if (url.pathname === '/connect') return new Response(null, { status: 302,
      headers: { location: '/api/remote.mux', 'set-cookie': 'test=session; HttpOnly' } });
    assert.equal(url.pathname, '/api/settings/describe');
    const body = JSON.parse(String(options?.body)) as { rpcId: string };
    return Response.json({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: {} } });
  });
  const result = await probeDshHealth({ enabled: true, endpoint: 'https://dsh.example.test', auth: 'synthetic' }, new AbortController().signal);
  assert.equal(result.state, 'ready'); assert.equal(result.modelExecutionVerified, false);
  assert.equal(dshHealthLabel(result), '服务可连接');
  assert.deepEqual(methods, ['/connect', '/api/settings/describe']);
  assert.equal(dshHealthLabel(result, true), '读取失败');
});

test('transport errors, disabled connections and missing credentials have distinct health states', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('sensitive remote details'); });
  const adapter = { enabled: true, endpoint: 'https://dsh.example.test', auth: 'synthetic' };
  const signal = new AbortController().signal;
  const failed = await probeDshHealth(adapter, signal);
  assert.equal(failed.state, 'unavailable'); assert.equal(failed.reason, 'connection_failed');
  assert.equal((await probeDshHealth({ ...adapter, enabled: false }, signal)).state, 'disabled');
  assert.equal((await probeDshHealth({ ...adapter, auth: '' }, signal)).state, 'unconfigured');
  assert.doesNotMatch(JSON.stringify(failed), /sensitive|synthetic/);
  assert(parseDshHealth(failed));
  assert.equal(parseDshHealth({ ...failed, state: 'ready' }), null);
});

test('DSH health routes can read a disabled connection without assembling a chat runtime', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'qbf-health-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const route = createNativeDshHealthRoutes(directory)[0]!;
  const result = await route.handle({ query: new URLSearchParams(), signal: new AbortController().signal, body: null });
  assert.equal(parseDshHealth(result)?.state, 'disabled');
});

test('one CLI separates foreground launch from explicit managed services and maintenance shortcuts', () => {
  assert.deepEqual(serviceArguments(['service', 'start']), ['start']);
  assert.deepEqual(serviceArguments(['restart', 'dsh']), ['restart', 'dsh']);
  assert.deepEqual(serviceArguments(['service', 'status', '--json']), ['status', '--json']);
  assert.equal(serviceArguments(['start']), null);
  assert.equal(serviceArguments(['doctor', '--conversation', 'group:123']), null);
});

test('an existing runtime lease is reported as blocked and is never removed by health reads', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'qbf-lease-health-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal((await readNativeRuntimeLease(directory, false)).state, 'available');
  await writeFile(join(directory, '.native-chat-runtime.lock'), '', { mode: 0o600 });
  assert.equal((await readNativeRuntimeLease(directory, false)).state, 'blocked');
  assert.equal((await readNativeRuntimeLease(directory, true)).state, 'owned');
  assert.equal((await readNativeRuntimeLease(directory, false)).state, 'blocked');
});
