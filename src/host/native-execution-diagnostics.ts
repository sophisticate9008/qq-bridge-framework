import type { DurableStore } from '../contracts/ports.ts'
import { isRecord } from '../core/values.ts'
import { digest, json } from './data.ts'

export interface NativeExecutionPhase {
  readonly sessionId: string
  readonly requestId?: string
  readonly turn?: number
  readonly phase: string
  readonly at?: number
  readonly code?: string
  readonly sequence?: number
}
/** Metadata only, independently retained from UI notices and bounded per request/turn. */
export function recordNativeExecutionPhase(store: DurableStore, input: NativeExecutionPhase): void {
  const key = digest(input.requestId ? [input.sessionId, input.requestId] : [input.sessionId, input.turn])
  const prior = store.read('host.execution-diagnostics', key)
  const value = prior && isRecord(prior.value) ? prior.value : {}
  const events = Array.isArray(value.events) ? value.events : []
  const at = input.at ?? Date.now()
  if (!Number.isSafeInteger(at) || at < 0) return
  if (input.sequence !== undefined && events.some(event => isRecord(event) && event.sequence === input.sequence)) return
  store.write('host.execution-diagnostics', key, json({ schema: 1, sessionId: input.sessionId,
    ...(input.requestId ? { requestId: input.requestId } : { turn: input.turn }),
    events: [...events, { phase: input.phase, at, observedAt: Date.now(), ...(input.code ? { code: input.code } : {}),
      ...(input.sequence === undefined ? {} : { sequence: input.sequence }) }].slice(-128),
    truncated: value.truncated === true || events.length >= 128 }),
  { expectedRevision: prior?.revision ?? null, expiresAt: Date.now() + 7 * 86400000 })
}
export function readNativeExecutionDiagnostics(store: DurableStore, execution: { binding: { sessionId: string }; requestId: string; turn: { id: string } | null }) {
  return { request: store.read('host.execution-diagnostics', digest([execution.binding.sessionId, execution.requestId]))?.value ?? null,
    turn: execution.turn ? store.read('host.execution-diagnostics', digest([execution.binding.sessionId, Number(execution.turn.id)]))?.value ?? null : null }
}
