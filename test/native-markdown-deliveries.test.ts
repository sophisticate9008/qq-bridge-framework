import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { type TestContext } from 'node:test'
import type { DeliveryReceipt, FrameworkEvent, MessageContent, SendRequest } from '../src/core/types.ts'
import { createContextStore } from '../src/core/context.ts'
import { createBridgeHost, type AgentMessageDelivery } from '../src/host/bridge.ts'
import { createNativeMarkdownDeliveries, NATIVE_MARKDOWN_DELIVERY_EVENT, validateNativeMarkdownDeliveryEvent } from '../src/host/native-markdown-deliveries.ts'
import { createSqliteStore } from '../src/storage/sqlite.ts'
import { awaitCondition } from './fixtures/await-condition.ts'

const event: FrameworkEvent = { id: 'synthetic-reply', type: 'fixture.reply', conversationId: 'group:123', sessionId: 'original-session',
  data: { generation: 1, agentData: { nativeRequestId: 'original-request' }, content: [{ type: 'text', text: '# Synthetic document\n\n$x^2$' }] } }
const pages: readonly MessageContent[] = [{ type: 'image', assetId: 'registered-synthetic-page' }]
type Render = Parameters<typeof createNativeMarkdownDeliveries>[0]['render']

test('HTML handoffs persist their format across restart and never replay an unknown send', async context => {
  const store = createSqliteStore({ filename: ':memory:' })
  const source: FrameworkEvent = { ...event, data: { ...event.data, content: [{ type: 'text', text: JSON.stringify({
    schema: 'qbf.output/1', format: 'html-image', body: '<h1 style="color:purple">HTML</h1>' }) }] } }
  const first = await fixture(context, async () => pages, store)
  assert.equal((await first.queue.defer(source, first.lifetime.signal))?.status, 'queued')
  await first.stop()
  const restored = await fixture(context, async request => { assert.equal(request.format, 'html-image'); return pages }, store, [{ status: 'unknown' }])
  restored.queue.start()
  await awaitCondition(() => restored.results.some(result => result.status === 'unknown'), { timeoutMs: 2000, message: 'HTML unknown delivery' })
  await restored.stop()
  const again = await fixture(context, async () => { assert.fail('unknown HTML must not render again') }, store)
  context.after(async () => { await again.stop(); await restored.stop(); await first.stop(); store.close() })
  again.queue.start()
  assert.equal((await again.queue.defer(source, again.lifetime.signal))?.status, 'unknown')
  assert.equal(again.sent.length, 0)
})

async function fixture(context: TestContext, render: Render, sharedStore?: ReturnType<typeof createSqliteStore>, receipts?: readonly DeliveryReceipt[]) {
  const store = sharedStore ?? createSqliteStore({ filename: ':memory:' })
  const lifetime = new AbortController()
  const sent: SendRequest[] = [], results: AgentMessageDelivery[] = []
  const contextStore = createContextStore()
  const persona = contextStore.registerPersona({ id: 'synthetic', version: '1', name: 'Synthetic', identity: {}, style: {} })
  let queue: ReturnType<typeof createNativeMarkdownDeliveries>
  let ordinary = 0, allowed = true
  const host = createBridgeHost({ store, context: contextStore, persona, authorizeIncoming: () => false,
    agent: { async createSession() { return { sessionId: 'original-session' } }, async submit() { return { status: 'accepted' } }, async follow() { return () => {} } },
    transport: { async send(request) { sent.push(request); return receipts?.[sent.length - 1] ?? { status: 'confirmed', messageId: `synthetic-sent-${sent.length}` } } },
    deferAgentMessage: (source, signal) => queue.defer(source, signal),
    eventValidators: { 'fixture.reply': () => true, 'fixture.ordinary': () => true,
      [NATIVE_MARKDOWN_DELIVERY_EVENT]: validateNativeMarkdownDeliveryEvent } })
  host.sessions.bind(event.conversationId, event.sessionId!, 1)
  queue = createNativeMarkdownDeliveries({ store, accountId: '9001', signal: lifetime.signal,
    binding: conversationId => host.sessions.get(conversationId), authorize: async () => { assert(allowed, 'permission revoked') }, render,
    dispatch: (source, signal) => host.engine.emit(source, { signal }), delivered: (_event, result) => { results.push(result) } })
  host.engine.install(queue.feature({ id: 'framework-tools', version: '1.0.0', apiVersion: 1, capabilities: ['messaging.send'],
    subscriptions: ['fixture.reply', 'fixture.ordinary'], setup(services) {
      services.on('fixture.reply', async (execution, source) => { results.push(await host.deliverAgentMessage(execution, source)) })
      services.on('fixture.ordinary', () => { ordinary++ })
    } }))
  host.policy.grant({ id: `synthetic-grant-${randomUUID()}`, featureId: 'framework-tools', conversationId: event.conversationId,
    capabilities: ['messaging.send'], maxUses: { 'messaging.send': null }, expiresAt: null })
  await host.start()
  let closed = false
  async function stop() { if (closed) return; closed = true; lifetime.abort(); await queue.stop(); await host.stop() }
  context.after(async () => { await stop(); if (!sharedStore) store.close() })
  return { queue, store, host, lifetime, sent, results, stop, ordinary: () => ordinary,
    revoke: () => { allowed = false }, generation: () => { host.sessions.retire(event.conversationId); host.sessions.bind(event.conversationId, 'replacement-session') } }
}

test('durable Markdown handoff releases the conversation and ignores the original turn cancellation', async context => {
  let release!: () => void, started = false
  const held = new Promise<void>(resolve => { release = resolve })
  const data = await fixture(context, async request => { started = true; await held; request.signal.throwIfAborted(); return pages })
  data.queue.start()
  const turn = new AbortController()
  await data.host.engine.emit(event, { signal: turn.signal })
  assert.equal(data.results[0]?.status, 'queued')
  assert.equal(data.store.list('native-chat.markdown-deliveries')[0]?.expiresAt, null)
  await awaitCondition(() => started, { timeoutMs: 1000, message: 'background rendering must begin' })
  turn.abort(new Error('original model deadline'))
  await data.host.engine.emit({ ...event, id: 'ordinary-message', type: 'fixture.ordinary', data: {} })
  assert.equal(data.ordinary(), 1, 'new conversation work must complete while the renderer is pending')
  assert.equal(data.sent.length, 0)
  release()
  await awaitCondition(() => data.results.some(result => result.status === 'sent'), { timeoutMs: 2000, message: 'accepted document must send after original turn cancellation' })
  assert.equal(data.sent.length, 1)
  assert.equal((await data.queue.defer(event, new AbortController().signal))?.status, 'sent')
  assert.equal(data.sent.length, 1, 'repeated handoff must reuse the persisted delivery')
})

test('queued documents survive a runtime restart while unknown sends never replay', async context => {
  const store = createSqliteStore({ filename: ':memory:' })
  const first = await fixture(context, async () => pages, store)
  assert.equal((await first.queue.defer(event, first.lifetime.signal))?.status, 'queued')
  await first.stop()
  const restored = await fixture(context, async () => pages, store, [{ status: 'unknown' }])
  restored.queue.start()
  await awaitCondition(() => restored.results.some(result => result.status === 'unknown'), { timeoutMs: 2000, message: 'restored pending document must use its original outbox' })
  assert.equal(restored.sent.length, 1)
  await restored.stop()
  const again = await fixture(context, async () => { assert.fail('unknown delivery must not render again') }, store)
  context.after(async () => { await again.stop(); await restored.stop(); await first.stop(); store.close() })
  again.queue.start()
  assert.equal((await again.queue.defer(event, again.lifetime.signal))?.status, 'unknown')
  assert.equal(again.sent.length, 0)
})

for (const change of ['generation', 'revoke'] as const) test(`background Markdown rechecks ${change} before sending`, async context => {
  let release!: () => void, rendering = false
  const held = new Promise<void>(resolve => { release = resolve })
  const data = await fixture(context, async () => { rendering = true; await held; return pages })
  await data.queue.defer(event, data.lifetime.signal)
  data.queue.start()
  await awaitCondition(() => rendering, { timeoutMs: 1000, message: 'background render must start' })
  data[change]()
  release()
  await awaitCondition(() => data.results.some(result => result.status === 'rejected'), { timeoutMs: 2000, message: 'changed authority must reject the delayed send' })
  assert.equal(data.sent.length, 0)
})
