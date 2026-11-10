import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { uninstallProduct, productUninstallPending } from '../src/host/product-uninstall.ts';
import { registerProductCommands, unregisterProductCommands } from '../src/host/product-commands.ts';
import { registerManagedBridge, readManagedBridge } from '../src/host/product-components.ts';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'qbf-uninstall-')), root = join(directory, 'installed');
  const files = [];
  for (const [path, content] of Object.entries({ 'package.json': '{"name":"qq-bridge-framework","version":"2.0.0"}',
    'dist/scripts/cli.js': 'console.log("2.0.0")' })) {
    await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), content);
    files.push({ path, sha256: createHash('sha256').update(content).digest('hex'), size: Buffer.byteLength(content), executable: false });
  }
  await writeFile(join(root, 'distribution.json'), JSON.stringify({ schema: 1, kind: 'framework-runtime', version: '2.0.0',
    sourceCommit: 'a'.repeat(40), sourceModified: false, compatibility: { data: 1, overwrite: 1 }, files }));
  for (const path of ['data/session.json', 'workspace/work.txt', 'private/extensions/business.ts', 'custom.txt', 'node_modules/dependency/index.js']) {
    await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), 'retained');
  }
  return { root, directory, dispose: () => rm(directory, { recursive: true, force: true }) };
}
test('full uninstall removes only verified program/dependency files after detaching its registered component', async () => {
  const setup = await fixture(); let removed = 0;
  try {
    const result = await uninstallProduct(setup.root, { id: randomUUID(), keepBridge: false }, {
      async assertStopped() {}, async removeBridge() { removed++; await access(join(setup.root, 'package.json')); }, async unregister() {}
    });
    assert.equal(result.phase, 'completed'); assert.equal(removed, 1);
    await assert.rejects(access(join(setup.root, 'package.json'))); await assert.rejects(access(join(setup.root, 'node_modules')));
    for (const path of ['data/session.json', 'workspace/work.txt', 'private/extensions/business.ts', 'custom.txt']) {
      assert.equal(await readFile(join(setup.root, path), 'utf8'), 'retained');
    }
    assert.equal(await productUninstallPending(setup.root), false);
  } finally { await setup.dispose(); }
});
test('keep-bridge skips component changes, and an interrupted native removal retains all program files and the original operation', async () => {
  const setup = await fixture(); const id = randomUUID(); let calls = 0;
  const ports = { async assertStopped() {}, async removeBridge() { calls++; throw new Error('fixture unknown removal'); }, async unregister() {} };
  try {
    await assert.rejects(uninstallProduct(setup.root, { id, keepBridge: false }, ports), /unknown removal/);
    await access(join(setup.root, 'package.json')); assert.equal(await productUninstallPending(setup.root), true);
    await assert.rejects(uninstallProduct(setup.root, { id: randomUUID(), keepBridge: true }, ports), /requires_reconciliation/);
    await assert.rejects(uninstallProduct(setup.root, { id, keepBridge: true }, ports), /intent_conflict/);
    assert.equal(calls, 1);
  } finally { await setup.dispose(); }
  const keep = await fixture();
  try {
    assert.equal((await uninstallProduct(keep.root, { id: randomUUID(), keepBridge: true }, ports)).phase, 'completed');
    assert.equal(calls, 1);
  } finally { await keep.dispose(); }
});
test('a running installation, altered program and changed command registration stop destructive cleanup', async () => {
  const setup = await fixture();
  try {
    let removes = 0;
    const ports = { async assertStopped() { throw new Error('fixture running'); }, async removeBridge() { removes++; }, async unregister() {} };
    await assert.rejects(uninstallProduct(setup.root, { id: randomUUID(), keepBridge: false }, ports), /running/);
    await writeFile(join(setup.root, 'package.json'), 'changed');
    await assert.rejects(uninstallProduct(setup.root, { id: randomUUID(), keepBridge: false }, { ...ports, async assertStopped() {} }), /checksum/);
    assert.equal(removes, 0);
    if (process.platform !== 'win32') {
      const command = join(setup.directory, 'qbf-cli'), target = join(setup.root, 'dist/scripts/cli.js');
      await symlink(target, command); await registerProductCommands(setup.root, [{ path: command, target }]);
      await rm(command); await writeFile(command, 'different program');
      await assert.rejects(unregisterProductCommands(setup.root), /registration_changed/);
      assert.equal(await readFile(command, 'utf8'), 'different program');
    }
  } finally { await setup.dispose(); }
});
test('bridge registration preserves its exact source and rejects removal through a different DSH target', async () => {
  const setup = await fixture();
  const home = join(setup.directory, 'dsh');
  const bundle = { installed: true, enabled: true, removable: true, legacy: false, version: '2.0.0', source: 'file:/persistent/bridge.tgz' };
  try {
    await registerManagedBridge(setup.root, home, 'http://127.0.0.1:3080', bundle);
    assert.equal((await readManagedBridge(setup.root))?.source, bundle.source);
    await assert.rejects(registerManagedBridge(setup.root, home, 'http://127.0.0.1:3081', { ...bundle, installed: false }), /registration_changed/);
    await registerManagedBridge(setup.root, home, 'http://127.0.0.1:3080', { ...bundle, installed: false });
    assert.equal(await readManagedBridge(setup.root), null);
  } finally { await setup.dispose(); }
});
