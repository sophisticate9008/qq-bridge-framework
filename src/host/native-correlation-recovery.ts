/** A transient read failure can be rechecked; an epoch change or explicit recovery requires a new lifecycle. */
export function createNativeCorrelationRecovery(options: {
  readonly issuerEpoch: string;
  readonly signal: AbortSignal;
  readonly describe: (signal: AbortSignal) => Promise<{ readonly issuerEpoch: string }>;
  readonly restored: () => void;
  readonly now?: () => number;
}) {
  let suspended = false, blocked = false, next = 0;
  let pending: Promise<void> | undefined;
  const now = options.now ?? Date.now;
  return {
    fault(transient: boolean) { suspended = true; blocked ||= !transient; next = now() + 30_000; },
    block() { blocked = true; },
    tick(): Promise<void> {
      if (pending) return pending;
      if (!suspended || blocked || options.signal.aborted || now() < next) return Promise.resolve();
      next = now() + 30_000;
      pending = (async () => {
        try {
          const description = await options.describe(AbortSignal.any([options.signal, AbortSignal.timeout(5000)]));
          if (blocked || options.signal.aborted) return;
          if (description.issuerEpoch !== options.issuerEpoch) { blocked = true; return; }
          suspended = false;
          options.restored();
        } catch { /* Retain the pause and retry only this read, with the same issuer identity. */ }
      })().finally(() => { pending = undefined; });
      return pending;
    },
  };
}
