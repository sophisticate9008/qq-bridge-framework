import assert from 'node:assert/strict'
import test, {type TestContext} from 'node:test'
import {createSqliteStore} from '../src/storage/sqlite.ts'
import {createNativeWorkFailureNotifier, type WorkFailureNotice} from '../src/host/native-work-failure-notices.ts'
import {awaitCondition} from './fixtures/await-condition.ts'
import {digest,object} from '../src/host/data.ts'

function fixture(context: TestContext) {
  const store=createSqliteStore({filename:':memory:'}),controller=new AbortController()
  context.after(()=>{controller.abort();store.close()})
  const put=(changes:Record<string,string|null>={})=>{const prior=store.read('native-work.executions','work-1');return store.write('native-work.executions','work-1',{
    schema:1,id:'work-1',runId:'run-1',ownerId:'123',childId:'child-1',parentSessionId:'parent-1',conversationId:'group:456',generation:1,
    status:'unknown',createdAt:1,deadlineAt:2,result:null,lateResult:null,delivery:'not-requested',lastError:'WORK_RESULT_UNKNOWN',
    progress:[{id:'assistant/message:seq:1',at:1,text:'正在检查 PDF 文件。'}],...changes},{expectedRevision:prior?.revision??null})}
  put()
  const notices:WorkFailureNotice[]=[]
  const create=(changes:Partial<Parameters<typeof createNativeWorkFailureNotifier>[0]>={})=>createNativeWorkFailureNotifier({store,signal:controller.signal,
    current:()=>true,deliver:async notice=>{notices.push(notice);return{status:'confirmed',messageId:'qq-1'}},...changes})
  return{store,controller,put,notices,create}
}
const settled=async(f:ReturnType<typeof fixture>)=>awaitCondition(()=>f.store.list('native-work.failure-notices').some(r=>!['pending','sending'].includes(String(object(r.value).status))),{timeoutMs:2000,message:'Failure notice must settle'})

test('unknown work notifies the original group owner once without model generation or rewriting work evidence',async context=>{
  const f=fixture(context),before=f.store.read('native-work.executions','work-1'),notifier=f.create()
  notifier.observe('work-1');notifier.observe('work-1');await settled(f)
  assert.equal(f.notices.length,1)
  assert.deepEqual(f.notices[0]!.content[0],{type:'mention',userId:'123'})
  assert.equal(f.notices[0]!.work.conversationId,'group:456')
  const body=JSON.stringify(f.notices[0]!.content)
  assert.match(body,/执行中断/);assert.match(body,/不代表已完成/);assert.match(body,/没有自动重新提交/)
  assert.doesNotMatch(body,/WORK_RESULT_UNKNOWN|token|https:/)
  assert.deepEqual(f.store.read('native-work.executions','work-1'),before)
  await notifier.recover();await f.create().recover();assert.equal(f.notices.length,1)
})

test('private task failures and deadlines are clear and do not duplicate existing result delivery',async context=>{
  const f=fixture(context);f.put({status:'failed',conversationId:'private:123',lastError:'NATIVE_WORK_TIMEOUT_UNKNOWN'})
  const notifier=f.create();notifier.observe('work-1');await settled(f)
  assert(f.notices[0]!.content.every(p=>p.type!=='mention'));assert.match(JSON.stringify(f.notices[0]!.content),/超过本次时间限制/)
  f.put({runId:'run-2',status:'failed',delivery:'confirmed'});notifier.observe('work-1')
  assert.equal(f.store.list('native-work.failure-notices').length,1)
})

test('uncertain notice delivery survives restart without sending again',async context=>{
  const f=fixture(context),notifier=f.create({deliver:async notice=>{f.notices.push(notice);return{status:'unknown'}}})
  notifier.observe('work-1');await settled(f);await f.create().recover()
  assert.equal(f.notices.length,1);assert.equal(object(f.store.list('native-work.failure-notices')[0]!.value).status,'unknown')
})

test('withdrawn owner, replaced binding and new run prevent stale notifications',async context=>{
  const f=fixture(context),notifier=f.create({current:()=>false})
  notifier.observe('work-1');await settled(f);assert.equal(f.notices.length,0)
  assert.equal(object(f.store.list('native-work.failure-notices')[0]!.value).status,'rejected')
  f.put({runId:'run-2',status:'running'});notifier.observe('work-1');assert.equal(f.store.list('native-work.failure-notices').length,1)
  f.put({runId:'run-2',status:'unknown'});f.create().observe('work-1')
  await awaitCondition(()=>f.notices.length===1,{timeoutMs:2000,message:'A distinct interrupted run has its own notice'})
})

test('notification failure never leaks raw errors or causes a task retry',async context=>{
  const f=fixture(context),notifier=f.create({deliver:async notice=>{f.notices.push(notice);throw new Error('private-token-should-not-be-persisted')}})
  notifier.observe('work-1');await settled(f);await f.create().recover()
  assert.equal(f.notices.length,1);assert.doesNotMatch(JSON.stringify(f.store.list('native-work.failure-notices')),/private-token/)
  assert.equal(object(f.store.read('native-work.executions','work-1')!.value).status,'unknown')
})

test('an interrupted sending record is sealed unknown on recovery and never replayed',async context=>{
  const f=fixture(context)
  const key=digest(['work-1','run-1'])
  f.store.write('native-work.failure-notices',key,{schema:1,id:key,workId:'work-1',runId:'run-1',ownerId:'123',status:'sending',createdAt:1},{expectedRevision:null})
  const notifier=f.create()
  await notifier.recover();await settled(f)
  assert.equal(object(f.store.read('native-work.failure-notices',key)!.value).status,'unknown')
  assert.equal(f.notices.length,0)
})
