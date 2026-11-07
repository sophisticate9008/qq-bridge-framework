import { assert, errorCode } from '../core/values.ts'
import { withDeadline } from './deadlines.ts'

/** Bounded, read-only recovery observation. Exhausted records retain their original unknown state. */
export function createExecutionRecoveryPoll(options: {
  readonly signal: AbortSignal
  readonly candidates: () => readonly string[]
  readonly inspect: (id: string, signal: AbortSignal) => Promise<boolean>
  readonly observe: (id: string, result: { readonly attempt: number; readonly settled: boolean; readonly exhausted: boolean; readonly error: string | null; readonly nextAt: number | null }) => void
  readonly previous?: (id: string) => { readonly attempt: number; readonly nextAt: number | null; readonly exhausted: boolean } | null
  readonly onFault?: (code: string) => void
  readonly clock?: () => number
  readonly intervalMs?: number
  readonly maxAttempts?: number
}) {
  const clock = options.clock ?? Date.now
  const interval = options.intervalMs ?? 1000, maxAttempts = options.maxAttempts ?? 24
  assert(Number.isSafeInteger(interval) && interval >= 10 && interval <= 60_000 && Number.isSafeInteger(maxAttempts)
    && maxAttempts >= 1 && maxAttempts <= 100, 'RECOVERY_POLL_INVALID', 'Recovery observation must be bounded.')
  const entries = new Map<string, { attempt: number; nextAt: number; pending: boolean; raw: boolean }>()
  let active = 0
  let rawActive = 0
  let timer: ReturnType<typeof setInterval> | undefined
  function tick() {
    if (options.signal.aborted) return
    const candidates = [...new Set(options.candidates())].slice(0, 256)
    const current = new Set(candidates)
    for (const [id, entry] of entries) if (!current.has(id) && !entry.pending && !entry.raw) entries.delete(id)
    for (const id of candidates) {
      if (active >= 4 || rawActive >= 4) break
      let entry = entries.get(id)
      if (!entry) {
        if (entries.size >= 256) continue
        const previous = options.previous?.(id)
        entry = { attempt: previous?.exhausted ? maxAttempts : previous?.attempt ?? 0, nextAt: previous?.nextAt ?? 0, pending: false, raw: false }; entries.set(id, entry)
      }
      if (entry.pending || entry.raw || entry.attempt >= maxAttempts || entry.nextAt > clock()) continue
      const selected = entry
      selected.pending = true; selected.attempt++; active++
      void (async () => {
        let settled = false, error: string | null = null
        try { settled = await withDeadline({ signal: options.signal, timeoutMs: 6000, code: 'RECOVERY_OBSERVATION_TIMEOUT',
          run: async signal => {
            selected.raw = true; rawActive++
            try { return await options.inspect(id, signal) } finally { selected.raw = false; rawActive-- }
          } }) } catch (failure) { error = errorCode(failure, 'RECOVERY_OBSERVATION_UNKNOWN') }
        if (options.signal.aborted) return
        const exhausted = !settled && selected.attempt >= maxAttempts
        selected.nextAt = clock() + Math.min(60_000, 1000 * 2 ** Math.min(6, selected.attempt - 1))
        options.observe(id, { attempt: selected.attempt, settled, exhausted, error, nextAt: settled || exhausted ? null : selected.nextAt })
      })().catch(error => options.onFault?.(errorCode(error, 'RECOVERY_OBSERVATION_STORAGE_FAILED'))).finally(() => { selected.pending = false; active-- })
    }
  }
  options.signal.addEventListener('abort', () => { if (timer) clearInterval(timer); entries.clear() }, { once: true })
  return Object.freeze({
    start() { if (!timer && !options.signal.aborted) { timer = setInterval(() => { try { tick() } catch (error) { options.onFault?.(errorCode(error, 'RECOVERY_OBSERVATION_FAILED')) } }, interval); timer.unref(); tick() } },
    tick,
    metrics() { return { tracked: entries.size, active, rawActive, exhausted: [...entries.values()].filter(x => x.attempt >= maxAttempts).length } },
  })
}
