import assert from 'node:assert/strict'
import test from 'node:test'
import { createAdminServer, type AdminRoute } from '../src/admin/server.ts'

const routes = (count: number): AdminRoute[] => Array.from({ length: count }, (_, index) => ({
  method: 'GET', pathname: `/api/capacity/route-${index}`, handle: () => ({ ready: true })
}))
test('admin route capacity permits the full framework and recovery surfaces while remaining bounded', () => {
  const server = createAdminServer({ token: 'isolated-route-capacity-administrator', snapshot: () => ({}), routes: routes(256) })
  server.close()
  assert.throws(() => createAdminServer({ token: 'isolated-route-capacity-administrator', snapshot: () => ({}), routes: routes(257) }), /at most 256 entries/)
})
