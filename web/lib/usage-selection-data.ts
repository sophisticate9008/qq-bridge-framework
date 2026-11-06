import { useEffect, useState } from 'react';
import type { ApiClient } from './api.ts';
import { errorMessage } from './api.ts';
import { parseUsageSnapshot, type UsageSnapshot } from './activity.ts';
import { parseUsageRecent, parseUsageSeries, type UsageRecent, type UsageSeries } from './usage-details.ts';

interface SelectionData {
  readonly scope: string;
  readonly summary: UsageSnapshot;
  readonly series: UsageSeries;
  readonly recent: UsageRecent;
}

/** Keep each response tied to its exact selection; cancelled reads cannot replace newer scopes. */
export function useUsageSelectionData(api: ApiClient, connected: boolean, keys: ReadonlySet<string>, hours: number, source: UsageSnapshot | null, refresh: number) {
  const query = [...keys].sort().join(',');
  const scope = `${hours}:${query}`;
  const [data, setData] = useState<SelectionData | null>(null);
  const [error, setError] = useState<{ scope: string; message: string } | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    setError(null);
    if (!connected || !query) { setData(null); setLoading(false); return; }
    const controller = new AbortController();
    setLoading(true);
    // Coalesce continuous drag updates into one bounded read after movement pauses.
    const timer = setTimeout(() => {
      void Promise.all([
        api.get(`/api/chat/usage?limit=200&ledgerKeys=${query}`, controller.signal),
        api.get(`/api/chat/usage/series?hours=${hours}&buckets=48&ledgerKeys=${query}`, controller.signal),
        api.get(`/api/chat/usage/recent?limit=40&ledgerKeys=${query}`, controller.signal),
      ]).then(([summaryValue, seriesValue, recentValue]) => {
        if (controller.signal.aborted) return;
        const summary = parseUsageSnapshot(summaryValue), series = parseUsageSeries(seriesValue), recent = parseUsageRecent(recentValue);
        if (!summary || !series || !recent || series.hours !== hours) throw new Error('所选会话统计返回了无法识别的内容');
        if (summary.conversations.some(item => !item.ledgerKey || !query.split(',').includes(item.ledgerKey))) {
          throw new Error('服务未正确应用会话筛选，请更新框架后重试');
        }
        setData({ scope, summary, series, recent });
      }).catch((reason: unknown) => {
        if (!controller.signal.aborted) setError({ scope, message: errorMessage(reason) });
      }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 150);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [api, connected, hours, query, scope, source, refresh]);
  return { data: data?.scope === scope ? data : null, loading, error: error?.scope === scope ? error.message : '' };
}
