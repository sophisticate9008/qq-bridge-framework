import { parseDshHealth } from '../../src/contracts/dsh-health.ts';
import type { ApiClient } from '../lib/api.ts';
import { dshHealthDescription, dshHealthLabel } from '../lib/dsh-health.ts';
import { useReadResource } from '../lib/use-read-resource.ts';
import { StatusPill } from './management.tsx';

export function useDshHealth(api: ApiClient, connected: boolean) {
  const resource = useReadResource(api, '/api/chat/dsh/health', connected, parseDshHealth, { intervalMs: 15_000 });
  const health = resource.error ? null : resource.snapshot;
  const tone = resource.error || health?.state === 'unavailable' || health?.state === 'unknown' ? 'warning'
    : health?.state === 'ready' ? 'success' : 'neutral';
  return { ...resource, health, tone, label: dshHealthLabel(health, !!resource.error),
    description: resource.error ? '状态接口读取失败，当前 DSH 服务状态未确认。' : dshHealthDescription(health) } as const;
}
export function DshHealthStatus({ api, connected }: { readonly api: ApiClient; readonly connected: boolean }) {
  const status = useDshHealth(api, connected);
  return <StatusPill tone={status.tone}>{status.label}</StatusPill>;
}
