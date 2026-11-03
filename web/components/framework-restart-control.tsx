import { useState } from 'react';
import { RotateCw } from 'lucide-react';
import { asRecord, errorMessage, type ApiClient } from '../lib/api.ts';
import { Button } from './ui/button.tsx';
import { SettingsWindow } from './settings-window.tsx';

/** Reuses the server-selected framework maintenance operation; no external service command. */
export function FrameworkRestartControl({ api }: { readonly api: ApiClient }) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  async function restart(): Promise<void> {
    if (pending) return;
    setPending(true); setMessage('');
    let dispatched = false;
    try {
      const settings = asRecord(await api.get('/api/settings'));
      const admin = asRecord(settings.admin);
      if (asRecord(settings.capabilities).applyAdmin !== true || typeof admin.revision !== 'string') {
        setMessage('当前部署没有网页重启能力，请在运行机器执行下方命令。'); setPending(false); return;
      }
      dispatched = true;
      const result = asRecord(await api.post('/api/settings/apply', { target: 'admin', revision: admin.revision }));
      if (result.ok !== true || asRecord(result.application).accepted !== true) throw new Error('framework_restart_unverified');
      setMessage('框架重启已受理。请等待服务恢复后刷新页面；若提示登录，使用原管理令牌重新连接。');
    } catch (error) {
      if (!dispatched) setPending(false);
      setMessage(`${errorMessage(error)} 请先检查服务状态；结果未知时不要重复重启，可使用下方命令核对。`);
    }
  }
  return <SettingsWindow title="重启框架" label="重启框架" description="重新启动框架宿主，恢复自己的聊天连接。">
    <div className="stack"><p className="small">重启会短暂中断框架处理，保留配置、会话历史和执行记录。协议端和 DSH 继续由各自管理；结果未知的请求不会自动重发。</p>
      <div className="actions"><Button variant="outline" disabled={pending} onClick={() => void restart()}><RotateCw className="size-3.5" />{pending ? '等待框架恢复' : '确认重启框架'}</Button></div>
      {message && <p role="status" className="small">{message}</p>}
      <p className="small muted">网页无法连接或该入口不可用时，在框架运行机器执行：</p><code>qbf-cli service status</code><code>qbf-cli restart framework-admin</code>
    </div>
  </SettingsWindow>;
}
