import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { isRecord } from '../contracts/values.ts';
import { isNativeApplicationId } from '../contracts/native-application.ts';
import { readDocument, updateDocument } from '../storage/private-json.ts';
import type { AdminRoute } from './server.ts';
import type { ChatHealth } from '../contracts/chat-health.ts';
import { isTransientAssistantHealthReason } from './assistant-health.ts';

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

/** Called after saved-intent and maintenance checks. Health is the same read-only evidence shown by the console. */
export function observeChatRecovery(status: { readonly state: string; readonly chatReady: boolean; readonly canStart: boolean;
  readonly missingReasons: readonly string[];
  readonly configurationImpact?: { readonly changedDependencies: readonly string[] } | null }, health: ChatHealth | null, managedRepair: boolean): RecoveryObservation {
  const blocked = (reason: string): RecoveryObservation => ({ eligible: false, fault: false, reason });
  if (!['stopped', 'error', 'running'].includes(status.state)) return blocked('lifecycle_busy');
  const recoverable = new Set(['runtime_not_started', 'native_runtime_lease_blocked', 'native_runtime_lease_unknown',
    'agent_follow_unavailable', 'framework_tool_channel_unavailable', 'interaction_channel_unavailable',
    'host_not_ready', 'execution_controller_unavailable', 'execution_correlation_unavailable', 'onebot_protocol_not_connected',
    'dsh_live_verification_required', 'dsh_profile_operation_failed', 'capability_source_unverified', 'pending_reload']);
  // Lost live bindings are a consequence of a failed DSH check, not an edit to the saved settings.
  const bindingObservationLost = status.configurationImpact?.changedDependencies.length === 1
    && status.configurationImpact.changedDependencies[0] === 'bindings'
    && status.missingReasons.some(reason => ['dsh_live_verification_required', 'dsh_profile_operation_failed', 'capability_source_unverified', 'pending_reload'].includes(reason));
  if (status.missingReasons.some(reason => !recoverable.has(reason) && !(reason === 'configuration_changed' && bindingObservationLost))) {
    return blocked('configuration_or_external_service_unavailable');
  }
  // Offline accounts, a different HTTP identity and bad protocol credentials cannot be repaired by restarting DSH.
  const send = health?.layers.find(layer => layer.id === 'send');
  if (send && ['http_not_configured', 'http_account_offline', 'http_identity_mismatch', 'http_authentication_failed'].includes(send.reason ?? '')) {
    return blocked('protocol_configuration_or_login_required');
  }
  if (!status.chatReady) {
    if (!managedRepair && !status.canStart) return blocked('managed_repair_unavailable');
    return { eligible: true, fault: true, reason: 'framework_unavailable' };
  }
  if (!health) return blocked('health_observation_unavailable');
  const transport = health.layers.find(layer => !['ready', 'idle'].includes(layer.state));
  if (transport) {
    if (transport.reason === 'configuration_changed') return blocked('configuration_changed');
    if (!managedRepair) return blocked('managed_repair_unavailable');
    return { eligible: true, fault: true, reason: `${transport.id}_unavailable` };
  }
  const assistant = health.assistant;
  if (assistant && !['ready', 'idle'].includes(assistant.state)) {
    if (assistant.state === 'recovering') return blocked('assistant_verification_pending');
    if (!isTransientAssistantHealthReason(assistant.reason)) return blocked('assistant_configuration_requires_attention');
    if (!managedRepair) return blocked('managed_repair_unavailable');
    return { eligible: true, fault: true, reason: 'assistant_unavailable' };
  }
  return { eligible: true, fault: false, reason: null };
}
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
