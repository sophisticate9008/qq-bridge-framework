import { isNativeApplicationId } from './native-application.ts';
import { releaseVersion } from './framework-release.ts';
import { isRecord } from './values.ts';
export const FRAMEWORK_PRODUCT_PHASES = ['prepared', 'stopping', 'bridge', 'runtime', 'starting', 'completed',
  'rollback-bridge', 'rollback-runtime', 'rollback-start', 'rolled-back', 'unknown'] as const;
export type FrameworkProductPhase = typeof FRAMEWORK_PRODUCT_PHASES[number];

export interface FrameworkUpdateState {
  readonly schema: 1;
  readonly id: string;
  readonly version: string;
  readonly state: 'preparing' | 'ready' | 'applying' | 'verifying' | 'completed' | 'failed' | 'rolled-back' | 'unknown';
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly error: string | null;
  readonly transactionId: string | null;
  readonly productPhase?: FrameworkProductPhase;
}
export function parseFrameworkUpdateState(value: unknown): FrameworkUpdateState | null {
  if (!isRecord(value) || value.schema !== 1 || !isNativeApplicationId(value.id) || !releaseVersion(value.version)
    || !['preparing', 'ready', 'applying', 'verifying', 'completed', 'failed', 'rolled-back', 'unknown'].includes(String(value.state))
    || ![value.createdAt, value.updatedAt].every(at => typeof at === 'number' && Number.isSafeInteger(at) && at >= 0)
    || value.error !== null && (typeof value.error !== 'string' || !/^[a-z0-9_]{1,96}$/.test(value.error))
    || value.transactionId !== null && !isNativeApplicationId(value.transactionId)
    || value.productPhase !== undefined && !FRAMEWORK_PRODUCT_PHASES.includes(value.productPhase as FrameworkProductPhase)) return null;
  return value as unknown as FrameworkUpdateState;
}
