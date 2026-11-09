import type { ChatHealth, ChatHealthLayer } from '../../src/contracts/chat-health.ts';
export { chatHealthChecks } from '../../src/contracts/chat-health.ts';
import { chatRuntimeBadge, chatRuntimeReason, type ChatRuntimeStatus } from './chat-runtime.ts';

export const chatHealthNames: Readonly<Record<ChatHealthLayer['id'], string>> = {
  framework: '框架处理', receive: 'QQ 消息接收', send: 'HTTP 发送接口', dsh: 'DSH 鉴权接口', replies: '会话回复监听', tools: '框架工具通道',
  interactions: '模型提问通道', assistant: '后台助手',
};
export const chatHealthStates: Readonly<Record<ChatHealthLayer['state'], string>> = {
  ready: '正常', idle: '待命', recovering: '正在重连', unavailable: '异常', unknown: '未确认', stopped: '未运行',
};
export function chatHealthLayerLabel(layer: ChatHealthLayer): string {
  if (layer.state !== 'ready') return chatHealthStates[layer.state];
  return { framework: '已运行', receive: '已连接', send: '接口可连接', dsh: '鉴权可用', replies: '已连接', tools: '轮询可用', interactions: '已连接', assistant: '会话配置可用' }[layer.id];
}
export function chatHealthGuidance(layer: ChatHealthLayer): string {
  if (layer.id === 'assistant') {
    if (layer.reason === 'assistant_disabled') return '后台助手已关闭。';
    if (layer.state === 'recovering') return '正在复核助手所用的 DSH 会话、模型与工具通道；短暂超时会自动复查，持续异常由后台尝试恢复。';
    if (layer.state === 'ready') return '助手所用的 DSH 会话配置、模型与工具通道已核验；实际工作结果单独核对。';
    if (/configuration_changed|not_applied/.test(layer.reason ?? '')) return '助手部署需要更新，请在聊天方案中重新保存并应用助手设置；原会话保留。';
    if (/reconciliation|unknown|interrupted|pending_reload/.test(layer.reason ?? '')) return '助手加载结果尚未确认，请核对原部署记录；未受理的任务没有交给模型，不自动重发。';
    return '请检查聊天方案中的助手状态与 DSH 连接；原工作与会话记录保留。';
  }
  if (layer.state === 'ready') return layer.id === 'dsh' ? '鉴权接口可用；模型生成结果单独核对。' : '当前检查通过。';
  if (layer.state === 'idle') return '当前没有活动连接需求；新请求会建立连接，也可手动检查连接。';
  if (layer.id === 'receive') return layer.reason === 'onebot_account_offline' ? '请在协议端重新登录 QQ；框架等待连接恢复。'
    : '请检查协议端 WebSocket 服务、网络和访问密钥；连接恢复后框架会重新接收消息。';
  if (layer.id === 'send') {
    if (layer.reason === 'http_account_offline') return 'HTTP 接口报告 QQ 已离线，请在协议端核对登录和账号状态。';
    if (layer.reason === 'http_identity_mismatch') return 'HTTP 接口与消息接收连接的 QQ 账号不同，请核对协议端配置。';
    if (layer.reason === 'http_identity_unverified') return 'HTTP 接口已响应；等待消息接收连接确认同一 QQ 账号。';
    if (layer.reason === 'http_authentication_failed') return 'HTTP 接口拒绝鉴权，请核对协议端 HTTP 服务的专用密钥。';
    return '请检查协议端 HTTP 服务及发送地址；若使用框架网关，再检查网关状态。接口恢复后重新检查，未知送达的消息不重发。';
  }
  if (layer.id === 'dsh') return layer.reason === 'authentication_failed' || layer.reason === 'credentials_unavailable'
    ? '请核对 DSH 的鉴权设置；本机受管 DSH 可使用“一键恢复聊天”自动恢复。'
    : '请检查 DSH 服务和网络；本机受管 DSH 可使用“一键恢复聊天”，远程 DSH 请在其部署端恢复。';
  if (layer.id === 'replies') {
    const causes: Readonly<Record<string, string>> = {
      dsh_follow_ended: 'DSH 会话订阅连接已关闭。', dsh_follow_pong_timeout: 'DSH 会话订阅心跳超时。',
      dsh_follow_sequence_gap: 'DSH 会话事件出现序列缺口。', dsh_follow_invalid_frame: 'DSH 会话事件格式无法核验。',
      dsh_follow_transport_unknown: 'DSH 会话订阅网络连接中断。', dsh_follow_backpressure: 'DSH 会话事件积压超过接收上限。',
      dsh_follow_callback_failed: '框架处理会话事件时失败。',
    };
    const cause = layer.reason && Object.hasOwn(causes, layer.reason) ? causes[layer.reason] : '会话回复监听已中断。';
    return `${cause}框架正在重新连接；旧请求不重发。持续失败可使用“一键恢复聊天”。`;
  }
  if (layer.id === 'tools') {
    if (layer.state === 'recovering') return '工具轮询连接中断，框架会重连只读轮询；已执行或结果未知的工具不重做。';
    const cause = ['dsh_invalid_response', 'dsh_tool_invalid_response'].includes(layer.reason ?? '')
      ? 'DSH 工具接口返回了无法核验的数据，框架已停止该通道。'
      : layer.reason === 'dsh_timeout' ? '工具通道请求超时，执行或回执结果尚未确认。' : '工具通道未恢复。';
    return `${cause}可使用“一键恢复聊天”恢复通道；未确认的工具结果保留，不重复执行。`;
  }
  if (layer.id === 'interactions') return 'DSH 的模型提问连接已中断，当前无法接收新的提问。可使用“重新连接聊天”或“一键恢复聊天”；旧提问按原记录核对，不重复答复。';
  return layer.reason ? chatRuntimeReason(layer.reason).text : '查看聊天运行详情；持续异常可重启框架，保留原会话。';
}
export function chatHealthBadge(health: ChatHealth | null, runtime: ChatRuntimeStatus | null): string {
  if (!runtime || runtime.state !== 'running') return chatRuntimeBadge(runtime);
  if (!health) return '聊天链路待检查';
  if (health.healthy) return '聊天链路就绪';
  for (const id of ['receive', 'send', 'dsh', 'replies', 'tools', 'interactions', 'framework'] as const) {
    const layer = health.layers.find(item => item.id === id);
    if (!layer || ['ready', 'idle'].includes(layer.state)) continue;
    return { receive: 'QQ 接收连接异常', send: 'HTTP 发送接口异常', dsh: '等待 DSH 连接恢复',
      replies: '会话回复监听正在重连', tools: layer.state === 'recovering' ? '工具通道正在重连' : '工具通道需要恢复',
      interactions: '模型提问通道需要恢复', framework: '框架处理需要恢复' }[id];
  }
  if (health.assistant?.state === 'recovering') return '后台助手正在复核';
  if (health.assistant && !['ready', 'idle'].includes(health.assistant.state)) return '后台助手需要恢复';
  return chatRuntimeBadge(runtime);
}
