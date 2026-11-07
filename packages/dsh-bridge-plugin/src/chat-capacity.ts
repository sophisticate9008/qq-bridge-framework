/** Kept in sync with the host's managed summary allowance; old presets retain their original budget. */
export function chatCompactionSummaryBudget(contextWindow: number, maxTokens: number): number {
  return Math.max(1, Math.min(8192, maxTokens, Math.floor((contextWindow - maxTokens) / 4)))
}
