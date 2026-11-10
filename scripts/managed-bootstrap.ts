import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { FrameworkError } from '../src/core/values.ts'
import { readExtensionRegistry, extensionSetRevision, extensionStore } from '../src/host/managed-extensions.ts'
import type { LoadedNativeBootstrap, NativeBootstrapContext } from '../src/host/native-bootstrap.ts'
import type { NativePackageContent } from '../src/host/native-package-content.ts'
import { loadNativeBootstrap } from './bootstrap-loader.ts'

/** Managed packages are additive; the original operator bootstrap remains unchanged. */
export async function loadManagedBootstrap(configuration: string, base?: LoadedNativeBootstrap): Promise<LoadedNativeBootstrap | undefined> {
  const registry = await readExtensionRegistry(configuration)
  const items = registry.value.items.filter(item => item.enabled)
  if (!items.length && !registry.exists) return base
  const loaded: { item: typeof items[number]; bootstrap: LoadedNativeBootstrap }[] = []
  for (const item of items) {
    const expected = join(extensionStore(configuration), item.id, item.revision)
    if (resolve(item.directory) !== expected) throw new FrameworkError('EXTENSION_DIRECTORY_INVALID', '扩展版本不属于当前安装。')
    const bootstrap = await loadNativeBootstrap(join(expected, item.entry), { expectedFingerprint: item.fingerprint,expectedContentFingerprint:item.revision })
    if (bootstrap.metadata.manifest.id !== item.id || bootstrap.metadata.manifest.version !== item.version
      || bootstrap.metadata.contentIdentity?.coverage !== 'package-tree-and-dependency-locks-v1') {
      throw new FrameworkError('EXTENSION_CONTENT_UNVERIFIED', '扩展身份或完整源码与依赖锁未通过校验。')
    }
    loaded.push({ item, bootstrap })
  }
  const contents = new Map<string, NativePackageContent>()
  const content = (bootstrap: LoadedNativeBootstrap): NativePackageContent => ({
    identity: bootstrap.metadata.contentIdentity ?? { fingerprint: bootstrap.metadata.codeFingerprint, coverage: 'entry-only', files: 1 },
    verify: signal => bootstrap.verifyContent?.(signal) ?? Promise.resolve(),
  })
  const all = [...(base ? [base] : []), ...loaded.map(row => row.bootstrap)]
  for (const row of loaded) for (const id of row.item.packages) contents.set(id,content(row.bootstrap))
  const fingerprint = createHash('sha256').update(JSON.stringify(all.map(row => row.metadata.codeFingerprint))).update(extensionSetRevision(registry.value.items)).digest('hex')
  return {
    metadata: { manifest: { id: base?.metadata.manifest.id ?? 'managed-extensions', version: base?.metadata.manifest.version ?? '1.0.0', apiVersion: 1 },
      codeFingerprint: fingerprint, trust: 'trusted-operator-code', sandboxed: false, requiresSeparateAuthorization: true,
      contentIdentity: { fingerprint, coverage: all.every(row => row.metadata.contentIdentity?.coverage === 'package-tree-and-dependency-locks-v1')
        ? 'package-tree-and-dependency-locks-v1' : 'entry-only', files: all.reduce((sum,row) => sum + (row.metadata.contentIdentity?.files ?? 1),0) },
      managedExtensions: { operationId: registry.value.operation?.id ?? null, revision: extensionSetRevision(registry.value.items), items: registry.value.items.map(item => ({ id: item.id, revision: item.revision, enabled: item.enabled, packages: item.packages })) } },
    packageConfigurations: all.flatMap(row => row.packageConfigurations ?? []),
    controlCommands: all.flatMap(row => row.controlCommands ?? []), lifecycleHooks: all.flatMap(row => row.lifecycleHooks ?? []),
    contentForPackage: id => contents.get(id),
    async verifyContent(signal) { for (const row of all) await row.verifyContent?.(signal) },
    async create(context: Readonly<NativeBootstrapContext>) {
      const current = await readExtensionRegistry(configuration)
      if (extensionSetRevision(current.value.items) !== extensionSetRevision(registry.value.items)) throw new FrameworkError('EXTENSION_SELECTION_CHANGED','扩展登记已改变，请重新应用当前配置。')
      const original = base ? await base.create(context) : {}
      const packages = [...(original.packages ?? [])]
      if (base) for (const definition of packages) {
        if (loaded.some(row=>row.item.packages.includes(definition.manifest.id))) throw new FrameworkError('EXTENSION_PACKAGE_CONFLICT','扩展与已有装配的功能包标识冲突。')
        contents.set(definition.manifest.id, base.contentForPackage?.(definition.manifest.id) ?? content(base))
      }
      const seen = new Set(packages.map(definition=>definition.manifest.id))
      for (const { item, bootstrap } of loaded) {
        const extension = await bootstrap.create(context)
        if (Object.keys(extension).some(key => key !== 'packages')) throw new FrameworkError('EXTENSION_PACKAGE_ONLY', '受管扩展请通过 SDK 功能包注册工具、服务与生命周期。')
        const added = extension.packages ?? []
        if (added.some(row=>!row.manifest.displayName||!row.manifest.description||!Array.isArray(row.manifest.toolNames))) {
          throw new FrameworkError('EXTENSION_METADATA_REQUIRED','受管扩展的每个功能包需声明名称、用途和完整工具清单。')
        }
        if (JSON.stringify(added.map(row => row.manifest.id).sort()) !== JSON.stringify([...item.packages].sort())) {
          throw new FrameworkError('EXTENSION_PACKAGE_MISMATCH', '实际功能包与扩展清单声明不一致。')
        }
        for (const definition of added) {
          if (seen.has(definition.manifest.id)) throw new FrameworkError('EXTENSION_PACKAGE_CONFLICT', '扩展与已有装配的功能包标识冲突。')
          seen.add(definition.manifest.id); packages.push(definition)
        }
      }
      return { ...original, packages }
    },
  }
}
