import { acquireProcessFileLock } from '../src/storage/process-file-lock.ts'
import { ensurePrivateDirectory } from '../src/storage/private-json.ts'
import { readProductUpdate, productUpdateDirectory } from '../src/host/product-update.ts'
import { productUninstallPending } from '../src/host/product-uninstall-state.ts'
import { trustedPermissions } from '../src/storage/file-security.ts'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { lstat, mkdir, readdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FrameworkError, isRecord } from '../src/core/values.ts'
import { extensionId } from '../src/contracts/managed-extensions.ts'
import { applyExtensionOperation, createExtensionRegistry, extensionObservationMatches, extensionOperationPending,
  extensionSetRevision, readExtensionRegistry, type ExtensionObservation } from '../src/host/managed-extensions.ts'
import { gatewayAdminAddress, loadGatewayAdminConfiguration } from '../src/admin/gateway.ts'
import { verifyNativeBootstrapFiles } from './bootstrap-loader.ts'
import { installExtension } from './extension-installation.ts'
import { manageExtensions, readExtensionAdminToken, readExtensionAdminResponse } from './extension-management.ts'
import { resolveRuntimeConfiguration } from './runtime-configuration.ts'

const execute = promisify(execFile)
const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)),'..')
const frameworkRoot = sourceRoot.endsWith('/dist') || sourceRoot.endsWith('\\dist') ? dirname(sourceRoot) : sourceRoot
const HELP = 'qbf-cli extensions init <目录> --id <标识> | install <目录> [--stage] | enable/disable/remove <标识> [--stage] | apply/reconcile [操作编号] | list | verify [标识] | reload <标识>；可选 --config <管理配置> --json。'
function fail(code: string, message = HELP): never { throw new FrameworkError(code,message) }

async function observer(filename: string): Promise<ExtensionObservation> {
  const configuration = loadGatewayAdminConfiguration(filename), token = await readExtensionAdminToken(configuration.tokenFile)
  const response = await fetch(new URL('/api/chat/extensions/installed',gatewayAdminAddress(configuration)),{
    headers:{authorization:`Bearer ${token}`},redirect:'error',signal:AbortSignal.timeout(5000)})
  if (!response.ok || Number(response.headers.get('content-length') ?? 0)>131072) {
    await response.body?.cancel(); return fail('EXTENSION_OBSERVATION_UNAVAILABLE','当前管理服务未提供可核验的扩展状态，请核对运行版本。')
  }
  const value: unknown = await readExtensionAdminResponse(response)
  if (!isRecord(value) || !isRecord(value.observation)) fail('EXTENSION_OBSERVATION_INVALID')
  const o = value.observation
  if (!(o.operationId===undefined||o.operationId===null||typeof o.operationId==='string'&&/^[a-f0-9-]{36}$/.test(o.operationId)) || typeof o.registryRevision !== 'string' || typeof o.running !== 'boolean' || !Array.isArray(o.packages) || o.packages.length>128
    || !Array.isArray(o.tools) || o.tools.length>256 || !o.tools.every(item=>typeof item==='string')
    || !Array.isArray(o.services) || o.services.length>16384 || !o.services.every(item=>isRecord(item)&&typeof item.owner==='string'&&typeof item.state==='string')
    || !o.packages.every(item=>isRecord(item)&&typeof item.id==='string'&&typeof item.state==='string'
      &&Array.isArray(item.toolNames)&&item.toolNames.every(name=>typeof name==='string'))) fail('EXTENSION_OBSERVATION_INVALID')
  return o as unknown as ExtensionObservation
}

async function apply(configuration: string, id?: string, reconcile = false) {
  const admin = loadGatewayAdminConfiguration(configuration)
  if (!reconcile && !admin.serviceManager) fail('EXTENSION_APPLY_UNAVAILABLE','扩展已登记，当前安装未配置受控框架管理器；启动本配置后用 extensions verify 验收。')
  const current=await readExtensionRegistry(configuration)
  if(!reconcile&&current.value.operation?.phase==='prepared') for(const item of current.value.items.filter(item=>item.enabled)) {
    const verified=await verifyNativeBootstrapFiles(join(item.directory,item.entry),item.fingerprint)
    if(verified.content?.identity.fingerprint!==item.revision)fail('EXTENSION_CONTENT_CHANGED','已登记的版本发生变化，保留当前运行版本，请重新安装源码。')
  }
  const manager=admin.serviceManager
  if(!reconcile&&current.value.operation?.phase==='prepared') {
    if(!manager||!isAbsolute(manager))fail('EXTENSION_MANAGER_INVALID')
    const metadata=await lstat(manager)
    if(!metadata.isFile()||metadata.isSymbolicLink()||!trustedPermissions(manager,metadata)
      ||typeof process.getuid==='function'&&![0,process.getuid()].includes(metadata.uid))fail('EXTENSION_MANAGER_INVALID')
  }
  return applyExtensionOperation(configuration,{
    async restart() {
      await execute(manager!,['restart','framework-admin'],{timeout:90000,maxBuffer:131072})
      return 'confirmed'
    },
    async observe() {
      let last: ExtensionObservation | undefined
      const deadline=Date.now()+30000
      for (let attempt=0;attempt<30&&Date.now()<deadline;attempt++) {
        try { last=await observer(configuration); if(last.running) return last } catch { /* Read-only startup observation. */ }
        await new Promise<void>(done=>setTimeout(done,500))
      }
      if(last) return last
      return fail('EXTENSION_OBSERVATION_UNAVAILABLE','应用结果未核实；请保留原操作编号执行 reconcile，勿重复安装或重启。')
    },
  },id,reconcile)
}

export async function managedExtensionCli(argumentsList: readonly string[], options: {
  cwd: string; env: NodeJS.ProcessEnv; output(message:string):void; framework?:string
}): Promise<number> {
  const values: string[] = [], flags = new Map<string,string|boolean>()
  for(let i=0;i<argumentsList.length;i++) {
    const value=argumentsList[i]!
    if(!value.startsWith('--')) {values.push(value);continue}
    if(flags.has(value)||!['--config','--id','--stage','--json'].includes(value)) fail('EXTENSION_ARGUMENTS_INVALID')
    if(['--stage','--json'].includes(value)) flags.set(value,true)
    else {const next=argumentsList[++i];if(!next||next.startsWith('--'))fail('EXTENSION_ARGUMENTS_INVALID');flags.set(value,next)}
  }
  const action=values.shift()??'list', root=options.framework??frameworkRoot
  const configuration=resolveRuntimeConfiguration(root,typeof flags.get('--config')==='string'?String(flags.get('--config')):undefined,options.env,options.cwd)
  const print=(value:unknown)=>options.output(JSON.stringify(value,null,2))
  let releaseMaintenance:(()=>Promise<void>)|undefined
  try {
    if(['install','enable','disable','remove','apply','reconcile','reload'].includes(action)) {
      const directory=productUpdateDirectory(root);await ensurePrivateDirectory(directory)
      try {releaseMaintenance=await acquireProcessFileLock(directory,'operation.lock')}
      catch(error) {if(error instanceof Error&&error.message==='process_lock_busy')fail('EXTENSION_MAINTENANCE_BUSY','另一项扩展、整套更新或卸载正在运行，请先核对原操作。');throw error}
      const product=await readProductUpdate(root)
      if(product&&!['completed','rolled-back'].includes(product.phase)||await productUninstallPending(root))fail('EXTENSION_PRODUCT_MAINTENANCE_PENDING','整套更新或卸载尚未确认，请先核对原维护操作。')
    }
    if(action==='init') {
      const id=flags.get('--id')
      if(values.length!==1||!extensionId(id)||flags.has('--stage'))fail('EXTENSION_ARGUMENTS_INVALID')
      const directory=resolve(options.cwd,values[0]!)
      await mkdir(directory,{recursive:true,mode:0o700})
      if((await readdir(directory)).length!==0)fail('EXTENSION_PROJECT_NOT_EMPTY','请使用空目录创建扩展，不覆盖已有源码。')
      await writeFile(join(directory,'package.json'),JSON.stringify({name:`qbf-extension-${id}`,version:'1.0.0',private:true,type:'module'},null,2)+'\n',{mode:0o600,flag:'wx'})
      await writeFile(join(directory,'qbf.extension.json'),JSON.stringify({schema:1,id,version:'1.0.0',displayName:id,entry:'index.ts',files:['index.ts','package.json'],packages:[id]},null,2)+'\n',{mode:0o600,flag:'wx'})
      await writeFile(join(directory,'index.ts'),`import { defineNativeBootstrap, PLUGIN_RUNTIME_PACKAGE_ID, PLUGIN_TOOLS_SERVICE_CONTRACT, serviceDeclaration, useService } from '@qq-bridge-framework/sdk/host'

export default defineNativeBootstrap({
  manifest: { id: '${id}', version: '1.0.0', apiVersion: 1 },
  create() { return { packages: [{
    manifest: { schema: 1, id: '${id}', version: '1.0.0', displayName: '${id}', description: '扩展状态查询。',
      toolNames: ['extension.${id}.status'], dependencies: [PLUGIN_RUNTIME_PACKAGE_ID],
      requires: [serviceDeclaration(PLUGIN_TOOLS_SERVICE_CONTRACT)], provides: [], contributions: [] },
    install(context) {
      const tools = useService(context, PLUGIN_TOOLS_SERVICE_CONTRACT)
      context.own('subscription', 'status', tools.register({ id: 'status', description: '查询本扩展状态。', permission: 'owner', readOnly: true,
        parameters: { type: 'object', additionalProperties: false, properties: {} },
        async execute(_input, request) { request.signal.throwIfAborted(); return { status: 'ready' } } }))
    },
  }] } },
})
`,{mode:0o600,flag:'wx'})
      await writeFile(join(directory,'README.md'),'# 扩展开发\n\n修改 index.ts 实现功能，并同步 qbf.extension.json 的源码文件和功能包清单。install 自动安装当前框架 SDK 与锁定依赖、执行严格类型检查并保存独立版本。在 bootstrap 的 create(host) 中取得 host.directory，把运行文件和成果放在其对应数据目录或明确的任务工作区；包 install(context) 本身不提供 directory，不写源码版本目录。只读工具不执行持久写入。\n',{mode:0o600,flag:'wx'})
      print({schema:1,id,directory,stage:'source-created',next:'extensions install <目录>'});return 0
    }
    if(flags.has('--id'))fail('EXTENSION_ARGUMENTS_INVALID')
    if(action==='reload') {
      if(values.length!==1||flags.has('--stage'))fail('EXTENSION_ARGUMENTS_INVALID')
      await manageExtensions(root,['reload',values[0]!],options.output,configuration);return 0
    }
    if(['list','verify'].includes(action)) {
      if(values.length>(action==='verify'?1:0)||flags.has('--stage'))fail('EXTENSION_ARGUMENTS_INVALID')
      loadGatewayAdminConfiguration(configuration)
      const registry=await readExtensionRegistry(configuration)
      let observed: ExtensionObservation|undefined
      try { observed=await observer(configuration) } catch { /* Offline installation state remains readable. */ }
      let reloadableExtensions:unknown=null
      if(action==='list') try { await manageExtensions(root,['list'],text=>{reloadableExtensions=JSON.parse(text) as unknown},configuration) } catch { /* Legacy reload status remains independent of installation observations. */ }
      const items=registry.value.items.filter(item=>!values[0]||item.id===values[0])
      if(values[0]&&!items.length)fail('EXTENSION_NOT_FOUND','扩展未在这份管理配置登记。')
      if(action==='verify') for(const item of items) {
        const verified=await verifyNativeBootstrapFiles(join(item.directory,item.entry),item.fingerprint)
        if(verified.content?.identity.fingerprint!==item.revision)fail('EXTENSION_CONTENT_CHANGED','安装版本的源码或依赖锁已改变，请从源码目录重新安装。')
      }
      print({schema:1,...(action==='list'?{reloadableExtensions}:{}),registryRevision:extensionSetRevision(registry.value.items),operation:registry.value.operation,items:items.map(item=>({
        id:item.id,version:item.version,revision:item.revision,enabled:item.enabled,packages:item.packages,
        registered:true,sourceVerified:action==='verify',runtimeVerified:!!observed&&extensionObservationMatches(registry.value.items,observed),
        invocationVerified:false })),observation:observed??null})
      return action==='verify'&&(!observed||!extensionObservationMatches(registry.value.items,observed))?2:0
    }
    if(['apply','reconcile'].includes(action)) {
      if(values.length>1||flags.has('--stage'))fail('EXTENSION_ARGUMENTS_INVALID')
      const op=await apply(configuration,values[0],action==='reconcile');print({schema:1,operation:op});return op?.phase==='completed'||action==='reconcile'&&op?.phase==='rolled-back'?0:2
    }
    // Validate this profile before preparing snapshots or changing its selection.
    const admin=loadGatewayAdminConfiguration(configuration)
    let document
    if(action==='install') {
      if(values.length!==1)fail('EXTENSION_ARGUMENTS_INVALID')
      document=await installExtension({source:resolve(options.cwd,values[0]!),configuration,framework:root})
    } else if(['enable','disable','remove'].includes(action)) {
      if(values.length!==1||!extensionId(values[0]))fail('EXTENSION_ARGUMENTS_INVALID')
      const store=createExtensionRegistry(configuration),release=await store.lock()
      try {
        const current=await store.read()
        if(extensionOperationPending(current.value))fail('EXTENSION_OPERATION_PENDING')
        if(!current.value.items.some(item=>item.id===values[0]))fail('EXTENSION_NOT_FOUND')
        const items=action==='remove'?current.value.items.filter(item=>item.id!==values[0]):current.value.items.map(item=>item.id===values[0]?{...item,enabled:action==='enable'}:item)
        document=await store.stage(items)
      } finally {await release()}
    } else fail('EXTENSION_ARGUMENTS_INVALID')
    if('unchanged' in document&&document.unchanged) {
      let observation:ExtensionObservation|undefined
      try{observation=await observer(configuration)}catch{ /* Never restart an unchanged installation to manufacture success. */ }
      print({schema:1,stage:'unchanged',runtimeVerified:!!observation&&extensionObservationMatches(document.value.items,observation)})
      return 0
    }
    if(flags.has('--stage')||!admin.serviceManager) {
      print({schema:1,stage:'registered',runtimeVerified:false,operation:document.value.operation,next:'extensions apply <操作编号> 或在启动本配置后 extensions reconcile <操作编号>'});return 0
    }
    const op=await apply(configuration,document.value.operation?.id);print({schema:1,operation:op});return op?.phase==='completed'?0:2
  } finally {await releaseMaintenance?.()}
}
