import { FrameworkError, isRecord } from '../core/values.ts'
import { resetNativeSessionContext, validNativeSessionResetTarget, type NativeSessionManagementState } from '../host/native-session-management.ts'
import { AdminRequestError, type AdminRoute } from './server.ts'
import { parsePluginModelSelection, type PluginModelSelection } from '../contracts/plugin-model.ts'
import type { NativeSessionResetTarget } from '../host/native-session-management.ts'

export function createNativeSessionManagementRoutes(options: {
  readonly setModel?: (target: NativeSessionResetTarget, model: PluginModelSelection | null, revision: number | null, signal: AbortSignal) => Promise<unknown>
  readonly bind?: (target: import('../host/native-session-management.ts').NativeSessionResetTarget, targetSessionId: string, signal: AbortSignal) => unknown | Promise<unknown>
  readonly unbind?: (target: import('../host/native-session-management.ts').NativeSessionResetTarget) => unknown
  readonly directory: string
  readonly state: () => NativeSessionManagementState | Promise<NativeSessionManagementState>
  readonly runExclusive?: <Result>(operation: () => Promise<Result>) => Promise<Result>
}): readonly AdminRoute[] {
  let pending = false
  return Object.freeze([Object.freeze({
    method: 'POST' as const, pathname: '/api/chat/sessions/model',
    async handle({ query, body, signal }: Parameters<AdminRoute['handle']>[0]) {
      if (query.size || !isRecord(body) || Object.keys(body).length !== 7 || body.confirm !== true
        || !validNativeSessionResetTarget(body) || body.modelRevision !== null && (!Number.isSafeInteger(body.modelRevision) || Number(body.modelRevision) < 1))
        throw new AdminRequestError(400, 'invalid_session_model')
      let model: PluginModelSelection | null
      try { model = body.model === null ? null : parsePluginModelSelection(body.model) }
      catch { throw new AdminRequestError(400, 'invalid_session_model') }
      if (model?.contextWindow !== undefined) throw new AdminRequestError(400, 'invalid_session_model')
      if (!options.setModel) throw new AdminRequestError(503, 'session_model_unavailable')
      const setModel = options.setModel
      if (pending) throw new AdminRequestError(409, 'session_model_busy')
      pending = true
      try {
        const run = () => setModel({ key: body.key, sessionId: body.sessionId,
          generation: body.generation, bindingRevision: body.bindingRevision }, model, body.modelRevision as number | null, signal)
        return options.runExclusive ? await options.runExclusive(run) : await run()
      } catch (error) {
        if (error instanceof AdminRequestError) throw error
        const code = isRecord(error) ? String(error.code ?? '') : ''
        throw new AdminRequestError(/CONFLICT/.test(code) ? 409 : /BUSY|UNSETTLED|NOT_RUNNING/.test(code) ? 409 : /UNAVAILABLE/.test(code) ? 400 : 503,
          /CONFLICT/.test(code) ? 'session_model_conflict' : /BUSY|UNSETTLED|NOT_RUNNING/.test(code) ? 'session_model_busy' : /UNAVAILABLE/.test(code) ? 'session_model_selection_unavailable' : 'session_model_unknown')
      } finally { pending = false }
    }
  }), Object.freeze({
    method: 'POST' as const, pathname: '/api/chat/sessions/reset',
    async handle({ query, body, signal }: Parameters<AdminRoute['handle']>[0]) {
      if ([...query.keys()].length > 0) throw new AdminRequestError(400, 'invalid_query')
      if (!isRecord(body) || Object.keys(body).length !== 5 || body.confirm !== true
        || !validNativeSessionResetTarget(body)) throw new AdminRequestError(400, 'invalid_session_reset')
      if (pending) throw new AdminRequestError(409, 'session_reset_busy')
      pending = true
      try {
        const target = { key: body.key, sessionId: body.sessionId, generation: body.generation, bindingRevision: body.bindingRevision }
        const run = async () => await options.state() === 'running' && options.unbind ? options.unbind(target) : resetNativeSessionContext({ directory: options.directory, state: options.state, target, signal })
        return options.runExclusive ? await options.runExclusive(run) : await run()
      } catch (error) {
        if (error instanceof AdminRequestError) throw error
        if (error instanceof FrameworkError) {
          if (error.code === 'SESSION_MANAGEMENT_NOT_STOPPED') throw new AdminRequestError(409, 'session_reset_requires_stopped')
          if (error.code === 'SESSION_MANAGEMENT_BUSY') throw new AdminRequestError(409, 'session_reset_busy')
          if (error.code === 'SESSION_MANAGEMENT_CONFLICT') throw new AdminRequestError(409, 'session_reset_conflict')
          if (error.code === 'SESSION_MANAGEMENT_EXECUTION_UNSETTLED') throw new AdminRequestError(409, 'session_reset_execution_unsettled')
          if (error.code === 'SESSION_MANAGEMENT_INVALID_TARGET') throw new AdminRequestError(400, 'invalid_session_reset')
          if (error.code === 'SESSION_MANAGEMENT_UNKNOWN') throw new AdminRequestError(504, 'session_reset_unknown')
        }
        if (signal.aborted) throw new AdminRequestError(499, 'request_aborted')
        throw new AdminRequestError(503, 'session_reset_unavailable')
      } finally { pending = false }
    }
  }), Object.freeze({
    method: 'POST' as const, pathname: '/api/chat/sessions/bind',
    async handle({ query, body, signal }: Parameters<AdminRoute['handle']>[0]) {
      if ([...query.keys()].length > 0) throw new AdminRequestError(400, 'invalid_query')
      if (!isRecord(body) || Object.keys(body).length !== 6 || body.confirm !== true
        || !validNativeSessionResetTarget(body) || typeof body.targetSessionId !== 'string'
        || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(body.targetSessionId)) throw new AdminRequestError(400, 'invalid_session_bind')
      if (pending) throw new AdminRequestError(409, 'session_bind_busy')
      if (!options.bind) throw new AdminRequestError(503, 'session_bind_unavailable')
      const bind = options.bind
      pending = true
      try {
        const target = { key: body.key, sessionId: body.sessionId, generation: body.generation, bindingRevision: body.bindingRevision }
        const targetSessionId = body.targetSessionId
        const run = async () => {
          signal.throwIfAborted()
          return bind(target, targetSessionId, signal)
        }
        return options.runExclusive ? await options.runExclusive(run) : await run()
      } catch (error) {
        if (error instanceof AdminRequestError) throw error
        if (error instanceof FrameworkError) {
          if (error.code === 'SESSION_MANAGEMENT_NOT_RUNNING') throw new AdminRequestError(409, 'session_bind_requires_running')
          if (error.code === 'SESSION_MANAGEMENT_BUSY') throw new AdminRequestError(409, 'session_bind_busy')
          if (error.code === 'SESSION_MANAGEMENT_CONFLICT') throw new AdminRequestError(409, 'session_bind_conflict')
          if (error.code === 'SESSION_MANAGEMENT_EXECUTION_UNSETTLED') throw new AdminRequestError(409, 'session_bind_execution_unsettled')
          if (error.code === 'SESSION_MANAGEMENT_TARGET_OCCUPIED') throw new AdminRequestError(409, 'session_bind_target_occupied')
          if (error.code === 'SESSION_MANAGEMENT_TARGET_OWNED') throw new AdminRequestError(409, 'session_bind_target_owned')
          if (error.code === 'PLUGIN_MODEL_ASSISTANT_SESSION_RESERVED') throw new AdminRequestError(409, 'session_bind_target_reserved')
          if (error.code === 'SESSION_MANAGEMENT_TARGET_NOT_FOUND') throw new AdminRequestError(404, 'session_bind_target_not_found')
          if (error.code === 'SESSION_MANAGEMENT_INVALID_TARGET') throw new AdminRequestError(400, 'invalid_session_bind')
          if (error.code === 'SESSION_MANAGEMENT_UNKNOWN') throw new AdminRequestError(504, 'session_bind_unknown')
        }
        if (signal.aborted) throw new AdminRequestError(499, 'request_aborted')
        throw new AdminRequestError(503, 'session_bind_unavailable')
      } finally { pending = false }
    }
  })])
}
