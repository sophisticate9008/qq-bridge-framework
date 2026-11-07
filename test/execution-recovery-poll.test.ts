import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { createExecutionRecoveryPoll } from '../src/host/execution-recovery-poll.ts'

test('automatic observation backs off, records exhaustion, deduplicates and follows lifecycle', async () => {
  const lifetime = new AbortController()
  let now = 1000, calls = 0
  const results: { attempt: number; exhausted: boolean; settled: boolean }[] = []
  const poll = createExecutionRecoveryPoll({ signal: lifetime.signal, clock: () => now, maxAttempts: 2,
    candidates: () => ['request', 'request'], async inspect() { calls++; return false },
    observe(_id, result) { results.push(result) } })
  poll.tick(); poll.tick(); await delay(0)
  assert.equal(calls, 1)
  now += 999; poll.tick(); await delay(0); assert.equal(calls, 1)
  now++; poll.tick(); await delay(0); assert.equal(calls, 2)
  assert.deepEqual(results.map(x => [x.attempt, x.exhausted]), [[1, false], [2, true]])
  now += 1000000; poll.tick(); await delay(0); assert.equal(calls, 2)
  assert.equal(poll.metrics().exhausted, 1)
  lifetime.abort(); poll.tick(); assert.equal(poll.metrics().tracked, 0)
})

test('recovery has four query slots, preserves budgets across pages/restart and records positive settlement', async () => {
  const lifetime = new AbortController()
  let release!: () => void, calls = 0
  const gate = new Promise<void>(resolve => { release = resolve })
  let ids = ['a', 'b', 'c', 'd', 'e']
  const settled: string[] = []
  const poll = createExecutionRecoveryPoll({ signal: lifetime.signal, candidates: () => ids,
    previous: id => id === 'e' ? { attempt: 24, nextAt: null, exhausted: true } : null,
    async inspect() { calls++; await gate; return true }, observe(id, result) { if (result.settled) settled.push(id) } })
  poll.tick(); poll.tick(); assert.equal(calls, 4); assert.equal(poll.metrics().rawActive, 4)
  release(); await delay(0)
  ids = ['e']; poll.tick(); await delay(0)
  assert.equal(calls, 4); assert.equal(settled.length, 4); assert.equal(poll.metrics().exhausted, 1)
  lifetime.abort()
})
