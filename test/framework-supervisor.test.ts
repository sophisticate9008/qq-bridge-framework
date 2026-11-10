import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { writeFrameworkUpdateState, readFrameworkUpdateState } from '../src/host/framework-update-state.ts';
import { frameworkUpdateStage } from '../scripts/framework-update-download.ts';
import { readProductUpdate } from '../src/host/product-update.ts';

const extension = import.meta.url.endsWith('.js') ? 'js' : 'ts';
const worker = fileURLToPath(new URL(`./fixtures/framework-supervisor-process.${extension}`, import.meta.url));
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 35_000;
  while (Date.now() < deadline) { if (await check()) return; await new Promise<void>(resolve => setTimeout(resolve, 50)); }
  throw new Error('supervisor fixture timed out');
}
async function stop(child: ChildProcess | undefined, signal: NodeJS.Signals = 'SIGTERM') {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'exit'); child.kill(signal); await closed;
}
async function fixture(candidate: 'working' | 'crash' | 'wait') {
  const directory = await mkdtemp(join(tmpdir(), 'qbf-supervisor-')), root = join(directory, 'installed'), id = randomUUID();
  const source = join(frameworkUpdateStage(root, id), 'qq-bridge-framework-2.0.1');
  const listener = createServer(); await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  const address = listener.address(); assert(address && typeof address !== 'string'); const port = address.port;
  await new Promise<void>(resolve => listener.close(() => resolve()));
  const configuration = join(root, 'data/admin/config.json'); await mkdir(dirname(configuration), { recursive: true, mode: 0o700 });
  await writeFile(join(dirname(configuration), 'token'), 'fixture-management-token-0123456789', { mode: 0o600 });
  await writeFile(join(dirname(configuration), 'gateway.json'), JSON.stringify({ port: 0, upstreamEndpoint: 'http://127.0.0.1:1',
    tokenFile: './token', storeFilename: './gateway.sqlite', allowedConversations: [], persona: { id: 'fixture', version: '1' } }), { mode: 0o600 });
  await writeFile(configuration, JSON.stringify({ host: '127.0.0.1', port, tokenFile: './token', gatewayConfiguration: './gateway.json' }), { mode: 0o600 });
  async function release(path: string, version: string, mode: typeof candidate) {
    const script = mode === 'crash' ? 'process.exit(1)' : `
      import {createServer} from 'node:http'; import {existsSync} from 'node:fs';
      const server=createServer((request,response)=>{
        if(request.url==='/api/setup' && ${JSON.stringify(mode)}==='wait' && !existsSync(${JSON.stringify(join(root, 'allow-ready'))})) {response.writeHead(503).end();return}
        response.setHeader('content-type','application/json');response.end(JSON.stringify(request.url==='/api/setup'?{initialized:true}:{currentVersion:${JSON.stringify(version)}}));
      });
      server.listen(${port},'127.0.0.1');
      const stop=()=>{server.closeAllConnections();server.close(()=>process.exit(0))};
      process.on('SIGTERM',stop);process.on('message',stop);process.on('disconnect',stop);
    `;
    const content = { 'package.json': JSON.stringify({ name: 'qq-bridge-framework', version, type: 'module' }), 'dist/scripts/cli.js': script,
      [`components/qq-bridge-framework-sdk-${version}.tgz`]: 'SDK inventory fixture',
      [`components/qq-bridge-framework-dsh-bridge-plugin-${version}.tgz`]: 'bridge inventory fixture' };
    const files = [];
    for (const [name, text] of Object.entries(content)) {
      await mkdir(dirname(join(path, name)), { recursive: true }); await writeFile(join(path, name), text);
      files.push({ path: name, sha256: createHash('sha256').update(text).digest('hex'), size: Buffer.byteLength(text), executable: false });
    }
    await mkdir(join(path, 'node_modules'));
    await writeFile(join(path, 'distribution.json'), JSON.stringify({ schema: 1, kind: 'framework-runtime', version,
      sourceCommit: 'a'.repeat(40), sourceModified: false, compatibility: { data: 1, overwrite: 1 }, files,
      components: files.filter(file => file.path.startsWith('components/')).map(file => ({ filename: file.path.slice(11), sha256: file.sha256 })) }));
  }
  await release(root, '2.0.0', 'working'); await release(source, '2.0.1', candidate);
  let output = '';
  const start = () => {
    const child = spawn(process.execPath, [worker, root, configuration], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stderr!.on('data', bytes => { output += String(bytes); }); return child;
  };
  const online = async () => {
    try { const response = await fetch(`http://127.0.0.1:${port}/api/setup`, { signal: AbortSignal.timeout(300) }); await response.body?.cancel(); return response.ok; }
    catch { return false; }
  };
  const request = async () => {
    const at = Date.now(); await writeFrameworkUpdateState(root, { schema: 1, id, version: '2.0.1', state: 'ready',
      createdAt: at, updatedAt: at, error: null, transactionId: null }, true);
  };
  return { root, id, start, online, request, output: () => output, async dispose() {
    await rm(directory, { recursive: true, force: true }); await rm(frameworkUpdateStage(root, id), { recursive: true, force: true });
  } };
}
for (const mode of ['working', 'crash'] as const) test(`real supervisor ${mode === 'working' ? 'selects and verifies the new fixed entry' : 'restores and restarts the original program when the candidate exits'}`, { timeout: 60_000 }, async () => {
  const setup = await fixture(mode); let child: ChildProcess | undefined;
  try {
    child = setup.start(); await until(setup.online); await setup.request();
    await until(async () => ['completed', 'rolled-back'].includes((await readFrameworkUpdateState(setup.root))?.state ?? ''));
    const state = await readFrameworkUpdateState(setup.root);
    assert.equal(state?.state, mode === 'working' ? 'completed' : 'rolled-back', setup.output());
    assert.equal((await readProductUpdate(setup.root))?.phase, state?.state);
    assert.equal((JSON.parse(await readFile(join(setup.root, 'package.json'), 'utf8')) as { version: string }).version, mode === 'working' ? '2.0.1' : '2.0.0');
    assert.equal(await setup.online(), true);
  } finally { await stop(child); await setup.dispose(); }
});
test('a killed supervisor reopens the same product journal and restores the old complete combination before serving', { timeout: 90_000 }, async () => {
  const setup = await fixture('wait'); let child: ChildProcess | undefined;
  try {
    child = setup.start(); await until(setup.online); await setup.request();
    await until(async () => (await readProductUpdate(setup.root))?.phase === 'starting');
    await stop(child, 'SIGKILL'); await until(async () => !await setup.online());
    child = setup.start();
    await until(async () => (await readFrameworkUpdateState(setup.root))?.state === 'rolled-back');
    assert.equal((await readProductUpdate(setup.root))?.phase, 'rolled-back'); assert.equal(await setup.online(), true);
    assert.equal((JSON.parse(await readFile(join(setup.root, 'package.json'), 'utf8')) as { version: string }).version, '2.0.0');
  } finally { await stop(child); await setup.dispose(); }
});
