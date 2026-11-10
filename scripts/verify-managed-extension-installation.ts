import assert from 'node:assert/strict'
import { mkdtemp,mkdir,readFile,readdir,rm,writeFile } from 'node:fs/promises'
import {dirname,join} from 'node:path'
import {execFileSync} from 'node:child_process'
import {createExtensionRegistry} from '../src/host/managed-extensions.ts'
import {loadSelectedNativeBootstrap} from './bootstrap-loader.ts'
import {managedExtensionCli} from './managed-extension-cli.ts'
import {runCli} from './cli.ts'

/** The SDK job prepares the real package first; ordinary source tests require no SDK build or network. */
export async function verifyManagedExtensionInstallation(root:string):Promise<void> {
  const parent=join(root,'private/maintenance/sdk-installation-checks')
  await mkdir(parent,{recursive:true,mode:0o700})
  const directory=await mkdtemp(join(parent,'case-'))
  try {
    const configuration=join(directory,'admin/config.json'),output:string[]=[],errors:string[]=[]
    assert.equal(await runCli(['init','--config',configuration],{cwd:directory,env:{},stdout:x=>output.push(x),stderr:x=>errors.push(x)}),0,errors.join('\n'))
    const project=join(directory,'source'),io={cwd:directory,env:{},framework:root,output:(value:string)=>output.push(value)}
    assert.equal(await managedExtensionCli(['init',project,'--id','sample-status','--config',configuration],io),0)
    const original=await readFile(join(project,'index.ts'))
    assert.equal(await managedExtensionCli(['install',project,'--config',configuration,'--stage'],io),0)
    const saved=await createExtensionRegistry(configuration).read(),item=saved.value.items[0];assert(item)
    assert.equal(saved.value.operation?.phase,'prepared');assert.equal(item.id,'sample-status')
    assert.deepEqual(await readFile(join(project,'index.ts')),original)
    const sdk:unknown=JSON.parse(await readFile(join(item.directory,'node_modules/@qq-bridge-framework/sdk/package.json'),'utf8'))
    const framework:unknown=JSON.parse(await readFile(join(root,'package.json'),'utf8'))
    assert(sdk&&typeof sdk==='object'&&'version' in sdk&&framework&&typeof framework==='object'&&'version' in framework&&sdk.version===framework.version)
    const loaded=await loadSelectedNativeBootstrap(configuration);assert.equal(loaded?.metadata.managedExtensions?.items[0]?.id,item.id)
    const lock=JSON.parse(await readFile(join(item.directory,'package-lock.json'),'utf8')) as {packages:Record<string,{integrity?:string}>}
    assert(lock.packages['node_modules/@qq-bridge-framework/sdk']?.integrity)
    // Seed a terminal receipt only in this offline registry fixture; actual runtime/model proof is separate.
    const registry=createExtensionRegistry(configuration)
    assert(saved.value.operation)
    const release=await registry.lock()
    try {await registry.write(saved.revision,{...saved.value,operation:{...saved.value.operation,phase:'completed'}})} finally {await release()}
    const before=await registry.read()
    assert.equal(await managedExtensionCli(['install',project,'--config',configuration,'--stage'],io),0)
    assert.equal((JSON.parse(output.at(-1)!) as {stage:string}).stage,'unchanged')
    assert.equal((await registry.read()).revision,before.revision)
    await writeFile(join(project,'index.ts'),'//'+ 'x'.repeat(262144)+'\n'+original.toString(),{mode:0o600})
    await assert.rejects(managedExtensionCli(['install',project,'--config',configuration,'--stage'],io),{code:'EXTENSION_SOURCE_INVALID'})
    assert.equal((await registry.read()).revision,before.revision)
    await writeFile(join(project,'index.ts'),original,{mode:0o600})
    console.log('Managed extension CLI scaffold installed the matching real SDK, passed strict checking and preserved source files.')
  } catch(error) {
    // Only this generated fixture's bounded diagnostics enter CI logs; user installations keep their logs private.
    const logs=join(directory,'admin/extensions/install-logs')
    for(const name of (await readdir(logs).catch(()=>[])).sort().slice(0,8)) {
      console.error(`SDK installation fixture ${name}:\n${(await readFile(join(logs,name),'utf8')).slice(-8192)}`)
    }
    if(process.platform==='win32') {
      for(let parent=directory,depth=0;depth<32;depth++) {
        console.error(execFileSync(join(process.env.SystemRoot??'C:/Windows','System32/icacls.exe'),[parent],{encoding:'utf8',maxBuffer:16384}).slice(-8192))
        const next=dirname(parent);if(next===parent)break;parent=next
      }
    }
    throw error
  } finally {await rm(directory,{recursive:true,force:true})}
}
