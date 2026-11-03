import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { privatePermissions, securePermissions } from '../storage/file-security.ts'

const ACCESS_TOKEN_BYTES = 32
const MAX_ACCESS_SESSIONS = 256

interface StoredAccessSession {
  readonly expiresAt: number
}

export interface AccessSession {
  readonly token: string
  readonly expiresAt: number
}

export interface AccessSessionStore {
  issue(administratorToken: string): AccessSession | null
  authenticate(accessToken: string, administratorToken: string | null): number | null
  revoke(accessToken: string): boolean
  clear(persist?: boolean): void
  activeCount(administratorToken: string | null): number
}

export interface AccessSessionStoreOptions {
  readonly ttlMs: number
  readonly clock?: () => number
  readonly filename?: string
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

function equalDigest(left: Buffer | null, right: Buffer | null): boolean {
  if (left === null || right === null) return left === right
  return timingSafeEqual(left, right)
}

export function createAccessSessionStore({
  ttlMs,
  clock = Date.now,
  filename
}: AccessSessionStoreOptions): AccessSessionStore {
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new TypeError('ttlMs must be a positive integer')
  if (typeof clock !== 'function') throw new TypeError('clock must be a function')

  const sessions = new Map<string, StoredAccessSession>()
  let administratorTokenHash: Buffer | null = null
  if (filename !== undefined && !isAbsolute(filename)) throw new TypeError('Access session storage requires an absolute path')
  const sameFile = (left: { dev: number; ino: number }, right: { dev: number; ino: number }) => left.dev === right.dev && left.ino === right.ino
  const owned = (metadata: { uid: number }) => !process.getuid || metadata.uid === process.getuid()
  let persistenceDirty = false
  if (filename) {
    let descriptor: number | undefined
    try {
      descriptor = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      const metadata = fstatSync(descriptor)
      const pathname = lstatSync(filename)
      if (!metadata.isFile() || pathname.isSymbolicLink() || !sameFile(metadata, pathname) || !owned(metadata) || metadata.nlink !== 1 || metadata.size > 65_536
        || !privatePermissions(filename, metadata, 0o600)) throw new Error('Invalid access session storage')
      const content = readFileSync(descriptor)
      const after = fstatSync(descriptor)
      if (content.byteLength > 65_536 || !sameFile(after, lstatSync(filename)) || metadata.size !== after.size
        || metadata.mtimeMs !== after.mtimeMs || metadata.ctimeMs !== after.ctimeMs) throw new Error('Access session storage changed')
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content))
      if (!value || typeof value !== 'object' || !('schema' in value) || value.schema !== 1
        || !('administrator' in value) || value.administrator !== null && (typeof value.administrator !== 'string' || !/^[a-f0-9]{64}$/.test(value.administrator))
        || !('sessions' in value) || !Array.isArray(value.sessions) || value.sessions.length > MAX_ACCESS_SESSIONS) throw new Error('Invalid access session storage')
      administratorTokenHash = value.administrator === null ? null : Buffer.from(value.administrator, 'hex')
      for (const entry of value.sessions) {
        if (!entry || typeof entry !== 'object' || !('hash' in entry) || typeof entry.hash !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(entry.hash)
          || !('expiresAt' in entry) || typeof entry.expiresAt !== 'number' || !Number.isSafeInteger(entry.expiresAt) || entry.expiresAt < 0
          || sessions.has(entry.hash)) throw new Error('Invalid access session storage')
        if (entry.expiresAt > clock()) sessions.set(entry.hash, { expiresAt: entry.expiresAt })
      }
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    } finally { if (descriptor !== undefined) closeSync(descriptor) }
  }
  const persist = () => {
    if (!filename) return
    persistenceDirty = true
    const directory = dirname(filename)
    const created = mkdirSync(directory, { recursive: true, mode: 0o700 })
    if (created) securePermissions(directory, 0o700)
    const metadata = lstatSync(directory)
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || !owned(metadata) || !privatePermissions(directory, metadata, 0o700)) throw new Error('Invalid access session directory')
    const temporary = `${filename}.${randomBytes(8).toString('hex')}.tmp`
    try {
      const descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      try {
        securePermissions(temporary, 0o600)
        const opened = fstatSync(descriptor)
        if (!opened.isFile() || opened.nlink !== 1 || !owned(opened) || !privatePermissions(temporary, opened, 0o600)
          || !sameFile(opened, lstatSync(temporary))) throw new Error('Invalid access session temporary')
        writeFileSync(descriptor, JSON.stringify({ schema: 1, administrator: administratorTokenHash?.toString('hex') ?? null,
          sessions: [...sessions].map(([hash, value]) => ({ hash, expiresAt: value.expiresAt })) }) + '\n')
        fsyncSync(descriptor)
      } finally { closeSync(descriptor) }
      if (!sameFile(metadata, lstatSync(directory))) throw new Error('Access session directory changed')
      renameSync(temporary, filename)
      if (process.platform !== 'win32') {
        const parent = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
        try { fsyncSync(parent) } finally { closeSync(parent) }
      }
      persistenceDirty = false
    } catch (error) {
      persistenceDirty = true
      throw error
    } finally { try { unlinkSync(temporary) } catch { /* Renamed temporary. */ } }
  }

  const purgeExpired = (currentTime: number): void => {
    for (const [tokenHash, session] of sessions) {
      if (session.expiresAt <= currentTime) sessions.delete(tokenHash)
    }
  }

  const synchronizeAdministrator = (administratorToken: string | null): number => {
    const currentTime = clock()
    const nextHash = administratorToken === null ? null : digest(administratorToken)
    if (!equalDigest(administratorTokenHash, nextHash)) {
      sessions.clear()
      administratorTokenHash = nextHash
      persist()
    }
    if (persistenceDirty) persist()
    purgeExpired(currentTime)
    return currentTime
  }

  return Object.freeze({
    issue(administratorToken: string): AccessSession | null {
      const currentTime = synchronizeAdministrator(administratorToken)
      if (sessions.size >= MAX_ACCESS_SESSIONS) return null

      let token: string
      let tokenHash: string
      do {
        token = randomBytes(ACCESS_TOKEN_BYTES).toString('base64url')
        tokenHash = digest(token).toString('base64url')
      } while (sessions.has(tokenHash))

      const expiresAt = currentTime + ttlMs
      sessions.set(tokenHash, Object.freeze({ expiresAt }))
      persist()
      return Object.freeze({ token, expiresAt })
    },
    authenticate(accessToken: string, administratorToken: string | null): number | null {
      synchronizeAdministrator(administratorToken)
      if (administratorToken === null) return null
      return sessions.get(digest(accessToken).toString('base64url'))?.expiresAt ?? null
    },
    revoke(accessToken: string): boolean {
      purgeExpired(clock())
      const removed = sessions.delete(digest(accessToken).toString('base64url'))
      if (removed) persist()
      return removed
    },
    clear(save = true): void {
      sessions.clear()
      administratorTokenHash = null
      if (save) persist()
    },
    activeCount(administratorToken: string | null): number {
      synchronizeAdministrator(administratorToken)
      return sessions.size
    }
  })
}
