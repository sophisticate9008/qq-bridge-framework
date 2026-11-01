import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Popover } from '@base-ui/react/popover'
import { Button } from './ui/button.tsx'

function OriginalImage({ url, label }: { readonly url: string; readonly label: string }) {
  const [loaded, setLoaded] = useState(false), [failed, setFailed] = useState(false), [attempt, setAttempt] = useState(0)
  return <div className="grid min-h-32 place-items-center rounded bg-muted/40">
    {!loaded && !failed && <p role="status" className="p-4 text-xs text-muted-foreground">正在读取原图…</p>}
    {failed ? <div className="grid justify-items-center gap-2 p-4 text-xs text-muted-foreground"><p>原图暂不可用</p>
      <Button size="sm" variant="outline" onClick={() => { setFailed(false); setLoaded(false); setAttempt(value => value + 1) }}>重试原图</Button></div>
      : <img key={attempt} src={url} alt={label} decoding="async" onLoad={() => setLoaded(true)} onError={() => setFailed(true)}
        className={`max-h-[65dvh] max-w-full object-contain ${loaded ? '' : 'hidden'}`} />}
  </div>
}

/** The original is mounted only while open. No Blob URL or completed-image cache is retained. */
export function StickerOriginalViewer({ id, label, active, open, onOpenChange, children }: {
  readonly id: string; readonly label: string; readonly active: boolean; readonly open: boolean
  readonly onOpenChange: (id: string, open: boolean) => void; readonly children: ReactNode
}) {
  const triggerId = useId(), popup = useRef<HTMLDivElement>(null)
  const shown = open && active
  const url = `/api/chat/stickers/original?id=${encodeURIComponent(id)}`
  useEffect(() => { if (!active && open) onOpenChange(id, false) }, [active, open, id, onOpenChange])
  useEffect(() => {
    if (!shown) return
    const close = () => onOpenChange(id, false)
    const scroll = (event: Event) => {
      if (event.target instanceof Node && popup.current?.contains(event.target)) return
      close()
    }
    window.addEventListener('scroll', scroll, true)
    window.addEventListener('blur', close)
    document.addEventListener('visibilitychange', close)
    return () => {
      window.removeEventListener('scroll', scroll, true)
      window.removeEventListener('blur', close)
      document.removeEventListener('visibilitychange', close)
    }
  }, [shown, id, onOpenChange])
  return <Popover.Root open={shown} onOpenChange={next => onOpenChange(id, next)} triggerId={triggerId} modal={false}>
    <div className="relative">
      {children}
      <Popover.Trigger id={triggerId} type="button" openOnHover delay={500} closeDelay={150} disabled={!active}
        aria-label={`查看原图：${label}`} title="悬停半秒或点击查看原图"
        className="absolute inset-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none">
        <span className="absolute left-1 top-1 rounded bg-background/90 px-1.5 py-0.5 text-[10px] text-muted-foreground">原图</span>
      </Popover.Trigger>
    </div>
    <Popover.Portal><Popover.Positioner side="right" align="center" sideOffset={8} collisionPadding={12} className="z-[85]">
      <Popover.Popup ref={popup} initialFocus={false} finalFocus={false}
        className="grid max-h-[85dvh] w-max max-w-[min(80vw,720px)] gap-2 overflow-auto overscroll-contain rounded-lg border bg-popover p-3 text-popover-foreground shadow-lg outline-none">
        <div className="flex items-center justify-between gap-4">
          <Popover.Title className="text-sm font-medium">原图</Popover.Title>
          <Popover.Close render={<Button type="button" size="sm" variant="ghost" className="h-6 px-2 text-xs" />}>关闭</Popover.Close>
        </div>
        <Popover.Description className="sr-only">查看完整图片，GIF 按原始动画播放。</Popover.Description>
        {shown && <OriginalImage url={url} label={label} />}
        <a href={url} target="_blank" rel="noopener noreferrer" className="justify-self-end text-xs underline underline-offset-2">新窗口查看原图</a>
      </Popover.Popup>
    </Popover.Positioner></Popover.Portal>
  </Popover.Root>
}
