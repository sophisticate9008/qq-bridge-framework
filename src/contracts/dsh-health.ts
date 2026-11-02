import { isRecord } from './values.ts';

export const DSH_HEALTH_REASONS = ['disabled', 'configuration_missing', 'configuration_unavailable', 'configuration_changed',
  'authentication_failed', 'credentials_unavailable', 'timeout', 'connection_failed', 'invalid_response', 'probe_failed'] as const;
export interface DshHealth {
  readonly schema: 1;
  readonly state: 'ready' | 'unavailable' | 'disabled' | 'unconfigured' | 'unknown';
  readonly reason: typeof DSH_HEALTH_REASONS[number] | null;
  readonly checkedAt: number;
  readonly scope: 'authenticated-api';
  readonly modelExecutionVerified: false;
}
export function parseDshHealth(value: unknown): DshHealth | null {
  if (!isRecord(value) || value.schema !== 1 || !['ready', 'unavailable', 'disabled', 'unconfigured', 'unknown'].includes(String(value.state))
    || !(value.reason === null || DSH_HEALTH_REASONS.some(reason => reason === value.reason))
    || (value.state === 'ready') !== (value.reason === null)
    || typeof value.checkedAt !== 'number' || !Number.isSafeInteger(value.checkedAt) || value.checkedAt < 0
    || value.scope !== 'authenticated-api' || value.modelExecutionVerified !== false) return null;
  return value as unknown as DshHealth;
}
