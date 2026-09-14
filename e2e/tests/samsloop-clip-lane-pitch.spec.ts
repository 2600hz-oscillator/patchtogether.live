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
// the same 6 ¢ real-chain tolerance. The scope is added to the patch IN PLACE
// (a Y.Doc transact, never `spawnPatch`, which clears the rack and with it the
// pinned trio this spec exists to drive).

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

/** Hann-windowed Goertzel magnitude at `f` (voice-pitch-accuracy.spec.ts). */
function goertzelMag(buf: Float32Array, f: number, sr: number): number {
  const coeff = 2 * Math.cos((2 * Math.PI * f) / sr);
  const n = buf.length;
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    const s0 = buf[i]! * hann + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - coeff * s1 * s2));
}

/** Peak of |X(f)| within ±6 % of `around` — coarse 1 Hz sweep, then a 0.02 Hz
 *  refinement. Null when the window is too quiet to mean anything. */
function spectralFundamental(buf: Float32Array, sr: number, around: number): number | null {
  let energy = 0;
  for (let i = 0; i < buf.length; i++) energy += buf[i]! * buf[i]!;
  if (Math.sqrt(energy / buf.length) < 0.002) return null;
  const lo = around * 0.94;
  const hi = around * 1.06;
  let best = around;
  let bestMag = -1;
  for (let f = lo; f <= hi; f += 1) {
    const m = goertzelMag(buf, f, sr);
    if (m > bestMag) { bestMag = m; best = f; }
  }
  const fineLo = Math.max(lo, best - 1.5);
  const fineHi = Math.min(hi, best + 1.5);
  for (let f = fineLo; f <= fineHi; f += 0.02) {
    const m = goertzelMag(buf, f, sr);
    if (m > bestMag) { bestMag = m; best = f; }
  }
  return best;
}

/** One terminal analyser snapshot off AUDIO OUT (the limiter tap). */
async function readOutputSnapshot(
  page: Page,
  outNodeId: string,
): Promise<{ samples: number[]; sampleRate: number } | null> {
  return page.evaluate((id) => {
    const w = globalThis as unknown as {
      __engine?: () => { read: (n: unknown, k: string) => unknown } | null;
      __patch: { nodes: Record<string, unknown> };
    };
    const eng = w.__engine?.();
    const node = w.__patch.nodes[id];
    if (!eng || !node) return null;
    const snap = eng.read(node, 'outputSnapshot') as { samples: Float32Array; sampleRate: number } | undefined;
    if (!snap) return null;
    return { samples: Array.from(snap.samples), sampleRate: snap.sampleRate };
  }, outNodeId);
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
    await addScopeOn(page, sl);
    await seedAndRun(page, 0, note.midi);

    // LIVENESS FIRST — observe UNTIL audible, the cap bounds the failure. For
    // C3 this is where an additive law dies: knob 1 + (−1 V) = 0 = frozen.
    const live = await readScopePeakOverWindow(page, 'sc', AUDIBLE_CAP_MS, { untilPeak: AUDIBLE_FLOOR });
    expect(
      live.peak,
      `the lane samsloop must SOUND at ${note.name} — ${describeScopeWindow(live)}`,
    ).toBeGreaterThan(AUDIBLE_FLOOR);

    // Then the pitch: MEDIAN spectral fundamental over the terminal tap.
    const cents: number[] = [];
    let polled = 0;
    const deadline = Date.now() + 12_000;
    while (cents.length < 30 && Date.now() < deadline) {
      const snap = await readOutputSnapshot(page, PINNED_OUT);
      polled += 1;
      if (snap && snap.samples.length >= 1024) {
        const hz = spectralFundamental(new Float32Array(snap.samples), snap.sampleRate, note.hz);
        if (hz != null) cents.push(1200 * Math.log2(hz / note.hz));
      }
      await page.waitForTimeout(90); // > the 2048-sample analyser span — fresh window each poll
    }
    expect(polled, 'the terminal tap was polled').toBeGreaterThan(10);
    expect(cents.length, `the real clip→samsloop chain is AUDIBLE at the terminal output (measurable windows)`)
      .toBeGreaterThanOrEqual(12);
    cents.sort((a, b) => a - b);
    const median = cents[cents.length >> 1]!;
    // The measurement, on the record (the line reporter prints test stdout).
    console.log(
      `[samsloop-clip-lane-pitch] ${note.name} midi=${note.midi} expect=${note.hz.toFixed(2)}Hz ` +
        `median=${median.toFixed(2)}c windows=${cents.length}/${polled} ` +
        `iqr=${(cents[(cents.length * 3) >> 2]! - cents[cents.length >> 2]!).toFixed(2)}c ` +
        `liveness.peak=${live.peak.toFixed(3)} after ${live.elapsedMs.toFixed(0)}ms`,
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
