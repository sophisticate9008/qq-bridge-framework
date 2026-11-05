import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { isRecord } from '../contracts/values.ts';
import { isNativeApplicationId } from '../contracts/native-application.ts';
import { readDocument, updateDocument } from '../storage/private-json.ts';
import type { AdminRoute } from './server.ts';

export interface AutomaticRecoveryState {
  readonly schema: 1;
  readonly faultSince: number | null;
  readonly attempts: readonly number[];
  readonly nextAttemptAt: number;
  readonly operationId: string | null;
  readonly reason: string | null;
}
const initial: AutomaticRecoveryState = { schema: 1, faultSince: null, attempts: [], nextAttemptAt: 0, operationId: null, reason: null };
function validate(value: unknown): AutomaticRecoveryState {
  const time = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  if (!isRecord(value) || value.schema !== 1 || value.faultSince !== null && !time(value.faultSince)
    || !time(value.nextAttemptAt) || !Array.isArray(value.attempts) || value.attempts.length > 3 || !value.attempts.every(time)
    || value.operationId !== null && !isNativeApplicationId(value.operationId)
    || value.reason !== null && (typeof value.reason !== 'string' || !/^[a-z0-9_]{1,96}$/.test(value.reason))) throw new Error('automatic_recovery_storage_invalid');
  return value as unknown as AutomaticRecoveryState;
}
export interface RecoveryObservation { readonly eligible: boolean; readonly fault: boolean; readonly reason: string | null }
/** Admission is durable before repair starts. A lost response never causes the same operation to be replayed. */
export function createAutomaticChatRecovery(options: {
  readonly directory: string;
  readonly enabled?: boolean;
  readonly observe: (signal: AbortSignal) => Promise<RecoveryObservation>;
  readonly repair: (operationId: string, signal: AbortSignal) => Promise<void>;
  readonly now?: () => number;
}) {
  const filename = join(options.directory, 'automatic-chat-recovery.json');
  const now = options.now ?? Date.now;
  const enabled = options.enabled ?? true;
  const read = () => readDocument(filename, initial, validate);
  let pending: Promise<void> | undefined;
  async function inspect(signal: AbortSignal) {
    if (!enabled || signal.aborted) return;
    const observation = await options.observe(signal);
    signal.throwIfAborted();
    const document = await read(), previous = document.value, at = now();
    let next: AutomaticRecoveryState = previous;
    let operationId: string | null = null;
    if (!observation.eligible || !observation.fault) {
      next = { ...previous, faultSince: null, reason: observation.reason };
    } else {
      const attempts = previous.attempts.filter(time => time > at - 3_600_000);
      // A clock rollback must not turn the restart budget into an unlimited retry loop.
      const faultSince = previous.faultSince === null || previous.faultSince > at ? at : previous.faultSince;
      next = { ...previous, faultSince, attempts, reason: observation.reason };
      if (at - faultSince >= 90_000 && at >= previous.nextAttemptAt && attempts.length < 3) {
        operationId = randomUUID();
        next = { ...next, attempts: [...attempts, at], operationId,
          nextAttemptAt: at + [300_000, 900_000, 3_600_000][attempts.length] };
      }
    }
    if (JSON.stringify(next) !== JSON.stringify(previous)) {
      await updateDocument(options.directory, filename, document.revision, initial, validate, () => next);
    }
    signal.throwIfAborted();
    if (operationId) await options.repair(operationId, signal);
  }
  return {
    tick(signal: AbortSignal): Promise<void> {
      pending ??= inspect(signal).finally(() => { pending = undefined; });
      return pending;
    },
    routes: [{ method: 'GET', pathname: '/api/chat/automatic-recovery', async handle() {
      return { ...(await read()).value, enabled, observationIntervalMs: 30_000, faultThresholdMs: 90_000 };
    } }] satisfies AdminRoute[],
  };
}
