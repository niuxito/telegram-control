export interface AssistantTextChunk {
  type: 'text_chunk';
  text: string;
}

export interface ToolUseEvent {
  type: 'tool_use';
  toolName: string;
  input: unknown;
}

export interface ResultEvent {
  type: 'result';
  success: boolean;
  costUsd: number;
  sessionId: string;
  result: string;
  error?: string;
}

export interface InitEvent {
  type: 'init';
  sessionId: string;
}

export type StreamEvent = AssistantTextChunk | ToolUseEvent | ResultEvent | InitEvent;

// The CLI reports cost as `total_cost_usd`; `cost_usd` is kept as a fallback
// in case an older CLI version (or a different subtype) still emits it.
function extractCostUsd(obj: any): number {
  return obj.total_cost_usd ?? obj.cost_usd ?? 0;
}

// The CLI uses several non-success subtypes (`error`, `error_during_execution`,
// possibly others) and doesn't put the message in the same field for all of
// them — `error` for some, `errors` (array) for others, `result` for others
// still. Checking success via `subtype === 'success'` already works for all
// of them; this just makes sure a failure is never reported with no message
// at all, which upstream code relies on to tell a failure from a real (if
// empty) successful response.
function extractResultError(obj: any): string | undefined {
  if (obj.subtype === 'success') return undefined;
  if (typeof obj.error === 'string' && obj.error) return obj.error;
  if (Array.isArray(obj.errors) && obj.errors.length) {
    return obj.errors.filter((e: unknown) => typeof e === 'string').join('; ');
  }
  if (typeof obj.result === 'string' && obj.result) return obj.result;
  return `Claude CLI returned subtype "${obj.subtype}"`;
}

export function parseLine(line: string): StreamEvent | null {
  if (!line.trim()) return null;
  try {
    const obj = JSON.parse(line);

    if (obj.type === 'system' && obj.subtype === 'init') {
      return { type: 'init', sessionId: obj.session_id };
    }

    if (obj.type === 'assistant' && obj.message?.content) {
      // Return null here; caller should iterate content blocks
      return null;
    }

    if (obj.type === 'result') {
      const success = obj.subtype === 'success';
      return {
        type: 'result',
        success,
        costUsd: extractCostUsd(obj),
        sessionId: obj.session_id ?? '',
        result: success ? (obj.result ?? '') : '',
        error: extractResultError(obj),
      };
    }

    return null;
  } catch {
    return null;
  }
}

export function parseLineDetailed(line: string): StreamEvent[] {
  if (!line.trim()) return [];
  try {
    const obj = JSON.parse(line);
    const events: StreamEvent[] = [];

    if (obj.type === 'system' && obj.subtype === 'init') {
      events.push({ type: 'init', sessionId: obj.session_id });
    } else if (obj.type === 'assistant' && obj.message?.content) {
      for (const block of obj.message.content) {
        if (block.type === 'text' && block.text) {
          events.push({ type: 'text_chunk', text: block.text });
        } else if (block.type === 'tool_use') {
          events.push({ type: 'tool_use', toolName: block.name, input: block.input });
        }
      }
    } else if (obj.type === 'result') {
      const success = obj.subtype === 'success';
      events.push({
        type: 'result',
        success,
        costUsd: extractCostUsd(obj),
        sessionId: obj.session_id ?? '',
        result: success ? (obj.result ?? '') : '',
        error: extractResultError(obj),
      });
    }

    return events;
  } catch {
    return [];
  }
}
