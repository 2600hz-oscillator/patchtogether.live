// per-module-per-port-outputs.spec.ts
//
// SPLIT from per-module-per-port.spec.ts (#1538). That file was 3,370 CPU-s —
// 1.74x a whole balanced shard's budget — so no cost-based scheduler could
// place it. Splitting at its three existing top-level `test.describe`s makes a
// balanced partition possible; the shared prelude moved verbatim to
// `_per-module-per-port-shared.ts`. No test logic changed.
//
// Measured cost of this dimension: 1013.6 s / 181 tests

import { test, expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import {
  EXEMPT_OUTPUT_EMIT,
  EXEMPT_OUTPUT_EMIT_MODULES,
  PER_PORT_BASE_MS,
  REGISTRY,
  SKIP_SPAWN,
  collectPageErrors,
  driverFor,
  // NB: `freezeVideoRender` and `heavyVideoTimeout` were imported here and never
  // called — leftovers from the #1538 split. Removed with #1984 because the first
  // one is actively misleading: this sweep is the one that does NOT freeze the GL
  // draw (it reads real pixels), and that is exactly what makes its per-output
  // cost what it is. See the budget derivation in _per-module-per-port-shared.ts.
  observeScopePeak,
  readEmitDiagnostics,
  formatEmitDiagnostics,
  perPortDriverFor,
  pickOutputSink,
  spawnPatch,
  touchesVideo,
  emitSkipReason,
  emitBudgetMs,
} from './_per-module-per-port-shared';
import { buildKriaData } from './_helpers';
import { SLOW_RENDER } from '../_helpers/boot-budget';
import type {
  RegistryModule,
  SpawnEdge,
  SpawnNode,
} from './_per-module-per-port-shared';

test.describe.configure({ mode: 'parallel' });


// ────────── DIM 2: outputs emit ──────────
//
// For every declared output, route to a type-compatible sink and assert
// the sink picks up a signal. Per-module test iterates the outputs
// internally + emits exempt-skipped notes inline so a failure message
// pinpoints the offending port.

// ────────── The emit sweep's SKIP DECISION — ONE definition ──────────
//
// Every reason the emit sweep declines to run for a module, in one place, so
// the test loop and the budget ratchet below cannot disagree about which tests
// EXIST. They did disagree: the ratchet's private mirror re-read the two
// EXEMPT_* lists and nothing else, so it was structurally blind to the
// SKIP_SPAWN, effect-shape and pure-CV-utility skips — three of the five
// reasons. It therefore priced `colourofmagic` (22 outputs, 1 020 s across two
// attempts) as "the worst LIVE plan" when that test is `test.fixme`-d and has
// never executed. A mirror that re-derives half a predicate reports a number
// about a test that does not run; anchoring both callers to this function is
// what makes the ratchet's subject the same as the loop's.
//
// Returns the skip reason (the suffix the fixme title carries) or null when the
// module's emit test really runs.

/** A module that has an `audio`/`video` input AND self-running outputs (FOXY's
 *  out_l/out_r ring even with no upstream because the wavetable oscillator is
 *  ticking; the `fm` input is OPTIONAL), so it takes the normal emit path. */

// ────────── The VIDEO sink oracle: a picture, against the sink's OWN IDLE ──────
//
// ⚠ WHY A DIFFERENTIAL AND NOT A BRIGHTNESS FLOOR. The floors this branch used
// to stand on — `nonBlackFrac > 0.001` and `variance > 0.5` — BOTH PASS WITH
// NOTHING CONNECTED. Measured 2026-09-04 with a videoOut spawned alone, no edge:
// the shell tile reads nonBlackFrac 1.0000 / variance 1.50 (an unpatched
// videoOut paints its own dark-blue idle gradient, 10,15,27..37), and the legacy
// card canvas read nonBlackFrac 1.0000 / variance 22.82 (that number came from
// the card CHROME around the frame, not from the frame). So the video half of
// this sweep was never measuring what its message claimed on EITHER surface.
//
// The state a "the port emitted" claim has to be told apart from is the sink's
// own idle picture, so that is what it is compared against: one 16x12 luma grid,
// measured once per worker from a rack holding ONLY a videoOut, cached, and
// required to differ. Nothing about it is tuned to a particular shader — if the
// idle picture changes, the measurement changes with it.

/** One sink read: the 16x12 luma grid plus the two legacy scalar floors. */
interface SinkFrame {
  cells: number[];
  variance: number;
  nonBlackFrac: number;
}

/** Grid the sink picture is reduced to. 16x12 keeps the videoOut aspect and is
 *  coarse enough that a one-pixel AA difference cannot register as a cell. */
const SINK_GRID_W = 16;
const SINK_GRID_H = 12;
/** Luma delta (0..255) at which a CELL counts as different from idle.
 *
 *  4, and the number is a compromise measured from both ends. The idle picture
 *  is a deterministic shader, so a re-render of it lands on the SAME cell means
 *  and a threshold could in principle be 1; what sets the floor is 8-bit
 *  rounding across the 160x120 downscale. What sets the CEILING is that several
 *  real pictures are DARK: loopback's no-capture frame reads mean 25.1 against
 *  idle's 19.0, so a delta of 12 rejected a picture that was plainly there. */
const SINK_CELL_DELTA = 4;
/** Cells that must differ, out of 192. A picture that fills the frame moves
 *  nearly all of them; a thin mono-video trace on a dark field moves the cells
 *  it crosses, which for a 16x12 grid over a 160x120 canvas is a whole row. */
const SINK_DIFF_MIN_CELLS = 8;
/** The thumb is throttled to VIDEO_THUMB_FPS (15) and its first ticks paint the
 *  empty well before the engine has drawn the node, so the first READABLE frame
 *  is not necessarily the settled one. Frames, not a fixed sleep: the poll ends
 *  as soon as the picture differs.
 *
 *  ⚠ IT WAS A FLAT 8 s AND THAT IS A DIFFERENT BOUND ON EVERY RUNNER. Measured
 *  locally and written down twelve lines above: loopback reads EMPTY at ~1 s and
 *  carries a real picture by ~4 s. 8 s is two settles' headroom on a dev box and
 *  none at all on CI, where the same picture is composited by SwiftShader on a
 *  shared 2-core runner with up to five workers.
 *
 *  ⚠ AND IT COST THREE PORTS ON 2026-09-05, all with the same call log
 *  ("Timeout 8000ms exceeded while waiting on the predicate"): `loopback.out`,
 *  `mandelbulb` and `mandleblot`. Read the subjects and the diagnosis is one
 *  line — loopback's no-capture frame is a REAL picture this file's own
 *  `SINK_CELL_DELTA` note measures at mean 25.1 against idle's 19.0, and the two
 *  fractal iterators are the most expensive first frames in the registry. None
 *  of the three is a port that fails to emit; all three are pictures that had
 *  not arrived yet.
 *
 *  Scaled rather than raised: the poll EXITS the instant the picture differs, so
 *  a port that emits pays nothing for the larger ceiling and only a port that
 *  was going to fail spends it. This is a BOUND, and the sweep's assertion —
 *  that the sink shows a picture DIFFERENT from its own idle — is untouched. */
const SINK_FRAME_TIMEOUT_MS = SLOW_RENDER ? 24_000 : 8_000;

async function readSinkFrame(canvas: Locator): Promise<SinkFrame | null> {
  return await canvas.evaluate(
    (el, { gw, gh }) => {
      const c = el as HTMLCanvasElement;
      const ctx = c.getContext('2d');
      if (!ctx) return null;
      const img = ctx.getImageData(0, 0, c.width, c.height);
      const w = c.width, h = c.height;
      const cells = new Array<number>(gw * gh).fill(0);
      const counts = new Array<number>(gw * gh).fill(0);
      let n = 0, sum = 0, sumSq = 0, nonBlack = 0;
      for (let y = 0; y < h; y++) {
        const gy = Math.min(gh - 1, Math.floor((y / h) * gh));
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          const v = (img.data[i]! + img.data[i + 1]! + img.data[i + 2]!) / 3;
          sum += v; sumSq += v * v;
          // Threshold at 1 (essentially "any pixel above pure 0"). This floor
          // is now the SECONDARY check — see the differential above.
          if (v > 1) nonBlack++;
          n++;
          const gx = Math.min(gw - 1, Math.floor((x / w) * gw));
          const k = gy * gw + gx;
          cells[k] += v;
          counts[k]++;
        }
      }
      for (let k = 0; k < cells.length; k++) cells[k] = counts[k]! ? cells[k]! / counts[k]! : 0;
      const mean = sum / n;
      return { cells, variance: sumSq / n - mean * mean, nonBlackFrac: nonBlack / n };
    },
    { gw: SINK_GRID_W, gh: SINK_GRID_H },
  );
}

/** How many grid cells of `frame` differ from `idle` by more than the delta. */
function differsFrom(frame: readonly number[], idle: readonly number[]): number {
  if (idle.length === 0) return frame.length; // no idle measured — see sinkIdleCells
  let d = 0;
  for (let k = 0; k < frame.length; k++) {
    if (Math.abs(frame[k]! - (idle[k] ?? 0)) > SINK_CELL_DELTA) d++;
  }
  return d;
}

/** The videoOut sink's OWN idle picture, as a 16x12 luma grid.
 *
 *  Measured ONCE PER WORKER (module scope is worker scope in Playwright) from a
 *  rack holding only a videoOut, because it is a property of videoOut and not of
 *  any SUT: paying it per test would add a navigation to all 25 video modules
 *  for the same numbers. Two consecutive agreeing reads are required before it
 *  is cached, so an idle that turns out to animate cannot be frozen at one
 *  arbitrary tick and then differ from itself in every later comparison. */
let idleSinkCells: number[] | null = null;
async function sinkIdleCells(page: Page): Promise<number[]> {
  if (idleSinkCells) return idleSinkCells;
  const sink = pickOutputSink('video');
  if (!sink) return [];
  await page.goto('/rack?seed=none');
  await spawnPatch(page, [sink.node], []);
  const canvas = page.locator(
    `canvas[data-testid="video-tile-thumb"][data-thumb-node="${sink.node.id}"]`,
  );
  await expect(
    canvas,
    'the idle videoOut sink must paint a tile thumb — without it there is nothing to compare against',
  ).toHaveCount(1);
  let prev: number[] | null = null;
  await expect
    .poll(
      async () => {
        const f = await readSinkFrame(canvas);
        if (!f) return false;
        const settled = prev !== null && differsFrom(f.cells, prev) === 0;
        prev = f.cells;
        return settled;
      },
      {
        message: 'the idle videoOut picture must settle before it can be used as a control',
        timeout: SINK_FRAME_TIMEOUT_MS,
      },
    )
    .toBe(true);
  idleSinkCells = prev ?? [];
  return idleSinkCells;
}

test.describe('per-module per-port: outputs emit signal', () => {
  for (const mod of REGISTRY) {
    if (mod.outputs.length === 0) continue;
    const title = `${mod.type}: every declared output emits a measurable signal`;
    const skipReason = emitSkipReason(mod);
    if (skipReason) {
      test.fixme(`${title} [SKIPPED: ${skipReason}]`, () => {});
      continue;
    }

    test(title, async ({ page }) => {
      test.setTimeout(emitBudgetMs(mod));

      const errors = collectPageErrors(page);

      // The control for every VIDEO port below: what this module's sink looks
      // like with nothing patched into it. Hoisted out of the port loop because
      // it navigates, and cached across the worker because it is a property of
      // videoOut. Modules with no video-sinking output never pay for it.
      const idle = mod.outputs.some(
        (p) => !EXEMPT_OUTPUT_EMIT[`${mod.type}.${p.id}`] && pickOutputSink(p.type)?.node.type === 'videoOut',
      )
        ? await sinkIdleCells(page)
        : [];

      const driver = driverFor(mod);
      // Per-port driver: category-appropriate setup (page-init shim,
      // pre-seeded params/data, additional upstream graph, post-spawn
      // event dispatch). Null when the module needs no extra work
      // beyond the default driver path. See _per-port-drivers.ts for
      // the full registry + rationale.
      const ppDriver = perPortDriverFor(mod.type);

      // pageSetup MUST run before every navigation (the init script
      // is bound to the page, not the document, so addInitScript
      // re-installs the shim on each goto). Install once here AND on
      // each per-output iteration below — `addInitScript` is idempotent
      // (Playwright tracks it per-context, second call appends a second
      // script but the shims are written defensively to no-op on
      // re-install).
      if (ppDriver?.pageSetup) await ppDriver.pageSetup(page);

      // Loop over outputs serially within the test — each iteration
      // re-navigates to '/' to get a fresh AudioContext + fresh engine.
      // We CAN'T just spawnPatch+rebuild within a single navigation
      // because the AudioContext keeps the previous SUT's audio sources
      // alive (their .start() is sticky), and respawning the same SUT
      // type mid-page sometimes leaves the engine's audio-bridge
      // bookkeeping confused — NIBBLES.snake observed silent on iter 2
      // but ringing on a fresh-page direct spawn. The goto() cost is
      // ~1.5s per output; well worth the determinism.
      for (const port of mod.outputs) {
        const exemptReason = EXEMPT_OUTPUT_EMIT[`${mod.type}.${port.id}`];
        if (exemptReason) {
          // Log + continue. The handle-presence test already pinned
          // this port; here we deliberately don't run signal-flow.
          // eslint-disable-next-line no-console
          console.log(`[per-port] SKIP emit ${mod.type}.${port.id}: ${exemptReason}`);
          continue;
        }

        // FRESH NAVIGATION PER PORT — deliberate, and NOT the expensive part.
        // Re-using one page would let iteration N-1's still-running audio source
        // (an AudioBufferSourceNode's .start() is sticky) leak into iteration N
        // and turn a dead port GREEN, so the nav stays.
        //
        // What is gone is the `waitForLoadState('networkidle')` that used to sit
        // right here. MEASURED on clipplayer (24 ports, E2E_SWIFTSHADER=1):
        // goto ~10 ms, networkidle ~1000 ms, spawn ~80 ms, read ~50 ms — the
        // fixed wait was ~85 % of every iteration and ~24 s of the test's 30 s.
        // It bought nothing: `networkidle` resolves 500 ms after the last
        // request, which is a PROXY for app readiness, and the very next call —
        // `spawnPatch` — waits for `__ensureEngine` to be bound, awaits the
        // engine boot, and then waits for the requested node ids to mount on a
        // FRAME budget. That chain is strictly stronger AND event-driven, so the
        // quiet-window wait was a fixed cost in front of the real gate.
        // (_helpers.ts already says as much at its HMR retry: "networkidle is
        // too strict here".)
        await page.goto('/rack?seed=none');

        const sink = pickOutputSink(port.type);
        if (!sink) {
          // Unknown port type — fail loudly so adding a new cable type
          // forces a decision (extend pickOutputSink or add an exemption).
          expect(
            sink,
            `${mod.type}.${port.id} (type=${port.type}): no sink known for type — extend pickOutputSink or add EXEMPT_OUTPUT_EMIT`,
          ).not.toBeNull();
          continue;
        }

        // SUT params: merge the per-port driver's seed params with the
        // legacy _drivers.ts params (per-port wins on conflict so the
        // category-aware driver controls e.g. isPlaying for sequencer).
        const sutParams = { ...(driver.params ?? {}), ...(ppDriver?.params ?? {}) };
        const sutNode: SpawnNode = {
          id: 'sut',
          type: mod.type,
          position: { x: 400, y: 60 },
          domain: mod.domain,
          params: sutParams,
        };
        const nodes: SpawnNode[] = [sutNode, sink.node];
        const edges: SpawnEdge[] = [
          {
            id: 'e-sut-sink',
            from: { nodeId: 'sut', portId: port.id },
            to:   { nodeId: sink.node.id, portId: sink.inPort },
            sourceType: port.type,
            targetType: sink.targetType,
          },
        ];
        // Per-port driver upstream graph (BUGGLES → ILLOGIC.in1,
        // SEQUENCER → STAGES.trig, ACIDWARP → VIDEOOUT.in, etc.).
        if (ppDriver?.upstream) {
          const extra = ppDriver.upstream('sut');
          nodes.push(...extra.nodes);
          edges.push(...extra.edges);
        }
        if (driver.gatePort || driver.pitchPort) {
          nodes.unshift({
            id: 'driver-seq',
            type: 'kria',
            position: { x: 60, y: 280 },
            // Same 16th grid + bpm as the deleted SEQUENCER driver.
            params: { bpm: 240, running: 1 },
          });
          if (driver.gatePort) {
            edges.unshift({
              id: 'e-seq-g',
              from: { nodeId: 'driver-seq', portId: 'gate1' },
              to:   { nodeId: 'sut',        portId: driver.gatePort },
              sourceType: 'gate',
              targetType: 'gate',
            });
          }
          if (driver.pitchPort) {
            edges.unshift({
              id: 'e-seq-p',
              from: { nodeId: 'driver-seq', portId: 'pitch1' },
              to:   { nodeId: 'sut',        portId: driver.pitchPort },
              sourceType: 'pitch',
              targetType: 'cv',
            });
          }
        }

        await spawnPatch(page, nodes, edges);

        // Seed SUT-side node.data BEFORE the engine reads it on the
        // next tick. Sequencer-family modules read data.steps each
        // tick from livePatch, so writing here is picked up within ~25ms.
        if (ppDriver?.data) {
          await page.evaluate(({ id, data }) => {
            const w = globalThis as unknown as {
              __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
              __ydoc: { transact: (fn: () => void) => void };
            };
            w.__ydoc.transact(() => {
              const n = w.__patch.nodes[id];
              if (!n) return;
              if (!n.data) n.data = {};
              for (const [k, v] of Object.entries(data)) n.data[k] = v;
            });
          }, { id: 'sut', data: ppDriver.data });
        }

        // Post-spawn dispatch (synthetic keypresses, MIDI sends,
        // sequencer-step seeding for driver-seq under the upstream graph).
        if (ppDriver?.postSpawn) await ppDriver.postSpawn(page, 'sut');

        if (driver.gatePort || driver.pitchPort) {
          // KRIA is data-driven — an unseeded node has no active pattern and
          // emits nothing, so the driver MUST be seeded (C4/E4/G4/C5 arp).
          await page.evaluate((data) => {
            const w = globalThis as unknown as {
              __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
              __ydoc: { transact: (fn: () => void) => void };
            };
            w.__ydoc.transact(() => {
              const seq = w.__patch.nodes['driver-seq'];
              if (!seq) return;
              if (!seq.data) seq.data = {};
              for (const [k, v] of Object.entries(data)) seq.data[k] = v;
            });
          }, buildKriaData([
            { note: 0, octave: 1 }, // C4 (60)
            { note: 2, octave: 1 }, // E4 (64)
            { note: 4, octave: 1 }, // G4 (67)
            { note: 0, octave: 2 }, // C5 (72)
          ]));
        }

        // ── THE OBSERVATION WINDOW IS A BOUND, NOT A GATE ──────────────────
        //
        // It used to be a GATE, sized by guesswork: 800 ms for a same-domain
        // scope read, 1 200 for a gate port, 2 000 cross-domain, ≥3 000 for a
        // heavy-GL module. Every one of those numbers was fiction, because the
        // loop underneath spent `polls × round-trip` rather than `totalMs` —
        // MEASURED at 11.4 s for a stated 1 200 ms. The tiering was therefore
        // never doing the job it was written for; the OVERRUN was.
        //
        // Proof that the overrun was load-bearing, not incidental: with the
        // window made real at its stated 800 ms, `sampleHold.cv_quant` FAILED
        // (`samples=25 over 811 ms`, peak 0.0000) — and probing it with a
        // 20 s window shows why. Its signal appears at **1 141 ms**. The stated
        // window had been too small for that port since it was written; only
        // the accidental ~10× overrun ever covered it. Restoring the tiering
        // as-is would ship a real timeout.
        //
        // So the window is now sized as what it actually is — a FAILURE BOUND,
        // per CLAUDE.md ("keep a wall-clock cap only to bound the failure,
        // never as the gate"). The GATE is the early-out: `observeScopePeak`
        // returns the instant ch1 clears the floor, so a healthy port pays its
        // own signal latency (MEASURED: 30–90 ms for continuous CV/audio,
        // 1 141 ms for the slowest live port) and NOT the window. Making the
        // bound generous therefore costs the happy path nothing, while removing
        // the whole class of "the guessed number was 40 % too small".
        //
        // The tiering is gone with it: three tiers that were never the real
        // window are three numbers to get wrong. One bound, one heavy-GL bound.
        const HEAVY_GL = touchesVideo(mod);
        // Bounds a dead port. 4.4× the slowest measured live port (1 141 ms),
        // so a CI runner would have to be >4× slower than a local preview run
        // before this became the gate again.
        const OBSERVE_BOUND_MS = 5_000;
        // Heavy-WebGL modules (touchesVideo) mount a GL pipeline on CI's
        // SwiftShader before the audio graph warms up, so a continuous tap
        // (WAVESCULPT.L) can still be ramping — the "peak=0, polls=1" symptom
        // the old ≥3 s floor was added for. Same reasoning, bigger bound.
        const OBSERVE_BOUND_HEAVY_GL_MS = 8_000;

        // Read the sink. Audio-domain sink (SCOPE) → analyser snapshot.
        // Video-domain sink (VIDEOOUT) → canvas-pixel statistics.
        if (sink.node.type === 'scope') {
          // The peak-hold runs IN THE PAGE on a 30 ms interval — below the
          // analyser's ~43 ms refresh (fftSize 2048 @ 48 kHz), so a gate pulse
          // cannot fall between two readings — and comes back over ONE round
          // trip. That contiguity is what the old loop's comment claimed and
          // its ~420 ms real spacing could not deliver. See observeScopePeak.
          const boundMs = HEAVY_GL ? OBSERVE_BOUND_HEAVY_GL_MS : OBSERVE_BOUND_MS;
          const obs = await observeScopePeak(page, sink.node.id, {
            windowMs: boundMs,
            floor: 0.005,
          });
          // INSTRUMENT BEFORE FINDING. `maxPeak = 0` from a window that took no
          // readings is not evidence about the port — the old loop's
          // `if (!snap) continue` made "the engine handle never resolved" print
          // exactly like "the output is dead". Fail as an instrument first.
          expect(
            obs.samples,
            `${mod.type}.${port.id}: the scope observation took NO readings in `
            + `${Math.round(obs.elapsedMs)} ms (bound=${boundMs} ms) — the engine/scope handle `
            + `never resolved, so this run says NOTHING about whether the port emits. `
            + `This is an instrument failure, not a dead port.`,
          ).toBeGreaterThan(0);
          // CAUSE, NOT JUST LEVEL. The peak/rms/samples triple says HOW MUCH
          // signal arrived and nothing about WHY it did not — which is how a
          // moog904a.audio flake supported two incompatible explanations
          // through a full log read. Read the discriminating state only on the
          // failing branch, so a green port pays no extra round trip.
          // See readEmitDiagnostics for the measurement that motivated it.
          // ⚠ The probe must never COST us the finding. It runs on a page that
          // has already misbehaved once, so a throw here would replace a real
          // measurement with a stack trace about the instrument. Degrade to a
          // note instead and let the peak/rms/samples triple stand on its own.
          let diagLine = '';
          if (obs.maxPeak <= 0.005) {
            try {
              diagLine = formatEmitDiagnostics(
                await readEmitDiagnostics(page, 'sut', Object.keys(sutParams), 'e-sut-sink'),
              );
            } catch (err) {
              diagLine = `unavailable (${(err as Error)?.message ?? 'unknown'})`;
            }
          }
          expect(
            obs.maxPeak,
            `${mod.type}.${port.id} (type=${port.type}): scope.ch1 peak above floor `
            + `(maxPeak=${obs.maxPeak.toFixed(4)}, lastRms=${obs.lastRms.toFixed(4)}, `
            + `samples=${obs.samples} over ${Math.round(obs.elapsedMs)} ms of a ${boundMs} ms `
            + `bound, unpatched ch2 peak=${obs.maxPeakCh2.toFixed(4)})`
            + (diagLine ? `\n  SUT state at failure: ${diagLine}` : ''),
          ).toBeGreaterThan(0.005);
        } else {
          // ────────── VIDEO OUTPUT → the sink's PICTURE, against its OWN IDLE ──
          //
          // Two things changed here, and the second one is the important one.
          //
          // 1. THE SINK IS ADDRESSED BY NODE ID. The read used to be
          //    `canvas[data-testid="video-out-canvas"]` — a testid only
          //    `VideoOutCard.svelte` ever emitted — followed by `.last()`,
          //    because when the SUT was itself a videoOut BOTH cards painted
          //    one and "the later-mounted element" was the only way to say
          //    "the sink". All 25 video modules' emit legs went red the moment
          //    this file booted the shell a player gets: there is no card, so
          //    the locator resolved nothing, and `toHaveCount(0)` is what an
          //    ABSENT SURFACE looks like — it says nothing about the port. The
          //    lane tile paints `VideoTileThumb`, a 160x120 2D canvas fed by
          //    the same central engine frame the card canvas took, stamped with
          //    `data-thumb-node`. Naming the sink also retires `.last()`: a
          //    videoOut SUT paints its own thumb and this locator cannot pick
          //    it up by accident.
          //
          // 2. ⚠ THE OLD FLOORS PASSED WITH NOTHING CONNECTED, ON BOTH
          //    SURFACES. MEASURED (2026-09-04, painter + videoOut, sink
          //    spawned with NO edge): the shell tile reads nonBlackFrac 1.0000
          //    / variance 1.50, and the legacy card canvas read nonBlackFrac
          //    1.0000 / variance 22.82. Both clear `> 0.001` and `> 0.5`. So
          //    "the port emits" was never what this branch measured — an
          //    unpatched videoOut paints its own dark-blue idle gradient
          //    (10,15,27..37), and the card's numbers came from the card CHROME
          //    around the frame. The vacuity is pre-existing, not something the
          //    shell flip introduced; the flip only stopped it being green.
          //
          //    The repair is a DIFFERENTIAL against the thing that was
          //    indistinguishable: the sink's own idle picture, measured once
          //    per worker from a rack holding ONLY a videoOut, and required to
          //    be different from what the sink shows with the SUT patched in.
          //    That is the same claim the floors meant to make ("a picture
          //    arrived"), stated against the state it has to be told apart
          //    from. The floors stay as the secondary "not pure black" and
          //    "painted something" checks, because they still catch a sink that
          //    went black — a state the differential alone would accept.
          const canvases = page.locator(
            `canvas[data-testid="video-tile-thumb"][data-thumb-node="${sink.node.id}"]`,
          );
          await expect(
            canvases,
            `${mod.type}.${port.id}: videoOut sink tile thumb present`,
          ).toHaveCount(1);
          const canvas = canvases.first();
          // ⚠ READ THE WELL ONLY ONCE IT HAS PAINTED. `VideoTileThumb` has
          // three states and the first two are pixel-different from the third
          // while being STILL: before its first tick the 2D context has drawn
          // nothing, so `getImageData` returns transparent black everywhere —
          // which is not "the sink is black", it is "the sink has not answered
          // yet". It also defeats the differential in the wrong direction: an
          // all-zero frame differs from the idle gradient in every cell, so the
          // poll below would exit on the FIRST read with the emptiest possible
          // canvas. The component publishes `data-thumb-painted` exactly once,
          // on `framesDrawnFor(nodeId) >= 1`, for this. It is observable state,
          // not a delay.
          await expect(
            canvas,
            `${mod.type}.${port.id}: the videoOut sink's well must have painted at least one `
            + `engine frame before its pixels mean anything (data-thumb-painted)`,
          ).toHaveAttribute('data-thumb-painted', '1', { timeout: SINK_FRAME_TIMEOUT_MS });
          // Poll: the thumb is throttled to VIDEO_THUMB_FPS (15) and its first
          // ticks paint the empty well before the engine has drawn the node, so
          // the FIRST readable frame is not necessarily the settled one. The
          // poll ends the moment the picture differs from idle, so a healthy
          // port pays one round trip.
          //
          // ⚠ AN EMPTY FRAME DOES NOT COUNT AS "DIFFERENT", and getting that
          // wrong is how a differential lies in the OTHER direction. The tile's
          // `drawImage` is skipped entirely while the sink has no output texture
          // (`outputTexture(nodeId)` null — the guard that stops a texture-less
          // node snapshotting somebody else's frame), so the well can sit at
          // transparent-black AFTER `data-thumb-painted` is stamped, and
          // transparent-black differs from the idle gradient in EVERY cell. A
          // naive predicate therefore returns 192 on the emptiest possible read
          // and ends the poll on the one frame that says nothing. Requiring
          // ink first makes the wait wait: measured, loopback / lushgarden read
          // empty at ~1 s and carry a real picture by ~4 s.
          const held: { frame: SinkFrame | null } = { frame: null };
          await expect
            .poll(
              async () => {
                held.frame = await readSinkFrame(canvas);
                if (!held.frame) return -1;
                if (held.frame.nonBlackFrac <= 0.001) return 0; // no ink yet — keep waiting
                return differsFrom(held.frame.cells, idle);
              },
              {
                message:
                  `${mod.type}.${port.id} (type=${port.type}): the videoOut sink must show a `
                  + `DIFFERENT picture from its own idle. An unpatched videoOut paints a dark `
                  + `gradient that clears every brightness floor, so "not black" is not evidence `
                  + `the port emitted anything.`,
                timeout: SINK_FRAME_TIMEOUT_MS,
              },
            )
            .toBeGreaterThan(SINK_DIFF_MIN_CELLS);
          const stats = held.frame;
          expect(stats, `${mod.type}.${port.id}: video stats read succeeded`).not.toBeNull();
          if (!stats) continue;
          // Secondary floors, unchanged in value and now genuinely secondary:
          // the differential above is what proves a picture ARRIVED; these two
          // still catch a sink that arrived BLACK (bridge delivered an empty
          // texture), which differs from idle and would otherwise pass.
          expect(
            stats.nonBlackFrac,
            `${mod.type}.${port.id} (type=${port.type}): canvas non-blank fraction above floor (nonBlackFrac=${stats.nonBlackFrac.toFixed(4)}, variance=${stats.variance.toFixed(2)})`,
          ).toBeGreaterThan(0.001);
        }
      }

      expect(
        errors.significant(),
        `${mod.type} outputs-emit: no console / page errors (a failed resource load — a 404'd `
        + `worklet, a dropped static asset — reads as "Failed to load resource" with the url in `
        + `brackets; see _page-errors.ts for the named optional-asset exemptions)`,
      ).toEqual([]);
    });
  }
});
