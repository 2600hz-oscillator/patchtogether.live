// packages/web/src/lib/video/recorderbox-chunk-name.test.ts
//
// Unit coverage for GoPro-style chunk naming: FILENAME-CHUNK#-DATETIME.mp4,
// 3-digit chunk from 001, UNIQUE + sequentially SORTABLE in Finder. PURE — the
// Date is injected so the datetime is deterministic. CI-safe (no encoder).

import { describe, it, expect } from 'vitest';
import { chunkFileName, chunkDateTimeStamp } from './recorderbox-chunk-name';

// 2026-06-20 14:30:05 local.
const T0 = new Date(2026, 5, 20, 14, 30, 5);

describe('chunkDateTimeStamp', () => {
  it('formats YYYYMMDD-HHMMSS (zero-padded)', () => {
    expect(chunkDateTimeStamp(new Date(2026, 5, 20, 14, 30, 5))).toBe('20260620-143005');
    expect(chunkDateTimeStamp(new Date(2026, 0, 3, 9, 7, 2))).toBe('20260103-090702');
  });
});

describe('chunkFileName — FILENAME-CHUNK#-DATETIME.mp4', () => {
  it('matches the spec example: recording.mp4 → RECORDING-001-<datetime>.mp4', () => {
    expect(chunkFileName('recording.mp4', 1, T0)).toBe('RECORDING-001-20260620-143005.mp4');
  });

  it('uppercases the base + appends .mp4 when the ext is missing', () => {
    expect(chunkFileName('recording', 1, T0)).toBe('RECORDING-001-20260620-143005.mp4');
    expect(chunkFileName('My Jam', 2, T0)).toBe('MY JAM-002-20260620-143005.mp4');
  });

  it('zero-pads the chunk number to 3 digits (1→001, 42→042, 100→100, 1000→1000)', () => {
    expect(chunkFileName('x', 1, T0)).toMatch(/^X-001-/);
    expect(chunkFileName('x', 42, T0)).toMatch(/^X-042-/);
    expect(chunkFileName('x', 100, T0)).toMatch(/^X-100-/);
    // >999 keeps all digits (no truncation) — padStart is a MINIMUM width.
    expect(chunkFileName('x', 1000, T0)).toMatch(/^X-1000-/);
  });

  it('clamps a 0 / negative / fractional index to a valid 1-based number', () => {
    expect(chunkFileName('x', 0, T0)).toMatch(/^X-001-/);
    expect(chunkFileName('x', -3, T0)).toMatch(/^X-001-/);
    expect(chunkFileName('x', 2.9, T0)).toMatch(/^X-002-/);
  });

  it('strips a user-typed extension (any case) before re-appending .mp4', () => {
    expect(chunkFileName('clip.MOV', 1, T0)).toBe('CLIP-001-20260620-143005.mp4');
    expect(chunkFileName('clip.webm', 1, T0)).toBe('CLIP-001-20260620-143005.mp4');
  });

  it('sanitizes filesystem-hostile input (path separators / control chars)', () => {
    expect(chunkFileName('a/b\\c:d*e?f"g<h>i|j', 1, T0)).toBe('ABCDEFGHIJ-001-20260620-143005.mp4');
  });

  it('falls back to a timestamped default for empty input', () => {
    // sanitizeRecordingFilename's empty fallback → recording-YYYYMMDD-HHMMSS,
    // then uppercased.
    expect(chunkFileName('', 1, T0)).toBe('RECORDING-20260620-143005-001-20260620-143005.mp4');
    expect(chunkFileName(null, 1, T0)).toMatch(/^RECORDING-20260620-143005-001-/);
  });

  it('LEXICAL sort == NUMERIC sort across a sequence (Finder-sortable)', () => {
    // Chunks rolled ~10 min apart over a long take.
    const names: string[] = [];
    for (let i = 1; i <= 12; i++) {
      const when = new Date(2026, 5, 20, 14, 30 + (i - 1) * 10, 5);
      names.push(chunkFileName('recording', i, when));
    }
    // A copy sorted as STRINGS (what Finder does) must equal generation order.
    const lex = [...names].sort();
    expect(lex).toEqual(names);
    // And the 3-digit chunk# also sorts correctly past the 9→10 boundary
    // (001..009,010,011,012 — the reason for zero-padding).
    expect(names[8]).toMatch(/-009-/);
    expect(names[9]).toMatch(/-010-/);
    expect(lex[8]).toMatch(/-009-/);
    expect(lex[9]).toMatch(/-010-/);
  });

  it('is UNIQUE per chunk (the datetime advances each roll)', () => {
    const a = chunkFileName('jam', 1, new Date(2026, 5, 20, 14, 30, 5));
    const b = chunkFileName('jam', 2, new Date(2026, 5, 20, 14, 40, 5));
    expect(a).not.toBe(b);
  });
});
