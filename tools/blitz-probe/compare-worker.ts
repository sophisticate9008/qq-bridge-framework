import { readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { Renderer, type Node, type ImageSource } from '@takumi-rs/core';
import { fromHtml } from '@takumi-rs/helpers/html';

const [htmlPath, pngPath, ...fontPaths] = process.argv.slice(2);
if (!htmlPath || !pngPath || fontPaths.length !== 4) throw new Error('Expected HTML, PNG and four fonts');
const started = performance.now();
const renderer = new Renderer({ cacheMaxBytes: 16 * 1024 * 1024, fontCacheMaxBytes: 16 * 1024 * 1024 });
const fontFamilies: string[] = [];
for (const path of fontPaths) {
  const families = await renderer.registerFont({ data: await readFile(path) });
  fontFamilies.push(...families.map((family) => family.name));
}
const { node: parsed, css } = fromHtml(await readFile(htmlPath, 'utf8'));
const images: ImageSource[] = [];
const structural = new Set(['html', 'body', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'ul', 'ol', 'blockquote']);
const canonical = (source: Node): Node => {
  if (source.type === 'image' && typeof source.src === 'string' && source.src.startsWith('<svg')) {
    const key = `inline-svg-${images.length}`;
    images.push({ src: key, data: Buffer.from(source.src) });
    return { ...source, src: key };
  }
  if (source.type !== 'container') return source;
  return { ...source, children: source.children?.filter((child) => !(structural.has(source.tagName ?? '')
    && child.type === 'text' && /^\s*$/.test(child.text))).map(canonical) };
};
const node = canonical(parsed);
const options = { width: 1080, css, images, fontFamilies, lang: 'zh-CN' };
const measured = await renderer.measure(node, options);
const height = Math.ceil(measured.height);
if (!Number.isSafeInteger(height) || height <= 0 || height * 1080 > 16_777_216) throw new Error('Pixel limit exceeded');
const png = await renderer.render(node, { ...options, height, format: 'png' });
if (png.byteLength > 8 * 1024 * 1024) throw new Error('PNG byte limit exceeded');
await writeFile(pngPath, png);
console.log(JSON.stringify({ width: 1080, height, pngBytes: png.byteLength, elapsedMs: Math.round(performance.now() - started) }));
