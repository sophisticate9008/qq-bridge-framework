import { isRecord } from './values.ts'

export interface ExtensionManifest {
  readonly schema: 1
  readonly id: string
  readonly version: string
  readonly displayName: string
  readonly entry: string
  readonly files: readonly string[]
  readonly packages: readonly string[]
}
export interface ManagedExtension extends ExtensionManifest {
  readonly revision: string
  readonly directory: string
  readonly fingerprint: string
  readonly enabled: boolean
}
export interface ExtensionOperation {
  readonly id: string
  readonly phase: 'prepared' | 'applying' | 'completed' | 'restoring' | 'rolled-back' | 'unknown'
  readonly before: readonly ManagedExtension[]
  readonly after: readonly ManagedExtension[]
  readonly error: string | null
}
export interface ExtensionRegistry {
  readonly schema: 1
  readonly items: readonly ManagedExtension[]
  readonly operation: ExtensionOperation | null
}
export const EMPTY_EXTENSION_REGISTRY: ExtensionRegistry = Object.freeze({ schema: 1, items: [], operation: null })
const reservedName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i
export const extensionId = (input: unknown): input is string => typeof input === 'string' && /^[a-z][a-z0-9-]{0,47}$/.test(input) && !reservedName.test(input)
export const extensionRevision = (input: unknown): input is string => typeof input === 'string' && /^[a-f0-9]{64}$/.test(input)
export function extensionFile(input: unknown): input is string {
  return typeof input === 'string' && input.length <= 240 && input.split('/').every(part => /^[A-Za-z0-9_@.-]+$/.test(part)
    && !part.endsWith('.') && !reservedName.test(part) && !['.', '..', 'node_modules', '.git', 'data', 'runtime', 'workspace', '.cache'].includes(part.toLowerCase()))
    && !input.split('/').some(part => /^\.env(?:\.|$)|(?:^|[._-])(?:credentials?|secrets?|tokens?)(?:\.|$)|\.(?:sqlite|db|pem|key|p12|pfx)(?:$|-(?:wal|shm|journal)$)|^(?:id_rsa|id_ed25519|hosts\.yml)$/i.test(part))
}
export function parseExtensionManifest(input: unknown): ExtensionManifest | null {
  if (!isRecord(input) || Object.keys(input).some(key => !['schema','id','version','displayName','entry','files','packages'].includes(key))
    || input.schema !== 1 || !extensionId(input.id) || typeof input.version !== 'string' || input.version.length>64 || !/^\d+\.\d+\.\d+$/.test(input.version)
    || typeof input.displayName !== 'string' || !input.displayName.trim() || input.displayName.length > 80 || /[\x00-\x1f\x7f]/.test(input.displayName)
    || !extensionFile(input.entry) || input.entry.includes('/') || !input.entry.endsWith('.ts') || !Array.isArray(input.files) || input.files.length < 1 || input.files.length > 128
    || !input.files.every(extensionFile) || new Set(input.files.map(file => file.toLowerCase())).size !== input.files.length || !input.files.includes(input.entry)
    || !input.files.includes('package.json') || !Array.isArray(input.packages) || input.packages.length < 1 || input.packages.length > 32
    || !input.packages.every(extensionId) || new Set(input.packages).size !== input.packages.length) return null
  return input as unknown as ExtensionManifest
}
export function parseManagedExtension(input: unknown): ManagedExtension | null {
  if (!isRecord(input) || Object.keys(input).some(key => !['schema','id','version','displayName','entry','files','packages','revision','directory','fingerprint','enabled'].includes(key))) return null
  const { revision, directory, fingerprint, enabled, ...manifest } = input
  if (!parseExtensionManifest(manifest) || !extensionRevision(revision) || !extensionRevision(fingerprint)
    || typeof directory !== 'string' || directory.length > 4096 || /[\x00-\x1f\x7f]/.test(directory) || typeof enabled !== 'boolean') return null
  return input as unknown as ManagedExtension
}
function entries(input: unknown): input is readonly ManagedExtension[] {
  return Array.isArray(input) && input.length <= 32 && input.every(item => parseManagedExtension(item) !== null)
    && new Set(input.map(item => item.id)).size === input.length
    && new Set(input.flatMap(item => item.enabled ? item.packages : [])).size === input.flatMap(item => item.enabled ? item.packages : []).length
}
export function parseExtensionRegistry(input: unknown): ExtensionRegistry | null {
  if (!isRecord(input) || Object.keys(input).length !== 3 || input.schema !== 1 || !entries(input.items)) return null
  const op = input.operation
  if (op !== null && (!isRecord(op) || Object.keys(op).length !== 5 || typeof op.id !== 'string'
    || !/^[a-f0-9-]{36}$/.test(op.id) || !['prepared','applying','completed','restoring','rolled-back','unknown'].includes(String(op.phase))
    || !entries(op.before) || !entries(op.after) || !(op.error === null || typeof op.error === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/.test(op.error)))) return null
  return input as unknown as ExtensionRegistry
}
