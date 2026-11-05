import { useEffect, useState } from 'react';
import { parseFrameworkReleaseStatus, type FrameworkReleaseStatus } from '../../src/contracts/framework-release.ts';
import { errorMessage, type ApiClient } from '../lib/api.ts';
import { Button } from './ui/button.tsx';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog.tsx';

export function FrameworkVersion({ api, connected }: { readonly api: ApiClient; readonly connected: boolean }) {
  const [status, setStatus] = useState<FrameworkReleaseStatus | null>(null);
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    if (!connected) { setStatus(null); return; }
    const controller = new AbortController();
    void api.get('/api/framework/version', controller.signal).then(value => {
      const parsed = parseFrameworkReleaseStatus(value);
      if (!controller.signal.aborted && parsed) setStatus(parsed);
    }).catch(() => undefined);
    return () => controller.abort();
  }, [api, connected]);
  async function check() {
    setBusy(true); setError('');
    try {
      const parsed = parseFrameworkReleaseStatus(await api.get('/api/framework/version?refresh=1'));
      if (!parsed) throw new Error('invalid_version_response');
      setStatus(parsed);
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }
  return <><Button variant="ghost" size="sm" disabled={!connected} onClick={() => setOpen(true)} aria-label="框架版本与更新" className="text-xs tabular-nums">
    {status ? `v${status.currentVersion}` : '版本'}{status?.state === 'available' && <span className="ml-1 size-1.5 rounded-full bg-primary" />}
  </Button><Dialog open={open} onOpenChange={setOpen}><DialogContent><DialogHeader><DialogTitle>框架版本与更新</DialogTitle><DialogDescription>查看运行版本和 GitHub 正式发行版本。</DialogDescription></DialogHeader>
    <div className="stack text-sm"><p>当前版本：{status ? `v${status.currentVersion}` : '待读取'}</p>
      <p>最新发行：{status?.latestVersion ? `v${status.latestVersion}` : '尚未获取'}</p>
      {status?.state === 'current' && <p>当前已是最新正式版本。</p>}
      {status?.state === 'ahead' && <p>当前运行版本高于最新正式发行版本。</p>}
      {status?.state === 'unavailable' && <p role="status">暂时无法检查更新。已显示的发行版本为上次成功检查结果。</p>}
      {status?.majorUpgrade && <p>此更新跨越主版本，请先阅读迁移说明并备份数据。</p>}
      <p className="text-muted-foreground">{status?.installation === 'docker' ? 'Docker 使用新镜像重新创建容器，继续挂载原数据卷。'
        : status?.installation === 'source' ? '当前为源码安装，请使用 Git 更新并执行依赖安装与构建。'
        : '完整发行包支持覆盖程序文件并保留 runtime、private 及自定义文件。更新前停止框架并备份数据。'}</p>
      {error && <p role="alert">{error}</p>}
      <div className="flex gap-2"><Button disabled={busy} onClick={() => void check()}>{busy ? '正在检查…' : '主动检查更新'}</Button>
        {status && <a className="inline-flex items-center underline" href={status.releaseUrl} target="_blank" rel="noreferrer">查看发行说明与下载</a>}</div>
    </div></DialogContent></Dialog></>;
}
