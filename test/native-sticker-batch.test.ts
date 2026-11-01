import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import type { EffectRequest, JsonValue } from '../src/core/types.ts'
import { isRecord } from '../src/core/values.ts'
import { createNativeMessageSources } from '../src/host/native-message-sources.ts'
import { createNativeStickerService, NATIVE_STICKER_TOOLS } from '../src/host/native-sticker-tools.ts'
import { createSqliteStore } from '../src/storage/sqlite.ts'

function fixture(t: TestContext, reply: (request: EffectRequest, index: number) => Promise<JsonValue> = async () => ({ status: 'queued', quiet: true })) {
  const store = createSqliteStore({ filename: ':memory:' })
  const lifetime = new AbortController()
  const sources = createNativeMessageSources({ owner: 'owner', signal: lifetime.signal, async validate() {} })
  sources.capture({ id: 'source', conversationId: 'group:fixture', userId: 'ordinary-member' },
    { receivedAt: Date.now(), expiresAt: Date.now() + 30_000, signal: lifetime.signal })
  const calls: EffectRequest[] = []
  const service = createNativeStickerService({ store, selfId: 'account', sources: () => sources.reader,
    async authorize() {}, register() { throw new Error('Collection registration never sends an image') },
    port: { async list() { throw new Error('Registration must not wait for QQ collection reads') },
      async add() { throw new Error('Registration must not perform a QQ write') } },
    async collect(request) { calls.push(request); return reply(request, calls.length - 1) } })
  t.after(() => { lifetime.abort(); store.close() })
  function asset(id: string, changes: Record<string, JsonValue> = {}) {
    store.write('native-chat.media', id, { schema: 1, accountId: 'account', conversationId: 'group:fixture',
      kind: 'image', expiresAt: Date.now() + 30_000, ...changes }, { expectedRevision: null })
  }
  const execute = (input: JsonValue) => service.manage.execute({ input, signal: lifetime.signal,
    scope: { featureId: 'framework-tools', version: '1.0.0', conversationId: 'group:fixture', eventId: 'source' } })
  return { calls, asset, execute }
}

test('one multi-image request registers each unique image without claiming collection completion', async t => {
  const f = fixture(t, async (_request, index): Promise<JsonValue> => index === 0 ? { status: 'queued', quiet: true } : { status: 'skipped', reason: 'busy', quiet: true })
  f.asset('first'); f.asset('second')
  const result = await f.execute({ action: 'add', assetIds: ['first', 'first', 'second'] })
  assert.deepEqual(f.calls.map(call => call.input), [{ action: 'add', assetId: 'first' }, { action: 'add', assetId: 'second' }])
  assert.deepEqual(result, { status: 'queued', requestedCount: 2, acceptedCount: 1, completed: false, quiet: true,
    items: [{ status: 'queued', quiet: true, assetId: 'first', completed: false },
      { status: 'skipped', reason: 'busy', quiet: true, assetId: 'second', completed: false }] })
  const allQueued = fixture(t)
  allQueued.asset('first'); allQueued.asset('second')
  const accepted = await allQueued.execute({ action: 'add', assetIds: ['first', 'second'] })
  assert(isRecord(accepted)); assert.equal(accepted.acceptedCount, 2); assert.equal(accepted.completed, false)
  assert.equal(allQueued.calls.length, 2)
})

test('batch media validation rejects another account, conversation, expired or non-image handle before any registration', async t => {
  const invalidMedia: Record<string, JsonValue>[] = [{ accountId: 'other-account' }, { conversationId: 'group:other' }, { kind: 'file' }, { expiresAt: 1 }]
  for (const changes of invalidMedia) {
    const f = fixture(t)
    f.asset('first'); f.asset('second', changes)
    await assert.rejects(Promise.resolve().then(() => f.execute({ action: 'add', assetIds: ['first', 'second'] })), { code: 'NATIVE_MEDIA_UNAVAILABLE' })
    assert.equal(f.calls.length, 0)
  }
})

test('single-image callers remain compatible and uncertain registration is not retried or labelled completed', async t => {
  const f = fixture(t)
  f.asset('single')
  const result = await f.execute({ action: 'add', assetId: 'single' })
  assert(isRecord(result)); assert.equal(result.status, 'queued'); assert.equal(result.completed, false)
  assert.deepEqual(f.calls[0]!.input, { action: 'add', assetId: 'single' })
  const uncertain = fixture(t, async () => { throw new Error('No confirmed registration result') })
  uncertain.asset('single')
  const unknown = await uncertain.execute({ action: 'add', assetIds: ['single'] })
  assert(isRecord(unknown)); assert.equal(unknown.status, 'unknown'); assert.equal(unknown.completed, false)
  assert.equal(uncertain.calls.length, 1)
})

test('add input accepts one bounded image form and rejects ambiguous or oversized batches', () => {
  const tool = NATIVE_STICKER_TOOLS.find(tool => tool.definition.name === 'qbf_sticker_manage')!
  const invalidInputs: JsonValue[] = [{ action: 'add', assetId: 'first', assetIds: ['second'] }, { action: 'add', assetIds: [] },
    { action: 'add', assetIds: Array.from({ length: 9 }, (_, index) => `asset-${index}`) },
    { action: 'add', assetIds: ['valid', 'invalid\nhandle'] }]
  for (const input of invalidInputs) {
    assert.throws(() => tool.validate(input), { code: 'INVALID_STICKER_INPUT' })
  }
  assert.deepEqual(tool.validate({ action: 'add', assetIds: ['first', 'second'] }), { action: 'add', assetIds: ['first', 'second'] })
})
