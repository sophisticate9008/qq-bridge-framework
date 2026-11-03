import { htmlRendererBuildHash } from './html-renderer-component.ts'
import { createHash } from 'node:crypto'
import { chmod, cp, lstat, mkdir, readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { assert, isRecord } from '../src/core/values.ts'

const source = resolve(process.argv[2] ?? 'runtime/html-renderer-components')
const expected = ['linux-x64', 'linux-arm64', 'win32-x64']
const installed = new Set<string>()
for (const name of await readdir(source)) {
  const directory = join(source, name)
  if (!(await lstat(directory)).isDirectory()) continue
  const component: unknown = JSON.parse(await readFile(join(directory, 'component.json'), 'utf8'))
  assert(isRecord(component) && component.buildHash === await htmlRendererBuildHash(process.cwd()) && component.schema === 1 && component.protocol === 1 && component.engine === 'blitz'
    && typeof component.target === 'string' && expected.includes(component.target)
    && component.resourcePolicy === 'no-network-no-files-no-scripts'
    && component.binary === (component.target.startsWith('win32-') ? 'qbf-html-renderer.exe' : 'qbf-html-renderer')
    && typeof component.sha256 === 'string' && /^[a-f0-9]{64}$/.test(component.sha256), 'NATIVE_HTML_COMPONENT_INVALID', 'Invalid HTML component.')
  const binary = join(directory, String(component.binary)), info = await lstat(binary)
  assert(info.isFile() && !info.isSymbolicLink() && info.size <= 32 * 1024 * 1024
    && createHash('sha256').update(await readFile(binary)).digest('hex') === component.sha256,
  'NATIVE_HTML_COMPONENT_INVALID', 'HTML component checksum mismatch.')
  assert(!installed.has(component.target), 'NATIVE_HTML_COMPONENT_INVALID', 'Duplicate HTML component.')
  const target = resolve('assets/native/html-renderer', component.target)
  await mkdir(target, { recursive: true })
  await cp(directory, target, { recursive: true })
  await chmod(join(target, String(component.binary)), 0o755)
  installed.add(component.target)
}
if (process.argv.includes('--all')) assert(expected.every(target => installed.has(target)), 'NATIVE_HTML_COMPONENT_MISSING', 'All release platforms must be included.')
assert(installed.size > 0, 'NATIVE_HTML_COMPONENT_MISSING', 'No HTML component was installed.')
console.log(`Installed HTML components: ${[...installed].sort().join(', ')}`)
