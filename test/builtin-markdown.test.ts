import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import sharp from 'sharp'
import { createBuiltinMarkdownRenderer } from '../src/rendering/builtin-markdown.ts'

const document = '# 中文排版\n\n**重点**、*强调*、~~删除线~~、`inline code`。\n\n| 字段 | 内容 |\n|---|---|\n| 中文 | 表格内容自动换行，保持列边界 |\n\n```typescript\nconst 名称: string = "代码高亮";\nfor (let i = 0; i < 2; i++) {\n  console.log(名称, i);\n}\n```\n\n> 引用内容\n\n- [x] 完成\n- [ ] 待办\n  - 子项\n\n公式：$E=mc^2$。\n\n$$\\sum_{k=1}^{n}k=\\frac{n(n+1)}2$$\n\n'

test('built-in Takumi renderer produces actual Chinese table/code/math PNG pages with text-free cut rows', async () => {
  const pages = await createBuiltinMarkdownRenderer({ width: 720, pageHeight: 900 }).render({ markdown: document.repeat(3) })
  assert(pages.length >= 2 && pages.length <= 6)
  for (let index = 0; index < pages.length; index++) {
    const page = pages[index]
    assert.deepEqual([...page.png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
    const metadata = await sharp(page.png).metadata()
    assert.equal(metadata.width, 720); assert.equal(metadata.height, page.height)
    assert(page.height > 0 && page.height <= 900)
    if (index < pages.length - 1) {
      const { data, info } = await sharp(page.png).extract({ left: 48, top: page.height - 1, width: 624, height: 1 }).removeAlpha().raw().toBuffer({ resolveWithObject: true })
      let ink = 0
      for (let column = 0; column < info.width; column++) {
        const offset = column * info.channels
        if (data[offset] * .2126 + data[offset + 1] * .7152 + data[offset + 2] * .0722 < 165) ink++
      }
      assert(ink <= 3, `page ${index + 1} ends through text pixels`)
    }
  }
})

test('plain mathematical letters and superscript parentheses render distinct glyphs instead of identical missing-glyph boxes', async () => {
  const renderer = createBuiltinMarkdownRenderer({ width: 480, pageHeight: 600 })
  const symbols = ['𝑥', '𝑦', 'ℝ', 'ℂ', '⁽', '⁾']
  const images = new Set<string>()
  for (const markdown of symbols) {
    const pages = await renderer.render({ markdown })
    assert.equal(pages.length, 1)
    const pixels = await sharp(pages[0].png).removeAlpha().raw().toBuffer()
    images.add(createHash('sha256').update(pixels).digest('hex'))
  }
  assert.equal(images.size, symbols.length, 'different math symbols must not collapse to the same missing-glyph image')
})

test('formula-rich documents share document resource budgets without formula count or source quotas', async () => {
  const renderer = createBuiltinMarkdownRenderer()
  const formulas = Array.from({ length: 60 }, (_, index) => `$x_{${index}}^2$`)
  const markdown = '# 公式排版\n\n' + Array.from({ length: 10 }, (_, index) => formulas.slice(index * 6, index * 6 + 6).join('，')).join('\n\n')
    + '\n\n$x%' + 'source comment '.repeat(650) + '$'
    + '\n\n$$\nx\n' + '% comment\n'.repeat(90) + '$$'
  const pages = await renderer.render({ markdown })
  assert(pages.length >= 1 && pages.length <= 6)
  for (const page of pages) assert.equal((await sharp(page.png).metadata()).format, 'png')
})

test('Markdown links/images and raw HTML never fetch external content; prices remain ordinary text', async context => {
  let requests = 0
  const server = createServer((_, response) => { requests++; response.end('must not be read') })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  context.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const address = server.address(); assert(address && typeof address !== 'string')
  const target = `http://127.0.0.1:${address.port}/private`
  const pages = await createBuiltinMarkdownRenderer().render({ markdown:
    `# 安全渲染\n\n![外部图片](${target})\n\n![文件图片](file:///etc/passwd)\n\n[链接](${target})\n\n<img src="${target}"><script>fetch("${target}")</script>\n\n报价 $20 和 $30；转义 \\$x。` })
  assert.equal(pages.length, 1); assert.equal(requests, 0)
})

test('math dynamic package commands, overflow and cancellation fail clearly without poisoning later documents', async () => {
  const renderer = createBuiltinMarkdownRenderer()
  await assert.rejects(renderer.render({ markdown: '$\\require{https://example.invalid/x}$' }), { code: 'MARKDOWN_MATH_INVALID' })
  await assert.rejects(renderer.render({ markdown: 'x'.repeat(65537) }), { code: 'MARKDOWN_INVALID_INPUT' })
  await assert.rejects(renderer.render({ markdown: ('第行\n\n').repeat(2500) }), { code: 'MARKDOWN_PAGE_LIMIT' })
  const controller = new AbortController()
  const aborted = renderer.render({ markdown: document, signal: controller.signal })
  controller.abort()
  await assert.rejects(aborted, { code: 'MARKDOWN_ABORTED' })
  assert.equal((await renderer.render({ markdown: '# 后续请求正常' })).length, 1)
})
