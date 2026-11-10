import { trustedPermissions, canonicalPathMatches } from '../src/storage/file-security.ts'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import { fileURLToPath } from 'node:url'
import { basename, dirname, join, resolve } from 'node:path'
import { parseExtensionManifest, type ManagedExtension } from '../src/contracts/managed-extensions.ts'
import { parseFrameworkDistribution } from '../src/contracts/framework-distribution.ts'
import { FrameworkError, isRecord } from '../src/core/values.ts'
import { createExtensionRegistry, extensionOperationPending, extensionStore } from '../src/host/managed-extensions.ts'
import { ensurePrivateDirectory } from '../src/storage/private-json.ts'
import { readNativeBootstrapContent } from './bootstrap-content.ts'

const execute = promisify(execFile)
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
function fail(code: string, log?: string): never { throw new FrameworkError(code, log ? `扩展安装未完成，诊断日志：${log}` : '扩展安装未完成，请核对源码清单与本机私有安装日志。') }
function diagnostic(error:unknown):string {
  return [error instanceof Error?error.message:'Operation failed',isRecord(error)&&typeof error.stdout==='string'?error.stdout:'',
    isRecord(error)&&typeof error.stderr==='string'?error.stderr:''].join('\n')
}
async function safeBytes(filename: string, maximum = 1048576): Promise<Buffer> {
  if (!canonicalPathMatches(await realpath(dirname(filename)),dirname(filename))) fail('EXTENSION_SOURCE_LINK_DENIED')
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.nlink !== 1 || info.size > maximum || !trustedPermissions(filename,info)
      || typeof process.getuid === 'function' && ![0,process.getuid()].includes(info.uid)) fail('EXTENSION_SOURCE_INVALID')
    const bytes = await handle.readFile(), after = await handle.stat(), path = await lstat(filename)
    if (bytes.length !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs
      || path.ino !== info.ino || path.dev !== info.dev || path.isSymbolicLink()) fail('EXTENSION_SOURCE_CHANGED')
    return bytes
  } finally { await handle.close() }
}
async function npmCli() {
  for (const path of [join(dirname(process.execPath),'node_modules/npm/bin/npm-cli.js'), resolve(dirname(process.execPath),'../lib/node_modules/npm/bin/npm-cli.js')]) {
    if (await lstat(path).then(value => value.isFile()).catch(() => false)) return path
  }
  return fail('EXTENSION_NPM_UNAVAILABLE')
}
async function npm(args: readonly string[], cwd: string, cache: string) {
  return execute(process.execPath, [await npmCli(), ...args], { cwd, timeout: 180000, maxBuffer: 2097152,
    env: { ...process.env, npm_config_cache: cache, npm_config_ignore_scripts: 'true', npm_config_audit: 'false', npm_config_fund: 'false' } })
}

/** Installers consume the matching bundled SDK. A source checkout packs its existing SDK build once. */
export async function prepareExtensionSdk(framework: string, directory: string): Promise<string> {
  const metadata: unknown = JSON.parse(await readFile(join(framework,'package.json'),'utf8'))
  if (!isRecord(metadata) || typeof metadata.version !== 'string') fail('EXTENSION_SDK_INVALID')
  const sdkRoot = join(directory,'sdk'); await ensurePrivateDirectory(sdkRoot)
  let archive: string
  if (await lstat(join(framework,'distribution.json')).then(() => true).catch(() => false)) {
    const manifest = parseFrameworkDistribution(JSON.parse(await readFile(join(framework,'distribution.json'),'utf8')) as unknown)
    const component = manifest?.components?.find(item => item.filename === `qq-bridge-framework-sdk-${metadata.version}.tgz`)
    if (!component) fail('EXTENSION_SDK_NOT_BUNDLED')
    archive = join(framework,'components',component.filename)
    if (sha(await safeBytes(archive, 33554432)) !== component.sha256) fail('EXTENSION_SDK_CHECKSUM_MISMATCH')
  } else {
    const source = join(framework,'packages/framework-sdk')
    const sdk: unknown = JSON.parse(await readFile(join(source,'package.json'),'utf8'))
    if (!isRecord(sdk) || sdk.version !== metadata.version || sdk.name !== '@qq-bridge-framework/sdk'
      || !await lstat(join(source,'dist/sdk/host.js')).then(value => value.isFile()).catch(() => false)) throw new FrameworkError('EXTENSION_SDK_BUILD_REQUIRED','源码工作区尚无配套 SDK 构建，请先运行 npm run build:sdk；完整发行包使用随包 SDK。')
    const temporary = await mkdtemp(join(sdkRoot,'.pack-'))
    try {
      const packed = JSON.parse((await npm(['pack','--ignore-scripts','--json','--pack-destination',temporary,source], framework, join(sdkRoot,'.cache'))).stdout) as unknown
      if (!Array.isArray(packed) || !isRecord(packed[0]) || typeof packed[0].filename !== 'string'
        || basename(packed[0].filename) !== packed[0].filename) fail('EXTENSION_SDK_PACK_FAILED')
      const bytes = await safeBytes(join(temporary,packed[0].filename),33554432)
      const saved = join(sdkRoot,`${sha(bytes)}.tgz`)
      await writeFile(saved,bytes,{mode:0o600,flag:'wx'}).catch(async error => {
        if (!isRecord(error) || error.code !== 'EEXIST' || sha(await safeBytes(saved,33554432)) !== sha(bytes)) throw error
      })
      return saved
    } finally { await rm(temporary,{recursive:true,force:true}) }
  }
  const bytes = await safeBytes(archive,33554432), saved = join(sdkRoot,`${sha(bytes)}.tgz`)
  await writeFile(saved,bytes,{mode:0o600,flag:'wx'}).catch(async error => {
    if (!isRecord(error) || error.code !== 'EEXIST' || sha(await safeBytes(saved,33554432)) !== sha(bytes)) throw error
  })
  return saved
}

async function externalImports(directory: string, files: readonly string[]) {
  const ts = await import('typescript'), imports = new Set<string>()
  for (const file of files) {
    if (!/\.[cm]?[jt]s$/.test(file)) continue
    const ast = ts.createSourceFile(file,await readFile(join(directory,file),'utf8'),ts.ScriptTarget.Latest,true)
    function add(text: string) { if (!isBuiltin(text) && !text.startsWith('.')) imports.add(text) }
    function visit(node: import('typescript').Node): void {
      if (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly !== true || ts.isExportDeclaration(node) && !node.isTypeOnly) {
        const specifier = (node as import('typescript').ImportDeclaration).moduleSpecifier
        if (specifier && ts.isStringLiteral(specifier)) add(specifier.text)
      }
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
        if (node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]!)) add(node.arguments[0].text)
      }
      ts.forEachChild(node,visit)
    }
    visit(ast)
  }
  return [...imports].sort().map(specifier => ({specifier,lockFile:'package-lock.json'}))
}

export async function installExtension(options: { source: string; configuration: string; framework: string }) {
  const source = resolve(options.source), store = createExtensionRegistry(options.configuration), release = await store.lock()
  let temporary: string | undefined
  try {
    const current = await store.read()
    if (extensionOperationPending(current.value)) fail('EXTENSION_OPERATION_PENDING')
    const manifest = parseExtensionManifest(JSON.parse((await safeBytes(join(source,'qbf.extension.json'),65536)).toString('utf8')) as unknown)
    if (!manifest) fail('EXTENSION_MANIFEST_INVALID')
    const parent = join(extensionStore(options.configuration),manifest.id); await ensurePrivateDirectory(parent)
    temporary = await mkdtemp(join(parent,'.candidate-'))
    let total = 0
    for (const file of manifest.files) {
      if (file.endsWith('.manifest.json') || ['qbf.extension.json','.qbf-typecheck.json','install.log','.npmrc'].includes(file.toLowerCase())) fail('EXTENSION_FILE_RESERVED')
      const bytes = await safeBytes(join(source,file),file===manifest.entry?262144:1048576); total += bytes.length
      if (total > 8388608) fail('EXTENSION_SOURCE_LIMIT')
      const destination = join(temporary,file); await mkdir(dirname(destination),{recursive:true,mode:0o700}); await writeFile(destination,bytes,{mode:0o600,flag:'wx'})
    }
    const pkg: unknown = JSON.parse(await readFile(join(temporary,'package.json'),'utf8'))
    if (!isRecord(pkg) || pkg.type !== 'module') fail('EXTENSION_PACKAGE_INVALID')
    for (const section of ['dependencies','devDependencies','optionalDependencies']) {
      const deps = pkg[section]
      if (deps !== undefined && (!isRecord(deps) || Object.entries(deps).some(([name,value]) => name !== '@qq-bridge-framework/sdk'
        && (typeof value !== 'string' || /^(?:file:|link:|workspace:|git|https?:|\/|\.|~\/)/i.test(value))))) fail('EXTENSION_DEPENDENCY_INVALID')
    }
    const sdk = await prepareExtensionSdk(options.framework,extensionStore(options.configuration))
    pkg.dependencies = { ...(isRecord(pkg.dependencies) ? pkg.dependencies : {}), '@qq-bridge-framework/sdk': `file:${sdk}` }
    if (isRecord(pkg.devDependencies)) delete pkg.devDependencies['@qq-bridge-framework/sdk']
    if (isRecord(pkg.optionalDependencies)) delete pkg.optionalDependencies['@qq-bridge-framework/sdk']
    const lockFile = join(temporary,'package-lock.json')
    const lock: unknown = await readFile(lockFile,'utf8').then(text=>JSON.parse(text) as unknown).catch(error=>{
      if (isRecord(error) && error.code==='ENOENT') return null
      throw error
    })
    if (lock !== null) {
      if (!isRecord(lock) || ![2,3].includes(Number(lock.lockfileVersion)) || !isRecord(lock.packages)) fail('EXTENSION_DEPENDENCY_LOCK_INVALID')
      for (const [key,entry] of Object.entries(lock.packages)) {
        if (key === 'node_modules/@qq-bridge-framework/sdk' || key !== '' && !key.startsWith('node_modules/')) { delete lock.packages[key]; continue }
        if (!isRecord(entry) || key !== '' && (entry.link === true || typeof entry.resolved === 'string' && !/^https:\/\//.test(entry.resolved))) fail('EXTENSION_DEPENDENCY_LOCK_INVALID')
      }
      if (isRecord(lock.packages[''])) {
        lock.packages[''].dependencies = pkg.dependencies
        if (isRecord(lock.packages[''].devDependencies)) delete lock.packages[''].devDependencies['@qq-bridge-framework/sdk']
      }
      await writeFile(lockFile,JSON.stringify(lock,null,2)+'\n',{mode:0o600})
    }
    await writeFile(join(temporary,'package.json'),JSON.stringify(pkg,null,2)+'\n',{mode:0o600})
    const logs = join(extensionStore(options.configuration),'install-logs'); await ensurePrivateDirectory(logs)
    const log = join(logs,`${manifest.id}-${basename(temporary)}.log`)
    try {
      const result = await npm(['install','--ignore-scripts','--install-links','--no-audit','--no-fund'],temporary,join(extensionStore(options.configuration),'.npm-cache'))
      await writeFile(log,result.stdout+'\n'+result.stderr,{mode:0o600})
    } catch (error) {
      await writeFile(log,diagnostic(error),{mode:0o600})
      fail('EXTENSION_DEPENDENCY_INSTALL_FAILED',log)
    }
    await writeFile(join(temporary,'.qbf-typecheck.json'),JSON.stringify({compilerOptions:{strict:true,noEmit:true,target:'ES2023',types:['node'],skipLibCheck:false,
      module:'NodeNext',moduleResolution:'NodeNext',allowImportingTsExtensions:true,erasableSyntaxOnly:true},files:manifest.files.filter(file=>file.endsWith('.ts'))})+'\n',{mode:0o600})
    try {
      await execute(process.execPath,[join(options.framework,'node_modules/typescript/bin/tsc'),'--project',join(temporary,'.qbf-typecheck.json')],
        {cwd:temporary,timeout:120000,maxBuffer:2097152,env:{...process.env,NODE_OPTIONS:'--max-old-space-size=768'}})
    } catch(error) {
      await writeFile(`${log}.types`,diagnostic(error),{mode:0o600})
      fail('EXTENSION_TYPES_INVALID',`${log}.types`)
    }
    await writeFile(join(temporary,'qbf.extension.json'),JSON.stringify(manifest)+'\n',{mode:0o600})
    await writeFile(join(temporary,`${manifest.entry}.manifest.json`),JSON.stringify({schema:1,entry:manifest.entry,
      dependencies:await externalImports(temporary,manifest.files)})+'\n',{mode:0o600})
    const content = await readNativeBootstrapContent(join(temporary,manifest.entry),new AbortController().signal)
    if (!content) fail('EXTENSION_CONTENT_UNVERIFIED')
    try {
      const probe = fileURLToPath(new URL(`./extension-probe${import.meta.url.endsWith('.js')?'.js':'.ts'}`,import.meta.url))
      const result=await execute(process.execPath,[probe,join(temporary,manifest.entry)],{cwd:temporary,timeout:20000,maxBuffer:131072,
        env:{...process.env,NODE_OPTIONS:'--max-old-space-size=768'}})
      const inspected: unknown=JSON.parse(result.stdout)
      if(!isRecord(inspected)||!isRecord(inspected.manifest)||inspected.manifest.id!==manifest.id||inspected.manifest.version!==manifest.version) fail('EXTENSION_IDENTITY_MISMATCH')
    } catch(error) { await writeFile(`${log}.import`,diagnostic(error),{mode:0o600}); fail('EXTENSION_IMPORT_FAILED',`${log}.import`) }
    const revision = content.identity.fingerprint, directory = join(parent,revision)
    const entryBytes = await safeBytes(join(temporary,manifest.entry))
    const item: ManagedExtension = { ...manifest, revision, directory, fingerprint:sha(entryBytes), enabled:true }
    try { await rename(temporary,directory); temporary = undefined }
    catch (error) {
      if (!await lstat(directory).then(info=>info.isDirectory()&&!info.isSymbolicLink()).catch(()=>false)) throw error
      const existing = await readNativeBootstrapContent(join(directory,manifest.entry),new AbortController().signal)
      if (existing?.identity.fingerprint !== revision) fail('EXTENSION_REVISION_CONFLICT')
    }
    const previous=current.value.items.find(entry=>entry.id===item.id)
    if(previous?.enabled&&previous.revision===item.revision&&JSON.stringify(previous)===JSON.stringify(item))return {...current,unchanged:true as const}
    const items = [...current.value.items.filter(entry=>entry.id!==item.id),item]
    return await store.stage(items)
  } finally { if (temporary) await rm(temporary,{recursive:true,force:true}); await release() }
}
