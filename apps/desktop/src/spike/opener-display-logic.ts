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
}

// ── Display math ────────────────────────────────────────────────────────────

/** The display the popup must land on: the first display that is NOT the
 *  primary. Null when the machine has no second display — the caller decides
 *  whether that is a refusal (real mode) or a degrade (dry-run). */
export function pickTargetDisplay(all: readonly DisplayLike[], primaryId: number): DisplayLike | null {
  return all.find((d) => d.id !== primaryId) ?? null;
}

/** Popup bounds: centered in the target display's work area (falling back to
 *  raw bounds), at 60% of each dimension with a floor — big enough that a
 *  mis-placed window visibly straddles displays instead of hiding in a
 *  corner, small enough that the titlebar stays reachable if placement is
 *  wrong and a human has to drag it. */
export function popupBoundsOn(display: DisplayLike): Rect {
  const area = display.workArea ?? display.bounds;
  const width = Math.max(320, Math.round(area.width * 0.6));
  const height = Math.max(240, Math.round(area.height * 0.6));
  return {
    x: area.x + Math.round((area.width - width) / 2),
    y: area.y + Math.round((area.height - height) / 2),
    width,
    height,
  };
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

// ── The pattern contract ────────────────────────────────────────────────────
// One definition shared by the opener-side draw and the popup-side readback,
// so the two halves cannot drift apart and silently pass. The background is
// MAGENTA — a color no black screen, no cleared canvas, and no letterboxed
// bar ever emits, which is what makes step 4 the captureStream-went-black
// test for the real path.

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

export function isNonBlack(px: Rgba, minChannel = 24): boolean {
  return (px[0] ?? 0) >= minChannel || (px[1] ?? 0) >= minChannel || (px[2] ?? 0) >= minChannel;
}

/** RGB within tolerance of an expected color (alpha ignored — the sink canvas
 *  is alpha:false). Tolerance absorbs color-management rounding, nothing more:
 *  a black pixel is ~255 away from magenta on two channels. */
export function approxColor(px: Rgba, expected: readonly number[], tolerance = 24): boolean {
  for (let i = 0; i < 3; i++) {
    if (Math.abs((px[i] ?? 0) - (expected[i] ?? 0)) > tolerance) return false;
  }
  return true;
}

/** Two point samples of the counter square differ enough to prove the frame
 *  counter moved. minDelta stays small (the counter walks 1/frame) but above
 *  any conceivable readback jitter on an alpha:false 2D canvas. */
export function pixelsDiffer(a: Rgba, b: Rgba, minDelta = 3): boolean {
  for (let i = 0; i < 3; i++) {
    if (Math.abs((a[i] ?? 0) - (b[i] ?? 0)) >= minDelta) return true;
  }
  return false;
}

// ── Verdict shaping ─────────────────────────────────────────────────────────

export type StepId =
  | 'displays' // 1. two displays detected
  | 'placement' // 2. popup landed on the SECOND display
  | 'domAccess' // 3. opener reached the popup's DOM + canvas context
  | 'blitPixels' // 4. opener-driven blit read back NON-BLACK, correct color, in the popup
  | 'motion'; // 5. the pattern advances — two samples differ

export const STEP_ORDER: readonly StepId[] = ['displays', 'placement', 'domAccess', 'blitPixels', 'motion'];

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
 * Fold the five step results into one verdict.
 *
 * Real mode: all five must PASS — a DRY or NOT-RUN step is a failure, so a
 * single-display run can never masquerade as the spike result.
 *
 * Dry-run: `displays`/`placement` may be DRY (there is no second display to
 * land on), but the wiring steps — domAccess, blitPixels, motion — must
 * actually PASS for the dry-run to be green. Exit 0 then means "the harness
 * itself works"; it explicitly does NOT unblock P4.
 */
export function verdict(steps: readonly StepResult[], opts: { dryRun: boolean }): SpikeVerdict {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const lines: string[] = [];
  let ok = true;
  for (const id of STEP_ORDER) {
    const step = byId.get(id) ?? { id, status: 'NOT-RUN' as const, detail: 'never reached' };
    const acceptable = step.status === 'PASS' || (opts.dryRun && step.status === 'DRY' && (id === 'displays' || id === 'placement'));
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
        ? 'SPIKE PASS — opener→popup DOM access AND the cross-display blit hold on this hardware. P4 may proceed on the window.open + setWindowOpenHandler architecture.'
        : 'SPIKE FAIL — if domAccess, blitPixels, or motion failed on real dual-monitor hardware, the P4 premise is dead: re-plan output windows (main-process BrowserWindows + a push transport) BEFORE any window-manager code. A placement-only failure is survivable — P4’s display map positions from MAIN anyway — but record it.',
    );
  }
  return { ok, exitCode: ok ? 0 : 1, lines };
}
