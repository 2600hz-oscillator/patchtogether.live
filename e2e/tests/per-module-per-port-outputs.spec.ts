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
        await page.goto('/rack?shell=legacy&seed=none');

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
            params: { bpm: 240, length: 4, isPlaying: 1, gateLength: 0.5 },
          });
          if (driver.gatePort) {
            edges.unshift({
              id: 'e-seq-g',
              from: { nodeId: 'driver-seq', portId: 'gate' },
              to:   { nodeId: 'sut',        portId: driver.gatePort },
              sourceType: 'gate',
              targetType: 'gate',
            });
          }
          if (driver.pitchPort) {
            edges.unshift({
              id: 'e-seq-p',
              from: { nodeId: 'driver-seq', portId: 'pitch' },
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
          await page.evaluate(() => {
            const w = globalThis as unknown as {
              __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
              __ydoc: { transact: (fn: () => void) => void };
            };
            w.__ydoc.transact(() => {
              const seq = w.__patch.nodes['driver-seq'];
              if (!seq) return;
              if (!seq.data) seq.data = {};
              seq.data.steps = [
                { on: true, midi: 60 },
                { on: true, midi: 64 },
                { on: true, midi: 67 },
                { on: true, midi: 72 },
              ];
            });
          });
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
          // Video output → VIDEOOUT canvas stats. We assert TWO floors:
          //   * any-nonblack pixel fraction > 0.1% — catches a totally
          //     blank canvas (the regression case: video bridge dropped
          //     the edge or the source's drawFrame() noop'd).
          //   * variance threshold — calibrated per cable type. `video`
          //     outputs typically fill the frame, so >5 is fine (matches
          //     wavecel-video-outs). `mono-video` outputs are often
          //     waveform-scope renders (a thin trace on a near-black
          //     canvas) where variance is intrinsically low; >0.5 is
          //     the floor where a SINGLE-PIXEL trace clears noise.
          // When the SUT is itself a videoOut module, BOTH the SUT and
          // the sink render `data-testid="video-out-canvas"` so the
          // locator matches 2 elements. Use `.last()` to target the
          // sink (added to the patch AFTER the SUT, so its canvas is
          // mounted last and represents what came OUT of the SUT's
          // passthrough). For non-videoOut SUTs, count is 1 and last()
          // == only().
          const canvases = page.locator('canvas[data-testid="video-out-canvas"]');
          await expect(canvases, `${mod.type}.${port.id}: video-out canvas present`).not.toHaveCount(0);
          const canvas = canvases.last();
          const stats = await canvas.evaluate((el) => {
            const c = el as HTMLCanvasElement;
            const ctx = c.getContext('2d');
            if (!ctx) return null;
            const img = ctx.getImageData(0, 0, c.width, c.height);
            const w = c.width, h = c.height;
            let n = 0, sum = 0, sumSq = 0, nonBlack = 0;
            for (let y = 0; y < h; y++) {
              for (let x = 0; x < w; x++) {
                const i = (y * w + x) * 4;
                const v = (img.data[i]! + img.data[i + 1]! + img.data[i + 2]!) / 3;
                sum += v; sumSq += v * v;
                // Threshold at 1 (essentially "any pixel above pure 0").
                // mono-video waveform-scope traces antialias down to v~10-30
                // at the trace center but the dimmest edge pixels are
                // v~2-5; setting the floor at 1 catches the trace + the
                // anti-aliased shoulder without claiming pure-black canvases.
                if (v > 1) nonBlack++;
                n++;
              }
            }
            const mean = sum / n;
            return { variance: sumSq / n - mean * mean, nonBlackFrac: nonBlack / n, n };
          });
          expect(stats, `${mod.type}.${port.id}: video stats read succeeded`).not.toBeNull();
          if (!stats) continue;
          // Variance floor: relatively loose because bare-spawn video
          // outputs often render THIN content (a 1-pixel scope trace, a
          // single-line 3D wavetable) on a near-black canvas — variance
          // is dominated by background. The nonBlackFrac assertion above
          // already pins "the canvas is not pure black"; variance > 0.5
          // is the secondary "the painter actually painted SOMETHING with
          // contrast" check. wavecel-video-outs.spec.ts asserts >5
          // SPECIFICALLY because its scene drives an upstream VCO — that
          // test's upstream-source pattern is the right way to assert
          // a stronger floor.
          const varianceFloor = 0.5;
          expect(
            stats.nonBlackFrac,
            `${mod.type}.${port.id} (type=${port.type}): canvas non-blank fraction above floor (nonBlackFrac=${stats.nonBlackFrac.toFixed(4)}, variance=${stats.variance.toFixed(2)})`,
          ).toBeGreaterThan(0.001);
          expect(
            stats.variance,
            `${mod.type}.${port.id} (type=${port.type}): video-out canvas variance above floor (variance=${stats.variance.toFixed(2)}, floor=${varianceFloor})`,
          ).toBeGreaterThan(varianceFloor);
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
