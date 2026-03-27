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
      return {
        type: 'result',
        success: obj.subtype === 'success',
        costUsd: obj.cost_usd ?? 0,
        sessionId: obj.session_id ?? '',
        result: obj.result ?? '',
        error: obj.subtype === 'error' ? obj.error : undefined,
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
      events.push({
        type: 'result',
        success: obj.subtype === 'success',
        costUsd: obj.cost_usd ?? 0,
        sessionId: obj.session_id ?? '',
        result: obj.result ?? '',
        error: obj.subtype === 'error' ? obj.result : undefined,
      });
    }

    return events;
  } catch {
    return [];
  }
}
