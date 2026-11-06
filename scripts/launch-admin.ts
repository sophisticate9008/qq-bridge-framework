import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

// The launcher belongs to the program; only the private deployment selection is data.
function launch(): void {
  const args = process.argv.slice(2);
  assert(args.length === 2 && args[0] === '--config' && isAbsolute(args[1]));
  const configurationFilename = resolve(args[1]);
  const selectionFile = join(dirname(configurationFilename), 'admin-deployment.json');
  const file = openSync(selectionFile, constants.O_RDONLY | constants.O_NOFOLLOW);
  let selected: unknown;
  try {
    const info = fstatSync(file);
    assert(info.isFile() && info.nlink === 1 && info.size <= 16_384
      && (!process.getuid || info.uid === process.getuid())
      && (process.platform === 'win32' || (info.mode & 0o077) === 0));
    selected = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } finally { closeSync(file); }
  assert(typeof selected === 'object' && selected !== null
    && 'schema' in selected && selected.schema === 1
    && 'configurationFilename' in selected && selected.configurationFilename === configurationFilename
    && 'entry' in selected && typeof selected.entry === 'string' && isAbsolute(selected.entry)
    && 'sha256' in selected && typeof selected.sha256 === 'string' && /^[a-f0-9]{64}$/.test(selected.sha256));
  assert.equal(createHash('sha256').update(readFileSync(selected.entry)).digest('hex'), selected.sha256);
  const child = spawn(process.execPath, [selected.entry, '--config', configurationFilename], {
    cwd: dirname(selected.entry), stdio: 'inherit', env: process.env,
  });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => { child.kill(signal); });
  child.once('error', () => { console.error('管理服务启动失败，请查看组件日志。'); process.exitCode = 1; });
  child.once('exit', code => { process.exitCode = code ?? 1; });
}

try { launch(); } catch {
  console.error('管理服务部署入口核验失败，请检查私有部署选择、配置路径与程序校验值。');
  process.exitCode = 1;
}
