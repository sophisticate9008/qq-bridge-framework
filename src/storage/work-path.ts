/** Wire metadata validation only. File authority belongs to the trusted filesystem host. */
export interface WorkPathIdentity { readonly path: string; readonly dev: number; readonly ino: number }
export interface WorkPathDescriptor {
  readonly path: string; readonly root: string; readonly bytes: number;
  readonly mtimeMs: number; readonly ctimeMs: number; readonly dev: number; readonly ino: number;
  readonly sha256: string; readonly createdAt: number; readonly expiresAt: number | null;
  readonly parents: readonly WorkPathIdentity[];
}
export function validWorkPath(value: unknown): value is WorkPathDescriptor {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.path === 'string' && typeof v.root === 'string' && typeof v.sha256 === 'string'
    && /^[a-f0-9]{64}$/.test(v.sha256) && Number.isSafeInteger(v.bytes) && Number(v.bytes) > 0
    && Number.isSafeInteger(v.createdAt) && (v.expiresAt === null || Number.isSafeInteger(v.expiresAt))
    && ['mtimeMs','ctimeMs','dev','ino'].every(key => typeof v[key] === 'number' && Number.isFinite(v[key]))
    && Array.isArray(v.parents);
}
