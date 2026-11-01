import assert from 'node:assert/strict';
import test from 'node:test';
import { assertFrameworkReleasePath, frameworkRuntimeManifest } from '../scripts/framework-release.ts';

test('framework archives exclude private paths, stores, traversal and credential files', () => {
  for (const filename of ['private/extensions/local.ts', 'runtime/live/config.json', 'src/../private/key',
    '/etc/passwd', '.git/config', 'node_modules/library/index.js', '.cache/file', '.env', 'src/.env.local',
    'state/chat.sqlite', 'history.jsonl', 'session.zstd', 'src\\private\\key', 'src/a\nfile']) {
    assert.throws(() => assertFrameworkReleasePath(filename), /Private or invalid release path/, filename);
  }
  for (const filename of ['src/admin/runtime.ts', 'dist/src/admin/server.js', 'dist/admin-web/app.js',
    'assets/fonts/wqy-microhei.ttc', '.github/workflows/verify.yml', 'package-lock.json']) assertFrameworkReleasePath(filename);
});

test('the runtime archive uses compiled commands without changing the source manifest or dependencies', () => {
  const original = { name: 'qq-bridge-framework', version: '1.7.2', private: true,
    scripts: { start: 'node scripts/cli.ts start', cli: 'node scripts/cli.ts', build: 'node scripts/build.ts' },
    bin: { 'qq-bridge-framework': 'scripts/cli.ts', 'qqbridge-framework': 'ops/qqbridge-framework' }, dependencies: { example: '1.0.0' } };
  const saved = structuredClone(original), runtime = frameworkRuntimeManifest(original);
  assert.deepEqual(original, saved);
  assert.deepEqual(runtime.scripts, { ...original.scripts, start: 'node dist/scripts/cli.js start', cli: 'node dist/scripts/cli.js' });
  assert.deepEqual(runtime.bin, { ...original.bin, 'qq-bridge-framework': 'dist/scripts/cli.js' });
  assert.deepEqual(runtime.dependencies, original.dependencies);
});
