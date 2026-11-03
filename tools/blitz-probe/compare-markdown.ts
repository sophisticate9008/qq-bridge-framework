import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import sharp from 'sharp';

interface PreparedDocument {
  html: string;
  css: string;
  images: { src: string; data: Uint8Array }[];
}
interface EngineResult {
  engine: string;
  status: number | null;
  wallMs: number;
  sampledPeakRssKiB: number | null;
  result: unknown;
  error: string | null;
}

const executable = process.argv[2];
if (!executable) throw new Error('Usage: node tools/blitz-probe/compare-markdown.ts /path/to/qbf-html-probe [BULLET_FONT.otf]');
const binary = resolve(executable);
// The default Blitz document registers this internal font itself. Our probe supplies
// its own FontContext, so explicitly provide it to preserve normal list markers.
const bulletFont = process.argv[3] ? resolve(process.argv[3]) : undefined;
const output = resolve('runtime/research/markdown-render-comparison');
await mkdir(output, { recursive: true });
const fontPaths = ['wqy-microhei.ttc', 'NotoSansMath-Regular.ttf', 'NotoSansSymbols2-Regular.ttf', 'NotoSans-Regular.ttf']
  .map((name) => resolve('assets/fonts', name));
// Derive the preparation function from the actual worker, without changing the runtime.
// Fail on source structure changes rather than silently maintaining a second parser.
const source = await readFile('src/rendering/builtin-markdown-worker.ts', 'utf8');
const styleStart = source.indexOf('const STYLE =');
const runStart = source.indexOf('async function run()');
const parserStart = source.indexOf('  const parser = new MarkdownIt(');
const htmlStart = source.indexOf('  const { node: parsedNode } = fromHtml(');
if (!(styleStart > 0 && runStart > styleStart && parserStart > runStart && htmlStart > parserStart)) throw new Error('Markdown worker structure changed');
const imports = source.slice(0, styleStart).split('\n').filter((line) =>
  line.includes("from 'markdown-it'") || line.includes("from 'highlight.js/") || line.includes("from '../core/values.ts'"));
const valuesUrl = pathToFileURL(resolve('src/core/values.ts')).href;
const mathUrl = pathToFileURL(resolve('src/rendering/builtin-markdown-math.ts')).href;
const preparation = [
  ...imports.map((line) => line.replace('../core/values.ts', valuesUrl)),
  "import type { ImageSource } from '@takumi-rs/core';",
  source.slice(styleStart, runStart),
  'export async function prepare(input: { markdown: string; title?: string }, width: number) {',
  source.slice(parserStart, htmlStart).replace('./builtin-markdown-math.ts', mathUrl),
  'return { html: `<html lang="zh-CN"><body>${title}${body}</body></html>`, css: STYLE, images };',
  '}',
].join('\n');
const generated = resolve(output, 'generated-preparation.ts');
await writeFile(generated, preparation);
const module: unknown = await import(pathToFileURL(generated).href);
if (typeof module !== 'object' || module === null || !('prepare' in module) || typeof module.prepare !== 'function') throw new Error('Invalid preparation module');
const prepare = module.prepare as (input: { markdown: string; title?: string }, width: number) => Promise<PreparedDocument>;

const mixed = `# 中文 Markdown 排版\n\n**重点内容**、*强调*、~~删除线~~、\`inline code\`。中文自动换行，英文 English，常用符号 f‴(x)、f⁽ⁿ⁾(x)、𝑓(𝑥)、ℝ、∭、⟹。\n\n| 项目 | 内容 |\n|---|---|\n| 中文 | 表格内容与列边界 |\n| 公式 | 实际本地 SVG 图形 |\n\n\`\`\`typescript\nconst 名称: string = "彩色代码";\nfor (let i = 0; i < 3; i++) {\n  console.log(名称, i);\n}\n\`\`\`\n\n> 引用内容：排版应保留这里的中文与边框。\n\n- [x] 已完成\n- [ ] 待办\n  - 嵌套项目\n\n行内公式 $E=mc^2$。\n\n$$f'(x)=\\lim_{h\\to0}\\frac{f(x+h)-f(x)}h$$\n\n最后标记：混合文档结束。`;
const fixtures = [
  { name: 'mixed', markdown: mixed },
  { name: 'long', markdown: '# 长文档\n\n' + Array.from({ length: 34 }, (_, i) => `## 第 ${i + 1} 段\n\n这是同一份 Markdown 的中文段落。自动换行、列表和段落间距应完整保留，不因固定高度而裁掉末尾。\n\n- 本段第一项\n- 本段第二项\n`).join('\n') + '\n最终结束标记。' },
  { name: 'table', markdown: '# 多列表格\n\n| 序号 | 条件 | 中文内容 | 结果 |\n|---|---|---|---|\n' + Array.from({ length: 22 }, (_, i) => `| ${i + 1} | x > ${i} | 中文较长单元格，检查自动换行及表格边界。 | **完成** |`).join('\n') + '\n\n表格结束标记。' },
  { name: 'formulas', markdown: '# 公式密集文档\n\n' + Array.from({ length: 60 }, (_, i) => `$x_{${i}}^2$`).join('，') + '\n\n公式最终结束标记。' },
];
async function run(engine: string, command: string, args: string[]): Promise<EngineResult> {
  const started = performance.now();
  return new Promise((done, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let peak = 0; let polling = false;
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    const sample = async () => {
      if (process.platform !== 'linux' || polling || !child.pid) return;
      polling = true;
      try {
        const status = await readFile(`/proc/${child.pid}/status`, 'utf8');
        const match = status.match(/^VmHWM:\s+(\d+)\s+kB/m);
        if (match) peak = Math.max(peak, Number(match[1]));
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ESRCH'))) stderr += String(error);
      } finally { polling = false; }
    };
    const sampler = setInterval(() => { void sample(); }, 5);
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, 20_000);
    child.once('error', (error) => { clearInterval(sampler); clearTimeout(timer); reject(error); });
    child.once('close', (status) => {
      clearInterval(sampler); clearTimeout(timer);
      let parsed: unknown = null;
      if (status === 0) { try { parsed = JSON.parse(stdout.trim()); } catch { stderr += 'Invalid JSON result'; } }
      done({ engine, status, wallMs: Math.round(performance.now() - started), sampledPeakRssKiB: peak || null, result: parsed, error: stderr.trim() || null });
    });
  });
}
const report: { name: string; markdownBytes: number; htmlBytes: number; preparationMs: number; results: EngineResult[] }[] = [];
for (const fixture of fixtures) {
  const started = performance.now();
  const prepared = await prepare({ markdown: fixture.markdown }, 1080);
  const preparationMs = Math.round(performance.now() - started);
  let html = prepared.html;
  for (const image of prepared.images) {
    const escaped = image.src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`<img class="([^"]+)" src="${escaped}" width="(\\d+)" height="(\\d+)">`, 'g');
    html = html.replace(pattern, (_whole: string, className: string, width: string, height: string) =>
      Buffer.from(image.data).toString('utf8').replace(/\bwidth="[^"]*"/, `width="${width}"`).replace(/\bheight="[^"]*"/, `height="${height}"`).replace('<svg ', `<svg class="${className}" `));
  }
  // Explicit font fallback is shared by both engines; no system font discovery.
  const css = prepared.css + '\nhtml{font-family:"WenQuanYi Micro Hei","Noto Sans Math","Noto Sans Symbols 2","Noto Sans"}';
  html = '<!doctype html>' + html.replace('<body>', `<head><meta charset="utf-8"><style>${css}</style></head><body>`);
  const htmlPath = resolve(output, `${fixture.name}.html`);
  await writeFile(htmlPath, html);
  await writeFile(resolve(output, `${fixture.name}.md`), fixture.markdown);
  const results: EngineResult[] = [];
  for (let repeat = 0; repeat < 3; repeat++) {
    for (const engine of repeat % 2 ? ['blitz', 'takumi'] : ['takumi', 'blitz']) {
      const pngPath = resolve(output, `${fixture.name}-${engine}-${repeat}.png`);
      const result = engine === 'takumi'
        ? await run(engine, process.execPath, [resolve('tools/blitz-probe/compare-worker.ts'), htmlPath, pngPath, ...fontPaths])
        : await run(engine, binary, [htmlPath, pngPath, '1080', ...fontPaths, ...(bulletFont ? [bulletFont] : [])]);
      results.push(result);
      if (result.status === 0) {
        const meta = await sharp(pngPath).metadata();
        if (meta.width !== 1080 || !meta.height) throw new Error('Invalid PNG output');
      }
    }
  }
  report.push({ name: fixture.name, markdownBytes: Buffer.byteLength(fixture.markdown), htmlBytes: Buffer.byteLength(html), preparationMs, results });
  console.log(JSON.stringify(report.at(-1)));
}
await writeFile(resolve(output, 'report.json'), JSON.stringify({
  sourceSha256: createHash('sha256').update(source).digest('hex'),
  binarySha256: createHash('sha256').update(await readFile(binary)).digest('hex'),
  platform: process.platform, arch: process.arch, node: process.version,
  bulletFontSupplied: Boolean(bulletFont),
  method: 'Identical prepared HTML/CSS, four explicit fonts, fresh process per sample; Markdown preparation excluded; 5ms /proc HWM samples are lower bounds.',
  report,
}, null, 2) + '\n');
console.log(`Report: ${resolve(output, 'report.json')}`);
