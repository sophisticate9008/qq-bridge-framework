import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridgeManager } from '../src/host/bridge-manager.ts';
import type { BridgeBundle, BridgeChange } from '../src/contracts/bridge-management.ts';
import type { DshPluginManagement } from '../src/adapters/dsh-plugin-management.ts';

const signal = () => new AbortController().signal;
async function fixture(installed = false) {
  const directory = await mkdtemp(join(tmpdir(), 'qbf-bridge-manager-'));
  const path = (version: string) => join(directory, `plugin-${version}.tgz`);
  let bundle: BridgeBundle = { installed, version: installed ? '2.0.0' : null, enabled: installed,
    removable: installed, legacy: false, source: installed ? `file:${path('2.0.0')}` : null };
  let liveVersion: string | null = installed ? '2.0.0' : null;
  const events: string[] = [];
  const results: (BridgeChange | Error)[] = [];
  let loseAfterApply = false, archiveFailure: string | null = null;
  let waitResult: BridgeChange | null = null;
  const port: DshPluginManagement = {
    async read() { return { ...bundle }; },
    async install(archive, _id, enabled) {
      const version = /plugin-(\d+\.\d+\.\d+)\.tgz$/.exec(archive)?.[1]; assert(version);
      events.push(`install:${version}`);
      const result = results.shift() ?? { application: 'applied', changed: true, version, error: null };
      if (result instanceof Error) throw result;
      if (['applied', 'restart-required'].includes(result.application)) {
        bundle = { installed: true, enabled, removable: true, legacy: false, version, source: `file:${archive}` };
        if (result.application === 'applied') liveVersion = enabled ? version : null;
        if (loseAfterApply) { loseAfterApply = false; throw new Error('transport_lost'); }
      }
      return result;
    },
    async remove() {
      events.push('remove'); bundle = { installed: false, enabled: false, removable: false, legacy: false, version: null, source: null };
      liveVersion = null;
      return { application: 'applied', changed: true, version: null, error: null };
    },
    async wait() { events.push('wait'); return waitResult; },
  };
  const reopen = () => createBridgeManager({ directory, port,
    async archive(version) {
      events.push(`archive:${version}`);
      if (archiveFailure === version) throw new Error('download_failed');
      return path(version);
    },
    async describe() { if (!liveVersion) throw new Error('not_loaded'); return { pluginVersion: liveVersion }; },
  });
  return { manager: reopen(), reopen, events, results, bundle: () => bundle,
    setBundle: (value: Partial<BridgeBundle>) => { bundle = { ...bundle, ...value }; },
    loseResponse: () => { loseAfterApply = true; },
    archiveFailure: (version: string) => { archiveFailure = version; },
    setWait: (value: BridgeChange | null) => { waitResult = value; },
    dispose: () => rm(directory, { recursive: true, force: true }),
  };
}

test('native installation is durable and a reopened manager never replays the same request', async t => {
  const setup = await fixture(); t.after(setup.dispose);
  const request = { id: randomUUID(), action: 'install' as const, version: '2.0.0' };
  assert.equal((await setup.manager.execute(request, signal())).state, 'loaded');
  assert.equal((await setup.reopen().execute(request, signal())).state, 'loaded');
  assert.deepEqual(setup.events, ['archive:2.0.0', 'install:2.0.0']);
  await assert.rejects(setup.reopen().execute({ ...request, version: '2.0.1' }, signal()), /bridge_operation_conflict/);
});

test('download failure and legacy installation leave the original DSH package alone', async t => {
  for (const legacy of [false, true]) {
    const setup = await fixture(true); t.after(setup.dispose);
    const before = setup.bundle();
    if (legacy) setup.setBundle({ legacy: true }); else setup.archiveFailure('2.0.1');
    const result = await setup.manager.execute({ id: randomUUID(), action: 'update', version: '2.0.1' }, signal());
    assert.equal(result.state, 'failed');
    assert.equal(result.error, legacy ? 'bridge_legacy_installation_requires_migration' : 'download_failed');
    assert.equal(setup.bundle().version, before.version);
    assert(!setup.events.some(event => event === 'remove' || event.startsWith('install:')));
  }
});

test('installed and loaded versions remain distinct when DSH reports restart-required', async t => {
  const setup = await fixture(true); t.after(setup.dispose);
  setup.results.push({ application: 'restart-required', changed: true, version: '2.0.1', error: null });
  const result = await setup.manager.execute({ id: randomUUID(), action: 'update', version: '2.0.1' }, signal());
  assert.equal(result.state, 'restart-required'); assert.equal(result.restartRequired, true);
  assert.equal(setup.bundle().version, '2.0.1');
  assert.deepEqual(setup.events, ['archive:2.0.1', 'install:2.0.1']);
});

test('HMR replacement prepares rollback before removal and restores a rejected candidate', async t => {
  const setup = await fixture(true); t.after(setup.dispose);
  setup.results.push({ application: 'failed', changed: false, version: null, error: 'already-installed' },
    { application: 'failed', changed: false, version: null, error: 'incompatible-version' });
  const result = await setup.manager.execute({ id: randomUUID(), action: 'update', version: '2.0.1' }, signal());
  assert.equal(result.state, 'rolled-back'); assert.equal(result.restartRequired, false);
  assert.equal(result.error, 'incompatible-version');
  assert.equal(setup.bundle().version, '2.0.0');
  assert.deepEqual(setup.events, ['archive:2.0.1', 'install:2.0.1', 'archive:2.0.0', 'remove', 'install:2.0.1', 'install:2.0.0']);
});

test('missing rollback archive and unmanaged package source never permit HMR removal', async t => {
  for (const badSource of [false, true]) {
    const setup = await fixture(true); t.after(setup.dispose);
    if (badSource) setup.setBundle({ source: 'file:/someone-else/custom.tgz' }); else setup.archiveFailure('2.0.0');
    setup.results.push({ application: 'failed', changed: false, version: null, error: 'already-installed' });
    const result = await setup.manager.execute({ id: randomUUID(), action: 'update', version: '2.0.1' }, signal());
    assert.equal(result.state, 'failed'); assert.equal(setup.bundle().version, '2.0.0');
    assert(!setup.events.includes('remove'));
  }
});

test('a lost successful response is reconciled read-only after reopening without another installation', async t => {
  const setup = await fixture(); t.after(setup.dispose); setup.loseResponse();
  const request = { id: randomUUID(), action: 'install' as const, version: '2.0.0' };
  assert.equal((await setup.manager.execute(request, signal())).state, 'unknown');
  const reopened = setup.reopen();
  assert.equal((await reopened.execute(request, signal())).state, 'unknown');
  assert.equal((await reopened.reconcile(request.id, signal())).state, 'loaded');
  assert.deepEqual(setup.events, ['archive:2.0.0', 'install:2.0.0', 'wait']);
});

test('absence of an active native request is not a successful outcome and blocks new writes', async t => {
  const setup = await fixture(); t.after(setup.dispose);
  setup.results.push(new Error('transport_lost'));
  const request = { id: randomUUID(), action: 'install' as const, version: '2.0.0' };
  assert.equal((await setup.manager.execute(request, signal())).state, 'unknown');
  assert.equal((await setup.reopen().reconcile(request.id, signal())).state, 'unknown');
  await assert.rejects(setup.reopen().execute({ ...request, id: randomUUID() }, signal()), /bridge_operation_unresolved/);
  assert.deepEqual(setup.events, ['archive:2.0.0', 'install:2.0.0', 'wait']);
});

test('explicit removal affects only the bridge package and remains idempotent', async t => {
  const setup = await fixture(true); t.after(setup.dispose);
  const request = { id: randomUUID(), action: 'remove' as const, version: null };
  assert.equal((await setup.manager.execute(request, signal())).state, 'removed');
  assert.equal((await setup.reopen().execute(request, signal())).state, 'removed');
  assert.deepEqual(setup.events, ['remove']);
});


test('updating a disabled bundle preserves its disabled state without falsely requiring a restart to load it', async t => {
  const setup = await fixture(true); t.after(setup.dispose);
  setup.setBundle({ enabled: false });
  const result = await setup.manager.execute({ id: randomUUID(), action: 'update', version: '2.1.0' }, signal());
  assert.equal(result.state, 'installed-disabled');
  assert.equal(result.restartRequired, false);
  assert.equal(setup.bundle().enabled, false);
  assert.equal(setup.bundle().version, '2.1.0');
});
