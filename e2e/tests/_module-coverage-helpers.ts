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
// SCOPE PEAK-HOLD — the accumulator lives IN THE PAGE
// ═══════════════════════════════════════════════════════════════════════════
//
// `readScopeSnapshot` in a Playwright-side `for` loop is the exact pattern
// CLAUDE.md forbids ("Never sample a page-side quantity with a Playwright-side
// poll loop"), and here it was also the emit sweep's single largest cost. Each
// poll is a `waitForTimeout` PLUS a `page.evaluate` that serialises the whole
// analyser buffer — `Array.from(snap.ch1)` + `ch2`, i.e. ~4 096 numbers as JSON
// per sample — and every one of those crosses CDP on the same main thread as
// the audio graph and the (SwiftShader) GL draw it is measuring.
//
// MEASURED, E2E_SWIFTSHADER=1, `midiLane` (5 live outputs): the loop asked for
// `totalMs = 1 200` and spent **11.4 s per port**. A poll intended to cost
// 30 ms actually cost ~420 ms. The variable named `totalMs` was not a window at
// all — it was `polls × round-trip`, wrong by ~10×, so the code's stated "1.2 s
// of poll window" and its real behaviour had nothing to do with each other.
//
// It is ALSO the weaker observation, which is the part worth noticing. The
// analyser holds ~43 ms (fftSize 2048 @ 48 kHz), so sampling every ~420 ms sees
// ~43 ms out of every ~420 — a **~10 % duty cycle**. Over 27 polls that is
// ~1.2 s of signal timeline observed, scattered across 11.4 s of wall clock,
// and a gate pulse landing in one of the ~90 % blind gaps is simply missed. The
// pass was partly luck.
//
// Sampling in-page on a `setInterval` finer than the analyser window makes the
// coverage CONTIGUOUS: ~40 samples at 30 ms spacing over a real 1 200 ms window
// observe the same ~1.2 s of signal timeline with NO gaps, in 1/10 the wall
// clock. Same evidence, tenth the cost, and a 2 Hz gate (TIMELORDE.1x, the
// worst case the window is sized for) can no longer fall through a gap.
//
// Three further properties, all from CLAUDE.md's treatment of this pattern:
//   * ONE round trip total, and it carries four numbers instead of 4 096.
//   * The accumulated peak SURVIVES a main-thread stall — a page frozen for
//     3 s and then released still reports every value it computed.
//   * `samples` / `elapsedMs` come back with the result, so "polled the whole
//     window and it was silent" is DISTINGUISHABLE from "never got a reading".
//     Both used to print `maxPeak=0.0000`: the old loop's `if (!snap) continue`
//     swallowed a permanently unresolvable engine handle and reported it as a
//     dead port. Callers assert `samples > 0` so the instrument fails as an
//     instrument rather than as a finding.

export interface ScopeObservation {
  /** Peak-hold over ch1 (the patched channel) across the whole window. */
  maxPeak: number;
  /** RMS of the LAST sample taken — a level hint for the failure message. */
  lastRms: number;
  /** Peak-hold over ch2. NOTHING is patched there by the emit sweep, so a hot
   *  ch2 means the sink was wired wrong, not that the port is alive. Reported
   *  in the message only. */
  maxPeakCh2: number;
  /** How many readings were actually taken. 0 ⇒ the instrument never read. */
  samples: number;
  /** Real wall-clock span of the observation, for the same reason. */
  elapsedMs: number;
}

/**
 * Peak-hold a scope's analyser for `windowMs`, sampling every `sampleMs`
 * INSIDE the page, and stop early once ch1 crosses `floor`.
 *
 * `sampleMs` must stay BELOW the analyser's ~43 ms refresh or the coverage
 * goes sparse again — that bound is the whole point of the default.
 */
export async function observeScopePeak(
  page: Page,
  scopeNodeId: string,
  opts: { windowMs: number; floor: number; sampleMs?: number },
): Promise<ScopeObservation> {
  const { windowMs, floor } = opts;
  const sampleMs = opts.sampleMs ?? 30;
  return await page.evaluate(
    ({ id, windowMs, floor, sampleMs }) =>
      new Promise<ScopeObservation>((resolve) => {
        const w = globalThis as unknown as {
          __engine?: () => {
            read: (n: { id: string; type: string; domain: string }, k: string) => unknown;
          } | null;
          __patch?: { nodes: Record<string, { id: string; type: string; domain: string }> };
        };
        const t0 = performance.now();
        let maxPeak = 0;
        let maxPeakCh2 = 0;
        let lastRms = 0;
        let samples = 0;
        let timer = 0;
        const finish = (): void => {
          clearInterval(timer);
          resolve({ maxPeak, lastRms, maxPeakCh2, samples, elapsedMs: performance.now() - t0 });
        };
        const sample = (): void => {
          const eng = w.__engine?.();
          const node = w.__patch?.nodes?.[id];
          if (eng && node) {
            const snap = eng.read(node, 'snapshot') as
              | { ch1: Float32Array; ch2?: Float32Array }
              | undefined;
            if (snap?.ch1) {
              samples++;
              const a = snap.ch1;
              let peak = 0;
              let energy = 0;
              for (let i = 0; i < a.length; i++) {
                const v = a[i]!;
                const abs = v < 0 ? -v : v;
                if (abs > peak) peak = abs;
                energy += v * v;
              }
              if (peak > maxPeak) maxPeak = peak;
              lastRms = Math.sqrt(energy / Math.max(1, a.length));
              const b = snap.ch2;
              if (b) {
                let p2 = 0;
                for (let i = 0; i < b.length; i++) {
                  const v = b[i]!;
                  const abs = v < 0 ? -v : v;
                  if (abs > p2) p2 = abs;
                }
                if (p2 > maxPeakCh2) maxPeakCh2 = p2;
              }
            }
          }
          // Early-out the instant the tap clears the floor (continuous audio /
          // CV cases bail on the first reading), else run the window out — a
          // genuinely silent output pays the FULL window and still fails at 0.
          if (maxPeak > floor || performance.now() - t0 >= windowMs) finish();
        };
        timer = setInterval(sample, sampleMs) as unknown as number;
        sample();
      }),
    { id: scopeNodeId, windowMs, floor, sampleMs },
  );
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

/** `page.goto('/rack?shell=legacy')` + networkidle + spawnPatch + step seeding, per spawn. */
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

// ── THE AUDIO OBSERVATION WINDOW LIVES IN THE PAGE, NOT IN PLAYWRIGHT ───────
//
// CLAUDE.md, "VALIDATE THE INSTRUMENT", defence #5, verbatim: "NEVER sample a
// page-side quantity with a Playwright-side poll loop. […] a stalled thread can
// burn the whole window in two reads and then report […] off a sample size of
// two. […] Move the accumulator INTO the page."
//
// This helper was that exact anti-pattern —
//   while (Date.now() < deadline) { await page.evaluate(read); await waitForTimeout(60) }
// — one CDP round-trip per sample, on the SAME main thread as the audio graph,
// the scheduler tick and the WebGL cards it is measuring. On a contended runner
// the sampler starves together with its subject, and the "600 ms window"
// silently becomes ONE 42 ms peek at an arbitrary instant.
//
// MEASURED, from the trace of the run that failed (PR #1303, e2e shard 1/10,
// run 30758889295, `cube poly chord (POLYSEQZ → poly)`), BOTH attempts:
//
//     attempt      seed steps    ONE readScopeSnapshot   ONE waitForTimeout(60)
//     initial       @5.75 s         255 ms                   392 ms
//     retry #1      @6.34 s         325 ms                   393 ms
//
// 255 + 392 = 647 ms > the 600 ms deadline, so the loop exited after ONE
// iteration. `polls === 1`. The assertion then reported `Received: 0` — and
// "the voice is silent" and "we looked once, 250 ms after seeding, and the
// first gated step had not sounded yet" are INDISTINGUISHABLE from that
// output. That is the whole bug: the instrument, not the module.
//
// THE FIX, three parts, all of which are properties rather than tuning:
//
//  1. ONE `page.evaluate` for the whole window; the accumulator runs on a
//     `setInterval` INSIDE the page. Zero protocol traffic during the window,
//     so the sampler no longer competes with the subject, and the accumulated
//     max SURVIVES a stall (a thread frozen for 400 ms and then released still
//     reports every value it managed to compute).
//  2. `pollMs` drops 60 → 20, comfortably finer than the ~42 ms AnalyserNode
//     ring at 48 kHz/2048, so consecutive samples overlap and a transient
//     cannot fall between two reads. This is only affordable because of (1).
//  3. `untilPeak` turns "observe for a fixed wall-clock window" into "observe
//     UNTIL the thing happens, bounded by a cap" for the callers that are
//     asking `does this ever make sound?`. A fixed window is a DIFFERENT
//     assertion on every machine (the CLAUDE.md frames-vs-milliseconds
//     argument, in the audio domain: a gated voice needs the main-thread
//     scheduler to tick, and how many ticks fit in 600 ms is a property of the
//     runner). A bounded condition-wait is the same assertion everywhere, and
//     on a healthy machine it returns EARLIER than the old fixed window — so
//     this is a CI wall-time saving, not a cost. Callers asserting SILENCE
//     deliberately omit it and observe the full window.
//
// `polls === 0` THROWS. "The instrument never looked" must never be able to
// masquerade as "the module is silent" — that ambiguity is what cost this run,
// and every one of the ~40 call sites now gets the guard for free.

/** What one observation window saw. `polls` / `elapsedMs` / `audioAdvancedS`
 *  are the INSTRUMENT's own vitals — put them in assertion messages so a red
 *  run says whether the subject was quiet or the sampler was starved. */
export interface ScopeWindow {
  /** Max |sample| over every snapshot taken (max-hold). */
  peak: number;
  /** Max per-snapshot RMS (max-hold). */
  rms: number;
  /** Max per-snapshot count of samples above 1e-6 (the most-structured window). */
  nonzeroSamples: number;
  /** Snapshots actually taken IN THE PAGE. Never 0 (the helper throws). */
  polls: number;
  /** Wall clock the PAGE measured for the window (not Playwright's). */
  elapsedMs: number;
  /** Largest gap between two consecutive samples, in ms. This is a DIRECT,
   *  free measure of main-thread starvation: it should sit near `pollMs`, and a
   *  value many times larger says the thread was wedged — i.e. a low `peak`
   *  may mean "we could not look", not "it was quiet". The old Playwright-side
   *  loop had no way to report this at all, which is why a 600 ms window that
   *  collapsed to one 42 ms peek was indistinguishable from silence. */
  maxSampleGapMs: number;
  /** True when the window ended early because `untilPeak` was reached. */
  reachedTarget: boolean;
}

export interface ScopeWindowOptions {
  /** Sampling period inside the page. Default 20 ms — finer than the ~42 ms
   *  analyser ring, so consecutive snapshots overlap. */
  pollMs?: number;
  /** Stop as soon as the running max peak exceeds this. Turns the window into
   *  a BOUNDED CONDITION WAIT (`windowMs` becomes the cap that BOUNDS THE
   *  FAILURE, not the gate). Omit it to always observe the full window — which
   *  is what an assertion of SILENCE needs. */
  untilPeak?: number;
  /** Minimum observation before `untilPeak` may end the window. Defaults to 0.
   *  Only useful when a caller wants both an early exit and a floor. */
  minMs?: number;
}

/**
 * Observe a scope module's analyser for a window and return the MAX peak seen.
 *
 * A single `readScopeSnapshot` only captures the ~42 ms analyser ring at one
 * instant — for envelope-driven voices (a 303's single-decay amp env
 * retriggered at 240 BPM, a poly chord whose lanes are gated by a main-thread
 * step scheduler) that instant can land in a trough, or before the first note
 * has been scheduled at all. Max-holding across a window makes "does this voice
 * ever make sound?" robust for percussive / decaying / gated sources without
 * weakening the assertion: a truly silent module never crosses the floor no
 * matter how long or how densely you look.
 *
 * The sampling loop runs INSIDE THE PAGE (see the block comment above) — that
 * is the load-bearing property, not the window length.
 */
export async function readScopePeakOverWindow(
  page: Page,
  scopeNodeId: string,
  windowMs: number,
  opts: ScopeWindowOptions = {},
): Promise<ScopeWindow> {
  const pollMs = opts.pollMs ?? 20;
  const untilPeak = opts.untilPeak ?? Number.POSITIVE_INFINITY;
  const minMs = opts.minMs ?? 0;

  const result = await page.evaluate(
    async ({ id, windowMs, pollMs, untilPeak, minMs }) => {
      const w = globalThis as unknown as {
        __engine?: () => {
          read: (n: { id: string; type: string; domain: string }, k: string) => unknown;
        } | null;
        __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
      };

      // Summarize IN THE PAGE — the Float32Array never crosses the protocol
      // boundary, which is most of why this is cheap enough to run at 20 ms.
      const grab = (): { peak: number; rms: number; nonzero: number } | null => {
        const eng = w.__engine?.();
        if (!eng) return null;
        const node = w.__patch?.nodes?.[id];
        if (!node) return null;
        const snap = eng.read(node, 'snapshot') as
          | { ch1: Float32Array; sampleRate: number }
          | undefined;
        if (!snap?.ch1) return null;
        const ch1 = snap.ch1;
        let peak = 0;
        let energy = 0;
        let nonzero = 0;
        for (let i = 0; i < ch1.length; i++) {
          const v = ch1[i] ?? 0;
          const a = v < 0 ? -v : v;
          if (a > peak) peak = a;
          energy += v * v;
          if (a > 1e-6) nonzero++;
        }
        return { peak, rms: Math.sqrt(energy / Math.max(1, ch1.length)), nonzero };
      };

      return await new Promise<{
        peak: number;
        rms: number;
        nonzeroSamples: number;
        polls: number;
        elapsedMs: number;
        maxSampleGapMs: number;
        reachedTarget: boolean;
      }>((resolve) => {
        const t0 = performance.now();
        let peak = 0;
        let rms = 0;
        let nonzeroSamples = 0;
        let polls = 0;
        let lastSampleAt = t0;
        let maxSampleGapMs = 0;
        let reachedTarget = false;

        const finish = (): void => {
          clearInterval(timer);
          resolve({
            peak,
            rms,
            nonzeroSamples,
            polls,
            elapsedMs: performance.now() - t0,
            maxSampleGapMs,
            reachedTarget,
          });
        };

        const sample = (): void => {
          const at = performance.now();
          const gap = at - lastSampleAt;
          if (gap > maxSampleGapMs) maxSampleGapMs = gap;
          lastSampleAt = at;
          const s = grab();
          if (s) {
            if (s.peak > peak) peak = s.peak;
            if (s.rms > rms) rms = s.rms;
            if (s.nonzero > nonzeroSamples) nonzeroSamples = s.nonzero;
            polls++;
          }
          const elapsed = at - t0;
          if (peak > untilPeak && elapsed >= minMs) {
            reachedTarget = true;
            finish();
            return;
          }
          if (elapsed >= windowMs) finish();
        };

        const timer = setInterval(sample, pollMs);
        // Sample immediately too, so a window shorter than one interval still
        // takes at least one reading.
        sample();
      });
    },
    { id: scopeNodeId, windowMs, pollMs, untilPeak, minMs },
  );

  if (result.polls === 0) {
    // NEVER let "we never looked" print as "it was silent" — that ambiguity is
    // the failure this helper was rewritten to remove.
    throw new Error(
      `readScopePeakOverWindow('${scopeNodeId}'): the instrument took ZERO samples in ` +
        `${Math.round(result.elapsedMs)} ms (requested window ${windowMs} ms @ ${pollMs} ms). ` +
        `The engine or the scope node was unreadable for the whole window — this is an ` +
        `INSTRUMENT failure, not a silent module. Do NOT read the peak as 0.`,
    );
  }
  return result;
}

/** One-line vitals for an assertion message. Makes a red run diagnosable:
 *  "silent" and "starved sampler" print differently. */
export function describeScopeWindow(w: ScopeWindow): string {
  return (
    `peak=${w.peak.toFixed(4)} rms=${w.rms.toFixed(4)} ` +
    `polls=${w.polls} elapsed=${Math.round(w.elapsedMs)}ms ` +
    `maxSampleGap=${Math.round(w.maxSampleGapMs)}ms` +
    (w.reachedTarget ? ' (hit target early)' : '')
  );
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
