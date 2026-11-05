import { isRecord } from './values.ts';

export const FRAMEWORK_REPOSITORY = 'sophisticate9008/qq-bridge-framework';
export const FRAMEWORK_RELEASE_URL = `https://github.com/${FRAMEWORK_REPOSITORY}/releases`;
export function releaseVersion(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.test(value);
}
export function compareReleaseVersions(left: string, right: string): number {
  if (!releaseVersion(left) || !releaseVersion(right)) throw new Error('invalid_release_version');
  const a = left.split('.').map(Number), b = right.split('.').map(Number);
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  return 0;
}
export interface FrameworkReleaseStatus {
  readonly schema: 1;
  readonly currentVersion: string;
  readonly latestVersion: string | null;
  readonly checkedAt: number | null;
  readonly state: 'current' | 'available' | 'ahead' | 'unavailable';
  readonly majorUpgrade: boolean;
  readonly releaseUrl: string;
  readonly installation: 'source' | 'archive' | 'docker';
  readonly error: 'release_check_failed' | null;
}
export function parseFrameworkReleaseStatus(value: unknown): FrameworkReleaseStatus | null {
  if (!isRecord(value) || value.schema !== 1 || !releaseVersion(value.currentVersion)
    || value.latestVersion !== null && !releaseVersion(value.latestVersion)
    || value.checkedAt !== null && (!Number.isSafeInteger(value.checkedAt) || Number(value.checkedAt) < 0)
    || !['current', 'available', 'ahead', 'unavailable'].includes(String(value.state))
    || typeof value.majorUpgrade !== 'boolean' || !['source', 'archive', 'docker'].includes(String(value.installation))
    || value.error !== null && value.error !== 'release_check_failed'
    || value.releaseUrl !== FRAMEWORK_RELEASE_URL && value.releaseUrl !== `${FRAMEWORK_RELEASE_URL}/tag/v${value.latestVersion}`) return null;
  return value as unknown as FrameworkReleaseStatus;
}
