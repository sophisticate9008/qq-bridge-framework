import { createHash } from 'node:crypto';
import { lstat, readFile, readlink, unlink } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { isRecord } from '../contracts/values.ts';
import { ensurePrivateDirectory, readDocument, writeDocumentLocked } from '../storage/private-json.ts';

type Entry = { readonly path: string; readonly target: string } | { readonly path: string; readonly sha256: string };
function validate(input: unknown): readonly Entry[] {
  if (!Array.isArray(input) || input.length > 16 || !input.every(row => isRecord(row) && typeof row.path === 'string' && isAbsolute(row.path)
    && (typeof row.target === 'string' && isAbsolute(row.target) || typeof row.sha256 === 'string' && /^[a-f0-9]{64}$/.test(row.sha256)))) throw new Error('product_command_registration_invalid');
  return input as Entry[];
}
export async function registerProductCommands(root: string, entries: readonly Entry[]) {
  const directory = join(root, 'data'), filename = join(directory, 'managed-commands.json');
  await ensurePrivateDirectory(directory);
  const prior = await readDocument(filename, [], validate);
  await writeDocumentLocked(directory, filename, prior.revision, [], validate, entries);
}
/** Remove only exact installer registrations. An edited/replaced entry is preserved and stops automatic cleanup. */
export async function unregisterProductCommands(root: string): Promise<void> {
  const entries = (await readDocument(join(root, 'data/managed-commands.json'), [], validate)).value;
  const permitted = new Set([join(root, 'dist/scripts/cli.js'), join(root, 'scripts/cli.ts')]);
  for (const entry of entries) {
    const metadata = await lstat(entry.path).catch(error => { if (isRecord(error) && error.code === 'ENOENT') return null; throw error; });
    if (!metadata) continue;
    if ('target' in entry) {
      if (!permitted.has(entry.target) || !metadata.isSymbolicLink() || resolve(entry.path, '..', await readlink(entry.path)) !== entry.target) throw new Error('product_command_registration_changed');
    } else if (entry.path !== '/etc/cron.d/qq-bridge-framework-storage' || !metadata.isFile() || metadata.isSymbolicLink()
      || createHash('sha256').update(await readFile(entry.path)).digest('hex') !== entry.sha256) throw new Error('product_command_registration_changed');
  }
  for (const entry of entries) await unlink(entry.path).catch(error => { if (!isRecord(error) || error.code !== 'ENOENT') throw error; });
}
