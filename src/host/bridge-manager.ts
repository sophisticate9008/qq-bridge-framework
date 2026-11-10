import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isRecord } from '../contracts/values.ts';
import { compareReleaseVersions, releaseVersion } from '../contracts/framework-release.ts';
import { isNativeApplicationId } from '../contracts/native-application.ts';
import type { BridgeBundle, BridgeChange } from '../contracts/bridge-management.ts';
import type { DshPluginManagement } from '../adapters/dsh-plugin-management.ts';
import { ensurePrivateDirectory, readDocument, writeDocumentLocked } from '../storage/private-json.ts';
import { acquireProcessFileLock } from '../storage/process-file-lock.ts';

export interface BridgeOperation {
  readonly schema: 1;
  readonly id: string;
  readonly action: 'install' | 'update' | 'rollback' | 'remove';
  readonly version: string | null;
  readonly previousVersion: string | null;
  readonly previousEnabled: boolean;
  readonly previousSource: string | null;
  readonly phase: 'preparing' | 'installing' | 'removing' | 'restoring' | 'verifying';
  readonly restartRequired: boolean;
  readonly state: 'preparing' | 'installing' | 'removing' | 'restoring' | 'verifying' | 'loaded'
    | 'restart-required' | 'removed' | 'rolled-back' | 'failed' | 'unknown';
  readonly requestId: string | null;
  readonly error: string | null;
}
const terminal = (value: BridgeOperation) => ['loaded', 'restart-required', 'removed', 'rolled-back', 'failed'].includes(value.state);
const safeError = (value: string) => /^[a-z][a-z0-9_-]{0,95}$/.test(value) ? value : 'bridge_operation_failed';
function validate(value: unknown): BridgeOperation | null {
  if (value === null) return null;
  if (!isRecord(value) || value.schema !== 1 || !isNativeApplicationId(value.id)
    || !['install', 'update', 'rollback', 'remove'].includes(String(value.action))
    || value.version !== null && !releaseVersion(value.version)
    || value.previousVersion !== null && !releaseVersion(value.previousVersion)
    || typeof value.previousEnabled !== 'boolean'
    || value.previousSource !== null && (typeof value.previousSource !== 'string' || value.previousSource.length > 4096)
    || !['preparing', 'installing', 'removing', 'restoring', 'verifying'].includes(String(value.phase))
    || typeof value.restartRequired !== 'boolean'
    || !['preparing', 'installing', 'removing', 'restoring', 'verifying', 'loaded', 'restart-required', 'removed', 'rolled-back', 'failed', 'unknown'].includes(String(value.state))
    || value.requestId !== null && !isNativeApplicationId(value.requestId)
    || value.error !== null && (typeof value.error !== 'string' || safeError(value.error) !== value.error)) throw new Error('bridge_journal_invalid');
  return value as unknown as BridgeOperation;
}
/** Installation belongs to DSH; this coordinator records explicit operator requests and never restarts an engine. */
export function createBridgeManager(options: { readonly directory: string; readonly port: DshPluginManagement;
  readonly archive: (version: string, signal: AbortSignal) => Promise<string>;
  readonly describe: (signal: AbortSignal) => Promise<{ readonly pluginVersion: string }> }) {
  const pointer = join(options.directory, 'current.json');
  const exclusive = async <T>(run: () => Promise<T>): Promise<T> => {
    const release = await acquireProcessFileLock(options.directory, 'operation.lock');
    try { return await run(); } finally { await release(); }
  };
  const file = (id: string) => {
    if (!isNativeApplicationId(id)) throw new Error('bridge_operation_id_invalid');
    return join(options.directory, `${id}.json`);
  };
  const read = async (id?: string): Promise<BridgeOperation | null> => {
    if (!id) {
      const current = (await readDocument(pointer, null, value => {
        if (value !== null && !isNativeApplicationId(value)) throw new Error('bridge_journal_invalid');
        return value as string | null;
      })).value;
      if (!current) return null;
      id = current;
    }
    return (await readDocument(file(id), null, validate)).value;
  };
  async function save(operation: BridgeOperation, admitting = false): Promise<void> {
    const filename = file(operation.id), previous = await readDocument(filename, null, validate);
    await writeDocumentLocked(options.directory, filename, previous.revision, null, validate, operation);
    if (admitting) {
      const current = await readDocument(pointer, null, value => value as string | null);
      await writeDocumentLocked(options.directory, pointer, current.revision, null, value => value as string | null, operation.id);
    }
  }
  async function finish(operation: BridgeOperation, change: BridgeChange, signal: AbortSignal): Promise<BridgeOperation> {
    if (change.application === 'failed' || change.application === 'cancelled' || change.application === 'overridden') {
      const result: BridgeOperation = { ...operation, state: 'failed', error: safeError(change.error ?? `dsh_${change.application}`) };
      await save(result); return result;
    }
    if (operation.action === 'remove') {
      const current = await options.port.read(signal);
      if (current.installed || current.enabled) throw new Error('bridge_removal_unverified');
      const result: BridgeOperation = { ...operation, state: 'removed', error: null };
      await save(result); return result;
    }
    const current = await options.port.read(signal);
    if (!current.installed || current.version !== operation.version || current.legacy
      || current.enabled !== (operation.action === 'install' ? true : operation.previousEnabled)) throw new Error('bridge_installation_unverified');
    const live = await options.describe(signal).catch(() => null);
    const result: BridgeOperation = { ...operation,
      restartRequired: change.application === 'restart-required' || !live || live.pluginVersion !== operation.version,
      state: change.application === 'restart-required' || !live || live.pluginVersion !== operation.version ? 'restart-required' : 'loaded', error: null };
    await save(result); return result;
  }
  const unchanged = (before: BridgeBundle, current: BridgeBundle) => JSON.stringify(before) === JSON.stringify(current);
  return {
    read,
    async execute(request: Pick<BridgeOperation, 'id' | 'action' | 'version'>, signal: AbortSignal): Promise<BridgeOperation> {
      file(request.id);
      if (!['install', 'update', 'rollback', 'remove'].includes(request.action)
        || (request.action === 'remove' ? request.version !== null : !releaseVersion(request.version))) throw new Error('bridge_request_invalid');
      await ensurePrivateDirectory(options.directory);
      return exclusive(async () => {
        const received = await read(request.id);
        if (received) {
          if (received.action !== request.action || received.version !== request.version) throw new Error('bridge_operation_conflict');
          return received;
        }
        const current = await read();
        if (current && !terminal(current)) throw new Error('bridge_operation_unresolved');
        const before = await options.port.read(signal);
        let operation: BridgeOperation = { schema: 1, ...request, previousVersion: before.version,
          previousEnabled: before.enabled, previousSource: before.source, phase: 'preparing', restartRequired: false,
          state: 'preparing', requestId: null, error: null };
        await save(operation, true);
        const phase = async (state: BridgeOperation['phase'], requestId: string | null = null) => {
          operation = { ...operation, state, phase: state, requestId }; await save(operation);
        };
        try {
          if (before.legacy) throw new Error('bridge_legacy_installation_requires_migration');
          if (request.action === 'install' && before.installed) throw new Error('bridge_already_installed');
          if (request.action !== 'install' && !before.installed) throw new Error('bridge_not_installed');
          if (request.action === 'update' && (!before.version || compareReleaseVersions(request.version!, before.version) <= 0)) throw new Error('bridge_update_not_newer');
          if (request.action === 'rollback' && (!before.version || compareReleaseVersions(request.version!, before.version) >= 0)) throw new Error('bridge_rollback_not_older');
          const archive = request.version === null ? null : await options.archive(request.version, signal);
          if (!unchanged(before, await options.port.read(signal))) throw new Error('bridge_installation_changed');
          if (request.action === 'remove') {
            if (!before.removable) throw new Error('bridge_not_removable');
            await phase('removing');
            return await finish(operation, await options.port.remove(signal), signal);
          }
          await phase('installing', randomUUID());
          let result = await options.port.install(archive!, operation.requestId!, request.action === 'install' ? true : before.enabled, signal);
          // With HMR, DSH refuses an existing package before changing it. Prepare rollback BEFORE removing anything.
          if (request.action !== 'install' && result.application === 'failed' && result.error === 'already-installed') {
            await phase('preparing');
            const previousArchive = await options.archive(before.version!, signal);
            if (before.source !== `file:${previousArchive}` && before.source !== previousArchive) throw new Error('bridge_previous_source_not_managed');
            if (!unchanged(before, await options.port.read(signal))) throw new Error('bridge_installation_changed');
            await phase('removing');
            const removed = await options.port.remove(signal);
            if (removed.application !== 'applied') return await finish(operation, removed, signal);
            await phase('installing', randomUUID());
            result = await options.port.install(archive!, operation.requestId!, before.enabled, signal);
            if (result.application === 'failed' || result.application === 'cancelled') {
              const failure = result.error ?? 'bridge_candidate_failed';
              await phase('restoring', randomUUID());
              const restored = await options.port.install(previousArchive, operation.requestId!, before.enabled, signal);
              const actual = await options.port.read(signal);
              if (!['applied', 'restart-required'].includes(restored.application) || actual.version !== before.version
                || actual.enabled !== before.enabled || !actual.installed) throw new Error('bridge_rollback_unverified');
              const live = await options.describe(signal).catch(() => null);
              operation = { ...operation, state: 'rolled-back',
                restartRequired: restored.application === 'restart-required' || live?.pluginVersion !== before.version,
                error: safeError(failure) };
              await save(operation); return operation;
            }
          }
          await phase('verifying', operation.requestId);
          return await finish(operation, result, signal);
        } catch (error) {
          const state = ['installing', 'removing', 'restoring', 'verifying'].includes(operation.state) ? 'unknown' : 'failed';
          operation = { ...operation, state, error: safeError(error instanceof Error ? error.message : 'bridge_operation_failed') };
          await save(operation); return operation;
        }
      });
    },
    async reconcile(id: string, signal: AbortSignal): Promise<BridgeOperation> {
      await ensurePrivateDirectory(options.directory);
      return exclusive(async () => {
        const operation = await read(id);
        if (!operation) throw new Error('bridge_operation_not_received');
        if (terminal(operation)) return operation;
        if (operation.phase === 'preparing') {
          const result: BridgeOperation = { ...operation, state: 'failed', error: 'bridge_preparation_interrupted' };
          await save(result); return result;
        }
        const result = operation.requestId ? await options.port.wait(operation.requestId, signal) : null;
        // DSH retains only active requests. Absence is not permission to repeat an install or removal.
        if (operation.phase === 'restoring') {
          const current = await options.port.read(signal);
          if (!current.legacy && current.installed && current.version === operation.previousVersion
            && current.enabled === operation.previousEnabled) {
            const live = await options.describe(signal).catch(() => null);
            const restored: BridgeOperation = { ...operation, state: 'rolled-back',
              restartRequired: result?.application === 'restart-required' || live?.pluginVersion !== operation.previousVersion,
              error: operation.error ?? 'bridge_candidate_failed' };
            await save(restored); return restored;
          }
        }
        if (!result) {
          const current = await options.port.read(signal);
          if (operation.action === 'remove' && !current.installed && !current.enabled
            || operation.phase !== 'restoring' && operation.action !== 'remove' && current.installed
              && current.version === operation.version && !current.legacy
              && current.enabled === (operation.action === 'install' ? true : operation.previousEnabled)) {
            return finish(operation, { application: 'applied', changed: true, error: null, version: current.version }, signal);
          }
          const unknown: BridgeOperation = { ...operation, state: 'unknown', error: 'bridge_outcome_unconfirmed' };
          await save(unknown); return unknown;
        }
        if (operation.phase === 'restoring') {
          const unknown: BridgeOperation = { ...operation, state: 'unknown', error: 'bridge_rollback_requires_verification' };
          await save(unknown); return unknown;
        }
        return finish(operation, result, signal);
      });
    },
  };
}
