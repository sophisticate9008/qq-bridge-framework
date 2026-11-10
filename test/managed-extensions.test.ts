import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { managedExtensionCli } from '../scripts/managed-extension-cli.ts'
import { acquireProcessFileLock } from '../src/storage/process-file-lock.ts'
import { createExtensionRegistry, applyExtensionOperation, extensionSetRevision, readExtensionOperation,
  type ExtensionObservation } from '../src/host/managed-extensions.ts'
import { parseExtensionManifest, type ManagedExtension } from '../src/contracts/managed-extensions.ts'
import { loadSelectedNativeBootstrap } from '../scripts/bootstrap-loader.ts'
import { createContextStore } from '../src/core/context.ts'
import { createSqliteStore } from '../src/storage/sqlite.ts'
import { readNativeBootstrapContent } from '../scripts/bootstrap-content.ts'

const codeRoot=resolve(import.meta.dirname,'..')
const root=basename(codeRoot)==='dist'?dirname(codeRoot):codeRoot
async function fixture(t:TestContext) {
  const parent=join(root,'private/maintenance/extension-manager-20261110/tests');await mkdir(parent,{recursive:true,mode:0o700})
  const directory=await mkdtemp(join(parent,'case-'));t.after(()=>rm(directory,{recursive:true,force:true}))
  const configuration=join(directory,'admin.json');await writeFile(configuration,'{}\n',{mode:0o600})
  return {directory,configuration,store:createExtensionRegistry(configuration)}
}
function entry(directory:string):ManagedExtension {
  return {schema:1,id:'document-test',version:'1.0.0',displayName:'Document test',entry:'index.ts',files:['index.ts','package.json'],packages:['document-test'],
    revision:'1'.repeat(64),fingerprint:'2'.repeat(64),directory,enabled:true}
}
function observed(items:readonly ManagedExtension[],running=true):ExtensionObservation {
  return {registryRevision:extensionSetRevision(items),running,packages:items.filter(item=>item.enabled).flatMap(item=>item.packages.map(id=>({id,state:'running',toolNames:[`extension.${id}.status`]}))),
    tools:items.filter(item=>item.enabled).flatMap(item=>item.packages.map(id=>`extension.${id}.status`)),services:[]}
}
async function stage(f:Awaited<ReturnType<typeof fixture>>,items:readonly ManagedExtension[]) {
  const release=await f.store.lock();try{return await f.store.stage(items)}finally{await release()}
}

test('extension manifests reject traversals, credential files, duplicate packages and undeclared entries',()=>{
  const input={schema:1,id:'document-test',version:'1.0.0',displayName:'Test',entry:'index.ts',files:['index.ts','package.json'],packages:['document-test']}
  assert(parseExtensionManifest(input))
  assert(parseExtensionManifest({...input,files:['index.ts','tokenizer.ts','package.json']}))
  for(const file of ['../index.ts','node_modules/code.ts','secrets.json','nested/.env','api-token.json','state.sqlite-wal','id_ed25519','C:/index.ts','CON.ts','nested/file.','Data/code.ts'])assert.equal(parseExtensionManifest({...input,files:[file,'package.json']}),null)
  assert.equal(parseExtensionManifest({...input,files:['index.ts','INDEX.ts','package.json']}),null)
  assert.equal(parseExtensionManifest({...input,id:'nul'}),null)
  assert.equal(parseExtensionManifest({...input,entry:'src/index.ts',files:['src/index.ts','package.json']}),null)
  assert.equal(parseExtensionManifest({...input,packages:['document-test','document-test']}),null)
  assert.equal(parseExtensionManifest({...input,extra:'unexpected'}),null)
})

test('a lost restart stays unknown, blocks new writes and reconciles without restarting again',async t=>{
  const f=await fixture(t),item=entry(f.directory),staged=await stage(f,[item]);let restarts=0
  const unknown=await applyExtensionOperation(f.configuration,{async restart(){restarts++;return 'unknown'},async observe(){throw Error('Must not assume a failed observation proves rejection')}})
  assert.equal(unknown?.phase,'unknown');assert.equal(restarts,1)
  await assert.rejects(stage(f,[]),{code:'EXTENSION_OPERATION_PENDING'})
  await assert.rejects(applyExtensionOperation(f.configuration,{async restart(){throw Error('Do not repeat restart')},async observe(){return observed([])}},staged.value.operation!.id,true),{code:'EXTENSION_OPERATION_UNKNOWN'})
  await assert.rejects(applyExtensionOperation(f.configuration,{async restart(){throw Error('No replay')},async observe(){return observed([item])}},staged.value.operation!.id,true),{code:'EXTENSION_OPERATION_UNKNOWN'})
  const done=await applyExtensionOperation(f.configuration,{async restart(){throw Error('Do not repeat restart')},async observe(){return {...observed([item]),operationId:staged.value.operation!.id}}},staged.value.operation!.id,true)
  assert.equal(done?.phase,'completed');assert.equal(restarts,1)
  const removed=await stage(f,[])
  assert.equal((await readExtensionOperation(f.configuration,staged.value.operation!.id))?.phase,'completed')
  assert.notEqual(removed.value.operation?.id,staged.value.operation?.id)
})

test('reconciling an unapplied prepared selection keeps it staged while the old host is running',async t=>{
  const f=await fixture(t),item=entry(f.directory),saved=await stage(f,[item])
  const result=await applyExtensionOperation(f.configuration,{async restart(){throw Error('Reconcile does not restart')},async observe(){return observed([])}},saved.value.operation!.id,true)
  assert.equal(result?.phase,'prepared');assert.deepEqual((await f.store.read()).value.items,[item])
})

test('a confirmed failed candidate restores the previous selection and restarts it once',async t=>{
  const f=await fixture(t),item=entry(f.directory);await stage(f,[item]);let restarts=0
  const result=await applyExtensionOperation(f.configuration,{async restart(){restarts++;return 'confirmed'},async observe(){return restarts===1?observed([item],false):observed([])}})
  assert.equal(result?.phase,'rolled-back');assert.equal(restarts,2);assert.deepEqual((await f.store.read()).value.items,[])
})

test('an interrupted rollback never reactivates the candidate based on stale after evidence',async t=>{
  const f=await fixture(t),item=entry(f.directory);await stage(f,[item]);let restarts=0
  const failed=await applyExtensionOperation(f.configuration,{async restart(){return ++restarts===1?'confirmed':'unknown'},async observe(){return observed([item],false)}})
  assert.equal(failed?.phase,'unknown');assert.deepEqual((await f.store.read()).value.items,[])
  await assert.rejects(applyExtensionOperation(f.configuration,{async restart(){throw Error('Never replay unknown rollback')},async observe(){return {...observed([item]),operationId:failed!.id}}},failed!.id,true),{code:'EXTENSION_OPERATION_UNKNOWN'})
  assert.deepEqual((await f.store.read()).value.items,[])
  const restored=await applyExtensionOperation(f.configuration,{async restart(){throw Error('No restart needed')},async observe(){return {...observed([]),operationId:failed!.id}}},failed!.id,true)
  assert.equal(restored?.phase,'rolled-back')
})

test('missing service publication or an undeclared tool prevents runtime verification',async t=>{
  const f=await fixture(t),item=entry(f.directory);await stage(f,[item]);let restarts=0
  const result=await applyExtensionOperation(f.configuration,{async restart(){restarts++;return 'confirmed'},async observe(){
    if(restarts===1)return {...observed([item]),services:[{owner:'document-test',state:'unavailable'}]}
    return observed([])
  }})
  assert.equal(result?.phase,'rolled-back')
  await stage(f,[item]);restarts=0
  const tools=await applyExtensionOperation(f.configuration,{async restart(){restarts++;return 'confirmed'},async observe(){
    return restarts===1?{...observed([item]),tools:[`extension.${item.id}.status`,`extension.${item.id}.undeclared`]}:observed([])
  }})
  assert.equal(tools?.phase,'rolled-back')
})

test('managed package composition preserves base identity and rejects dependency source tampering before import',async t=>{
  const f=await fixture(t),base=join(f.directory,'base.ts')
  const manifest={schema:1 as const,id:'document-test',version:'1.0.0',displayName:'Test',entry:'index.ts',files:['index.ts','helper.ts','package.json'],packages:['document-test']}
  const candidate=join(f.directory,'staged');await mkdir(candidate,{mode:0o700})
  const code="import {version} from './helper.ts'; export default {manifest:{id:'document-test',version:'1.0.0',apiVersion:1},create(){return {packages:[{manifest:{schema:1,id:'document-test',version,displayName:'Test',description:'Fixture',toolNames:[],dependencies:[],provides:[],requires:[],contributions:[]}}]}}}\n"
  await writeFile(join(candidate,'index.ts'),code,{mode:0o600});await writeFile(join(candidate,'helper.ts'),"export const version='1.0.0'\n",{mode:0o600})
  await writeFile(join(candidate,'package.json'),'{"type":"module"}\n',{mode:0o600})
  await writeFile(join(candidate,'index.ts.manifest.json'),JSON.stringify({schema:1,entry:'index.ts',dependencies:[]}),{mode:0o600})
  const content=await readNativeBootstrapContent(join(candidate,'index.ts'),AbortSignal.timeout(5000));assert(content)
  const parent=join(f.directory,'extensions/document-test');await mkdir(parent,{recursive:true,mode:0o700})
  const directory=join(parent,content.identity.fingerprint)
  const {rename}=await import('node:fs/promises');await rename(candidate,directory)
  const item={...manifest,revision:content.identity.fingerprint,directory,fingerprint:createHash('sha256').update(code).digest('hex'),enabled:true}
  await writeFile(base,"export default {manifest:{id:'existing',version:'1.0.0',apiVersion:1},create(){return {packages:[{manifest:{schema:1,id:'existing',version:'1.0.0',displayName:'Base',description:'Existing package',toolNames:[],dependencies:[],requires:[],provides:[],contributions:[]}}]}}}\n",{mode:0o600})
  const {loadNativeBootstrap}=await import('../scripts/bootstrap-loader.ts'),original=await loadNativeBootstrap(base)
  await writeFile(`${f.configuration}.bootstrap.json`,JSON.stringify({schema:1,filename:base,fingerprint:original.metadata.codeFingerprint}),{mode:0o600})
  const selection=await readFile(`${f.configuration}.bootstrap.json`)
  await stage(f,[item]);const loaded=await loadSelectedNativeBootstrap(f.configuration);assert(loaded)
  const store=createSqliteStore({filename:':memory:'});t.after(()=>store.close())
  const context=createContextStore();const persona=context.registerPersona({id:'test',version:'1',name:'Test',identity:{},style:{}})
  const extension=await loaded.create({directory:f.directory,store,context,persona,signal:AbortSignal.timeout(5000)})
  assert.deepEqual(extension.packages?.map(p=>p.manifest.id),['existing','document-test'])
  assert.equal(loaded.contentForPackage?.('existing')?.identity.fingerprint,original.metadata.codeFingerprint)
  assert.equal(loaded.contentForPackage?.('document-test')?.identity.fingerprint,item.revision)
  assert.deepEqual(await readFile(`${f.configuration}.bootstrap.json`),selection)
  await writeFile(join(directory,'helper.ts'),"export const version='2.0.0'\n",{mode:0o600})
  await assert.rejects(loadSelectedNativeBootstrap(f.configuration),{code:'NATIVE_PACKAGE_PROCESS_RESTART_REQUIRED'})
  const loader=new URL(import.meta.url.endsWith('.js')?'../scripts/bootstrap-loader.js':'../scripts/bootstrap-loader.ts',import.meta.url)
  const fresh=spawnSync(process.execPath,['--input-type=module','-e',`import {loadSelectedNativeBootstrap} from ${JSON.stringify(loader.href)};try{await loadSelectedNativeBootstrap(process.argv[1]);process.exitCode=3}catch(error){console.log(error.code)}`,f.configuration],{cwd:root,encoding:'utf8',timeout:15000})
  assert.equal(fresh.status,0,fresh.stderr);assert.match(fresh.stdout,/NATIVE_PACKAGE_CONTENT_CHANGED/)
})


test('extension writes share product maintenance exclusion and reject unresolved updates before preparing code',async t=>{
  const f=await fixture(t),product=join(f.directory,'data/product-updates'),id=randomUUID()
  await mkdir(product,{recursive:true,mode:0o700})
  await writeFile(join(product,'current.json'),JSON.stringify(id),{mode:0o600})
  await writeFile(join(product,`${id}.json`),JSON.stringify({schema:1,id,from:'2.0.0',to:'2.0.1',bridgeBefore:null,
    bridgeOperationId:randomUUID(),restoreOperationId:randomUUID(),runtimeTransactionId:randomUUID(),wasRunning:true,phase:'unknown',error:null}),{mode:0o600})
  const io={cwd:f.directory,env:{},framework:f.directory,output(){throw Error('No success output')}}
  await assert.rejects(managedExtensionCli(['install','missing-source','--config',f.configuration],io),{code:'EXTENSION_PRODUCT_MAINTENANCE_PENDING'})
  assert.equal((await f.store.read()).exists,false)
  await rm(join(product,'current.json'))
  const release=await acquireProcessFileLock(product,'operation.lock')
  try {await assert.rejects(managedExtensionCli(['install','missing-source','--config',f.configuration],io),{code:'EXTENSION_MAINTENANCE_BUSY'})}finally{await release()}
  // Failed preconditions release the maintenance lock and do not turn invalid configuration into a staged operation.
  await assert.rejects(managedExtensionCli(['install','missing-source','--config',f.configuration],io))
  assert.equal((await f.store.read()).exists,false)
  const again=await acquireProcessFileLock(product,'operation.lock');await again()
})
