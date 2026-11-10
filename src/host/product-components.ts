import { join, isAbsolute } from 'node:path';
import { isRecord } from '../contracts/values.ts';
import { releaseVersion } from '../contracts/framework-release.ts';
import type { BridgeBundle } from '../contracts/bridge-management.ts';
import { ensurePrivateDirectory, readDocument, writeDocumentLocked } from '../storage/private-json.ts';

export interface ManagedBridge { readonly home: string; readonly endpoint: string; readonly version: string; readonly source: string }
function validate(input: unknown): ManagedBridge | null {
  if (input === null) return null;
  if (!isRecord(input) || typeof input.home !== 'string' || !isAbsolute(input.home) || !releaseVersion(input.version)
    || typeof input.endpoint !== 'string' || typeof input.source !== 'string' || input.source.length > 4096) throw new Error('product_bridge_registration_invalid');
  const endpoint = new URL(input.endpoint);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('product_bridge_registration_invalid');
  return input as unknown as ManagedBridge;
}
export const readManagedBridge = async (root: string) => (await readDocument(join(root, 'data/managed-bridge.json'), null, validate)).value;
export async function registerManagedBridge(root: string, home: string, endpoint: string, bundle: BridgeBundle): Promise<void> {
  const directory = join(root, 'data'), filename = join(directory, 'managed-bridge.json');
  await ensurePrivateDirectory(directory);
  const value = bundle.installed ? validate({ home, endpoint, version: bundle.version, source: bundle.source }) : null;
  const prior = await readDocument(filename, null, validate);
  if (!bundle.installed && prior.value && (prior.value.home !== home || prior.value.endpoint !== endpoint)) throw new Error('product_bridge_registration_changed');
  await writeDocumentLocked(directory, filename, prior.revision, null, validate, value);
}
