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
import { createProductUpdateRuntime } from './product-update.ts';
import { readProductUpdate } from '../src/host/product-update.ts';
import { readFrameworkUpdateState, writeFrameworkUpdateState } from '../src/host/framework-update-state.ts';

export async function assertStopped(root: string): Promise<void> {
  for (const filename of new Set([resolveRuntimeConfiguration(root, undefined, process.env, root),
    join(root, 'data/admin/config.json'), join(root, 'data/live/framework-admin.json'),
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
  if (source === '--rollback' || source === '--reconcile') {
    if (!flag || extra.length) throw new Error('用法：qbf-cli update --rollback <事务编号>');
    if (await readProductUpdate(root, flag)) {
      await assertStopped(root);
      const runtime = await createProductUpdateRuntime({ root, stop: () => assertStopped(root), start: async () => {}, verify: async () => {} });
      try {
        const result = await runtime.updater.rollback(flag);
        const web = await readFrameworkUpdateState(root);
        if (result.phase === 'rolled-back' && web?.id === flag && ['applying', 'verifying', 'unknown'].includes(web.state)) {
          await writeFrameworkUpdateState(root, { ...web, state: 'rolled-back', transactionId: result.runtimeTransactionId,
            error: 'update_reconciled_to_previous', updatedAt: Date.now() });
        }
        output(`整套更新 ${result.id}：${result.phase}。配置与会话保留，当前核验范围为已安装程序及组件，聊天待启动后核验。`);
        if (result.phase !== 'rolled-back') throw new Error('整套恢复结果待核对，请保留原操作编号并处理组件状态。');
      } finally { await runtime.close(); }
      return;
    }
    if (source === '--reconcile') throw new Error('未找到原整套更新记录，未重复更新。');
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
    const id = randomUUID();
    output(`整套更新操作编号：${id}`);
    const runtime = await createProductUpdateRuntime({ root, source: stage, allowMajor: flag === '--allow-major',
      stop: () => assertStopped(root), start: async () => {}, verify: async () => {} });
    try {
      const result = await runtime.updater.execute({ id, version: distribution.version, wasRunning: false });
      output(`整套更新 ${id}：${result.phase}。程序与桥接组件按同一发行清单核验，配置、会话和私人文件保留。请启动框架核对聊天与助手状态。`);
      if (result.phase !== 'completed') throw new Error(`更新未完成，使用 qbf-cli update --reconcile ${id} 核对原操作。`);
    } finally { await runtime.close(); }
  } finally { await rm(stage, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [option, target, ...rest] = process.argv.slice(2);
  if (option !== '--target' || !target) throw new Error('用法：node 新包/dist/scripts/update-framework.js --target 旧安装目录 [--allow-major]');
  const source = fileURLToPath(new URL(import.meta.url.endsWith('.js') ? '../../' : '../', import.meta.url));
  await updateFrameworkCli(rest[0] === '--rollback' ? rest : [source, ...rest], await realpath(target), console.log);
}
