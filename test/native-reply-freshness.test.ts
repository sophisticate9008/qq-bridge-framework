import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import type { FrameworkEvent } from '../src/core/types.ts'
import { createContextStore } from '../src/core/context.ts'
import { createBridgeHost } from '../src/host/bridge.ts'
import { digest } from '../src/host/data.ts'
import { createNativeReplyFreshness } from '../src/host/native-reply-freshness.ts'
import { createSqliteStore } from '../src/storage/sqlite.ts'

function fixture(context: TestContext) {
  const store = createSqliteStore({ filename: ':memory:' })
  context.after(() => store.close())
  const personas = createContextStore()
  const persona = personas.registerPersona({ id: 'freshness', version: '1', name: 'Fixture', identity: {}, style: {} })
  const host = createBridgeHost({ store, context: personas, persona, authorizeIncoming: () => true,
    transport: { send() { throw new Error('No transport calls') } },
    agent: { async createSession() { throw new Error('No model calls') },
      async submit() { throw new Error('No model calls') }, async follow() { return () => {} } } })
  const binding = host.sessions.bind('group:456', 'freshness-session')
  let waitingActor: string | undefined
  let deferred = 0
  const checks: string[] = []
  const freshness = createNativeReplyFreshness({ host, store,
    hasWaitingFrom(_conversationId, actor, _messageId, mode) { checks.push(`${actor}:${mode}`); return actor === waitingActor },
    onDeferred() { deferred++ } })
  const append = (id: string, actor = '123') => host.history.append(binding.conversationId,
    { id, actor, receivedAt: 100, content: [{ type: 'text', text: `message-${id}` }] })
  const event = (id: string): FrameworkEvent => ({ id: `reply-${id}`, type: 'agent.message',
    conversationId: binding.conversationId, sessionId: binding.sessionId,
    data: { generation: binding.generation, agentData: { nativeRequestId: digest([binding.conversationId, id, 'prompt']) },
      content: [{ type: 'text', text: 'draft' }] } })
  return { binding, freshness, checks, append, event, waiting(actor?: string) { waitingActor = actor }, deferred: () => deferred }
}

test('a withheld contact signal retains its original unread request and explicit wake in the successor', async context => {
  const f = fixture(context)
  f.append('original-question'); f.append('contact'); f.append('picture')
  f.freshness.prepare(f.binding, '123', 'contact', { addressedMessages: [{ messageId: 'contact', actor: '123' }],
    contextMessageIds: ['original-question', 'contact'] })
  f.waiting('123')
  assert.equal(await f.freshness.hold(f.event('contact')), true)
  assert.equal(await f.freshness.hold(f.event('contact')), true)
  assert.equal(f.deferred(), 1)
  const next = f.freshness.prepare(f.binding, '123', 'picture', { addressedMessages: [], contextMessageIds: ['picture'] })
  assert.deepEqual(next.unsentReplyMessageIds, ['original-question', 'contact'])
  assert.deepEqual(next.addressedMessageIds, ['contact'])
  // Acceptance consumes the durable notice, while this prepared execution remains protected.
  f.freshness.settled(digest([f.binding.conversationId, 'picture', 'prompt']), true)
  assert.equal(await f.freshness.hold(f.event('picture')), false)
  assert.equal(f.deferred(), 1)
})

test('coalesced explicit calls follow their actual authors rather than the last ordinary speaker', async context => {
  const f = fixture(context)
  f.append('call'); f.append('last-ordinary', '789')
  f.freshness.prepare(f.binding, '789', 'last-ordinary', {
    addressedMessages: [{ messageId: 'call', actor: '123' }], contextMessageIds: ['call', 'last-ordinary'] })
  f.waiting('789')
  assert.equal(await f.freshness.hold(f.event('last-ordinary')), false)
  assert.deepEqual(f.checks, ['123:same-speaker'])
  f.waiting('123')
  assert.equal(await f.freshness.hold(f.event('last-ordinary')), true)
  const next = f.freshness.prepare(f.binding, '123', 'next', { addressedMessages: [], contextMessageIds: [] })
  assert(next.unsentReplyMessageIds?.includes('call'))
  assert.deepEqual(next.addressedMessageIds, ['call'])
})

test('ordinary observation can reconsider once, then same-speaker chatter cannot postpone it again', async context => {
  const f = fixture(context)
  f.append('observation'); f.append('successor')
  f.freshness.prepare(f.binding, '123', 'observation', { addressedMessages: [], contextMessageIds: ['observation'] })
  f.waiting('123')
  assert.equal(await f.freshness.hold(f.event('observation')), true)
  assert.deepEqual(f.checks, ['123:group-observation'])
  f.freshness.prepare(f.binding, '123', 'successor', { addressedMessages: [], contextMessageIds: ['successor'] })
  assert.equal(await f.freshness.hold(f.event('successor')), false)
})

test('retained request sources stay fenced to the original session generation', async context => {
  const f = fixture(context)
  f.append('call')
  f.freshness.prepare(f.binding, '123', 'call', {
    addressedMessages: [{ messageId: 'call', actor: '123' }], contextMessageIds: ['call'] })
  f.waiting('123')
  assert.equal(await f.freshness.hold(f.event('call')), true)
  const replacement = { ...f.binding, sessionId: 'replacement-session', generation: f.binding.generation + 1 }
  assert.deepEqual(f.freshness.prepare(replacement, '123', 'next', { addressedMessages: [], contextMessageIds: [] }),
    { addressedMessageIds: [] })
})

test('withheld input survives ordinary chatter rolling the original messages out of host history', async context => {
  const f = fixture(context)
  f.append('original'); f.append('contact')
  f.freshness.prepare(f.binding, '123', 'contact', {
    addressedMessages: [{ messageId: 'contact', actor: '123' }], contextMessageIds: ['original', 'contact'],
    contextMessages: [{ id: 'original', actor: '123', receivedAt: 100,
      content: [{ type: 'text', text: '原始明确问题' }] },
    { id: 'contact', actor: '123', receivedAt: 101, content: [{ type: 'mention', userId: '999' }] }] })
  for (let index = 0; index < 105; index++) f.append(`chatter-${index}`, '789')
  f.waiting('123')
  assert.equal(await f.freshness.hold(f.event('contact')), true)
  const next = f.freshness.prepare(f.binding, '123', 'next', { addressedMessages: [], contextMessageIds: [] })
  assert.deepEqual(next.unsentReplyMessageIds, ['original', 'contact'])
  assert.equal(next.unsentReplyRequests?.[0]?.text, '原始明确问题')
  assert.equal(next.unsentReplyRequests?.[0]?.actor, '123')
})
