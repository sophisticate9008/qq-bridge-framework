import { appendFile } from 'node:fs/promises';
import { htmlRendererBuildHash } from '../../scripts/html-renderer-component.ts';
const digest = await htmlRendererBuildHash(process.cwd());
console.log(digest);
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `hash=${digest}\n`);
