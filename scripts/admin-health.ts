import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gatewayAdminAddress, type GatewayAdminConfiguration } from '../src/admin/gateway.ts';
import { parseDshHealth } from '../src/contracts/dsh-health.ts';
import { parseNativeApplicationSnapshot } from '../src/contracts/native-application.ts';
import { isRecord } from '../src/core/values.ts';
import { privatePermissions } from '../src/storage/file-security.ts';

export interface HealthCheck {
  readonly id: 'admin' | 'gateway' | 'dsh' | 'protocol' | 'chat' | 'application';
  readonly state: 'ready' | 'stopped' | 'pending' | 'blocked' | 'unavailable' | 'unknown' | 'disabled' | 'unconfigured';
  readonly reasons: readonly string[];
}
export interface AdminHealthReport {
  readonly schema: 1;
  readonly checkedAt: number;
  readonly healthy: boolean;
  readonly checks: readonly HealthCheck[];
}

async function privateToken(filename: string): Promise<string> {
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > 4_096 || !privatePermissions(filename, info, 0o600)
      || process.getuid && info.uid !== process.getuid()) throw new Error('token');
    const value = (await handle.readFile('utf8')).trim();
    if (value.length < 16 || /[\r\n]/.test(value)) throw new Error('token');
    return value;
  } finally { await handle.close(); }
}
async function responseValue(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('response');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > 1_048_576) throw new Error('capacity');
      chunks.push(item.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
const codes = (value: unknown): string[] => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === 'string' && /^[A-Za-z][A-Za-z0-9_.:-]{0,159}$/.test(item)).slice(0, 64) : [];

/** Every observation settles independently; one failed domain never erases another domain's evidence. */
export async function readAdminHealth(configuration: Readonly<GatewayAdminConfiguration>, account?: string): Promise<AdminHealthReport> {
  const base = gatewayAdminAddress(configuration);
  let token: string | undefined;
  try { token = await privateToken(configuration.tokenFile); } catch { /* Public liveness remains readable. */ }
  const read = async (path: string, scoped = false): Promise<{ value?: unknown; reason?: string }> => {
    if (path !== '/health' && !token) return { reason: 'admin_credentials_unavailable' };
    const url = new URL(account && scoped ? '/api/accounts/dispatch' : path, base);
    if (account && scoped) { url.searchParams.set('account', account); url.searchParams.set('path', path); }
    const signal = AbortSignal.timeout(8_000);
    try {
      const response = await fetch(url, { headers: token && path !== '/health' ? { authorization: `Bearer ${token}` } : {},
        redirect: 'error', signal });
      if (!response.ok) { await response.body?.cancel(); return { reason: `http_${response.status}` }; }
      return { value: await responseValue(response) };
    } catch { return { reason: signal.aborted ? 'read_timeout' : 'read_failed' }; }
  };
  const [admin, gateway, dsh, runtime, application] = await Promise.all([
    read('/health'), read('/api/gateway/health'), read('/api/chat/dsh/health', true),
    read('/api/chat/runtime', true), read('/api/chat/application', true),
  ]);
  const unknown = (id: HealthCheck['id'], reason = 'invalid_response'): HealthCheck => ({ id, state: 'unknown', reasons: [reason] });
  const checks: HealthCheck[] = [];
  checks.push(isRecord(admin.value) && admin.value.ok === true && admin.value.mode === 'framework'
    ? { id: 'admin', state: 'ready', reasons: [] } : unknown('admin', admin.reason));
  const expectedRevision = createHash('sha256').update(JSON.stringify(configuration)).digest('hex');
  checks.push(isRecord(gateway.value) && gateway.value.mode === 'gateway-live' && gateway.value.revision === expectedRevision
    && typeof gateway.value.ok === 'boolean' ? { id: 'gateway', state: gateway.value.ok ? 'ready' : 'unavailable',
      reasons: gateway.value.ok ? [] : ['gateway_unavailable'] } : unknown('gateway', gateway.reason));
  const dshHealth = parseDshHealth(dsh.value);
  checks.push(dshHealth ? { id: 'dsh', state: dshHealth.state, reasons: dshHealth.reason ? [dshHealth.reason] : [] } : unknown('dsh', dsh.reason));
  const r = runtime.value;
  if (isRecord(r) && ['stopped', 'starting', 'running', 'stopping', 'error'].includes(String(r.state))
    && typeof r.chatReady === 'boolean' && (!r.chatReady || r.state === 'running') && typeof r.protocolConnected === 'boolean'
    && Array.isArray(r.missingReasons) && r.missingReasons.every(reason => typeof reason === 'string')) {
    checks.push({ id: 'protocol', state: r.protocolConnected ? 'ready' : 'unavailable', reasons: r.protocolConnected ? [] : ['protocol_not_connected'] });
    const notRestored = r.state === 'stopped' && isRecord(r.lifecycle) && r.lifecycle.desiredRunning === true;
    const blocked = r.state === 'stopped' && (notRestored || r.missingReasons.some(reason => reason !== 'runtime_not_started'));
    checks.push({ id: 'chat', state: r.state === 'stopped' ? blocked ? 'blocked' : 'stopped'
      : r.state === 'starting' || r.state === 'stopping' ? 'pending' : r.chatReady ? 'ready' : 'unavailable',
      reasons: [...new Set([...codes(r.missingReasons), ...codes([r.lastError]), ...(notRestored ? ['running_intent_not_restored'] : [])])] });
  } else checks.push(unknown('protocol', runtime.reason), unknown('chat', runtime.reason));
  const a = application.value;
  if (isRecord(a) && a.schema === 1 && a.operation === null) checks.push({ id: 'application', state: 'ready', reasons: [] });
  else {
    const parsed = isRecord(a) && a.schema === 1 ? parseNativeApplicationSnapshot(a.operation) : null;
    checks.push(parsed ? { id: 'application', state: parsed.state === 'completed' ? 'ready' : parsed.state === 'running' ? 'pending'
      : parsed.state === 'unknown' ? 'unknown' : 'blocked', reasons: codes(parsed.reasons) } : unknown('application', application.reason));
  }
  return { schema: 1, checkedAt: Date.now(), healthy: checks.every(check => ['ready', 'stopped'].includes(check.state)), checks };
}
export function printAdminHealth(report: AdminHealthReport, output: (line: string) => void): void {
  const names = { admin: '管理服务', gateway: '发送网关', dsh: 'DSH 鉴权接口', protocol: 'QQ 协议连接', chat: '聊天处理', application: '配置应用' };
  const states = { ready: '正常', stopped: '已停止', pending: '处理中', blocked: '需要处理', unavailable: '异常', unknown: '未确认', disabled: '未启用', unconfigured: '未配置' };
  for (const check of report.checks) output(`${names[check.id]}：${states[check.state]}${check.reasons.length ? `（${check.reasons.join('、')}）` : ''}`);
}
