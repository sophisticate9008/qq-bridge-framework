import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, open, readFile, unlink } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { parseChatRepairOperation, type ChatRepairOperation } from '../contracts/chat-repair.ts'
import { isNativeApplicationId } from '../contracts/native-application.ts'
import { isRecord } from '../contracts/values.ts'
import { ensurePrivateDirectory, readPrivateJson, replacePrivateJson, PrivateJsonStorageError } from './private-json.ts'
import { privatePermissions } from './file-security.ts'

export interface ChatRepairProcessIdentity { readonly pid: number; readonly started: string | null }
export interface ChatRepairRecord {
  readonly operation: ChatRepairOperation
  readonly applicationId?: string
  readonly worker: ChatRepairProcessIdentity | null
  readonly guardian?: ChatRepairProcessIdentity
  readonly guardianRecoveryComplete?: boolean
  readonly rescueAttempts?: number
}
interface Journal { readonly schema: 1; readonly records: readonly ChatRepairRecord[]; readonly retired: readonly string[] }
function validate(value: unknown): Journal {
  if (!isRecord(value) || value.schema !== 1 || !Array.isArray(value.records) || value.records.length > 16
    || !Array.isArray(value.retired) || value.retired.length > 8192 || !value.retired.every(isNativeApplicationId)) throw new Error('chat_repair_storage_invalid')
  const seen = new Set<string>(value.retired)
  if (seen.size !== value.retired.length) throw new Error('chat_repair_storage_invalid')
  const records = value.records.map((entry: unknown): ChatRepairRecord => {
    if (!isRecord(entry)) throw new Error('chat_repair_storage_invalid')
    const operation = parseChatRepairOperation(entry.operation)
    const identity = (value: unknown): value is ChatRepairProcessIdentity => isRecord(value) && typeof value.pid === 'number'
      && Number.isSafeInteger(value.pid) && value.pid > 0 && (value.started === null || typeof value.started === 'string' && /^\d+$/.test(value.started))
    if (!operation || seen.has(operation.id) || entry.applicationId !== undefined && !isNativeApplicationId(entry.applicationId)
      || entry.worker !== null && !identity(entry.worker) || entry.guardian !== undefined && !identity(entry.guardian)
      || entry.guardianRecoveryComplete !== undefined && typeof entry.guardianRecoveryComplete !== 'boolean'
      || entry.rescueAttempts !== undefined && (typeof entry.rescueAttempts !== 'number' || !Number.isSafeInteger(entry.rescueAttempts)
        || entry.rescueAttempts < 0 || entry.rescueAttempts > 2)) throw new Error('chat_repair_storage_invalid')
    seen.add(operation.id)
    return { operation, ...(entry.applicationId === undefined ? {} : { applicationId: entry.applicationId as string }), worker: entry.worker as ChatRepairRecord['worker'],
      ...(entry.guardian === undefined ? {} : { guardian: entry.guardian as ChatRepairProcessIdentity }),
      ...(entry.guardianRecoveryComplete === undefined ? {} : { guardianRecoveryComplete: entry.guardianRecoveryComplete as boolean }),
      ...(entry.rescueAttempts === undefined ? {} : { rescueAttempts: entry.rescueAttempts as number }) }
  })
  return { schema: 1, records, retired: value.retired }
}
export async function chatRepairProcessStart(pid: number): Promise<string | null> {
  if (process.platform !== 'linux') return null
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
  if (fields[0] === 'Z') throw Object.assign(new Error('Process exited'), { code: 'ESRCH' })
  const started = fields[19]
  if (!started || !/^\d+$/.test(started)) throw new Error('chat_repair_process_identity_invalid')
  return started
}
export async function chatRepairProcessAlive(worker: ChatRepairProcessIdentity): Promise<boolean> {
  try {
    process.kill(worker.pid, 0)
    return worker.started === null || await chatRepairProcessStart(worker.pid) === worker.started
  } catch (error) {
    // Permission and inspection failures do not prove that a process is dead.
    return !isRecord(error) || !['ESRCH', 'ENOENT'].includes(String(error.code))
  }
}
export async function chatRepairWorkerAlive(record: ChatRepairRecord): Promise<boolean> {
  if (!record.worker) return Date.now() - record.operation.createdAt < 15_000
  return chatRepairProcessAlive(record.worker)
}
export async function projectChatRepair(record: ChatRepairRecord): Promise<ChatRepairOperation> {
  if (record.operation.state === 'completed') return record.operation
  const workerAlive = await chatRepairWorkerAlive(record)
  if ((!workerAlive || record.operation.state === 'failed') && record.guardian && record.guardianRecoveryComplete !== true
    && await chatRepairProcessAlive(record.guardian)) {
    return { ...record.operation, state: 'running', phase: 'starting-services', reasons: [] }
  }
  return record.operation.state === 'running' && !workerAlive
    ? { ...record.operation, state: 'failed', updatedAt: Date.now(), reasons: ['chat_repair_worker_interrupted'] } : record.operation
}

/** Its own PID-identified lock remains recoverable when the framework dies while writing another journal. */
export function createChatRepairStorage(directory: string) {
  if (!isAbsolute(directory)) throw new Error('chat_repair_directory_invalid')
  const root = join(directory, 'chat-repair-control')
  const filename = join(root, 'journal.json')
  const lockname = join(root, 'writer.lock')
  const readOnce = () => readPrivateJson(filename, { validate, maxBytes: 524_288, exactMode: 0o600, requireSingleLink: true,
    fallback: { value: { schema: 1 as const, records: [], retired: [] } }, invalidCode: 'chat_repair_storage_invalid', conflictCode: 'chat_repair_revision_conflict' })
  async function read() {
    for (let attempt = 0; ; attempt++) {
      try { return await readOnce() }
      catch (error) { if (attempt >= 2 || !(error instanceof PrivateJsonStorageError) || error.code !== 'chat_repair_revision_conflict') throw error }
    }
  }
  async function lock(): Promise<() => Promise<void>> {
    await ensurePrivateDirectory(root)
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const temporary = join(root, `.writer-${randomUUID()}.tmp`)
        const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
        const metadata = await handle.stat()
        try {
          // Publish a complete PID identity atomically. A crash cannot leave a partially written live lock.
          await handle.writeFile(JSON.stringify({ pid: process.pid, started: await chatRepairProcessStart(process.pid) }))
          await handle.sync()
          await link(temporary, lockname)
        } catch (error) { await handle.close(); throw error }
        finally { await unlink(temporary).catch(() => undefined) }
        return async () => {
          await handle.close()
          const current = await lstat(lockname).catch(() => null)
          if (current?.ino === metadata.ino && current.dev === metadata.dev) await unlink(lockname)
        }
      } catch (error) {
        if (!isRecord(error) || error.code !== 'EEXIST') throw error
        const handle = await open(lockname, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((error: unknown) => {
          if (isRecord(error) && error.code === 'ENOENT') throw new Error('chat_repair_busy')
          throw error
        })
        try {
          const before = await handle.stat()
          if (!before.isFile() || ![1, 2].includes(before.nlink) || before.size > 1024 || !privatePermissions(lockname, before, 0o600)
            || process.getuid && before.uid !== process.getuid()) throw new Error('chat_repair_lock_invalid')
          const content = await handle.readFile('utf8')
          if (!content && Date.now() - before.mtimeMs < 15_000) throw new Error('chat_repair_busy')
          if (content) {
            const owner: unknown = JSON.parse(content)
            if (!isRecord(owner) || !Number.isSafeInteger(owner.pid) || typeof owner.pid !== 'number' || owner.pid < 1
              || owner.started !== null && (typeof owner.started !== 'string' || !/^\d+$/.test(owner.started))) throw new Error('chat_repair_lock_invalid')
            if (await chatRepairProcessAlive({ pid: owner.pid, started: owner.started as string | null })) throw new Error('chat_repair_busy')
          }
          const current = await lstat(lockname)
          if (current.ino !== before.ino || current.dev !== before.dev || current.mtimeMs !== before.mtimeMs) throw new Error('chat_repair_busy')
          await unlink(lockname)
        } finally { await handle.close() }
      }
    }
    throw new Error('chat_repair_busy')
  }
  async function acquire() {
    const deadline = Date.now() + 2500
    while (true) {
      try { return await lock() }
      catch (error) {
        if (!(error instanceof Error) || error.message !== 'chat_repair_busy') throw error
        if (Date.now() >= deadline) throw new PrivateJsonStorageError(409, 'chat_repair_busy')
        await new Promise<void>(resolve => setTimeout(resolve, 25))
      }
    }
  }
  async function replace(expectedRevision: string, input: Journal) {
    const value = validate(input)
    const content = Buffer.from(JSON.stringify(value) + '\n')
    if (content.byteLength > 524_288) throw new Error('chat_repair_history_full')
    return replacePrivateJson({ directory: root, filename, expectedRevision, temporary: join(root, `.repair-${randomUUID()}.tmp`), content, read,
      verifyTemporaryMetadata: true, conflictCode: 'chat_repair_revision_conflict', writeFailedCode: 'chat_repair_write_failed', writeUnknownCode: 'chat_repair_write_unknown' })
  }
  return { read, async write(expectedRevision: string, input: Journal) {
    const release = await acquire()
    try { return await replace(expectedRevision, input) } finally { await release() }
  }, async modify(change: (value: Journal) => Journal | Promise<Journal>) {
    const release = await acquire()
    try { const prior = await read(); return await replace(prior.revision, await change(prior.value)) } finally { await release() }
  } }
}
