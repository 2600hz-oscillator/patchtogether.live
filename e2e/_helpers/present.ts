// e2e/_helpers/present.ts
//
// THE RECEIVER-SIDE PROBE for "is the projector actually showing something".
//
// ⚠ WHY A COUNTER IS NOT AN ANSWER. Every continuity assertion this project had
// written down measured a FRAME COUNTER in the driving window. The blit those
// frames run (packages/web/src/lib/ui/modules/present-window.ts) black-fills the
// sink canvas unconditionally before it draws, gates the `drawImage` on the
// source having real pixels, and wraps the whole frame in a bare `catch {}` —
// deliberately, so a lost GL context cannot kill the loop. Put together: a
// projector that is open, correctly identified, pulling frames on schedule and
// painting PURE BLACK satisfied every visual assertion in the system. So did one
// frozen on its last good frame. The counter cannot fail for the reasons the
// feature exists to prevent.
//
// What this reads instead is the SINK's own pixels, in the sink's own page, and
// the rule it enables is causal rather than statistical: CHANGE THE GRAPH, then
// require the receiver's hash to follow. That single assertion covers the whole
// chain — a closed popup cannot be sampled, a dead render lease freezes the
// node, a severed blit freezes the picture — and it needs no animated content
// and no wall-clock frame budget, so CI's ~8 fps software rasteriser does not
// change the claim.
//
// ⚠ ZERO SAMPLES IS A FAILURE, NOT AN "UNCHANGED". `0.0000` is FIRST an
// instrument bug in this repo, and a probe that quietly returns "no difference"
// when it read no pixels at all is the same class of lie. Every reader below
// reports how much it actually sampled and the callers assert on it.
//
// ⚠ FRAMES ARE COUNTED IN THE DRIVING WINDOW. The pacing `waitFrames` here runs
// on the OPENER, which is the window Playwright keeps focused; an unfocused
// popup has its rAF throttled, so counting frames THERE measures the wrong clock
// (that is what made the first frames-based fix flake, #1903). The pixels are
// read in the popup; only the clock stays in the opener.

import { expect, type Page } from '@playwright/test';
import { waitFrames } from './frames';

export interface PresentFrameSample {
  /** FNV-1a over a stride-sampled sweep of the WHOLE sink canvas. */
  hash: number;
  /** Any pixel meaningfully above black. */
  nonBlack: boolean;
  /** How many pixels went into the hash. ZERO means the probe read nothing —
   *  never treat that as "the picture did not change". */
  sampled: number;
  /** Backing-store dimensions, so a failure can say whether the canvas was
   *  simply never sized. */
  width: number;
  height: number;
}

/**
 * Sample the sink canvas IN THE POPUP'S OWN PAGE.
 *
 * Returns null when the popup is gone or carries no usable canvas — a CLOSED
 * projector and a FROZEN one must stay distinguishable in a failure message,
 * because "the output stops" has two causes that need opposite fixes.
 */
export async function presentFrame(popup: Page): Promise<PresentFrameSample | null> {
  if (popup.isClosed()) return null;
  return popup
    .evaluate(() => {
      const c = document.querySelector<HTMLCanvasElement>('[data-testid="present-canvas"]');
      if (!c || c.width < 2 || c.height < 2) return null;
      const ctx = c.getContext('2d');
      if (!ctx) return null;
      const { data } = ctx.getImageData(0, 0, c.width, c.height);
      let hash = 2166136261;
      let nonBlack = false;
      let sampled = 0;
      // Stride 8 pixels (32 bytes) — ~1/8 of the frame, enough to key on and
      // cheap enough to read every batch. Whole-canvas rather than a crop so a
      // change ANYWHERE in the projected frame registers.
      for (let i = 0; i < data.length; i += 32) {
        hash = Math.imul(hash ^ data[i]!, 16777619);
        hash = Math.imul(hash ^ data[i + 1]!, 16777619);
        hash = Math.imul(hash ^ data[i + 2]!, 16777619);
        if (data[i]! > 16 || data[i + 1]! > 16 || data[i + 2]! > 16) nonBlack = true;
        sampled++;
      }
      return { hash: hash >>> 0, nonBlack, sampled, width: c.width, height: c.height };
    })
    .catch(() => null);
}

/** Sample, and FAIL rather than return an unusable reading. */
export async function requirePresentFrame(
  popup: Page,
  what: string,
): Promise<PresentFrameSample> {
  const s = await presentFrame(popup);
  expect(
    s,
    `${what}: the projector canvas could not be sampled at all — the popup is ` +
      `closed, unsized, or has no 2D context. This is an INSTRUMENT failure, not a pass.`,
  ).not.toBeNull();
  expect(
    s!.sampled,
    `${what}: the probe folded ZERO pixels into its hash (canvas ${s!.width}×${s!.height}). ` +
      'A zero-sample read must never be reported as "the picture did not change".',
  ).toBeGreaterThan(0);
  return s!;
}

/** The sink's own view of its link — receiver-side diagnostics for a failure
 *  message. Present only in DEV / VITE_E2E_HOOKS builds; null otherwise. */
export interface PresentSinkStats {
  state: 'waiting' | 'live' | 'stalled' | 'lost';
  ticks: number;
  painted: number;
  errors: number;
  ticksSincePaint: number;
  everPainted: boolean;
  slot: string;
}

export async function presentSinkStats(popup: Page): Promise<PresentSinkStats | null> {
  if (popup.isClosed()) return null;
  return popup
    .evaluate(
      () => (globalThis as unknown as { __presentStats?: PresentSinkStats }).__presentStats ?? null,
    )
    .catch(() => null);
}

export interface FollowResult {
  /** The predicate held on some read within the budget. */
  ok: boolean;
  framesWaited: number;
  /** Reads that produced a usable sample. Zero means the probe was blind. */
  reads: number;
  last: PresentFrameSample | null;
  stats: PresentSinkStats | null;
}

/**
 * Pace on the OPENER's frames and watch the RECEIVER's pixels until `pred`
 * holds, or the frame budget is spent.
 *
 * Used in BOTH directions: a positive leg waits for `ok`, a negative leg spends
 * the whole budget and asserts `ok` never became true. It never asserts on its
 * own — the caller owns the claim, because the same loop proves opposite things.
 */
export async function awaitReceiver(
  opener: Page,
  popup: Page,
  pred: (s: PresentFrameSample) => boolean,
  budgetFrames: number,
  batchFrames = 5,
): Promise<FollowResult> {
  let framesWaited = 0;
  let reads = 0;
  let last: PresentFrameSample | null = null;
  let ok = false;
  while (framesWaited < budgetFrames) {
    await waitFrames(opener, batchFrames);
    framesWaited += batchFrames;
    const s = await presentFrame(popup);
    if (s && s.sampled > 0) {
      reads++;
      last = s;
      if (pred(s)) {
        ok = true;
        break;
      }
    }
  }
  return { ok, framesWaited, reads, last, stats: await presentSinkStats(popup) };
}

/** The common case: watch for the projected picture to CHANGE from a known
 *  hash. `ok` means it did. */
export function followReceiver(
  opener: Page,
  popup: Page,
  fromHash: number,
  budgetFrames: number,
  batchFrames = 5,
): Promise<FollowResult> {
  return awaitReceiver(opener, popup, (s) => s.hash !== fromHash, budgetFrames, batchFrames);
}

/** One-line diagnosis for a failure message: what the receiver last saw and
 *  what the sink itself thinks of its link. */
export function describeReceiver(r: FollowResult): string {
  const s = r.last;
  const st = r.stats;
  return (
    `${r.reads} usable read(s) over ${r.framesWaited} opener frames; ` +
    (s
      ? `last frame hash=${s.hash} nonBlack=${s.nonBlack} sampled=${s.sampled} (${s.width}×${s.height})`
      : 'NO usable frame — the popup could not be sampled') +
    (st
      ? `; sink says state=${st.state} painted=${st.painted} errors=${st.errors} ` +
        `ticks=${st.ticks} sincePaint=${st.ticksSincePaint} slot="${st.slot}"`
      : '; sink stats unavailable (a build without test hooks?)')
  );
}
