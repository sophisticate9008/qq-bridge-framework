import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultTreeAdapter, parse, serialize, type DefaultTreeAdapterTypes } from 'parse5'
import { assert, FrameworkError, isRecord } from '../core/values.ts'
import { ensurePrivateDirectory } from '../storage/private-json.ts'
import { canonicalPathMatches } from '../storage/file-security.ts'
import type { MarkdownPngPage } from './markdown.ts'

export interface HtmlRenderer {
  render(request: { readonly html: string; readonly title?: string; readonly signal?: AbortSignal }): Promise<readonly MarkdownPngPage[]>
}
const upstream = '16ebc29363826d43917d2e3cb91d37f7d2156fdd'
function prepareHtml(source: string, title?: string): string {
  const document = parse(source, { scriptingEnabled: false })
  const element = (parent: DefaultTreeAdapterTypes.ParentNode, name: string) => parent.childNodes.find(
    (node): node is DefaultTreeAdapterTypes.Element => 'tagName' in node && node.tagName === name)
  const root = element(document, 'html')
  assert(root, 'NATIVE_HTML_LAYOUT_INVALID', 'An HTML document is required.')
  const head = element(root, 'head'), body = element(root, 'body')
  assert(head && body, 'NATIVE_HTML_LAYOUT_INVALID', 'The HTML document requires a body.')
  const prepend = (parent: DefaultTreeAdapterTypes.Element, child: DefaultTreeAdapterTypes.Element) => {
    if (parent.childNodes.length) defaultTreeAdapter.insertBefore(parent, child, parent.childNodes[0])
    else defaultTreeAdapter.appendChild(parent, child)
  }
  const style = defaultTreeAdapter.createElement('style', root.namespaceURI, [])
  defaultTreeAdapter.insertText(style, 'html{font-family:"WenQuanYi Micro Hei","Noto Sans Math","Noto Sans Symbols 2","Noto Sans";font-size:24px;color:#202b3b;background:#fff}body{margin:0;padding:24px}pre,code{font-family:"WenQuanYi Micro Hei Mono","Noto Sans",monospace}')
  prepend(head, style)
  if (title) {
    const heading = defaultTreeAdapter.createElement('h1', root.namespaceURI, [])
    defaultTreeAdapter.insertText(heading, title)
    prepend(body, heading)
  }
  return serialize(document)
}
export function createBuiltinHtmlRenderer(options: { readonly directory: string; readonly componentDirectory?: string }): HtmlRenderer {
  const target = `${process.platform}-${process.arch}`
  const component = resolve(options.componentDirectory ?? fileURLToPath(new URL(`../../assets/native/html-renderer/${target}/`, import.meta.url)))
  const temporaryRoot = resolve(options.directory, 'html-render-jobs')
  const fonts = ['wqy-microhei.ttc', 'NotoSansMath-Regular.ttf', 'NotoSansSymbols2-Regular.ttf', 'NotoSans-Regular.ttf']
    .map(name => fileURLToPath(new URL(`../../assets/fonts/${name}`, import.meta.url)))
  let pending = 0
  return Object.freeze<HtmlRenderer>({ async render(request) {
    assert(typeof request.html === 'string' && request.html.trim().length > 0 && request.html.length <= 32000
      && Buffer.byteLength(request.html) <= 65536 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(request.html)
      && (request.title === undefined || typeof request.title === 'string' && request.title.length <= 120),
    'NATIVE_HTML_INPUT_LIMIT', 'HTML requires bounded source and title.')
    request.signal?.throwIfAborted()
    assert(pending < 2, 'NATIVE_HTML_BACKPRESSURE', 'HTML rendering has reached its concurrent document limit.')
    pending++
    let temporary: string | undefined
    try {
      let metadata: unknown
      try { metadata = JSON.parse(await readFile(join(component, 'component.json'), 'utf8')) }
      catch { throw new FrameworkError('NATIVE_HTML_COMPONENT_MISSING', 'The HTML renderer component is missing; install the complete framework package.') }
      const binaryName = process.platform === 'win32' ? 'qbf-html-renderer.exe' : 'qbf-html-renderer'
      assert(isRecord(metadata) && metadata.schema === 1 && metadata.protocol === 1 && metadata.engine === 'blitz'
        && metadata.target === target && metadata.binary === binaryName && metadata.upstream === upstream
        && metadata.resourcePolicy === 'no-network-no-files-no-scripts' && typeof metadata.sha256 === 'string'
        && /^[a-f0-9]{64}$/.test(metadata.sha256), 'NATIVE_HTML_COMPONENT_INVALID', 'The HTML renderer component is incompatible.')
      const binary = join(component, binaryName)
      assert(canonicalPathMatches(await realpath(component), component.replace(/[\\/]$/, '')), 'NATIVE_HTML_COMPONENT_INVALID', 'A canonical component directory is required.')
      const info = await lstat(binary)
      assert(info.isFile() && !info.isSymbolicLink() && info.size <= 32 * 1024 * 1024
        && createHash('sha256').update(await readFile(binary)).digest('hex') === metadata.sha256,
      'NATIVE_HTML_COMPONENT_INVALID', 'The HTML renderer component failed its integrity check.')
      const html = prepareHtml(request.html, request.title)
      await ensurePrivateDirectory(temporaryRoot)
      temporary = await mkdtemp(join(temporaryRoot, 'job-'))
      const input = join(temporary, 'input.html'), output = join(temporary, 'output.png')
      await writeFile(input, html, { mode: 0o600, flag: 'wx', signal: request.signal })
      const childResult: unknown = await new Promise((resolve, reject) => {
        const child = spawn(binary, [input, output, '1080', ...fonts], { cwd: temporary, windowsHide: true,
          env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, LANG: 'C.UTF-8',
            TEMP: temporary, TMP: temporary, TMPDIR: temporary, RAYON_NUM_THREADS: '2' }, stdio: ['ignore', 'pipe', 'pipe'] })
        let stdout = '', stderr = '', failure: string | undefined
        const stop = (code: string) => { failure ??= code; child.kill('SIGKILL') }
        const aborted = () => stop('NATIVE_HTML_ABORTED')
        const timer = setTimeout(() => stop('NATIVE_HTML_TIMEOUT'), 12000)
        request.signal?.addEventListener('abort', aborted, { once: true })
        if (request.signal?.aborted) aborted()
        child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; if (stdout.length > 16384) stop('NATIVE_HTML_WORKER_INVALID') })
        child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; if (stderr.length > 16384) stop('NATIVE_HTML_WORKER_INVALID') })
        child.once('error', () => { failure ??= 'NATIVE_HTML_WORKER_UNAVAILABLE' })
        child.once('close', code => {
          clearTimeout(timer); request.signal?.removeEventListener('abort', aborted)
          if (failure) { reject(new FrameworkError(failure, 'HTML rendering did not complete.')); return }
          if (code !== 0) {
            const reason = stderr.includes('16777216 pixels') ? 'NATIVE_HTML_PIXEL_LIMIT'
              : stderr.includes('PNG exceeds') ? 'NATIVE_HTML_OUTPUT_LIMIT' : 'NATIVE_HTML_RENDER_FAILED'
            reject(new FrameworkError(reason, 'HTML rendering failed.')); return
          }
          try { resolve(JSON.parse(stdout.trim())) } catch { reject(new FrameworkError('NATIVE_HTML_WORKER_INVALID', 'The HTML renderer returned an invalid result.')) }
        })
      })
      request.signal?.throwIfAborted()
      assert(isRecord(childResult) && childResult.width === 1080 && Number.isSafeInteger(childResult.height)
        && Number(childResult.height) > 0 && 1080 * Number(childResult.height) <= 16777216,
      'NATIVE_HTML_WORKER_INVALID', 'The HTML renderer returned invalid dimensions.')
      const handle = await open(output, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      let png: Buffer
      try {
        const file = await handle.stat()
        assert(file.isFile() && file.nlink === 1 && file.size >= 57 && file.size <= 8 * 1024 * 1024,
          'NATIVE_HTML_OUTPUT_LIMIT', 'A bounded rendered PNG is required.')
        png = await handle.readFile()
      } finally { await handle.close() }
      request.signal?.throwIfAborted()
      return [{ png, width: 1080, height: Number(childResult.height) }]
    } finally { if (temporary) await rm(temporary, { recursive: true, force: true }); pending-- }
  } })
}
