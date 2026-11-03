import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { htmlRendererBuildHash } from '../../scripts/html-renderer-component.ts';
const target = `${process.platform}-${process.arch}`;
const directory = resolve('runtime/html-renderer',target);
const metadata = JSON.parse(await readFile(join(directory,'component.json'),'utf8')) as {buildHash:string;target:string;binary:string;sha256:string};
assert.equal(metadata.target,target);
assert.equal(metadata.buildHash,await htmlRendererBuildHash(process.cwd()));
const binary=join(directory,process.platform==='win32'?'qbf-html-renderer.exe':'qbf-html-renderer');
assert.equal(createHash('sha256').update(await readFile(binary)).digest('hex'),metadata.sha256);
const output=resolve('runtime/html-renderer-smoke');
await mkdir(output,{recursive:true});
const font=resolve('assets/fonts/wqy-microhei.ttc');
function render(name:string,html:string): Buffer {
  const input=join(output,`${name}.html`), png=join(output,`${name}.png`);
  execFileSync(process.execPath,['-e','require("node:fs").writeFileSync(process.argv[1],process.argv[2])',input,html]);
  execFileSync(binary,[input,png,'1080',font],{timeout:20000,stdio:['ignore','pipe','pipe']});
  return execFileSync(process.execPath,['-e','process.stdout.write(require("node:fs").readFileSync(process.argv[1]))',png]);
}
const wrap=(text:string,family:string)=>`<html><style>body{margin:0;height:160px;font:36px ${family};color:#202b3b}</style><body>${text}</body></html>`;
const blank=render('blank',wrap('','sans-serif'));
for(const family of ['sans-serif','"PingFang SC","Microsoft YaHei","Noto Sans SC",sans-serif','"Unavailable QBF Font"']) {
  const png=render(`font-${family.length}`,wrap('字体回退 · 中文 English 123',family));
  assert(png.length>blank.length+500,'Text must paint visible glyphs with unavailable platform fonts');
}
const long=render('long',`<style>body{font:24px sans-serif}</style>${'<p>长图完整内容</p>'.repeat(100)}`);
assert(long.readUInt32BE(20)>4000,'Long documents must not be clipped');
// The embedded SVG image loader must not read local files, including a valid PNG.
const local=join(output,'font-10.png').replaceAll('\\','/');
const svg=(image:string)=>`<body style="margin:0"><svg width="1080" height="160" xmlns="http://www.w3.org/2000/svg">${image}</svg></body>`;
assert.deepEqual(render('svg-empty',svg('')),render('svg-local',svg(`<image href="${local}" width="1080" height="160"/>`)));
await writeFile(join(directory,'verification.json'),JSON.stringify({target,buildHash:metadata.buildHash,checks:['font-fallback-visible','long-image','svg-file-denied'],verifiedCommit:process.env.GITHUB_SHA},null,2)+'\n');
console.log(`Verified native HTML component: ${target}`);
