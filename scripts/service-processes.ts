export interface ServiceProcessIdentity {
  readonly pid: number;
  readonly parent: number;
  readonly session: number;
  readonly started: string;
}

/** A detached maintenance session must survive stopping its former parent service. */
export function selectServiceProcesses(all: readonly ServiceProcessIdentity[], roots: readonly number[], controllerSession: number): ServiceProcessIdentity[] {
  const included = new Set(roots);
  const protectedPids = new Set(all.filter(item => item.session === controllerSession).map(item => item.pid));
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of all) {
      if (included.has(item.parent) && !included.has(item.pid)) { included.add(item.pid); changed = true; }
      if (protectedPids.has(item.parent) && !protectedPids.has(item.pid)) { protectedPids.add(item.pid); changed = true; }
    }
  }
  return all.filter(item => included.has(item.pid) && !roots.includes(item.pid) && !protectedPids.has(item.pid));
}
