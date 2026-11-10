import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile, utimes, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runRuntimeMaintenance } from '../scripts/runtime-maintenance.ts';

test('maintenance works without a deployment selector and never collects user data', async t => {
  const root = await mkdtemp(join(tmpdir(), 'qbf-maintenance-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of ['runtime', 'data', 'workspace']) {
    await mkdir(join(root, path)); await writeFile(join(root, path, 'keep'), 'preserve');
  }
  assert.equal((await runRuntimeMaintenance(root, true)).removedTrees, 0);
  for (const path of ['runtime', 'data', 'workspace']) assert.equal(await readFile(join(root, path, 'keep'), 'utf8'), 'preserve');
});

test('maintenance protects current, rollback and snapshots containing arbitrary user data', async t => {
  const root = await mkdtemp(join(tmpdir(), 'qbf-maintenance-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'data/live'), { recursive: true });
  for (const [i, name] of ['with-data', 'rollback', 'current'].entries()) {
    const path = join(root, 'runtime/deployments', name);
    await mkdir(join(path, 'scripts'), { recursive: true });
    await writeFile(join(path, 'scripts/gateway-admin.ts'), '');
    await writeFile(join(path, 'package.json'), JSON.stringify({ name: 'qq-bridge-framework' }));
    if (name === 'with-data') { await mkdir(join(path, 'data')); await writeFile(join(path, 'data/important'), 'preserve'); }
    await utimes(path, new Date(1000 + i * 1000), new Date(1000 + i * 1000));
  }
  await writeFile(join(root, 'data/live/admin-deployment.json'), JSON.stringify({ entry: join(root, 'runtime/deployments/current/scripts/gateway-admin.ts') }));
  const result = await runRuntimeMaintenance(root, true);
  assert.equal(result.removedTrees, 0); assert.equal(result.protectedTrees, 2);
  assert.equal(await readFile(join(root, 'runtime/deployments/with-data/data/important'), 'utf8'), 'preserve');
});

test('maintenance retains a legacy DSH dependency even with no running process using the snapshot', async t => {
  const root = await mkdtemp(join(tmpdir(), 'qbf-dsh-dependency-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'data/live'), { recursive: true });
  for (const [index, name] of ['linked', 'rollback', 'current'].entries()) {
    const path = join(root, 'runtime/deployments', name);
    await mkdir(join(path, 'scripts'), { recursive: true });
    await writeFile(join(path, 'scripts/gateway-admin.ts'), '');
    await writeFile(join(path, 'package.json'), JSON.stringify({ name: 'qq-bridge-framework' }));
    await utimes(path, new Date(1000 + index * 1000), new Date(1000 + index * 1000));
  }
  const component = join(root, 'runtime/deployments/linked/components/bridge');
  await mkdir(component, { recursive: true });
  await writeFile(join(component, 'package.json'), '{"name":"@qq-bridge-framework/dsh-bridge-plugin"}');
  // Reapply the original mtime after creating components.
  await utimes(join(root, 'runtime/deployments/linked'), new Date(1000), new Date(1000));
  const home = join(root, 'independent-dsh'), profile = join(home, 'profiles/web');
  await mkdir(join(profile, 'node_modules/@qq-bridge-framework'), { recursive: true });
  await writeFile(join(profile, 'package.json'), JSON.stringify({ dependencies: {
    '@qq-bridge-framework/dsh-bridge-plugin': 'link:../../../runtime/deployments/linked/components/bridge',
  } }));
  await symlink(component, join(profile, 'node_modules/@qq-bridge-framework/dsh-bridge-plugin'), process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(join(root, 'data/live/services.json'), JSON.stringify({ dshHome: home }));
  await writeFile(join(root, 'data/live/admin-deployment.json'), JSON.stringify({ entry: join(root, 'runtime/deployments/current/scripts/gateway-admin.ts') }));
  const result = await runRuntimeMaintenance(root, true);
  assert.equal(result.removedTrees, 0);
  assert.equal(await readFile(join(component, 'package.json'), 'utf8'), '{"name":"@qq-bridge-framework/dsh-bridge-plugin"}');
});
