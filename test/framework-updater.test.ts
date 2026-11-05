import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyFrameworkUpdate, rollbackFrameworkUpdate, verifyFrameworkDistribution } from '../src/host/framework-updater.ts';
import { isDistributionPath, parseFrameworkDistribution } from '../src/contracts/framework-distribution.ts';
import { acquireFrameworkProcessLease } from '../src/host/framework-process-lease.ts';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'qbf-update-'));
  const source = join(directory, 'new'), target = join(directory, 'installed');
  async function distribution(root: string, version: string, extra: Record<string, string> = {}) {
    const content = { 'package.json': JSON.stringify({ name: 'qq-bridge-framework', version }), 'dist/scripts/cli.js': `console.log('${version}')`, ...extra };
    const files = [];
    for (const [path, value] of Object.entries(content)) {
      await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), value);
      files.push({ path, size: Buffer.byteLength(value), sha256: createHash('sha256').update(value).digest('hex'), executable: false });
    }
    await writeFile(join(root, 'distribution.json'), JSON.stringify({ schema: 1, kind: 'framework-runtime', version,
      sourceCommit: 'a'.repeat(40), sourceModified: false, compatibility: { data: 1, overwrite: 1 }, files }));
  }
  await distribution(source, '1.12.0', { 'new.txt': 'new' });
  await distribution(target, '1.11.0', { 'obsolete.txt': 'old' });
  return { source, target, distribution, dispose: () => rm(directory, { recursive: true, force: true }) };
}
test('overwrite removes only obsolete managed files, retains data/custom files, and rolls code back exactly', async () => {
  const setup = await fixture();
  try {
    for (const path of ['runtime/session.db', 'private/extensions/custom.ts', 'custom-config.json']) {
      await mkdir(dirname(join(setup.target, path)), { recursive: true }); await writeFile(join(setup.target, path), 'preserve');
    }
    const id = await applyFrameworkUpdate(setup);
    assert.equal((await verifyFrameworkDistribution(setup.target)).version, '1.12.0');
    await assert.rejects(readFile(join(setup.target, 'obsolete.txt')));
    for (const path of ['runtime/session.db', 'private/extensions/custom.ts', 'custom-config.json']) assert.equal(await readFile(join(setup.target, path), 'utf8'), 'preserve');
    await rollbackFrameworkUpdate(setup.target, id);
    assert.equal((await verifyFrameworkDistribution(setup.target)).version, '1.11.0');
    assert.equal(await readFile(join(setup.target, 'obsolete.txt'), 'utf8'), 'old');
    await assert.rejects(readFile(join(setup.target, 'new.txt')));
    await rollbackFrameworkUpdate(setup.target, id);
  } finally { await setup.dispose(); }
});
test('corruption, a running framework and cross-major updates fail before replacing old files', async () => {
  const setup = await fixture();
  try {
    await writeFile(join(setup.source, 'new.txt'), 'corrupt');
    await assert.rejects(applyFrameworkUpdate(setup), /checksum/);
    await setup.distribution(setup.source, '2.0.0');
    await assert.rejects(applyFrameworkUpdate(setup), /major_requires/);
    await setup.distribution(setup.source, '1.12.0');
    const release = await acquireFrameworkProcessLease(setup.target, 'runtime');
    try { await assert.rejects(applyFrameworkUpdate(setup), /still_running/); } finally { await release(); }
    assert.equal((await verifyFrameworkDistribution(setup.target)).version, '1.11.0');
  } finally { await setup.dispose(); }
});
test('release inventories reject traversal, protected data, case collisions and destination symlinks', async () => {
  for (const path of ['../x', '/absolute', 'runtime/a', 'private/a', '.git/x', '.env', 'a/CON.txt', 'node_modules/a', 'a\\b', '.framework-update.lock']) assert.equal(isDistributionPath(path), false, path);
  const setup = await fixture();
  try {
    const value = JSON.parse(await readFile(join(setup.source, 'distribution.json'), 'utf8'));
    value.files.push({ ...value.files[0], path: 'PACKAGE.JSON' });
    assert.equal(parseFrameworkDistribution(value), null);
    if (process.platform !== 'win32') {
      await symlink(join(setup.source, 'new.txt'), join(setup.target, 'new.txt'));
      await assert.rejects(applyFrameworkUpdate(setup), /symlink/);
    }
  } finally { await setup.dispose(); }
});

test('a completed swap retains its recovery lock until the supervisor records the transaction', async () => {
  const setup = await fixture();
  try {
    const id = await applyFrameworkUpdate({ ...setup, retainLock: true });
    assert.equal(await readFile(join(setup.target, '.framework-update.lock'), 'utf8'), id);
    await rollbackFrameworkUpdate(setup.target, id);
    assert.equal((await verifyFrameworkDistribution(setup.target)).version, '1.11.0');
    await assert.rejects(readFile(join(setup.target, '.framework-update.lock')));
  } finally { await setup.dispose(); }
});
