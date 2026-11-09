import type { ChatHealthLayer } from '../contracts/chat-health.ts';

export function isTransientAssistantHealthReason(reason: string | null): boolean {
  return ['assistant_target_unavailable', 'assistant_status_timeout', 'dsh_timeout', 'dsh_transport_unknown',
    'dsh_live_verification_required', 'dsh_profile_operation_failed', 'pending_reload',
    'native_work_backend_unavailable', 'native_work_channel_unknown'].includes(reason ?? '');
}

/** Diagnostic hysteresis only. Task admission always performs its own current target/permission checks. */
export function createAssistantHealthConfirmation(now: () => number = Date.now) {
  let previousKey: string | undefined;
  let faultSince: number | undefined;
  let failures = 0;
  return (key: string, observed: ChatHealthLayer): ChatHealthLayer => {
    if (key !== previousKey) { previousKey = key; faultSince = undefined; failures = 0; }
    if (observed.reason === 'assistant_deployment_busy') {
      faultSince = undefined; failures = 0;
      return { ...observed, state: 'recovering' };
    }
    if (!['unknown', 'unavailable'].includes(observed.state) || !isTransientAssistantHealthReason(observed.reason)) {
      faultSince = undefined; failures = 0;
      return observed;
    }
    const at = now();
    if (faultSince === undefined || faultSince > at) { faultSince = at; failures = 0; }
    failures++;
    return { ...observed, state: failures >= 2 && at - faultSince >= 15_000 ? 'unavailable' : 'recovering' };
  };
}
