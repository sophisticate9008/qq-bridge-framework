import { execFile } from 'node:child_process';
import { cp, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { connect } from 'node:net';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isRecord } from '../src/contracts/values.ts';
import { applyFrameworkUpdate, rollbackFrameworkUpdate, verifyFrameworkDistribution } from '../src/host/framework-updater.ts';
import { loadGatewayAdminConfiguration } from '../src/admin/gateway.ts';
import { loadOneBotGatewayConfiguration } from '../src/host/onebot-gateway.ts';
import { resolveRuntimeConfiguration } from './runtime-configuration.ts';

async function assertStopped(root: string): Promise<void> {
  for (const filename of new Set([resolveRuntimeConfiguration(root, undefined, process.env, root),
    join(root, 'runtime/admin/config.json'), join(root, 'runtime/live/framework-admin.json')])) {
    if (!existsSync(filename)) continue;
    const config = loadGatewayAdminConfiguration(filename);
    const gateway = loadOneBotGatewayConfiguration(config.gatewayConfiguration);
    for (const endpoint of [{ host: config.host, port: config.port }, { host: '127.0.0.1', port: gateway.port }]) {
      const closed = await new Promise<boolean>(resolve => {
        const host = endpoint.host === '0.0.0.0' ? '127.0.0.1' : endpoint.host === '::' ? '::1' : endpoint.host;
        const socket = connect({ host, port: endpoint.port });
        socket.setTimeout(2000);
        socket.once('connect', () => { socket.destroy(); resolve(false); });
        socket.once('timeout', () => { socket.destroy(); resolve(false); });
        socket.once('error', error => { socket.destroy(); resolve(isRecord(error) && error.code === 'ECONNREFUSED'); });
      });
      if (!closed) throw new Error('请先停止框架宿主及网关后更新，端口尚未确认关闭。');
    }
  }
}
export async function updateFrameworkCli(args: readonly string[], root: string, output: (message: string) => void): Promise<void> {
  const [source, flag, ...extra] = args;
  if (source === '--rollback') {
    if (!flag || extra.length) throw new Error('用法：qbf-cli update --rollback <事务编号>');
    await assertStopped(root); await rollbackFrameworkUpdate(root, flag); output('程序已回滚，运行数据保留。'); return;
  }
  if (!source || extra.length || flag !== undefined && flag !== '--allow-major') throw new Error('用法：qbf-cli update <解压后的新包目录> [--allow-major]');
  await assertStopped(root);
  const canonical = await realpath(resolve(source));
  const distribution = await verifyFrameworkDistribution(canonical);
  const stage = join(dirname(root), `.qbf-offline-${randomUUID()}`);
  await mkdir(stage, { mode: 0o700 });
  try {
    // Copy only the verified inventory. User-supplied directories may contain unrelated local data.
    for (const file of [...distribution.files.map(file => file.path), 'distribution.json']) {
      await mkdir(dirname(join(stage, file)), { recursive: true });
      await cp(join(canonical, file), join(stage, file));
    }
    const npm = process.platform === 'win32' ? process.execPath : 'npm';
    const npmArgs = [...(process.platform === 'win32' ? [join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')] : []), 'ci', '--omit=dev', '--no-audit', '--no-fund'];
    await promisify(execFile)(npm, npmArgs, { cwd: stage, timeout: 300_000, maxBuffer: 1024 * 1024 });
    await assertStopped(root);
    const id = await applyFrameworkUpdate({ source: stage, target: root, dependencies: true, allowMajor: flag === '--allow-major' });
    output(`已更新到 ${distribution.version}，配置、会话和私人文件保留。回滚事务：${id}。请启动框架并核对聊天状态。`);
  } finally { await rm(stage, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [option, target, ...rest] = process.argv.slice(2);
  if (option !== '--target' || !target) throw new Error('用法：node 新包/dist/scripts/update-framework.js --target 旧安装目录 [--allow-major]');
  const source = fileURLToPath(new URL(import.meta.url.endsWith('.js') ? '../../' : '../', import.meta.url));
  await updateFrameworkCli(rest[0] === '--rollback' ? rest : [source, ...rest], await realpath(target), console.log);
}
