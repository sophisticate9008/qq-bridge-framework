import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isRecord } from '../src/core/values.ts';

const installOnly = process.argv.length === 3 && process.argv[2] === '--install-dependencies';
if (process.argv.length > 2 && !installOnly) throw new Error('用法：windows-launcher [--install-dependencies]');
const root = fileURLToPath(new URL('../../', import.meta.url));
const cli = join(root, 'dist/scripts/cli.js');
const configuration = join(root, 'runtime/admin/config.json');
const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
if (process.platform !== 'win32' || major < 24 || major === 24 && minor < 12)
  throw new Error('Windows 启动器需要 Node.js 24.12 或更新版本。');
if (!existsSync(join(root, 'distribution.json'))) throw new Error('请从完整框架压缩包启动。');
process.chdir(root);
let child: ChildProcess | undefined;
let stopping = false;
function stop(): void {
  stopping = true;
  if (child?.connected) child.send({ type: 'qqbridge.shutdown' });
}
process.on('message', (message: unknown) => { if (isRecord(message) && message.type === 'qqbridge.shutdown') stop(); });
if (process.send) process.once('disconnect', stop);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, stop);
async function run(args: readonly string[], ipc = false): Promise<void> {
  if (stopping) return;
  await new Promise<void>((resolve, reject) => {
    child = spawn(process.execPath, [...args], { cwd: root, windowsHide: false,
      stdio: ipc ? ['inherit', 'inherit', 'inherit', 'ipc'] : 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      child = undefined;
      if (code === 0) resolve();
      else reject(new Error(`启动步骤未完成（${code ?? signal}），请检查上方日志。`));
    });
  });
}
try {
  const marker = join(root, 'node_modules/.qqbridge-windows-dependencies.json');
  const signature = readFileSync(join(root, 'package-lock.json'), 'utf8');
  const { createHash } = await import('node:crypto');
  const key = createHash('sha256').update(signature).update(process.versions.modules).update(process.arch).digest('hex');
  let installed = false;
  try { const value: unknown = JSON.parse(readFileSync(marker, 'utf8')); installed = isRecord(value) && value.key === key; } catch {}
  if (!installed) {
    console.log('首次启动：安装锁定的生产依赖，请保持网络连接。');
    await run([join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), 'ci', '--omit=dev', '--no-audit', '--no-fund']);
    if (!stopping) { const { writeFileSync } = await import('node:fs'); writeFileSync(marker, JSON.stringify({ key })); }
  }
  if (!installOnly && !existsSync(configuration)) await run([cli, 'init']);
  if (!installOnly && !stopping) {
    console.log('启动后请打开日志中的本机网页地址；按 Ctrl+C 正常退出。');
    await run([cli, 'serve'], true);
  }
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : '启动失败，请检查日志。');
  process.exitCode = 1;
}

if (process.connected) process.disconnect();
