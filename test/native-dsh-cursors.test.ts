import assert from 'node:assert/strict'
import test from 'node:test'
import { createSqliteStore } from '../src/storage/sqlite.ts'
import { createNativeDshCursors } from '../src/host/native-dsh-cursors.ts'

test('DSH cursor checkpoints survive consumer recreation and isolate endpoints and consumers', () => {
  const store = createSqliteStore({ filename: ':memory:' })
  try {
    const cursors = createNativeDshCursors(store, 'http://localhost:3080')
    assert.equal(cursors.load('session-a'), undefined)
    cursors.save('session-a', 100)
    cursors.save('session-a', 99)
    const restored = createNativeDshCursors(store, 'http://localhost:3080')
    assert.equal(restored.load('session-a'), 100)
    assert.equal(restored.load('session-b'), undefined)
    assert.equal(restored.load(JSON.stringify(['plugin-model', 'session-a'])), undefined)
    assert.equal(createNativeDshCursors(store, 'http://localhost:4080').load('session-a'), undefined)
    assert.throws(() => cursors.save('session-a', NaN), { code: 'DSH_FOLLOW_CURSOR_INVALID' })
  } finally { store.close() }
})
