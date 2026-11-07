import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { createSessionTurnQueue } from '../src/host/session-turns.ts'
import { createNativeExecutionController, DEFAULT_NATIVE_EXECUTION_POLICY } from '../src/host/native-execution.ts'
import { createSqliteStore } from '../src/storage/sqlite.ts'
import type { AgentAdapter } from '../src/contracts/ports.ts'

for (const order of ['terminal-first', 'ack-first'] as const) test(`session lane wakes its waiter after cancellation (${order})`, async context => {
  const store = createSqliteStore({ filename: ':memory:' })
  const lifetime = new AbortController()
  const queue = createSessionTurnQueue({ store, signal: lifetime.signal })
  let acknowledge!: (value: { status: 'accepted' }) => void
  const controller = createNativeExecutionController({ store,
    policy: { ...DEFAULT_NATIVE_EXECUTION_POLICY, turnTimeoutMs: 60_000 },
    cancel: () => new Promise(resolve => { acknowledge = resolve }),
    onReleased: record => { queue.releaseReconciled(record.binding.sessionId, record.requestId) } })
  controller.start()
  context.after(async () => { lifetime.abort(); await controller.stop(); store.close() })
  const binding = { conversationId: 'group:123', sessionId: 'session-1', generation: 1 }
  const records = new Map<string, string>()
  const source: AgentAdapter = {
    async createSession() { return { sessionId: binding.sessionId } },
    async follow() { return async () => {} },
    async submit(request) {
      const execution = controller.admit({ binding, requestId: request.requestId, policyRevision: 'a'.repeat(64) })
      records.set(request.requestId, execution.id)
      await controller.submit(execution.id, async () => ({ status: 'accepted' }))
      controller.claimed(execution.id, { kind: 'dsh.agent-inbox-claimed', sessionId: binding.sessionId,
        requestId: request.requestId, userMessageId: `message-${request.requestId}`, turn: records.size,
        evidenceId: `claim-${request.requestId}`, issuerEpoch: 'epoch', receiptSeq: records.size })
      return { status: 'accepted' }
    },
  }
  const agent = queue.wrapChat(source)
  const request = (requestId: string) => ({ sessionId: binding.sessionId, requestId,
    content: [{ type: 'text' as const, text: 'test' }], signal: lifetime.signal })
  await agent.submit(request('old'))
  const old = records.get('old')!
  const cancel = controller.cancel(old)
  let waiterStarted = false
  const waiter = agent.submit(request('new')).then(result => { waiterStarted = true; return result })
  const otherRelease = await queue.acquire('independent', lifetime.signal)
  otherRelease()
  const terminal = () => controller.observe(old, { eventId: 'cancelled-old', binding, turnId: '1', kind: 'cancelled' })
  if (order === 'terminal-first') {
    terminal()
    await delay(0)
    assert.equal(waiterStarted, false)
    assert.equal(queue.isBusy(binding.sessionId), true)
    acknowledge({ status: 'accepted' })
    await cancel
  } else {
    acknowledge({ status: 'accepted' })
    await cancel
    assert.equal(waiterStarted, false)
    terminal()
  }
  assert.equal((await waiter).status, 'accepted')
  assert.equal(controller.get(old)?.cancelStatus, 'confirmed')
  assert.equal(controller.observe(old, { eventId: 'cancelled-old', binding, turnId: '1', kind: 'cancelled' }).decision, 'duplicate')
  controller.observe(old, { eventId: 'late-old', binding, turnId: '1', kind: 'cancelled' })
  assert.equal(queue.releaseReconciled(binding.sessionId, 'old'), false)
  assert.equal(queue.isBusy(binding.sessionId), true)
  assert.equal(controller.get(records.get('new')!)?.externalStatus, 'accepted')
  controller.observe(records.get('new')!, { eventId: 'complete-new', binding, turnId: '2', kind: 'completed' })
  assert.equal(queue.isBusy(binding.sessionId), false)
})
