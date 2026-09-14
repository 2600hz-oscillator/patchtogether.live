// SAMSLOOP IN A CLIP-LAUNCHER LANE — the owner's sentence (2026-09-14):
// "samsloop dropped into a clip launcher lane should autoconnect its speed
// setting to the pitch cv, as well (gates and audio already work)".
//
// This is the AGENTS.md boundary-8 proof for the new `pitch_cv` jack: the REAL
// default-mode source (the pinned CLIP PLAYER, seeded through its Y.Doc and run
// by the pinned TIMELORDE) → the REAL palette-drop seams (__setSpawnFlowPos +
// __spawnFromPalette → wcolDropTarget → lane membership → the column
// reconciler, which writes `pitch1→pitch_cv` and `gate1→trig` under the
// `wcol-e-` namespace) → the REAL worklet → the pinned mixer → the terminal
// `outputSnapshot` tap on AUDIO OUT. Nothing here drives the engine class, and
// nothing asserts an edge alone.
//
// THE LAW UNDER TEST: `step = rate × 2^V × rateScale` with V = (midi − 60) / 12
// (0 V = C4 = as recorded). The loaded sample is a 220 Hz sine, so the audible
// fundamental at the terminal IS the transposition:
//   C4 (60) → 220 Hz     unity at the reference note
//   C5 (72) → 440 Hz     chain liveness: 0 V ≡ unpatched, +1 V cannot be faked
//   C3 (48) → 110 Hz     the ADDITIVE-law control — knob 1 + (−1) = 0 would
//                        FREEZE the cursor, and the liveness gate fails by name
//   G4 (67) → 329.63 Hz  exp-vs-linear at the cents level: an additive path
//                        would read 1 + 7/12 = 1.583× = 348.3 Hz, 95 ¢ out
// plus the wiring itself and a MUST-READ-ZERO leg (same lane, clip running, no
// sample loaded → silence), so "the module sounds" and "the meter is stuck
// high" cannot print identically.
//
// MEASUREMENT: `readScopePeakOverWindow` on a scope patched to the samsloop's
// OUT is the liveness gate (observe UNTIL audible, cap bounds the failure);
// the pitch is the MEDIAN spectral fundamental over ≥ 12 terminal snapshots,
// bracketed ±6 % around the expected note (the voice-pitch-accuracy shape), to
// the same 6 ¢ real-chain tolerance. The snapshots are gathered INSIDE THE
// PAGE and paced on the AUDIO CLOCK (`measureTerminalCents` says why: a
// per-window protocol round trip is what a starved 2-core runner cannot
// afford, and it was the instrument — never the chain — that went red). The
// scope is added to the patch IN PLACE (a Y.Doc transact, never `spawnPatch`,
// which clears the rack and with it the pinned trio this spec exists to drive).

import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';
import { installRenderSmokeHooks } from './_render-smoke';
import { BOOT_MS } from '../_helpers/boot-budget';
import { waitForMounted } from './_helpers';
import { openSamsloopPane } from './_samsloop-helpers';
import { readScopePeakOverWindow, describeScopeWindow } from './_module-coverage-helpers';

test.describe.configure({ mode: 'parallel' });

/** channel-columns.ts geometry (workflow-channel-columns.spec.ts values). */
const COLUMN_W = 765;
const COLUMN_BASELINE_Y = 4320;
const PINNED_MIXER = 'pinned-mixmstrs';
const PINNED_CLIP = 'pinned-clipplayer';
const PINNED_OUT = 'pinned-audioOut';

const TOL_CENTS = 6;
const AUDIBLE_FLOOR = 0.01;
/** CAP that BOUNDS THE FAILURE; it is NOT the gate. */
const AUDIBLE_CAP_MS = 8_000;
/** Full-window observation for the SILENCE leg — no early exit. */
const SILENCE_WINDOW_MS = 600;
/** Non-overlapping terminal windows the pitch median wants (the GATE the
 *  in-page sampler exits on), the floor the assertion holds it to, and the
 *  CAP that bounds the failure when they never come (NOT the gate). */
const PITCH_WINDOWS = 30;
const PITCH_WINDOWS_MIN = 12;
const PITCH_CAP_MS = 12_000;
/** The in-page sampler's tick — readScopePeakOverWindow's cadence. A window is
 *  ACCEPTED on the audio clock (below), never on this interval. */
const PITCH_TICK_MS = 20;
/** Local reproduction of a starved CI main thread: `E2E_CPU_THROTTLE=20`
 *  applies CDP CPU throttling to the page (the backdraft-clocked-delay.spec.ts
 *  method). The renderer slows; the AUDIO clock does not — exactly the shape
 *  of e2e shard 9 in run 34889596109, where this file's C4 and C5 legs went
 *  red on a 2-core runner while a real-GPU Mac passed 18/18. Never set on CI. */
const CPU_THROTTLE = Number(process.env.E2E_CPU_THROTTLE ?? '1');

/** Applied AFTER the boot and the sample load, as backdraft does after its
 *  baseline: shard 9 did not starve the boot (`waitForPinnedTrio` took 2.6 s
 *  there) and BOOT_MS is its own budget — what starved was the MEASUREMENT,
 *  and that is the phase this throttles. No-op at the default rate 1. */
async function starveMainThread(page: Page): Promise<void> {
  if (CPU_THROTTLE <= 1) return;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE });
}

/** The loaded sample's own pitch, and the notes that transpose it. */
const SAMPLE_HZ = 220;
const NOTES = [
  { name: 'C4', midi: 60, hz: 220, why: 'unity at the reference note (0 V = as recorded)' },
  { name: 'C5', midi: 72, hz: 440, why: 'chain liveness: 0 V ≡ unpatched, +1 V cannot be faked' },
  { name: 'C3', midi: 48, hz: 110, why: 'additive-law control: knob 1 + (−1 V) = 0 would FREEZE the cursor' },
  { name: 'G4', midi: 67, hz: 220 * Math.pow(2, 7 / 12), why: 'exp-vs-linear at cents level: additive would read 348.3 Hz (95 ¢ out)' },
] as const;

function colPos(ch: number): { x: number; y: number } {
  return { x: (ch - 1) * COLUMN_W + 60, y: COLUMN_BASELINE_Y - 40 };
}

async function waitForPinnedTrio(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const w = globalThis as unknown as {
        __patch?: { nodes: Record<string, { data?: { pinned?: boolean } } | undefined> };
      };
      return !!w.__patch && ['pinned-mixmstrs', 'pinned-clipplayer', 'pinned-audioOut'].every(
        (id) => w.__patch!.nodes[id]?.data?.pinned === true,
      );
    },
    undefined,
    { timeout: BOOT_MS },
  );
}

async function waitForHooks(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const w = globalThis as unknown as { __setSpawnFlowPos?: unknown; __spawnFromPalette?: unknown };
      return typeof w.__setSpawnFlowPos === 'function' && typeof w.__spawnFromPalette === 'function';
    },
    undefined,
    { timeout: BOOT_MS },
  );
}

async function dropInBand(page: Page, type: string, pos: { x: number; y: number }): Promise<void> {
  await waitForHooks(page);
  await page.evaluate(
    ({ type, pos }) => {
      const w = globalThis as unknown as {
        __setSpawnFlowPos: (p: { x: number; y: number }) => void;
        __spawnFromPalette: (t: string) => void;
      };
      w.__setSpawnFlowPos(pos);
      w.__spawnFromPalette(type);
    },
    { type, pos },
  );
}

async function orderOf(page: Page, kind: 'columns' | 'sends', key: number): Promise<string[]> {
  return page.evaluate(
    ({ kind, key }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { data?: Record<string, Record<string, string[]>> } | undefined> };
      };
      return w.__patch.nodes['pinned-mixmstrs']?.data?.[kind]?.[String(key)] ?? [];
    },
    { kind, key },
  );
}

async function wcolEdges(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { edges: Record<string, { source: { nodeId: string; portId: string }; target: { nodeId: string; portId: string } } | undefined> };
    };
    return Object.entries(w.__patch.edges)
      .filter(([id, e]) => e && id.startsWith('wcol-e-'))
      .map(([, e]) => `${e!.source.nodeId}.${e!.source.portId}->${e!.target.nodeId}.${e!.target.portId}`);
  });
}

/** Seed ONE looping note on `lane` and run every TIMELORDE — the
 *  vst-lane-autowire / workflow-channel-columns seedAndRun, parametrised on the
 *  note. A single step per 16-step loop: the gate re-strikes the loop every
 *  bar and S&H (default ON) holds the pitch between strikes. */
async function seedAndRun(page: Page, lane: number, midi: number): Promise<void> {
  await page.evaluate(({ lane, midi }) => {
    const w = globalThis as unknown as {
      __ydoc: { transact: (fn: () => void) => void };
      __patch: { nodes: Record<string, { type?: string; params: Record<string, number>; data?: Record<string, unknown> } | undefined> };
    };
    w.__ydoc.transact(() => {
      const cp = w.__patch.nodes['pinned-clipplayer']!;
      if (!cp.data) cp.data = {};
      const d = cp.data as { clips?: Record<string, unknown>; queued?: (number | 'stop' | null)[]; queuedImmediate?: boolean[] };
      if (!d.clips) d.clips = {};
      d.clips[String(lane * 64)] = { kind: 'note', steps: [{ step: 0, midi }], lengthSteps: 16, root: 48, loop: true };
      const queued = new Array(8).fill(null) as (number | 'stop' | null)[];
      const imm = new Array(8).fill(false) as boolean[];
      queued[lane] = 0; imm[lane] = true;
      d.queued = queued;
      d.queuedImmediate = imm;
      for (const n of Object.values(w.__patch.nodes)) {
        if (n?.type === 'timelorde') { n.params.running = 1; n.params.bpm = 120; }
      }
    });
  }, { lane, midi });
}

/** 16-bit mono WAV: a 220 Hz sine at a constant 0.8, 4 s at 44.1 kHz — 880
 *  whole cycles, so the loop wrap is seamless and every window the analyser
 *  sees is the sine. 44.1 kHz so `finalizeSamsloopBuffer` applies no
 *  downsample (factor < 2). The worklet's rateScale then plays it at its
 *  captured pitch in the 48 kHz context: 220 Hz at 0 V. */
function sineWav(sec = 4, rate = 44100): Buffer {
  const n = Math.floor(sec * rate);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    data.writeInt16LE(Math.round(0.8 * Math.sin((2 * Math.PI * SAMPLE_HZ * i) / rate) * 32767), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/** Boot /rack (the pins), drop a SAMSLOOP into channel 1 through the palette
 *  seams and wait for the reconciler to wire it. Returns the dropped node id. */
async function dropSamsloopInLane1(page: Page): Promise<string> {
  await page.goto('/rack');
  await waitForPinnedTrio(page);
  await dropInBand(page, 'samsloop', colPos(1));
  await expect.poll(async () => (await orderOf(page, 'columns', 1)).length, { timeout: 10_000 }).toBe(1);
  const sl = (await orderOf(page, 'columns', 1))[0]!;
  await expect
    .poll(async () => (await wcolEdges(page)).includes(`${PINNED_CLIP}.gate1->${sl}.trig`), {
      timeout: 10_000,
      message: 'the lane reconciler wires the clip gate into trig',
    })
    .toBe(true);
  return sl;
}

/** Load the sine through the dock pane's FILE cell (the shipped upload path). */
async function loadSine(page: Page, sl: string): Promise<void> {
  const pane = await openSamsloopPane(page, sl);
  await pane.getByTestId('shell-cell-samsloop-wav-input').setInputFiles({
    name: 'sine220.wav', mimeType: 'audio/wav', buffer: sineWav(),
  });
  await expect(pane.getByTestId('shell-cell-samsloop-wav-input-status'))
    .toContainText(/loaded \d+ samples/i, { timeout: 15_000 });
  // The pane was only the upload path. Close it (whole-view Escape — the
  // multi-video-playback.spec.ts gesture) BEFORE anything is measured: its
  // body redraws the waveform on EVERY rAF frame, folding all 176 k samples
  // into 512 columns each time (SamsloopOutputBody.svelte → foldWaveformColumns),
  // main-thread work that is not under test and that a starved runner cannot
  // spare. The sample lives on the node, not the pane; closing it stops nothing.
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-testid="dock-fullview-pane"]')).toHaveCount(0);
}

/** A scope on the samsloop's OUT, added IN PLACE (never spawnPatch — that
 *  clears the rack and the pins with it). Spawned above the lanes, so it is
 *  positionally outside every band and joins no column. */
async function addScopeOn(page: Page, sl: string): Promise<void> {
  await page.evaluate((sl) => {
    const w = globalThis as unknown as {
      __ydoc: { transact: (fn: () => void) => void };
      __patch: { nodes: Record<string, unknown>; edges: Record<string, unknown> };
    };
    w.__ydoc.transact(() => {
      w.__patch.nodes['sc'] = {
        id: 'sc', type: 'scope', domain: 'audio', position: { x: 60, y: 40 }, params: { timeMs: 50 },
      };
      w.__patch.edges['e_sl_sc'] = {
        id: 'e_sl_sc',
        source: { nodeId: sl, portId: 'out' },
        target: { nodeId: 'sc', portId: 'ch1' },
        sourceType: 'audio', targetType: 'audio',
      };
    });
  }, sl);
  await waitForMounted(page, ['sc']);
}

interface TerminalPitchRead {
  /** Cents off the expected note for every MEASURABLE (non-silent) window. */
  cents: number[];
  /** Fresh, non-overlapping windows READ off the tap, measurable or not. */
  windows: number;
  ticks: number;
  elapsedMs: number;
  /** How far AudioContext.currentTime advanced while we looked — a stalled
   *  clock, a starved sampler and a silent chain must print differently. */
  clockAdvancedSec: number;
  maxTickGapMs: number;
  spanMs: number;
}

/** Up to PITCH_WINDOWS non-overlapping terminal windows off AUDIO OUT's
 *  `outputSnapshot` tap, gathered INSIDE ONE page.evaluate and reduced to
 *  their spectral fundamentals in the page once the gathering is done.
 *
 *  WHY IN-PAGE, WHY THE AUDIO CLOCK (run 34889596109, e2e shard 9): the first
 *  cut of this loop lived in Node — one protocol round trip per window that
 *  shipped 2048 floats as JSON, then a 90 ms wall-clock sleep "longer than the
 *  analyser span". Every window it read was audible; it simply could not read
 *  twelve of them inside its 12 s cap on the 2-core runner, where each round
 *  trip took 300–670 ms and each 90 ms sleep 160–370 ms (11 iterations in all
 *  four traces; ×20 CDP CPU throttling reproduces it locally at 9–10). The
 *  subject was fine; the instrument was starved. Now the Float32Array never
 *  crosses the protocol boundary, and a window is accepted on OBSERVED state:
 *  AudioContext.currentTime has advanced one full analyser span plus one
 *  render quantum since the previous accepted read, so none of the frames the
 *  tap reports can belong to that window (the tap is a 2048-sample analyser,
 *  audio-out.ts:317). A tick does only the read, the RMS gate and a copy — the
 *  Goertzel sweep runs after the loop, off the pacing path — so a starved main
 *  thread costs the sampler ticks, never windows it could have taken. The cap
 *  bounds the failure; the gate is the measurable count reaching PITCH_WINDOWS. */
async function measureTerminalCents(
  page: Page,
  outNodeId: string,
  aroundHz: number,
): Promise<TerminalPitchRead> {
  return page.evaluate(
    async ({ id, around, want, capMs, tickMs }) => {
      const w = globalThis as unknown as {
        __engine?: () => {
          read: (n: unknown, k: string) => unknown;
          hasDomain?: (d: string) => boolean;
          getDomain?: (d: string) => { ctx?: { currentTime: number } };
        } | null;
        __patch: { nodes: Record<string, unknown> };
      };
      const eng = w.__engine?.();
      const node = w.__patch.nodes[id];
      const ctx = eng?.hasDomain?.('audio') ? eng.getDomain?.('audio')?.ctx : undefined;
      if (!eng || !node || !ctx) {
        return { cents: [], windows: 0, ticks: 0, elapsedMs: 0, clockAdvancedSec: 0, maxTickGapMs: 0, spanMs: 0 };
      }

      /** Hann-windowed Goertzel magnitude at `f` (voice-pitch-accuracy.spec.ts). */
      const goertzelMag = (buf: Float32Array, hann: Float32Array, f: number, sr: number): number => {
        const coeff = 2 * Math.cos((2 * Math.PI * f) / sr);
        let s1 = 0;
        let s2 = 0;
        for (let i = 0; i < buf.length; i++) {
          const s0 = buf[i]! * hann[i]! + coeff * s1 - s2;
          s2 = s1;
          s1 = s0;
        }
        return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - coeff * s1 * s2));
      };
      /** Peak of |X(f)| within ±6 % of `around` — coarse 1 Hz sweep, then a
       *  0.02 Hz refinement. */
      const spectralFundamental = (buf: Float32Array, hann: Float32Array, sr: number): number => {
        const lo = around * 0.94;
        const hi = around * 1.06;
        let best = around;
        let bestMag = -1;
        for (let f = lo; f <= hi; f += 1) {
          const m = goertzelMag(buf, hann, f, sr);
          if (m > bestMag) { bestMag = m; best = f; }
        }
        const fineLo = Math.max(lo, best - 1.5);
        const fineHi = Math.min(hi, best + 1.5);
        for (let f = fineLo; f <= fineHi; f += 0.02) {
          const m = goertzelMag(buf, hann, f, sr);
          if (m > bestMag) { bestMag = m; best = f; }
        }
        return best;
      };

      return await new Promise<TerminalPitchRead>((resolve) => {
        const t0 = performance.now();
        const clock0 = ctx.currentTime;
        /** Measurable windows, COPIED off the tap's shared buffer. */
        const held: Float32Array[] = [];
        let sampleRate = 0;
        let windows = 0;
        let ticks = 0;
        let lastTickAt = t0;
        let maxTickGapMs = 0;
        let lastAcceptedClock = Number.NEGATIVE_INFINITY;
        let spanSec = 0;

        const finish = (): void => {
          clearInterval(timer);
          const elapsedMs = performance.now() - t0;
          const clockAdvancedSec = ctx.currentTime - clock0;
          const n = held[0]?.length ?? 0;
          const hann = new Float32Array(n);
          for (let i = 0; i < n; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
          const cents = held.map(
            (buf) => 1200 * Math.log2(spectralFundamental(buf, hann, sampleRate) / around),
          );
          resolve({ cents, windows, ticks, elapsedMs, clockAdvancedSec, maxTickGapMs, spanMs: spanSec * 1000 });
        };

        const tick = (): void => {
          const at = performance.now();
          ticks += 1;
          const gap = at - lastTickAt;
          if (gap > maxTickGapMs) maxTickGapMs = gap;
          lastTickAt = at;
          // OBSERVED pacing: the audio clock has moved a whole span since the
          // last accepted read, so the tap now holds a window that shares no
          // frame with it. The tick interval is never what accepts a window.
          const now = ctx.currentTime;
          if (now - lastAcceptedClock >= spanSec) {
            const snap = eng.read(node, 'outputSnapshot') as
              | { samples: Float32Array; sampleRate: number }
              | undefined;
            if (snap && snap.samples.length >= 1024) {
              // One analyser span + one render quantum (128 frames).
              spanSec = (snap.samples.length + 128) / snap.sampleRate;
              sampleRate = snap.sampleRate;
              lastAcceptedClock = now;
              windows += 1;
              // Measurable = not too quiet to mean anything (the RMS floor the
              // Node-side estimator used). The copy is the whole per-tick cost.
              let energy = 0;
              for (let i = 0; i < snap.samples.length; i++) energy += snap.samples[i]! * snap.samples[i]!;
              if (Math.sqrt(energy / snap.samples.length) >= 0.002) held.push(snap.samples.slice());
            }
          }
          if (held.length >= want) {
            finish();
            return;
          }
          if (at - t0 >= capMs) finish();
        };

        const timer = setInterval(tick, tickMs);
        tick();
      });
    },
    { id: outNodeId, around: aroundHz, want: PITCH_WINDOWS, capMs: PITCH_CAP_MS, tickMs: PITCH_TICK_MS },
  );
}

test.beforeEach(async ({ page }) => {
  // Idle the video-engine rAF loop: this spec asserts wiring + AUDIO, never pixels.
  await installRenderSmokeHooks(page);
});

test('WIRING — a lane drop patches clip pitch1→pitch_cv and gate1→trig, and out→mixer ch1 (both legs)', async ({ page, errorWatch }) => {
  test.setTimeout(90_000);
  const sl = await dropSamsloopInLane1(page);
  await expect
    .poll(async () => (await wcolEdges(page)).includes(`${PINNED_CLIP}.pitch1->${sl}.pitch_cv`), {
      timeout: 10_000,
      message: 'the owner sentence: the clip PITCH is auto-patched to pitch_cv',
    })
    .toBe(true);
  const edges = await wcolEdges(page);
  expect(edges).toContain(`${PINNED_CLIP}.pitch1->${sl}.pitch_cv`);
  expect(edges).toContain(`${PINNED_CLIP}.gate1->${sl}.trig`);
  expect(edges).toContain(`${sl}.out->${PINNED_MIXER}.ch1L`);
  expect(edges).toContain(`${sl}.out->${PINNED_MIXER}.ch1R`);
  // NEGATIVE: the additive rate_cv is never the clip's pitch target.
  expect(edges.some((e) => e.endsWith(`->${sl}.rate_cv`)), 'rate_cv must not be clip-wired').toBe(false);
  errorWatch.assertClean();
});

for (const note of NOTES) {
  test(`${note.name} (MIDI ${note.midi}) on the lane plays the 220 Hz loop at ${note.hz.toFixed(2)} Hz — ${note.why}`, async ({ page, errorWatch }) => {
    test.setTimeout(90_000);
    const sl = await dropSamsloopInLane1(page);
    await loadSine(page, sl);
    await starveMainThread(page);
    await addScopeOn(page, sl);
    await seedAndRun(page, 0, note.midi);

    // LIVENESS FIRST — observe UNTIL audible, the cap bounds the failure. For
    // C3 this is where an additive law dies: knob 1 + (−1 V) = 0 = frozen.
    const live = await readScopePeakOverWindow(page, 'sc', AUDIBLE_CAP_MS, { untilPeak: AUDIBLE_FLOOR });
    expect(
      live.peak,
      `the lane samsloop must SOUND at ${note.name} — ${describeScopeWindow(live)}`,
    ).toBeGreaterThan(AUDIBLE_FLOOR);

    // Then the pitch: MEDIAN spectral fundamental over the terminal tap —
    // gathered in the page, one window per analyser span OF THE AUDIO CLOCK.
    const m = await measureTerminalCents(page, PINNED_OUT, note.hz);
    const vitals =
      `${m.cents.length} measurable of ${m.windows} windows read, ticks=${m.ticks}, ` +
      `elapsed=${m.elapsedMs.toFixed(0)}ms, audio clock +${m.clockAdvancedSec.toFixed(2)}s, ` +
      `span=${m.spanMs.toFixed(1)}ms, maxTickGap=${m.maxTickGapMs.toFixed(0)}ms`;
    expect(m.windows, `the terminal tap was polled — ${vitals}`).toBeGreaterThan(10);
    expect(
      m.cents.length,
      `the real clip→samsloop chain is AUDIBLE at the terminal output (measurable windows) — ${vitals}`,
    ).toBeGreaterThanOrEqual(PITCH_WINDOWS_MIN);
    const cents = m.cents.slice().sort((a, b) => a - b);
    const median = cents[cents.length >> 1]!;
    // The measurement, on the record (the line reporter prints test stdout).
    console.log(
      `[samsloop-clip-lane-pitch] ${note.name} midi=${note.midi} expect=${note.hz.toFixed(2)}Hz ` +
        `median=${median.toFixed(2)}c windows=${cents.length}/${m.windows} ` +
        `iqr=${(cents[(cents.length * 3) >> 2]! - cents[cents.length >> 2]!).toFixed(2)}c ` +
        `liveness.peak=${live.peak.toFixed(3)} after ${live.elapsedMs.toFixed(0)}ms ` +
        `clock+${m.clockAdvancedSec.toFixed(2)}s in ${m.elapsedMs.toFixed(0)}ms`,
    );
    expect(
      Math.abs(median),
      `${note.name} (V = ${((note.midi - 60) / 12).toFixed(3)}): measured ${median.toFixed(2)}¢ off ` +
        `${note.hz.toFixed(2)} Hz (must be ≤ ${TOL_CENTS}¢ — rate × 2^V)`,
    ).toBeLessThanOrEqual(TOL_CENTS);
    errorWatch.assertClean();
  });
}

test('MUST-READ-ZERO — the same lane with the clip running and NO sample loaded is SILENT', async ({ page, errorWatch }) => {
  test.setTimeout(90_000);
  const sl = await dropSamsloopInLane1(page);
  await addScopeOn(page, sl);
  await seedAndRun(page, 0, 72);
  // Deliberately NO `untilPeak`: watch the whole window, because "it never got
  // loud" is only meaningful if we never stopped looking.
  const w = await readScopePeakOverWindow(page, 'sc', SILENCE_WINDOW_MS);
  expect(
    w.peak,
    `an EMPTY samsloop must stay silent under clip pitch + gate — ${describeScopeWindow(w)}`,
  ).toBeLessThan(AUDIBLE_FLOOR);
  errorWatch.assertClean();
});
