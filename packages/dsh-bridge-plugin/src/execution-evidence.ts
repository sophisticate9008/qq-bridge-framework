import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { SessionId } from '@deepseek-ai/dsh-session'
import { validIdentifier } from './receipts.js'
import { executionCheckpoint, executionRequestIndex } from './execution-checkpoint.js'
import { DSH_EXECUTION_EVIDENCE_PROTOCOL, type DshExecutionEvidence, type DshExecutionEvidenceRequest } from './execution-evidence-protocol.js'

/** Positive evidence only: a missing request never proves that an uncertain submission did not execute. */
export async function inspectSdkExecution(ctx: Context, request: DshExecutionEvidenceRequest, issuerEpoch: string, signal: AbortSignal): Promise<DshExecutionEvidence> {
  if (!request || Object.keys(request).some(key => !['sessionId', 'requestId', 'userMessageId', 'turn'].includes(key))
    || !validIdentifier(request.sessionId) || !validIdentifier(request.requestId)
    || request.userMessageId !== undefined && !validIdentifier(request.userMessageId)
    || request.turn !== undefined && (!Number.isSafeInteger(request.turn) || request.turn < 1)) throw new TypeError('Invalid execution evidence address')
  const base: DshExecutionEvidence = { ...request, schema: 1, protocol: DSH_EXECUTION_EVIDENCE_PROTOCOL, issuerEpoch,
    state: 'unavailable', matchedUserMessageId: null, matchedTurn: null, outcome: null, userSequence: null,
    terminalSequence: null, checkpointSequence: null, checkpointHash: null, quiescent: false, missingReasons: [] }
  const unavailable = (reason: string, partial: Partial<DshExecutionEvidence> = {}): DshExecutionEvidence =>
    ({ ...base, ...partial, state: 'unavailable', missingReasons: [reason] })
  const query = ctx.get('sessionQuery')
  const persistence = ctx.get('sessionPersistence')
  if (!query || !persistence) return unavailable('execution_checkpoint_unavailable')
  signal.throwIfAborted()
  try {
    const sessionId = SessionId(request.sessionId)
    const observation = await query.observeSession(sessionId, { signal, projectionMode: 'none' })
    try {
      const events = observation.events
      if (observation.header.id !== sessionId)
        return unavailable('execution_checkpoint_unsupported')
      const observedHash = await executionCheckpoint({ ...observation.header, delegationDepth: observation.header.delegationDepth ?? 0 }, events, signal)
      const match = await executionRequestIndex(ctx, observedHash, events, request.requestId, signal)
      if (match?.ambiguous) return unavailable('execution_request_ambiguous')
      if (match?.terminalUnverifiable) return unavailable('execution_terminal_unverifiable')
      const terminal = match?.terminal
      const live = ctx.agents.get(sessionId)
      const quiescent = (!live || live.status === 'idle') && (!live || live.inbox.nextTurn.length === 0 && live.inbox.nextStep.length === 0)
      if (!match) return { ...base, state: 'not-observed', quiescent, missingReasons: ['execution_request_not_observed'] }
      const partial = { matchedUserMessageId: match.messageId, matchedTurn: match.turn, userSequence: match.sequence, quiescent }
      if (request.userMessageId !== undefined && request.userMessageId !== match.messageId || request.turn !== undefined && request.turn !== match.turn)
        return unavailable('execution_correlation_conflict', partial)
      if (!terminal) return { ...base, ...partial, state: 'pending', missingReasons: ['execution_turn_not_settled'] }
      if (!quiescent) return { ...base, ...partial, state: 'pending', missingReasons: ['execution_session_not_quiescent'] }
      const durable = await persistence.open(sessionId, 'read', { signal })
      try {
        const checkpoint = await durable.read()
        signal.throwIfAborted()
        // The JSONL SDK persists an omitted live delegationDepth as zero. Compare that documented storage form.
        const checkpointHash = await executionCheckpoint(durable.header, checkpoint.events, signal)
        if (durable.header.id !== sessionId || checkpointHash !== observedHash) return unavailable('execution_checkpoint_not_confirmed', partial)
        const current = ctx.agents.get(sessionId)
        if (current !== live || current && (current.status !== 'idle' || current.inbox.nextTurn.length || current.inbox.nextStep.length
          || current.session.seq - 1 !== observation.cursor)) return unavailable('execution_observation_changed', partial)
        return { ...base, ...partial, state: 'settled', outcome: terminal.outcome, terminalSequence: terminal.sequence,
          checkpointSequence: Number(observation.cursor), checkpointHash, missingReasons: [] }
      } finally { await durable.close() }
    } finally { observation[Symbol.dispose]() }
  } catch {
    signal.throwIfAborted()
    return unavailable('execution_checkpoint_read_unavailable')
  }
}
