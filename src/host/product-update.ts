import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { isNativeApplicationId } from '../contracts/native-application.ts';
import { releaseVersion } from '../contracts/framework-release.ts';
import { isRecord } from '../contracts/values.ts';
import type { BridgeBundle } from '../contracts/bridge-management.ts';
import type { BridgeOperation } from './bridge-manager.ts';
import { FRAMEWORK_PRODUCT_PHASES, type FrameworkProductPhase } from '../contracts/framework-update.ts';
import { ensurePrivateDirectory, readDocument, writeDocumentLocked } from '../storage/private-json.ts';
import { acquireProcessFileLock } from '../storage/process-file-lock.ts';
import { productUninstallPending } from './product-uninstall-state.ts';

export interface ProductUpdate {
  readonly schema: 1;
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly bridgeBefore: BridgeBundle | null;
  readonly bridgeOperationId: string;
  readonly restoreOperationId: string;
  readonly runtimeTransactionId: string;
  readonly wasRunning: boolean;
  readonly phase: FrameworkProductPhase;
  readonly error: string | null;
}
const phases: readonly string[] = FRAMEWORK_PRODUCT_PHASES;
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
function validate(input: unknown): ProductUpdate | null {
  if (input === null) return null;
  if (!isRecord(input) || input.schema !== 1 || ![input.id, input.bridgeOperationId, input.restoreOperationId, input.runtimeTransactionId].every(isNativeApplicationId)
    || !releaseVersion(input.from) || !releaseVersion(input.to) || typeof input.wasRunning !== 'boolean'
    || !phases.includes(String(input.phase)) || input.error !== null && (typeof input.error !== 'string' || !/^[a-z0-9_]{1,96}$/.test(input.error))) throw new Error('product_update_journal_invalid');
  const bundle = input.bridgeBefore;
  if (bundle !== null && (!isRecord(bundle) || !['installed', 'enabled', 'removable', 'legacy'].every(key => typeof bundle[key] === 'boolean')
    || bundle.version !== null && !releaseVersion(bundle.version)
    || bundle.source !== null && (typeof bundle.source !== 'string' || bundle.source.length > 4096))) throw new Error('product_update_journal_invalid');
  return input as unknown as ProductUpdate;
}
export const productUpdateDirectory = (root: string) => join(root, 'data/product-updates');
async function readProductUpdateOnce(root: string, id?: string): Promise<ProductUpdate | null> {
  const directory = productUpdateDirectory(root);
  if (!id) {
    id = (await readDocument(join(directory, 'current.json'), null, input => {
      if (input !== null && !isNativeApplicationId(input)) throw new Error('product_update_pointer_invalid');
      return input as string | null;
    })).value ?? undefined;
    if (!id) return null;
  }
  if (!isNativeApplicationId(id)) throw new Error('product_update_id_invalid');
  return (await readDocument(join(directory, `${id}.json`), null, validate)).value;
}
export async function readProductUpdate(root: string, id?: string): Promise<ProductUpdate | null> {
  for (let attempt = 0; ; attempt++) {
    try { return await readProductUpdateOnce(root, id); }
    catch (error) {
      if (attempt >= 2 || !isRecord(error) || error.code !== 'chat_revision_conflict') throw error;
      await new Promise<void>(resolve => setTimeout(resolve, 10));
    }
  }
}
export function productUpdateAllowsStart(operation: ProductUpdate | null): boolean {
  return operation === null || ['starting', 'completed', 'rollback-start', 'rolled-back'].includes(operation.phase);
}
export interface ProductUpdatePorts {
  runtimeVersion(): Promise<string>;
  bridge(): Promise<BridgeBundle | null>;
  prepareArchive(version: string): Promise<string>;
  changeBridge(id: string, version: string | null): Promise<BridgeOperation>;
  reconcileBridge(id: string): Promise<BridgeOperation | null>;
  ensureBridge(version: string | null, enabled: boolean, restartRequired: boolean, maintenanceId: string): Promise<void>;
  stop(): Promise<void>;
  applyRuntime(transactionId: string): Promise<void>;
  rollbackRuntime(transactionId: string): Promise<void>;
  start(): Promise<void>;
  verify(version: string, wasRunning: boolean): Promise<void>;
}
/** One durable operation owns both component selection and program replacement. Unknown writes are reconciled, never repeated. */
export function createProductUpdater(root: string, ports: ProductUpdatePorts) {
  const directory = productUpdateDirectory(root);
  async function save(operation: ProductUpdate, admitting = false) {
    const filename = join(directory, `${operation.id}.json`), prior = await readDocument(filename, null, validate);
    await writeDocumentLocked(directory, filename, prior.revision, null, validate, operation);
    if (admitting) {
      const pointer = join(directory, 'current.json'), previous = await readDocument(pointer, null, input => input as string | null);
      await writeDocumentLocked(directory, pointer, previous.revision, null, input => input as string | null, operation.id);
    }
  }
  const exclusive = async <T>(run: () => Promise<T>) => {
    await ensurePrivateDirectory(directory);
    const release = await acquireProcessFileLock(directory, 'operation.lock');
    try { return await run(); } finally { await release(); }
  };
  async function restore(operation: ProductUpdate): Promise<ProductUpdate> {
    let current = operation;
    const phase = async (next: ProductUpdate['phase']) => { current = { ...current, phase: next }; await save(current); };
    try {
      await ports.stop();
      await phase('rollback-bridge');
      if (current.bridgeBefore !== null) {
        const before = current.bridgeBefore;
        const pending = await ports.reconcileBridge(current.bridgeOperationId);
        if (pending && ['unknown', 'installing', 'removing', 'restoring', 'verifying', 'preparing'].includes(pending.state)) throw new Error('product_bridge_outcome_unknown');
        const actual = await ports.bridge();
        if (!actual || actual.legacy) throw new Error('product_bridge_changed');
        let restartRequired = pending?.restartRequired ?? false;
        if (!same(before, actual)) {
          if (!actual.installed || actual.version !== current.to || actual.enabled !== (before.installed ? before.enabled : true)) throw new Error('product_bridge_changed');
          const restored = await ports.changeBridge(current.restoreOperationId, before.installed ? before.version : null);
          if (!['loaded', 'restart-required', 'installed-disabled', 'removed'].includes(restored.state)) throw new Error('product_bridge_restore_unconfirmed');
          restartRequired = restored.restartRequired;
          if (!same(before, await ports.bridge())) throw new Error('product_bridge_restore_unconfirmed');
        }
        await ports.ensureBridge(before.installed ? before.version : null, before.enabled, restartRequired, current.restoreOperationId);
      }
      await phase('rollback-runtime');
      await ports.rollbackRuntime(current.runtimeTransactionId);
      if (await ports.runtimeVersion() !== current.from) throw new Error('product_runtime_restore_unconfirmed');
      await phase('rollback-start'); await ports.start(); await ports.verify(current.from, current.wasRunning);
      await phase('rolled-back');
    } catch {
      await ports.stop().catch(() => undefined);
      current = { ...current, phase: 'unknown', error: 'product_restore_requires_reconciliation' }; await save(current);
    }
    return current;
  }
  return {
    read: (id?: string) => readProductUpdate(root, id),
    async execute(request: { id: string; version: string; wasRunning: boolean }): Promise<ProductUpdate> {
      if (!isNativeApplicationId(request.id) || !releaseVersion(request.version)) throw new Error('product_update_request_invalid');
      return exclusive(async () => {
        const existing = await readProductUpdate(root, request.id);
        if (existing) {
          if (existing.to !== request.version || existing.wasRunning !== request.wasRunning) throw new Error('product_update_id_conflict');
          return existing;
        }
        const active = await readProductUpdate(root);
        if (active && !['completed', 'rolled-back'].includes(active.phase)) throw new Error('product_update_requires_reconciliation');
        if (await productUninstallPending(root)) throw new Error('product_uninstall_requires_reconciliation');
        const before = await ports.bridge();
        if (before?.legacy || before?.installed && (!before.version || !before.removable)) throw new Error('product_bridge_migration_required');
        if (before !== null) {
          await ports.prepareArchive(request.version);
          if (before.installed) {
            const archive = await ports.prepareArchive(before.version!);
            if (![archive, `file:${archive}`].includes(before.source ?? '')) throw new Error('product_bridge_source_not_managed');
          }
          if (!same(before, await ports.bridge())) throw new Error('product_bridge_changed');
        }
        let operation: ProductUpdate = { schema: 1, id: request.id, from: await ports.runtimeVersion(), to: request.version,
          bridgeBefore: before, bridgeOperationId: randomUUID(), restoreOperationId: randomUUID(), runtimeTransactionId: randomUUID(),
          wasRunning: request.wasRunning, phase: 'prepared', error: null };
        await save(operation, true);
        const phase = async (next: ProductUpdate['phase']) => { operation = { ...operation, phase: next }; await save(operation); };
        try {
          await phase('stopping'); await ports.stop();
          if (before !== null) {
            if (!same(before, await ports.bridge())) throw new Error('product_bridge_changed');
            await phase('bridge');
            const changed = before.installed && before.version === request.version ? null : await ports.changeBridge(operation.bridgeOperationId, request.version);
            if (changed && !['loaded', 'restart-required', 'installed-disabled'].includes(changed.state)) throw new Error('product_bridge_update_unconfirmed');
            await ports.ensureBridge(request.version, before.installed ? before.enabled : true, changed?.restartRequired ?? false, operation.bridgeOperationId);
          }
          await phase('runtime'); await ports.applyRuntime(operation.runtimeTransactionId);
          await phase('starting'); await ports.start(); await ports.verify(operation.to, operation.wasRunning);
          await phase('completed'); return operation;
        } catch {
          operation = { ...operation, error: 'product_update_failed' }; await save(operation);
          return restore(operation);
        }
      });
    },
    async rollback(id: string): Promise<ProductUpdate> {
      return exclusive(async () => {
        const operation = await readProductUpdate(root, id);
        if (!operation || (await readProductUpdate(root))?.id !== id) throw new Error('product_update_not_current');
        if (operation.phase === 'rolled-back') return operation;
        if (operation.phase === 'completed' && await ports.runtimeVersion() !== operation.to) throw new Error('product_update_version_conflict');
        return restore(operation);
      });
    },
  };
}
