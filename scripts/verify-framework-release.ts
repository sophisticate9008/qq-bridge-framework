import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { isRecord } from '../src/core/values.ts';
import { verifyFrameworkUpgrade } from './verify-framework-upgrade.ts';
import { assertFrameworkReleasePath } from './framework-release.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const source: unknown = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
assert(isRecord(source) && typeof source.version === 'string');
const version = source.version, prefix = `qq-bridge-framework-${version}`;
const artifact = join(root, 'private/maintenance/releases', `v${version}`, `${prefix}.tar.gz`);
// Git Bash's GNU tar treats a drive-letter path as a remote host. The Windows
// system tar understands native absolute paths without changing archive checks.
const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'tar.exe') : 'tar';
const expectedSourceCommit = process.env.QQ_BRIDGE_FRAMEWORK_RELEASE_SOURCE_COMMIT ?? process.env.GITHUB_SHA;
if (process.env.QQ_BRIDGE_FRAMEWORK_RELEASE_PLATFORM) assert.equal(process.platform, process.env.QQ_BRIDGE_FRAMEWORK_RELEASE_PLATFORM);
if (process.env.QQ_BRIDGE_FRAMEWORK_RELEASE_ARCH) assert.equal(process.arch, process.env.QQ_BRIDGE_FRAMEWORK_RELEASE_ARCH);
const directory = await mkdtemp(join(tmpdir(), 'qqbf-runtime-consumer-'));
const run = promisify(execFile);
const env: NodeJS.ProcessEnv = { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' };
delete env.QQ_BRIDGE_FRAMEWORK_CONFIG;
let child: ChildProcess | undefined, childExit: Promise<unknown[]> | undefined, diagnostics = '';
let phase = 'archive', completed = false;
const evidence = { version, platform: process.platform, arch: process.arch, productionInstall: false,
  nativeRenderingAndFonts: false, windowsChatAndAcl: false, managedExtensionSdk: false, initialized: false, webAssetsVerified: 0, initializationAndRestart: false };
function checkpoint(next: string): void { phase = next; console.log(JSON.stringify({ phase, platform: process.platform, arch: process.arch })); }
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function port(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}
async function stop(): Promise<void> {
  if (!child) return;
  const current = child;
  if (current.exitCode === null && current.signalCode === null) {
    if (process.platform === 'win32' && current.connected) current.send({ type: 'qqbridge.shutdown' });
    else current.kill('SIGTERM');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([childExit!, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { current.kill('SIGKILL'); reject(new Error('Runtime did not drain')); }, 10000);
      })]);
      assert.equal(result[0], 0, diagnostics.slice(-4000));
    } finally { clearTimeout(timer); }
  }
  child = undefined;
}
try {
  console.log(JSON.stringify({ phase, platform: process.platform, arch: process.arch, node: process.version }));
  const checksums = (await readFile(join(dirname(artifact), 'SHA256SUMS'), 'utf8')).trim().split(/\r?\n/);
  const archiveChecksum = checksums.find(line => line.endsWith(`  ${prefix}.tar.gz`));
  assert(archiveChecksum && /^[a-f0-9]{64}  /.test(archiveChecksum));
  assert.equal(hash(await readFile(artifact)), archiveChecksum.slice(0, 64));
  const listing = await run(tar, ['-tzf', artifact], { maxBuffer: 8 * 1024 * 1024 });
  const members = listing.stdout.trim().split(/\r?\n/);
  for (const member of members) {
    assert(member.startsWith(prefix + '/'));
    const filename = member.slice(prefix.length + 1).replace(/\/$/, '');
    if (filename) assertFrameworkReleasePath(filename);
  }
  const verbose = await run(tar, ['-tvzf', artifact], { maxBuffer: 8 * 1024 * 1024 });
  assert(verbose.stdout.trim().split(/\r?\n/).every(line => line.startsWith('-') || line.startsWith('d')));
  if (process.platform === 'win32' && checksums.some(line => line.endsWith(`  ${prefix}-windows-x64.zip`))) {
    const windowsArchive = join(dirname(artifact), `${prefix}-windows-x64.zip`);
    const checksum = checksums.find(line => line.endsWith(`  ${prefix}-windows-x64.zip`));
    assert(checksum && /^[a-f0-9]{64}  /.test(checksum));
    assert.equal(hash(await readFile(windowsArchive)), checksum.slice(0, 64));
    const zipListing = await run(tar, ['-tf', windowsArchive], { maxBuffer: 8 * 1024 * 1024 });
    assert.deepEqual(zipListing.stdout.trim().split(/\r?\n/).sort(), [...members].sort());
    await run(tar, ['-xf', windowsArchive, '-C', directory]);
  } else await run(tar, ['-xzf', artifact, '-C', directory]);
  const cwd = join(directory, prefix);
  const manifest: unknown = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8'));
  assert(isRecord(manifest) && isRecord(manifest.scripts));
  assert.equal(manifest.version, version);
  assert.equal(manifest.scripts.start, 'node dist/scripts/cli.js start');
  const distribution: unknown = JSON.parse(await readFile(join(cwd, 'distribution.json'), 'utf8'));
  assert(isRecord(distribution) && distribution.version === version && Array.isArray(distribution.components));
  assert.equal(distribution.sourceModified, false);
  if (expectedSourceCommit) assert.equal(distribution.sourceCommit, expectedSourceCommit);
  for (const document of ['README.md', 'docs/DIRECTORIES.md', 'docs/EXTENDING.md', 'docs/SERVICE_CONVENTIONS.md', 'examples/reloadable-plugin/README.md', 'packages/framework-sdk/README.md']) assert((await readFile(join(cwd, document), 'utf8')).length > 100);
  for (const item of distribution.components) {
    assert(isRecord(item) && typeof item.filename === 'string' && typeof item.sha256 === 'string');
    assert.equal(hash(await readFile(join(cwd, 'components', item.filename))), item.sha256);
  }
  checkpoint('production-dependencies');
  const npmArguments = ['ci', '--omit=dev', '--no-audit', '--no-fund'];
  // On Windows validate the launcher's first-install path once, then its reuse path on startup.
  await run(process.platform === 'win32' ? process.execPath : 'npm', process.platform === 'win32'
    ? [join(cwd, 'dist/scripts/windows-launcher.js'), '--install-dependencies'] : npmArguments,
  { cwd, env, timeout: 240000, maxBuffer: 2 * 1024 * 1024 });
  evidence.productionInstall = true;
  assert((await lstat(join(cwd, 'node_modules'))).isDirectory());
  assert(!(await lstat(join(cwd, 'node_modules'))).isSymbolicLink());
  await assert.rejects(lstat(join(cwd, 'node_modules/vite')), { code: 'ENOENT' });
  if (process.platform === 'win32' && process.env.QQ_BRIDGE_FRAMEWORK_RELEASE_WINDOWS_SMOKE === '1') {
    checkpoint('windows-chat-and-acl');
    for (const args of [
      ['--test', 'test/windows-file-security.test.ts', 'test/windows-acl-worker.test.ts'],
      ['--test', '--test-name-pattern=real local WS text passes through native host', 'test/native-chat-runtime.test.ts']
    ]) {
      const result = await run(process.execPath, args, { cwd, env, timeout: 45000, maxBuffer: 256 * 1024 });
      console.log(result.stdout.trim());
      assert.match(result.stdout, /pass [1-9]/);
    }
    evidence.windowsChatAndAcl = true;
  }
  checkpoint('previous-release-upgrade');
  await verifyFrameworkUpgrade(cwd);
  // Removing original TS proves that the runtime package actually uses compiled backend/worker files.
  await rm(join(cwd, 'src'), { recursive: true });
  await rm(join(cwd, 'scripts'), { recursive: true });
  checkpoint('bundled-sdk-extension');
  const extensionCheck=await run(process.execPath,['--input-type=module','-e',"import {verifyManagedExtensionInstallation} from './dist/scripts/verify-managed-extension-installation.js'; await verifyManagedExtensionInstallation(process.cwd());"],{cwd,env,timeout:240000,maxBuffer:262144});
  console.log(extensionCheck.stdout.trim());
  evidence.managedExtensionSdk=true;
  checkpoint('native-rendering');
  await run(process.execPath, ['--input-type=module', '-e', String.raw`
    import assert from 'node:assert/strict';
    import sharp from 'sharp';
    import { createBuiltinMarkdownRenderer } from './dist/src/rendering/builtin-markdown.js';
    import { createBuiltinHtmlRenderer } from './dist/src/rendering/builtin-html.js';
    const pages = await createBuiltinMarkdownRenderer({ timeoutMs: 30000 }).render({ markdown: '# 安装验证\n\n中文字体与公式 $1+1=2$。' });
    assert(pages.length > 0);
    const metadata = await sharp(pages[0].png).metadata();
    assert.equal(metadata.format, 'png'); assert(metadata.width > 0);
    const html = await createBuiltinHtmlRenderer({ directory: './data/html-install-check' }).render({ html: '<h1 style="color:#7134c4">HTML 安装验证</h1><p>中文与彩色排版。</p>' });
    assert.equal(html.length, 1); assert.equal((await sharp(html[0].png).metadata()).format, 'png');
  `], { cwd, env, timeout: 45000, maxBuffer: 65536 });
  evidence.nativeRenderingAndFonts = true;
  checkpoint('initialization');
  const cli = join(cwd, 'dist/scripts/cli.js');
  const adminPort = await port();
  let gatewayPort = await port();
  while (gatewayPort === adminPort) gatewayPort = await port();
  await run(process.execPath, [cli, 'init', '--port', String(adminPort)], { cwd, env, timeout: 90000 });
  evidence.initialized = true;
  const configuration = join(cwd, 'data/admin/config.json');
  const saved: unknown = JSON.parse(await readFile(configuration, 'utf8'));
  assert(isRecord(saved) && typeof saved.gatewayConfiguration === 'string' && typeof saved.tokenFile === 'string');
  const gatewayFile = resolve(dirname(configuration), saved.gatewayConfiguration);
  const gateway: unknown = JSON.parse(await readFile(gatewayFile, 'utf8'));
  assert(isRecord(gateway));
  await writeFile(gatewayFile, JSON.stringify({ ...gateway, port: gatewayPort, upstreamEndpoint: 'http://127.0.0.1:9' }), { mode: 0o600 });
  const original = await readFile(configuration, 'utf8');
  await assert.rejects(run(process.execPath, [cli, 'init'], { cwd, env, timeout: 30000 }));
  assert.equal(await readFile(configuration, 'utf8'), original);
  const origin = `http://127.0.0.1:${adminPort}`;
  async function launch(): Promise<void> {
    child = spawn(process.execPath, process.platform === 'win32' ? [join(cwd, 'dist/scripts/windows-launcher.js')] : [cli, 'serve'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    childExit = once(child, 'exit');
    void childExit.catch(() => {});
    for (const stream of [child.stdout, child.stderr]) stream?.on('data', chunk => { diagnostics = (diagnostics + String(chunk)).slice(-16000); });
    for (let attempt = 0; attempt < 450; attempt++) {
      assert(child.exitCode === null && child.signalCode === null, diagnostics.slice(-4000));
      try {
        const response = await fetch(origin + '/health', { signal: AbortSignal.timeout(1000) });
        if (response.ok) { const value: unknown = await response.json(); if (isRecord(value) && value.mode === 'framework') return; }
      } catch {}
      await delay(200);
    }
    assert.fail('Compiled runtime did not become ready: ' + diagnostics.slice(-4000));
  }
  checkpoint('backend-and-webui');
  await launch();
  const html = await fetch(origin, { signal: AbortSignal.timeout(10000) });
  assert.equal(html.status, 200); assert.match(await html.text(), /app\.js/);
  const assets = (await readdir(join(cwd, 'dist/admin-web'))).filter(name => /\.(?:js|css|svg)$/.test(name));
  for (const name of assets) {
    const response = await fetch(`${origin}/${name}`, { signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200, name);
    assert.equal(hash(new Uint8Array(await response.arrayBuffer())), hash(await readFile(join(cwd, 'dist/admin-web', name))), name);
  }
  evidence.webAssetsVerified = assets.length;
  const initialized = await fetch(origin + '/api/setup', { method: 'POST', headers: { origin, 'content-type': 'application/json' },
    body: '{}', signal: AbortSignal.timeout(10000) });
  assert.equal(initialized.status, 200);
  const token = (await readFile(resolve(dirname(configuration), saved.tokenFile), 'utf8')).trim();
  assert(token.length >= 24);
  // A fresh install has a working admin/gateway but no QQ or DSH configured.
  // Require the real diagnostic exit status and independently verify every domain.
  const status = await run(process.execPath, [cli, 'status', '--json'], { cwd, env, timeout: 15000 })
    .then(result => ({ stdout: result.stdout, code: 0 }), (error: unknown) => {
      assert(error instanceof Error && 'code' in error && error.code === 1
        && 'stdout' in error && typeof error.stdout === 'string', 'Status failed without a diagnostic result');
      return { stdout: error.stdout, code: 1 };
    });
  assert.equal(status.code, 1, 'An unconfigured chat must not be reported as healthy');
  const report: unknown = JSON.parse(status.stdout);
  assert(isRecord(report) && report.schema === 1 && report.healthy === false && Array.isArray(report.checks));
  assert.deepEqual(report.checks.map((check: unknown) => {
    assert(isRecord(check) && typeof check.id === 'string' && typeof check.state === 'string');
    return { id: check.id, state: check.state };
  }), [{ id: 'admin', state: 'ready' }, { id: 'gateway', state: 'ready' }, { id: 'dsh', state: 'disabled' },
    { id: 'protocol', state: 'unavailable' }, { id: 'chat', state: 'blocked' }, { id: 'application', state: 'ready' }]);
  checkpoint('restart');
  await stop();
  evidence.initializationAndRestart = true;
  checkpoint('missing-asset-rejection');
  await launch();
  assert.equal((await readFile(resolve(dirname(configuration), saved.tokenFile), 'utf8')).trim(), token);
  await stop();
  await rm(join(cwd, 'dist/admin-web/app.js'));
  await assert.rejects(run(process.execPath, [cli, 'start'], { cwd, env, timeout: 15000 }),
    error => error instanceof Error && 'stderr' in error && String(error.stderr).includes('发行包网页资源缺失'));
  completed = true;
  console.log(JSON.stringify({ ...evidence, archiveMembers: members.length,
    productionInstall: true, compiledBackendWithoutSources: true, initializationAndRestart: true,
    nativeRenderingAndFonts: true, actualQqMessagesSent: 0 }));
} finally {
  try { await stop(); } finally {
    await rm(directory, { recursive: true, force: true });
    if (process.env.QQ_BRIDGE_FRAMEWORK_RELEASE_REPORT) await writeFile(process.env.QQ_BRIDGE_FRAMEWORK_RELEASE_REPORT,
      JSON.stringify({ ...evidence, phase, completed, expectedSourceCommit: expectedSourceCommit ?? null, actualQqMessagesSent: 0 }, null, 2) + '\n');
  }
}
