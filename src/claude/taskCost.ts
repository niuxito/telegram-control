/**
 * The Claude CLI reports `total_cost_usd` for the whole session, and the total
 * carries over when a session is continued with --resume. A task's own cost is
 * therefore the difference with the total reported for the same session last
 * time.
 */
export interface SessionCostState {
  /** CLI session the task resumed, as stored before the task ran. */
  claudeSessionId: string | null;
  /** Cumulative total last reported for that session; null if never recorded. */
  reportedCostUsd: number | null;
  /** Tasks already run in this session record. */
  messageCount: number;
}

export function taskCostFromCumulative(
  reportedTotalUsd: number,
  resultSessionId: string,
  before: SessionCostState | undefined,
): number {
  const resumedSameSession = !!before?.claudeSessionId && before.claudeSessionId === resultSessionId;
  if (!resumedSameSession) return Math.max(0, reportedTotalUsd); // fresh session: total == this task

  if (before!.reportedCostUsd == null) {
    // A session started before totals were tracked: the earlier part of the
    // total is unknown, so don't attribute it to this task.
    return before!.messageCount > 0 ? 0 : Math.max(0, reportedTotalUsd);
  }
  return Math.max(0, reportedTotalUsd - before!.reportedCostUsd);
}
