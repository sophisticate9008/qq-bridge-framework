import { spawn } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute } from 'node:path'
import { CHAT_REPAIR_PATH, type ChatRepairSnapshot } from '../contracts/chat-repair.ts'
import { isNativeApplicationId } from '../contracts/native-application.ts'
import { createChatRepairStorage, projectChatRepair, type ChatRepairRecord } from '../storage/chat-repair.ts'
import { AdminRequestError, type AdminRoute } from './server.ts'

/** The browser selects no command, path or component. Its request starts a fixed, detached maintenance workflow. */
export function createChatRepairRoutes(options: { readonly directory: string; readonly configurationFilename?: string; readonly serviceManager?: string;
  readonly assertRepairScope?: () => Promise<void> }): AdminRoute[] {
  const storage = createChatRepairStorage(options.directory)
  const available = process.platform === 'linux' && Boolean(options.configurationFilename && isAbsolute(options.configurationFilename) && options.serviceManager && isAbsolute(options.serviceManager))
  let admitting = false
  async function read(id?: string): Promise<ChatRepairSnapshot> {
    const journal = await storage.read()
    const record = id ? journal.value.records.find(entry => entry.operation.id === id) : journal.value.records.at(-1)
    return { schema: 1, available, operation: record ? await projectChatRepair(record) : null, applicationId: record?.applicationId ?? null }
  }
  return [{ method: 'GET', pathname: CHAT_REPAIR_PATH, async handle({ query }) {
    const id = query.get('id')
    if (query.size > 1 || query.size === 1 && (!query.has('id') || !isNativeApplicationId(id))) throw new AdminRequestError(400, 'invalid_chat_repair_request')
    return read(id ?? undefined)
  } }, { method: 'POST', pathname: `${CHAT_REPAIR_PATH}/reconcile`, maxRequestBytes: 1024, async handle({ query, body }) {
    if (query.size || !body || Object.keys(body).length !== 1 || !isNativeApplicationId(body.operationId)) throw new AdminRequestError(400, 'invalid_chat_repair_request')
    const operationId = body.operationId
    let found = false
    await storage.modify(journal => {
      found = journal.records.some(entry => entry.operation.id === operationId)
      if (found || journal.retired.includes(operationId)) return journal
      if (journal.retired.length >= 8192) throw new AdminRequestError(409, 'chat_repair_history_full')
      return { ...journal, retired: [...journal.retired, operationId] }
    })
    if (!found) throw new AdminRequestError(409, 'chat_repair_not_received')
    return read(operationId)
  } }, { method: 'POST', pathname: CHAT_REPAIR_PATH, maxRequestBytes: 1024, async handle({ query, body, signal }) {
    if (query.size || !body || Object.keys(body).length !== 1 || !isNativeApplicationId(body.operationId)) throw new AdminRequestError(400, 'invalid_chat_repair_request')
    const operationId = body.operationId
    if (!available) throw new AdminRequestError(409, 'chat_repair_unavailable')
    if (admitting) throw new AdminRequestError(409, 'chat_repair_busy')
    admitting = true
    try {
      signal.throwIfAborted()
      await options.assertRepairScope?.()
      let accepted = false
      let selectedId = operationId
      await storage.modify(async journal => {
        if (journal.records.some(entry => entry.operation.id === operationId)) return journal
        if (journal.retired.includes(operationId)) throw new AdminRequestError(409, 'chat_repair_retired')
        for (const record of journal.records) if ((await projectChatRepair(record)).state === 'running') {
          selectedId = record.operation.id
          return journal
        }
        const records = await Promise.all(journal.records.map(async entry => ({ ...entry, operation: await projectChatRepair(entry) })))
        const at = Date.now()
        const record: ChatRepairRecord = { operation: { id: operationId, state: 'running', phase: 'checking', createdAt: at, updatedAt: at, reasons: [] }, worker: null }
        const retired = [...journal.retired, ...records.slice(0, -15).map(entry => entry.operation.id)]
        if (retired.length > 8192) throw new AdminRequestError(409, 'chat_repair_history_full')
        accepted = true
        return { schema: 1, records: [...records.slice(-15), record], retired }
      })
      if (accepted) {
        // No HTTP lifetime signal reaches this session. The worker survives stopping its accepting framework.
        const environment = { ...process.env }
        delete environment.QQ_BRIDGE_FRAMEWORK_OPS_LOCKED
        let manager: string | null = null
        try {
          const canonical = await realpath(options.serviceManager!)
          const metadata = await lstat(canonical)
          if (!metadata.isFile() || metadata.nlink !== 1 || (metadata.mode & 0o022) !== 0 || (metadata.mode & 0o111) === 0
            || metadata.uid !== process.getuid?.() || basename(canonical) !== 'qbf-cli' || basename(dirname(canonical)) !== 'ops') throw new Error('Unsafe manager')
          for (const path of [dirname(canonical), dirname(dirname(canonical))]) {
            const metadata = await lstat(path)
            if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o022) !== 0 || metadata.uid !== process.getuid?.()) throw new Error('Unsafe manager directory')
          }
          manager = canonical
        } catch { /* Persist a retryable start failure; the browser never supplies this executable. */ }
        const spawned = manager !== null && await new Promise<boolean>(resolve => {
          try {
            const child = spawn(manager!, ['repair-chat', operationId, '--config', options.configurationFilename!],
              { detached: true, stdio: 'ignore', env: environment })
            child.once('error', () => resolve(false))
            child.once('spawn', () => { child.unref(); resolve(true) })
          } catch { resolve(false) }
        })
        if (!spawned) await storage.modify(journal => ({ ...journal, records: journal.records.map(entry =>
          entry.operation.id === operationId && entry.worker === null && entry.operation.state === 'running'
            ? { ...entry, operation: { ...entry.operation, state: 'failed', updatedAt: Date.now(), reasons: ['chat_repair_worker_start_failed'] } } : entry) }))
      }
      return read(selectedId)
    } finally { admitting = false }
  } }]
}
