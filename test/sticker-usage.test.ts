import assert from 'node:assert/strict'
import test from 'node:test'
import { createSqliteStore } from '../src/storage/sqlite.ts'
import { createStickerUsage } from '../src/host/sticker-usage.ts'

test('successful delivery counters are account scoped and receipt idempotent without touching annotations', context => {
  const store = createSqliteStore({ filename: ':memory:', clock: () => 1000 })
  context.after(() => store.close())
  const id = 'a'.repeat(64), first = createStickerUsage({ store, accountId: 'first', now: () => 1000 })
  const second = createStickerUsage({ store, accountId: 'second', now: () => 1000 })
  const annotation = store.write('native-chat.sticker-library', id, { label: 'original' })
  assert.deepEqual(first.read(id), { sentCount: 0, lastSentAt: null })
  first.record({ id, idempotencyKey: 'delivery-one', at: 900 })
  first.record({ id, idempotencyKey: 'delivery-one', at: 1000 })
  assert.deepEqual(first.read(id), { sentCount: 1, lastSentAt: 900 })
  first.record({ id, idempotencyKey: 'delivery-two', at: 800 })
  assert.deepEqual(first.read(id), { sentCount: 2, lastSentAt: 900 })
  assert.deepEqual(second.read(id), { sentCount: 0, lastSentAt: null })
  second.record({ id, idempotencyKey: 'delivery-one' })
  assert.deepEqual(second.read(id), { sentCount: 1, lastSentAt: 1000 })
  assert.equal(store.read('native-chat.sticker-library', id)?.revision, annotation.revision)
})
