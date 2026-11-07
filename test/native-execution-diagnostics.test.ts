import test from 'node:test'
import assert from 'node:assert/strict'
import { createSqliteStore } from '../src/storage/sqlite.ts'
import { recordNativeExecutionPhase, readNativeExecutionDiagnostics } from '../src/host/native-execution-diagnostics.ts'
import { isRecord } from '../src/core/values.ts'

test('phase evidence is bounded, independently correlated, deduplicated and retained without notices', () => {
  const store = createSqliteStore({ filename: ':memory:' })
  try {
    recordNativeExecutionPhase(store, { sessionId: 'session', requestId: 'old', phase: 'queue-start', at: 100 })
    for (let i = 0; i < 140; i++) recordNativeExecutionPhase(store, { sessionId: 'session', turn: 1, phase: 'compaction-start', at: i, sequence: i })
    recordNativeExecutionPhase(store, { sessionId: 'session', turn: 1, phase: 'compaction-start', at: 139, sequence: 139 })
    const old = readNativeExecutionDiagnostics(store, { binding: { sessionId: 'session' }, requestId: 'old', turn: { id: '1' } })
    assert(isRecord(old.turn)); assert.equal(old.turn.truncated, true)
    assert(Array.isArray(old.turn.events)); assert.equal(old.turn.events.length, 128)
    const next = readNativeExecutionDiagnostics(store, { binding: { sessionId: 'session' }, requestId: 'new', turn: { id: '2' } })
    assert.deepEqual(next, { request: null, turn: null })
  } finally { store.close() }
})
