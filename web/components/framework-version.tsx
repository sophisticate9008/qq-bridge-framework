import { useEffect, useId, useRef, useState } from 'react';
import { Popover } from '@base-ui/react/popover';
import { ArrowUpRight, Check, CircleHelp, ExternalLink, RefreshCw, X } from 'lucide-react';
import { createPortal } from 'react-dom';
import { useSidebar } from './ui/sidebar.tsx';
import { parseFrameworkReleaseStatus, type FrameworkReleaseStatus } from '../../src/contracts/framework-release.ts';
import { parseFrameworkUpdateState, type FrameworkUpdateState } from '../../src/contracts/framework-update.ts';
import { asRecord, errorMessage, type ApiClient } from '../lib/api.ts';
import { Button } from './ui/button.tsx';

// Keep requests and update state mounted even when the mobile navigation is closed.
export function FrameworkVersion({ api, connected, triggerContainer }: { readonly api: ApiClient; readonly connected: boolean; readonly triggerContainer: HTMLElement | null }) {
  const { isMobile, openMobile, state: sidebarState } = useSidebar();
  const triggerId = useId();
  const [status, setStatus] = useState<FrameworkReleaseStatus | null>(null);
  const [checkFailed, setCheckFailed] = useState(false);
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [updateAvailable, setUpdateAvailable] = useState(false), [update, setUpdate] = useState<FrameworkUpdateState | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const requestedId = useRef<string | null>(null);
  useEffect(() => {
    if (!connected || !triggerContainer || (isMobile ? !openMobile : sidebarState === 'collapsed')) setOpen(false);
  }, [connected, triggerContainer, isMobile, openMobile, sidebarState]);
  useEffect(() => {
    if (!connected) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function read() {
      try {
        const value = asRecord(await api.get('/api/framework/update', controller.signal));
        if (controller.signal.aborted) return;
        setUpdateAvailable(value.available === true);
        const operation = parseFrameworkUpdateState(value.operation);
        setUpdate(operation);
        if (operation && (!requestedId.current || operation.id === requestedId.current)
          && ['completed', 'failed', 'rolled-back'].includes(operation.state)) setSubmitted(false);
      } catch { /* During restart the original operation remains visible and POST is never retried. */ }
      if (!controller.signal.aborted && open) timer = setTimeout(() => void read(), 3000);
    }
    void read();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [api, connected, open]);
  async function install() {
    if (!status?.latestVersion || submitted) return;
    setSubmitted(true); setError('');
    requestedId.current = crypto.randomUUID();
    try {
      const value = asRecord(await api.post('/api/framework/update', { operationId: requestedId.current, version: status.latestVersion }));
      const operation = parseFrameworkUpdateState(value.operation);
      if (operation) setUpdate(operation);
      else setError('更新受理结果待核对，请等待状态刷新。');
    } catch (failure) { setError(`${errorMessage(failure)} 正在核对原更新状态，请勿重复提交。`); }
  }
  const updateLabels: Record<FrameworkUpdateState['state'], string> = { preparing: '下载、校验并安装新包依赖', ready: '等待框架停止后更新',
    applying: '备份并替换程序', verifying: '核对新版本启动', completed: '更新完成，请刷新页面', failed: '更新未完成，原版本保留', 'rolled-back': '启动未通过，已恢复原程序' };
  const updating = submitted || !!update && !['completed', 'failed', 'rolled-back'].includes(update.state);
  useEffect(() => {
    if (!connected) { setStatus(null); setCheckFailed(false); return; }
    const controller = new AbortController();
    void api.get('/api/framework/version', controller.signal).then(value => {
      const parsed = parseFrameworkReleaseStatus(value);
      if (!parsed) throw new Error('invalid_version_response');
      if (!controller.signal.aborted) { setStatus(parsed); setCheckFailed(false); }
    }).catch(() => { if (!controller.signal.aborted) setCheckFailed(true); });
    return () => controller.abort();
  }, [api, connected]);
  async function check() {
    setBusy(true); setError('');
    try {
      const parsed = parseFrameworkReleaseStatus(await api.get('/api/framework/version?refresh=1'));
      if (!parsed) throw new Error('invalid_version_response');
      setStatus(parsed); setCheckFailed(false);
    } catch (failure) { setCheckFailed(true); setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }
  const indicator = !connected || busy || checkFailed || !status || status.state === 'unavailable'
    ? 'unknown' : status.state === 'available' ? 'available' : 'current';
  const indicatorLabel = !connected ? '未连接，更新状态未知' : busy ? '正在检查更新'
    : checkFailed || status?.state === 'unavailable' ? '检查失败，更新状态未知；点击查看并重试'
      : !status ? '正在读取版本' : status.state === 'available' ? `有新版本 v${status.latestVersion}`
        : status.state === 'ahead' ? '暂无更新，当前运行版本高于最新正式发行版本' : '暂无更新，当前已是最新正式版本';
  const StateIcon = indicator === 'available' ? ArrowUpRight : indicator === 'current' ? Check : CircleHelp;
  return <Popover.Root open={open} onOpenChange={setOpen} triggerId={triggerId} modal={false}>
    {triggerContainer && createPortal(<Popover.Trigger id={triggerId} render={<Button variant="ghost" size="sm" />} disabled={!connected} aria-label="框架版本与更新" aria-describedby="framework-version-state" title={indicatorLabel} className="h-5 gap-1.5 rounded-md bg-muted/70 px-1.5 text-xs text-muted-foreground tabular-nums hover:bg-muted">
      {status ? `v${status.currentVersion}` : '版本'}
      <span id="framework-version-state" className="sr-only">{indicatorLabel}</span>
      {indicator !== 'current' && <span aria-hidden="true" data-version-indicator={indicator} className={`size-1.5 shrink-0 rounded-full bg-current ${indicator === 'available' ? 'text-amber-400' : 'text-muted-foreground/50'}`} />}
    </Popover.Trigger>, triggerContainer)}
    <Popover.Portal container={isMobile ? triggerContainer : undefined}>
      <Popover.Positioner side="bottom" align="start" sideOffset={8} collisionPadding={12} className="z-[80]">
        <Popover.Popup data-framework-version-popover className="w-72 max-w-[calc(100vw-1.5rem)] max-h-[calc(100dvh-1.5rem)] overflow-y-auto rounded-xl border bg-popover text-popover-foreground shadow-xl outline-none">
          <Popover.Title className="sr-only">框架版本与更新</Popover.Title>
          <Popover.Description className="sr-only">查看运行版本和 GitHub 正式发行版本。</Popover.Description>
          <div className="flex items-center justify-between border-b px-4 py-2.5">
            <span className="text-xs text-muted-foreground">当前版本</span>
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="icon" disabled={busy} onClick={() => void check()} aria-label="主动检查更新" title="主动检查更新"><RefreshCw className={busy ? 'size-3.5 animate-spin' : 'size-3.5'} /></Button>
              <Popover.Close render={<Button variant="ghost" size="icon" />} aria-label="关闭"><X className="size-3.5" /></Popover.Close>
            </div>
          </div>
          <div className="grid justify-items-center gap-2 px-4 py-4 text-center">
            <div className="flex items-center gap-2"><strong className="text-xl font-semibold tabular-nums">{status ? `v${status.currentVersion}` : '待读取'}</strong><span className={`flex size-5 items-center justify-center rounded-full ${indicator === 'available' ? 'bg-amber-500/10 text-amber-500' : indicator === 'current' ? 'bg-green-500/10 text-green-500' : 'bg-muted text-muted-foreground'}`}><StateIcon className="size-3" /></span></div>
            <p className="text-xs leading-5 text-muted-foreground" role="status">{indicatorLabel}</p>
            {status?.latestVersion && status.latestVersion !== status.currentVersion && <p className="text-xs text-muted-foreground">最新发行：v{status.latestVersion}</p>}
            {error && <p className="text-xs leading-5 text-destructive" role="alert">{error}</p>}
            {status?.majorUpgrade && <p className="text-xs leading-5 text-amber-600 dark:text-amber-400">此更新跨越主版本，请先阅读迁移说明并备份数据。</p>}
            {update && <p className="text-xs leading-5" role="status">更新 v{update.version}：{updateLabels[update.state]}</p>}
            {updateAvailable && status?.state === 'available' && !status.majorUpgrade && <Button disabled={updating} onClick={() => void install()}>{updating ? '更新处理中' : '更新框架'}</Button>}
            {status && <a className="mt-1 inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground" href={status.releaseUrl} target="_blank" rel="noreferrer" aria-label="查看发行说明与下载"><ExternalLink className="size-3.5" />查看发布</a>}
          </div>
          <details className="border-t px-4 py-3 text-xs text-muted-foreground">
            <summary className="cursor-pointer">更新方式</summary>
            <div className="mt-2 grid gap-2 leading-5">
              <p>{status?.installation === 'docker' ? 'Docker 使用新镜像重新创建容器，继续挂载原数据卷。'
                : status?.installation === 'source' ? '当前为源码安装，请使用 Git 更新并执行依赖安装与构建。'
                  : '完整发行包支持覆盖程序文件并保留 runtime、private 及自定义文件。更新前停止框架并备份数据。'}</p>
              {status?.installation === 'archive' && <p>{updateAvailable
                ? '点击更新后会下载并校验新包，短暂停止框架后替换程序；配置、会话和私人扩展保留，启动失败自动回滚程序。'
                : '使用 npm run cli -- serve 启动完整发行包后可在此更新；也可停止框架后执行 npm run cli -- update /解压后的新包目录。'}</p>}
            </div>
          </details>
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  </Popover.Root>;
}
