import { execFileSync } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { htmlRendererBuildHash } from '../../scripts/html-renderer-component.ts';

// Public release assets survive Actions cache and artifact expiry. A miss simply builds.
const digest = await htmlRendererBuildHash(process.cwd());
const target = `${process.platform}-${process.arch}`;
const filename = `qbf-html-renderer-${digest}-${target}.tgz`;
const destination = resolve('private/maintenance/html-renderer', target);
try {
  const releases: unknown = JSON.parse(execFileSync('gh', ['api', `repos/${process.env.GITHUB_REPOSITORY}/releases?per_page=100`], {encoding:'utf8',stdio:['ignore','pipe','pipe']}));
  if (!Array.isArray(releases)) throw new Error('Invalid release catalog');
  const release: unknown = releases.find((row: unknown) => typeof row === 'object' && row !== null && 'draft' in row && row.draft === false
    && 'assets' in row && Array.isArray(row.assets) && row.assets.some((asset: unknown) => typeof asset === 'object' && asset !== null && 'name' in asset && asset.name === filename));
  if (!release || typeof release !== 'object' || !('tag_name' in release) || typeof release.tag_name !== 'string') throw new Error('No matching release component');
  const temporary = resolve('private/maintenance/html-renderer-download');
  await mkdir(temporary,{recursive:true});
  execFileSync('gh',['release','download',release.tag_name,'--repo',String(process.env.GITHUB_REPOSITORY),'--pattern',filename,'--dir',temporary,'--clobber'],{stdio:['ignore','pipe','pipe']});
  const entries = execFileSync('tar',['-tzf',filename],{cwd:temporary,encoding:'utf8'}).trim().split('\n');
  if (!entries.every(name => !name.startsWith('/') && !name.includes('\\') && !name.split('/').includes('..'))) throw new Error('Invalid component archive');
  await mkdir(destination,{recursive:true});
  execFileSync('tar',['-xzf',filename,'-C',destination],{cwd:temporary,stdio:['ignore','pipe','pipe']});
  console.log(`Reused release component ${target} (${digest})`);
} catch {
  await rm(destination,{recursive:true,force:true});
  console.log(`No reusable release component for ${target}; build from locked source.`);
}
