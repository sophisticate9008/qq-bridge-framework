import type { PluginModelDescription, PluginModelSelection } from '../contracts/plugin-model.ts'
import type { NativeDeploymentPresetBinding } from '../contracts/native-deployment.ts'
import type { NativeModelProvider } from './model-providers.ts'
import type { SessionModelRouteAlias } from './session-model-aliases.ts'

/** Project configured suppliers onto verified live routes; generated routes stay transport details. */
export function buildSessionModelCatalog(providers: readonly Pick<NativeModelProvider, 'id' | 'name' | 'enabled' | 'models'>[],
  bindings: readonly NativeDeploymentPresetBinding[], live: readonly PluginModelDescription[], knownAliases: readonly SessionModelRouteAlias[] = []): readonly PluginModelDescription[] {
  const available = new Set(live.map(item => JSON.stringify([item.provider, item.model])))
  return providers.filter(provider => provider.enabled).flatMap(provider => provider.models.flatMap(model => {
    const routes = bindings.filter(binding => binding.definition.model.provider === provider.id && binding.externalProvider
      && available.has(JSON.stringify([binding.externalProvider, model.id])))
    const direct = available.has(JSON.stringify([provider.id, model.id]))
    const preferred = direct ? provider.id : (routes.find(binding => binding.conversationKind === 'private') ?? routes[0])?.externalProvider
    if (!preferred) return []
    const aliases = [...new Set([...(direct ? [provider.id] : []), ...routes.flatMap(binding => binding.externalProvider ? [binding.externalProvider] : []),
      ...knownAliases.filter(item => item.providerId === provider.id && available.has(JSON.stringify([item.alias, model.id]))).map(item => item.alias)])]
    return [{ provider: preferred, model: model.id, providerName: provider.name, modelName: model.name,
      ...(aliases.some(alias => alias !== preferred) ? { aliases } : {}) }]
  }))
}

export function sessionModelForConversation(model: PluginModelSelection, conversationId: string,
  bindings: readonly NativeDeploymentPresetBinding[]): PluginModelSelection {
  const current = bindings.find(binding => binding.externalProvider === model.provider)
  if (!current) return model
  const kind = conversationId.startsWith('group:') ? 'group' : 'private'
  const target = bindings.find(binding => binding.definition.model.provider === current.definition.model.provider && binding.conversationKind === kind)
  return target?.externalProvider ? { ...model, provider: target.externalProvider } : model
}
