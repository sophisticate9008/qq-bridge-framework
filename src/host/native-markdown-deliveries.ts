import type { EventReport, FeatureDefinition, FeatureExecution, FrameworkEvent, MessageContent } from '../core/types.ts'
import { normalizeContent } from '../core/content.ts'
import { normalizeDeliveryReceipt } from '../core/delivery.ts'
import { assert, errorCode, isRecord, reference } from '../core/values.ts'
import type { AgentMessageDelivery } from './bridge.ts'
import type { DurableStore, SessionBinding, StoredRecord } from './types.ts'
import { digest, json, records } from './data.ts'
import { isNativeMarkdownText, parseNativeOutputContent, type NativeMarkdownOutputRequest } from './native-output.ts'

export const NATIVE_MARKDOWN_DELIVERY_EVENT = 'native.markdown.delivery'
const namespace = 'native-chat.markdown-deliveries'
const terminalRetentionMs = 7 * 24 * 60 * 60 * 1000
type State = 'queued' | 'rendering' | 'ready' | 'sending' | 'sent' | 'failed' | 'unknown'
interface Job {
  schema: 1
  id: string
  accountId: string
  state: State
  createdAt: number
  event: FrameworkEvent
  request: NativeMarkdownOutputRequest
  content: readonly MessageContent[] | null
  result: AgentMessageDelivery | null
  errorCode: string | null
}
const pending = (state: State) => ['queued', 'rendering', 'ready', 'sending'].includes(state)

export function validateNativeMarkdownDeliveryEvent(data: Record<string, unknown>): boolean {
  return Object.keys(data).length === 2 && typeof data.jobId === 'string' && /^[a-f0-9]{64}$/.test(data.jobId)
    && Number.isSafeInteger(data.generation) && Number(data.generation) > 0
}

/** Accepted documents outlive their model turn. Rendering never occupies the conversation's engine queue. */
export function createNativeMarkdownDeliveries(options: {
  readonly store: DurableStore
  readonly accountId: string
  readonly signal: AbortSignal
  readonly binding: (conversationId: string) => SessionBinding | null
  readonly authorize: (conversationId: string, signal: AbortSignal) => Promise<void>
  readonly render: (request: NativeMarkdownOutputRequest & { readonly event: FrameworkEvent; readonly signal: AbortSignal }) => Promise<readonly MessageContent[]>
  readonly dispatch: (event: FrameworkEvent, signal: AbortSignal) => Promise<EventReport>
  readonly delivered: (event: FrameworkEvent, result: AgentMessageDelivery, content: readonly MessageContent[]) => void
  readonly observe?: (state: State, event: FrameworkEvent, code?: string) => void
  readonly onFault?: (code: string) => void
}) {
  options.store.createIndex?.({ namespace, field: 'state' })
  let started = false, stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let running: Promise<void> | undefined
  function rows(states: readonly State[]): readonly StoredRecord[] {
    return options.store.lookup
      ? states.flatMap(state => options.store.lookup!({ namespace, field: 'state', equals: state, limit: 33 }))
      : [...records(options.store, namespace)].filter(row => states.includes(read(row).state))
  }
  function read(row: StoredRecord): Job {
    const value = row.value
    assert(isRecord(value) && value.schema === 1 && value.id === row.key && /^[a-f0-9]{64}$/.test(row.key)
      && value.accountId === options.accountId && ['queued', 'rendering', 'ready', 'sending', 'sent', 'failed', 'unknown'].includes(String(value.state))
      && Number.isSafeInteger(value.createdAt) && isRecord(value.event) && reference(value.event.id)
      && reference(value.event.conversationId) && reference(value.event.sessionId) && isRecord(value.event.data)
      && Number.isSafeInteger(value.event.data.generation) && Number(value.event.data.generation) > 0
      && isRecord(value.event.data.agentData) && reference(value.event.data.agentData.nativeRequestId)
      && isRecord(value.request) && ['markdown-image', 'html-image'].includes(String(value.request.format)) && typeof value.request.body === 'string'
      && value.request.body.trim().length > 0 && value.request.body.length <= 32000 && Buffer.byteLength(value.request.body) <= 65536
      && (value.request.title === undefined || typeof value.request.title === 'string' && value.request.title.length <= 120)
      && (value.content === null || Array.isArray(value.content))
      && (value.result === null || isRecord(value.result) && ['sent', 'queued', 'rejected', 'unknown'].includes(String(value.result.status))
        && Array.isArray(value.result.receipts))
      && (value.errorCode === null || typeof value.errorCode === 'string'),
    'NATIVE_MARKDOWN_QUEUE_INVALID', 'The stored Markdown delivery is invalid.')
    if (value.content !== null) normalizeContent(value.content)
    if (isRecord(value.result) && Array.isArray(value.result.receipts)) value.result.receipts.forEach(normalizeDeliveryReceipt)
    return value as unknown as Job
  }
  function update(row: StoredRecord, changes: Partial<Job>) {
    const next = { ...read(row), ...changes }
    return options.store.write(namespace, row.key, json(next), { expectedRevision: row.revision,
      expiresAt: pending(next.state) ? null : Date.now() + terminalRetentionMs })
  }
  function current(job: Job) {
    const binding = options.binding(job.event.conversationId)
    assert(binding && binding.sessionId === job.event.sessionId && binding.generation === job.event.data.generation,
      'NATIVE_MARKDOWN_SESSION_STALE', 'The original Markdown delivery session has changed.')
  }
  function finish(row: StoredRecord, result: AgentMessageDelivery, content: readonly MessageContent[] = []) {
    const job = read(row)
    const state = result.status === 'sent' ? 'sent' : result.status === 'unknown' ? 'unknown' : 'failed'
    update(row, { state, result, errorCode: result.errorCode ?? null })
    try { options.delivered(job.event, result, content) } catch {}
    try { options.observe?.(state, job.event, result.errorCode) } catch {}
  }
  async function send(execution: FeatureExecution, event: FrameworkEvent) {
    const row = options.store.read(namespace, String(event.data.jobId))
    assert(row, 'NATIVE_MARKDOWN_QUEUE_INVALID', 'The Markdown delivery is not registered.')
    const job = read(row)
    assert(event.id === `markdown-send:${job.id}` && event.conversationId === job.event.conversationId
      && event.sessionId === job.event.sessionId && event.data.generation === job.event.data.generation
      && job.state === 'ready' && job.content !== null, 'NATIVE_MARKDOWN_QUEUE_INVALID', 'The delivery event does not match its queued document.')
    current(job)
    await options.authorize(event.conversationId, execution.signal)
    execution.signal.throwIfAborted()
    current(job)
    let held = update(row, { state: 'sending' })
    const receipts: AgentMessageDelivery['receipts'][number][] = []
    const confirmed: MessageContent[] = []
    try {
      // Send one page at a time through the original whitelist, engine policy and durable outbox.
      for (const page of job.content) {
        await options.authorize(event.conversationId, execution.signal)
        execution.signal.throwIfAborted()
        current(job)
        const receipt = await execution.send([page])
        receipts.push(receipt)
        if (receipt.status !== 'confirmed') {
          finish(held, { status: receipt.status, receipts, errorCode: receipt.status === 'unknown' ? 'DELIVERY_UNKNOWN' : 'DELIVERY_REJECTED' }, confirmed)
          return
        }
        confirmed.push(page)
        held = update(held, { result: { status: 'queued', receipts: [...receipts] } })
      }
      finish(held, { status: 'sent', receipts }, confirmed)
    } catch (error) {
      // A stop or lost receipt after send admission can never be automatically replayed.
      finish(held, { status: 'unknown', receipts, errorCode: errorCode(error, 'DELIVERY_UNKNOWN') }, confirmed)
    }
  }
  async function processJob(original: StoredRecord) {
    let row = original, job = read(row)
    try {
      current(job)
      await options.authorize(job.event.conversationId, options.signal)
      options.signal.throwIfAborted()
      if (job.state === 'queued') {
        row = update(row, { state: 'rendering' })
        const content = normalizeContent(await options.render({ ...job.request, event: job.event, signal: options.signal }))
        options.signal.throwIfAborted()
        assert(content.length > 0 && content.length <= 6 && content.every(part => part.type === 'image'),
          'NATIVE_MARKDOWN_INVALID_PNG', 'The Markdown worker must return registered image pages.')
        row = update(row, { state: 'ready', content })
        job = read(row)
      }
      const report = await options.dispatch({ ...(job.event.accountScope ? { accountScope: job.event.accountScope } : {}),
        id: `markdown-send:${job.id}`, type: NATIVE_MARKDOWN_DELIVERY_EVENT,
        conversationId: job.event.conversationId, sessionId: job.event.sessionId,
        data: { jobId: job.id, generation: Number(job.event.data.generation) } }, options.signal)
      const latest = options.store.read(namespace, job.id)!
      if (pending(read(latest).state)) {
        if (options.signal.aborted) return
        finish(latest, { status: 'rejected', receipts: [], errorCode: report.outcomes.find(outcome => outcome.status === 'failed')?.errorCode ?? 'NATIVE_MARKDOWN_DELIVERY_FAILED' })
      }
    } catch (error) {
      const latest = options.store.read(namespace, job.id)
      if (!latest || !pending(read(latest).state)) return
      if (options.signal.aborted || stopped) {
        if (read(latest).state === 'rendering') update(latest, { state: 'queued', content: null })
        return
      }
      finish(latest, { status: 'rejected', receipts: [], errorCode: errorCode(error, 'NATIVE_MARKDOWN_RENDER_FAILED') })
    }
  }
  function schedule() {
    if (!started || stopped || options.signal.aborted || timer || running) return
    timer = setTimeout(() => {
      timer = undefined
      let failed = false
      running = (async () => {
        while (!stopped && !options.signal.aborted) {
          const next = [...rows(['queued', 'ready'])]
            .sort((left, right) => read(left).createdAt - read(right).createdAt || left.key.localeCompare(right.key))[0]
          if (!next) return
          await processJob(next)
        }
      })().catch(error => {
        failed = true
        try { options.onFault?.(errorCode(error, 'NATIVE_MARKDOWN_QUEUE_FAILED')) } catch {}
      }).finally(() => {
        running = undefined
        if (!failed && !stopped && !options.signal.aborted && rows(['queued', 'ready']).length) schedule()
      })
    }, 0)
    timer.unref()
  }
  return {
    async defer(event: FrameworkEvent, signal: AbortSignal): Promise<AgentMessageDelivery | null> {
      const content = normalizeContent(event.data.content)
      const parsed = parseNativeOutputContent(content)
      const body = 'format' in parsed ? null : parsed.every(part => part.type === 'text')
        ? parsed.map(part => part.type === 'text' ? part.text : '').join('') : null
      const request: NativeMarkdownOutputRequest | null = 'format' in parsed ? parsed
        : body !== null && isNativeMarkdownText(body) ? { format: 'markdown-image', body } : null
      if (!request) return null
      assert(!stopped && !options.signal.aborted && typeof event.sessionId === 'string'
        && isRecord(event.data.agentData) && reference(event.data.agentData.nativeRequestId),
      'NATIVE_MARKDOWN_UNAVAILABLE', 'A live admitted reply source is required.')
      assert(request.body.trim().length > 0 && request.body.length <= 32000 && Buffer.byteLength(request.body) <= 65536,
        'NATIVE_MARKDOWN_INPUT_LIMIT', 'Markdown requires bounded text.')
      const id = digest([options.accountId, event.conversationId, event.sessionId, event.data.generation,
        event.data.agentData.nativeRequestId, request])
      const prior = options.store.read(namespace, id)
      if (prior) {
        const job = read(prior)
        if (job.result && !pending(job.state)) return { ...job.result, deliveryId: id, reused: true }
        return { status: 'queued', receipts: [], deliveryId: id, reused: true }
      }
      const job: Job = { schema: 1, id, accountId: options.accountId, state: 'queued', createdAt: Date.now(),
        event: { ...(event.accountScope ? { accountScope: event.accountScope } : {}), id: event.id, type: event.type,
          conversationId: event.conversationId, sessionId: event.sessionId, data: { generation: event.data.generation!,
            content: event.data.content!, agentData: { nativeRequestId: event.data.agentData.nativeRequestId } } },
        request, content: null, result: null, errorCode: null }
      current(job)
      await options.authorize(event.conversationId, signal)
      signal.throwIfAborted()
      current(job)
      assert(rows(['queued', 'rendering', 'ready', 'sending']).length < 32,
        'NATIVE_MARKDOWN_BACKPRESSURE', 'The background document queue is full; this document has not been accepted.')
      options.store.write(namespace, id, json(job), { expectedRevision: null })
      try { options.observe?.('queued', job.event) } catch {}
      schedule()
      return { status: 'queued', receipts: [], deliveryId: id }
    },
    feature(feature: FeatureDefinition): FeatureDefinition {
      return { ...feature, subscriptions: [...feature.subscriptions, NATIVE_MARKDOWN_DELIVERY_EVENT],
        setup(services) { const dispose = feature.setup(services); services.on(NATIVE_MARKDOWN_DELIVERY_EVENT, send); return dispose } }
    },
    start() {
      for (const row of rows(['rendering', 'sending'])) {
        const job = read(row)
        if (job.state === 'rendering') update(row, { state: 'queued', content: null })
        else if (job.state === 'sending') finish(row, { status: 'unknown', receipts: job.result?.receipts ?? [], errorCode: 'DISPATCH_INTERRUPTED' },
          job.content?.slice(0, job.result?.receipts.filter(receipt => receipt.status === 'confirmed').length ?? 0) ?? [])
      }
      started = true
      schedule()
    },
    async stop() { stopped = true; clearTimeout(timer); timer = undefined; await running?.catch(() => {}) },
  }
}
