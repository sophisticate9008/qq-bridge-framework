import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProductUpdater, productUpdateAllowsStart, readProductUpdate, type ProductUpdatePorts } from '../src/host/product-update.ts';
import { applyFrameworkUpdate, rollbackFrameworkUpdate } from '../src/host/framework-updater.ts';
import { ensureProductEngineReload } from '../src/host/product-engine-reload.ts';
import type { BridgeBundle } from '../src/contracts/bridge-management.ts';
import type { BridgeOperation } from '../src/host/bridge-manager.ts';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'qbf-product-update-')), root = join(directory, 'installed'), source = join(directory, 'candidate');
  async function install(target: string, version: string) {
    const files = [];
    for (const [path, content] of Object.entries({ 'package.json': JSON.stringify({ name: 'qq-bridge-framework', version }),
      'dist/scripts/cli.js': `console.log('${version}')` })) {
      await mkdir(dirname(join(target, path)), { recursive: true }); await writeFile(join(target, path), content);
      files.push({ path, size: Buffer.byteLength(content), executable: false, sha256: createHash('sha256').update(content).digest('hex') });
    }
    await writeFile(join(target, 'distribution.json'), JSON.stringify({ schema: 1, kind: 'framework-runtime', version,
      sourceCommit: 'a'.repeat(40), sourceModified: false, compatibility: { data: 1, overwrite: 1 }, files }));
  }
  await install(root, '2.0.0'); await install(source, '2.0.1');
  await mkdir(join(root, 'private'), { mode: 0o700 }); await writeFile(join(root, 'private/keep.txt'), 'private-data');
  const archive = (version: string) => join(directory, `bridge-${version}.tgz`);
  let bundle: BridgeBundle = { installed: true, enabled: true, removable: true, legacy: false, version: '2.0.0', source: `file:${archive('2.0.0')}` };
  let running = true, failVerify = false, loseBridge = false, unknownBridge = false, changes = 0, runtimeChanges = 0;
  const operations = new Map<string, BridgeOperation>(), events: string[] = [];
  const ports: ProductUpdatePorts = {
    async runtimeVersion() { return (JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { version: string }).version; },
    async bridge() { return structuredClone(bundle); }, async prepareArchive(version) { events.push(`prepare:${version}`); return archive(version); },
    async changeBridge(id, version) {
      assert(!running, 'host must stop before the component changes');
      const previous = operations.get(id); if (previous) return previous;
      changes++; events.push(`bridge:${version}`);
      const operation: BridgeOperation = { schema: 1, id, action: version === null ? 'remove' : 'update', version,
        previousVersion: bundle.version, previousEnabled: bundle.enabled, previousSource: bundle.source,
        phase: 'verifying', restartRequired: false, state: loseBridge && version === '2.0.1' ? 'unknown' : 'loaded', requestId: randomUUID(), error: null };
      if (!unknownBridge) bundle = { ...bundle, installed: version !== null, enabled: version !== null && bundle.enabled,
        version, source: version === null ? null : `file:${archive(version)}` };
      operations.set(id, operation); return operation;
    },
    async reconcileBridge(id) {
      const operation = operations.get(id); if (!operation) return null;
      if (operation.state === 'unknown' && !unknownBridge) {
        const reconciled = { ...operation, state: 'loaded' as const }; operations.set(id, reconciled); return reconciled;
      }
      return operation;
    },
    async ensureBridge(version, enabled) { assert.equal(bundle.version, version); assert.equal(bundle.enabled, enabled); },
    async stop() { running = false; events.push('stop'); },
    async start() { running = true; events.push('start'); },
    async applyRuntime(transactionId) { assert(!running); runtimeChanges++; events.push('runtime'); await applyFrameworkUpdate({ source, target: root, transactionId }); },
    async rollbackRuntime(transactionId) {
      try { await readFile(join(root, 'data/framework-updates', transactionId, 'journal.json')); }
      catch { return; }
      events.push('rollback-runtime'); await rollbackFrameworkUpdate(root, transactionId);
    },
    async verify(version, wasRunning) { assert.equal(running, true); assert.equal(wasRunning, true); assert.equal(await ports.runtimeVersion(), version);
      if (failVerify && version === '2.0.1') throw new Error('fixture candidate health failure'); },
  };
  const create = () => createProductUpdater(root, ports);
  return { root, ports, create, events, bundle: () => bundle, changes: () => changes, runtimeChanges: () => runtimeChanges,
    setBundle(value: Partial<BridgeBundle>) { bundle = { ...bundle, ...value }; }, failVerify() { failVerify = true; },
    loseBridge(uncertain = false) { loseBridge = true; unknownBridge = uncertain; },
    resolveBridge() { loseBridge = false; unknownBridge = false; }, running: () => running,
    dispose: () => rm(directory, { recursive: true, force: true }) };
}
test('a single durable operation pins archives, updates both installed components, preserves private files, and rolls both back', async () => {
  const setup = await fixture();
  try {
    const id = randomUUID(), request = { id, version: '2.0.1', wasRunning: true };
    const result = await setup.create().execute(request);
    assert.equal(result.phase, 'completed'); assert.equal(setup.bundle().version, '2.0.1');
    assert(setup.events.indexOf('prepare:2.0.0') < setup.events.indexOf('stop'));
    assert(setup.events.indexOf('bridge:2.0.1') < setup.events.indexOf('runtime'));
    assert.equal(await readFile(join(setup.root, 'private/keep.txt'), 'utf8'), 'private-data');
    assert.equal((await setup.create().execute(request)).phase, 'completed'); assert.equal(setup.changes(), 1); assert.equal(setup.runtimeChanges(), 1);
    assert.equal((await setup.create().rollback(id)).phase, 'rolled-back');
    assert.equal(setup.bundle().version, '2.0.0'); assert.equal(await setup.ports.runtimeVersion(), '2.0.0');
    assert.equal((await setup.create().rollback(id)).phase, 'rolled-back'); assert.equal(setup.changes(), 2);
  } finally { await setup.dispose(); }
});
test('failed candidate readiness restores the old plugin and actual program files before restarting the old host', async () => {
  const setup = await fixture(); setup.failVerify(); setup.setBundle({ enabled: false });
  try {
    const result = await setup.create().execute({ id: randomUUID(), version: '2.0.1', wasRunning: true });
    assert.equal(result.phase, 'rolled-back'); assert.equal(setup.bundle().enabled, false);
    assert.equal(setup.bundle().version, '2.0.0'); assert.equal(await setup.ports.runtimeVersion(), '2.0.0');
    assert(setup.events.indexOf('bridge:2.0.0') < setup.events.indexOf('rollback-runtime'));
    assert.equal(setup.events.at(-1), 'start');
  } finally { await setup.dispose(); }
});
test('an unknown native write blocks new updates and startup; reopened reconciliation never replays the candidate install', async () => {
  const setup = await fixture(); setup.loseBridge(true);
  try {
    const request = { id: randomUUID(), version: '2.0.1', wasRunning: true };
    const result = await setup.create().execute(request);
    assert.equal(result.phase, 'unknown'); assert.equal(productUpdateAllowsStart(await readProductUpdate(setup.root)), false);
    assert.equal(setup.running(), false); assert.equal(setup.runtimeChanges(), 0);
    await assert.rejects(setup.create().execute({ ...request, id: randomUUID() }), /requires_reconciliation/);
    assert.equal((await setup.create().rollback(request.id)).phase, 'unknown'); assert.equal(setup.changes(), 1);
    setup.resolveBridge();
    assert.equal((await setup.create().rollback(request.id)).phase, 'rolled-back');
    assert.equal(setup.changes(), 1); assert.equal(productUpdateAllowsStart(await readProductUpdate(setup.root)), true);
  } finally { await setup.dispose(); }
});
test('a lost native acknowledgement with confirmed selection safely restores the old combination without installing the candidate twice', async () => {
  const setup = await fixture(); setup.loseBridge();
  try {
    const result = await setup.create().execute({ id: randomUUID(), version: '2.0.1', wasRunning: true });
    assert.equal(result.phase, 'rolled-back'); assert.equal(setup.changes(), 2); assert.equal(setup.runtimeChanges(), 0);
    assert.equal(setup.bundle().version, '2.0.0');
  } finally { await setup.dispose(); }
});
test('an unacknowledged DSH restart is checked by loaded evidence and never repeated after reopening', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qbf-product-reload-')), id = randomUUID();
  let restarts = 0, loaded = false;
  const ports = { async restart() { restarts++; throw new Error('fixture lost acknowledgement'); },
    async verify() { if (!loaded) throw new Error('fixture loading unconfirmed'); } };
  try {
    await assert.rejects(ensureProductEngineReload(root, id, '2.0.1', true, ports));
    await assert.rejects(ensureProductEngineReload(root, id, '2.0.1', true, ports));
    assert.equal(restarts, 1);
    loaded = true; await ensureProductEngineReload(root, id, '2.0.1', true, ports); assert.equal(restarts, 1);
    await assert.rejects(ensureProductEngineReload(root, id, '2.0.0', true, ports), /chat_storage_invalid/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
