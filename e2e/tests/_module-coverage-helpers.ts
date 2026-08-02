// e2e/tests/_module-coverage-helpers.ts
//
// Shared per-module-coverage helpers. Built lazily as the group-by-group
// coverage PRs need them — start minimal, grow under demand. Lives next
// to _helpers.ts (spawnPatch + readStatus) so test files only have to
// import from one place per concern.

import type { Page } from '@playwright/test';

/**
 * Read a scope module's analyser snapshot via the dev `__engine` hook.
 * Returns ch1 + ch2 Float32 arrays + the sample rate so callers can
 * convert sample counts to time. Mirrors the pattern from
 * `e2e/tests/voice-chain.spec.ts` (which inlines this read each time).
 *
 * `null` is returned if the engine isn't ready yet — callers should
 * usually wait for a `waitForTimeout` after wiring before reading.
 */
export async function readScopeSnapshot(
  page: Page,
  scopeNodeId: string,
): Promise<{ ch1: Float32Array; ch2: Float32Array; sampleRate: number } | null> {
  return await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __engine?: () => {
        read: (n: { id: string; type: string; domain: string }, k: string) => unknown;
      } | null;
      __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
    };
    const eng = w.__engine?.();
    if (!eng) return null;
    const node = w.__patch.nodes[id];
    if (!node) return null;
    const snap = eng.read(node, 'snapshot') as
      | { ch1: Float32Array; ch2: Float32Array; sampleRate: number }
      | undefined;
    if (!snap) return null;
    // Return plain arrays so they cross the page->node boundary intact.
    return {
      ch1: Array.from(snap.ch1) as unknown as Float32Array,
      ch2: Array.from(snap.ch2) as unknown as Float32Array,
      sampleRate: snap.sampleRate,
    };
  }, scopeNodeId);
}

/**
 * Compute peak + rms + nonzero-count summary from a Float32-like array.
 * Tests use this to assert "audio is flowing" without baking in exact
 * threshold semantics in every spec. Returns a `Summary` value object.
 */
export interface AudioSummary {
  peak: number;
  rms: number;
  nonzeroSamples: number;
  totalSamples: number;
}

export function summarize(samples: ArrayLike<number>): AudioSummary {
  let peak = 0;
  let energy = 0;
  let nonzero = 0;
  const n = samples.length;
  for (let i = 0; i < n; i++) {
    const v = samples[i];
    const a = Math.abs(v);
    if (a > peak) peak = a;
    energy += v * v;
    if (a > 1e-6) nonzero++;
  }
  return { peak, rms: Math.sqrt(energy / Math.max(1, n)), nonzeroSamples: nonzero, totalSamples: n };
}

/**
 * Wait a fixed wall-clock duration (ms). Thin wrapper for readability
 * in tests — `await runFor(page, 500)` reads better than
 * `await page.waitForTimeout(500)` when scattered through a long spec.
 *
 * ⚠ ONLY for waits on a genuinely WALL-CLOCK process — an analyser buffer
 * filling at the sample rate, an asset fetch, a spawns-per-SECOND generator.
 * A wait on RENDERED OUTPUT is a frame count, not a duration: see
 * `captureCanvasStatsFrameSpaced` below and the CLAUDE.md rule it implements.
 */
export async function runFor(page: Page, ms: number): Promise<void> {
  await page.waitForTimeout(ms);
}

// ═══════════════════════════════════════════════════════════════════════════
// THE OBSERVATION PLAN — and the BUDGET derived from it
// ═══════════════════════════════════════════════════════════════════════════
//
// The per-module behavioral sweep observes a module by spawning it twice per
// input port (control + patched) and fingerprinting a sink. The size of that
// job is a function of the SINK KIND: an audio sink polls a scope, a video
// sink reads back a canvas the WebGL engine is repainting on the page's own
// rAF loop. Those two plans cost different amounts and are paced by different
// clocks.
//
// The plan and the budget for it live HERE, in ONE module, because the failure
// that produced this file's frame-based capture was exactly a budget that had
// drifted away from the plan it was budgeting: a FLAT `inputs × 22 000 ms` in
// per-module-per-port-behavioral.spec.ts, whose own comment derives it from the
// AUDIO plan ("aggregated read 5×150ms"), applied unchanged to the VIDEO plan.
// `lushgarden` (3 video ports, 96 000 ms) blew it on main on both attempts of
// run 30742314468, and `luma` (5 video ports, 140 000 ms) blew it on the first
// attempt of the same shard. A constant cannot serve two plans.
//
// ── Which waits are FRAMES and which are MILLISECONDS ──────────────────────
//
// Not every wait here is renderer-dependent, and converting the wall-clock ones
// would be as wrong as leaving the frame ones. The test of it is: what is the
// thing being waited on paced by?
//
//   * The SETTLE stays MILLISECONDS. It waits on an AudioContext coming up, an
//     asset fetch/bake (lushgarden fetches ~75 plant cutouts), and generators
//     whose rate is declared in per-SECOND units (lushgarden's RATE is
//     spawns/second). All wall-clock; a frame count would make them
//     renderer-dependent, which is the bug inverted.
//   * The AUDIO capture spacing stays MILLISECONDS. An AnalyserNode fills at
//     the sample rate. Frames have nothing to do with it.
//   * The VIDEO capture spacing is FRAMES. `VideoOutCard.draw()` advances the
//     sink canvas EXACTLY ONE STEP PER rAF, so "how much has the picture moved
//     between two samples" is a frame count and nothing else.
//
// ── Why the video spacing had to change ────────────────────────────────────
//
// It was `waitForTimeout(200)`. MEASURED on one machine, one renderer
// (`E2E_SWIFTSHADER=1`, lushgarden → videoOut), across four runs, 200 ms bought
// 22, 23, 25 and 26 frames — and the free-running rAF rate on that same box
// ranged over 33.9, 76.9, 90.7, 108.3 and 120.4 fps run to run. Headless
// Chromium's rAF is not vsync-locked; it is a main-thread throughput number.
// So the spacing was never a fixed observation window even on ONE machine, let
// alone on a 4-vCPU runner running four workers under a software rasteriser.
//
// That is not only a pacing problem, it is a SOUNDNESS problem, and it is
// invisible from the output. `computeDelta`'s video arm ORs three criteria, one
// of which — `varRangeΔ > 10` — is the max-minus-min of the samples, i.e. it
// asks "how much did the picture move ACROSS the observation window". Sample
// three times inside one rendered frame and the range is 0 for BOTH the control
// and the patched run, so that criterion silently contributes nothing and the
// gate quietly falls back to the two mean-based criteria. It does not fail; it
// gets less sensitive, on exactly the machines that are slowest. A frame count
// is renderer-independent by construction and needs no per-machine calibration.
//
// ⚠ WHAT THIS DOES **NOT** FIX, measured while negative-controlling it. Making
// `lushgarden`'s RESET a no-op in the module and re-running the sweep, the
// `lushgarden.reset` assertion still PASSES most of the time — 7/10 at a
// 16-frame span, 6/10 at a 48-frame span, and 2/5 on the ORIGINAL wall-clock
// code. Tripling the span moves it by one run in ten: the observation window
// is NOT what makes that port vacuous. The video arm's ABSOLUTE floors are —
// `varMeanΔ > 5` against a module whose whole output variance is ~50, versus
// luma's ~4000. Three orders of magnitude, one constant.
// The video arm also has no per-port threshold mechanism at all,
// where the audio arm has BEHAVIORAL_DELTA_THRESHOLDS. That is a separate
// defect with a separate fix (a seeded garden via the existing
// `__lushgardenVrtSeed` hook so control and patched are the SAME garden, or
// per-port video thresholds) and it is why this lane is not yet fit to be
// REQUIRED. It is called out here rather than quietly left in the dark.

/** Sink kinds the sweep knows how to fingerprint. */
export type SinkKind = 'audio' | 'video';

/** Scope snapshots per aggregated audio read. */
export const AUDIO_CAPTURES = 5;
/** Wall clock BY DESIGN: an AnalyserNode fills at the sample rate. */
export const AUDIO_CAPTURE_SPACING_MS = 150;

/** Canvas readbacks per aggregated video read. */
export const VIDEO_CAPTURES = 3;
/**
 * RENDERED FRAMES between video samples. Replaces a 200 ms `waitForTimeout`.
 *
 * SIZED TO CHANGE THE WINDOW AS LITTLE AS POSSIBLE. The point of this constant
 * is that the window becomes the SAME everywhere, not that it becomes bigger or
 * smaller — so it is picked to sit inside the range the sweep has actually been
 * running at. MEASURED, what 200 ms bought per gap:
 *
 *     free-running page   29, 26 frames   (→ ~55-frame observation span)
 *     hog  30 ms/frame    16, 16 frames
 *     hog 120 ms/frame    11, 11 frames   (→ ~22-frame span)
 *     hog 250 ms/frame    10, 10 frames
 *
 * (It does not collapse to one frame under load because the Playwright round
 * trip starts to dominate — which is its own indictment: at 250 ms/frame those
 * "200 ms" gaps cost ~2.5 s of wall clock each. The old window was uncontrolled
 * in BOTH units.)
 *
 * 16 frames → a 32-frame span with 3 captures, i.e. between the ~22 frames a
 * loaded runner was getting and the ~55 a free-running box was. The delta
 * thresholds in `computeDelta` were calibrated against runs in that range, so
 * this neither tightens nor loosens them; it just stops the window being a
 * different width on every machine.
 */
export const VIDEO_CAPTURE_SPACING_FRAMES = 16;
/**
 * Wall-clock CAP on a video capture. This BOUNDS THE FAILURE — it is not the
 * gate (CLAUDE.md). A page whose rAF loop has stopped entirely can only be
 * caught by a clock; a page that is merely slow must be waited for.
 */
export const VIDEO_CAPTURE_CAP_MS = 20_000;

/** Settle after a spawn, before observing. WALL CLOCK — see the note above. */
export const SETTLE_MS = { sameDomainScope: 800, other: 1500 } as const;

// ── Budget calibration ─────────────────────────────────────────────────────
//
// Every term below is MEASURED on this repo's e2e harness under
// `E2E_SWIFTSHADER=1`, 1 worker, on a fast dev box, by timing the phases of
// per-module-per-port-behavioral.spec.ts's own port loop:
//
//   moog911 (AUDIO sink, 3 ports)   nav 1.01–1.21 s · spawn 0.08–0.64 s
//                                   settle 0.81 s · read 0.67–0.70 s
//                                   → 5.6 s per port
//   lushgarden (VIDEO sink, 3 ports) nav 1.00–1.21 s · spawn 0.08–0.68 s
//                                   settle 1.50 s · read 0.60–0.99 s
//                                   → 6.6–7.7 s per port
//
// The CI lane is not that box. It is four Playwright workers on a 4-vCPU
// runner with no GPU.

/** `page.goto('/rack')` + networkidle + spawnPatch + step seeding, per spawn. */
export const NAV_AND_SPAWN_MS = 1_400;
/** One scope snapshot: a `page.evaluate` round trip + Float32 marshalling. */
export const SCOPE_CAPTURE_MS = 35;
/** One canvas readback: `getImageData` + a full-frame JS pass. */
export const CANVAS_CAPTURE_MS = 110;
/** Control + patched. */
export const SPAWNS_PER_PORT = 2;
/** Fixed cushion for the test's own setup and the final assertions. */
export const BEHAVIORAL_BASELINE_MS = 30_000;

/**
 * How much slower the machine-dependent work is on the CI runner than on the
 * measured box.
 *
 * ⚠ NOT a free parameter — it is PINNED by a calibration this file's own policy
 * spec asserts. At 6, the model reproduces the historical flat 22 000 ms/port
 * for the AUDIO plan to within 1.4 % (1 400 + 1 575 × 6 = 10 850 per spawn,
 * ×2 = 21 700). That constant has been passing on this lane for months, so
 * reproducing it is evidence the model is calibrated rather than invented —
 * and it means this change does NOT loosen the audio budget. It re-derives it.
 */
export const RUNNER_FACTOR = 6;

/**
 * Extra tax on a VIDEO sink's machine-dependent work.
 *
 * A video SUT renders continuously ON THE SAME MAIN THREAD that every
 * Playwright operation in the port needs — the navigation, the spawn AND the
 * readbacks all queue behind the engine's rAF loop. So the runner tax on a
 * video port compounds; it is not confined to the read.
 *
 * MEASURED 1.37× on the fast box at 1 worker (7.7 s vs 5.6 s per port). On CI
 * it is larger: on run 30742314468 shard 3, `moog911` (audio, 3 ports) finished
 * inside its 96 000 ms while `lushgarden` (video, 3 ports) needed MORE than the
 * same 96 000 ms on both attempts — i.e. ≥1.45× — and `luma` (video, 5 ports)
 * overran 140 000 ms on its first attempt. 2 is the conservative round-up.
 */
export const VIDEO_MAIN_THREAD_FACTOR = 2;

/** ~8 fps — the SwiftShader floor CLAUDE.md records for backdraft PURE TV. The
 *  frame term is priced at the SLOW end on purpose: a budget's job is to cover
 *  the worst renderer, not the measured one. */
export const SLOW_FRAME_PERIOD_MS = 125;

/**
 * Wall-clock budget for ONE input port, DERIVED FROM THE PLAN that port will
 * actually execute — not from a constant.
 *
 * This is the whole point of the change: the number responds to the capture
 * count, the capture spacing, the settle and the sink kind, so a future edit to
 * the plan moves the budget with it instead of silently eating its headroom.
 */
export function perPortBudgetMs(sink: SinkKind, settleMs: number): number {
  if (sink === 'audio') {
    // Machine-dependent: navigate, spawn, and marshal each snapshot.
    const work = NAV_AND_SPAWN_MS + AUDIO_CAPTURES * SCOPE_CAPTURE_MS;
    // Wall-clock, identical on every machine.
    const fixed = settleMs + (AUDIO_CAPTURES - 1) * AUDIO_CAPTURE_SPACING_MS;
    return SPAWNS_PER_PORT * (fixed + work * RUNNER_FACTOR);
  }
  const work = NAV_AND_SPAWN_MS + VIDEO_CAPTURES * CANVAS_CAPTURE_MS;
  // The frame-spaced gaps, priced at the SLOW renderer's frame period.
  const frames = (VIDEO_CAPTURES - 1) * VIDEO_CAPTURE_SPACING_FRAMES;
  return SPAWNS_PER_PORT * (
    settleMs + frames * SLOW_FRAME_PERIOD_MS
    + work * RUNNER_FACTOR * VIDEO_MAIN_THREAD_FACTOR
  );
}

/** The test-level timeout: the per-port budget × the ports this test will
 *  actually drive, plus a fixed baseline. */
export function behavioralTimeoutMs(ports: number, sink: SinkKind, settleMs: number): number {
  return BEHAVIORAL_BASELINE_MS + ports * perPortBudgetMs(sink, settleMs);
}

/**
 * `timeout-minutes` on the `behavioral-coverage` job in ci.yml.
 *
 * A DERIVED budget has a failure mode a flat one does not: it can grow without
 * anyone deciding to grow it. Add two ports to a module, widen a capture plan,
 * and the per-test timeout moves on its own — and since a timeout only spends
 * wall clock when it FIRES, nothing notices until a red test eats the whole
 * CI job and the shard dies on ITS timeout instead, which reports as an
 * infrastructure failure rather than a test failure.
 *
 * So the job's own ceiling is pinned here and asserted against the worst-case
 * derived budget (× Playwright's `retries: 1`, i.e. two attempts) in
 * behavioral-observation-window.spec.ts. Moving `timeout-minutes` in ci.yml
 * without moving this makes the guard read the wrong ceiling — they are one
 * fact and they live in two files, so they are stated in both.
 */
export const BEHAVIORAL_JOB_TIMEOUT_MS = 20 * 60_000;

/** One video sample: the same two features `computeDelta`'s video arm reads. */
export interface VideoFrameStats {
  variance: number;
  nonBlackFrac: number;
}

export interface FrameSpacedCapture {
  samples: VideoFrameStats[];
  /** The rAF index each sample was taken on. Returned so the CALLER can assert
   *  the separation it asked for actually happened — the instrument reports the
   *  unit it counts in, rather than asking to be trusted. */
  frames: number[];
  elapsedMs: number;
}

/**
 * Sample a canvas N times, spaced a fixed number of RENDERED FRAMES apart,
 * entirely INSIDE THE PAGE.
 *
 * Two properties, both deliberate:
 *
 *  1. The spacing is a FRAME COUNT, so the observation window is the same
 *     window on a software rasteriser as on a GPU. The wall-clock cap exists
 *     only to bound a page whose rAF loop has DIED; it never decides how long
 *     a healthy capture waits.
 *  2. The accumulation happens in the page, on the rAF loop, so it costs ONE
 *     Playwright round trip instead of one per sample. That matters here for
 *     the reason CLAUDE.md gives for the workflow-master-transport rework: a
 *     Playwright-side poll loop samples a page-side quantity over the very
 *     main thread it is measuring, so a loaded runner starves the sampler and
 *     the subject together. The old read was three `locator.evaluate` round
 *     trips against a main thread already saturated by a WebGL engine.
 *
 * Returns `null` when the canvas or its 2D context is absent — the caller
 * reports that as a failed sink read, which is a different fact from "the
 * frames never came" and must not be conflated with it.
 */
export async function captureCanvasStatsFrameSpaced(
  page: Page,
  selector: string,
  opts: { captures: number; spacingFrames: number; capMs: number },
): Promise<FrameSpacedCapture | null> {
  return await page.evaluate(
    async ({ selector, captures, spacingFrames, capMs }) => {
      const canvas = document.querySelector(selector);
      if (!(canvas instanceof HTMLCanvasElement)) return null;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;

      // Identical arithmetic to the readback this replaces — the metric must
      // not move just because the pacing did.
      const grab = (): { variance: number; nonBlackFrac: number } => {
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const w = canvas.width, h = canvas.height;
        let n = 0, sum = 0, sumSq = 0, nonBlack = 0;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            const v = (img.data[i]! + img.data[i + 1]! + img.data[i + 2]!) / 3;
            sum += v; sumSq += v * v;
            if (v > 1) nonBlack++;
            n++;
          }
        }
        const mean = sum / n;
        return { variance: sumSq / n - mean * mean, nonBlackFrac: nonBlack / n };
      };

      return await new Promise<{
        samples: { variance: number; nonBlackFrac: number }[];
        frames: number[];
        elapsedMs: number;
      }>((resolve, reject) => {
        const t0 = performance.now();
        const samples: { variance: number; nonBlackFrac: number }[] = [];
        const frames: number[] = [];
        let frame = 0;
        const tick = () => {
          frame++;
          const due = frames.length === 0 || frame - frames[frames.length - 1]! >= spacingFrames;
          if (due) {
            samples.push(grab());
            frames.push(frame);
            if (samples.length >= captures) {
              resolve({ samples, frames, elapsedMs: performance.now() - t0 });
              return;
            }
          }
          const elapsed = performance.now() - t0;
          if (elapsed >= capMs) {
            // The message names the unit the GATE is counted in, and the unit
            // the CAP is counted in, so a red run says which one ran out.
            reject(new Error(
              `video capture: only ${samples.length}/${captures} samples spaced ` +
              `${spacingFrames} FRAMES after ${frame} rendered FRAMES / ` +
              `${Math.round(elapsed)} ms. The ${capMs} ms cap BOUNDS THE FAILURE; ` +
              `it is not the gate — hitting it means the rAF loop stalled, not ` +
              `that the renderer is slow.`,
            ));
            return;
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
    },
    { selector, captures: opts.captures, spacingFrames: opts.spacingFrames, capMs: opts.capMs },
  );
}

/**
 * Poll a scope's analyser over `windowMs` and return the MAX peak seen.
 * A single readScopeSnapshot only captures the ~50ms analyser buffer at
 * one instant — for envelope-driven voices (e.g. a 303's single-decay
 * amp env retriggered at 240 BPM) that instant can land in a decay
 * trough, so the one-shot peak dips under the alive-floor and the test
 * flakes. Max-holding across the whole drive window makes "does this
 * voice ever make sound?" robust for percussive/decaying/gated sources
 * without weakening the assertion (a truly silent module never crosses
 * the floor). Returns running max peak/rms + the max single-window
 * nonzero-sample count (the most-structured window seen, so an "is this a
 * sustained signal not a one-off glitch?" check stays meaningful under
 * max-hold) + the snapshot count.
 */
export async function readScopePeakOverWindow(
  page: Page,
  scopeNodeId: string,
  windowMs: number,
  pollMs = 60,
): Promise<{ peak: number; rms: number; nonzeroSamples: number; polls: number }> {
  const deadline = Date.now() + windowMs;
  let peak = 0;
  let rms = 0;
  let nonzeroSamples = 0;
  let polls = 0;
  while (Date.now() < deadline) {
    const snap = await readScopeSnapshot(page, scopeNodeId);
    if (snap) {
      const s = summarize(snap.ch1);
      if (s.peak > peak) peak = s.peak;
      if (s.rms > rms) rms = s.rms;
      if (s.nonzeroSamples > nonzeroSamples) nonzeroSamples = s.nonzeroSamples;
      polls++;
    }
    await page.waitForTimeout(pollMs);
  }
  return { peak, rms, nonzeroSamples, polls };
}

/**
 * Mutate one node's `params` record inside a Yjs transaction. Tests
 * use this to retroactively change a knob value (e.g. master fader,
 * sequencer bpm) without re-spawning the patch. Wraps `__ydoc.transact`
 * so the change replicates correctly to peers in collab tests too.
 */
export async function setNodeParams(
  page: Page,
  nodeId: string,
  params: Record<string, number>,
): Promise<void> {
  await page.evaluate(
    ({ id, p }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const node = w.__patch.nodes[id];
        if (!node.params) node.params = {};
        for (const [k, v] of Object.entries(p)) node.params[k] = v;
      });
    },
    { id: nodeId, p: params },
  );
}
