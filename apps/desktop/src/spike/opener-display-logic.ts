// PURE logic for the opener→popup cross-display blit spike — no `electron`
// import anywhere in this file, so every decision the harness makes about
// displays, placement, and pixels is unit-testable on any machine (including
// the machines the spike itself refuses to run on).
//
// Why the spike exists: plan.md §1.2 "main ↔ output windows" — the
// HIGHEST-RISK display assumption. P4's whole output design rests on a
// same-origin `window.open` popup on a SECOND display whose DOM the MAIN
// window's renderer keeps reaching into every frame (the /present blit). The
// fallback (captureStream) rendered BLACK on real dual-monitor hardware, so
// "it worked on one display" proves nothing — this spike is the dual-monitor
// answer, and `verdict()` below is deliberately strict about which steps are
// allowed to count outside that hardware.

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The subset of Electron's `Display` the spike reasons about. */
export interface DisplayLike {
  id: number;
  bounds: Rect;
  /** Bounds minus dock/menubar — where a window can actually sit. */
  workArea?: Rect;
  label?: string;
  scaleFactor?: number;
  detected?: boolean;
}

// ── Display math ────────────────────────────────────────────────────────────

/** Reject mirrored/overlapping desktop rectangles and known invalid/virtual IDs.
 * Electron can still describe remote displays: the operator confirms physical output. */
export function pickTargetDisplay(
  all: readonly DisplayLike[], primaryId: number, requestedId?: number,
): DisplayLike | null {
  const primary = all.find((d) => d.id === primaryId);
  if (!primary || !validRect(primary.bounds)) return null;
  return all.find((d) => d.id !== primaryId && d.id !== -1 && d.id !== -10
    && d.detected !== false && validRect(d.bounds)
    && (requestedId === undefined || d.id === requestedId)
    && intersectionArea(primary.bounds, d.bounds) === 0) ?? null;
}

function validRect(r: Rect): boolean {
  return [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.width > 0 && r.height > 0;
}

/** Stay inside the work area even on small displays. */
export function popupBoundsOn(display: DisplayLike): Rect {
  const area = display.workArea && validRect(display.workArea) ? display.workArea : display.bounds;
  if (!validRect(area)) throw new Error('Display has no usable bounds');
  const width = Math.min(area.width, Math.max(320, Math.round(area.width * 0.6)));
  const height = Math.min(area.height, Math.max(240, Math.round(area.height * 0.6)));
  return { x: area.x + Math.round((area.width - width) / 2),
    y: area.y + Math.round((area.height - height) / 2), width, height };
}

/** A majority match alone can accept a mostly off-screen window. */
export function isOnDisplay(rect: Rect, display: DisplayLike): boolean {
  return validRect(rect) && validRect(display.bounds)
    && intersectionArea(rect, display.bounds) / (rect.width * rect.height) >= 0.99;
}

/** window.open features for those bounds — the same `popup,left/top/width/
 *  height` shape present-window.ts sends, because the spike must ride the
 *  exact same `setWindowOpenHandler` path the product does. */
export function popupFeatures(rect: Rect): string {
  return `popup,left=${rect.x},top=${rect.y},width=${rect.width},height=${rect.height}`;
}

export function intersectionArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** Which display holds the largest share of `rect` — a pure mirror of
 *  Electron's `screen.getDisplayMatching`, used for the placement CHECK so
 *  the check itself has unit tests. Zero overlap with every display → null
 *  (an off-screen window is a placement failure, not "closest display"). */
export function displayContaining(all: readonly DisplayLike[], rect: Rect): DisplayLike | null {
  let best: DisplayLike | null = null;
  let bestArea = 0;
  for (const d of all) {
    const area = intersectionArea(d.bounds, rect);
    if (area > bestArea) {
      best = d;
      bestArea = area;
    }
  }
  return best;
}

// Shared draw/readback coordinates. These prove canvas content; page capture
// and operator confirmation separately cover composition and physical output.

export const PATTERN = {
  /** Full-canvas fill. */
  background: [255, 0, 255] as const,
  /** Top-left square that encodes the frame counter (so motion is provable
   *  from two point samples, whatever the frame rate). */
  counterSize: 32,
  /** Probe inside the counter square. */
  counterProbe: { x: 8, y: 8 },
  /** Probe safely outside the counter square, inside any sane canvas. */
  backgroundProbe: { x: 96, y: 96 },
} as const;

/** The counter square's color at a given painted-frame count. Red walks one
 *  step per frame; green carries the wrap; blue pins the square at a value
 *  the magenta background never has. */
export function counterColor(frame: number): [number, number, number] {
  return [frame % 256, Math.floor(frame / 256) % 256, 128];
}

// ── Pixel predicates ────────────────────────────────────────────────────────

export type Rgba = readonly number[]; // [r, g, b, a] from getImageData().data

/** RGB within tolerance of an expected color (alpha ignored — the sink canvas
 *  is alpha:false). Tolerance absorbs color-management rounding, nothing more:
 *  a black pixel is ~255 away from magenta on two channels. */
export function approxColor(px: Rgba, expected: readonly number[], tolerance = 24): boolean {
  if (px.length < 3 || expected.length < 3 || !Number.isFinite(tolerance) || tolerance < 0) return false;
  for (let i = 0; i < 3; i++) {
    if (!Number.isFinite(px[i]) || !Number.isFinite(expected[i]) || Math.abs(px[i]! - expected[i]!) > tolerance) return false;
  }
  return true;
}

export interface PixelSample {
  counter: number[];
  background: number[];
  painted: number;
  w: number;
  h: number;
}

/** Each count and pixel sample is read together in the popup renderer. */
export function validSample(sample: PixelSample): boolean {
  return Number.isSafeInteger(sample.painted) && sample.painted >= 1
    && sample.w > PATTERN.backgroundProbe.x && sample.h > PATTERN.backgroundProbe.y
    && approxColor(sample.background, PATTERN.background)
    && approxColor(sample.counter, counterColor(sample.painted), 0);
}

export function motionAdvanced(samples: readonly PixelSample[]): boolean {
  if (samples.length < 2 || !samples.every(validSample)) return false;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i]!.painted < samples[i - 1]!.painted) return false;
  }
  return samples[samples.length - 1]!.painted - samples[0]!.painted >= 3;
}

/** The page-capture counter must advance as an encoded frame, not change to
 * an unrelated color. The observation is far shorter than half the 16-bit cycle. */
export function compositeAdvanced(a: readonly number[], b: readonly number[]): boolean {
  const valid = (px: readonly number[]) => px.length >= 3 && px.slice(0, 3).every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
    && Math.abs(px[2]! - 128) <= 1;
  if (!valid(a) || !valid(b)) return false;
  const delta = (b[0]! + 256 * b[1]! - a[0]! - 256 * a[1]! + 65536) % 65536;
  return delta >= 3 && delta < 32768;
}

// ── Verdict shaping ─────────────────────────────────────────────────────────

export type StepId =
  | 'displays' // 1. two displays detected
  | 'placement' // 2. popup landed on the SECOND display
  | 'domAccess' // 3. opener reached the popup's DOM + canvas context
  | 'blitPixels' // 4. opener-driven blit read back NON-BLACK, correct color, in the popup
  | 'motion' // advancing counts match the sampled pixels
  | 'composited' // visible page capture agrees with the canvas
  | 'operator'; // physical display and visible motion confirmed by the owner

export const STEP_ORDER: readonly StepId[] = ['displays', 'placement', 'domAccess', 'blitPixels', 'motion', 'composited', 'operator'];

export type StepStatus =
  | 'PASS'
  | 'FAIL'
  /** Not reached (an earlier step failed / hardware refused). */
  | 'NOT-RUN'
  /** Ran in --dry-run degrade (single display): the wiring executed but the
   *  step's real question was NOT answered. Never counts as a spike PASS. */
  | 'DRY';

export interface StepResult {
  id: StepId;
  status: StepStatus;
  detail: string;
}

export interface SpikeVerdict {
  ok: boolean;
  exitCode: 0 | 1;
  lines: string[];
}

export const HARDWARE_REFUSAL =
  'SPIKE REQUIRES DUAL-MONITOR HARDWARE — run `task desktop:spike` on the owner’s machine ' +
  '(or `task desktop:spike -- --dry-run` to exercise the wiring on this one).';

/**
 * Fold the step results into one verdict.
 *
 * Real mode: all steps must PASS — a DRY or NOT-RUN step is a failure, so a
 * single-display run can never masquerade as the spike result.
 *
 * Dry-run: `displays`/`placement`/`operator` may be DRY (there is no second display to
 * land on), but the wiring steps — domAccess, blitPixels, motion, composited — must
 * actually PASS for the dry-run to be green. Exit 0 then means "the harness
 * itself works"; it explicitly does NOT unblock P4.
 */
export function verdict(steps: readonly StepResult[], opts: { dryRun: boolean; error?: string }): SpikeVerdict {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const lines: string[] = [];
  let ok = !opts.error && byId.size === steps.length;
  if (opts.error) lines.push(`HARNESS ERROR: ${opts.error}`);
  if (byId.size !== steps.length) lines.push('INVALID RESULT: duplicate step IDs');
  for (const id of STEP_ORDER) {
    const step = byId.get(id) ?? { id, status: 'NOT-RUN' as const, detail: 'never reached' };
    const acceptable = step.status === 'PASS' || (opts.dryRun && step.status === 'DRY' && (id === 'displays' || id === 'placement' || id === 'operator'));
    if (!acceptable) ok = false;
    lines.push(`${step.status.padEnd(7)} ${id.padEnd(10)} ${step.detail}`);
  }
  if (opts.dryRun) {
    lines.push(
      ok
        ? 'DRY-RUN OK — the harness wiring works on this machine. This is NOT the spike result and unblocks nothing: run `task desktop:spike` on the dual-monitor rig.'
        : 'DRY-RUN FAILED — the harness itself is broken; fix it before asking the owner to run anything.',
    );
  } else {
    lines.push(
      ok
        ? 'SPIKE PASS — automated checks passed and the operator confirmed visible motion on the target physical display. P4 may proceed on the window.open + setWindowOpenHandler architecture.'
        : 'SPIKE FAIL — inspect the failed steps and saved evidence before P4. Canvas readback and page capture alone cannot establish physical output; a confirmed cross-display failure requires reviewing the output architecture.',
    );
  }
  return { ok, exitCode: ok ? 0 : 1, lines };
}
