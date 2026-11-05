import type { ChatHealth, ChatHealthLayer } from '../contracts/chat-health.ts';
import { probeDshHealth } from '../adapters/dsh-health.ts';
import { probeOneBotHttpHealth } from '../adapters/onebot-health.ts';
import type { NativeChatRuntime } from '../host/native-chat-runtime.ts';
import type { NativeAssistantTarget } from '../host/native-assistant-target.ts';
import { withDeadline } from '../host/deadlines.ts';
import { NativeConfigurationRepository } from './native-configuration-repository.ts';
import { AdminRequestError, type AdminRoute } from './server.ts';

export function createNativeChatHealthRoutes(directory: string, runtime: NativeChatRuntime, assistantTarget?: Pick<NativeAssistantTarget, 'resolve'>): readonly AdminRoute[] {
  const repository = new NativeConfigurationRepository(directory);
  let pending: Promise<ChatHealth> | undefined;
  async function inspect(signal: AbortSignal): Promise<ChatHealth> {
    const configuration = await repository.readAdapterDocument();
    const assistantDocument = await repository.readAssistant();
    const revisions = JSON.stringify((await repository.read()).revisions);
    const initial = await runtime.status();
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(6000)]);
    const [dshResult, sendResult, assistantResult] = await Promise.allSettled([
      probeDshHealth(configuration.value.adapters.dshAgent, deadline),
      probeOneBotHttpHealth(configuration.value.adapters.onebotHttp, initial.connection.selfId, deadline),
      assistantDocument.value.mode === 'chat-only' ? Promise.resolve(null)
        : assistantTarget ? withDeadline({ signal: deadline, timeoutMs: 5_000, code: 'ASSISTANT_STATUS_TIMEOUT',
          run: currentSignal => assistantTarget.resolve(currentSignal) }) : Promise.reject(new Error('unavailable')),
    ]);
    const stable = configuration.revision === (await repository.readAdapterDocument()).revision
      && revisions === JSON.stringify((await repository.read()).revisions)
      && assistantDocument.revision === (await repository.readAssistant()).revision;
    const status = await runtime.status();
    const layer = (id: ChatHealthLayer['id'], state: ChatHealthLayer['state'], reason: string | null = null): ChatHealthLayer => ({ id, state, reason });
    const connection = status.connection;
    const frameworkReasons = status.missingReasons.filter(reason => !['agent_follow_unavailable', 'framework_tool_channel_unavailable',
      'interaction_channel_unavailable', 'onebot_protocol_not_connected', 'onebot_account_offline', 'onebot_account_unhealthy'].includes(reason));
    const tool = status.frameworkTools;
    const toolCode = tool?.channel.lastError;
    const toolReason = toolCode && ['DSH_INVALID_RESPONSE', 'DSH_TOOL_INVALID_RESPONSE', 'DSH_TIMEOUT', 'DSH_TRANSPORT_UNKNOWN',
      'DSH_ABORTED', 'TOOL_CHANNEL_UNKNOWN', 'TOOL_CALL_CAPACITY'].includes(toolCode) ? toolCode.toLowerCase() : 'framework_tool_channel_unavailable';
    const replyCode = status.host?.followRecovery.lastError;
    const replyReason = replyCode && ['DSH_FOLLOW_ENDED', 'DSH_FOLLOW_PONG_TIMEOUT', 'DSH_FOLLOW_SEQUENCE_GAP',
      'DSH_FOLLOW_INVALID_FRAME', 'DSH_FOLLOW_FRAME_TOO_LARGE', 'DSH_FOLLOW_EVENT_TOO_LARGE', 'DSH_FOLLOW_CURSOR_CONFLICT',
      'DSH_FOLLOW_REPLAY_LIMIT', 'DSH_FOLLOW_TRANSPORT_UNKNOWN', 'DSH_FOLLOW_BACKPRESSURE', 'DSH_FOLLOW_CALLBACK_FAILED'].includes(replyCode)
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
        : tool.channel.state === 'idle' ? 'idle' : 'ready', tool && !tool.available ? toolReason : null),
      layer('interactions', status.state !== 'running' ? 'stopped' : status.interactionChannel?.state === 'connected' ? 'ready'
        : status.interactionChannel?.state === 'connecting' ? 'recovering' : 'unavailable',
        status.state === 'running' && status.interactionChannel?.state !== 'connected' ? 'interaction_channel_unavailable' : null),
    ];
    const work = runtime.workStatus();
    const resolved = assistantResult.status === 'fulfilled' ? assistantResult.value : undefined;
    const missing = resolved === undefined ? 'assistant_target_unavailable'
      : resolved?.missingReasons[0] ?? work.missingReasons[0] ?? 'assistant_target_unavailable';
    const assistantReasons = ['assistant_disabled', 'assistant_deployment_not_applied', 'assistant_deployment_configuration_changed',
      'assistant_deployment_reconciliation_required', 'assistant_deployment_busy', 'assistant_deployment_target_unverified',
      'assistant_model_unavailable', 'assistant_model_capabilities_unverified', 'assistant_reasoning_unsupported', 'assistant_local_target_unavailable'];
    const assistant = layer('assistant', assistantDocument.value.mode === 'chat-only' ? 'idle'
      : status.state !== 'running' ? 'stopped' : resolved?.configuration.enabled && work.available && !resolved.missingReasons.length ? 'ready'
      : resolved === undefined ? 'unknown' : 'unavailable',
    assistantDocument.value.mode === 'chat-only' ? 'assistant_disabled' : status.state !== 'running' ? 'runtime_not_started'
      : resolved?.configuration.enabled && work.available && !resolved.missingReasons.length ? null
      : assistantReasons.includes(missing) ? missing : 'assistant_target_unavailable');
    if (!stable) for (const item of layers) Object.assign(item, { state: 'unknown', reason: 'configuration_changed' });
    if (!stable) Object.assign(assistant, { state: 'unknown', reason: 'configuration_changed' });
    return { schema: 1, checkedAt: Date.now(), healthy: stable && status.chatReady
      && [...layers, assistant].every(item => ['ready', 'idle'].includes(item.state)), modelExecutionVerified: false, layers, assistant };
  }
  return [{ method: 'GET', pathname: '/api/chat/health', async handle({ query }) {
    if (query.size) throw new AdminRequestError(400, 'invalid_query');
    if (!pending) {
      pending = inspect(AbortSignal.timeout(8000)).finally(() => { pending = undefined; });
    }
    try { return await pending; } catch { throw new AdminRequestError(503, 'chat_health_unavailable'); }
  } }];
}
