import type { ChatHealthLayer } from '../contracts/chat-health.ts';
import { isRecord } from '../core/values.ts';

/** Checks the actual configured HTTP path with read-only OneBot actions. */
export async function probeOneBotHttpHealth(adapter: { readonly enabled: boolean; readonly endpoint: string; readonly secret: string },
  selfId: string | null, signal: AbortSignal): Promise<ChatHealthLayer> {
  const result = (state: ChatHealthLayer['state'], reason: string | null): ChatHealthLayer => ({ id: 'send', state, reason });
  if (!adapter.enabled || !adapter.endpoint) return result('unavailable', 'http_not_configured');
  const deadline = AbortSignal.timeout(5000);
  const combined = AbortSignal.any([signal, deadline]);
  try {
    const query = async (action: 'get_status' | 'get_login_info') => {
      const response = await fetch(`${adapter.endpoint.replace(/\/+$/, '')}/${action}`, { method: 'POST', redirect: 'error',
        headers: { 'content-type': 'application/json', ...(adapter.secret ? { authorization: `Bearer ${adapter.secret}` } : {}) }, body: '{}', signal: combined });
      if (!response.ok) { await response.body?.cancel(); throw new Error(response.status === 401 || response.status === 403 ? 'http_authentication_failed' : 'http_connection_failed'); }
      const reader = response.body?.getReader();
      if (!reader) throw new Error('http_invalid_response');
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        for (;;) {
          const item = await reader.read(); if (item.done) break;
          size += item.value.length; if (size > 65536) throw new Error('http_invalid_response');
          chunks.push(item.value);
        }
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!isRecord(value) || value.status !== 'ok' || value.retcode !== 0 || !isRecord(value.data)) throw new Error('http_invalid_response');
      return value.data;
    };
    const [status, login] = await Promise.all([query('get_status'), query('get_login_info')]);
    if (status.online !== true || status.good === false) return result('unavailable', 'http_account_offline');
    if (selfId === null) return result('unknown', 'http_identity_unverified');
    if (String(login.user_id) !== selfId) return result('unavailable', 'http_identity_mismatch');
    return result('ready', null);
  } catch (error) {
    signal.throwIfAborted();
    const known = ['http_authentication_failed', 'http_connection_failed', 'http_invalid_response'];
    return result('unavailable', deadline.aborted ? 'http_timeout'
      : error instanceof Error && known.includes(error.message) ? error.message : 'http_connection_failed');
  }
}
