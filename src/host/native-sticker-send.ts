import type { EffectAdapter, JsonValue } from '../core/types.ts'
import { assert, isRecord } from '../core/values.ts'
import { digest, json } from './data.ts'
import { DEFAULT_STICKER_SENDING_CONFIGURATION, type StickerSendingConfiguration } from '../contracts/sticker-sending.ts'
import type { StickerSelectionRequest } from './sticker-dsh-selector.ts'
import type { NativeToolContribution } from './native-framework-tools.ts'
import type { NativeMessageSourceReader } from './native-message-sources.ts'
import { NATIVE_REPLY_TOOLS } from './native-reply-tools.ts'
import type { StickerLibrary } from './sticker-library.ts'

export const NATIVE_STICKER_SEND_TOOLS: readonly NativeToolContribution[] = [{
  definition: { name: 'qbf_sticker_send', capability: 'native.stickers.send', featureId: 'framework-tools', timeoutMs: 120_000,
    registrationSource: { origin: 'framework-builtin', ownerId: 'qq-bridge-framework', ownerName: '框架内置工具', transport: 'native' },
    description: '向当前QQ会话发表情，按普通回复发送，无主人权限。给简短表达意图；只有明确指定角色时才填写character，未知或没有该角色就静默放弃，不换角色。意图先保留当前情绪，再写动作；仍在生气时被摸头应写生气、被摸头，不自动改成害羞高兴。按设置使用本地标注匹配，并可由独立DSH会话筛选少量候选；无需主会话列库、看图或打标。被摸头、被夸奖、接梗、招呼及别人向你发表情时可主动使用，纯图也可以。text是正常要说的话；没有合适图或选图超时仍发送text，省略text才静默放弃，不补发图片。排名第一且唯一明确命中动作或用途的候选直接本地选取，其他候选按配置AI筛选。本工具无论成功、失败、不适合或超时均结束当前回合，回执不需要解释或追加文字；不要为了补发再调用。先完成本轮其他必要工作再调用。',
    parameters: { type: 'object', additionalProperties: false, required: ['intent'], properties: {
      intent: { type: 'string', minLength: 1, maxLength: 240, description: '用1至3个简短动作、用途或情绪词，例如被摸头、害羞；打招呼、开心；表达无奈。可参考输入中的已有用途词，不写长句叙述聊天经过。' },
      character: { type: 'string', minLength: 1, maxLength: 64, description: '可选，明确要求的角色名称或别名；找不到时放弃，不换角色。' },
      text: { type: 'string', maxLength: 500, description: '可选，本轮正常要说的文字；图片不合适或选图超时仍正常发送，不描述选图过程。' },
    } } },
  validate(input) {
    assert(isRecord(input) && Object.keys(input).every(key => ['intent', 'character', 'text'].includes(key))
      && typeof input.intent === 'string' && input.intent.trim().length > 0 && input.intent.length <= 240
      && (input.character === undefined || typeof input.character === 'string' && input.character.trim().length > 0
        && input.character.length <= 64 && !/[\x00-\x1f\x7f]/.test(input.character))
      && (input.text === undefined || typeof input.text === 'string' && input.text.length <= 500), 'INVALID_STICKER_INPUT', 'Use a short expression intent.')
    return input
  }, deliveryCapabilities: ['messaging.send'],
  async afterInvoke(value, execution, event, host) {
    execution.signal.throwIfAborted()
    if (!isRecord(value) || value.status !== 'selected' && value.status !== 'text-only')
      return { status: 'skipped', quiet: true }
    const deliver = NATIVE_REPLY_TOOLS[0]!.afterInvoke!
    // The configured timer limits auxiliary model work. Once selected, delivery
    // follows the original ticket, reply policy and outbox cancellation fences.
    return deliver(value, execution, event, host)
  },
}]

export function createNativeStickerSendEffect(options: {
  readonly library: () => Pick<StickerLibrary, 'choose'> | undefined
  readonly sources: () => NativeMessageSourceReader | undefined
  readonly authorize: (conversationId: string, signal: AbortSignal) => Promise<void>
  readonly configuration?: () => Promise<StickerSendingConfiguration>
  readonly selector?: (request: StickerSelectionRequest) => Promise<string | null>
}): EffectAdapter {
  return { async execute(request): Promise<JsonValue> {
    const startedAt = Date.now(), signal = request.signal
    const configuration = options.configuration ? await options.configuration() : { ...DEFAULT_STICKER_SENDING_CONFIGURATION, useAiSelection: false }
    signal.throwIfAborted()
    const deadlineAt = configuration.useAiSelection ? startedAt + 1000 * configuration.dshSelectionTimeoutSeconds : Infinity
    await options.authorize(request.scope.conversationId, signal)
    signal.throwIfAborted()
    const sources = options.sources(), library = options.library()
    assert(sources && library, 'NATIVE_STICKERS_UNAVAILABLE', 'The sticker helper is unavailable.')
    const source = await sources.lookup(request.scope, signal)
    signal.throwIfAborted()
    assert(isRecord(request.input) && typeof request.input.intent === 'string', 'INVALID_STICKER_INPUT', 'Use a short expression intent.')
    const assetId = configuration.useAiSelection && !options.selector ? null : await library.choose(request.input.intent, request.scope.conversationId, signal, deadlineAt,
      typeof request.input.character === 'string' ? request.input.character : undefined,
      configuration.useAiSelection ? options.selector : undefined)
    // The selection deadline only fences the image. Text still uses the original
    // tool lifetime, current source, policy and outbox; cancellation fences both.
    signal.throwIfAborted()
    const selected = assetId && Date.now() < deadlineAt ? assetId : null
    const text = typeof request.input.text === 'string' ? request.input.text.trim() : ''
    if (!selected && !text) return { status: 'skipped', quiet: true }
    return { status: selected ? 'selected' : 'text-only', nativeRequestId: digest([source.conversationId, source.sourceMessageId, 'prompt']),
      content: json([...(text ? [{ type: 'text', text }] : []), ...(selected ? [{ type: 'image', assetId: selected }] : [])]) }
  } }
}
