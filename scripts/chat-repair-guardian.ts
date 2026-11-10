import { createChatRepairStorage, chatRepairProcessAlive, chatRepairProcessStart, type ChatRepairProcessIdentity, type ChatRepairRecord } from '../src/storage/chat-repair.ts'

export interface ChatRepairGuardianPorts {
  /** Only the trusted, protocol-excluding managed service start command. No configuration application. */
  start(): Promise<void>
  ready(): Promise<boolean>
}
const same = (left: ChatRepairProcessIdentity | null | undefined, right: ChatRepairProcessIdentity) => left?.pid === right.pid && left.started === right.started

/** An independent process, sharing the detached repair session so service stopping also protects the guardian. */
export async function runChatRepairGuardian(options: { readonly directory: string; readonly operationId: string; readonly pollMs?: number }, ports: ChatRepairGuardianPorts): Promise<void> {
  const storage = createChatRepairStorage(options.directory)
  const guardian = { pid: process.pid, started: await chatRepairProcessStart(process.pid) }
  let worker: ChatRepairProcessIdentity | null = null
  await storage.modify(async journal => {
    const record = journal.records.find(entry => entry.operation.id === options.operationId)
    if (!record?.worker || record.operation.state === 'completed' || record.guardianRecoveryComplete === true
      || record.guardian && await chatRepairProcessAlive(record.guardian)) return journal
    worker = record.worker
    return { ...journal, records: journal.records.map(entry => entry === record ? { ...entry, guardian, guardianRecoveryComplete: false } : entry) }
  })
  if (!worker) return
  const ownedWorker: ChatRepairProcessIdentity = worker
  const pause = () => new Promise<void>(resolve => setTimeout(resolve, options.pollMs ?? 1000))
  const owns = (record: ChatRepairRecord | undefined) => record && same(record.worker, ownedWorker) && same(record.guardian, guardian)
  const ready = async () => { try { return await ports.ready() } catch { return false } }
  while (true) {
    const record = (await storage.read()).value.records.find(entry => entry.operation.id === options.operationId)
    if (!owns(record) || !record || record.operation.state === 'completed' || record.guardianRecoveryComplete === true) return
    if (record.operation.state === 'running' && await chatRepairProcessAlive(ownedWorker)) { await pause(); continue }
    const interrupted = record.operation.state === 'running'
    // A still-running stop stage may shut the UI after a successful probe. Rescue waits on its same operations lock first.
    const disrupted = (interrupted || record.restartDsh === true) && record.operation.phase !== 'checking'
    let available = disrupted ? false : await ready()
    let attempts = record.rescueAttempts ?? 0
    while (!available && attempts < 2) {
      let permitted = false
      await storage.modify(journal => ({ ...journal, records: journal.records.map(entry => {
        if (!owns(entry) || entry.operation.state === 'completed' || (entry.rescueAttempts ?? 0) >= 2) return entry
        permitted = true
        return { ...entry, rescueAttempts: (entry.rescueAttempts ?? 0) + 1 }
      }) }))
      if (!permitted) break
      attempts++
      try { await ports.start() } catch { /* Another bounded attempt remains; never replay an application or model operation. */ }
      available = await ready()
      if (!available) await pause()
    }
    await storage.modify(journal => ({ ...journal, records: journal.records.map(entry => {
      if (!owns(entry) || entry.operation.state === 'completed') return entry
      const reasons = [...new Set([...entry.operation.reasons,
        ...(interrupted ? ['chat_repair_worker_interrupted'] : []), ...(!available ? ['chat_repair_services_not_restored'] : [])])].slice(0, 16)
      return { ...entry, guardianRecoveryComplete: true, operation: { ...entry.operation, state: 'failed', updatedAt: Date.now(), reasons } }
    }) }))
    return
  }
}
