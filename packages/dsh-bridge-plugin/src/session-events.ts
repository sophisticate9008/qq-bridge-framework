import { createHash } from 'node:crypto'
import type { SessionWireEvent } from '@deepseek-ai/dsh-api-session-controller/types'
import { validIdentifier } from './receipts.js'
import type { SessionEventSource } from './session-event-source.js'

export const SESSION_EVENTS_PROTOCOL = 'qq-bridge-framework.session-events/1' as const
const chunkBytes = 192 * 1024
const eventBytes = 16 * 1024 * 1024
export interface SessionEventsRequest {
  readonly sessionId: string
  readonly issuerEpoch: string
  readonly after?: number
}

/** Preserve the fields consumed by the bridge; bulky unrelated journal data stays in DSH. */
function project(event: SessionWireEvent): SessionWireEvent {
  const data = event.data
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ...event, data: {} }
  if (['assistant/message', 'turn/start', 'turn/end', 'turn/error', 'session/error'].includes(event.type)) return event
  if (event.type === 'user/message') {
    const { content: _content, ...identity } = data
    return { ...event, data: identity }
  }
  if (event.type === 'agent/inbox/spliced' && Array.isArray(data.inserted)) return { ...event, data: { ...data,
    inserted: data.inserted.map(message => {
      if (!message || typeof message !== 'object' || Array.isArray(message)) return null
      const { content: _content, ...identity } = message
      return identity
    }) } }
  if (['step/start', 'step/end', 'tool/call'].includes(event.type)) return { ...event, data: {
    ...(typeof data.turn === 'number' ? { turn: data.turn } : {}),
    ...(typeof data.step === 'number' ? { step: data.step } : {}),
    ...(typeof data.callId === 'string' ? { callId: data.callId } : {}),
  } }
  if (event.type === 'tool/result') {
    const message = data.message
    return { ...event, data: { ...(typeof data.turn === 'number' ? { turn: data.turn } : {}),
      ...(typeof data.step === 'number' ? { step: data.step } : {}),
      ...(message && typeof message === 'object' && !Array.isArray(message) ? { message: {
        role: 'tool', ...(typeof message.toolCallId === 'string' ? { toolCallId: message.toolCallId } : {}),
        ...(typeof message.isError === 'boolean' ? { isError: message.isError } : {}),
      } } : {}) } }
  }
  return { seq: event.seq, type: event.type, time: event.time, data: {} }
}

function* frames(event: SessionWireEvent, replayed: boolean) {
  const bytes = Buffer.from(JSON.stringify(project(event)), 'utf8')
  if (bytes.length > eventBytes) throw new Error('DSH_FOLLOW_EVENT_TOO_LARGE')
  const hash = createHash('sha256').update(bytes).digest('hex')
  for (let offset = 0; offset < bytes.length; offset += chunkBytes) yield {
    type: 'event-chunk' as const, seq: event.seq, offset, bytes: bytes.length, hash, replayed,
    data: bytes.subarray(offset, offset + chunkBytes).toString('base64'),
  }
}

/** The SDK owns the atomic snapshot/live cut. The carrier never receives snapshot history. */
export async function* followSessionEvents(source: SessionEventSource, request: SessionEventsRequest, issuerEpoch: string, signal: AbortSignal) {
  if (!request || Object.keys(request).some(key => !['sessionId', 'issuerEpoch', 'after'].includes(key))
    || !validIdentifier(request.sessionId) || request.issuerEpoch !== issuerEpoch
    || request.after !== undefined && (!Number.isSafeInteger(request.after) || request.after < -1))
    throw new TypeError('Invalid session event address')
  let opened = false
  for await (const frame of source.follow(request.sessionId, signal)) {
    signal.throwIfAborted()
    if (frame.type === 'snapshot') {
      if (opened || frame.header.id !== request.sessionId || request.after !== undefined && request.after > frame.cursor)
        throw new Error('DSH_FOLLOW_CURSOR_CONFLICT')
      opened = true
      const after = request.after ?? frame.cursor
      yield { type: 'snapshot' as const, protocol: SESSION_EVENTS_PROTOCOL, issuerEpoch,
        header: { id: request.sessionId }, cursor: after, headCursor: frame.cursor, records: [] }
      let next = after + 1
      if (after < frame.cursor) for await (const event of source.replay(request.sessionId, after, frame.cursor, signal)) {
        signal.throwIfAborted()
        if (event.seq !== next++) throw new Error('DSH_FOLLOW_SEQUENCE_GAP')
        yield* frames(event, true)
      }
      if (next !== frame.cursor + 1) throw new Error('DSH_FOLLOW_SEQUENCE_GAP')
      yield { type: 'ready' as const, cursor: frame.cursor }
    } else if (frame.type === 'event') {
      if (!opened) throw new Error('DSH_FOLLOW_INVALID_FRAME')
      yield* frames(frame.event, false)
    }
  }
}
