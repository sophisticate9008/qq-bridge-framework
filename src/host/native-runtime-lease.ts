import { lstat } from 'node:fs/promises';
import { join } from 'node:path';

/** Presence alone never proves a previous owner has drained. Reads do not retire leases. */
export async function readNativeRuntimeLease(directory: string, owned: boolean): Promise<{ readonly state: 'owned' | 'available' | 'blocked' | 'unknown' }> {
  if (owned) return { state: 'owned' };
  try { await lstat(join(directory, '.native-chat-runtime.lock')); return { state: 'blocked' }; }
  catch (error) { return { state: error instanceof Error && 'code' in error && error.code === 'ENOENT' ? 'available' : 'unknown' }; }
}
