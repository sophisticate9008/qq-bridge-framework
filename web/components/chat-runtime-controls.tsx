import { useChatApplication } from '../lib/use-chat-application.ts';
import { useReadResource } from '../lib/use-read-resource.ts';
import { readResource, writeResource } from '../lib/resource-reader.ts';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { CircleAlert, LoaderCircle, Play, RefreshCw, Square } from 'lucide-react';
import { errorMessage, type ApiClient } from '../lib/api.ts';
import { chatRuntimeBadge, chatRuntimeCanApplyAndStart, chatRuntimeCanRecoverStoppedControl, chatRuntimeLastError, chatRuntimeNeedsSessionMigration, chatRuntimeReason, chatRuntimeVisibleReasons, parseChatRuntimeStatus, type ChatRuntimeStatus } from '../lib/chat-runtime.ts';
import { useDshHealth } from './dsh-health-status.tsx';
import { applyAndStartChat, chatApplicationPhaseLabels } from '../lib/chat-application.ts';
import type { PageProps } from '../lib/types.ts';
import { StatusPill } from './management.tsx';
import { Button } from './ui/button.tsx';
import { SessionMigrationControl } from './session-migration-control.tsx';
import { ReadOnlyDetails, TechnicalDetails } from './read-only-details.tsx';
import { SettingsWindow } from './settings-window.tsx';
import { useDshRestart } from '../lib/use-dsh-restart.ts';
import { parseChatHealth } from '../../src/contracts/chat-health.ts';
import { chatHealthChecks, chatHealthBadge, chatHealthGuidance, chatHealthLayerLabel, chatHealthNames } from '../lib/chat-health.ts';
import { FrameworkRestartControl } from './framework-restart-control.tsx';
import { ChatRepairControl } from './chat-repair-control.tsx';
import { useChatRepair } from '../lib/chat-repair.ts';

export function ChatRuntimeControls({ api, connected, dirty, navigate, onRunningChange, connectionPanel, compact = false }: {
  readonly api: ApiClient; readonly connected: boolean; readonly dirty: boolean; readonly navigate: PageProps['navigate'];
  onRunningChange?(running: boolean): void; readonly connectionPanel?: ReactNode; readonly compact?: boolean;
}) {
  const { application, state: applicationState, observationError, refresh: refreshApplication } = useChatApplication(api, connected);
  const restart = useDshRestart(api, connected);
  const repair = useChatRepair(api, connected);
  const dshHealth = useDshHealth(api, connected);
  const chain = useReadResource(api, '/api/chat/health', connected, parseChatHealth, { intervalMs: 5_000 });
  const health = chain.error ? null : chain.snapshot;
  const [status, setStatus] = useState<ChatRuntimeStatus | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);
  const [action, setAction] = useState<'start' | 'stop' | 'restore' | 'reconnect' | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const request = useRef<AbortController | null>(null);
  const epoch = useRef(0);
  const repairEpoch = useRef(repair.state.epoch);
  const connection = useRef({ api, connected, dirty });
  connection.current = { api, connected, dirty };
  const resource = useReadResource(api, '/api/chat/runtime', connected, parseChatRuntimeStatus, { intervalMs: 5_000,
    pollWhen: () => request.current === null && !application.getSnapshot().busy });
  const active = repair.pending || action !== null || status?.restoring === true || status?.state === 'starting' || status?.state === 'stopping';
  const running = status?.state === 'running';
  const visibleReasons = status ? chatRuntimeVisibleReasons(status) : [];
  const applyBeforeStart = status ? chatRuntimeCanApplyAndStart(status) : false;
  useEffect(() => { onRunningChange?.(running || active); }, [running, active, onRunningChange]);

  useEffect(() => {
    epoch.current++;
    setAction(null); setStatus(null); setError(''); setUncertain(false);
    return () => { epoch.current++; request.current?.abort(); request.current = null; };
  }, [api, connected]);
  useEffect(() => {
    setLoading(resource.loading);
    if (request.current === null) {
      if (resource.snapshot) { setStatus(resource.snapshot); if (!resource.error) setUncertain(false); }
      setError(resource.error ? errorMessage(resource.error) : '');
    }
  }, [resource.snapshot, resource.loading, resource.error]);

  useEffect(() => {
    if (repairEpoch.current === repair.state.epoch) return;
    repairEpoch.current = repair.state.epoch;
    epoch.current++;
    request.current?.abort(); request.current = null;
    setAction(null); setError(''); setNotice(''); setUncertain(false);
  }, [api, repair.state.epoch]);

  async function control(operation: 'start' | 'stop'): Promise<void> {
    if (!status || active || uncertain || restart.pending || operation === 'start' && dirty || loading || request.current
      || application.getSnapshot().busy || application.getSnapshot().blocked || connection.current.api !== api || !connection.current.connected) return;
    epoch.current++;
    const controller = new AbortController();
    request.current = controller;
    const generation = epoch.current;
    const current = () => !controller.signal.aborted && request.current === controller && generation === epoch.current
      && connection.current.api === api && connection.current.connected;
    const sharedOwner = operation === 'stop' ? application.claim() : null;
    const abort = () => { if (sharedOwner && application.owns(sharedOwner)) application.freeze(); };
    controller.signal.addEventListener('abort', abort, { once: true });
    setAction(operation);
    setError(''); setNotice('');
    try {
      if (operation === 'start') {
        const result = await applyAndStartChat({ api, signal: controller.signal, deploy: applyBeforeStart, expectedRevisions: status.revisions,
          isCurrent: () => current() && !connection.current.dirty,
          onPhase: phase => { if (current()) setNotice(chatApplicationPhaseLabels[phase]); } });
        if (!current()) return;
        setStatus(result.runtime);
        setNotice(result.state === 'running' ? '聊天已启动，原有上下文保留。' : '检查未通过，已停止后续操作。');
        setError(result.state === 'running' ? '' : result.reasons.map(reason => chatRuntimeReason(reason).text).join(' '));
        return;
      }
      await writeResource(api, '/api/chat/runtime/stop', {}, controller.signal);
      if (!current()) return;
      const next = parseChatRuntimeStatus(await readResource(api, '/api/chat/runtime', controller.signal));
      if (!current()) return;
      if (!next) throw new Error('invalid_chat_runtime');
      setStatus(next);
    } catch (failure) {
      if (current()) {
        if (sharedOwner) application.freeze();
        setError(`${errorMessage(failure)} 请重新检查状态，不会自动重复操作。`);
        setUncertain(true);
      }
    } finally {
      if (current()) setAction(null);
      if (request.current === controller) request.current = null;
      if (sharedOwner) application.release(sharedOwner);
      controller.signal.removeEventListener('abort', abort);
    }
  }

  async function restoreStoppedControls(): Promise<void> {
    const state = application.getSnapshot();
    if (!connected || repair.pending || request.current || restart.pending || state.busy || state.reconciling || state.kind !== 'manual'
      || state.manualSource !== 'runtime' || !state.blocked) return;
    const controller = new AbortController();
    const generation = epoch.current;
    request.current = controller;
    const current = () => !controller.signal.aborted && request.current === controller && epoch.current === generation
      && connection.current.api === api && connection.current.connected;
    setAction('restore'); setError('');
    try {
      const value = await api.get('/api/chat/runtime', controller.signal);
      if (!current()) return;
      const next = parseChatRuntimeStatus(value);
      if (!next || !chatRuntimeCanRecoverStoppedControl(value)) {
        setError('尚未确认聊天已停止并排空，保护仍保留；可重新恢复操作，不会重复启停。');
        return;
      }
      const proof = application.reviewManual('runtime');
      if (!proof || !application.acknowledgeManual(proof, 'runtime')) throw new Error('runtime_recovery_changed');
      setStatus(next); setUncertain(false); setNotice('已确认聊天停止且没有待排空操作，管理操作已恢复；会话记录保留。');
    } catch (failure) { if (current()) setError(`${errorMessage(failure)} 恢复入口仍可重试。`); }
    finally {
      if (request.current === controller) { request.current = null; setAction(null); }
    }
  }

  async function reconnectChat(): Promise<void> {
    if (!status || !running || active || dirty || request.current || applicationState.busy || applicationState.blocked) return;
    const controller = new AbortController();
    const generation = epoch.current;
    request.current = controller; setAction('reconnect'); setError(''); setNotice('');
    const current = () => epoch.current === generation && connection.current.api === api && !controller.signal.aborted;
    try {
      await writeResource(api, '/api/chat/runtime/reconnect', { revisions: status.revisions }, controller.signal);
      if (current()) { setNotice('已核验聊天连接；已有会话和历史保留，没有发送模型请求或重放旧操作。'); resource.refresh(); chain.refresh(); }
    } catch {
      if (current()) setError('聊天连接未能恢复。请查看下方诊断，可使用“一键恢复聊天”恢复受管服务；协议端登录需在协议端处理。原请求不会重发。');
    } finally {
      if (request.current === controller) request.current = null;
      if (current()) setAction(null);
    }
  }

  if (!connected) return null;
  const refreshControl = <Button variant="ghost" size="sm" disabled={active} onClick={() => { resource.refresh(); chain.refresh(); dshHealth.refresh(); refreshApplication(); }}><RefreshCw className="size-3.5" />刷新状态</Button>;
  const statusTone = health?.healthy && !resource.error ? 'success' : running || uncertain || resource.error || applicationState.blocked ? 'warning' : 'neutral';
  const statusLabel = repair.pending ? '正在恢复聊天' : active ? '正在处理' : resource.error ? '运行状态待确认' : chatHealthBadge(health, status);
  const interrupted = health ? chatHealthChecks(health).filter(layer => !['ready', 'idle', 'stopped'].includes(layer.state)) : [];
  const chainChecks = <div className="stack" data-chat-health>
    {health ? <dl className="info">{chatHealthChecks(health).map(layer => <div key={layer.id} className="contents"><dt>{chatHealthNames[layer.id]}</dt><dd><StatusPill tone={['ready', 'idle'].includes(layer.state) ? 'success' : layer.state === 'stopped' ? 'neutral' : 'warning'}>{chatHealthLayerLabel(layer)}</StatusPill></dd></div>)}</dl>
      : <p className="small muted">{chain.error ? '聊天链路诊断暂不可用。请刷新；若框架持续无响应，使用重启框架入口或运行机器上的命令。' : '正在分别检查收发接口与框架聊天链路。'}</p>}
    {interrupted.map(layer => <p key={layer.id} className="small" data-chat-health-guidance={layer.id}><strong>{chatHealthNames[layer.id]}：</strong>{chatHealthGuidance(layer)}</p>)}
  </div>;
  const controlButton = running || status?.state === 'error'
    ? <Button variant="outline" disabled={active || uncertain || restart.pending || loading || applicationState.busy || applicationState.blocked} onClick={() => void control('stop')}><Square className="size-3.5" />停止聊天</Button>
    : <span role="group" aria-label="启动聊天" data-page-field><Button id="chat-runtime-start" disabled={!status?.canStart && !applyBeforeStart || active || uncertain || restart.pending || dirty || loading || applicationState.busy || applicationState.blocked} onClick={() => void control('start')}><Play className="size-3.5" />{applyBeforeStart ? '应用并启动' : '启动聊天'}</Button></span>;
  const recovery = <>
    <ChatRepairControl api={api} connected={connected} compact />
    {applicationState.kind === 'manual' && applicationState.manualSource === 'runtime' && applicationState.blocked && <div className="strip warn stack" data-runtime-control-recovery><p>先前启停请求没有确认结果。恢复只读取实际停止与排空状态，不重复启停。</p><Button size="sm" variant="outline" className="justify-self-start" disabled={request.current !== null || restart.pending || applicationState.busy || applicationState.reconciling} onClick={() => void restoreStoppedControls()}>恢复操作</Button></div>}
    {applicationState.blocked && <p role="status" className="small muted">先前应用或启动结果尚未确认，后续操作暂时锁定；刷新只读取状态。</p>}
  </>;
  const checks = <>
    {chainChecks}
    <dl className="info"><dt>QQ 消息</dt><dd>{resource.error ? '读取失败' : status ? status.protocolConnected ? '已连接' : '未连接' : '尚未确认'}</dd><dt>DSH 服务</dt><dd><StatusPill tone={dshHealth.tone}>{dshHealth.label}</StatusPill></dd><dt>聊天处理</dt><dd>{resource.error ? '读取失败' : !status ? '尚未确认' : health?.healthy ? '已就绪' : running ? '等待链路恢复' : status.state === 'stopped' ? '已停止' : status.state === 'error' ? '启动或运行失败' : '正在处理'}</dd></dl>
    <p className="small muted">{dshHealth.description}</p>
    {visibleReasons.length > 0 && <ul className="stack">{visibleReasons.map(reason => {
      const item = chatRuntimeReason(reason);
      return <li key={reason} className="row"><span className="grow text-xs">{item.text}</span><Button variant="ghost" size="sm" onClick={() => navigate(item.page, item.target)}>去设置</Button></li>;
    })}</ul>}
  </>;
  const controlBody = <div className="stack">
        <div className="row"><StatusPill tone={statusTone}>{statusLabel}</StatusPill>{refreshControl}</div>
        {loading && <p role="status" className="row muted small"><LoaderCircle className="size-3.5 animate-spin" />正在检查聊天条件</p>}
        {checks}
        {status?.state === 'stopped' && chatRuntimeNeedsSessionMigration(status) && <SessionMigrationControl api={api} connected={connected} disabled={dirty || active || uncertain || loading} onComplete={() => resource.refresh()} />}
        <div className="strip">{running ? '停止接收新的聊天消息，保留已有聊天记录与发送证据。' : applyBeforeStart ? '将应用已保存的聊天设置并启动，原有上下文保留。' : '启动前核对连接与配置；实际模型请求通过 QQ 消息验证。'}</div>
        {dirty && <p className="small muted">请先保存连接设置。</p>}
        {notice && <p role="status" className="small muted">{notice}</p>}
        {error && <p role="alert" className="row text-xs text-destructive"><CircleAlert className="size-3.5 shrink-0" />{error}</p>}
        {recovery}<div className="actions border-t pt-2">{controlButton}{refreshControl}</div>
      </div>;
  if (compact) return controlBody;
  return <section id="chat-runtime" className="panel entity">
    <div className="row"><span className="avatar" aria-hidden="true">▷</span><div className="grow"><h2 className="panel-title">聊天运行</h2><p className="muted small">已授权的 QQ 会话</p></div><StatusPill tone={statusTone}>{statusLabel}</StatusPill></div>
    <div className="meta"><span>QQ 消息：{resource.error ? '读取失败' : status ? status.protocolConnected ? '已连接' : '未连接' : '待确认'}</span><span>DSH 服务：{dshHealth.label}</span></div>
    {chainChecks}
    <div className={`strip ${uncertain || applicationState.blocked || resource.error ? 'warn' : ''}`} role="status">{!status ? loading ? '正在读取聊天运行状态。' : '暂时无法确认聊天运行状态，请刷新读取。' : active ? '正在更新聊天运行状态，请等待原操作。' : dirty ? '连接草稿尚未保存；请保存后再启动聊天。' : uncertain || applicationState.blocked ? '启停结果尚未确认，可使用下方一键恢复聊天。' : status?.configurationChanged ? '有已保存设置等待应用，请查看详情中的具体运行条件。' : running ? health?.healthy ? '聊天链路检查通过；模型请求与实际送达以各会话的执行记录为准。' : interrupted.length > 0 ? '请按上方异常环节处理；恢复连接保留原会话，不重发旧请求。' : '框架进程正在运行，聊天链路仍待核对。' : status.state === 'error' ? '聊天运行需要处理，请查看详情。' : '聊天已停止；可检查条件后明确启动。'}</div>
    <div className="actions">
      <SettingsWindow title={running ? '停止聊天' : '启动与检查聊天'} label={running ? '停止聊天' : '启动聊天'} description="检查真实运行状态后执行；停止保留历史，启动沿当前配置继续。">{controlBody}</SettingsWindow>
      {refreshControl}
      <Button variant="outline" disabled={!running || active || dirty || applicationState.busy || applicationState.blocked} onClick={() => void reconnectChat()}><RefreshCw className="size-3.5" />重新连接聊天</Button>
      <FrameworkRestartControl api={api} />
      <ReadOnlyDetails title="聊天运行详情" description="运行条件、当前诊断与原操作证据。"><div className="stack">{checks}<TechnicalDetails fields={[{ label: '运行状态', value: statusLabel }, { label: '最近错误', value: status?.lastError ? chatRuntimeLastError(status.lastError, status) : '无' }, { label: '应用阶段', value: applicationState.phase ? chatApplicationPhaseLabels[applicationState.phase] : '无' }, { label: '操作编号', value: applicationState.operationId }, { label: '配置更新', value: status?.configurationChanged ?? '未知' }]} />{recovery}{connectionPanel}</div></ReadOnlyDetails>
    </div>
    <ChatRepairControl api={api} connected={connected} />
    {notice && <p role="status" className="small muted">{notice}</p>}
    {error && <p role="alert" className="text-xs leading-5 text-destructive">{error}</p>}
    {observationError && <p role="status" className="small muted">暂时无法读取应用操作，后台阶段不会重复执行，请刷新状态。</p>}
    {status?.lastError && <p role={status.chatReady ? "status" : "alert"} className={`text-xs ${status.chatReady ? "text-muted-foreground" : "text-destructive"}`}>{chatRuntimeLastError(status.lastError, status)}</p>}
    {(uncertain || applicationState.blocked) && <p className="small muted">可使用一键恢复聊天重新建立受管服务和聊天链路，具体原因与原操作记录保留在详情中。</p>}
  </section>;
}
