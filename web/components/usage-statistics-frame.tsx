import type { ReactNode } from 'react';

/** Card slots keep their geometry across loading, coverage and selection changes. */
export function UsageStatisticsFrame({ children, busy }: { readonly children: ReactNode; readonly busy: boolean }) {
  return <div data-usage-statistics aria-busy={busy} className="grid min-w-0 gap-2">{children}</div>;
}
