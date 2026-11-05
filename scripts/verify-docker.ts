import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { isRecord } from '../src/contracts/values.ts';

const run = promisify(execFile), root = process.cwd();
const manifest: unknown = JSON.parse(await readFile('package.json', 'utf8'));
assert(isRecord(manifest) && typeof manifest.version === 'string');
const version = manifest.version, arch = process.arch === 'x64' ? 'amd64' : process.arch;
assert(process.platform === 'linux' && ['amd64', 'arm64'].includes(arch));
const image = `qq-bridge-framework:${version}`, name = `qbf-ci-${randomUUID()}`, volume = `${name}-data`, privateVolume = `${name}-private`;
const stage = resolve('runtime/docker-build');
await mkdir(stage, { recursive: true });
await copyFile('Dockerfile', join(stage, 'Dockerfile'));
await copyFile(`runtime/releases/v${version}/qq-bridge-framework-${version}.tar.gz`, join(stage, 'framework.tar.gz'));
const docker = (args: string[], timeout = 60_000) => run('docker', args, { timeout, maxBuffer: 1024 * 1024 });
await docker(['build', '--tag', image, stage], 600_000);
let origin = '';
async function launch() {
  await docker(['run', '--detach', '--init', '--name', name, '--publish', '127.0.0.1::3210',
    '--mount', `type=volume,src=${volume},dst=/opt/qbf/runtime`, '--mount', `type=volume,src=${privateVolume},dst=/opt/qbf/private`, image]);
  const port = (await docker(['port', name, '3210/tcp'])).stdout.trim().split(':').at(-1);
  assert(port && /^\d+$/.test(port)); origin = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 90; attempt++) {
    try { if ((await fetch(origin + '/health')).ok) return; } catch {}
    await delay(1000);
  }
  throw new Error('docker_start_failed');
}
try {
  await launch();
  assert.equal((await fetch(origin)).status, 200);
  assert.equal((await fetch(origin + '/app.js')).status, 200);
  assert.equal((await fetch(origin + '/api/framework/update')).status, 401);
  await docker(['exec', name, 'node', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import sharp from 'sharp';
    import { writeFile } from 'node:fs/promises';
    import { createBuiltinMarkdownRenderer } from './dist/src/rendering/builtin-markdown.js';
    import { createBuiltinHtmlRenderer } from './dist/src/rendering/builtin-html.js';
    assert.equal(process.getuid(), 1000);
    const markdown = await createBuiltinMarkdownRenderer({ timeoutMs: 30000 }).render({ markdown: '# 容器验收\\n中文字体 $1+1=2$' });
    assert.equal((await sharp(markdown[0].png).metadata()).format, 'png');
    const html = await createBuiltinHtmlRenderer({ directory: './runtime/render-check' }).render({ html: '<h1>容器中文</h1>' });
    assert.equal((await sharp(html[0].png).metadata()).format, 'png');
    await writeFile('./runtime/upgrade-sentinel', 'keep-runtime');
    await writeFile('./private/upgrade-sentinel', 'keep-private');
  `], 60_000);
  const before = (await docker(['exec', name, 'cat', '/opt/qbf/runtime/admin/config.json'])).stdout;
  await docker(['stop', '--time', '40', name]);
  const stopped: unknown = JSON.parse((await docker(['inspect', name])).stdout);
  assert(Array.isArray(stopped) && isRecord(stopped[0]) && isRecord(stopped[0].State) && stopped[0].State.ExitCode === 0);
  await docker(['rm', name]);
  await launch();
  assert.equal((await docker(['exec', name, 'cat', '/opt/qbf/runtime/admin/config.json'])).stdout, before);
  assert.equal((await docker(['exec', name, 'cat', '/opt/qbf/runtime/upgrade-sentinel'])).stdout, 'keep-runtime');
  assert.equal((await docker(['exec', name, 'cat', '/opt/qbf/private/upgrade-sentinel'])).stdout, 'keep-private');
  await writeFile('docker-result.json', JSON.stringify({ version, arch, sourceCommit: process.env.GITHUB_SHA,
    startup: true, webui: true, nativeRendering: true, nonRoot: true, recreatePreservesData: true, actualQqMessagesSent: 0 }));
  console.log(`Docker ${arch}: startup, WebUI, native rendering and volume reuse passed.`);
} finally {
  await docker(['logs', name]).then(result => writeFile('docker-runtime.log', result.stdout + result.stderr)).catch(() => undefined);
  await docker(['rm', '--force', name]).catch(() => undefined);
  await docker(['volume', 'rm', volume, privateVolume]).catch(() => undefined);
}
