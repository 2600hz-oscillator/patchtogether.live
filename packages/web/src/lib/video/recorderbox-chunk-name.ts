// packages/web/src/lib/video/recorderbox-chunk-name.ts
//
// GoPro-style chunk file naming for RECORDERBOX: a long take rolls to a NEW file
// every ~10 min, and each chunk is named so it is UNIQUE and SORTS SEQUENTIALLY
// in Finder.
//
//   base "recording.mp4"  →  RECORDING-001-20260620-143005.mp4
//                            RECORDING-002-20260620-144005.mp4
//                            …
//
// Shape: `FILENAME-CHUNK#-DATETIME.mp4`
//   * FILENAME — the user's box value, sanitized + UPPERCASED (the card label
//     stays lowercase per the lowercase-label standard; only the FILE name is
//     uppercased here, matching the spec's RECORDING-001-… example).
//   * CHUNK#   — a 3-digit, 1-based, zero-padded counter (001, 002, …, 100, …).
//   * DATETIME — `YYYYMMDD-HHMMSS`, stamped at the chunk's roll time. This is
//     lexically sortable in Finder AND monotonically increasing across chunks
//     (each chunk is ~10 min after the last), so chunks sort sequentially even if
//     a base name repeats across sessions. The CHUNK# sorts too; the two agree.
//
// PURE — no browser API — so naming + sort-stability are unit-tested headlessly
// (CI-safe). The Date is injected so the datetime is deterministic in tests.

import { sanitizeRecordingFilename } from './recorderbox-store';

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Format a Date as the Finder-sortable `YYYYMMDD-HHMMSS` stamp (LOCAL time —
 *  the same wall clock the user names files against). Exported for tests + so the
 *  recovery/recorder paths can reuse the exact stamp form. */
export function chunkDateTimeStamp(when: Date): string {
  const y = when.getFullYear();
  const mo = pad2(when.getMonth() + 1);
  const d = pad2(when.getDate());
  const h = pad2(when.getHours());
  const mi = pad2(when.getMinutes());
  const s = pad2(when.getSeconds());
  return `${y}${mo}${d}-${h}${mi}${s}`;
}

/**
 * Build a chunk's file name: `FILENAME-CHUNK#-DATETIME.mp4`.
 *
 * @param baseFilename the user's box value (with or without a `.mp4`/other ext —
 *        it's stripped + the canonical `.mp4` re-appended). Hostile input is
 *        sanitized (path separators / control chars removed) via
 *        sanitizeRecordingFilename. Empty falls back to the sanitizer's
 *        timestamped default (then uppercased).
 * @param chunkIndex 1-based chunk number (001 = the first chunk).
 * @param when the roll time → the DATETIME stamp (inject a fixed Date in tests).
 */
export function chunkFileName(baseFilename: string | null | undefined, chunkIndex: number, when: Date): string {
  // Sanitize to an fs-safe name, drop the extension, uppercase the stem.
  const base = sanitizeRecordingFilename(baseFilename, 'mp4', when)
    .replace(/\.mp4$/i, '')
    .toUpperCase();
  const num = String(Math.max(1, Math.floor(chunkIndex))).padStart(3, '0');
  const dt = chunkDateTimeStamp(when);
  return `${base}-${num}-${dt}.mp4`;
}
