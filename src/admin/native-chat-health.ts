import type { ChatHealth, ChatHealthLayer } from '../contracts/chat-health.ts';
import { probeDshHealth } from '../adapters/dsh-health.ts';
import { probeOneBotHttpHealth } from '../adapters/onebot-health.ts';
import type { NativeChatRuntime } from '../host/native-chat-runtime.ts';
import { NativeConfigurationRepository } from './native-configuration-repository.ts';
import { AdminRequestError, type AdminRoute } from './server.ts';

export function createNativeChatHealthRoutes(directory: string, runtime: NativeChatRuntime): readonly AdminRoute[] {
  const repository = new NativeConfigurationRepository(directory);
  let pending: Promise<ChatHealth> | undefined;
  async function inspect(signal: AbortSignal): Promise<ChatHealth> {
    const configuration = await repository.readAdapterDocument();
    const initial = await runtime.status();
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(6000)]);
    const [dshResult, sendResult] = await Promise.allSettled([
      probeDshHealth(configuration.value.adapters.dshAgent, deadline),
      probeOneBotHttpHealth(configuration.value.adapters.onebotHttp, initial.connection.selfId, deadline),
    ]);
    const stable = configuration.revision === (await repository.readAdapterDocument()).revision;
    const status = await runtime.status();
    const layer = (id: ChatHealthLayer['id'], state: ChatHealthLayer['state'], reason: string | null = null): ChatHealthLayer => ({ id, state, reason });
    const connection = status.connection;
    const frameworkReasons = status.missingReasons.filter(reason => !['agent_follow_unavailable', 'framework_tool_channel_unavailable',
      'interaction_channel_unavailable', 'onebot_protocol_not_connected', 'onebot_account_offline', 'onebot_account_unhealthy'].includes(reason));
    const tool = status.frameworkTools;
    const replyCode = status.host?.followRecovery.lastError;
    const replyReason = replyCode && ['DSH_FOLLOW_ENDED', 'DSH_FOLLOW_PONG_TIMEOUT', 'DSH_FOLLOW_SEQUENCE_GAP',
      'DSH_FOLLOW_INVALID_FRAME', 'DSH_FOLLOW_TRANSPORT_UNKNOWN', 'DSH_FOLLOW_BACKPRESSURE', 'DSH_FOLLOW_CALLBACK_FAILED'].includes(replyCode)
      ? replyCode.toLowerCase() : 'agent_follow_unavailable';
    const layers: ChatHealthLayer[] = [
      layer('framework', status.state === 'stopped' ? 'stopped' : status.state !== 'running' || frameworkReasons.length > 0 ? 'unavailable' : 'ready',
        status.state === 'stopped' ? 'runtime_not_started' : frameworkReasons[0] ?? (status.state === 'running' ? null : 'host_not_ready')),
      layer('receive', status.protocolConnected ? 'ready' : ['connecting', 'reconnecting'].includes(connection.state) ? 'recovering' : 'unavailable',
        status.protocolConnected ? null : connection.accountOnline === false ? 'onebot_account_offline' : 'onebot_protocol_not_connected'),
      status.connection.selfId !== initial.connection.selfId ? layer('send', 'unknown', 'http_identity_unverified')
        : sendResult.status === 'fulfilled' ? sendResult.value : layer('send', 'unknown', 'http_probe_failed'),
      dshResult.status === 'fulfilled' ? layer('dsh', dshResult.value.state === 'ready' ? 'ready' : dshResult.value.state === 'unknown' ? 'unknown' : 'unavailable', dshResult.value.reason)
        : layer('dsh', 'unknown', 'probe_failed'),
      layer('replies', status.state !== 'running' ? 'stopped' : (status.host?.unhealthyFollows ?? 0) > 0 ? 'recovering'
        : (status.host?.followedSessions ?? 0) > 0 ? 'ready' : 'idle',
        (status.host?.unhealthyFollows ?? 0) > 0 ? replyReason : null),
      layer('tools', !tool ? 'stopped' : tool.channel.state === 'recovering' ? 'recovering' : !tool.available ? 'unavailable'
        : tool.channel.state === 'idle' ? 'idle' : 'ready', tool && !tool.available ? 'framework_tool_channel_unavailable' : null),
      layer('interactions', status.state !== 'running' ? 'stopped' : status.interactionChannel?.state === 'connected' ? 'ready'
        : status.interactionChannel?.state === 'connecting' ? 'recovering' : 'unavailable',
        status.state === 'running' && status.interactionChannel?.state !== 'connected' ? 'interaction_channel_unavailable' : null),
    ];
    if (!stable) for (const item of layers) Object.assign(item, { state: 'unknown', reason: 'configuration_changed' });
    return { schema: 1, checkedAt: Date.now(), healthy: stable && status.chatReady && layers.every(item => ['ready', 'idle'].includes(item.state)),
      modelExecutionVerified: false, layers };
  }
  return [{ method: 'GET', pathname: '/api/chat/health', async handle({ query }) {
    if (query.size) throw new AdminRequestError(400, 'invalid_query');
    if (!pending) {
      pending = inspect(AbortSignal.timeout(8000)).finally(() => { pending = undefined; });
    }
    try { return await pending; } catch { throw new AdminRequestError(503, 'chat_health_unavailable'); }
  } }];
}
