import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer, type Server } from 'node:http'
import { startRepairServices, type RepairServiceStartPorts } from '../scripts/repair-service-start.ts'

async function fixture(permanentlyUnhealthy = false) {
  const servers = new Map<string, Server>()
  const addresses = new Map<string, string>()
  const events: string[] = []
  async function check(id: string, path = '/health') {
    const address = addresses.get(id)
    if (!address) return false
    try {
      const response = await fetch(address + path, { signal: AbortSignal.timeout(200) })
      await response.body?.cancel()
      return response.ok
    } catch { return false }
  }
  async function launch(id: string) {
    if (servers.has(id)) return
    const server = createServer(async (request, response) => {
      const healthy = request.url === '/ping' || (id === 'framework-admin' ? await check('framework-gateway')
        : id === 'framework-gateway' ? !permanentlyUnhealthy && await check('framework-admin', '/ping') : true)
      response.writeHead(healthy ? 200 : 503).end()
    })
    servers.set(id, server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert(address && typeof address !== 'string')
    addresses.set(id, `http://127.0.0.1:${address.port}`)
  }
  const ports: RepairServiceStartPorts = {
    async bootstrapAdministrator() {
      await launch('framework-admin')
      assert.equal(await check('framework-admin', '/ping'), true)
      assert.equal(await check('framework-admin'), false)
      events.push('admin-listener-before-gateway')
    },
    async start(id) {
      await launch(id)
      events.push(`start:${id}`)
      // A transient phase failure must not survive a later successful complete health pass.
      if (id === 'dsh') throw new Error('fixture transient start observation')
    },
    async ready(id) { events.push(`full:${id}`); return check(id) },
    pending(id) { events.push(`pending:${id}`) }
  }
  return { ports, events, check, async close() {
    await Promise.all([...servers.values()].map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) })))
  } }
}
test('two-stage repair resolves real admin/gateway HTTP health dependency cycle and drops stale phase failures', async () => {
  const setup = await fixture()
  try {
    await startRepairServices(['framework-admin', 'dsh', 'framework-gateway'], Date.now() + 3000, setup.ports, 10)
    assert.equal(setup.events[0], 'admin-listener-before-gateway')
    assert(setup.events.includes('pending:dsh'))
    assert(setup.events.indexOf('start:framework-gateway') > setup.events.indexOf('pending:dsh'))
    for (const id of ['framework-admin', 'dsh', 'framework-gateway']) assert.equal(await setup.check(id), true)
  } finally { await setup.close() }
})
test('a listening administrator never replaces final full health when a dependency remains unhealthy', async () => {
  const setup = await fixture(true)
  try {
    await assert.rejects(startRepairServices(['framework-admin', 'dsh', 'framework-gateway'], Date.now() + 300, setup.ports, 10), /部分受管服务尚未恢复/)
    assert.equal(await setup.check('framework-admin', '/ping'), true)
    assert.equal(await setup.check('framework-admin'), false)
    assert(setup.events.includes('start:framework-gateway'))
  } finally { await setup.close() }
})
