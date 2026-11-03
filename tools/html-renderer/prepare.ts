import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Reuse the fixed workspace/dependency preparation; only the worker entry differs.
await import('../blitz-probe/prepare.ts');
const upstream = resolve(process.argv[2] ?? '.cache/blitz-source');
await copyFile(new URL('./main.rs', import.meta.url), resolve(upstream, 'examples/qbf-html-probe.rs'));
const utilityPath = resolve(upstream, 'packages/blitz-dom/src/util.rs');
const original = await readFile(utilityPath, 'utf8');
const before = '        fontdb: Arc::clone(&*FONT_DB),';
if (!original.includes(before) || !original.includes('    db.load_system_fonts();')) throw new Error('Unexpected SVG resource implementation');
// usvg permits local file image hrefs by default. No document-controlled SVG load
// may escape the framework resource adapter; static paths and shapes remain available.
const patched = original.replace(before, `${before}\n        image_href_resolver: usvg::ImageHrefResolver {\n            resolve_data: Box::new(|_, _, _| None),\n            resolve_string: Box::new(|_, _| None),\n        },`)
  .replace('    db.load_system_fonts();', '    // Framework worker uses explicit fonts, never system discovery.');
await writeFile(utilityPath, patched);

await copyFile(new URL('./Cargo.lock', import.meta.url), resolve(upstream, 'Cargo.lock'));
