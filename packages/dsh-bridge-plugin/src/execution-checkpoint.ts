import { createHash } from 'node:crypto'
import { setImmediate } from 'node:timers/promises'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { migrationDigest } from './migration-journal.js'

/** Hash bounded records rather than allocating a second serialized copy of the complete journal. */
export async function executionCheckpoint(header: unknown, events: readonly SessionEvent[], signal: AbortSignal): Promise<string> {
  const hash = createHash('sha256').update('qbf.execution-checkpoint/1\n').update(migrationDigest(header))
  for (let index = 0; index < events.length; index++) {
    signal.throwIfAborted()
    hash.update(migrationDigest(events[index]))
    if (index % 128 === 127) await setImmediate(undefined, { signal })
  }
  return hash.digest('hex')
}

interface RequestEvidence {
  messageId: string; turn: number; sequence: number
  terminal?: { sequence: number; outcome: 'completed' | 'failed' | 'cancelled' }
  ambiguous: boolean
  terminalUnverifiable?: boolean
}
const indexes = new WeakMap<object, Map<string, Map<string, RequestEvidence>>>()

/** Derived bounded index. DSH's durable log remains authoritative and every cache hit requires its verified hash. */
export async function executionRequestIndex(owner: object, hash: string, events: readonly SessionEvent[], requestId: string,
  signal: AbortSignal): Promise<RequestEvidence | undefined> {
  let cache = indexes.get(owner)
  if (!cache) { cache = new Map(); indexes.set(owner, cache) }
  const prior = cache.get(hash)
  if (prior?.has(requestId)) return prior.get(requestId)
  const found = new Map<string, RequestEvidence>()
  const turns = new Map<number, RequestEvidence[]>()
  let activeTurn: number | null = null
  for (let index = 0; index < events.length; index++) {
    signal.throwIfAborted()
    const event = events[index]!
    if (event.type === 'turn/start') activeTurn = event.data.turn
    if (event.type === 'user/message' && event.data.source?.kind === 'user' && 'rpcId' in event.data.source
      && typeof event.data.source.rpcId === 'string') {
      const id = event.data.source.rpcId
      const previous = found.get(id)
      if (previous) previous.ambiguous = true
      else if (activeTurn !== null) {
        const entry: RequestEvidence = { messageId: event.data.id, turn: activeTurn, sequence: Number(event.seq), ambiguous: false }
        // Always keep the addressed request even when the recent-request cache reaches its bound.
        if (found.size >= 4096) {
          const oldest = [...found.keys()].find(key => key !== requestId)
          if (oldest) found.delete(oldest)
        }
        found.set(id, entry)
        const active = turns.get(activeTurn) ?? []
        if (active.length >= 4096) {
          const oldest = active.findIndex(value => value !== found.get(requestId))
          if (oldest >= 0) active.splice(oldest, 1)
        }
        active.push(entry); turns.set(activeTurn, active)
      }
    }
    if (event.type === 'turn/end') {
      const kind = event.data.reason.kind
      for (const entry of turns.get(event.data.turn) ?? []) {
        if (kind === 'completed' || kind === 'error' || kind === 'aborted') entry.terminal = {
          sequence: Number(event.seq), outcome: kind === 'completed' ? 'completed' : kind === 'aborted' ? 'cancelled' : 'failed',
        }
        else entry.terminalUnverifiable = true
      }
      turns.delete(event.data.turn); activeTurn = null
    }
    if (index % 256 === 255) await setImmediate(undefined, { signal })
  }
  // Only entries specifically checked over the complete log are safe cache hits;
  // a recent-window entry could have an earlier duplicate outside that window.
  const results = prior ?? new Map<string, RequestEvidence>()
  const result = found.get(requestId)
  if (result) results.set(requestId, result)
  if (results.size > 4096) results.delete(results.keys().next().value!)
  if (!cache.has(hash) && cache.size >= 8) cache.delete(cache.keys().next().value!)
  cache.set(hash, results)
  return found.get(requestId)
}
