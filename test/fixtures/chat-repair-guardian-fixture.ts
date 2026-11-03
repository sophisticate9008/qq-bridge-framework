import { spawn } from 'node:child_process'
import { appendFile, open, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runChatRepairGuardian } from '../../scripts/chat-repair-guardian.ts'
import { createChatRepairRoutes } from '../../src/admin/chat-repair.ts'
import { createAdminServer } from '../../src/admin/server.ts'

const [mode, directory, id] = process.argv.slice(2)
if (!directory || !id) throw new Error('Invalid isolated fixture arguments')
const token = 'isolated-guardian-fixture-administrator'
const addressFile = join(directory, 'admin-address.json')
if (mode === 'writer') {
  const lease = await open(join(directory, 'writer.lock'), 'r')
  setInterval(() => { void lease.fd }, 1000)
  process.stdout.write('ready\n')
} else if (mode === 'worker') {
  setInterval(() => undefined, 1000)
  process.stdout.write('ready\n')
} else if (mode === 'admin') {
  const server = createAdminServer({ token, snapshot: () => ({}), routes: createChatRepairRoutes({ directory,
    configurationFilename: join(directory, 'admin.json'), serviceManager: join(directory, 'missing-manager') }) })
  server.on('request', request => { void appendFile(join(directory, 'http-effects.jsonl'), JSON.stringify({ path: request.url }) + '\n') })
  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Fixture admin did not listen')
    void writeFile(addressFile, JSON.stringify({ pid: process.pid, url: `http://127.0.0.1:${address.port}` }), { mode: 0o600 })
  })
} else if (mode === 'guardian') {
  await runChatRepairGuardian({ directory, operationId: id, pollMs: 20 }, {
    async ready() {
      const value: unknown = JSON.parse(await readFile(addressFile, 'utf8'))
      if (!value || typeof value !== 'object' || !('url' in value) || typeof value.url !== 'string') return false
      const response = await fetch(`${value.url}/api/chat/repair?id=${id}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1000) })
      await response.body?.cancel()
      return response.ok
    },
    async start() {
      await appendFile(join(directory, 'effects.jsonl'), JSON.stringify({ action: 'start-managed-services' }) + '\n')
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'admin', directory, id], { stdio: 'ignore', detached: false })
      child.unref()
      for (let step = 0; step < 100; step++) {
        try { await readFile(addressFile); return } catch { await new Promise<void>(resolve => setTimeout(resolve, 20)) }
      }
      throw new Error('Isolated admin did not start')
    }
  })
} else throw new Error('Unknown isolated fixture mode')
