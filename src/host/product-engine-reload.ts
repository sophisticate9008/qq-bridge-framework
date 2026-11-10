import { join } from 'node:path';
import { isNativeApplicationId } from '../contracts/native-application.ts';
import { releaseVersion } from '../contracts/framework-release.ts';
import { isRecord } from '../contracts/values.ts';
import { ensurePrivateDirectory, readDocument, writeDocumentLocked } from '../storage/private-json.ts';

interface Reload { readonly version: string | null; readonly enabled: boolean; readonly state: 'attempted' | 'confirmed' }
/** The product operation lock owns this journal. Reopening it never repeats an engine command with a lost acknowledgement. */
export async function ensureProductEngineReload(root: string, id: string, version: string | null, enabled: boolean,
  ports: { readonly restart: () => Promise<void>; readonly verify: () => Promise<void> }): Promise<void> {
  if (!isNativeApplicationId(id) || version !== null && !releaseVersion(version)) throw new Error('product_reload_request_invalid');
  const directory = join(root, 'data/product-engine-reloads'), filename = join(directory, `${id}.json`);
  const validate = (input: unknown): Reload | null => {
    if (input === null) return null;
    if (!isRecord(input) || input.version !== version || input.enabled !== enabled || !['attempted', 'confirmed'].includes(String(input.state))) throw new Error('product_reload_intent_conflict');
    return input as unknown as Reload;
  };
  await ensurePrivateDirectory(directory);
  let saved = await readDocument(filename, null, validate);
  if (!saved.value) {
    await writeDocumentLocked(directory, filename, saved.revision, null, validate, { version, enabled, state: 'attempted' });
    await ports.restart();
  }
  // Actual loaded/configuration evidence may confirm a previously interrupted command. Lack of evidence never permits another restart.
  await ports.verify();
  saved = await readDocument(filename, null, validate);
  if (saved.value?.state !== 'confirmed') await writeDocumentLocked(directory, filename, saved.revision, null, validate, { version, enabled, state: 'confirmed' });
}
