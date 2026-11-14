import type { Agent } from '@deepseek-ai/dsh-agent'

// These older bridge entry points duplicate the host's inbound queue, prompt,
// media channel, reply delivery or wake configuration. Keep their registrations
// intact for other presets; only trim agents carrying a framework tool lease.
const redundantBridgeTools = new Set([
  'qq_wait_for_messages', 'qq_get_unread_messages', 'qq_get_recent_messages',
  'qq_get_my_recent_messages', 'qq_mark_read', 'qq_get_prompt', 'qq_reply',
  'qq_send_burst', 'qq_get_message_images', 'qq_set_wake_config', 'qq_status',
])

/** This changes the prompt surface, not authorization or global installation. */
export function trimFrameworkChatTools(agent: Agent): (() => void) | undefined {
  // No scope argument reads global registrations, so absent and scope-local
  // tool names never enter restrict(), which rejects unknown inherited names.
  const names = agent.ctx.tools.schemas().map(tool => tool.name)
  const namespaces = names.flatMap(name => /^mcp__(.+)__qq_reply$/.exec(name)?.[1] ?? [])
  const hostStatus = new Set(namespaces.map(namespace => `mcp__${namespace}-host__${namespace}_status`))
  const deny = names.filter(name => {
    const tool = /^mcp__.+__(qq_[a-z_]+)$/.exec(name)?.[1]
    return tool !== undefined && redundantBridgeTools.has(tool) || hostStatus.has(name)
  })
  return deny.length ? agent.ctx.tools.restrict({ deny }) : undefined
}
