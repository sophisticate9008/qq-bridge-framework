import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import { createDshJsonRpcPort } from '../src/adapters/dsh-jsonrpc.ts';
import { createDshAuthenticationOptions } from '../src/adapters/dsh-authentication.ts';
import { discoverLocalDsh } from '../src/host/local-dsh-discovery.ts';
import { discoverLocalDshDeployment } from '../src/host/local-dsh-deployment.ts';
import { prepareBridgeArchive } from '../src/host/bridge-archive.ts';
import { createBridgeManager, type BridgeOperation } from '../src/host/bridge-manager.ts';
import { isNativeApplicationId } from '../src/contracts/native-application.ts';
import { releaseVersion } from '../src/contracts/framework-release.ts';
import { errorCode } from '../src/core/values.ts';

const help = `桥接组件管理（独立于框架更新）
qbf-cli bridge status
qbf-cli bridge download <版本> [--from <已解压完整包>]
qbf-cli bridge install <版本> [--from <已解压完整包>] [--operation-id <UUID>]
qbf-cli bridge update <版本> [--from <已解压完整包>] [--operation-id <UUID>]
qbf-cli bridge rollback <旧版本> [--from <已解压完整包>] [--operation-id <UUID>]
qbf-cli bridge remove [--operation-id <UUID>]
qbf-cli bridge reconcile <原操作UUID>

默认自动发现本机 DSH。高级接入同时指定 --home <DSH_HOME绝对目录> 和 --endpoint <本机DSH地址>。
归档保存在 DSH_HOME/packages/qq-bridge-framework，由 DSH 原生插件管理器安装、启用和移除。
操作不会重启 DSH 或 QQ。restart-required 表示需要在 DSH 中完成重载，不能当作已加载。
旧手工加载与目录链接先按迁移说明处理；响应未知时用原操作编号 reconcile，不重复安装。`;

export function parseBridgeArguments(args: readonly string[]) {
  if (!args.length || args.length === 1 && ['help', '--help', '-h'].includes(args[0]!)) return null;
  const [action, ...rest] = args;
  if (!['status', 'download', 'install', 'update', 'rollback', 'remove', 'reconcile'].includes(action ?? '')) throw new Error('bridge_arguments_invalid');
  const values = new Map<string, string>(), positionals: string[] = [];
  for (let index = 0; index < rest.length; index++) {
    const value = rest[index]!;
    if (!value.startsWith('-')) { positionals.push(value); continue; }
    if (!['--home', '--endpoint', '--from', '--operation-id'].includes(value) || values.has(value)
      || !rest[index + 1] || rest[index + 1]!.startsWith('-')) throw new Error('bridge_arguments_invalid');
    values.set(value, rest[++index]!);
  }
  const versioned = ['download', 'install', 'update', 'rollback'].includes(action!);
  if (versioned ? positionals.length !== 1 || !releaseVersion(positionals[0]) || Number(positionals[0].split('.')[0]) < 2
    : action === 'reconcile' ? positionals.length !== 1 || !isNativeApplicationId(positionals[0]) : positionals.length !== 0) throw new Error('bridge_arguments_invalid');
  const home = values.get('--home'), endpoint = values.get('--endpoint'), from = values.get('--from'), id = values.get('--operation-id');
  if (!!home !== !!endpoint || home && !isAbsolute(home) || id && !isNativeApplicationId(id)
    || from && !versioned || id && ['status', 'download', 'reconcile'].includes(action!)) throw new Error('bridge_arguments_invalid');
  if (endpoint) {
    const address = new URL(endpoint);
    if (address.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(address.hostname)
      || address.username || address.password || address.search || address.hash) throw new Error('bridge_local_endpoint_required');
  }
  return { action: action!, value: positionals[0], home, endpoint, from, id };
}
const project = (operation: BridgeOperation | null) => operation ? {
  id: operation.id, action: operation.action, requestedVersion: operation.version, previousVersion: operation.previousVersion,
  state: operation.state, phase: operation.phase, restartRequired: operation.restartRequired, error: operation.error,
} : null;

export async function bridgeCli(args: readonly string[], output: (message: string) => void,
  failure: (message: string) => void): Promise<number> {
  let client: ReturnType<typeof createDshJsonRpcPort> | undefined;
  try {
    const parsed = parseBridgeArguments(args);
    if (!parsed) { output(help); return 0; }
    const signal = AbortSignal.timeout(600_000);
    const selected = parsed.home ? { endpoint: parsed.endpoint!, credentialsPath: join(await realpath(parsed.home), '.credentials.yaml') }
      : await discoverLocalDsh({ signal });
    const home = await realpath(dirname(selected.credentialsPath));
    if (!parsed.home) {
      const target = await discoverLocalDshDeployment({ endpoint: selected.endpoint, localCredentialsPath: selected.credentialsPath, signal });
      if (await realpath(dirname(target.credentialsPath)) !== home) throw new Error('bridge_local_target_mismatch');
    }
    const archive = (version: string, archiveSignal: AbortSignal) => prepareBridgeArchive({ home, version, signal: archiveSignal,
      ...(parsed.from && version === parsed.value ? { offlineRoot: resolve(parsed.from) } : {}) });
    if (parsed.action === 'download') {
      const filename = await archive(parsed.value!, signal);
      output(JSON.stringify({ state: 'downloaded-and-verified', version: parsed.value, archive: filename })); return 0;
    }
    client = createDshJsonRpcPort({ endpoint: selected.endpoint, timeoutMs: 300_000,
      ...createDshAuthenticationOptions({ endpoint: selected.endpoint, auth: '', localCredentialsPath: selected.credentialsPath }) });
    const port = client;
    const manager = createBridgeManager({ directory: join(home, 'storages', 'qbf-bridge-management'),
      port: port.pluginManagement, archive, describe: currentSignal => port.bridgePlugin!.describe(currentSignal) });
    if (parsed.action === 'status') {
      const bundle = await port.pluginManagement.read(signal);
      const live = await port.bridgePlugin!.describe(signal).catch(() => null);
      output(JSON.stringify({ installed: bundle.installed, enabled: bundle.enabled, installedVersion: bundle.version,
        loadedVersion: live?.pluginVersion ?? null, legacyInstallation: bundle.legacy, operation: project(await manager.read()) })); return 0;
    }
    const operationId = parsed.id ?? (parsed.action === 'reconcile' ? parsed.value! : randomUUID());
    output(JSON.stringify({ state: 'checking', operationId }));
    const operation = parsed.action === 'reconcile' ? await manager.reconcile(operationId, signal)
      : await manager.execute({ id: operationId, action: parsed.action as BridgeOperation['action'],
        version: parsed.action === 'remove' ? null : parsed.value! }, signal);
    output(JSON.stringify(project(operation)));
    return ['loaded', 'removed'].includes(operation.state) ? 0 : operation.state === 'restart-required' ? 2 : 1;
  } catch (error) {
    const selected = errorCode(error, error instanceof Error && /^[a-z][a-z0-9_]{0,95}$/.test(error.message) ? error.message : 'bridge_operation_failed');
    failure(`${selected}。请查看组件状态和原操作记录；安装、更新和移除仅针对桥接组件。`); return 1;
  } finally { await client?.close(); }
}
