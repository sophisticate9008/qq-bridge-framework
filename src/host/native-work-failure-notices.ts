import type { DeliveryReceipt } from '../core/types.ts'
import type { NativeWorkView } from '../contracts/native-work.ts'
import type { createBridgeHost } from './bridge.ts'
import type { DurableStore } from './types.ts'
import { assert, errorCode } from '../core/values.ts'
import { createNativeWorkHistoryReader } from './native-work-history.ts'
import { digest, json, object } from './data.ts'
import { withDeadline } from './deadlines.ts'

export interface WorkFailureNotice {
  readonly id: string
  readonly work: NativeWorkView
  readonly ownerId: string
  readonly runId: string
  readonly taskSummary: string | null
  readonly reason: 'timeout' | 'interrupted' | 'failed' | 'unknown'
}
/** Failure notices have their own durable send evidence; they never turn unknown work into success or retry it. */
export function createNativeWorkFailureNotifier(options: {
  readonly store: DurableStore
  readonly signal: AbortSignal
  readonly current: (work: NativeWorkView, ownerId: string, runId: string) => boolean
  readonly deliver: (notice: WorkFailureNotice, signal: AbortSignal) => Promise<DeliveryReceipt>
  readonly onFault?: (code: string) => void
}) {
  const namespace = 'native-work.failure-notices'
  const history = createNativeWorkHistoryReader(options.store)
  const active = new Map<string, Promise<void>>()
  let after: string | undefined
  options.store.createIndex?.({ namespace, field: 'status' })
  const eligible = (work: NativeWorkView) => ['unknown', 'failed'].includes(work.status) && work.result === null && work.delivery === 'not-requested'
  function observe(id: string): void {
    if (options.signal.aborted) return
    const work = history.read(id)
    if (!work || !eligible(work)) return
    const record = object(options.store.read('native-work.executions', id)?.value)
    const key = digest([id, record.runId ?? id])
    if (options.store.read(namespace, key) || typeof record.ownerId !== 'string') return
    options.store.write(namespace, key, json({ schema: 1, id: key, workId: id, runId: record.runId ?? id,
      ownerId: record.ownerId, status: 'pending', createdAt: Date.now() }), { expectedRevision: null })
    tick()
  }
  async function send(key: string): Promise<void> {
    const row = options.store.read(namespace, key)
    if (!row || object(row.value).status !== 'pending' || options.signal.aborted) return
    const saved = object(row.value), work = history.read(String(saved.workId))
    const original = object(options.store.read('native-work.executions', String(saved.workId))?.value)
    if (!work || !eligible(work) || (original.runId ?? work.id) !== saved.runId
      || typeof saved.ownerId !== 'string' || typeof saved.runId !== 'string' || !options.current(work, saved.ownerId, saved.runId)) {
      options.store.write(namespace, key, json({ ...saved, status: 'rejected', errorCode: 'WORK_PARENT_UNAVAILABLE' }), { expectedRevision: row.revision }); return
    }
    const sending = options.store.write(namespace, key, json({ ...saved, status: 'sending' }), { expectedRevision: row.revision })
    let receipt: DeliveryReceipt = { status: 'unknown' }
    let code: string | null = null
    try {
      receipt = await withDeadline({ signal: options.signal, timeoutMs: 120000, code: 'WORK_FAILURE_NOTICE_UNKNOWN',
        run: signal => options.deliver({ id: `work-failure:${key}`, work, ownerId: String(saved.ownerId), runId: String(saved.runId),
          taskSummary: typeof original.taskSummary === 'string' ? original.taskSummary.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 120) : null,
          reason: /TIMEOUT|DEADLINE/.test(work.lastError ?? '') ? 'timeout'
            : /INTERRUPTED|STOP_UNKNOWN/.test(work.lastError ?? '') ? 'interrupted' : work.status === 'failed' ? 'failed' : 'unknown' }, signal) })
    } catch (error) { code = errorCode(error, 'WORK_FAILURE_NOTICE_UNKNOWN'); options.onFault?.(code) }
    options.store.write(namespace, key, json({ ...saved, status: receipt.status, receipt, errorCode: code, observedAt: Date.now() }), { expectedRevision: sending.revision })
  }
  function tick(): void {
    if (options.signal.aborted || active.size >= 4) return
    const rows = options.store.lookup && options.store.createIndex
      ? options.store.lookup({ namespace, field: 'status', equals: 'pending', limit: 32 })
      : options.store.list(namespace, { limit: 100, ...(after ? { after } : {}) })
    after = rows.length === 100 ? rows.at(-1)?.key : undefined
    for (const row of rows) {
      if (active.size >= 4) break
      if (active.has(row.key) || object(row.value).status !== 'pending') continue
      const operation = Promise.resolve().then(() => send(row.key)).catch(error => options.onFault?.(errorCode(error, 'WORK_FAILURE_NOTICE_UNKNOWN')))
        .finally(() => active.delete(row.key))
      active.set(row.key, operation)
    }
  }
  const timer = setInterval(tick, 1000)
  timer.unref()
  options.signal.addEventListener('abort', () => clearInterval(timer), { once: true })
  return Object.freeze({ observe,
    async recover() {
      let noticeCursor: string | undefined
      for (let page = 0; page < 1000; page++) {
        options.signal.throwIfAborted()
        const rows = options.store.list(namespace, { limit: 100, ...(noticeCursor ? { after: noticeCursor } : {}) })
        for (const row of rows) if (!active.has(row.key) && object(row.value).status === 'sending')
          options.store.write(namespace, row.key, json({ ...object(row.value), status: 'unknown', errorCode: 'WORK_FAILURE_NOTICE_INTERRUPTED' }), { expectedRevision: row.revision })
        if (rows.length < 100) break
        noticeCursor = rows.at(-1)!.key
        await new Promise<void>(resolve => setImmediate(resolve))
      }
      let cursor: string | undefined
      for (let page = 0; page < 1000; page++) {
        options.signal.throwIfAborted()
        const rows = options.store.list('native-work.executions', { limit: 100, ...(cursor ? { after: cursor } : {}) })
        for (const row of rows) observe(row.key)
        if (rows.length < 100) return
        cursor = rows.at(-1)!.key
        await new Promise<void>(resolve => setImmediate(resolve))
      }
      throw new Error('Work failure recovery exceeds its bounded history')
    },
    async drain() { await Promise.allSettled([...active.values()]) }
  })
}

/** Validate the original delegation before asking its parent agent to narrate failure facts. */
export function createNativeWorkFailureDelivery(options: {
  readonly host: ReturnType<typeof createBridgeHost>
  readonly store: DurableStore
  readonly present: (notice: WorkFailureNotice, signal: AbortSignal) => Promise<DeliveryReceipt>
  readonly owner: () => string | null
  readonly guard: (conversationId: string, signal: AbortSignal) => Promise<void>
}) {
  const current = (work: NativeWorkView, ownerId: string, runId: string) => {
    const record = object(options.store.read('native-work.executions', work.id)?.value)
    const binding = options.host.sessions.get(work.conversationId)
    return ['failed', 'unknown'].includes(String(record.status)) && record.delivery === 'not-requested' && record.result === null
      && (record.runId ?? work.id) === runId && record.ownerId === ownerId && ownerId === options.owner() && record.childId === work.childId
      && record.parentSessionId === work.parentSessionId && record.generation === work.generation
      && binding?.sessionId === work.parentSessionId && binding.generation === work.generation
  }
  return { current,
    async deliver(notice: WorkFailureNotice, signal: AbortSignal): Promise<DeliveryReceipt> {
      const { work, ownerId, runId } = notice
      await options.guard(work.conversationId, signal)
      signal.throwIfAborted()
      assert(current(work, ownerId, runId), 'WORK_PARENT_UNAVAILABLE', 'The original work owner or conversation changed.')
      return options.present(notice, signal)
    }
  }
}
