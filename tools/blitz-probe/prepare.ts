import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const upstream = resolve(process.argv[2] ?? '.cache/blitz-source');
const manifestPath = resolve(upstream, 'Cargo.toml');
const original = await readFile(manifestPath, 'utf8');
const members = ['blitz-dom', 'blitz-html', 'blitz-paint', 'blitz-traits', 'stylo_taffy', 'debug_timer'];
const dependencies = `
[dev-dependencies]
anyrender = { workspace = true }
anyrender_vello_cpu = { workspace = true, features = ["multithreading"] }
blitz-dom = { workspace = true, features = ["svg", "complex-scripts"] }
blitz-html = { workspace = true }
blitz-traits = { workspace = true }
blitz-paint = { workspace = true, features = ["svg"] }
linebender_resource_handle = { workspace = true }
parley = { workspace = true }
png = { workspace = true }
peniko = { workspace = true }

`;
// Preserve upstream workspace versions, git dependency revisions, patches and lockfile.
// Exclude desktop/Dioxus workspace members and their development dependencies.
let manifest = original.replace(/members = \[[\s\S]*?\]/,
  `members = [${members.map((name) => `"packages/${name}"`).join(', ')}]`);
manifest = manifest.replace(/\n\[features\][\s\S]*?\n\[dev-dependencies\][\s\S]*?(?=\n\[patch\.crates-io\])/, dependencies);
if (manifest === original || manifest.includes('log-times =')) throw new Error('Unexpected upstream manifest');
await writeFile(manifestPath, manifest);
await copyFile(new URL('./main.rs', import.meta.url), resolve(upstream, 'examples/qbf-html-probe.rs'));
const output = resolve('private/maintenance/blitz-probe');
await mkdir(output, { recursive: true });
const css = `html,body{margin:0;padding:0}body{font-family:"WenQuanYi Micro Hei";font-size:26px;color:#152139;background:#edf2fa}.card{margin:24px;padding:28px;background:#fff;border-radius:20px}h1{color:#7134c4;font-size:40px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.tile{padding:20px;border-radius:12px;background:#e4f5f0;color:#08765a}.blue{background:#e9edff;color:#384dc2}table{width:100%;border-collapse:collapse}td,th{padding:12px;border:1px solid #c9d4e7}pre{padding:20px;background:#182237;color:#adf1cf;white-space:pre-wrap}p{line-height:1.6}`;
const wrap = (body: string): string => `<!doctype html><html><head><meta charset="utf-8"><style>${css}pre,code{font-family:"WenQuanYi Micro Hei Mono"}</style></head><body>${body}</body></html>`;
await writeFile(resolve(output, 'color.html'), wrap(`<div class="card"><h1>HTML 彩色排版 · 中文验证</h1><p>独立 CPU 排版，无需桌面窗口。导数 f'(x)、引用、表格与多列布局。</p><div class="grid"><div class="tile">绿色卡片<br>中文自动换行</div><div class="tile blue">蓝色卡片<br>Flex / Grid</div></div><table><tr><th>平台</th><th>排版方式</th></tr><tr><td>Linux / Windows</td><td>HTML → PNG</td></tr></table><pre><span style="color:#efb0ff">const</span> answer = <span style="color:#ffcf71">42</span>;</pre><svg width="500" height="100" viewBox="0 0 500 100" xmlns="http://www.w3.org/2000/svg"><rect x="1" y="1" width="498" height="98" rx="16" fill="#ebddff"/><path d="M30 70 L80 20 L130 70 L180 20" fill="none" stroke="#8a36be" stroke-width="5"/></svg><p style="color:#d34160">结束标记：完整内容已到这里。</p></div>`));
await writeFile(resolve(output, 'long.html'), wrap(Array.from({ length: 38 }, (_, index) => `<div class="card"><h2>第 ${index + 1} 段 · 长图完整性</h2><p>高度按正文增长，保留中文和彩色内容，不使用固定高度裁切。${index === 37 ? '最终结束标记。' : ''}</p></div>`).join('')));
console.log('Prepared minimal CPU renderer and public HTML fixtures.');
