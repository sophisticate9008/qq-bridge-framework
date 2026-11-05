import type { DshFollowCursors } from '../adapters/dsh-follow-budget.ts'
import type { DurableStore } from './types.ts'
import { digest, object } from './data.ts'
import { assert } from '../core/values.ts'

/** Account storage and permanent session ownership scope each checkpoint. */
export function createNativeDshCursors(store: DurableStore, endpoint: string): DshFollowCursors {
  const namespace = 'native-chat.dsh-cursors'
  const key = (sessionId: string) => digest([endpoint, sessionId])
  function load(sessionId: string): number | undefined {
    const row = store.read(namespace, key(sessionId))
    if (!row) return undefined
    const value = object(row.value)
    assert(value.schema === 1 && value.sessionId === sessionId && Number.isSafeInteger(value.sequence)
      && Number(value.sequence) >= -1, 'DSH_FOLLOW_CURSOR_INVALID', 'The saved subscription position is invalid.')
    return Number(value.sequence)
  }
  return { load, save(sessionId, sequence) {
    assert(Number.isSafeInteger(sequence) && sequence >= -1, 'DSH_FOLLOW_CURSOR_INVALID', 'Invalid subscription position.')
    const previous = store.read(namespace, key(sessionId))
    const prior = load(sessionId)
    if (prior !== undefined && sequence <= prior) return
    store.write(namespace, key(sessionId), { schema: 1, sessionId, sequence }, { expectedRevision: previous?.revision ?? null })
  } }
}
