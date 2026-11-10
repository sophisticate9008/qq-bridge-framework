import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { isRecord } from '../contracts/values.ts';
import { isNativeApplicationId } from '../contracts/native-application.ts';
import { MAX_DISTRIBUTION_BYTES, parseFrameworkDistribution } from '../contracts/framework-distribution.ts';
import { verifyFrameworkDistribution } from './framework-updater.ts';
import { readProductUpdate, productUpdateDirectory } from './product-update.ts';
import { productUninstallPending, validateProductUninstall as validate, type ProductUninstall as Uninstall } from './product-uninstall-state.ts';
export { productUninstallPending } from './product-uninstall-state.ts';
import { readFrameworkUpdateState, writeFrameworkUpdateState } from './framework-update-state.ts';
import { ensurePrivateDirectory, readDocument, writeDocumentLocked } from '../storage/private-json.ts';
import { acquireProcessFileLock } from '../storage/process-file-lock.ts';

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
/** Only verified program inventory is removed. Data, workspaces, private extensions and unrelated files are retained. */
export async function uninstallProduct(rootPath: string, request: { readonly id: string; readonly keepBridge: boolean },
  ports: { readonly assertStopped: () => Promise<void>; readonly removeBridge: (id: string) => Promise<void>;
    readonly unregister: () => Promise<void> }): Promise<Uninstall> {
  if (!isNativeApplicationId(request.id)) throw new Error('product_uninstall_id_invalid');
  const root = await realpath(rootPath), directory = join(root, 'data/product-uninstalls');
  await ensurePrivateDirectory(directory);
  await ensurePrivateDirectory(productUpdateDirectory(root));
  const release = await acquireProcessFileLock(productUpdateDirectory(root), 'operation.lock');
  try {
    await ports.assertStopped();
    if (await lstat(join(root, '.git')).then(() => true, () => false)) throw new Error('product_uninstall_checkout_unsupported');
    const update = await readProductUpdate(root);
    if (update && !['completed', 'rolled-back'].includes(update.phase)) throw new Error('product_update_requires_reconciliation');
    const web = await readFrameworkUpdateState(root);
    if (web && ['preparing', 'ready'].includes(web.state)) await writeFrameworkUpdateState(root, { ...web, state: 'failed', error: 'update_cancelled_by_uninstall', updatedAt: Date.now() });
    else if (web && !['completed', 'failed', 'rolled-back'].includes(web.state)) throw new Error('product_update_requires_reconciliation');
    const filename = join(directory, `${request.id}.json`), snapshot = join(directory, `${request.id}.distribution.json`);
    let saved = await readDocument(filename, null, validate);
    let operation = saved.value;
    const save = async (value: Uninstall) => {
      await writeDocumentLocked(directory, filename, saved.revision, null, validate, value);
      saved = await readDocument(filename, null, validate); operation = value;
    };
    if (!operation) {
      if (await productUninstallPending(root)) throw new Error('product_uninstall_requires_reconciliation');
      await verifyFrameworkDistribution(root);
      const bytes = await readFile(join(root, 'distribution.json'));
      const file = await open(snapshot, 'wx', 0o600);
      try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      await save({ id: request.id, bridgeId: randomUUID(), keepBridge: request.keepBridge, manifestSha256: digest(bytes), phase: 'components' });
      const pointer = join(directory, 'current.json'), before = await readDocument(pointer, null, value => value as string | null);
      await writeDocumentLocked(directory, pointer, before.revision, null, value => value as string | null, request.id);
    }
    if (!operation || operation.keepBridge !== request.keepBridge) throw new Error('product_uninstall_intent_conflict');
    if (operation.phase === 'completed') return operation;
    const file = await open(snapshot, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes: Buffer;
    try {
      const metadata = await file.stat();
      if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > MAX_DISTRIBUTION_BYTES) throw new Error('product_uninstall_snapshot_invalid');
      bytes = await file.readFile();
    } finally { await file.close(); }
    if (digest(bytes) !== operation.manifestSha256) throw new Error('product_uninstall_snapshot_changed');
    const distribution = parseFrameworkDistribution(JSON.parse(bytes.toString('utf8')));
    if (!distribution) throw new Error('product_uninstall_snapshot_invalid');
    if (operation.phase === 'components') {
      if (!operation.keepBridge) await ports.removeBridge(operation.bridgeId);
      await save({ ...operation, phase: 'program' });
    }
    // Inspect every surviving file before removing any of this batch. Changed or linked files require review.
    const paths = [...distribution.files, { path: 'distribution.json', sha256: operation.manifestSha256 }];
    for (const entry of paths) {
      let path = root;
      for (const part of entry.path.split('/')) {
        path = join(path, part);
        const metadata = await lstat(path).catch(error => { if (isRecord(error) && error.code === 'ENOENT') return null; throw error; });
        if (metadata?.isSymbolicLink()) throw new Error('product_uninstall_symlink_rejected');
      }
      const metadata = await lstat(path).catch(() => null);
      if (metadata && (!metadata.isFile() || metadata.nlink !== 1 || digest(await readFile(path)) !== entry.sha256)) throw new Error('product_uninstall_program_changed');
    }
    const dependencies = await lstat(join(root, 'node_modules')).catch(() => null);
    if (dependencies && (!dependencies.isDirectory() || dependencies.isSymbolicLink())) throw new Error('product_uninstall_dependencies_unsafe');
    await ports.unregister();
    for (const entry of paths) await rm(join(root, entry.path), { force: true });
    await rm(join(root, 'node_modules'), { recursive: true, force: true });
    await save({ ...operation, phase: 'completed' });
    return operation!;
  } finally { await release(); }
}
