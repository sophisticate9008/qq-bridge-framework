import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bridgeArchiveName, prepareBridgeArchive } from '../src/host/bridge-archive.ts';
import { parseBridgeArguments } from '../scripts/bridge-cli.ts';

const signal = () => new AbortController().signal;
const sum = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'qbf-bridge-archives-'));
  const bytes = 'verified-component-fixture', name = bridgeArchiveName('2.0.0');
  const urls: string[] = [];
  const fetcher: typeof fetch = async input => {
    const url = String(input); urls.push(url);
    return new Response(url.endsWith('/SHA256SUMS') ? `${sum(bytes)}  ${name}\n` : bytes);
  };
  return { home, bytes, name, urls, fetcher, dispose: () => rm(home, { recursive: true, force: true }) };
}
test('downloads use fixed official URLs, verify bytes and retain an independent offline archive', async t => {
  const setup = await fixture(); t.after(setup.dispose);
  const options = { home: setup.home, version: '2.0.0', signal: signal(), fetch: setup.fetcher };
  const archive = await prepareBridgeArchive(options);
  assert.equal(await readFile(archive, 'utf8'), setup.bytes);
  assert.equal(archive, join(setup.home, 'packages/qq-bridge-framework', setup.name));
  assert.deepEqual(setup.urls, [
    'https://github.com/sophisticate9008/qq-bridge-framework/releases/download/v2.0.0/SHA256SUMS',
    `https://github.com/sophisticate9008/qq-bridge-framework/releases/download/v2.0.0/${setup.name}`,
  ]);
  const offline: typeof fetch = async () => { throw new Error('No network'); };
  assert.equal(await prepareBridgeArchive({ ...options, fetch: offline }), archive);
});

test('tampered archives are rejected and never replaced silently', async t => {
  const setup = await fixture(); t.after(setup.dispose);
  const options = { home: setup.home, version: '2.0.0', signal: signal(), fetch: setup.fetcher };
  const archive = await prepareBridgeArchive(options);
  await writeFile(archive, 'tampered');
  await assert.rejects(prepareBridgeArchive(options), /bridge_archive_checksum_invalid/);
  assert.equal(await readFile(archive, 'utf8'), 'tampered');
});

test('checksum failure and ambiguous manifests never publish an installable archive', async t => {
  for (const duplicate of [false, true]) {
    const setup = await fixture(); t.after(setup.dispose);
    const fetcher: typeof fetch = async input => new Response(String(input).endsWith('/SHA256SUMS')
      ? `${sum(setup.bytes)}  ${setup.name}\n`.repeat(duplicate ? 2 : 1) : 'wrong bytes');
    await assert.rejects(prepareBridgeArchive({ home: setup.home, version: '2.0.0', signal: signal(), fetch: fetcher }),
      duplicate ? /bridge_checksum_missing/ : /bridge_archive_checksum_invalid/);
    assert.deepEqual(await readdir(join(setup.home, 'packages/qq-bridge-framework')), []);
  }
});

test('offline full-package installation retains the archive after deleting the framework source', async t => {
  const setup = await fixture(); t.after(setup.dispose);
  const source = join(setup.home, 'framework-source');
  await mkdir(join(source, 'dist/scripts'), { recursive: true });
  await mkdir(join(source, 'components'));
  const contents = new Map([
    ['package.json', JSON.stringify({ name: 'qq-bridge-framework', version: '2.0.0' })],
    ['dist/scripts/cli.js', 'export {};'], ['components/' + setup.name, setup.bytes],
  ]);
  for (const [name, content] of contents) await writeFile(join(source, name), content);
  await writeFile(join(source, 'distribution.json'), JSON.stringify({ schema: 1, kind: 'framework-runtime', version: '2.0.0',
    sourceCommit: 'a'.repeat(40), sourceModified: false, compatibility: { data: 1, overwrite: 1 },
    files: [...contents].map(([path, content]) => ({ path, size: Buffer.byteLength(content), sha256: sum(content), executable: false })),
  }));
  const archive = await prepareBridgeArchive({ home: setup.home, version: '2.0.0', signal: signal(), offlineRoot: source });
  await rm(source, { recursive: true });
  assert.equal(await readFile(archive, 'utf8'), setup.bytes);
  assert.equal(await prepareBridgeArchive({ home: setup.home, version: '2.0.0', signal: signal(),
    fetch: async () => { throw new Error('offline'); } }), archive);
});

test('download directory links and hostile CLI targets are rejected', async t => {
  const setup = await fixture(); t.after(setup.dispose);
  const outside = await mkdtemp(join(tmpdir(), 'qbf-other-project-')); t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, join(setup.home, 'packages'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(prepareBridgeArchive({ home: setup.home, version: '2.0.0', signal: signal(), fetch: setup.fetcher }), /bridge_archive_directory_invalid/);
  assert.deepEqual(await readdir(outside), []);
  for (const args of [
    ['install', '../../elsewhere'], ['install', '1.13.7'], ['update', '2.0.0', '--home', '/dsh'],
    ['remove', '--operation-id', 'not-an-id'],
    ['install', '2.0.0', '--home', setup.home, '--endpoint', 'http://evil.invalid'],
    ['install', '2.0.0', '--home', setup.home, '--endpoint', 'http://secret@127.0.0.1:3080'],
  ]) assert.throws(() => parseBridgeArguments(args));
});


test('cancelled downloads cannot return a cached success or publish an archive', async t => {
  const setup = await fixture(); t.after(setup.dispose);
  const aborted = AbortSignal.abort();
  await assert.rejects(prepareBridgeArchive({ home: setup.home, version: '2.0.0', signal: aborted, fetch: setup.fetcher }));
  await prepareBridgeArchive({ home: setup.home, version: '2.0.0', signal: signal(), fetch: setup.fetcher });
  await assert.rejects(prepareBridgeArchive({ home: setup.home, version: '2.0.0', signal: aborted, fetch: setup.fetcher }));
});
