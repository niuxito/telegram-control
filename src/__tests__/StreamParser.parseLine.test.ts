import { describe, it, expect } from 'vitest';
import { parseLine } from '../claude/StreamParser.js';

// Helpers to build valid JSON lines for each event type
function makeInitLine(sessionId: string): string {
  return JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId });
}

function makeAssistantLine(contentBlocks: unknown[]): string {
  return JSON.stringify({ type: 'assistant', message: { content: contentBlocks } });
}

function makeResultLine(
  subtype: 'success' | 'error',
  opts: Record<string, unknown> = {}
): string {
  return JSON.stringify({
    type: 'result',
    subtype,
    cost_usd: 0.01,
    session_id: 'ses1',
    result: 'done',
    ...opts,
  });
}

describe('parseLine', () => {
  // ── Empty / whitespace ────────────────────────────────────────────────────
  describe('empty / whitespace input', () => {
    it('returns null for an empty string', () => {
      expect(parseLine('')).toBeNull();
    });

    it('returns null for a whitespace-only string', () => {
      expect(parseLine('   ')).toBeNull();
    });

    it('returns null for a tab-and-newline string', () => {
      expect(parseLine('\t\n')).toBeNull();
    });
  });

  // ── system/init events ────────────────────────────────────────────────────
  describe('system/init events', () => {
    it('parses a system init event into an InitEvent', () => {
      const line = makeInitLine('abc123');
      const result = parseLine(line);
      expect(result).not.toBeNull();
      expect(result).toEqual({ type: 'init', sessionId: 'abc123' });
    });

    it('preserves the full session ID', () => {
      const line = makeInitLine('session-uuid-9999');
      const result = parseLine(line);
      expect(result?.type).toBe('init');
      if (result?.type === 'init') {
        expect(result.sessionId).toBe('session-uuid-9999');
      }
    });

    it('returns null for a system event with a non-init subtype', () => {
      const line = JSON.stringify({ type: 'system', subtype: 'other', session_id: 'x' });
      expect(parseLine(line)).toBeNull();
    });
  });

  // ── assistant events ───────────────────────────────────────────────────────
  describe('assistant events', () => {
    it('returns null for an assistant message (caller iterates content blocks)', () => {
      const line = makeAssistantLine([{ type: 'text', text: 'Hello' }]);
      expect(parseLine(line)).toBeNull();
    });

    it('returns null when the assistant message has no content', () => {
      const line = JSON.stringify({ type: 'assistant', message: {} });
      expect(parseLine(line)).toBeNull();
    });

    it('returns null for an assistant message with tool_use blocks', () => {
      const line = makeAssistantLine([{ type: 'tool_use', name: 'Bash', input: {} }]);
      expect(parseLine(line)).toBeNull();
    });
  });

  // ── result success events ─────────────────────────────────────────────────
  describe('result success events', () => {
    it('parses a success result event with success: true', () => {
      const line = makeResultLine('success', {
        cost_usd: 0.05,
        session_id: 'sess-ok',
        result: 'finished',
      });
      const result = parseLine(line);
      expect(result).not.toBeNull();
      expect(result).toMatchObject({
        type: 'result',
        success: true,
        costUsd: 0.05,
        sessionId: 'sess-ok',
        result: 'finished',
      });
    });

    it('sets error to undefined on a success result', () => {
      const line = makeResultLine('success');
      const result = parseLine(line);
      expect(result?.type).toBe('result');
      if (result?.type === 'result') {
        expect(result.error).toBeUndefined();
      }
    });

    it('defaults costUsd to 0 when cost_usd field is absent', () => {
      const line = JSON.stringify({
        type: 'result',
        subtype: 'success',
        session_id: 'x',
        result: '',
      });
      const result = parseLine(line);
      if (result?.type === 'result') {
        expect(result.costUsd).toBe(0);
      }
    });

    it('defaults sessionId to empty string when session_id is absent', () => {
      const line = JSON.stringify({
        type: 'result',
        subtype: 'success',
        cost_usd: 0,
        result: '',
      });
      const result = parseLine(line);
      if (result?.type === 'result') {
        expect(result.sessionId).toBe('');
      }
    });

    it('defaults result to empty string when result field is absent', () => {
      const line = JSON.stringify({
        type: 'result',
        subtype: 'success',
        cost_usd: 0,
        session_id: 'x',
      });
      const result = parseLine(line);
      if (result?.type === 'result') {
        expect(result.result).toBe('');
      }
    });
  });

  // ── result error events ───────────────────────────────────────────────────
  describe('result error events', () => {
    it('parses an error result event with success: false', () => {
      const line = makeResultLine('error', { result: 'Something went wrong' });
      const result = parseLine(line);
      expect(result).not.toBeNull();
      expect(result).toMatchObject({ type: 'result', success: false });
    });

    it('sets error field from error field (not result) on error subtype', () => {
      // parseLine source: error: obj.subtype === 'error' ? obj.error : undefined
      const line = JSON.stringify({
        type: 'result',
        subtype: 'error',
        cost_usd: 0,
        session_id: 'ses2',
        result: 'result text',
        error: 'the actual error message',
      });
      const result = parseLine(line);
      expect(result?.type).toBe('result');
      if (result?.type === 'result') {
        expect(result.error).toBe('the actual error message');
      }
    });

    it('error is undefined when error field is absent and subtype is error', () => {
      // obj.error is undefined → error: undefined
      const line = JSON.stringify({
        type: 'result',
        subtype: 'error',
        cost_usd: 0,
        session_id: 'ses3',
        result: 'fail',
      });
      const result = parseLine(line);
      if (result?.type === 'result') {
        expect(result.error).toBeUndefined();
      }
    });
  });

  // ── malformed JSON ────────────────────────────────────────────────────────
  describe('malformed JSON', () => {
    it('returns null for completely invalid JSON', () => {
      expect(parseLine('not json at all')).toBeNull();
    });

    it('returns null for truncated JSON', () => {
      expect(parseLine('{"type": "result"')).toBeNull();
    });

    it('returns null for a bare number', () => {
      expect(parseLine('42')).toBeNull();
    });

    it('returns null for a JSON null', () => {
      expect(parseLine('null')).toBeNull();
    });

    it('returns null for a JSON array (not an object)', () => {
      expect(parseLine('[]')).toBeNull();
    });

    it('returns null for a JSON object with no recognised type', () => {
      expect(parseLine('{"foo":"bar"}')).toBeNull();
    });
  });
});
