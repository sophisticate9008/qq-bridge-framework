import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { resolveLivePath, resolveRuntimeConfiguration } from '../scripts/runtime-configuration.ts';
import { isDistributionPath } from '../src/contracts/framework-distribution.ts';

test('new installations use data while explicit configuration and environment retain priority', t => {
  const root = mkdtempSync(join(tmpdir(), 'qbf-layout-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(resolveRuntimeConfiguration(root, undefined, {}, root), join(root, 'data/admin/config.json'));
  mkdirSync(join(root, 'data/live'), { recursive: true });
  writeFileSync(join(root, 'data/live/framework-admin.json'), '{}');
  assert.equal(resolveRuntimeConfiguration(root, undefined, {}, root), join(root, 'data/live/framework-admin.json'));
  assert.equal(resolveLivePath(root, 'services.json'), join(root, 'data/live/services.json'));
  assert.equal(resolveRuntimeConfiguration(root, 'runtime/admin/config.json', {}, root), join(root, 'runtime/admin/config.json'));
  assert.equal(resolveRuntimeConfiguration(root, 'custom.json', { QQ_BRIDGE_FRAMEWORK_CONFIG: 'env.json' }, root), join(root, 'custom.json'));
  assert.equal(resolveRuntimeConfiguration(root, undefined, { QQ_BRIDGE_FRAMEWORK_CONFIG: 'env.json' }, root), join(root, 'env.json'));
  assert.throws(() => resolveRuntimeConfiguration(root, '', {}, root));
});

test('release inventories cannot own persistent data or assistant task files', () => {
  for (const path of ['data/admin/config.json', 'workspace/task/scripts/read.ts', 'runtime/live/config.json', 'private/extensions/example.ts']) {
    assert.equal(isDistributionPath(path), false, path);
  }
  assert.equal(isDistributionPath('scripts/runtime-configuration.ts'), true);
});
