import { describe, it, expect } from 'vitest';
import {
  CHECKPOINT_PROMPT,
  formatCheckpointBlock,
  composeCheckpointAppend,
} from '../claude/checkpointFormat.js';

describe('CHECKPOINT_PROMPT', () => {
  it('asks for the four standard sections', () => {
    expect(CHECKPOINT_PROMPT).toContain('Key decisions');
    expect(CHECKPOINT_PROMPT).toContain('context and findings');
    expect(CHECKPOINT_PROMPT).toContain('Current state');
    expect(CHECKPOINT_PROMPT).toContain('Pending work');
  });

  it('asks for a dated markdown section', () => {
    expect(CHECKPOINT_PROMPT.toLowerCase()).toContain('dated markdown');
  });

  it('mentions that a fresh session will read it (so brevity matters)', () => {
    expect(CHECKPOINT_PROMPT).toContain('fresh session');
  });
});

describe('formatCheckpointBlock', () => {
  it('renders a leading separator, the dated header, and the summary body', () => {
    const block = formatCheckpointBlock('did stuff', new Date('2026-05-01T12:00:00Z'));
    expect(block).toBe('\n---\n## Checkpoint 2026-05-01\n\ndid stuff\n');
  });

  it('uses today (UTC) when no date is passed', () => {
    const block = formatCheckpointBlock('summary');
    const today = new Date().toISOString().slice(0, 10);
    expect(block).toContain(`## Checkpoint ${today}`);
  });

  it('uses the YYYY-MM-DD slice (UTC) regardless of local timezone', () => {
    // Date is in UTC, so the slice yields the UTC date even if local is different
    const block = formatCheckpointBlock('s', new Date('2026-01-15T23:59:59Z'));
    expect(block).toContain('## Checkpoint 2026-01-15');
  });

  it('preserves multi-line summary bodies verbatim', () => {
    const summary = 'line one\n- bullet\n\nparagraph two';
    const block = formatCheckpointBlock(summary, new Date('2026-05-01T00:00:00Z'));
    expect(block).toContain(summary);
    expect(block.endsWith('\n')).toBe(true);
  });

  it('always starts with a blank-line + horizontal-rule separator', () => {
    const block = formatCheckpointBlock('x', new Date('2026-05-01T00:00:00Z'));
    expect(block.startsWith('\n---\n')).toBe(true);
  });

  it('keeps an empty summary in place (caller decides whether to skip)', () => {
    const block = formatCheckpointBlock('', new Date('2026-05-01T00:00:00Z'));
    expect(block).toContain('## Checkpoint 2026-05-01');
    expect(block).toContain('\n\n\n'); // header newline + blank summary line
  });
});

describe('composeCheckpointAppend', () => {
  it('returns the block alone when existing content is empty', () => {
    const block = '\n---\n## Checkpoint 2026-05-01\n\nsummary\n';
    expect(composeCheckpointAppend('', block)).toBe(block);
  });

  it('does not add an extra newline when existing already ends with \\n', () => {
    const existing = 'first line\nsecond line\n';
    const block = '\n---\n## Checkpoint 2026-05-01\n\ns\n';
    const result = composeCheckpointAppend(existing, block);
    expect(result).toBe(existing + block);
    // existing ends with one \n, block starts with \n---, so the joined result
    // has exactly the two newlines (a blank line before the horizontal rule)
    // — not three (which would mean we double-added a separator).
    expect(result).not.toContain('\n\n\n---');
  });

  it('inserts a single newline when existing does not end with \\n', () => {
    const existing = 'no trailing newline';
    const block = '\n---\n## Checkpoint 2026-05-01\n\ns\n';
    const result = composeCheckpointAppend(existing, block);
    expect(result).toBe(existing + '\n' + block);
  });

  it('preserves the entire existing content as a prefix', () => {
    const existing = '# Project\n\nSome notes.\n';
    const block = '\n---\n## Checkpoint 2026-05-01\n\nx\n';
    const result = composeCheckpointAppend(existing, block);
    expect(result.startsWith(existing)).toBe(true);
    expect(result.endsWith(block)).toBe(true);
  });
});
