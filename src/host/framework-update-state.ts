import { join } from 'node:path';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isNativeApplicationId } from '../contracts/native-application.ts';
import { isRecord } from '../contracts/values.ts';
import { readPrivateJson, ensurePrivateDirectory, withDirectoryWriteLock } from '../storage/private-json.ts';
import { securePermissions } from '../storage/file-security.ts';

export { parseFrameworkUpdateState, type FrameworkUpdateState } from '../contracts/framework-update.ts';
import { parseFrameworkUpdateState, type FrameworkUpdateState } from '../contracts/framework-update.ts';
export const frameworkUpdateDirectory = (root: string) => join(root, 'runtime/framework-update-control');
export async function readFrameworkUpdateState(root: string): Promise<FrameworkUpdateState | null> {
  const document = await readPrivateJson(join(frameworkUpdateDirectory(root), 'current.json'), {
    maxBytes: 8192, exactMode: 0o600, requireSingleLink: true, fallback: { value: null },
    invalidCode: 'update_state_invalid', conflictCode: 'update_state_conflict', validate(value) {
      const parsed = parseFrameworkUpdateState(value); if (!parsed) throw new Error('update_state_invalid'); return parsed;
    },
  });
  return document.value;
}
export async function writeFrameworkUpdateState(root: string, value: FrameworkUpdateState, admitting = false): Promise<void> {
  if (!parseFrameworkUpdateState(value)) throw new Error('update_state_invalid');
  const directory = frameworkUpdateDirectory(root);
  await ensurePrivateDirectory(directory);
  const save = async () => {
    if (!admitting) {
      const previous = await readFrameworkUpdateState(root);
      const transitions: Record<FrameworkUpdateState['state'], readonly FrameworkUpdateState['state'][]> = {
        preparing: ['ready', 'failed'], ready: ['applying', 'failed'], applying: ['verifying', 'failed', 'rolled-back'],
        verifying: ['completed', 'failed', 'rolled-back'], completed: [], failed: [], 'rolled-back': [],
      };
      if (!previous || previous.id !== value.id || previous.createdAt !== value.createdAt
        || !transitions[previous.state].includes(value.state)) throw new Error('update_state_conflict');
    }
    const temporary = join(directory, `${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 });
    securePermissions(temporary, 0o600);
    await rename(temporary, join(directory, 'current.json'));
  };
  // Admission already holds this exact lock, including its durable received-ID marker.
  if (admitting) await save(); else await withDirectoryWriteLock(directory, save);
}
export async function frameworkUpdateWasReceived(root: string, id: string): Promise<boolean> {
  if (!isNativeApplicationId(id)) throw new Error('update_id_invalid');
  try { await readFile(join(frameworkUpdateDirectory(root), `${id}.received`)); return true; }
  catch (error) { if (isRecord(error) && error.code === 'ENOENT') return false; throw error; }
}
