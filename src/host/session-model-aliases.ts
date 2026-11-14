import type { JsonObject } from '../contracts/data.ts'
import type { DshProfileFilePort } from '../contracts/dsh-profile.ts'
import type { NativeChatConfiguration } from './native-chat-configuration.ts'
import type { NativeModelProvider } from './model-providers.ts'
import { modelProviderApi } from './model-provider-protocols.ts'
import { isRecord } from '../contracts/values.ts'

export interface SessionModelRouteAlias { readonly providerId: string; readonly alias: string }
/** Attribute old routes only when endpoint, protocol and credential provenance identify one supplier. */
export async function identifySessionModelAliases(providers: readonly NativeModelProvider[], config: JsonObject,
  match: (candidates: readonly { readonly ref: string; readonly value: string }[]) => Promise<readonly { readonly ref: string; readonly matches: boolean }[]>): Promise<readonly SessionModelRouteAlias[]> {
  if (!isRecord(config.providers)) return []
  const configuredIds = new Set(providers.map(provider => provider.id))
  const routes = Object.entries(config.providers).flatMap(([alias, value]) => isRecord(value)
    && !configuredIds.has(alias)
    && typeof value.baseURL === 'string' && typeof value.api === 'string' && typeof value.apiKeyEnv === 'string'
    ? [{ alias, endpoint: value.baseURL, api: value.api, ref: value.apiKeyEnv }] : [])
  const found = new Map<string, Set<string>>()
  for (const provider of providers) {
    const candidates = routes.filter(route => route.endpoint === provider.baseUrl
      && route.api === modelProviderApi(provider))
    if (!candidates.length || !provider.apiKey) continue
    const refs = [...new Set(candidates.map(route => route.ref))]
    const proof = await match(refs.map(ref => ({ ref, value: provider.apiKey })))
    const matched = new Set(proof.filter(item => item.matches).map(item => item.ref))
    for (const route of candidates) if (matched.has(route.ref)) {
      const suppliers = found.get(route.alias) ?? new Set<string>()
      suppliers.add(provider.id); found.set(route.alias, suppliers)
    }
  }
  return [...found].flatMap(([alias, suppliers]) => suppliers.size === 1 ? [{ alias, providerId: [...suppliers][0]! }] : [])
}

export async function readSessionModelAliases(configuration: NativeChatConfiguration, files: Pick<DshProfileFilePort, 'read' | 'matchCredentials'>) {
  const target = configuration.deployment.target
  if (!target) return []
  const profile = await files.read(target)
  return identifySessionModelAliases(configuration.providers, profile.snapshot.providerConfig,
    candidates => files.matchCredentials(target, profile.snapshot.revision, candidates))
}
