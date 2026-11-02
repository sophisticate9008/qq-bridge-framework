import type { DshHealth } from '../../src/contracts/dsh-health.ts';

export function dshHealthLabel(health: DshHealth | null, readFailed = false): string {
  if (readFailed) return '读取失败';
  if (!health) return '尚未检查';
  return { ready: '服务可连接', unavailable: '服务连接异常', disabled: '连接未启用', unconfigured: '连接未配置', unknown: '状态未确认' }[health.state];
}
export function dshHealthDescription(health: DshHealth | null): string {
  if (!health) return 'DSH 服务状态独立读取。';
  if (health.state === 'ready') return 'DSH 鉴权接口已响应；聊天处理、桥接插件及模型请求结果分别核对。';
  const messages: Readonly<Record<NonNullable<DshHealth['reason']>, string>> = {
    disabled: 'DSH 连接尚未启用。', configuration_missing: 'DSH 地址或访问凭据尚未配置。',
    configuration_unavailable: '连接配置暂不可读，无法判断 DSH 服务是否正常。', configuration_changed: '检查期间连接配置发生变化，请重新检查。',
    authentication_failed: 'DSH 鉴权未通过，请核对访问凭据。', credentials_unavailable: '本机鉴权资料不可用，尚未确认 DSH 服务状态。',
    timeout: 'DSH 鉴权接口检查超时。', connection_failed: '无法连接 DSH 鉴权接口。',
    invalid_response: 'DSH 返回了无法核验的响应。', probe_failed: 'DSH 检查未完成，状态尚未确认。',
  };
  return health.reason ? messages[health.reason] : '状态尚未确认。';
}
