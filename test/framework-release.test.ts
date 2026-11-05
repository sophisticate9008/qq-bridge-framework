import assert from 'node:assert/strict';
import test from 'node:test';
import { assertFrameworkReleasePath, frameworkRuntimeManifest } from '../scripts/framework-release.ts';
import { createFrameworkReleaseService, createFrameworkReleaseRoutes } from '../src/admin/framework-release.ts';
import { compareReleaseVersions, parseFrameworkReleaseStatus } from '../src/contracts/framework-release.ts';

test('release checks compare numeric versions, coalesce requests and throttle refreshes', async () => {
  let at = 100_000, calls = 0;
  const service = createFrameworkReleaseService({ version: '1.9.0', installation: 'archive', now: () => at,
    fetch: async () => { calls++; return Response.json({ tag_name: 'v1.12.0', prerelease: false, draft: false }); } });
  const results = await Promise.all([service.read(), service.read(true), service.read()]);
  assert.equal(calls, 1); assert.equal(results[0].state, 'available');
  assert.equal(parseFrameworkReleaseStatus(results[0])?.majorUpgrade, false);
  at += 9999; await service.read(true); assert.equal(calls, 1);
  at++; await service.read(true); assert.equal(calls, 2);
  assert.equal(compareReleaseVersions('1.12.0', '1.9.0'), 1);
  assert.equal(compareReleaseVersions('1.12.0', '1.12.0'), 0);
  assert.throws(() => compareReleaseVersions('1.12.0-rc.1', '1.12.0'));
});
test('untrusted release links, drafts, prereleases, excessive responses and outages never become executable input', async () => {
  for (const response of [Response.json({ tag_name: 'v2.0.0', draft: true, prerelease: false }),
    Response.json({ tag_name: 'v2.0.0-rc.1', draft: false, prerelease: true }),
    new Response('x'.repeat(524289)), new Response('', { status: 403 })]) {
    const service = createFrameworkReleaseService({ version: '1.11.0', fetch: async () => response });
    assert.equal((await service.read()).state, 'unavailable');
  }
  const service = createFrameworkReleaseService({ version: '1.11.0', fetch: async () => Response.json({
    tag_name: 'v2.0.0', draft: false, prerelease: false, html_url: 'javascript:bad' }) });
  const status = await service.read();
  assert.equal(status.majorUpgrade, true);
  assert.equal(status.releaseUrl, 'https://github.com/sophisticate9008/qq-bridge-framework/releases/tag/v2.0.0');
  const route = createFrameworkReleaseRoutes(service)[0];
  await assert.rejects(async () => route.handle({ query: new URLSearchParams('refresh=1&refresh=1'), body: null, signal: AbortSignal.timeout(1000) }));
});

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
  const original = { name: 'qq-bridge-framework', version: '1.9.0', private: true,
    scripts: { start: 'node scripts/cli.ts start', cli: 'node scripts/cli.ts', build: 'node scripts/build.ts' },
    bin: { 'qbf-cli': 'scripts/cli.ts' }, dependencies: { example: '1.0.0' } };
  const saved = structuredClone(original), runtime = frameworkRuntimeManifest(original);
  assert.deepEqual(original, saved);
  assert.deepEqual(runtime.scripts, { ...original.scripts, start: 'node dist/scripts/cli.js start', cli: 'node dist/scripts/cli.js' });
  assert.deepEqual(runtime.bin, { 'qbf-cli': 'dist/scripts/cli.js', 'qq-bridge-framework': 'dist/scripts/cli.js',
    'qqbridge-framework': 'dist/scripts/legacy-service-cli.js' });
  assert.deepEqual(runtime.dependencies, original.dependencies);
});
