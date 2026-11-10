import { join } from 'node:path';
import { isRecord } from '../contracts/values.ts';
import { isNativeApplicationId } from '../contracts/native-application.ts';
import { readDocument } from '../storage/private-json.ts';

export interface ProductUninstall { readonly id: string; readonly bridgeId: string; readonly keepBridge: boolean;
  readonly manifestSha256: string; readonly phase: 'components' | 'program' | 'completed' }
export function validateProductUninstall(input: unknown): ProductUninstall | null {
  if (input === null) return null;
  if (!isRecord(input) || !isNativeApplicationId(input.id) || !isNativeApplicationId(input.bridgeId) || typeof input.keepBridge !== 'boolean'
    || typeof input.manifestSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(input.manifestSha256)
    || !['components', 'program', 'completed'].includes(String(input.phase))) throw new Error('product_uninstall_journal_invalid');
  return input as unknown as ProductUninstall;
}
export async function productUninstallPending(root: string): Promise<boolean> {
  const directory = join(root, 'data/product-uninstalls');
  const pointer = (await readDocument(join(directory, 'current.json'), null, value => {
    if (value !== null && !isNativeApplicationId(value)) throw new Error('product_uninstall_pointer_invalid');
    return value as string | null;
  })).value;
  return pointer !== null && (await readDocument(join(directory, `${pointer}.json`), null, validateProductUninstall)).value?.phase !== 'completed';
}
