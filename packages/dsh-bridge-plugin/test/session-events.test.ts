import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionEventSource } from '../dist/session-event-source.js'
import { followSessionEvents } from '../dist/session-events.js'

test('bridge event service sends cursor-only openings, bounded replay chunks and projected live metadata', async () => {
  const huge = 'private'.repeat(200000)
  const source: SessionEventSource = {
    async *follow() {
      yield { type: 'snapshot', header: { id: SessionId('s'), version: 4, createdAt: 0, isSeeded: false }, cursor: 2,
        records: [{ type: 'event', event: { seq: 2, type: 'assistant/message', time: 0, data: { text: huge } } }],
        hasMore: true, projections: { asOfSeq: 2, values: {} } }
      yield { type: 'event', event: { seq: 3, type: 'tool/result', time: 0, data: {
        turn: 1, step: 0, message: { role: 'tool', toolCallId: 'call', content: huge },
      } } }
    },
    async *replay(_sessionId, after, through) {
      assert.equal(after, 0); assert.equal(through, 2)
      yield { seq: 1, type: 'request/header', time: 0, data: { private: huge } }
      yield { seq: 2, type: 'assistant/message', time: 0, data: { text: huge } }
    },
  }
  const frames = []
  for await (const frame of followSessionEvents(source, { sessionId: 's', issuerEpoch: 'epoch', after: 0 }, 'epoch', new AbortController().signal)) frames.push(frame)
  const opening = frames[0]!
  assert.equal(opening.type, 'snapshot')
  assert(Buffer.byteLength(JSON.stringify(opening)) < 1024)
  const large = frames.filter(frame => frame.type === 'event-chunk' && frame.seq === 2)
  assert(large.length > 1)
  const chunks: Buffer[] = []
  for (const frame of large) {
    assert(frame.type === 'event-chunk')
    assert(Buffer.byteLength(JSON.stringify(frame)) < 300000)
    assert.equal(frame.replayed, true)
    chunks.push(Buffer.from(frame.data, 'base64'))
  }
  const bytes = Buffer.concat(chunks)
  assert.equal(createHash('sha256').update(bytes).digest('hex'), large[0]!.type === 'event-chunk' ? large[0]!.hash : '')
  assert.equal(JSON.parse(bytes.toString()).data.text, huge)
  const last = frames.at(-1)!
  assert(last.type === 'event-chunk' && last.seq === 3 && !last.replayed)
  assert.equal(JSON.stringify(last).includes(huge), false)
  assert(Buffer.byteLength(JSON.stringify(last)) < 1024)
})

test('bridge event service refuses a missing replay event instead of silently advancing the cursor', async () => {
  const source: SessionEventSource = {
    async *follow() { yield { type: 'snapshot', header: { id: SessionId('s'), version: 4, createdAt: 0, isSeeded: false },
      cursor: 2, records: [], hasMore: true, projections: { asOfSeq: 2, values: {} } } },
    async *replay() { yield { seq: 2, type: 'turn/end', time: 0, data: { turn: 1 } } },
  }
  await assert.rejects(async () => {
    for await (const _frame of followSessionEvents(source, { sessionId: 's', issuerEpoch: 'epoch', after: 0 }, 'epoch', new AbortController().signal)) { /* consume */ }
  }, /DSH_FOLLOW_SEQUENCE_GAP/)
})
