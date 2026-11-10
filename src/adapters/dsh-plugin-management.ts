import { isAbsolute } from 'node:path';
import { BRIDGE_PACKAGE, parseBridgeChange, type BridgeBundle, type BridgeChange,
  type BridgeManagementMethod } from '../contracts/bridge-management.ts';
import { isNativeApplicationId } from '../contracts/native-application.ts';
import { releaseVersion } from '../contracts/framework-release.ts';
import type { JsonObject } from '../contracts/data.ts';
import { isRecord } from '../contracts/values.ts';
import { DshAdapterError } from './dsh.ts';

const invalid = (): never => { throw new DshAdapterError('DSH_PLUGIN_MANAGEMENT_INVALID', 'DSH plugin management evidence is invalid.'); };
/** Owner-only management surface, restricted to this package. Never exposed as a model tool. */
export function createDshPluginManagement(invoke: (method: BridgeManagementMethod, input: JsonObject | undefined,
  signal: AbortSignal) => Promise<unknown>) {
  const change = async (method: BridgeManagementMethod, input: JsonObject, signal: AbortSignal): Promise<BridgeChange> => {
    return parseBridgeChange(await invoke(method, input, signal)) ?? invalid();
  };
  return Object.freeze({
    async read(signal: AbortSignal): Promise<BridgeBundle> {
      const bundles = await invoke('pluginManager/listBundles', undefined, signal);
      if (!Array.isArray(bundles) || bundles.length > 4096 || !bundles.every(isRecord)) return invalid();
      const matches = bundles.filter(row => row.name === BRIDGE_PACKAGE);
      if (matches.length > 1) return invalid();
      const bundle = matches[0];
      if (bundle && (typeof bundle.installed !== 'boolean' || typeof bundle.enabled !== 'boolean'
        || typeof bundle.removable !== 'boolean' || bundle.version !== undefined && !releaseVersion(bundle.version)
        || bundle.source !== undefined && (typeof bundle.source !== 'string' || bundle.source.length > 4096))) return invalid();
      const plugins = await invoke('pluginManager/listPlugins', undefined, signal);
      if (!Array.isArray(plugins) || plugins.length > 4096 || !plugins.every(isRecord)) return invalid();
      const rows = plugins.filter(row => row.moduleName === BRIDGE_PACKAGE);
      const declared = bundle && Array.isArray(bundle.rows) ? bundle.rows.filter(isRecord) : [];
      const entries = new Set(declared.map(row => row.entryId));
      return { installed: bundle?.installed === true, enabled: bundle?.enabled === true,
        removable: bundle?.removable === true, version: typeof bundle?.version === 'string' ? bundle.version : null,
        legacy: rows.some(row => !entries.has(row.entryId)) || bundle?.error !== undefined,
        source: typeof bundle?.source === 'string' ? bundle.source : null };
    },
    install(archive: string, operationId: string, enabled: boolean, signal: AbortSignal) {
      if (!isAbsolute(archive) || !archive.endsWith('.tgz') || /[\x00-\x1f\x7f]/.test(archive)
        || !isNativeApplicationId(operationId)) invalid();
      return change('pluginManager/installBundle', { spec: archive, options: { requestId: operationId, enabled, saveExact: true } }, signal);
    },
    remove(signal: AbortSignal) { return change('pluginManager/removeBundle', { name: BRIDGE_PACKAGE }, signal); },
    async wait(operationId: string, signal: AbortSignal): Promise<BridgeChange | null> {
      if (!isNativeApplicationId(operationId)) invalid();
      const value = await invoke('pluginManager/waitForInstall', { requestId: operationId }, signal);
      return value === null ? null : parseBridgeChange(value) ?? invalid();
    },
  });
}
export type DshPluginManagement = ReturnType<typeof createDshPluginManagement>;
