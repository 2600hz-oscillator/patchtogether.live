// e2e/tests/collapse-keeps-playing.spec.ts
//
// THE REGRESSION GUARD for the owner P0: "videovarispeed stops playing if its
// card is collapsed. i put it on scene, expand, load video, play → stops
// playing as soon as the expanded tray is dismissed."
//
// WHAT IT DRIVES — the real thing, in the DEFAULT shell:
//   spawn → expand (dock full-view) → load a file → play → COLLAPSE →
//   assert the element is STILL PLAYING.
//
// ⚠ THE DEFAULT SHELL IS THE POINT. The pre-existing videovarispeed specs all
// boot `/rack?shell=legacy`, which keeps the real card in the LANE — so the
// card never moves between mounts and the entire bug class is invisible to
// them. `shellFaces` is TRUE unless `?shell=legacy` is passed
// (Canvas.svelte), i.e. those specs were validating a mode users do not have.
// This spec goes to plain `/rack` deliberately; do not add a shell param.
//
// REGISTRY-DRIVEN, so a new DOM-source video module cannot opt out by
// accident: the subject list is DERIVED from DOM_SOURCE_LANE_TYPES in
// $lib/ui/workflow/dom-source-modules.ts (itself held exhaustive by that
// file's own grep gate). Every such module is spawned and expanded; whichever
// ones expose a local-file input get the full behavioural scenario. Nothing
// here is a hand-typed module list.
//
// NOT NAMED `video-*` DELIBERATELY. That prefix is a WEBGL_HEAVY_GLOB
// (e2e/webgl-heavy-globs.ts), which would enrol this spec on the sharded
// SwiftShader matrix and in the attest's Pass A. It does not belong there: what
// it measures is PLAYBACK LIFETIME — a media clock and an element's existence —
// and its one rendering assertion is a monotonic draw counter whose truth does
// not vary by renderer (verified: green under E2E_SWIFTSHADER=1, which is worth
// running by hand, not on every attest). Keeping it out also keeps the ATTESTED
// SET stable, so this change cannot be confused with one that alters what the
// GPU semaphore covers.
//
// DETERMINISM: the assertions are SECONDS OF MEDIA ACTUALLY PLAYED (accumulated
// in the page, wrap-safe and seek-proof — see "THE INSTRUMENT" below), a
// monotonic decoder frame counter, and the engine's own draw counter — never
// pixels, never a wall-clock budget standing in for progress, and never a
// single sample of `currentTime`, which for BOTH subjects here is a cyclic
// quantity the card itself rewrites. SwiftShader on CI renders ~7.9fps vs ~60
// locally, so a ms budget would be a different assertion on every machine.

import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnPatch } from './_helpers';

const FIXTURE = fileURLToPath(new URL('../fixtures/lobby-clip.webm', import.meta.url));

/** Derive the DOM-source module types from the shared registry SOURCE, so this
 *  sweep auto-enrols a new module rather than needing a list here. */
function domSourceTypes(): string[] {
  const src = readFileSync(
    fileURLToPath(
      new URL('../../packages/web/src/lib/ui/workflow/dom-source-modules.ts', import.meta.url),
    ),
    'utf8',
  );
  const block = /DOM_SOURCE_LANE_TYPES[^[]*\[([\s\S]*?)\]/.exec(src);
  if (!block) throw new Error('could not parse DOM_SOURCE_LANE_TYPES — has the shape changed?');
  const types = [...block[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
  if (types.length === 0) throw new Error('DOM_SOURCE_LANE_TYPES parsed EMPTY — refusing to pass vacuously');
  return types;
}

const TYPES = domSourceTypes();

/** Non-perturbing engine probe. NOT `VideoEngine.read()` — that calls
 *  markWatched() internally, which would pin the node as a pull root and mask
 *  a rendering fault the same measurement is meant to detect. */
async function drawCount(page: Page, nodeId: string): Promise<number> {
  return await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __engine?: () => { getDomain: (d: string) => { framesDrawnFor: (i: string) => number } };
    };
    try { return w.__engine!().getDomain('video').framesDrawnFor(id); } catch { return -1; }
  }, nodeId);
}

/** Every <video>/<img> in the document that currently holds a src, with where
 *  it lives. Reads the DOM directly — the element is node-owned, so it is
 *  found wherever it has been adopted. */
async function liveMedia(page: Page) {
  return await page.evaluate(() =>
    [...document.querySelectorAll('video')]
      .map((v) => v as HTMLVideoElement)
      .filter((v) => !!(v.currentSrc || v.getAttribute('src')))
      .map((v) => ({
        testid: v.getAttribute('data-testid'),
        where: v.closest('[data-testid="dock-full-view"]')
          ? 'dock'
          : v.closest('[data-testid="headless-source-host"]')
            ? 'headless'
            : v.closest('[data-testid="node-media-parking"]')
              ? 'parking'
              : 'lane',
        currentTime: v.currentTime,
        paused: v.paused,
      })),
  );
}

async function boot(page: Page): Promise<void> {
  // Plain /rack — the DEFAULT shell. See the header.
  await page.goto('/rack');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: 30_000 });
}

// ───────────────────────────────────────────────────────────────────────────
// THE INSTRUMENT: PLAYBACK PROGRESS, NOT A CLOCK READING (#1569)
// ───────────────────────────────────────────────────────────────────────────
//
// WHY THIS EXISTS. The assertion used to be `after.currentTime > tBefore` plus
// `some(!paused)` — two INSTANTANEOUS samples of `currentTime`. That is only a
// statement about playback if `currentTime` is a free-running media clock. It
// is NOT, for either subject this sweep actually exercises, and both were
// MEASURED here (in-page trace at 250 ms, no test-side perturbation):
//
//   videovarispeed  the CARD wraps the element itself — its rAF transport calls
//                   decideEdgeAction() and writes `videoEl.currentTime =
//                   window.startSec` at the window edge (`el.loop` is false the
//                   whole time). Trace: 3.816 -> 0.086 -> ... -> 3.944 -> 0.166,
//                   a clean wrap every ~4.0 s, forever.
//   videobox        `currentTime` is a WALL CLOCK. VideoboxCard's drift loop
//                   (decideDriftCorrection, every 500 ms) computes
//                   `lastSyncPosition + (Date.now()-lastSyncTime)/1000`, clamps
//                   it to `duration - 0.05`, and SEEKS whenever the element is
//                   more than 0.5 s off it.
//
// So a `>` between two samples of a quantity that WRAPS is not a comparison at
// all. Both CI failures this fixes are that one fact in two disguises:
//
//   videovarispeed  "the media clock must have advanced past 1.373s -> 0.857"
//                   and "past 0.713s -> 0.058"  (runs 31704647270, 31697446769)
//                   — the clock went BACKWARDS. It wrapped between the wait and
//                   the read; ~3.4 s of media time separated them both times.
//   videobox        "media must still be PLAYING: currentTime 4.004, paused"
//                   (runs 31665678796, 31666489868, 31671834818) — the clip
//                   simply ENDED. All three predate the `loop`+rewind fix and
//                   none has recurred in the runs since.
//
// ⚠ THE `loop`+REWIND FIX DID NOT REMOVE VIDEOBOX'S EXPOSURE, it changed which
// way it fails, and that is why this had to be fixed at the assertion. Replaying
// main's spec with CI's OWN measured latencies made deterministic (1.5 s before
// the `before` read, 3.0 s between the wait resolving and the `after` read) put
// BOTH subjects red on the first attempt, locally, every time:
//
//   videobox        the media clock must have advanced past 1.575s -> 0.232
//   videovarispeed  the media clock must have advanced past 1.574s -> 1.011
//
// videobox now fails through the SEEK STORM's oscillation rather than through
// the clip ending. The same perturbation against this file passes. And the
// failure probability has a shape: it is roughly `tBefore / clipDuration`,
// because the read has to land in the window between a wrap and `tBefore`.
// CI's tBefore was 0.713 s and 1.373 s (~18-34 % of 4.004 s); locally it is
// ~0.15 s (~4 %) — which is exactly why this is a CI flake and not a local one,
// and why "it passes here" was never evidence of anything.
//
// WHAT REPLACES IT: forward playback PROGRESS, accumulated IN THE PAGE across
// the whole post-collapse window (CLAUDE.md defence #5 — never sample a
// page-side quantity with a Playwright-side poll loop). Two properties make it
// sound where a `>` is not:
//
//   WRAP-SAFE   a negative delta credits ZERO. A wrap or a rewind can only cost
//               progress, never fake it, and can never make the value go down.
//   SEEK-PROOF  a positive delta is credited only up to what real playback
//               could have produced since the previous sample — `dt × rate`,
//               with `rate = 0` while paused. A 3.9 s forward SEEK inside one
//               100 ms sample is worth 0.15 s, not 3.9 s.
//
// That second property is not theoretical here. `el.loop = true` (below) puts
// VIDEOBOX into a measured ~4 Hz SEEK STORM once its wall-clock expectation
// saturates at `duration - 0.05`: the element wraps to 0, the drift loop yanks
// it back to 3.954, repeat. Traced: `currentTime` oscillating 0.07 <-> 3.954
// and totalVideoFrames climbing 133 -> 4491 in 16 s (~270 decoded fps against a
// 30 fps clip). A naive delta-sum would have called those yanks "progress".
//
// UNITS, stated because half of this class of bug is a unit confusion: the gate
// is in SECONDS OF MEDIA ACTUALLY PLAYED, bounded above by seconds of real
// time. It is renderer-independent by construction — SwiftShader changes how
// fast the page DRAWS, not how fast a decoder advances a media clock.

/** Sampling period of the in-page accumulator. */
const PROBE_SAMPLE_MS = 100;
/** Ceiling on the `dt` any single sample may claim. A main-thread stall must
 *  not hand the next sample a huge credit budget (which is exactly what would
 *  let a seek through). Under-credits after a stall — conservative on purpose:
 *  it can only make the gate harder to satisfy, never easier. */
const PROBE_MAX_DT_MS = 250;
/** Slack on `dt × rate` so ordinary timer jitter and decode scheduling do not
 *  clip genuine playback. The instrument's guarantee is therefore: credited
 *  progress <= 1.5 x real elapsed time, ALWAYS, whatever the clock does. */
const PROBE_RATE_TOLERANCE = 1.5;
/** THE GATE, in media seconds. Carried over unchanged from the `ADVANCE_S` the
 *  old endpoint comparison demanded — this change fixes the UNIT, it does not
 *  move the bar. Healthy playback banks it in ~0.4 s of real time. */
const MIN_PROGRESS_S = 0.4;
/** Bounds the FAILURE, never the gate — carried over from the old
 *  waitForFunction. 75x the real time MIN_PROGRESS_S needs, and the assertion
 *  runs (and prints the window) whether or not the wait resolves. */
const PROGRESS_CAP_MS = 30_000;

interface ProbeRow {
  testid: string;
  where: string;
  /** Seconds of media that were genuinely PLAYED in the window. THE GATE. */
  playedSec: number;
  samples: number;
  playingSamples: number;
  pausedSamples: number;
  /** Samples whose clock moved BACKWARDS (a wrap or a rewind). */
  backwardJumps: number;
  /** Samples whose clock moved forward FASTER than playback could (a seek). */
  forwardSeeks: number;
  minT: number;
  maxT: number;
  lastT: number;
  /** getVideoPlaybackQuality().totalVideoFrames delta — monotonic, so it never
   *  wraps. NOT seek-independent though (a seek decodes frames too), so it is a
   *  diagnostic plus one non-vacuity assertion, never the gate. -1 when the
   *  browser does not expose it. */
  decodedFrames: number;
}
interface ProbeRead {
  elapsedMs: number;
  samples: number;
  rows: ProbeRow[];
}

/** Start (or restart) the in-page accumulator. Idempotent — a second call
 *  replaces the first, so no test can leave two timers running. */
async function installPlaybackProbe(page: Page): Promise<void> {
  await page.evaluate(
    ({ sampleMs, maxDtMs, tol }) => {
      const g = globalThis as unknown as { __mediaProbe?: { stop(): void } };
      g.__mediaProbe?.stop();

      // ── THE CREDIT RULE — the entire instrument, in one pure function. ──
      // Everything the probe claims comes from here, so the permanent negative
      // control at the end of every test calls THIS function, not a copy.
      const credit = (deltaSec: number, dtMs: number, rate: number): number => {
        if (!(deltaSec > 0)) return 0; // wrap, rewind, or no motion
        const budget = (Math.min(Math.max(dtMs, 0), maxDtMs) / 1000) * Math.max(0, rate) * tol;
        return Math.min(deltaSec, budget);
      };

      interface Row {
        testid: string; where: string; playedSec: number; samples: number;
        playingSamples: number; pausedSamples: number; backwardJumps: number;
        forwardSeeks: number; minT: number; maxT: number; lastT: number;
        decodedFrames: number; prevT: number | null; frames0: number;
      }
      const rows = new Map<string, Row>();
      let t0 = performance.now();
      let last = t0;
      let samples = 0;

      const frameCount = (v: HTMLVideoElement): number => {
        const q = (v as unknown as {
          getVideoPlaybackQuality?: () => { totalVideoFrames: number };
        }).getVideoPlaybackQuality;
        if (typeof q !== 'function') return -1;
        try { return q.call(v).totalVideoFrames; } catch { return -1; }
      };

      const tick = (): void => {
        const now = performance.now();
        const dt = now - last;
        last = now;
        samples++;
        for (const node of document.querySelectorAll('video')) {
          const v = node as HTMLVideoElement;
          if (!(v.currentSrc || v.getAttribute('src'))) continue;
          const key = v.getAttribute('data-testid') ?? '(untagged)';
          const t = v.currentTime;
          const frames = frameCount(v);
          let r = rows.get(key);
          if (!r) {
            r = {
              testid: key, where: '', playedSec: 0, samples: 0, playingSamples: 0,
              pausedSamples: 0, backwardJumps: 0, forwardSeeks: 0, minT: t, maxT: t,
              lastT: t, decodedFrames: 0, prevT: null, frames0: frames,
            };
            rows.set(key, r);
          }
          // `rate` is 0 while paused, so a paused element credits nothing at
          // all however far its clock is dragged.
          const rate = v.paused ? 0 : Math.abs(v.playbackRate || 1);
          if (r.prevT !== null) {
            const delta = t - r.prevT;
            const c = credit(delta, dt, rate);
            r.playedSec += c;
            if (delta < 0) r.backwardJumps++;
            else if (delta > c + 1e-6) r.forwardSeeks++;
          }
          r.prevT = t;
          r.lastT = t;
          r.where = v.closest('[data-testid="dock-full-view"]') ? 'dock'
            : v.closest('[data-testid="headless-source-host"]') ? 'headless'
              : v.closest('[data-testid="node-media-parking"]') ? 'parking' : 'lane';
          r.samples++;
          if (v.paused) r.pausedSamples++; else r.playingSamples++;
          if (t < r.minT) r.minT = t;
          if (t > r.maxT) r.maxT = t;
          if (frames >= 0 && r.frames0 >= 0) r.decodedFrames = frames - r.frames0;
        }
      };

      const round = (n: number): number => Math.round(n * 1000) / 1000;
      const timer = setInterval(tick, sampleMs);
      tick();
      (globalThis as unknown as { __mediaProbe: unknown }).__mediaProbe = {
        credit,
        read: () => ({
          elapsedMs: Math.round(performance.now() - t0),
          samples,
          rows: [...rows.values()].map((r) => ({
            testid: r.testid, where: r.where, playedSec: round(r.playedSec),
            samples: r.samples, playingSamples: r.playingSamples,
            pausedSamples: r.pausedSamples, backwardJumps: r.backwardJumps,
            forwardSeeks: r.forwardSeeks, minT: round(r.minT), maxT: round(r.maxT),
            lastT: round(r.lastT), decodedFrames: r.decodedFrames,
          })),
        }),
        reset: () => { rows.clear(); t0 = performance.now(); last = t0; samples = 0; tick(); },
        stop: () => clearInterval(timer),
      };
    },
    { sampleMs: PROBE_SAMPLE_MS, maxDtMs: PROBE_MAX_DT_MS, tol: PROBE_RATE_TOLERANCE },
  );
}

async function readProbe(page: Page): Promise<ProbeRead> {
  return await page.evaluate(() =>
    (globalThis as unknown as { __mediaProbe: { read(): ProbeRead } }).__mediaProbe.read());
}
async function resetProbe(page: Page): Promise<void> {
  await page.evaluate(() =>
    (globalThis as unknown as { __mediaProbe: { reset(): void } }).__mediaProbe.reset());
}
async function stopProbe(page: Page): Promise<void> {
  await page.evaluate(() =>
    (globalThis as unknown as { __mediaProbe: { stop(): void } }).__mediaProbe.stop());
}

/** The best-progressing element in a window, or null when the page held none. */
function bestRow(rec: ProbeRead): ProbeRow | null {
  return rec.rows.reduce<ProbeRow | null>(
    (best, r) => (best === null || r.playedSec > best.playedSec ? r : best), null);
}

/**
 * PERMANENT NEGATIVE CONTROL — runs on every subject, every run, in the same
 * page, against the SAME `credit` closure the sampler just used. Not a copy of
 * the rule: the identical function object.
 *
 * A gate that cannot fail is worse than no gate, and the two failure modes this
 * instrument exists to be immune to (a wrap, a seek) are exactly the two that
 * would silently turn it back into the broken `>` if the rule regressed. Both
 * directions are asserted: the rule must still say YES to real playback.
 */
async function assertCreditRuleIsSound(page: Page): Promise<void> {
  const JUMP_S = 3.9; // ~a whole lobby-clip.webm, i.e. the storm's own seek size
  const c = await page.evaluate(
    ({ sampleMs, jump }) => {
      const credit = (globalThis as unknown as {
        __mediaProbe: { credit(d: number, dt: number, r: number): number };
      }).__mediaProbe.credit;
      return {
        playback: credit(sampleMs / 1000, sampleMs, 1),
        wrap: credit(-jump, sampleMs, 1),
        forwardSeek: credit(jump, sampleMs, 1),
        pausedDrag: credit(jump, sampleMs, 0),
        stalledThenSeek: credit(jump, 30_000, 1),
      };
    },
    { sampleMs: PROBE_SAMPLE_MS, jump: JUMP_S },
  );
  const realTimeBudgetSec = (PROBE_SAMPLE_MS / 1000) * PROBE_RATE_TOLERANCE;
  const stallBudgetSec = (PROBE_MAX_DT_MS / 1000) * PROBE_RATE_TOLERANCE;
  const seen = JSON.stringify(c);

  // POSITIVE leg — the rule can still say yes, in full, to genuine playback.
  expect(c.playback, `credit() must pass genuine playback through unchanged (media s): ${seen}`)
    .toBeCloseTo(PROBE_SAMPLE_MS / 1000, 6);
  // WRAP leg — a backwards clock credits nothing at all.
  expect(c.wrap, `a ${JUMP_S}s WRAP must credit exactly 0 media s: ${seen}`).toBe(0);
  // PAUSED leg — rate 0 means no credit however far the clock is dragged.
  expect(c.pausedDrag, `a ${JUMP_S}s drag on a PAUSED element must credit exactly 0 media s: ${seen}`)
    .toBe(0);
  // SEEK leg — a jump is worth one sample of real time, not the jump.
  expect(c.forwardSeek, `a ${JUMP_S}s forward SEEK must credit at most ${realTimeBudgetSec}s (one ${PROBE_SAMPLE_MS}ms sample x ${PROBE_RATE_TOLERANCE}), not the jump: ${seen}`)
    .toBeLessThanOrEqual(realTimeBudgetSec + 1e-9);
  // STALL leg — a 30 s main-thread stall must not hand the next sample a 30 s
  // budget; PROBE_MAX_DT_MS caps it.
  expect(c.stalledThenSeek, `a ${JUMP_S}s seek after a 30s STALL must still credit at most ${stallBudgetSec}s: ${seen}`)
    .toBeLessThanOrEqual(stallBudgetSec + 1e-9);
}

for (const type of TYPES) {
  test(`${type}: media survives the expanded tray being dismissed`, async ({ page }) => {
    test.setTimeout(180_000);
    const nodeId = `collapse-${type}`;
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await boot(page);
    await spawnPatch(page, [{ id: nodeId, type, domain: 'video' }], [], { mountTimeout: 30_000 });

    // EXPAND — the owner's "expand".
    await page.evaluate((id) => {
      (globalThis as unknown as { __openDockFullView: (i: string) => void }).__openDockFullView(id);
    }, nodeId);
    const pane = page.locator('[data-testid="dock-full-view"]');
    await expect(pane).toHaveCount(1, { timeout: 20_000 });

    // Enrolment is DERIVED from the card, not declared here: a module gets the
    // full behavioural scenario iff its expanded card exposes BOTH a local-file
    // input and a transport play button — i.e. it is a local-file PLAYER, the
    // only shape whose "is it still playing?" question is even well posed.
    // Two groups fall out, and neither can opt out silently:
    //   * network / capture sources (peertube, tvLibrarian, archivist,
    //     cameraInput, loopback) — no fixture can drive them in CI;
    //   * one-shot loaders (frametable, videocube) — they upload a file into an
    //     atlas/texture and have no transport, so there is no playback to lose.
    // BOTH groups are still covered, by the SOURCE-level gate
    // (packages/web/src/lib/ui/media/card-media-lifetime.test.ts), which reads
    // every DOM-source card's unmount path and needs no browser.
    const fileInput = pane.locator('input[type="file"][data-testid$="-file-input"]').first();
    const playBtn = pane.locator('button[data-testid$="-play-btn"]').first();
    const isPlayer = (await fileInput.count()) > 0 && (await playBtn.count()) > 0;
    test.skip(
      !isPlayer,
      `${type} is not a local-file player (no file input and/or no transport) — its unmount path is gated by card-media-lifetime.test.ts`,
    );

    await fileInput.setInputFiles(FIXTURE);
    await expect(playBtn).toBeVisible({ timeout: 20_000 });
    await playBtn.click();

    // Confirm genuine playback BEFORE touching anything, in-page (never a
    // Playwright poll loop — that samples the very main thread it measures).
    await page.waitForFunction(
      () => {
        const vids = [...document.querySelectorAll('[data-testid="dock-full-view"] video')];
        return vids.some((v) => {
          const el = v as HTMLVideoElement;
          return !el.paused && el.currentTime > 0.05;
        });
      },
      undefined,
      { timeout: 30_000 },
    );

    // ── REMOVE THE FIXTURE'S HIDDEN DEADLINE (#1553) ───────────────────────
    //
    // MEASURED, in-page, sampling every 250 ms with NO test-side perturbation
    // at all (re-run for #1569; the earlier 750 ms trace agreed):
    //
    //   videobox        3.813 -> 4.004 paused=TRUE, frames frozen at 120, and
    //                   it stays there for the remaining 16 s of the trace.
    //   videovarispeed  3.816 -> 0.086 -> ... -> 3.944 -> 0.166, wrapping every
    //                   ~4.0 s forever, never paused.
    //
    // `lobby-clip.webm` is 4.004 s (its EBML Duration header) and a non-looping
    // <video> sets `paused = true` the moment it ENDS. So "media must still be
    // PLAYING after the collapse" can fail for the most boring reason there is
    // — the clip finished — and that is exactly how videobox failed in CI three
    // times, reporting `currentTime: 4.004` to the millisecond.
    //
    // `loop` + a rewind is what keeps a 4.004 s fixture playable across a setup
    // that takes 11-22 s of shard time. It is a real perturbation and it is
    // documented as one:
    //
    // ⚠ MEASURED CONSEQUENCE, and the reason the instrument below has to be
    // seek-proof. For VIDEOBOX, `el.loop` fights the card's own transport.
    // VideoboxCard drives `currentTime` from the WALL CLOCK (decideDriftCorrection
    // every 500 ms, expectation clamped to `duration - 0.05` = 3.954 s) and
    // seeks whenever the element is >0.5 s off it. A looping element returns to
    // 0; the drift loop yanks it back to 3.954; repeat. Traced: `currentTime`
    // oscillating 0.07 <-> 3.954 at ~4 Hz with totalVideoFrames climbing
    // 133 -> 4491 in 16 s (~270 decoded fps against a 30 fps clip). The element
    // is genuinely PLAYING the whole time — which is why this is still the right
    // trade for a fixture this short — but any measurement here MUST be able to
    // tell that storm's seeks apart from playback. Hence the credit rule.
    //
    // The real root cause is that the fixture is shorter than this test's own
    // worst-case setup, and the durable fix is a longer fixture — tracked in
    // #1577 with the traces above. Nothing below depends on which way that
    // lands: the gate cannot be faked by the storm's seeks either way.
    await page.evaluate(() => {
      for (const v of document.querySelectorAll('video')) {
        const el = v as HTMLVideoElement;
        if (!(el.currentSrc || el.getAttribute('src'))) continue;
        el.loop = true;
        if (el.ended || el.paused) void el.play().catch(() => {});
        el.currentTime = 0;
      }
    });
    await page.waitForFunction(
      () => [...document.querySelectorAll('video')].some((v) => {
        const el = v as HTMLVideoElement;
        return !el.paused && el.currentTime > 0.05;
      }),
      undefined,
      { timeout: 30_000 },
    );

    // Arm the accumulator BEFORE the collapse, so the pre-collapse window is a
    // POSITIVE CONTROL in this very page: it proves the instrument can see
    // playback HERE, on THIS runner, before the thing under test happens. A
    // post-collapse zero can then only mean the collapse, never "the probe
    // never worked".
    await installPlaybackProbe(page);

    const before = await liveMedia(page);
    expect(before.length, `a media element must exist before the collapse: ${JSON.stringify(before)}`)
      .toBeGreaterThan(0);
    await page.waitForFunction(
      (need) => {
        const p = (globalThis as unknown as {
          __mediaProbe: { read(): { rows: { playedSec: number }[] } };
        }).__mediaProbe;
        return p.read().rows.some((r) => r.playedSec >= need);
      },
      MIN_PROGRESS_S,
      { timeout: PROGRESS_CAP_MS },
    ).catch(() => { /* fall through to the assertion, which PRINTS the window */ });
    const preRec = await readProbe(page);
    const pre = bestRow(preRec);
    expect(
      pre?.playedSec ?? 0,
      `POSITIVE CONTROL: the probe must see playback BEFORE the collapse — media s played over ${preRec.elapsedMs} ms / ${preRec.samples} samples: ${JSON.stringify(preRec)}`,
    ).toBeGreaterThanOrEqual(MIN_PROGRESS_S);
    const drawsBefore = await drawCount(page, nodeId);

    // COLLAPSE — the owner's "expanded tray is dismissed".
    await page.getByTestId('faceplate-collapse').click();
    await expect(page.locator('[data-testid="dock-full-view"]')).toHaveCount(0, { timeout: 20_000 });

    // Restart the window HERE, so everything measured below happened strictly
    // after the tray was dismissed.
    await resetProbe(page);

    // THE ASSERTION: after the collapse, some element still holding a src
    // PLAYED at least MIN_PROGRESS_S seconds of media — wrap-safe and
    // seek-proof (see the instrument header). The wait is a bound on the
    // FAILURE, never the gate: the assertion below runs either way and prints
    // the whole window, so a slow runner produces a diagnosis instead of
    // Playwright's mute timeout.
    await page.waitForFunction(
      (need) => {
        const p = (globalThis as unknown as {
          __mediaProbe: { read(): { rows: { playedSec: number }[] } };
        }).__mediaProbe;
        return p.read().rows.some((r) => r.playedSec >= need);
      },
      MIN_PROGRESS_S,
      { timeout: PROGRESS_CAP_MS },
    ).catch(() => { /* fall through to the assertion, which PRINTS the window */ });

    const rec = await readProbe(page);
    const best = bestRow(rec);
    const after = await liveMedia(page);
    const drawsAfter = await drawCount(page, nodeId);

    // The element survived the card move (it is now wherever the UI put it —
    // typically the off-screen headless host).
    expect(after.length, `the node's media element must survive the collapse: ${JSON.stringify(after)}`)
      .toBeGreaterThan(0);

    // The owner's P0, in the only unit that can state it: SECONDS OF MEDIA
    // ACTUALLY PLAYED after the collapse. A destroyed, detached or paused
    // element scores 0; a wrap scores 0 for that sample and cannot go negative;
    // a seek is worth at most one sample of real time.
    expect(
      best?.playedSec ?? 0,
      `media must still be PLAYING after the collapse — needed ${MIN_PROGRESS_S} media s of forward playback, saw ${best?.playedSec ?? 0} over ${rec.elapsedMs} ms / ${rec.samples} samples. Elements: ${JSON.stringify(rec.rows)} | DOM: ${JSON.stringify(after)}`,
    ).toBeGreaterThanOrEqual(MIN_PROGRESS_S);

    // Monotonic decoder counter — a NON-VACUITY check and a diagnostic, NOT a
    // second gate, and the negative control is why that distinction is written
    // down: with playback stubbed dead, videobox still logged
    // `decodedFrames: 329` because the drift loop's SEEKS decode frames too.
    // So it can be positive while nothing is playing; it can never be positive
    // while the element is gone. -1 means the browser exposes no such counter.
    if ((best?.decodedFrames ?? -1) >= 0) {
      expect(
        best!.decodedFrames,
        `the decoder must produce NEW frames after the collapse (totalVideoFrames delta over ${rec.elapsedMs} ms): ${JSON.stringify(rec.rows)}`,
      ).toBeGreaterThan(0);
    }

    // Rendering was never the fault (measured on the original bug: draws kept
    // advancing while playback died) — assert it stays healthy so a future
    // "fix" cannot trade playback for a frozen chain.
    expect(drawsAfter, `engine draws must keep advancing (${drawsBefore} -> ${drawsAfter})`)
      .toBeGreaterThan(drawsBefore);

    // The permanent control leg — see assertCreditRuleIsSound. Runs after the
    // real assertions so a failure here is unambiguously about the INSTRUMENT.
    await assertCreditRuleIsSound(page);
    await stopProbe(page);

    expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
  });
}
