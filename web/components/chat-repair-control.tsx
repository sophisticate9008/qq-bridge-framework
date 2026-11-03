import { LoaderCircle, Wrench } from 'lucide-react';
import type { ChatRepairOperation } from '../../src/contracts/chat-repair.ts';
import type { ApiClient } from '../lib/api.ts';
import { requestChatRepair, useChatRepair } from '../lib/chat-repair.ts';
import { chatRuntimeReason, parseChatRuntimeStatus } from '../lib/chat-runtime.ts';
import { useReadResource } from '../lib/use-read-resource.ts';
import { Button } from './ui/button.tsx';

const labels: Readonly<Record<ChatRepairOperation['phase'], string>> = {
  checking: '检查已保存的设置', stopping: '恢复受管组件', 'starting-services': '重新连接框架与 DSH',
  applying: '应用当前聊天设置', 'starting-chat': '启动聊天', verifying: '确认聊天链路',
};
const reasons: Readonly<Record<string, string>> = {
  chat_repair_local_dsh_required: '尚未配置受管的本机 DSH，请在连接设置中自动连接本机服务。',
  chat_repair_dsh_target_mismatch: '已连接的 DSH 与受管实例不同，请在连接设置中选择本机 DSH。',
  chat_repair_guardian_unavailable: '恢复守护进程未能就绪，本次尚未停服；可以再次点击恢复。',
  chat_repair_application_unknown: '应用结果尚未确认，已保留原操作记录；可再次恢复并查看应用详情。',
  chat_repair_worker_start_failed: '后台恢复进程未能启动，请检查本机服务管理器后再次修复。',
  chat_repair_services_not_restored: '部分受管服务尚未恢复，请查看服务状态；可再次点击修复。',
  chat_repair_configuration_changed: '已保存设置在预检期间发生变化，请再次点击修复以读取最新设置。',
  chat_repair_lock_unverified: '遗留写锁无法确认归属，本次保留文件；请检查服务状态后再次恢复。',
  chat_repair_lock_changed: '写锁状态发生变化，本次没有移除；稍后可再次恢复。',
  chat_repair_lock_owners_unverified: '尚未确认配置写入已全部结束，本次保留文件；可再次恢复。',
  chat_repair_worker_interrupted: '上次修复进程已中断，可以再次点击一键恢复。',
  chat_repair_not_received: '原修复请求未被受理，尚未执行；可以重新点击一键恢复。',
  chat_repair_accounts_require_individual_recovery: '当前部署包含多个账号，请先在各账号检查聊天状态；此恢复入口暂不支持统一重启多账号。',
  chat_repair_stop_failed: '受管组件未能全部停止；可以再次修复，并查看具体服务状态。',
  chat_repair_start_failed: '受管组件未能启动，请核对 DSH 安装与连接设置后再次修复。',
  chat_repair_protocol_unavailable: 'QQ 协议端尚未连通或未登录。请在协议端恢复登录，再点一键恢复。',
  chat_repair_chat_not_ready: '聊天链路尚未就绪，请查看聊天运行卡片的异常原因后再次修复。',
  chat_repair_timeout: '修复未能在期限内完成，会话记录保留；可以再次修复。',
  chat_repair_writer_still_running: '仍有配置写入未结束，本次未覆盖文件；稍后可再次修复。',
  chat_repair_failed: '修复未完成，会话记录保留；可以再次修复。',
};
export function ChatRepairControl({ api, connected, compact = false }: { readonly api: ApiClient; readonly connected: boolean; readonly compact?: boolean }) {
  const repair = useChatRepair(api, connected);
  const runtime = useReadResource(api, '/api/chat/runtime', connected, parseChatRuntimeStatus, { intervalMs: 5_000 });
  const { operation, pending } = repair;
  const message = pending ? `${operation ? labels[operation.phase] : '等待修复受理结果'}…`
    : operation?.state === 'completed' ? runtime.snapshot?.state === 'running' && runtime.snapshot.chatReady && !runtime.error
      ? '最近一次修复已完成；当前聊天链路就绪。' : '最近一次修复已完成；当前状态请查看聊天诊断。'
      : operation?.state === 'failed' ? '修复未完成，可处理原因后再次点击。' : '自动恢复受管服务并启动聊天。';
  return <div className={compact ? 'stack' : 'strip stack'} data-chat-repair>
    <div className="row"><Button size="sm" variant="outline" disabled={!connected || pending || repair.state.snapshot?.available !== true} onClick={() => void requestChatRepair(api)}>
      {pending ? <LoaderCircle className="size-3.5 animate-spin" /> : <Wrench className="size-3.5" />}{pending ? '正在恢复聊天' : '一键恢复聊天'}
    </Button><span className="small" role="status">{message}</span></div>
    {!compact && <p className="small muted">会短暂重启框架、DSH 及受管依赖，应用已保存设置并保留会话历史；协议端保持独立。未保存草稿不参与修复。</p>}
    {pending && repair.error && <p className="small" role="status">受管服务正在恢复，页面会自动重新连接并读取同一修复记录。</p>}
    {!pending && operation?.state === 'failed' && <p className="small" role="alert">{operation.reasons.map(code => reasons[code] ?? chatRuntimeReason(code).text).join(' ')}</p>}
    {!pending && repair.state.snapshot?.available === false && <p className="small">当前部署尚未配置受管服务入口，请在部署设置中接入本机服务管理器。</p>}
    {repair.state.error && <p className="small" role="status">{repair.state.error}</p>}
  </div>;
}
