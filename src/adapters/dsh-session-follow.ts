import { createHash, randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { snapshot } from '../core/values.ts'
import { DshAdapterError, type DshFollowRequest, type DshFollowEvent } from './dsh.ts'
import { dshFailure as failure, dshRecord as record, dshIdentifier as identifier, type DshCallbackBudget } from './dsh-stream-common.ts'
import type { DshFollowCursors, createDshFollowByteBudget } from './dsh-follow-budget.ts'

export function createDshSessionFollower(options: { readonly base: URL; readonly timeoutMs: number; readonly idleMs: number;
  readonly maxPendingEvents: number; readonly maxFollows: number; readonly maxBytes: number; readonly lifetime: AbortController;
  readonly follows: Map<string, () => Promise<void>>; readonly callbacks: DshCallbackBudget;
  readonly byteBudget?: ReturnType<typeof createDshFollowByteBudget>;
  readonly cursors?: DshFollowCursors;
  readonly bridgeStream?: (signal: AbortSignal) => Promise<{ issuerEpoch: string } | null>;
  readonly authenticate: (signal: AbortSignal) => Promise<string> }) {
  const { base, timeoutMs, idleMs, maxPendingEvents, maxFollows, maxBytes, lifetime, follows, callbacks, authenticate } = options
  const invokeCallback = (request: DshFollowRequest, event: DshFollowEvent, signal: AbortSignal) =>
    callbacks.deliver(event, request.onEvent, signal, 'DSH_FOLLOW_BACKPRESSURE')
  const follow = async (request: DshFollowRequest): Promise<() => Promise<void>> => {
    if (!identifier(request.sessionId)) throw failure('DSH_INVALID_SESSION')
    if (follows.has(request.sessionId)) throw failure('DSH_FOLLOW_ALREADY_ACTIVE')
    if (follows.size >= maxFollows || callbacks.active >= maxFollows) throw failure('DSH_FOLLOW_BACKPRESSURE')
    const controller = new AbortController()
    const signal = AbortSignal.any([request.signal, lifetime.signal, controller.signal])
    let socket: WebSocket | undefined
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    let pongTimer: ReturnType<typeof setTimeout> | undefined
    let pendingPing: string | undefined
    let openingTimer: ReturnType<typeof setTimeout> | undefined
    let opened = false
    let stopped = false
    let nextSeq = 0
    let bridge: { issuerEpoch: string } | null = null
    let snapshotSeen = false
    let readySeen = false
    let queueBytes = 0
    let assembly: { seq: number; bytes: number; hash: string; replayed: boolean; offset: number; chunks: Buffer[] } | undefined
    let pumping: Promise<void> | undefined
    const queue: { event: DshFollowEvent; bytes: number; sequence: number }[] = []
    const streamId = randomUUID()
    let readyResolve: () => void = () => undefined
    let readyReject: (error: Error) => void = () => undefined
    const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject })
    void ready.catch(() => undefined)
    const stop = async (): Promise<void> => {
      if (!stopped) {
        stopped = true
        queue.length = 0
        options.byteBudget?.release(queueBytes + (assembly?.bytes ?? 0))
        queueBytes = 0
        assembly = undefined
        clearTimeout(idleTimer)
        clearTimeout(pongTimer)
        pendingPing = undefined
        clearTimeout(openingTimer)
        signal.removeEventListener('abort', abort)
        controller.abort()
        if (follows.get(request.sessionId) === stop) follows.delete(request.sessionId)
        readyReject(failure('DSH_ABORTED'))
        if (socket?.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'cancel', streamId }))
        }
        socket?.terminate()
      }
      await pumping?.catch(() => undefined)
    }
    const fail = (code: string): void => {
      if (stopped) return
      const wasOpened = opened
      readyReject(failure(code))
      void stop().then(async () => {
        if (wasOpened && !request.signal.aborted && !lifetime.signal.aborted && !follows.has(request.sessionId)) {
          await invokeCallback(request, { type: 'stream/error', sessionId: request.sessionId, error: { code } }, request.signal)
        }
      }).catch(() => undefined)
    }
    const abort = (): void => { void stop().catch(() => undefined) }
    const resetIdle = (): void => {
      clearTimeout(idleTimer)
      if (stopped || !opened || pendingPing !== undefined) return
      idleTimer = setTimeout(() => {
        if (stopped) return
        if (socket?.readyState !== WebSocket.OPEN) { fail('DSH_FOLLOW_ENDED'); return }
        pendingPing = randomUUID()
        pongTimer = setTimeout(() => fail('DSH_FOLLOW_PONG_TIMEOUT'), Math.min(timeoutMs, 10_000))
        try {
          socket.ping(pendingPing, undefined, error => { if (error) fail('DSH_FOLLOW_TRANSPORT_UNKNOWN') })
        } catch { fail('DSH_FOLLOW_TRANSPORT_UNKNOWN') }
      }, idleMs)
    }
    const pump = (): void => {
      if (pumping !== undefined || stopped) return
      pumping = (async () => {
        while (!stopped && queue.length > 0) {
          const item = queue.shift()!
          try {
            await invokeCallback(request, item.event, signal)
            if (!stopped && bridge) options.cursors?.save(request.sessionId, item.sequence)
          } finally {
            // A concurrent stop already released every retained byte.
            if (!stopped) { queueBytes -= item.bytes; options.byteBudget?.release(item.bytes) }
          }
        }
      })()
      void pumping.then(() => { pumping = undefined; if (queue.length > 0) pump() }, () => {
        pumping = undefined
        fail('DSH_FOLLOW_CALLBACK_FAILED')
      })
    }
    follows.set(request.sessionId, stop)
    signal.addEventListener('abort', abort, { once: true })
    try {
      signal.throwIfAborted()
      openingTimer = setTimeout(() => fail('DSH_FOLLOW_OPEN_TIMEOUT'), timeoutMs)
      bridge = await options.bridgeStream?.(signal) ?? null
      const after = bridge ? options.cursors?.load(request.sessionId) : undefined
      const credential = await authenticate(signal)
      signal.throwIfAborted()
      const url = new URL('api/remote.mux', base)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      socket = new WebSocket(url, { headers: { cookie: credential }, followRedirects: false, maxPayload: maxBytes, handshakeTimeout: timeoutMs, perMessageDeflate: false })
      socket.on('unexpected-response', (_request, response) => {
        response.resume()
        fail(response.statusCode === 401 || response.statusCode === 403 ? 'DSH_FOLLOW_AUTH_REJECTED' : 'DSH_FOLLOW_HANDSHAKE_REJECTED')
      })
      socket.on('error', error => fail('code' in error && error.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH'
        ? 'DSH_FOLLOW_FRAME_TOO_LARGE' : 'DSH_FOLLOW_TRANSPORT_UNKNOWN'))
      socket.on('close', () => fail('DSH_FOLLOW_ENDED'))
      socket.on('pong', payload => {
        if (stopped || pendingPing === undefined || payload.toString() !== pendingPing) return
        clearTimeout(pongTimer)
        pendingPing = undefined
        resetIdle()
      })
      socket.on('open', () => {
        if (stopped) return
        // Only the opening cursor is consumed; keep DSH's history page minimal.
        socket!.send(JSON.stringify({ type: 'open', streamId, endpoint: bridge ? 'bridgePlugin/followSessionEvents' : 'session/follow',
          payload: { args: { request: bridge ? { sessionId: request.sessionId, issuerEpoch: bridge.issuerEpoch,
            ...(after === undefined ? {} : { after }) } : { address: { kind: 'session', sessionId: request.sessionId }, maxMessages: 1 } } } }))
      })
      socket.on('message', (data, binary) => {
        if (stopped) return
        try {
          if (binary || !Buffer.isBuffer(data) || data.byteLength > maxBytes) throw failure('DSH_FOLLOW_INVALID_FRAME')
          const frame: unknown = JSON.parse(data.toString())
          if (!record(frame)) throw failure('DSH_FOLLOW_INVALID_FRAME')
          if (frame.streamId !== streamId) return
          if (frame.type === 'end' || frame.type === 'error') {
            const error = record(frame.error) ? frame.error : null
            const reason = record(error?.details) ? error.details.reason : undefined
            const code = typeof reason === 'string' && /^DSH_FOLLOW_[A-Z_]+$/.test(reason) ? reason
              : typeof error?.message === 'string' && /^DSH_FOLLOW_[A-Z_]+$/.test(error.message) ? error.message : error?.code
            fail(typeof code === 'string' && /^DSH_FOLLOW_[A-Z_]+$/.test(code) ? code : 'DSH_FOLLOW_ENDED'); return
          }
          if (frame.type !== 'item' || !record(frame.value)) throw failure('DSH_FOLLOW_INVALID_FRAME')
          const value = frame.value
          if (!snapshotSeen) {
            if (value.type !== 'snapshot' || !record(value.header) || value.header.id !== request.sessionId
              || !Number.isSafeInteger(value.cursor) || (value.cursor as number) < -1 || !Array.isArray(value.records)) {
              throw failure('DSH_FOLLOW_INVALID_FRAME')
            }
            nextSeq = (value.cursor as number) + 1
            if (bridge && (value.protocol !== 'qq-bridge-framework.session-events/1' || value.issuerEpoch !== bridge.issuerEpoch
              || after !== undefined && value.cursor !== after)) throw failure('DSH_FOLLOW_CURSOR_CONFLICT')
            snapshotSeen = true
            if (bridge) {
              if (after === undefined) options.cursors?.save(request.sessionId, value.cursor as number)
              return
            }
            opened = true
            clearTimeout(openingTimer)
            resetIdle()
            readyResolve()
            return
          }
          if (bridge && value.type === 'ready') {
            if (opened || readySeen || value.cursor !== nextSeq - 1 || assembly) throw failure('DSH_FOLLOW_SEQUENCE_GAP')
            readySeen = true
            // Replay is queued before this barrier. Finish callbacks before accepting new work.
            void (async () => {
              while (pumping) await pumping
              if (stopped) return
              opened = true; clearTimeout(openingTimer); resetIdle(); readyResolve()
            })().catch(() => fail('DSH_FOLLOW_CALLBACK_FAILED'))
            return
          }
          let eventValue: unknown = value.event
          let replayed = false
          let reservedBytes = 0
          if (bridge) {
            if (value.type !== 'event-chunk' || !Number.isSafeInteger(value.seq) || value.seq !== nextSeq
              || !Number.isSafeInteger(value.offset) || !Number.isSafeInteger(value.bytes) || Number(value.bytes) < 1
              || Number(value.bytes) > 16 * 1024 * 1024 || typeof value.hash !== 'string' || !/^[a-f0-9]{64}$/.test(value.hash)
              || typeof value.data !== 'string' || value.data.length > 262144 || value.replayed !== !readySeen)
              throw failure('DSH_FOLLOW_INVALID_FRAME')
            if (!assembly) {
              if (value.offset !== 0) throw failure('DSH_FOLLOW_SEQUENCE_GAP')
              if (queueBytes + Number(value.bytes) > 16 * 1024 * 1024) throw failure('DSH_FOLLOW_BACKPRESSURE')
              if (!options.byteBudget?.reserve(Number(value.bytes)) && options.byteBudget) throw failure('DSH_FOLLOW_BACKPRESSURE')
              assembly = { seq: Number(value.seq), bytes: Number(value.bytes), hash: value.hash,
                replayed: value.replayed, offset: 0, chunks: [] }
            }
            if (assembly.seq !== value.seq || assembly.bytes !== value.bytes || assembly.hash !== value.hash
              || assembly.offset !== value.offset || assembly.replayed !== value.replayed) throw failure('DSH_FOLLOW_INVALID_FRAME')
            const chunk = Buffer.from(value.data, 'base64')
            if (chunk.length < 1 || chunk.toString('base64') !== value.data || assembly.offset + chunk.length > assembly.bytes)
              throw failure('DSH_FOLLOW_INVALID_FRAME')
            assembly.chunks.push(chunk); assembly.offset += chunk.length
            if (assembly.offset < assembly.bytes) return
            const bytes = Buffer.concat(assembly.chunks)
            if (createHash('sha256').update(bytes).digest('hex') !== assembly.hash) throw failure('DSH_FOLLOW_INVALID_FRAME')
            eventValue = JSON.parse(bytes.toString('utf8')) as unknown
            replayed = assembly.replayed
            reservedBytes = assembly.bytes
          }
          if ((!bridge && value.type !== 'event') || !record(eventValue)) throw failure('DSH_FOLLOW_INVALID_FRAME')
          const event = eventValue
          if (!Number.isSafeInteger(event.seq) || (event.seq as number) < 0 || typeof event.type !== 'string') throw failure('DSH_FOLLOW_INVALID_FRAME')
          const sequence = event.seq as number
          if (sequence < nextSeq) return
          if (sequence !== nextSeq) throw failure('DSH_FOLLOW_SEQUENCE_GAP')
          nextSeq = sequence + 1
          resetIdle()
          if (!record(event.data)) {
            if (bridge) throw failure('DSH_FOLLOW_INVALID_FRAME')
            return
          }
          const bytes = reservedBytes || data.byteLength
          if (queue.length >= maxPendingEvents || queueBytes + bytes > 16 * 1024 * 1024) throw failure('DSH_FOLLOW_BACKPRESSURE')
          if (!bridge && options.byteBudget && !options.byteBudget.reserve(bytes)) throw failure('DSH_FOLLOW_BACKPRESSURE')
          assembly = undefined
          queueBytes += bytes
          queue.push({ event: snapshot({ type: 'session/event', sessionId: request.sessionId,
            ...(replayed ? { replayed: true } : {}), event: { seq: sequence, type: event.type, data: event.data } }) as DshFollowEvent,
            bytes, sequence })
          pump()
        } catch (error) {
          fail(error instanceof DshAdapterError ? error.code : 'DSH_FOLLOW_INVALID_FRAME')
        }
      })
      await ready
      signal.throwIfAborted()
      return stop
    } catch (error) {
      await stop().catch(() => undefined)
      if (error instanceof DshAdapterError) throw error
      throw failure('DSH_FOLLOW_TRANSPORT_UNKNOWN')
    }
  }

  return follow
}
