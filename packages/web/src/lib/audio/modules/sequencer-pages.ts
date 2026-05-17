// packages/web/src/lib/audio/modules/sequencer-pages.ts
//
// Pure helpers for the multi-page sequencer view (DRUMSEQZ, POLYSEQZ, MACSEQ,
// Sequencer). These helpers are framework-agnostic so the unit tests in each
// sequencer's *.test.ts can verify the math without instantiating a Svelte
// component or AudioContext.
//
// Concepts:
//   PAGE_SIZE  — 16 cells per page (one screen-row of step-cells).
//   MAX_STEPS  — 128 = PAGE_SIZE * MAX_PAGES.
//   MAX_PAGES  — 8.
//
// Per-card view state (local Svelte state, NOT persisted via Y.Doc):
//   userPage : number  — page the user selected via < / > buttons.
//   hold     : boolean — when true, the visible page stays put while the
//                         playhead advances; when false, the visible page
//                         follows the playhead (auto-page-during-playback).
//
// Per-module persisted state (Y.Doc-shared):
//   data.steps / data.tracks : up to MAX_STEPS cells per track / step row.
//   params.length : 1..MAX_STEPS (was 1..16 / 1..32 in pre-pages modules).

export const PAGE_SIZE = 16;
export const MAX_PAGES = 8;
export const MAX_STEPS = PAGE_SIZE * MAX_PAGES; // 128

/** Page count for a given length, clamped to [1, MAX_PAGES]. */
export function pageCountFor(length: number): number {
  const safe = Math.max(1, Math.floor(length));
  return Math.min(MAX_PAGES, Math.max(1, Math.ceil(safe / PAGE_SIZE)));
}

/** Page index the playhead is currently on (floor(step / PAGE_SIZE)),
 *  clamped to [0, pageCount(length) - 1]. */
export function playheadPageFor(currentStep: number, length: number): number {
  const pc = pageCountFor(length);
  const raw = Math.floor(Math.max(0, currentStep) / PAGE_SIZE);
  return Math.min(pc - 1, raw);
}

/** The visible page given the user's choice + the current playhead.
 *  When hold=true, the user controls the page (clamped). When hold=false,
 *  the visible page follows the playhead. */
export function visiblePageFor(
  userPage: number,
  currentStep: number,
  length: number,
  hold: boolean,
): number {
  const pc = pageCountFor(length);
  if (hold) {
    return Math.min(pc - 1, Math.max(0, Math.floor(userPage)));
  }
  return playheadPageFor(currentStep, length);
}

/** Inclusive [from, to) range of step indices visible on a given page. */
export function pageRange(page: number): { start: number; end: number } {
  const start = Math.max(0, Math.floor(page)) * PAGE_SIZE;
  return { start, end: start + PAGE_SIZE };
}

/**
 * Resize a step-data array to exactly MAX_STEPS, preserving any pre-existing
 * entries. New cells are populated via the caller's `make` factory so each
 * sequencer can pick its own "empty step" default (e.g. drumseqz cells use
 * {on:false, midi:null}; sequencer uses {on:false, midi:C3_MIDI, chord:'mono'}).
 *
 * Backward-compat: a sequencer saved with 16 cells loads with those 16 cells
 * intact at slots 0..15, and 112 default-empty cells appended at 16..127.
 */
export function ensureCapacity<T>(
  existing: T[] | undefined,
  make: (i: number) => T,
): T[] {
  const out: T[] = [];
  const prev = Array.isArray(existing) ? existing : [];
  for (let i = 0; i < MAX_STEPS; i++) {
    if (i < prev.length && prev[i] !== undefined) {
      out.push(prev[i] as T);
    } else {
      out.push(make(i));
    }
  }
  return out;
}
