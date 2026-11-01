import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'qbf-reply-decision-repair': { readonly kind: 'qbf-reply-decision-repair'; readonly requestId: string;
      readonly turn: number; readonly form: 'notice'; readonly summary: string }
  }
}

export interface ReplyDecisionAgent {
  readonly id: string
  readonly session: { readonly id: string }
  readonly status: string
  steer(message: UserMessage): void
}
interface Decision {
  readonly turn: number
  readonly requestId: string
  readonly userMessageId: string
  readonly required: boolean
  readonly addressed: boolean
  collection: boolean
  attempted: boolean
  repaired: boolean
  final: string
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const repairText = '本轮正文还没有发送到QQ。现在只做一次明确决定：需要答复就调用 qbf_reply 发送；无需发言就输出 {"schema":"qbf.reply/1","action":"silent","reason":"no-useful-addition"}。沿用本轮原始用户来源和权限，不重复已执行的工具，不新增工作或调用其他工具。'
const requiredRepairText = '本轮是私聊或本批尚未处理的真实直接 @，需要处理向你提出的内容，不能按群聊旁观、未被提问或没有新信息略过。请结合本轮原消息及时自然回应，并调用 qbf_reply 实际发送；不要只写最终正文。用户明确要求静默、已经实际答复或已经调用静默结束的发表情工具时不追加回复。沿用本轮真实来源和权限，不编造答复或成功，不重复已执行的工具；只提醒这一次。'

const collectionRepairText = '本轮已经尝试按用户要求收藏图片，请依据实际工具回执，用当前人设自然简短回应一次并调用 qbf_reply。只有受理项明确为 queued／accepted 时才说已提交筛选，不说已收藏；部分受理、拒绝或未知要按事实说明，未知不能声称已提交。用户明确要求不回复时保持静默。不重复收藏或其他已执行工具，不等待后台完成，不为后台结果另起通知；只提醒这一次。'

function addressed(content: UserMessage['content']): 'required' | 'addressed' | 'observation' | null {
  const text = content.filter(block => block.type === 'text').map(block => block.text).join('')
  const prefix = '会话事实：\n'
  const ends = ['当前消息：\n', '本批最新消息（结合未读消息选择回应对象）：\n']
    .map(label => text.indexOf(label)).filter(index => index >= 0)
  const end = ends.length ? Math.min(...ends) : text.length
  if (!text.startsWith(prefix) || end < prefix.length || end > 64 * 1024) return null
  try {
    const facts: unknown = JSON.parse(text.slice(prefix.length, end).trim())
    if (!object(facts) || typeof facts.senderId !== 'string' || typeof facts.conversationId !== 'string'
      || !/^(group|private):/.test(facts.conversationId)) return null
    const wakes = Array.isArray(facts.groupWake) ? facts.groupWake : []
    if (facts.conversationId.startsWith('private:') || facts.participation === 'direct'
      || wakes.some(wake => object(wake) && wake.reason === 'direct')) return 'required'
    return facts.participation === 'reply' || wakes.some(wake => object(wake) && wake.reason === 'reply') ? 'addressed' : 'observation'
  } catch { return null }
}
function silent(text: string, required: boolean, collection: boolean): boolean {
  if (text.length > 2048) return false
  try {
    const value: unknown = JSON.parse(text)
    return object(value) && Object.keys(value).length === 3 && value.schema === 'qbf.reply/1' && value.action === 'silent'
      && (collection ? ['user-requested'] : required ? ['already-answered', 'user-requested']
        : ['not-addressed', 'already-answered', 'no-useful-addition', 'user-requested']).includes(String(value.reason))
  } catch { return false }
}

function collectionCall(block: Record<string, unknown>): boolean {
  if (block.name !== 'qbf_sticker_manage') return false
  // Native SDK assistant blocks retain the provider's JSON argument string;
  // some projections already expose its decoded input instead.
  let input: unknown = block.input ?? block.arguments
  if (typeof input === 'string' && input.length <= 65536) {
    try { input = JSON.parse(input) } catch { return false }
  }
  return object(input) && input.action === 'add'
}

/** A bounded same-turn reminder. It never manufactures a QQ send or a user claim. */
export function createReplyDecisionRepair(options: {
  readonly current: (agent: ReplyDecisionAgent) => boolean
  readonly hasReplyLease: (agent: ReplyDecisionAgent) => boolean
}) {
  const decisions = new WeakMap<ReplyDecisionAgent, Decision>()
  return Object.freeze({
    claimed(agent: ReplyDecisionAgent, message: UserMessage, turn: number): void {
      // Synthetic steering and context do not replace the authentic user RPC claim.
      if (message.source.kind !== 'user' || !('rpcId' in message.source) || typeof message.source.rpcId !== 'string') return
      decisions.delete(agent)
      const addressing = addressed(message.content)
      if (!options.current(agent) || !options.hasReplyLease(agent) || !addressing) return
      decisions.set(agent, { turn, requestId: message.source.rpcId, userMessageId: message.id, required: addressing === 'required', addressed: addressing !== 'observation', collection: false,
        attempted: false, repaired: false, final: '' })
    },
    assistant(agent: ReplyDecisionAgent, turn: number, content: unknown): void {
      const decision = decisions.get(agent)
      if (!decision || decision.turn !== turn || !Array.isArray(content)) return
      if (content.some(block => object(block) && block.type === 'tool-call' && (block.name === 'qbf_reply' || block.name === 'qbf_sticker_send')))
        decision.attempted = true
      if (content.some(block => object(block) && block.type === 'tool-call' && collectionCall(block))) decision.collection = true
      decision.final = content.filter(block => object(block) && block.type === 'text' && typeof block.text === 'string')
        .map(block => object(block) ? String(block.text) : '').join('').trim()
    },
    attempted(agent: ReplyDecisionAgent, claim: { readonly requestId: string; readonly userMessageId: string; readonly turn: number }): void {
      const decision = decisions.get(agent)
      if (decision?.turn === claim.turn && decision.requestId === claim.requestId && decision.userMessageId === claim.userMessageId)
        decision.attempted = true
    },
    stopping(agent: ReplyDecisionAgent, turn: number, signal: AbortSignal): void {
      const decision = decisions.get(agent)
      if (signal.aborted || !decision || decision.turn !== turn || decision.repaired || decision.attempted
        || (!decision.addressed && !decision.collection) || (!decision.required && !decision.collection && !decision.final)
        || silent(decision.final, decision.required, decision.collection) || agent.status !== 'running' || !options.current(agent) || !options.hasReplyLease(agent)) return
      // Set before steering: the SDK re-enters this boundary only after the next step.
      decision.repaired = true
      agent.steer(createUserMessage({ content: [{ type: 'text', text: decision.collection ? collectionRepairText : decision.required ? requiredRepairText : repairText }], source: {
        kind: 'qbf-reply-decision-repair', requestId: decision.requestId, turn, form: 'notice', summary: '确认本轮QQ发送或静默决定'
      } }))
    },
    clear(agent: ReplyDecisionAgent): void { decisions.delete(agent) }
  })
}
