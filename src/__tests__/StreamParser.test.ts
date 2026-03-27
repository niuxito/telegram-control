import { describe, it, expect } from 'vitest';
import { parseLineDetailed } from '../claude/StreamParser.js';

// Helpers to build valid JSON lines for each event type
function makeInitLine(sessionId: string): string {
  return JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId });
}

function makeAssistantLine(contentBlocks: unknown[]): string {
  return JSON.stringify({ type: 'assistant', message: { content: contentBlocks } });
}

function makeResultLine(subtype: 'success' | 'error', opts: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: 'result', subtype, cost_usd: 0.01, session_id: 'ses1', result: 'done', ...opts });
}

describe('parseLineDetailed', () => {
  describe('empty / whitespace input', () => {
    it('returns [] for an empty string', () => {
      expect(parseLineDetailed('')).toEqual([]);
    });

    it('returns [] for a whitespace-only string', () => {
      expect(parseLineDetailed('   ')).toEqual([]);
    });

    it('returns [] for a tab-only string', () => {
      expect(parseLineDetailed('\t\n')).toEqual([]);
    });
  });

  describe('system/init events', () => {
    it('parses a system init event into an InitEvent', () => {
      const line = makeInitLine('abc123');
      const result = parseLineDetailed(line);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ type: 'init', sessionId: 'abc123' });
    });

    it('preserves the full session ID', () => {
      const line = makeInitLine('session-uuid-9999');
      const [event] = parseLineDetailed(line);
      expect(event.type).toBe('init');
      if (event.type === 'init') {
        expect(event.sessionId).toBe('session-uuid-9999');
      }
    });

    it('does NOT produce an InitEvent for a system event with a different subtype', () => {
      const line = JSON.stringify({ type: 'system', subtype: 'other', session_id: 'x' });
      expect(parseLineDetailed(line)).toEqual([]);
    });
  });

  describe('assistant events with text content', () => {
    it('parses a single text block into a text_chunk event', () => {
      const line = makeAssistantLine([{ type: 'text', text: 'Hello, world!' }]);
      const result = parseLineDetailed(line);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ type: 'text_chunk', text: 'Hello, world!' });
    });

    it('ignores text blocks with empty/missing text', () => {
      const line = makeAssistantLine([{ type: 'text', text: '' }]);
      // Empty string is falsy, so the block is skipped
      expect(parseLineDetailed(line)).toEqual([]);
    });
  });

  describe('assistant events with tool_use content', () => {
    it('parses a tool_use block into a ToolUseEvent', () => {
      const input = { command: 'ls -la' };
      const line = makeAssistantLine([{ type: 'tool_use', name: 'Bash', input }]);
      const result = parseLineDetailed(line);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ type: 'tool_use', toolName: 'Bash', input });
    });

    it('preserves complex input objects', () => {
      const input = { path: '/tmp/file.ts', content: 'export {}' };
      const line = makeAssistantLine([{ type: 'tool_use', name: 'Write', input }]);
      const [event] = parseLineDetailed(line);
      expect(event.type).toBe('tool_use');
      if (event.type === 'tool_use') {
        expect(event.toolName).toBe('Write');
        expect(event.input).toEqual(input);
      }
    });
  });

  describe('multiple content blocks in one assistant event', () => {
    it('returns one event per content block', () => {
      const line = makeAssistantLine([
        { type: 'text', text: 'Running command...' },
        { type: 'tool_use', name: 'Bash', input: { cmd: 'echo hi' } },
        { type: 'text', text: 'Done.' },
      ]);
      const result = parseLineDetailed(line);
      expect(result).toHaveLength(3);
      expect(result[0]).toEqual({ type: 'text_chunk', text: 'Running command...' });
      expect(result[1]).toEqual({ type: 'tool_use', toolName: 'Bash', input: { cmd: 'echo hi' } });
      expect(result[2]).toEqual({ type: 'text_chunk', text: 'Done.' });
    });

    it('skips unknown block types and only returns known ones', () => {
      const line = makeAssistantLine([
        { type: 'image', source: {} },     // unknown — should be skipped
        { type: 'text', text: 'Hi' },
      ]);
      const result = parseLineDetailed(line);
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('text_chunk');
    });

    it('returns [] when assistant event has no content array', () => {
      const line = JSON.stringify({ type: 'assistant', message: {} });
      expect(parseLineDetailed(line)).toEqual([]);
    });
  });

  describe('result success events', () => {
    it('parses a success result event', () => {
      const line = makeResultLine('success', { cost_usd: 0.01, session_id: 'ses1', result: 'all done' });
      const result = parseLineDetailed(line);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        type: 'result',
        success: true,
        costUsd: 0.01,
        sessionId: 'ses1',
        result: 'all done',
      });
    });

    it('sets error to undefined on a success result', () => {
      const line = makeResultLine('success');
      const [event] = parseLineDetailed(line);
      expect(event.type).toBe('result');
      if (event.type === 'result') {
        expect(event.error).toBeUndefined();
      }
    });

    it('defaults costUsd to 0 when cost_usd is absent', () => {
      const line = JSON.stringify({ type: 'result', subtype: 'success', session_id: 'x', result: '' });
      const [event] = parseLineDetailed(line);
      expect(event.type).toBe('result');
      if (event.type === 'result') {
        expect(event.costUsd).toBe(0);
      }
    });

    it('defaults sessionId to empty string when session_id is absent', () => {
      const line = JSON.stringify({ type: 'result', subtype: 'success', cost_usd: 0, result: '' });
      const [event] = parseLineDetailed(line);
      if (event.type === 'result') {
        expect(event.sessionId).toBe('');
      }
    });
  });

  describe('result error events', () => {
    it('parses an error result event with success: false', () => {
      const line = makeResultLine('error', { result: 'Something went wrong' });
      const result = parseLineDetailed(line);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        type: 'result',
        success: false,
      });
    });

    it('sets error field from result field on error subtype', () => {
      // Looking at the source: error field = obj.result when subtype === 'error'
      const line = JSON.stringify({
        type: 'result',
        subtype: 'error',
        cost_usd: 0,
        session_id: 'ses2',
        result: 'Task timed out',
      });
      const [event] = parseLineDetailed(line);
      expect(event.type).toBe('result');
      if (event.type === 'result') {
        expect(event.success).toBe(false);
        expect(event.error).toBe('Task timed out');
      }
    });
  });

  describe('malformed JSON', () => {
    it('returns [] for completely invalid JSON', () => {
      expect(parseLineDetailed('not json at all')).toEqual([]);
    });

    it('returns [] for truncated JSON', () => {
      expect(parseLineDetailed('{"type": "result"')).toEqual([]);
    });

    it('returns [] for a bare number', () => {
      expect(parseLineDetailed('42')).toEqual([]);
    });

    it('returns [] for a JSON null', () => {
      expect(parseLineDetailed('null')).toEqual([]);
    });

    it('returns [] for a valid JSON array (not an object)', () => {
      expect(parseLineDetailed('[]')).toEqual([]);
    });

    it('returns [] for a JSON object with no recognised type', () => {
      expect(parseLineDetailed('{"foo": "bar"}')).toEqual([]);
    });
  });
});
