import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { SessionId } from '@deepseek-ai/dsh-session'
import { executionCheckpoint } from './execution-checkpoint.js'
import { normalizeWorkOutput } from './work-output.js'
import type { WorkJournalRecord } from './work-journal.js'

/** Observe an existing child only. A missing or interrupted checkpoint never authorizes restarting work. */
export async function recoverSdkWork(ctx: Context, record: WorkJournalRecord, signal: AbortSignal) {
  const query = ctx.get('sessionQuery'), persistence = ctx.get('sessionPersistence')
  if (!query || !persistence || !record.acceptedMessageId) return null
  const id = SessionId(record.address.childId)
  const observation = await query.observeSession(id, { signal, projectionMode: 'none' })
  try {
    if (observation.header.id !== id || observation.header.origin !== 'subagent'
      || observation.header.parentSession !== record.address.parentSessionId) return null
    const live = ctx.agents.get(id)
    if (live && (live.status !== 'idle' || live.inbox.nextTurn.length || live.inbox.nextStep.length)) return null
    let active: number | null = null, matched: number | null = null
    let terminal: 'completed' | 'failed' | 'cancelled' | null = null
    let output: Parameters<typeof normalizeWorkOutput>[0] = []
    let attachmentCalled = false
    for (const event of observation.events) {
      if (event.type === 'turn/start') {
        if (matched !== null) return null
        active = event.data.turn; terminal = null; output = []
      }
      if (event.type === 'user/message' && (record.followupRequestId
        ? event.data.source?.kind === 'user' && 'rpcId' in event.data.source && event.data.source.rpcId === record.followupRequestId
        : event.data.id === record.acceptedMessageId)) matched = active
      if (event.type === 'assistant/message' && active !== null && matched !== null && active === matched) output = event.data.message.content
      if (event.type === 'tool/call' && event.data.name === 'qbf_work_attach') attachmentCalled = true
      if (event.type === 'turn/end') {
        if (matched !== null && event.data.turn === matched) {
          const kind = event.data.reason.kind
          terminal = kind === 'completed' ? 'completed' : kind === 'aborted' ? 'cancelled' : kind === 'error' ? 'failed' : null
        }
        active = null
      }
    }
    if (matched === null || active !== null || !terminal || attachmentCalled && !record.attachments?.length) return null
    const hash = await executionCheckpoint({ ...observation.header, delegationDepth: observation.header.delegationDepth ?? 0 }, observation.events, signal)
    const durable = await persistence.open(id, 'read', { signal })
    try {
      const checkpoint = await durable.read()
      if (durable.header.id !== id || await executionCheckpoint(durable.header, checkpoint.events, signal) !== hash) return null
      const current = ctx.agents.get(id)
      if (current !== live || current && (current.status !== 'idle' || current.inbox.nextTurn.length || current.inbox.nextStep.length
        || current.session.seq - 1 !== observation.cursor)) return null
      const normalized = [...normalizeWorkOutput(output), ...(record.attachments ?? [])]
      if (normalized.length > 256 || Buffer.byteLength(JSON.stringify(normalized)) > 262144) return null
      return { result: { stopReason: terminal, output: normalized },
        evidence: { checkpointHash: hash, checkpointSequence: Number(observation.cursor), observedAt: Date.now() } }
    } finally { await durable.close() }
  } finally { observation[Symbol.dispose]() }
}
