import { isRecord } from './values.ts';
import { releaseVersion } from './framework-release.ts';

export const BRIDGE_PACKAGE = '@qq-bridge-framework/dsh-bridge-plugin';
export const BRIDGE_BUNDLE_ID = 'qbf-bridge';
export type BridgeManagementMethod = 'pluginManager/listBundles' | 'pluginManager/listPlugins'
  | 'pluginManager/installBundle' | 'pluginManager/removeBundle' | 'pluginManager/waitForInstall';
export interface BridgeBundle {
  readonly installed: boolean;
  readonly enabled: boolean;
  readonly removable: boolean;
  readonly version: string | null;
  readonly legacy: boolean;
  readonly source: string | null;
}
export interface BridgeChange {
  readonly application: 'applied' | 'restart-required' | 'overridden' | 'failed' | 'cancelled';
  readonly changed: boolean;
  readonly version: string | null;
  readonly error: string | null;
}
export function parseBridgeChange(value: unknown): BridgeChange | null {
  if (!isRecord(value) || typeof value.changed !== 'boolean'
    || !['applied', 'restart-required', 'overridden', 'failed', 'cancelled'].includes(String(value.application))
    || value.version !== undefined && !releaseVersion(value.version)
    || value.error !== undefined && (!isRecord(value.error) || typeof value.error.code !== 'string'
      || !/^[a-z][a-z0-9-]{0,63}$/.test(value.error.code))) return null;
  return { application: value.application as BridgeChange['application'], changed: value.changed,
    version: typeof value.version === 'string' ? value.version : null,
    error: isRecord(value.error) ? String(value.error.code) : null };
}
