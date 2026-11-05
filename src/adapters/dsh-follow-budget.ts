export interface DshFollowCursors {
  load(sessionId: string): number | undefined
  save(sessionId: string, sequence: number): void
}

/** Shared by chat and plugin subscriptions, including partially received events. */
export function createDshFollowByteBudget(limit = 64 * 1024 * 1024) {
  let used = 0
  return {
    reserve(bytes: number): boolean { if (used + bytes > limit) return false; used += bytes; return true },
    release(bytes: number): void { used -= bytes },
  }
}
