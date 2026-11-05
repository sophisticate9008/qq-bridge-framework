import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type { SessionFollowFrame, SessionWireEvent } from '@deepseek-ai/dsh-api-session-controller/types'
import type {} from '@deepseek-ai/dsh-session-query'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { SessionId } from '@deepseek-ai/dsh-session/types'

/** Backend port: event delivery does not depend on DSH's loader or transport implementation. */
export interface SessionEventSource {
  follow(sessionId: string, signal: AbortSignal): AsyncIterable<SessionFollowFrame>
  replay(sessionId: string, after: number, through: number, signal: AbortSignal): AsyncIterable<SessionWireEvent>
}

export function createSdkSessionEventSource(ctx: Context): SessionEventSource {
  const controller = () => {
    const value = ctx.get('sessionController')
    if (!value) throw new Error('DSH_FOLLOW_UNAVAILABLE')
    return value
  }
  const address = (sessionId: string) => ({ kind: 'session' as const, sessionId: SessionId(sessionId) })
  return {
    follow: (sessionId, signal) => controller().follow({ address: address(sessionId), maxMessages: 1 }, signal),
    async *replay(sessionId, after, through, signal) {
      const query = ctx.get('sessionQuery')
      if (!query) throw new Error('DSH_FOLLOW_REPLAY_UNAVAILABLE')
      const cut = await query.observeSession(SessionId(sessionId), { signal, projectionMode: 'none' })
      try {
        if (cut.header.id !== sessionId || cut.cursor < through || through - after > 100_000)
          throw new Error('DSH_FOLLOW_REPLAY_LIMIT')
        for (let seq = after + 1; seq <= through; seq++) {
          signal.throwIfAborted()
          const event = cut.events[seq]
          if (!event || Number(event.seq) !== seq) throw new Error('DSH_FOLLOW_SEQUENCE_GAP')
          yield { seq, type: event.type, time: Number(event.time), data: event.data as JsonValue }
        }
      } finally { cut[Symbol.dispose]() }
    },
  }
}
