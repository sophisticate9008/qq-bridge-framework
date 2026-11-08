export const SERVICE_STOP_TIMEOUT_MS = 30_000;
export const SERVICE_START_TIMEOUT_MS = 90_000;

export interface ServiceLifecycleOptions {
  readonly action: 'start' | 'stop' | 'restart';
  readonly stopTargets: readonly string[];
  readonly startTargets: readonly string[];
  readonly stop: (id: string, deadline: number) => Promise<void>;
  readonly start: (id: string, deadline: number) => Promise<void>;
  readonly report: (message: string) => void;
}

/** Only confirmed stops may be restored; an uncertain stop must never create another instance. */
export async function runServiceLifecycle(options: ServiceLifecycleOptions): Promise<void> {
  const stopped = new Set<string>();
  if (options.action !== 'start') {
    try {
      for (const id of options.stopTargets) {
        await options.stop(id, Date.now() + SERVICE_STOP_TIMEOUT_MS);
        stopped.add(id);
      }
    } catch (error) {
      if (options.action === 'restart' && options.startTargets.some(id => stopped.has(id))) {
        options.report('重启停止阶段失败，正在恢复已确认停止的组件。');
        for (const id of options.startTargets) {
          if (!stopped.has(id)) continue;
          try { await options.start(id, Date.now() + SERVICE_START_TIMEOUT_MS); }
          catch { options.report(`${id} 恢复失败，请查看状态和日志。`); }
        }
      }
      throw error;
    }
  }
  if (options.action === 'stop') return;
  let failure: { error: unknown } | undefined;
  for (const id of options.startTargets) {
    try { await options.start(id, Date.now() + SERVICE_START_TIMEOUT_MS); }
    catch (error) {
      if (options.action !== 'restart') throw error;
      failure ??= { error };
      options.report(`${id} 启动失败，继续启动其他组件。`);
    }
  }
  if (failure) throw failure.error;
}

export function serviceLifecycleTimeout(stopCount: number, startCount: number): number {
  return Math.max(300_000, stopCount * SERVICE_STOP_TIMEOUT_MS + startCount * SERVICE_START_TIMEOUT_MS + 10_000);
}
