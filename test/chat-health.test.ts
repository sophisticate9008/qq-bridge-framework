import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { CHAT_HEALTH_LAYERS, chatHealthChecks, parseChatHealth, type ChatHealth } from '../src/contracts/chat-health.ts';
import { probeOneBotHttpHealth } from '../src/adapters/onebot-health.ts';
import { chatHealthBadge, chatHealthGuidance } from '../web/lib/chat-health.ts';
import type { ChatRuntimeStatus } from '../web/lib/chat-runtime.ts';

const runtime: ChatRuntimeStatus = { state: 'running', chatReady: true, canStart: false, canApplyDeployment: false,
  protocolConnected: true, missingReasons: [], blockingReasons: [], revisions: {}, configurationChanged: false,
  lastError: null, readinessScope: null, modelExecutionVerified: false };
const ready: ChatHealth = { schema: 1, checkedAt: 1, healthy: true, modelExecutionVerified: false,
  layers: CHAT_HEALTH_LAYERS.map(id => ({ id, state: 'ready', reason: null })) };

test('optional assistant health preserves legacy layers and prevents false overall readiness', () => {
  const blocked: ChatHealth = { ...ready, healthy: false, assistant: {
    id: 'assistant', state: 'unavailable', reason: 'assistant_deployment_configuration_changed' } };
  assert(parseChatHealth(ready));
  assert(parseChatHealth(blocked));
  assert.equal(blocked.layers.length, 7);
  assert.equal(chatHealthChecks(blocked).length, 8);
  assert.equal(parseChatHealth({ ...blocked, healthy: true }), null);
  assert.equal(parseChatHealth({ ...blocked, assistant: { ...blocked.assistant, reason: '/private/key' } }), null);
  assert.equal(chatHealthBadge(blocked, runtime), '后台助手需要恢复');
  assert.match(chatHealthGuidance(blocked.assistant!), /助手部署需要更新/);
  assert(parseChatHealth({ ...ready, assistant: { id: 'assistant', state: 'idle', reason: 'assistant_disabled' } }));
});

test('chat readiness never treats an assembled host as proof of a working external path', () => {
  assert.equal(chatHealthBadge(ready, runtime), '聊天链路就绪');
  assert.equal(chatHealthBadge(null, runtime), '聊天链路待检查');
  for (const [id, title] of [['dsh', '等待 DSH 连接恢复'], ['send', 'HTTP 发送接口异常'], ['tools', '工具通道需要恢复']] as const) {
    const changed: ChatHealth = { ...ready, healthy: false,
      layers: ready.layers.map(layer => layer.id === id ? { ...layer, state: 'unavailable', reason: 'connection_failed' } : layer) };
    assert.equal(chatHealthBadge(changed, runtime), title);
    assert(parseChatHealth(changed));
    assert.equal(parseChatHealth({ ...changed, healthy: true }), null);
  }
  assert.equal(parseChatHealth({ ...ready, layers: ready.layers.map(() => ready.layers[0]) }), null);
  assert.equal(parseChatHealth({ ...ready, layers: ready.layers.map(layer => ({ ...layer, reason: '/private/credential' })) }), null);
  assert.match(chatHealthGuidance({ id: 'dsh', state: 'unavailable', reason: 'timeout' }), /本机受管 DSH.*一键恢复聊天.*远程 DSH.*部署端恢复/);
  assert.match(chatHealthGuidance({ id: 'tools', state: 'recovering', reason: null }), /不重做/);
  assert.match(chatHealthGuidance({ id: 'tools', state: 'unavailable', reason: 'dsh_invalid_response' }), /无法核验.*一键恢复聊天.*未确认.*不重复执行/);
});

test('HTTP health checks only read actions and detects mismatched identities and offline accounts', async context => {
  const actions: string[] = [];
  let account = '123456'; let online = true; let authenticated = true;
  const server = createServer((request, response) => {
    actions.push(request.url ?? ''); request.resume();
    response.setHeader('content-type', 'application/json');
    if (!authenticated) { response.writeHead(401).end('{}'); return; }
    const data = request.url === '/get_status' ? { online, good: true } : { user_id: account };
    response.end(JSON.stringify({ status: 'ok', retcode: 0, data }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address(); assert(address && typeof address !== 'string');
  const adapter = { enabled: true, endpoint: `http://127.0.0.1:${address.port}`, secret: 'synthetic-health-credential' };
  const signal = new AbortController().signal;
  assert.equal((await probeOneBotHttpHealth(adapter, '123456', signal)).state, 'ready');
  account = '654321';
  assert.equal((await probeOneBotHttpHealth(adapter, '123456', signal)).reason, 'http_identity_mismatch');
  online = false;
  assert.equal((await probeOneBotHttpHealth(adapter, '123456', signal)).reason, 'http_account_offline');
  authenticated = false;
  assert.equal((await probeOneBotHttpHealth(adapter, '123456', signal)).reason, 'http_authentication_failed');
  assert(actions.every(action => ['/get_status', '/get_login_info'].includes(action)));
});
