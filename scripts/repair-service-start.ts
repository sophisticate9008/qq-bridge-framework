export interface RepairServiceStartPorts {
  bootstrapAdministrator(deadline: number): Promise<void>
  start(id: string, deadline: number): Promise<void>
  ready(id: string, deadline: number): Promise<boolean>
  pending(id: string): void
}

/** A management listener breaks dependency cycles; only the final full health pass can complete recovery. */
export async function startRepairServices(targets: readonly string[], deadline: number, ports: RepairServiceStartPorts, pollMs = 500): Promise<void> {
  try { await ports.bootstrapAdministrator(Math.min(deadline, Date.now() + 45_000)) }
  catch { ports.pending('framework-admin') }
  for (const id of targets.filter(id => id !== 'framework-admin')) {
    try { await ports.start(id, Math.min(deadline, Date.now() + 45_000)) }
    catch { ports.pending(id) }
  }
  const checks = ['framework-admin', ...targets.filter(id => id !== 'framework-admin')]
  while (Date.now() < deadline) {
    const results = await Promise.all(checks.map(async id => {
      try { return await ports.ready(id, deadline) } catch { return false }
    }))
    if (results.every(Boolean)) return
    await new Promise<void>(resolve => setTimeout(resolve, Math.min(pollMs, Math.max(0, deadline - Date.now()))))
  }
  throw new Error('部分受管服务尚未恢复，管理页面可查看恢复状态。')
}
