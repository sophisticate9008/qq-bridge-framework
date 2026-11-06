import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/** Keep the session list stationary as statistics change; remeasure for a new viewport width. */
export function UsageStatisticsFrame({ children, busy }: { readonly children: ReactNode; readonly busy: boolean }) {
  const content = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = content.current;
    if (!element) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      setSize(current => {
        const height = Math.abs(current.width - rect.width) > 1 ? rect.height : Math.max(current.height, rect.height);
        return current.width === rect.width && current.height === height ? current : { width: rect.width, height };
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return <div data-usage-statistics aria-busy={busy} className="min-w-0" style={{ minHeight: size.height || undefined }}>
    <div ref={content} className="grid min-w-0 gap-2">{children}</div>
  </div>;
}
