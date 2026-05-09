import { describe, it, expect } from 'vitest';
import {
  parsePrReference,
  truncateDiff,
  buildReviewPrompt,
  MAX_REVIEW_DIFF_CHARS,
} from '../bot/handlers/topic/reviewHelpers.js';

describe('parsePrReference', () => {
  describe('bare integer', () => {
    it('accepts a single number string', () => {
      expect(parsePrReference('42')).toBe(42);
    });

    it('handles leading/trailing whitespace', () => {
      expect(parsePrReference('  42  ')).toBe(42);
    });

    it('parses larger numbers', () => {
      expect(parsePrReference('1234567')).toBe(1234567);
    });
  });

  describe('GitHub URL', () => {
    it('extracts the number from a standard /pull/<n> URL', () => {
      expect(parsePrReference('https://github.com/foo/bar/pull/123')).toBe(123);
    });

    it('extracts the number from a URL with extra path segments', () => {
      expect(parsePrReference('https://github.com/foo/bar/pull/9/files')).toBe(9);
    });

    it('extracts the number from a URL with query string and fragment', () => {
      expect(parsePrReference('https://github.com/foo/bar/pull/77?diff=split#issuecomment-1')).toBe(77);
    });

    it('handles URLs without protocol', () => {
      expect(parsePrReference('github.com/foo/bar/pull/55')).toBe(55);
    });
  });

  describe('invalid inputs', () => {
    it('returns null for an empty string', () => {
      expect(parsePrReference('')).toBeNull();
    });

    it('returns null for whitespace only', () => {
      expect(parsePrReference('   ')).toBeNull();
    });

    it('returns null for a non-numeric, non-URL string', () => {
      expect(parsePrReference('foobar')).toBeNull();
    });

    it('returns null for "42abc" (stricter than the original parseInt)', () => {
      // Documents the intentional behavior change: previously parseInt would
      // accept this, leading to silent matches against the wrong PR. We now
      // require the whole string to be digits or a /pull/<n> URL.
      expect(parsePrReference('42abc')).toBeNull();
    });

    it('returns null for "abc42"', () => {
      expect(parsePrReference('abc42')).toBeNull();
    });

    it('returns null when the URL has no /pull/ segment', () => {
      expect(parsePrReference('https://github.com/foo/bar/issues/42')).toBeNull();
    });
  });
});

describe('truncateDiff', () => {
  it('returns short diffs unchanged', () => {
    const diff = 'tiny diff';
    expect(truncateDiff(diff, 100)).toBe(diff);
  });

  it('returns the diff unchanged when its length equals the cap', () => {
    const diff = 'x'.repeat(100);
    expect(truncateDiff(diff, 100)).toBe(diff);
  });

  it('truncates diffs longer than the cap and appends a marker', () => {
    const diff = 'x'.repeat(200);
    const result = truncateDiff(diff, 50);
    expect(result.startsWith('x'.repeat(50))).toBe(true);
    expect(result).toContain('... (diff truncated)');
    expect(result.length).toBe(50 + '\n... (diff truncated)'.length);
  });

  it('uses MAX_REVIEW_DIFF_CHARS (12_000) by default', () => {
    expect(MAX_REVIEW_DIFF_CHARS).toBe(12_000);
    const diff = 'y'.repeat(15_000);
    const result = truncateDiff(diff);
    expect(result.startsWith('y'.repeat(12_000))).toBe(true);
    expect(result).toContain('... (diff truncated)');
  });

  it('does not truncate inside a multi-line diff if it fits', () => {
    const diff = 'line1\nline2\nline3';
    expect(truncateDiff(diff, 100)).toBe(diff);
  });
});

describe('buildReviewPrompt', () => {
  it('includes the project name in the leading sentence', () => {
    const prompt = buildReviewPrompt('telegram-control', 'current changes', 'diff body');
    expect(prompt).toContain('Please review the following code diff for telegram-control');
  });

  it('mentions the focus areas (correctness, security, bugs, quality, risk)', () => {
    const prompt = buildReviewPrompt('p', 't', 'd');
    expect(prompt).toContain('correctness');
    expect(prompt).toContain('security');
    expect(prompt).toContain('bugs');
    expect(prompt).toContain('code quality');
    expect(prompt).toContain('risky');
  });

  it('asks for concise output, with a "looks good" shortcut', () => {
    const prompt = buildReviewPrompt('p', 't', 'd');
    expect(prompt.toLowerCase()).toContain('be concise');
    expect(prompt.toLowerCase()).toContain('looks good');
  });

  it('wraps the diff in a ```diff fenced block', () => {
    const prompt = buildReviewPrompt('p', 't', 'the diff body');
    expect(prompt).toContain('```diff\nthe diff body\n```');
  });

  it('includes the target line when target is non-empty', () => {
    const prompt = buildReviewPrompt('p', 'PR #42: title', 'd');
    expect(prompt).toContain('Context: PR #42: title');
  });

  it('omits the Context line when target is empty', () => {
    const prompt = buildReviewPrompt('p', '', 'd');
    expect(prompt).not.toContain('Context:');
  });

  it('round-trips a target with multi-line content (PR body + stats)', () => {
    const target = 'PR #7: feat: add X\n\nDoes things\n\n+100 -50 in 4 file(s)';
    const prompt = buildReviewPrompt('p', target, 'd');
    expect(prompt).toContain(target);
  });
});
