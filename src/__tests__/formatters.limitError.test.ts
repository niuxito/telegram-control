import { describe, it, expect } from 'vitest';
import { formatLimitError } from '../notifications/formatters.js';

describe('formatLimitError', () => {
  describe('usage_limit', () => {
    it('returns a message indicating the usage limit was reached', () => {
      const result = formatLimitError('usage_limit');
      expect(result).toContain('Usage limit reached');
    });

    it('mentions claude.ai/settings in the usage_limit message', () => {
      const result = formatLimitError('usage_limit');
      expect(result).toContain('claude.ai/settings');
    });

    it('includes information about the usage reset', () => {
      const result = formatLimitError('usage_limit');
      expect(result).toContain('reset');
    });

    it('starts with the stop sign emoji ⛔', () => {
      const result = formatLimitError('usage_limit');
      expect(result.startsWith('⛔')).toBe(true);
    });
  });

  describe('rate_limit', () => {
    it('returns a message indicating a rate limit was hit', () => {
      const result = formatLimitError('rate_limit');
      expect(result).toContain('Rate limit hit');
    });

    it('indicates that the task has been marked as failed', () => {
      const result = formatLimitError('rate_limit');
      expect(result).toContain('failed');
    });

    it('starts with the warning emoji ⚠️', () => {
      const result = formatLimitError('rate_limit');
      expect(result.startsWith('⚠️')).toBe(true);
    });
  });

  describe('overloaded', () => {
    it('returns a message indicating Claude is overloaded', () => {
      const result = formatLimitError('overloaded');
      expect(result).toContain('overloaded');
    });

    it('suggests trying again later', () => {
      const result = formatLimitError('overloaded');
      expect(result.toLowerCase()).toContain('try again');
    });

    it('starts with the warning emoji ⚠️', () => {
      const result = formatLimitError('overloaded');
      expect(result.startsWith('⚠️')).toBe(true);
    });
  });

  describe('unknown (default)', () => {
    it('returns a generic error message for the unknown error type', () => {
      const result = formatLimitError('unknown');
      expect(result).toContain('error');
    });

    it('starts with the ❌ emoji', () => {
      const result = formatLimitError('unknown');
      expect(result.startsWith('❌')).toBe(true);
    });

    it('mentions checking server logs', () => {
      const result = formatLimitError('unknown');
      expect(result.toLowerCase()).toContain('server logs');
    });
  });

  describe('return type and format', () => {
    const allTypes = ['usage_limit', 'rate_limit', 'overloaded', 'unknown'] as const;

    it.each(allTypes)('returns a non-empty string for error type "%s"', (errorType) => {
      const result = formatLimitError(errorType);
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    it.each(allTypes)('different error types return different messages for "%s"', (errorType) => {
      // Each type should return a distinct string
      const results = allTypes.map(t => formatLimitError(t));
      const unique = new Set(results);
      expect(unique.size).toBe(allTypes.length);
    });
  });
});
