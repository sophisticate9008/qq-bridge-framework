import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isNativeApplicationId } from '../contracts/native-application.ts';
import { compareReleaseVersions, releaseVersion } from '../contracts/framework-release.ts';
import { frameworkUpdateDirectory, frameworkUpdateWasReceived, readFrameworkUpdateState, writeFrameworkUpdateState } from '../host/framework-update-state.ts';
import { ensurePrivateDirectory, withDirectoryWriteLock } from '../storage/private-json.ts';
import { AdminRequestError, type AdminRoute } from './server.ts';
import { frameworkInstallationRoot } from './framework-release.ts';
import { readProductUpdate } from '../host/product-update.ts';

export function createFrameworkUpdateRoutes(version: string): AdminRoute[] {
  const root = frameworkInstallationRoot(), directory = frameworkUpdateDirectory(root);
  const available = process.env.QQ_BRIDGE_FRAMEWORK_SUPERVISED === '1' && process.env.QQ_BRIDGE_FRAMEWORK_CONTAINER !== '1'
    && existsSync(join(root, 'distribution.json')) && !existsSync(join(root, '.git'));
  return [{ method: 'GET', pathname: '/api/framework/update', async handle() {
    const operation = await readFrameworkUpdateState(root), product = await readProductUpdate(root);
    return { schema: 1, available, operation: operation && product?.id === operation.id ? { ...operation, productPhase: product.phase } : operation };
  } }, { method: 'POST', pathname: '/api/framework/update', maxRequestBytes: 1024, async handle({ body, query, signal }) {
    if (query.size || !body || Object.keys(body).length !== 2 || !isNativeApplicationId(body.operationId) || !releaseVersion(body.version)) throw new AdminRequestError(400, 'update_request_invalid');
    if (!available) throw new AdminRequestError(409, 'update_supervisor_required');
    const id = body.operationId, targetVersion = body.version;
    if (compareReleaseVersions(targetVersion, version) <= 0 || targetVersion.split('.')[0] !== version.split('.')[0]) throw new AdminRequestError(409, 'update_version_incompatible');
    await ensurePrivateDirectory(directory);
    return withDirectoryWriteLock(directory, async () => {
      signal.throwIfAborted();
      const previous = await readFrameworkUpdateState(root);
      if (previous?.id === id) return { schema: 1, available, operation: previous };
      const product = await readProductUpdate(root);
      if (product && !['completed', 'rolled-back'].includes(product.phase)) throw new AdminRequestError(409, 'update_busy');
      if (await frameworkUpdateWasReceived(root, id)) throw new AdminRequestError(409, 'update_request_retired');
      if (previous && !['completed', 'failed', 'rolled-back'].includes(previous.state)) throw new AdminRequestError(409, 'update_busy');
      if ((await readdir(directory)).length >= 256) throw new AdminRequestError(409, 'update_history_full');
      const at = Date.now();
      const state = { schema: 1 as const, id, version: targetVersion, state: 'preparing' as const,
        createdAt: at, updatedAt: at, error: null, transactionId: null };
      await writeFile(join(directory, `${id}.received`), '', { flag: 'wx', mode: 0o600 });
      await writeFrameworkUpdateState(root, state, true);
      const child = spawn(process.execPath, [join(root, 'dist/scripts/framework-update-download.js'), root, id], { detached: true, stdio: 'ignore' });
      await new Promise<void>(resolve => {
        child.once('spawn', () => { child.unref(); resolve(); });
        child.once('error', () => { void writeFrameworkUpdateState(root, { ...state, state: 'failed', error: 'update_worker_start_failed', updatedAt: Date.now() }, true).catch(() => undefined).finally(resolve); });
      });
      return { schema: 1, available, operation: await readFrameworkUpdateState(root) };
    });
  } }];
}
