import test from 'node:test'
import assert from 'node:assert/strict'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createExecutionCancellation } from '../dist/execution-cancellation.js'

test('exact request cancellation rejects late requests, stale agents, epochs and missing claims', () => {
  let cancelled = 0
  const agent = { id: 'session-1', status: 'running', cancel() { cancelled++ } } as unknown as Agent
  let current: Agent | undefined = agent
  const channel = createExecutionCancellation({ issuerEpoch: 'epoch', getAgent: () => current })
  const old = { sessionId: 'session-1', requestId: 'old', issuerEpoch: 'epoch' }
  assert.equal(channel.cancel(old).status, 'rejected')
  channel.claimed(agent, 'old', 1)
  assert.equal(channel.cancel(old).status, 'accepted')
  channel.ended(agent, 1)
  channel.claimed(agent, 'new', 2)
  assert.equal(channel.cancel(old).status, 'rejected')
  channel.ended(agent, 1)
  assert.equal(channel.cancel({ ...old, requestId: 'new' }).status, 'accepted')
  assert.throws(() => channel.cancel({ ...old, issuerEpoch: 'old-epoch' }))
  current = undefined
  assert.equal(channel.cancel({ ...old, requestId: 'new' }).status, 'rejected')
  assert.equal(cancelled, 2)
  channel.close()
})
