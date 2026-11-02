import type { DshHealth } from '../contracts/dsh-health.ts';
import { errorCode } from '../core/values.ts';
import { createDshAuthenticationOptions } from './dsh-authentication.ts';
import { createDshJsonRpcPort } from './dsh-jsonrpc.ts';
import { DshAdapterError } from './dsh.ts';

/** Authenticated, bounded read only. Does not load chat, create a session or invoke a model. */
export async function probeDshHealth(adapter: { readonly enabled: boolean; readonly endpoint: string; readonly auth: string;
  readonly localCredentialsPath?: string }, signal: AbortSignal): Promise<DshHealth> {
  const result = (state: DshHealth['state'], reason: DshHealth['reason']): DshHealth => ({ schema: 1, state, reason,
    checkedAt: Date.now(), scope: 'authenticated-api', modelExecutionVerified: false });
  signal.throwIfAborted();
  if (!adapter.enabled) return result('disabled', 'disabled');
  if (!adapter.endpoint || !adapter.auth && !adapter.localCredentialsPath) return result('unconfigured', 'configuration_missing');
  const deadline = AbortSignal.timeout(5_000);
  const combined = AbortSignal.any([signal, deadline]);
  let port: ReturnType<typeof createDshJsonRpcPort> | undefined;
  try {
    const authentication = createDshAuthenticationOptions(adapter);
    const provider = authentication.authenticationProvider;
    port = createDshJsonRpcPort({ endpoint: adapter.endpoint, ...authentication,
      ...(provider ? { authenticationProvider: async (mode, authSignal) => {
        try { return await provider(mode, authSignal); }
        catch { throw new DshAdapterError('DSH_LOCAL_AUTH_UNAVAILABLE', 'Local authentication is unavailable.'); }
      } } : {}), timeoutMs: 5_000 });
    await port.verify(combined);
    combined.throwIfAborted();
    return result('ready', null);
  } catch (error) {
    signal.throwIfAborted();
    const code = errorCode(error, '');
    if (deadline.aborted || code === 'DSH_TIMEOUT') return result('unavailable', 'timeout');
    if (code === 'DSH_AUTH_REJECTED') return result('unavailable', 'authentication_failed');
    if (code.startsWith('DSH_LOCAL_AUTH_')) return result('unknown', 'credentials_unavailable');
    if (code === 'DSH_TRANSPORT_UNKNOWN') return result('unavailable', 'connection_failed');
    if (['DSH_INVALID_RESPONSE', 'DSH_RESPONSE_TOO_LARGE', 'DSH_VERIFICATION_FAILED'].includes(code)) return result('unavailable', 'invalid_response');
    return result('unknown', 'probe_failed');
  } finally { await port?.close(); }
}
