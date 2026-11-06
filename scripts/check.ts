import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkTypeScriptSyntax } from './typescript-syntax.ts';
import { checkSourceRules } from './source-rules.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const excluded = new Set(['.git', '.cache', 'node_modules', 'runtime', 'data', 'workspace', 'private', 'state', 'coverage', 'dist']);
// Directory exceptions are maintained independently of the CI implementation.
const authoredJavaScriptDirectories = fs.readFileSync(path.join(root, '.ci-js-ignore'), 'utf8')
  .split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#')).map(directory => {
    const normalized = directory.replace(/\/$/, '');
    if (!normalized || normalized.split('/').some(part => !part || part === '.' || part === '..')
      || /[\\:*?\[\]{}]/.test(normalized)) {
      throw new Error(`.ci-js-ignore: expected a repository-relative directory: ${directory}`);
    }
    return `${normalized}/`;
  });
const findings: string[] = [];
let checked = 0;
// Reviewed redistributable binary; replacements require an explicit identity update.
const publicAssets = new Map([['assets/fonts/wqy-microhei.ttc', {
  size: 5_177_387,
  sha256: '2420e8078af796b19a3f6ef13de527a1a91c1e7171eea115926c614ced1009b3',
}], ['assets/fonts/NotoSansMath-Regular.ttf', {
  size: 1_015_396,
  sha256: '3f495fe933c06786e4d5f6d86b8ee70b6753a68ee3b9d87528726de0f6e2c47d',
}], ['assets/fonts/NotoSansSymbols2-Regular.ttf', {
  size: 1_233_128,
  sha256: '7d5fb73b7ca67a6798101741f5d280a3d016a56a197afcd4199dbb57b4b82a21',
}], ['assets/fonts/NotoSans-Regular.ttf', {
  size: 569_208,
  sha256: 'b85c38ecea8a7cfb39c24e395a4007474fa5a4fc864f6ee33309eb4948d232d5',
}]]);

function walk(directory: string) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (excluded.has(entry.name)) continue;
    const location = path.join(directory, entry.name);
    const relative = path.relative(root, location);
    if (relative.split(path.sep).join('/') === 'assets/native') continue; // Generated, ignored release components.
    if (entry.isSymbolicLink()) { findings.push(`${relative}: symbolic link requires explicit review`); continue; }
    if (entry.isDirectory()) { walk(location); continue; }
    if (!entry.isFile()) { findings.push(`${relative}: unsupported file type`); continue; }
    const asset = publicAssets.get(relative.split(path.sep).join('/'));
    if (asset) {
      const bytes = fs.readFileSync(location);
      if (bytes.length !== asset.size || createHash('sha256').update(bytes).digest('hex') !== asset.sha256) {
        findings.push(`${relative}: public asset identity mismatch`);
      }
      checked++;
      continue;
    }
    if (fs.statSync(location).size > 1024 * 1024) { findings.push(`${relative}: oversized public file`); continue; }
    if (/^\.env(?:\.|$)/.test(entry.name) && entry.name !== '.env.example') findings.push(`${relative}: private environment file`);
    const source = fs.readFileSync(location, 'utf8');
    for (const pattern of [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, /ghp_[A-Za-z0-9]{36}/,
      /github_pat_[A-Za-z0-9_]{50,}/, /sk-[A-Za-z0-9_-]{40,}/]) {
      if (pattern.test(source)) findings.push(`${relative}: possible credential format`);
    }
    if (/\.(?:mjs|js|cjs)$/.test(entry.name)
      && !authoredJavaScriptDirectories.some(directory => relative.split(path.sep).join('/').startsWith(directory))) {
      findings.push(`${relative}: authored JavaScript must be TypeScript`);
    }
    if (/\.tsx?$/.test(entry.name)) {
      if (!checkTypeScriptSyntax(source, relative)) findings.push(`${relative}: TypeScript syntax check failed`);
      for (const finding of checkSourceRules(source, relative)) {
        findings.push(`${relative}:${finding.line}:${finding.column}: ${finding.code}: ${finding.message}`);
      }
    }
    checked++;
  }
}

walk(root);
if (findings.length) {
  for (const finding of findings) console.error(finding);
  process.exitCode = 1;
} else console.log(`Checked ${checked} public files: syntax, authored TypeScript rules, architecture and selected credential-format checks passed.`);
