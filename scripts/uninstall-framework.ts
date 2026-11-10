import { randomUUID } from 'node:crypto';
import { dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { realpath } from 'node:fs/promises';
import { isRecord } from '../src/contracts/values.ts';
import { isNativeApplicationId } from '../src/contracts/native-application.ts';
import { assertFrameworkProcessStopped } from '../src/host/framework-process-lease.ts';
import { uninstallProduct } from '../src/host/product-uninstall.ts';
import { unregisterProductCommands } from '../src/host/product-commands.ts';
import { readDocument, writeDocumentLocked } from '../src/storage/private-json.ts';
import { createProductUpdateRuntime } from './product-update.ts';
import { assertStopped } from './update-framework.ts';

async function unregisterServices(root: string) {
  const filename = join(root, 'data/live/services.json');
  const validate = (value: unknown) => {
    if (value === null) return null;
    if (!isRecord(value) || value.schema !== 1 || !isRecord(value.services)) throw new Error('product_service_registration_invalid');
    return value;
  };
  const prior = await readDocument(filename, null, validate);
  if (!prior.value || !isRecord(prior.value.services)) return;
  const services = { ...prior.value.services };
  for (const id of ['framework-admin', 'framework-gateway']) {
    const service = services[id];
    if (isRecord(service) && (service.cwd === root || typeof service.command === 'string' && service.command.startsWith(root + sep)
      || Array.isArray(service.args) && service.args.some(value => typeof value === 'string' && value.startsWith(root + sep)))) {
      services[id] = { ...service, managed: false, enabled: false };
    }
  }
  await writeDocumentLocked(dirname(filename), filename, prior.revision, null, validate, { ...prior.value, services });
}
export async function uninstallFrameworkCli(args: readonly string[], rootPath: string, output: (message: string) => void): Promise<void> {
  let keepBridge = false, id: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (value === '--framework') continue;
    if (value === '--keep-bridge' && !keepBridge) { keepBridge = true; continue; }
    if (value === '--operation-id' && !id && isNativeApplicationId(args[index + 1])) { id = args[++index]; continue; }
    throw new Error('用法：qbf-cli uninstall --framework [--keep-bridge] [--operation-id <原操作编号>]');
  }
  const root = await realpath(rootPath), operationId = id ?? randomUUID();
  output(`卸载操作编号：${operationId}`);
  const result = await uninstallProduct(root, { id: operationId, keepBridge }, {
    async assertStopped() { await assertStopped(root); await assertFrameworkProcessStopped(root, true); },
    async removeBridge(bridgeId) {
      const runtime = await createProductUpdateRuntime({ root, stop: () => assertStopped(root), start: async () => {}, verify: async () => {} });
      try { await runtime.removeBridge(bridgeId); } finally { await runtime.close(); }
    },
    async unregister() { await unregisterProductCommands(root); await unregisterServices(root); }
  });
  output(`卸载 ${result.phase}：已移除发行清单中的程序和登记的命令入口${keepBridge ? '，桥接插件按本次选择保留' : '及受管桥接插件'}。DSH、QQ、配置、会话、工作区和私人文件保留。`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [flag, root, ...args] = process.argv.slice(2);
  if (flag !== '--target' || !root) throw new Error('用法：node 新包/dist/scripts/uninstall-framework.js --target 原安装目录 [--keep-bridge] [--operation-id <原操作编号>]');
  await uninstallFrameworkCli(args, root, console.log);
}
