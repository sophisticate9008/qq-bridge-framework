import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { parsePluginSessionModels } from '../../src/contracts/plugin-sessions.ts';
import { parseSessionModelConfiguration } from '../../src/contracts/session-model-configuration.ts';
import type { PluginModelSelection } from '../../src/contracts/plugin-model.ts';
import { ApiError, errorMessage, isRecord, type ApiClient } from '../lib/api.ts';
import { hasSessionResetTarget, type ManagedSession } from '../lib/session-management.ts';
import { useReadResource } from '../lib/use-read-resource.ts';
import { writeResource } from '../lib/resource-reader.ts';
import { Button } from './ui/button.tsx';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog.tsx';

const key = (model: PluginModelSelection) => JSON.stringify([model.provider, model.model]);
export function SessionModelDialog({ api, connected, target, onClose, onSaved }: {
  readonly api: ApiClient; readonly connected: boolean; readonly target: ManagedSession | null;
  readonly onClose: () => void; readonly onSaved: () => void;
}) {
  const models = useReadResource(api, '/api/chat/plugin-sessions/models', connected && target !== null, parsePluginSessionModels);
  const [choice, setChoice] = useState('');
  const [state, setState] = useState<'idle' | 'saving' | 'blocked'>('idle');
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    request.current?.abort(); request.current = null;
    setChoice(target?.modelConfiguration?.override ? key(target.modelConfiguration.override) : '');
    setState('idle'); setError('');
    return () => { request.current?.abort(); request.current = null; };
  }, [api, connected, target]);
  function close() { if (state === 'saving') return; if (state === 'blocked') onSaved(); onClose(); }
  async function save() {
    if (!target || !connected || !hasSessionResetTarget(target) || !target.modelConfiguration || request.current || state !== 'idle') return;
    const selected = models.snapshot?.find(model => key(model) === choice);
    if (choice && !selected) { setError('请选择当前可用的模型。'); return; }
    const controller = new AbortController(); request.current = controller; setState('saving'); setError('');
    try {
      const model = selected ? { provider: selected.provider, model: selected.model,
        ...((selected.reasoningEffort ?? (target.modelConfiguration.override && key(target.modelConfiguration.override) === key(selected) ? target.modelConfiguration.override.reasoningEffort : undefined)) ? { reasoningEffort: selected.reasoningEffort ?? target.modelConfiguration.override?.reasoningEffort } : {}) } : null;
      const result = await writeResource(api, '/api/chat/sessions/model', { key: target.key, sessionId: target.sessionId,
        generation: target.generation, bindingRevision: target.bindingRevision, confirm: true,
        modelRevision: target.modelConfiguration.revision, model }, controller.signal);
      if (request.current !== controller || controller.signal.aborted) return;
      if (!isRecord(result) || result.ok !== true || result.key !== target.key || result.sessionId !== target.sessionId
        || result.historyPreserved !== true || result.appliesTo !== 'next-request' || !parseSessionModelConfiguration(result.configuration))
        throw new ApiError('session_model_unknown', 504);
      toast.success('已保存，下次处理消息生效，聊天历史保留'); onSaved(); onClose();
    } catch (failure) {
      if (request.current !== controller || controller.signal.aborted) return;
      const code = failure instanceof ApiError ? failure.code : '';
      setState(failure instanceof ApiError && failure.status >= 400 && failure.status < 409 ? 'idle' : 'blocked');
      setError(/busy|unsettled/.test(code) ? '会话正在处理消息或有待核对的执行，请结束后刷新再调整。'
        : /conflict/.test(code) ? '会话设置已变化，请关闭并刷新后重新选择。'
        : /unavailable/.test(code) ? '所选模型当前不可用，请重新读取模型目录。' : `暂时无法确认保存结果，请关闭并刷新核对。${errorMessage(failure)}`);
    } finally { if (request.current === controller) request.current = null; }
  }
  const configuration = target?.modelConfiguration;
  const applied = configuration?.lastApplied;
  const appliedDescriptor = applied && models.snapshot?.find(model => model.provider === applied.model.provider && model.model === applied.model.model);
  return <Dialog open={target !== null} onOpenChange={open => { if (!open) close(); }}><DialogContent showCloseButton={state !== 'saving'}>
    <DialogHeader><DialogTitle>调整会话模型</DialogTitle><DialogDescription>选择这条 QQ 会话后续消息使用的供应商和模型，保留当前对话与历史。</DialogDescription></DialogHeader>
    <div className="grid gap-3 text-xs"><p>{target?.key}</p><p className="text-muted-foreground">当前设置：{configuration?.providerName} / {configuration?.modelName} · {configuration?.override ? '本会话指定' : `跟随聊天方案「${configuration?.planName}」`}</p>
      <p className="text-muted-foreground">最近应用：{applied ? `${appliedDescriptor?.providerName ?? applied.model.provider} / ${appliedDescriptor?.modelName ?? applied.model.model}` : '尚无应用记录'}</p><label className="grid gap-1">供应商与模型<select aria-label="会话供应商与模型" className="h-8 rounded border border-input bg-background px-2" value={choice} disabled={state !== 'idle' || models.loading || Boolean(models.error)} onChange={event => setChoice(event.target.value)}>
        <option value="">跟随聊天方案（恢复默认）</option>{models.snapshot?.map(model => <option key={key(model)} value={key(model)}>{model.providerName} / {model.modelName}{model.reasoningEffort ? ` · ${model.reasoningEffort}` : ''}</option>)}
      </select></label><p className="text-muted-foreground">保存后从下次处理消息开始使用。其他会话继续使用各自的设置。</p>
      {models.loading && <p>正在读取模型…</p>}{models.error && <p role="alert" className="text-destructive">模型目录读取失败。<Button variant="ghost" size="sm" onClick={models.refresh}>重新读取</Button></p>}
      {error && <p role="alert" className="text-destructive">{error}</p>}</div>
    <DialogFooter><Button variant="outline" disabled={state === 'saving'} onClick={close}>{state === 'blocked' ? '关闭并刷新' : '取消'}</Button><Button disabled={state !== 'idle' || !connected || !configuration || models.loading || Boolean(models.error)} onClick={() => void save()}>{state === 'saving' ? '正在保存' : '保存模型设置'}</Button></DialogFooter>
  </DialogContent></Dialog>;
}
