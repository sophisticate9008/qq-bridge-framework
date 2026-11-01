import { useEffect, useId, useRef, useState } from 'react'
import { parseStickerLibraryAnnotationUpdate, parseStickerLibraryAnnotationUpdateResult, parseStickerLibrarySnapshot,
  type StickerLibraryAnnotation, type StickerLibraryAnnotationUpdate, type StickerLibraryIdentity,
  type StickerLibraryItem, type StickerLibrarySnapshot } from '../../src/contracts/sticker-library.ts'
import { ApiError, errorMessage, type ApiClient } from '../lib/api.ts'
import { Button } from './ui/button.tsx'
import { Input } from './ui/input.tsx'
import { Textarea } from './ui/textarea.tsx'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog.tsx'

interface StickerAnnotationEditorProps {
  readonly api: ApiClient
  readonly item: StickerLibraryItem | null
  readonly onClose: () => void
  readonly onSaved: (snapshot?: StickerLibrarySnapshot) => void
}
interface Draft {
  readonly description: string; readonly tags: string; readonly avoid: string
  readonly emotions: string; readonly actions: string; readonly intents: string; readonly scenes: string; readonly visibleText: string
  readonly colors: string; readonly styles: string; readonly entities: string
  readonly character: string; readonly aliases: string; readonly identityEdited: boolean
}
type FieldName = Exclude<keyof Draft, 'identityEdited'>
interface Field { readonly name: FieldName; readonly label: string; readonly length: number; readonly count?: number; readonly multiline?: boolean }
const meaningFields: readonly Field[] = [
  { name: 'description', label: '描述', length: 240, multiline: true }, { name: 'tags', label: '检索标签', count: 12, length: 24 },
  { name: 'emotions', label: '情绪', count: 4, length: 24 }, { name: 'actions', label: '动作', count: 4, length: 24 },
  { name: 'intents', label: '用途', count: 4, length: 24 }, { name: 'scenes', label: '场景', count: 3, length: 24 },
  { name: 'visibleText', label: '图中文字', length: 160, multiline: true }, { name: 'avoid', label: '不适用语境', length: 128, multiline: true },
]
const appearanceFields: readonly Field[] = [
  { name: 'colors', label: '颜色', count: 8, length: 24 }, { name: 'styles', label: '画风', count: 4, length: 24 },
  { name: 'entities', label: '可见元素', count: 8, length: 24 },
]
const roleFields: readonly Field[] = [{ name: 'character', label: '角色名', length: 64 }, { name: 'aliases', label: '角色别名', count: 8, length: 64 }]
const clients = new WeakMap<ApiClient, { readonly key: number; readonly pending: Map<string, StickerLibraryAnnotationUpdate>;
  readonly drafts: Map<string, { readonly base: StickerLibraryItem; readonly draft: Draft }> }>()
let nextClient = 0
function clientState(api: ApiClient) {
  let state = clients.get(api)
  if (!state) { state = { key: ++nextClient, pending: new Map(), drafts: new Map() }; clients.set(api, state) }
  return state
}
const normalizedName = (value: string): string => value.normalize('NFKC').toLocaleLowerCase().replace(/[\s_]+/g, ' ').trim()
const sources = { model: '模型推测', user: '用户确认', web: '网页依据' } as const
function annotationFromItem(item: StickerLibraryItem): StickerLibraryAnnotation {
  return { description: item.description, tags: item.tags, avoid: item.avoid,
    facets: item.facets ?? { emotions: [], actions: [], intents: [], scenes: [], visibleText: '' },
    visual: item.visual ?? { colors: [], styles: [], entities: [] } }
}
function makeDraft(annotation: StickerLibraryAnnotation, identity: { readonly character: string; readonly aliases: readonly string[] } | null | undefined, identityEdited = false): Draft {
  return { description: annotation.description, tags: annotation.tags.join('，'), avoid: annotation.avoid,
    emotions: annotation.facets.emotions.join('，'), actions: annotation.facets.actions.join('，'), intents: annotation.facets.intents.join('，'),
    scenes: annotation.facets.scenes.join('，'), visibleText: annotation.facets.visibleText,
    colors: annotation.visual.colors.join('，'), styles: annotation.visual.styles.join('，'), entities: annotation.visual.entities.join('，'),
    character: identity?.character ?? '', aliases: identity?.aliases.join('，') ?? '', identityEdited }
}
function sameIdentity(actual: StickerLibraryIdentity | null | undefined, expected: StickerLibraryAnnotationUpdate['identity']): boolean {
  if (expected === undefined) return true
  if (expected === null) return !actual
  return actual?.source === 'user' && normalizedName(actual.character) === normalizedName(expected.character)
    && actual.aliases.length === expected.aliases.length
    && actual.aliases.every(alias => expected.aliases.some(value => normalizedName(value) === normalizedName(alias)))
}
function sameAnnotation(actual: StickerLibraryAnnotation, expected: StickerLibraryAnnotation): boolean {
  // Response property order cannot make a confirmed write look unknown.
  const sameList = (left: readonly string[], right: readonly string[]) => left.length === right.length && left.every((value, index) => value === right[index])
  return actual.description === expected.description && actual.avoid === expected.avoid && sameList(actual.tags, expected.tags)
    && actual.facets.visibleText === expected.facets.visibleText
    && (['emotions', 'actions', 'intents', 'scenes'] as const).every(key => sameList(actual.facets[key], expected.facets[key]))
    && (['colors', 'styles', 'entities'] as const).every(key => sameList(actual.visual[key], expected.visual[key]))
}

export function StickerAnnotationEditor(props: StickerAnnotationEditorProps) {
  if (!props.item) return null
  return <AnnotationEditor key={`${clientState(props.api).key}:${props.item.id}`} {...props} item={props.item} />
}
function AnnotationEditor({ api, item, onClose, onSaved }: Omit<StickerAnnotationEditorProps, 'item'> & { readonly item: StickerLibraryItem }) {
  const state = clientState(api), previous = state.pending.get(item.id), savedDraft = state.drafts.get(item.id)
  const [base, setBase] = useState(savedDraft?.base ?? item)
  const [draft, setDraft] = useState<Draft>(() => savedDraft?.draft ?? makeDraft(previous?.annotation ?? annotationFromItem(item),
    previous && previous.identity !== undefined ? previous.identity : item.identity, previous?.identity !== undefined))
  const [phase, setPhase] = useState<'idle' | 'saving' | 'reading'>('idle')
  const [blocked, setBlocked] = useState(previous !== undefined), [missing, setMissing] = useState(false)
  const [errors, setErrors] = useState<Partial<Record<FieldName, string>>>({})
  const [error, setError] = useState(''), [message, setMessage] = useState('')
  const request = useRef<AbortController | null>(null), finished = useRef(false)
  const id = useId(), busy = phase !== 'idle', stale = item.revision > base.revision
  useEffect(() => () => { request.current?.abort() }, [])
  useEffect(() => {
    if (finished.current) return
    state.drafts.delete(item.id); state.drafts.set(item.id, { base, draft })
    while (state.drafts.size > 64) state.drafts.delete(state.drafts.keys().next().value!)
  }, [base, draft, item.id, state])
  function complete(snapshot?: StickerLibrarySnapshot) {
    finished.current = true; state.pending.delete(item.id); state.drafts.delete(item.id); onSaved(snapshot); onClose()
  }
  function change(name: FieldName, value: string) {
    setDraft(current => ({ ...current, [name]: value, identityEdited: current.identityEdited || name === 'character' || name === 'aliases' }))
    setErrors(current => ({ ...current, [name]: undefined }))
  }

  async function refresh() {
    if (request.current) return
    const controller = new AbortController(); request.current = controller
    setPhase('reading'); setError(''); setMessage('')
    try {
      const snapshot = parseStickerLibrarySnapshot(await api.get('/api/chat/stickers/library', controller.signal))
      if (controller.signal.aborted) return
      if (!snapshot) throw new ApiError('invalid_sticker_library_response', 503)
      const latest = snapshot.items.find(value => value.id === item.id)
      if (!latest) {
        setMissing(!snapshot.limited)
        setError(snapshot.limited ? '当前列表仅显示部分表情，尚未找到这张图，请稍后重新核对。' : '这张表情已不在库中，无法保存标注。')
        return
      }
      const unsettled = state.pending.get(item.id)
      const confirmed = unsettled && latest.revision > unsettled.revision && sameAnnotation(annotationFromItem(latest), unsettled.annotation)
        && sameIdentity(latest.identity, unsettled.identity)
      // A fresh local snapshot establishes the next CAS revision; it never replays a write.
      state.pending.delete(item.id)
      setBase(latest); setMissing(false); setBlocked(latest.state !== 'ready')
      if (confirmed) { complete(snapshot); return }
      setMessage(latest.state === 'ready' ? '已读取当前版本，草稿保持不变。请核对下方当前标注，再明确保存。' : '这张表情的状态仍待核对，请稍后刷新。')
    } catch (failure) { if (!controller.signal.aborted) setError(`读取失败，草稿已保留。${errorMessage(failure)}`) }
    finally { if (request.current === controller) request.current = null; if (!controller.signal.aborted) setPhase('idle') }
  }

  async function save() {
    if (request.current || blocked || stale || missing || base.state !== 'ready') return
    setError(''); setMessage('')
    const nextErrors: Partial<Record<FieldName, string>> = {}, lists = new Map<FieldName, readonly string[]>(), texts = new Map<FieldName, string>()
    for (const field of [...meaningFields, ...appearanceFields, ...roleFields]) {
      if (field.count) {
        const distinct = new Map<string, string>()
        for (const raw of draft[field.name].split(/[,，、;；\r\n]+/)) {
          const value = raw.trim(); if (!value) continue
          const key = field.name === 'aliases' ? normalizedName(value) : value.normalize('NFKC').toLocaleLowerCase()
          if (value.length > field.length || !key || /[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(value)) nextErrors[field.name] = `每项最多${field.length}字，不含不可见控制字符。`
          if (field.name !== 'aliases' || key !== normalizedName(draft.character)) distinct.set(key, value)
        }
        if (distinct.size > field.count) nextErrors[field.name] = `最多填写${field.count}项。`
        lists.set(field.name, [...distinct.values()])
      } else {
        const value = draft[field.name].trim().replace(/[\r\n]+/g, ' ')
        if (value.length > field.length || /[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(value)) nextErrors[field.name] = `最多${field.length}字，不含不可见控制字符。`
        texts.set(field.name, value)
      }
    }
    if (draft.identityEdited && !texts.get('character') && lists.get('aliases')?.length) nextErrors.character = '填写角色名，或一并清空角色别名。'
    if (texts.get('character') && !normalizedName(texts.get('character')!)) nextErrors.character = '请输入有效的角色名。'
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length) { setError('请检查标红的字段。'); return }
    const input = parseStickerLibraryAnnotationUpdate({ id: base.id, revision: base.revision,
      annotation: { description: texts.get('description')!, tags: lists.get('tags')!, avoid: texts.get('avoid')!,
        facets: { emotions: lists.get('emotions')!, actions: lists.get('actions')!, intents: lists.get('intents')!, scenes: lists.get('scenes')!, visibleText: texts.get('visibleText')! },
        visual: { colors: lists.get('colors')!, styles: lists.get('styles')!, entities: lists.get('entities')! } },
      ...(draft.identityEdited ? { identity: texts.get('character') ? { character: texts.get('character')!, aliases: lists.get('aliases')! } : null } : {}) })
    if (!input) { setError('请检查标注内容后再保存。'); return }
    if (!state.pending.has(item.id) && state.pending.size >= 64) { setError('仍有标注保存等待核对，请先逐项刷新核对。'); return }
    const controller = new AbortController(); request.current = controller
    state.pending.set(item.id, input); setPhase('saving')
    try {
      const result = parseStickerLibraryAnnotationUpdateResult(await api.post('/api/chat/stickers/annotation', input, controller.signal))
      if (controller.signal.aborted) return
      if (!result || result.id !== input.id || result.revision <= input.revision || !sameAnnotation(result.annotation, input.annotation) || !sameIdentity(result.identity, input.identity)) {
        throw new ApiError('sticker_annotation_result_unknown', 504)
      }
      complete()
    } catch (failure) {
      if (controller.signal.aborted) return
      if (failure instanceof ApiError && failure.status >= 400 && failure.status < 500 && failure.status !== 409) {
        state.pending.delete(item.id)
        if (failure.status === 404) { setMissing(true); setError('这张表情已不在库中，请刷新核对。') }
        else setError(errorMessage(failure))
      } else {
        setBlocked(true)
        setError(failure instanceof ApiError && failure.status === 409 ? '表情已在其他位置更新，草稿已保留，请先刷新核对。'
          : '保存结果尚未确认，草稿已保留。请先刷新核对，不会自动重试。')
      }
    } finally { if (request.current === controller) request.current = null; if (!controller.signal.aborted) setPhase('idle') }
  }

  function renderField(field: Field) {
    const help = errors[field.name] || (field.count ? `最多${field.count}项，每项${field.length}字；逗号分隔。` : `最多${field.length}字。`)
    const props = { id: `${id}-${field.name}`, value: draft[field.name], maxLength: field.count ? field.count * (field.length + 3) : field.length,
      disabled: busy || missing, 'aria-invalid': Boolean(errors[field.name]), 'aria-describedby': `${id}-${field.name}-help` }
    return <label key={field.name} htmlFor={props.id} className={`grid min-w-0 content-start gap-1 text-xs ${field.multiline ? 'sm:col-span-2' : ''}`}>
      {field.label}{field.multiline ? <Textarea {...props} className="h-16 resize-y" onChange={event => change(field.name, event.target.value)} />
        : <Input {...props} autoComplete="off" onChange={event => change(field.name, event.target.value)} />}
      <span id={`${id}-${field.name}-help`} className={errors[field.name] ? 'text-destructive' : 'text-muted-foreground'}>{help}</span>
    </label>
  }
  const currentDraft = makeDraft(annotationFromItem(base), base.identity)
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose() }}>
    <DialogContent showCloseButton={!busy} className="sm:max-w-[720px]">
      <form className="grid gap-4" onSubmit={event => { event.preventDefault(); void save() }}>
        <DialogHeader><DialogTitle>编辑表情标注</DialogTitle><DialogDescription>按这张图实际表达的含义填写。所有维度均可留空或清空；关闭后保留本次页面草稿。</DialogDescription></DialogHeader>
        {item.name && <p className="break-words text-xs text-muted-foreground">{item.name}</p>}
        <fieldset className="grid min-w-0 gap-3 sm:grid-cols-2"><legend className="mb-2 text-sm font-medium">表达与使用语境</legend>{meaningFields.map(renderField)}</fieldset>
        <fieldset className="grid min-w-0 gap-3 sm:grid-cols-2"><legend className="mb-2 text-sm font-medium">外观</legend>{appearanceFields.map(renderField)}</fieldset>
        <fieldset className="grid min-w-0 gap-3 sm:grid-cols-2"><legend className="mb-2 text-sm font-medium">角色与别名</legend>{roleFields.map(renderField)}
          <p className="text-xs text-muted-foreground sm:col-span-2">角色未编辑时保留原来源；手动修改记为用户确认。清空角色名与别名可移除角色标注。</p>
          <Button type="button" size="sm" variant="outline" className="w-fit" disabled={busy || missing} onClick={() => {
            setDraft(current => ({ ...current, character: '', aliases: '', identityEdited: true })); setErrors(current => ({ ...current, character: undefined, aliases: undefined }))
          }}>清空角色与别名</Button>
        </fieldset>
        <details className="min-w-0 rounded border p-2 text-xs"><summary className="cursor-pointer">当前保存的标注（供核对）</summary>
          <dl className="mt-2 grid gap-1">{[...meaningFields, ...appearanceFields, ...roleFields].map(field => <div key={field.name} className="flex min-w-0 gap-1 leading-5">
            <dt className="shrink-0 text-muted-foreground">{field.label}：</dt><dd className="min-w-0 break-words">{currentDraft[field.name] || '未填写'}</dd>
          </div>)}</dl>
          <p className="mt-2 text-muted-foreground">角色来源：{base.identity ? sources[base.identity.source] : '未标注'}</p>
        </details>
        {blocked && !error && <p role="status" className="text-xs">上次保存结果尚待核对，请先刷新当前标注。</p>}
        {stale && !blocked && <p role="status" className="text-xs">表情已更新，请刷新核对后继续保存。</p>}
        {error && <p role="alert" className="text-xs leading-5 text-destructive">{error}</p>}
        {message && <p role="status" className="text-xs leading-5 text-muted-foreground">{message}</p>}
        <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={onClose}>关闭</Button>
          <Button type="button" variant="outline" disabled={busy} onClick={() => void refresh()}>{phase === 'reading' ? '正在核对…' : '刷新核对'}</Button>
          <Button type="submit" disabled={busy || blocked || stale || missing || base.state !== 'ready'}>{phase === 'saving' ? '正在保存…' : '保存标注'}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
}
