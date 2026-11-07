import type { Agent } from '@deepseek-ai/dsh-agent'
import { validIdentifier } from './receipts.js'

/** A delayed cancellation can only affect the exact currently claimed request in this plugin epoch. */
export function createExecutionCancellation(options: { readonly issuerEpoch: string; readonly getAgent: (id: string) => Agent | undefined }) {
  const claims = new Map<string, { agent: Agent; requestId: string; turn: number }>()
  return Object.freeze({
    claimed(agent: Agent, requestId: string, turn: number) {
      if (options.getAgent(agent.id) === agent && validIdentifier(requestId)) claims.set(agent.id, { agent, requestId, turn })
    },
    ended(agent: Agent, turn?: number) {
      const claim = claims.get(agent.id)
      if (claim?.agent === agent && (turn === undefined || turn === claim.turn)) claims.delete(agent.id)
    },
    cancel(request: { readonly sessionId: string; readonly requestId: string; readonly issuerEpoch: string }) {
      if (!request || Object.keys(request).length !== 3 || !validIdentifier(request.sessionId) || !validIdentifier(request.requestId)
        || request.issuerEpoch !== options.issuerEpoch) throw new TypeError('Invalid request cancellation identity or epoch')
      const claim = claims.get(request.sessionId)
      const agent = options.getAgent(request.sessionId)
      // No await between identity check and cancellation. Missing claims never authorize address-scoped cancellation.
      if (!claim || claim.agent !== agent || claim.requestId !== request.requestId || !agent || agent.status === 'idle')
        return { ...request, status: 'rejected' as const }
      agent.cancel({ kind: 'user' })
      return { ...request, status: 'accepted' as const }
    },
    close() { claims.clear() },
  })
}
