import { createDshUnaryTransport } from './dsh-unary.ts'
import { createDshCallbackBudget } from './dsh-stream-common.ts'
import { createDshSessionFollower } from './dsh-session-follow.ts'
import { createDshInteractionChannel } from './dsh-interactions.ts'
import { snapshot } from '../core/values.ts'
import type { JsonObject, JsonValue } from '../core/types.ts'
import type { ChatSessionDefinition } from '../host/chat-plans.ts'
import { createDshSessionCreator, normalizeDshSessionDefinition, updateDshSessionModel } from './dsh-model-selection.ts'
import { validateAdapterEndpoint } from '../host/adapter-configuration.ts'
import { DshAdapterError } from './dsh.ts'
import type { DshClientPort, DshCreateSessionRequest, DshFollowEvent, DshFollowRequest, DshInteractionConnectionRequest, DshInteractionEvent, DshInteractionPort, DshInteractionResponseRequest, DshPortResult } from './dsh.ts'
import { createDshBridgePluginPort } from './dsh-tool-scope.ts'
import type { DshBridgePluginPort } from './dsh-tool-scope.ts'
import { createDshPluginManagement, type DshPluginManagement } from './dsh-plugin-management.ts'
import { createDshSessionMigrationPort, type DshSessionMigrationPort } from './dsh-session-migration.ts'
import { createDshFrameworkToolPort, type DshFrameworkToolPort, type DshFrameworkToolMethod } from './dsh-framework-tools.ts'
import { createDshWorkPort, dshWorkRpcError, type DshWorkPort, type DshWorkMethod } from './dsh-work.ts'
import { prepareDshPromptContent, type DshPromptImageResolver } from './dsh-prompt-content.ts'
import { createDshPluginModelBackend } from './dsh-plugin-model.ts'
import type { PluginModelBackend, PluginModelSelection } from '../contracts/plugin-model.ts'
import { createDshFollowByteBudget, type DshFollowCursors } from './dsh-follow-budget.ts'

export type { NativeDeploymentPresetBinding as DshPresetBinding } from '../contracts/native-deployment.ts'
import type { NativeDeploymentPresetBinding as DshPresetBinding } from '../contracts/native-deployment.ts'

export interface DshJsonRpcOptions {
  readonly sharedWorkFilesystem?: boolean
  readonly endpoint: string
  readonly auth?: string
  readonly authenticationProvider?: (mode: 'none' | 'answer', signal: AbortSignal) => Promise<string>
  readonly sessionDefinition?: ChatSessionDefinition | ((request: DshCreateSessionRequest) => ChatSessionDefinition)
  readonly presetBindings?: readonly DshPresetBinding[]
  readonly timeoutMs?: number
  readonly followIdleTimeoutMs?: number
  readonly maxPendingEvents?: number
  readonly maxFollows?: number
  readonly resolvePromptImage?: DshPromptImageResolver
  readonly preferSessionEvents?: boolean
  readonly followCursors?: DshFollowCursors
}

export interface DshJsonRpcPort extends DshClientPort, DshInteractionPort {
  readonly pluginManagement: DshPluginManagement
  interactionStatus?(): { readonly state: 'idle' | 'connecting' | 'connected' | 'closed' | 'error'; readonly lastError: string | null }
  readonly pluginModels: PluginModelBackend
  configureSession?(request: { readonly sessionId: string; readonly conversationId: string; readonly model?: PluginModelSelection; readonly signal: AbortSignal }): Promise<void>
  inspectSessionStorage?(sessionId: string, signal: AbortSignal): Promise<{ sessionId: string; exists: boolean; root?: string; filename?: string }>
  readModelCatalog(signal: AbortSignal): Promise<JsonValue>
  readonly bridgePlugin?: DshBridgePluginPort
  readonly sessionMigration?: DshSessionMigrationPort
  readonly frameworkTools?: DshFrameworkToolPort
  readonly work?: DshWorkPort
  verify(signal: AbortSignal): Promise<void>
  listAgentPresets(signal: AbortSignal): Promise<JsonValue>
  readAgentPreset(agentPreset: string, signal: AbortSignal): Promise<JsonValue>
  inspectDeployment(request: { readonly agentPresets: readonly string[]; readonly credentialRefs: readonly string[]; readonly signal: AbortSignal }): Promise<DshDeploymentInspection>
  close(): Promise<void>
}

export interface DshDeploymentInspection {
  readonly settings: JsonValue
  readonly roster: JsonValue
  readonly documents: readonly JsonValue[]
  readonly credentials: JsonValue
}

export const DSH_JSONRPC_CAPABILITIES = Object.freeze({
  directSystemInstructions: false,
  agentPreset: true,
  textPromptOnly: false,
  imagePrompt: true,
  automaticReconnect: false,
  interactionAnswers: true,
})

function failure(code: string): DshAdapterError {
  return new DshAdapterError(code, 'DSH network operation did not complete safely.')
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value)
}

function bound(value: number | undefined, fallback: number, maximum: number): number {
  const selected = value ?? fallback
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > maximum) throw failure('DSH_INVALID_OPTIONS')
  return selected
}

function rejected(code: string): DshPortResult<never> {
  return { ok: false, error: { code } }
}

export function createDshJsonRpcPort(options: DshJsonRpcOptions): DshJsonRpcPort {
  let endpoint: string
  try {
    endpoint = validateAdapterEndpoint(options.endpoint)
    if (endpoint === '') throw failure('DSH_INVALID_OPTIONS')
  } catch {
    throw failure('DSH_INVALID_OPTIONS')
  }
  const base = new URL(endpoint.endsWith('/') ? endpoint : `${endpoint}/`)
  const auth = options.auth ?? ''
  const authenticationProvider = options.authenticationProvider
  if (options.resolvePromptImage !== undefined && typeof options.resolvePromptImage !== 'function') throw failure('DSH_INVALID_OPTIONS')
  if (typeof auth !== 'string' || auth !== '' && !/^[\x21-\x7e]{1,4096}$/.test(auth)
    || authenticationProvider !== undefined && typeof authenticationProvider !== 'function'
    || auth === '' && authenticationProvider === undefined || auth !== '' && authenticationProvider !== undefined) throw failure('DSH_INVALID_OPTIONS')
  let cookie = auth.startsWith('cookie:') ? auth.slice(7) : undefined
  if (cookie !== undefined && !/^[A-Za-z0-9_-]+=[A-Za-z0-9_.~-]+$/.test(cookie)) throw failure('DSH_INVALID_OPTIONS')
  const timeoutMs = bound(options.timeoutMs, 60_000, 300_000)
  const idleMs = bound(options.followIdleTimeoutMs, 300_000, 3_600_000)
  const maxPendingEvents = bound(options.maxPendingEvents, 64, 1_024)
  const maxFollows = bound(options.maxFollows, 16, 128)
  const maxBytes = 1_048_576
  const configuredDefinition = typeof options.sessionDefinition === 'function'
    ? options.sessionDefinition : options.sessionDefinition === undefined ? undefined : normalizeDshSessionDefinition(options.sessionDefinition)
  const sourceBindings = options.presetBindings ?? []
  if (!Array.isArray(sourceBindings) || sourceBindings.length > 128) throw failure('DSH_INVALID_OPTIONS')
  const presetIds = new Set<string>()
  const bindings = sourceBindings.map(binding => {
    if (!identifier(binding.agentPreset)) throw failure('DSH_INVALID_OPTIONS')
    if (binding.externalProvider !== undefined && !identifier(binding.externalProvider)
      || binding.conversationKind !== undefined && !['group', 'private'].includes(binding.conversationKind)) throw failure('DSH_INVALID_OPTIONS')
    if (presetIds.has(binding.agentPreset)) throw failure('DSH_INVALID_OPTIONS')
    presetIds.add(binding.agentPreset)
    return { agentPreset: binding.agentPreset, definition: normalizeDshSessionDefinition(binding.definition),
      externalProvider: binding.externalProvider, conversationKind: binding.conversationKind }
  })
  const lifetime = new AbortController()
  const follows = new Map<string, () => Promise<void>>()
  const pluginFollows = new Map<string, () => Promise<void>>()
  const { limited, authenticate, rpc } = createDshUnaryTransport({ base, auth, initialCookie: cookie, authenticationProvider, timeoutMs, maxBytes, lifetime })
  // DSH token peers own exactly one API socket. Each physical follow receives
  // its own peer; unary calls keep their coalesced authentication cache.
  const authenticateStream = (signal: AbortSignal) => auth !== '' && !auth.startsWith('cookie:')
    ? createDshUnaryTransport({ base, auth, initialCookie: undefined, authenticationProvider: undefined, timeoutMs, maxBytes, lifetime }).authenticate(signal)
    : authenticate(signal)

  const callbacks = createDshCallbackBudget(maxFollows, limited)
  const byteBudget = createDshFollowByteBudget()
  let streamDescription: Promise<{ issuerEpoch: string } | null> | undefined
  const bridgeStream = async (signal: AbortSignal) => {
    if (!options.preferSessionEvents) return null
    streamDescription ??= bridgePlugin.describe(lifetime.signal).then(description =>
      description.sessionEventsProtocol === 'qq-bridge-framework.session-events/1'
        && description.methods?.includes('bridgePlugin/followSessionEvents') ? { issuerEpoch: description.issuerEpoch } : null)
    const pending = streamDescription
    // Coalesce concurrent openings, then re-read the live generation on a later reconnect.
    const clear = () => { if (streamDescription === pending) streamDescription = undefined }
    void pending.then(clear, clear)
    signal.throwIfAborted()
    return pending
  }
  const cursorOptions = options.followCursors ? { cursors: options.followCursors } : {}
  const follow = createDshSessionFollower({ base, timeoutMs, idleMs, maxPendingEvents, maxFollows, maxBytes, lifetime,
    follows, callbacks, authenticate: authenticateStream, bridgeStream, byteBudget, ...cursorOptions })
  const pluginFollow = createDshSessionFollower({ base, timeoutMs, idleMs, maxPendingEvents, maxFollows, maxBytes, lifetime,
    follows: pluginFollows, callbacks, authenticate: authenticateStream, bridgeStream, byteBudget,
    ...(options.followCursors ? { cursors: {
      load: (id: string) => options.followCursors!.load(JSON.stringify(['plugin-model', id])),
      save: (id: string, sequence: number) => options.followCursors!.save(JSON.stringify(['plugin-model', id]), sequence),
    } } : {}) })
  const interactions = createDshInteractionChannel({ base, timeoutMs, maxPendingEvents, maxFollows, maxBytes, lifetime, callbacks, authenticate, rpc })

  const bridgePlugin = createDshBridgePluginPort(async (method, request, signal) => {
    const result = await rpc(method, request === undefined ? undefined : snapshot(request) as JsonObject, signal)
    if (!result.ok) throw failure('DSH_PLUGIN_UNAVAILABLE')
    return result.value
  })
  const sessionMigration = createDshSessionMigrationPort({ describe: signal => bridgePlugin.describe(signal),
    async invoke(method, request, signal) {
      const result = await rpc(method, snapshot(request) as JsonObject, signal)
      if (!result.ok) throw failure('DSH_MIGRATION_UNAVAILABLE')
      return result.value
    } })
  const frameworkTools = createDshFrameworkToolPort(async (method, request, signal) => {
    const result = await rpc(method, snapshot(request) as JsonObject, signal)
    if (!result.ok) throw failure('DSH_TOOL_CHANNEL_UNAVAILABLE')
    return result.value
  })
  const work = createDshWorkPort(async (method, request, signal) => {
    const result = await rpc(method, snapshot(request) as JsonObject, signal)
    if (!result.ok) throw dshWorkRpcError(result.error.code)
    return result.value
  }, { currentEpoch: async signal => (await bridgePlugin.describe(signal)).issuerEpoch, streamBase: base.href, sharedFilesystem: options.sharedWorkFilesystem ?? ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) })
  const pluginModels = createDshPluginModelBackend({ client: {
    createSession: request => port.createSession(request), prompt: request => port.prompt(request),
    follow: request => pluginFollow(request), cancel: request => port.cancel(request),
  }, invoke: (method, input, signal) => rpc(method, method === 'bridgePlugin/pluginModels' ? undefined : input, signal) })
  const port: DshJsonRpcPort = Object.freeze({
    pluginManagement: createDshPluginManagement(async (method, input, signal) => {
      const result = await rpc(method, input, signal, true)
      if (!result.ok) throw failure('DSH_PLUGIN_MANAGEMENT_UNAVAILABLE')
      return result.value
    }),
    pluginModels,
    bridgePlugin,
    async configureSession(request: { readonly sessionId: string; readonly conversationId: string; readonly model?: PluginModelSelection; readonly signal: AbortSignal }) {
      if (!identifier(request.sessionId)) throw failure('DSH_INVALID_SESSION')
      const kind = request.conversationId.startsWith('group:') ? 'group' : 'private'
      const matches = bindings.filter(binding => binding.conversationKind === undefined || binding.conversationKind === kind)
      if (matches.length !== 1) throw failure('DSH_INSTRUCTIONS_UNSUPPORTED')
      const binding = matches[0]!
      const model = request.model
      await updateDshSessionModel({ sessionId: request.sessionId, definition: binding.definition,
        ...(model ? { selection: model } : {}),
        externalProvider: model?.provider ?? binding.externalProvider ?? binding.definition.model.provider, signal: request.signal, rpc })
    },
    async inspectSessionStorage(sessionId: string, signal: AbortSignal) {
      if (!identifier(sessionId)) throw failure('DSH_INVALID_SESSION')
      const result = await rpc('bridgePlugin/inspectSessionStorage', { sessionId }, signal)
      if (!result.ok || !record(result.value) || result.value.sessionId !== sessionId || typeof result.value.exists !== 'boolean') throw failure('DSH_SESSION_STORAGE_UNAVAILABLE')
      const value = result.value
      if (value.exists && (typeof value.root !== 'string' || typeof value.filename !== 'string')) throw failure('DSH_SESSION_STORAGE_UNAVAILABLE')
      return { sessionId, exists: value.exists as boolean, ...(typeof value.root === 'string' && typeof value.filename === 'string' ? { root: value.root, filename: value.filename } : {}) }
    },
    sessionMigration,
    frameworkTools,
    work,
    async verify(signal: AbortSignal): Promise<void> {
      const result = await rpc('settings/describe', undefined, signal)
      if (!result.ok || !record(result.value)) throw failure('DSH_VERIFICATION_FAILED')
    },
    async listAgentPresets(signal: AbortSignal): Promise<JsonValue> {
      const result = await rpc('agentPresets/list', undefined, signal)
      if (!result.ok) throw failure('DSH_VERIFICATION_FAILED')
      return result.value
    },
    async readAgentPreset(agentPreset: string, signal: AbortSignal): Promise<JsonValue> {
      if (!identifier(agentPreset)) throw failure('DSH_INVALID_OPTIONS')
      const result = await rpc('agentPresets/read', { agentPreset }, signal, true)
      if (!result.ok) throw failure('DSH_VERIFICATION_FAILED')
      return result.value
    },
    async inspectDeployment(request): Promise<DshDeploymentInspection> {
      if (request.agentPresets.length > 128 || request.credentialRefs.length > 256
        || !request.agentPresets.every(identifier) || !request.credentialRefs.every(ref => /^[A-Za-z_][A-Za-z0-9_]{0,255}$/.test(ref))) {
        throw failure('DSH_INVALID_OPTIONS')
      }
      const read = async (method: 'settings/describe' | 'agentPresets/list' | 'agentPresets/read' | 'credentials/describe', args?: JsonObject): Promise<JsonValue> => {
        const result = await rpc(method, args, request.signal, true)
        if (!result.ok) throw failure('DSH_VERIFICATION_FAILED')
        return result.value
      }
      const settings = await read('settings/describe')
      const roster = await read('agentPresets/list')
      const documents: JsonValue[] = []
      for (const agentPreset of request.agentPresets) documents.push(await read('agentPresets/read', { agentPreset }))
      const credentials = await read('credentials/describe', { refs: [...request.credentialRefs] })
      return snapshot({ settings, roster, documents, credentials })
    },
    async readModelCatalog(signal) {
      const result = await rpc('session/modelCatalog', undefined, signal)
      if (!result.ok) throw failure('DSH_MODEL_CAPABILITIES_UNVERIFIED')
      return result.value
    },
    createSession: createDshSessionCreator({ configuredDefinition, bindings, rpc }),
    async prompt(request) {
      if (!identifier(request.sessionId) || !identifier(request.requestId) || request.mode !== 'queue') {
        return rejected('DSH_PROMPT_UNSUPPORTED')
      }
      const content = await prepareDshPromptContent(request, options.resolvePromptImage).catch(error => {
        if (request.signal.aborted) throw failure('DSH_ABORTED')
        throw error
      })
      if (content === null) return rejected('DSH_PROMPT_UNSUPPORTED')
      const result = await rpc('session/prompt', { sessionId: request.sessionId, requestId: request.requestId, mode: 'queue', content }, request.signal)
      if (result.ok && (!record(result.value) || result.value.accepted !== true)) throw failure('DSH_INVALID_RESPONSE')
      return result
    },
    follow,
    async cancel(request) {
      if (!identifier(request.sessionId)) return rejected('DSH_INVALID_SESSION')
      const result = await rpc('session/cancel', { sessionId: request.sessionId }, request.signal)
      if (result.ok && (!record(result.value) || result.value.accepted !== true)) throw failure('DSH_INVALID_RESPONSE')
      return result
    },
    registerInteractionSession: interactions.registerSession,
    connectInteractions: interactions.connect,
    interactionStatus: interactions.status,
    respondInteraction: interactions.respond,
    async close() {
      await interactions.close()
      lifetime.abort()
      await Promise.all([...follows.values(), ...pluginFollows.values()].map(stop => stop()))
    },
  } satisfies DshJsonRpcPort)
  return port
}
