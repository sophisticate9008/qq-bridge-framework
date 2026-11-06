import { useEffect, useRef, useState, type MouseEvent, type PointerEvent, type KeyboardEvent } from 'react';

type Mode = 'replace' | 'add' | 'remove';
interface Options {
  readonly keys: readonly string[];
  readonly selected: ReadonlySet<string>;
  readonly onChange: (keys: ReadonlySet<string>) => void;
  readonly disabled: boolean;
}
interface Gesture {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly baseline: ReadonlySet<string>;
  readonly mode: Mode;
  readonly keys: readonly string[];
  readonly element: HTMLElement;
  clientX: number;
  clientY: number;
  active: boolean;
}

export function useLedgerSelection(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const root = useRef<HTMLDivElement>(null);
  const anchor = useRef<string | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressClickUntil = useRef(0);
  const [box, setBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null);

  function select(key: string, event: { shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean }, checkbox: boolean) {
    const { keys, selected, onChange, disabled } = latest.current;
    if (disabled || !keys.includes(key)) return;
    const from = anchor.current === null ? -1 : keys.indexOf(anchor.current);
    const to = keys.indexOf(key);
    const range = event.shiftKey && from >= 0 ? keys.slice(Math.min(from, to), Math.max(from, to) + 1) : [key];
    const next = new Set(event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || checkbox ? selected : []);
    const remove = event.altKey || !event.shiftKey && (checkbox || event.ctrlKey || event.metaKey) && selected.has(key);
    for (const item of range) { if (remove) next.delete(item); else next.add(item); }
    if (!event.shiftKey) anchor.current = key;
    onChange(next);
  }

  useEffect(() => {
    let frame = 0;
    const clearTimer = () => { if (timer.current !== null) clearTimeout(timer.current); timer.current = null; };
    const finish = (cancel: boolean) => {
      clearTimer();
      const current = gesture.current;
      gesture.current = null;
      cancelAnimationFrame(frame);
      if (current?.active) {
        if (cancel) latest.current.onChange(current.baseline);
        suppressClickUntil.current = Date.now() + 400;
        if (current.element.hasPointerCapture(current.id)) current.element.releasePointerCapture(current.id);
      }
      setBox(null);
    };
    const paint = () => {
      const current = gesture.current;
      const viewport = root.current;
      if (!current?.active || !viewport) return;
      if (latest.current.disabled || current.keys.join(',') !== latest.current.keys.join(',')) { finish(true); return; }
      const bounds = viewport.getBoundingClientRect();
      const x = Math.max(bounds.left, Math.min(bounds.right, current.clientX)) - bounds.left + viewport.scrollLeft;
      const y = Math.max(bounds.top, Math.min(bounds.bottom, current.clientY)) - bounds.top + viewport.scrollTop;
      const left = Math.min(current.x, x), right = Math.max(current.x, x);
      const top = Math.min(current.y, y), bottom = Math.max(current.y, y);
      const hits: number[] = [];
      for (const row of viewport.querySelectorAll<HTMLElement>('[data-usage-ledger-key]')) {
        const rect = row.getBoundingClientRect();
        const rowTop = rect.top - bounds.top + viewport.scrollTop;
        const rowLeft = rect.left - bounds.left + viewport.scrollLeft;
        if (rowTop <= bottom && rowTop + rect.height >= top && rowLeft <= right && rowLeft + rect.width >= left) {
          const index = current.keys.indexOf(row.dataset.usageLedgerKey ?? '');
          if (index >= 0) hits.push(index);
        }
      }
      // Include rows that were scrolled out of the virtual DOM during this drag.
      const start = current.keys.indexOf(anchor.current ?? '');
      if (start >= 0 && hits.length > 0) hits.push(start);
      const selected = new Set(current.mode === 'replace' ? [] : current.baseline);
      if (hits.length > 0) for (const key of current.keys.slice(Math.min(...hits), Math.max(...hits) + 1)) {
        if (current.mode === 'remove') selected.delete(key); else selected.add(key);
      }
      if (selected.size !== latest.current.selected.size || [...selected].some(key => !latest.current.selected.has(key))) latest.current.onChange(selected);
      const screenLeft = Math.max(bounds.left, left + bounds.left - viewport.scrollLeft);
      const screenTop = Math.max(bounds.top, top + bounds.top - viewport.scrollTop);
      setBox({ left: screenLeft, top: screenTop,
        width: Math.max(1, Math.min(bounds.right, right + bounds.left - viewport.scrollLeft) - screenLeft),
        height: Math.max(1, Math.min(bounds.bottom, bottom + bounds.top - viewport.scrollTop) - screenTop) });
      if (current.clientY < bounds.top + 28) viewport.scrollTop -= 12;
      else if (current.clientY > bounds.bottom - 28) viewport.scrollTop += 12;
      frame = requestAnimationFrame(paint);
    };
    const move = (event: globalThis.PointerEvent) => {
      const current = gesture.current;
      if (!current || current.id !== event.pointerId) return;
      current.clientX = event.clientX;
      current.clientY = event.clientY;
      if (current.active) event.preventDefault();
      else {
        const bounds = root.current?.getBoundingClientRect();
        if (bounds && Math.hypot(event.clientX - (current.x + bounds.left - current.element.scrollLeft),
          event.clientY - (current.y + bounds.top - current.element.scrollTop)) > 8) finish(false);
      }
    };
    const start = () => {
      const current = gesture.current;
      if (!current || latest.current.disabled) { finish(false); return; }
      current.active = true;
      current.element.setPointerCapture(current.id);
      document.getSelection()?.removeAllRanges();
      paint();
    };
    const down = (event: globalThis.PointerEvent) => {
      if (gesture.current?.id !== event.pointerId) return;
      clearTimer(); timer.current = setTimeout(start, 400);
    };
    const up = (event: globalThis.PointerEvent) => { if (gesture.current?.id === event.pointerId) finish(event.type === 'pointercancel'); };
    const key = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape' && gesture.current) { event.preventDefault(); finish(true); } };
    const touch = (event: TouchEvent) => { if (gesture.current?.active) event.preventDefault(); };
    const blur = () => finish(true);
    document.addEventListener('pointerdown', down);
    document.addEventListener('pointermove', move, { passive: false });
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
    document.addEventListener('keydown', key);
    document.addEventListener('touchmove', touch, { passive: false });
    window.addEventListener('blur', blur);
    return () => {
      clearTimer(); cancelAnimationFrame(frame); gesture.current = null;
      document.removeEventListener('pointerdown', down);
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', up);
      document.removeEventListener('keydown', key);
      document.removeEventListener('touchmove', touch);
      window.removeEventListener('blur', blur);
    };
  }, []);

  return { root, box,
    onPointerDown(event: PointerEvent<HTMLDivElement>) {
      suppressClickUntil.current = 0;
      if (options.disabled || event.button !== 0 || !(event.target instanceof HTMLElement)) return;
      const row = event.target.closest<HTMLElement>('[data-usage-ledger-key]');
      if (!row || event.target.closest('button, a, select, textarea')) return;
      const key = row.dataset.usageLedgerKey ?? '';
      if (!options.keys.includes(key)) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      anchor.current = event.shiftKey ? anchor.current : key;
      gesture.current = { id: event.pointerId, x: event.clientX - bounds.left + event.currentTarget.scrollLeft,
        y: event.clientY - bounds.top + event.currentTarget.scrollTop, clientX: event.clientX, clientY: event.clientY,
        baseline: options.selected, mode: event.altKey ? 'remove' : event.ctrlKey || event.metaKey ? 'add' : 'replace',
        keys: options.keys, active: false, element: event.currentTarget };
    },
    onClickCapture(event: MouseEvent<HTMLDivElement>) {
      if (event.detail > 0 && Date.now() < suppressClickUntil.current) { event.preventDefault(); event.stopPropagation(); return; }
      if (!(event.target instanceof HTMLElement)) return;
      const row = event.target.closest<HTMLElement>('[data-usage-ledger-key]');
      if (!row) return;
      const checkbox = event.target instanceof HTMLInputElement && event.target.type === 'checkbox';
      const modifiedName = (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey)
        && event.target.closest('[data-usage-selectable-name]');
      if (!checkbox && !modifiedName && event.target.closest('button, a, input, select, textarea')) return;
      if (modifiedName) event.preventDefault();
      event.stopPropagation();
      select(row.dataset.usageLedgerKey ?? '', event, checkbox);
    },
    onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
      if (options.disabled) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
        event.preventDefault(); options.onChange(new Set(options.keys));
      } else if (event.key === 'Escape' && !gesture.current) {
        event.preventDefault(); options.onChange(new Set());
      } else if (event.key === ' ' && event.target instanceof HTMLElement && event.target.matches('[data-usage-ledger-key]')) {
        event.preventDefault(); select(event.target.dataset.usageLedgerKey ?? '', event, true);
      }
    },
    onContextMenu(event: MouseEvent<HTMLDivElement>) { if (gesture.current?.active) event.preventDefault(); },
  };
}
