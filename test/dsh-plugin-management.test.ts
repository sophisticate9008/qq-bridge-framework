import { parseBridgeChange } from '../src/contracts/bridge-management.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDshJsonRpcPort } from '../src/adapters/dsh-jsonrpc.ts';
import { BRIDGE_PACKAGE } from '../src/contracts/bridge-management.ts';

test('native plugin management uses owner transport and only the fixed bridge package', async t => {
  const calls: { method: string; args: Record<string, unknown> }[] = [];
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.cookie, 'owner=fixture');
    const buffers: Buffer[] = [];
    for await (const part of request) buffers.push(Buffer.from(part));
    const wire = JSON.parse(Buffer.concat(buffers).toString()) as {
      rpcId: string; method: string; payload: { args: Record<string, unknown> };
    };
    calls.push({ method: wire.method, args: wire.payload.args });
    let value: unknown;
    if (wire.method === 'pluginManager/listBundles') value = [{ name: BRIDGE_PACKAGE, installed: true, enabled: true,
      removable: true, version: '2.0.0', source: 'file:/persistent/plugin.tgz', rows: [{ entryId: 'bridge-entry' }] }];
    else if (wire.method === 'pluginManager/listPlugins') value = [{ moduleName: BRIDGE_PACKAGE, entryId: 'bridge-entry' }];
    else if (wire.method === 'pluginManager/waitForInstall') value = null;
    else value = { application: 'restart-required', changed: true, version: '2.0.1' };
    response.end(JSON.stringify({ type: 'server-response', rpcId: wire.rpcId, result: { ok: true, value } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); assert(address && typeof address !== 'string');
  const client = createDshJsonRpcPort({ endpoint: `http://127.0.0.1:${address.port}`, auth: 'cookie:owner=fixture' });
  t.after(() => client.close());
  const port = client.pluginManagement, signal = new AbortController().signal;
  const bundle = await port.read(signal);
  assert.equal(bundle.installed, true); assert.equal(bundle.legacy, false); assert.equal(bundle.version, '2.0.0');
  const id = randomUUID(), archive = join(tmpdir(), 'bridge-2.0.1.tgz');
  assert.equal((await port.install(archive, id, true, signal)).application, 'restart-required');
  assert.deepEqual(calls.at(-1), { method: 'pluginManager/installBundle',
    args: { spec: archive, options: { requestId: id, enabled: true, saveExact: true } } });
  await port.remove(signal);
  assert.deepEqual(calls.at(-1), { method: 'pluginManager/removeBundle', args: { name: BRIDGE_PACKAGE } });
  assert.equal(await port.wait(id, signal), null);
  assert(calls.every(call => call.method.startsWith('pluginManager/')));
  const count = calls.length;
  assert.throws(() => port.install('relative.tgz', id, true, signal));
  assert.equal(calls.length, count);
});


test('missing DSH package manager has a specific safe code without forwarding external diagnostics', () => {
  const result = parseBridgeChange({ application: 'failed', changed: false, stage: 'install', target: 'bridge',
    error: { code: 'operation-error', diagnostic: 'Command failed with ENOENT: pnpm add /private/path.tgz\nspawn pnpm ENOENT' } });
  assert.deepEqual(result, { application: 'failed', changed: false, version: null, error: 'package-manager-unavailable' });
  assert.equal(parseBridgeChange({ application: 'failed', changed: false,
    error: { code: 'operation-error', diagnostic: 'secret private response' } })?.error, 'operation-error');
});
