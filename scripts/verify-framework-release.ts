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
import { assertFrameworkReleasePath } from './framework-release.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const source: unknown = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
assert(isRecord(source) && typeof source.version === 'string');
const version = source.version, prefix = `qq-bridge-framework-${version}`;
const artifact = join(root, 'runtime/releases', `v${version}`, `${prefix}.tar.gz`);
const directory = await mkdtemp(join(tmpdir(), 'qqbf-runtime-consumer-'));
const run = promisify(execFile);
const env: NodeJS.ProcessEnv = { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' };
delete env.QQ_BRIDGE_FRAMEWORK_CONFIG;
let child: ChildProcess | undefined, childExit: Promise<unknown[]> | undefined, diagnostics = '';
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
    current.kill('SIGTERM');
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
  const listing = await run('tar', ['-tzf', artifact], { maxBuffer: 8 * 1024 * 1024 });
  const members = listing.stdout.trim().split('\n');
  for (const member of members) {
    assert(member.startsWith(prefix + '/'));
    const filename = member.slice(prefix.length + 1).replace(/\/$/, '');
    if (filename) assertFrameworkReleasePath(filename);
  }
  const verbose = await run('tar', ['-tvzf', artifact], { maxBuffer: 8 * 1024 * 1024 });
  assert(verbose.stdout.trim().split('\n').every(line => line.startsWith('-') || line.startsWith('d')));
  await run('tar', ['-xzf', artifact, '-C', directory]);
  const cwd = join(directory, prefix);
  const manifest: unknown = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8'));
  assert(isRecord(manifest) && isRecord(manifest.scripts));
  assert.equal(manifest.version, version);
  assert.equal(manifest.scripts.start, 'node dist/scripts/cli.js start');
  const distribution: unknown = JSON.parse(await readFile(join(cwd, 'distribution.json'), 'utf8'));
  assert(isRecord(distribution) && distribution.version === version && Array.isArray(distribution.components));
  assert.equal(distribution.sourceModified, false);
  if (process.env.GITHUB_SHA) assert.equal(distribution.sourceCommit, process.env.GITHUB_SHA);
  for (const item of distribution.components) {
    assert(isRecord(item) && typeof item.filename === 'string' && typeof item.sha256 === 'string');
    assert.equal(hash(await readFile(join(cwd, 'components', item.filename))), item.sha256);
  }
  console.log('Installing locked production dependencies in an isolated extracted archive.');
  await run('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd, env, timeout: 240000, maxBuffer: 2 * 1024 * 1024 });
  assert((await lstat(join(cwd, 'node_modules'))).isDirectory());
  assert(!(await lstat(join(cwd, 'node_modules'))).isSymbolicLink());
  await assert.rejects(lstat(join(cwd, 'node_modules/vite')), { code: 'ENOENT' });
  // Removing original TS proves that the runtime package actually uses compiled backend/worker files.
  await rm(join(cwd, 'src'), { recursive: true });
  await rm(join(cwd, 'scripts'), { recursive: true });
  const cli = join(cwd, 'dist/scripts/cli.js');
  const adminPort = await port();
  let gatewayPort = await port();
  while (gatewayPort === adminPort) gatewayPort = await port();
  await run(process.execPath, [cli, 'init', '--port', String(adminPort)], { cwd, env, timeout: 30000 });
  const configuration = join(cwd, 'runtime/admin/config.json');
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
    child = spawn(process.execPath, [cli, 'start'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    childExit = once(child, 'exit');
    void childExit.catch(() => {});
    for (const stream of [child.stdout, child.stderr]) stream?.on('data', chunk => { diagnostics = (diagnostics + String(chunk)).slice(-16000); });
    for (let attempt = 0; attempt < 150; attempt++) {
      assert(child.exitCode === null && child.signalCode === null, diagnostics.slice(-4000));
      try {
        const response = await fetch(origin + '/health', { signal: AbortSignal.timeout(1000) });
        if (response.ok) { const value: unknown = await response.json(); if (isRecord(value) && value.mode === 'framework') return; }
      } catch {}
      await delay(200);
    }
    assert.fail('Compiled runtime did not become ready: ' + diagnostics.slice(-4000));
  }
  await launch();
  const html = await fetch(origin, { signal: AbortSignal.timeout(10000) });
  assert.equal(html.status, 200); assert.match(await html.text(), /app\.js/);
  const assets = (await readdir(join(cwd, 'dist/admin-web'))).filter(name => /\.(?:js|css|svg)$/.test(name));
  for (const name of assets) {
    const response = await fetch(`${origin}/${name}`, { signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200, name);
    assert.equal(hash(new Uint8Array(await response.arrayBuffer())), hash(await readFile(join(cwd, 'dist/admin-web', name))), name);
  }
  const initialized = await fetch(origin + '/api/setup', { method: 'POST', headers: { origin, 'content-type': 'application/json' },
    body: '{}', signal: AbortSignal.timeout(10000) });
  assert.equal(initialized.status, 200);
  const token = (await readFile(resolve(dirname(configuration), saved.tokenFile), 'utf8')).trim();
  assert(token.length >= 24);
  const status = await run(process.execPath, [cli, 'status'], { cwd, env, timeout: 15000 });
  assert.match(status.stdout, /运行正常/);
  await run(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import sharp from 'sharp';
    import { createBuiltinMarkdownRenderer } from './dist/src/rendering/builtin-markdown.js';
    const pages = await createBuiltinMarkdownRenderer({ timeoutMs: 30000 }).render({ markdown: '# 安装验证\n\n中文字体与公式 $1+1=2$。' });
    assert(pages.length > 0);
    const metadata = await sharp(pages[0].png).metadata();
    assert.equal(metadata.format, 'png'); assert(metadata.width > 0);
  `], { cwd, env, timeout: 45000, maxBuffer: 65536 });
  await stop();
  await launch();
  assert.equal((await readFile(resolve(dirname(configuration), saved.tokenFile), 'utf8')).trim(), token);
  await stop();
  await rm(join(cwd, 'dist/admin-web/app.js'));
  await assert.rejects(run(process.execPath, [cli, 'start'], { cwd, env, timeout: 15000 }),
    error => error instanceof Error && 'stderr' in error && String(error.stderr).includes('发行包网页资源缺失'));
  console.log(JSON.stringify({ version, archiveMembers: members.length, webAssetsVerified: assets.length,
    productionInstall: true, compiledBackendWithoutSources: true, initializationAndRestart: true,
    nativeRenderingAndFonts: true, actualQqMessagesSent: 0 }));
} finally { await stop(); await rm(directory, { recursive: true, force: true }); }
