// e2e/tests/adsr-poly-midilane.spec.ts
//
// Bespoke E2E for the per-voice ADSR feature on CUBE / WAVECEL / DX7.
// Validates in the REAL worklet (the pure-fn + worklet-unit tests cover the
// envelope math; this proves the end-to-end audio path):
//   - DX7 master-ADSR swell: a gated note through the master VCA carries audio.
//   - CUBE/WAVECEL mono TRIGGER gates the per-voice envelope (audio opens when
//     the TRIGGER fires).
//   - back-compat: a TRULY-UNPATCHED TRIGGER (no poly either) keeps CUBE/WAVECEL
//     droning as a continuous raw VCO (env idle, base_vol=1 → byte-identical).
//   - no-stray-drone (Bug 1): a TRIGGER patched but NEVER gated (sequencer parked,
//     isPlaying=0) is SILENT — patching poly/trigger puts the module into GATED
//     mode, so a never-gated voice does NOT fall through to the legacy drone.
//   - a poly chord (POLYSEQZ) into `poly` drives the per-voice envelopes → the
//     stereo OUT carries audio.
//
// CI is on a software renderer; audio-capture e2e is slow there, so timeouts
// scale with the number of capture windows rather than a flat value, and we keep
// the capture count modest.
//
// ── THE OBSERVATION WINDOW IS A BOUNDED CONDITION, NOT A FIXED 600 ms ───────
//
// This file went red on PR #1303 e2e shard 1/10 (run 30758889295) with
// `Received: 0` on `cube poly chord`, on the initial attempt AND the retry. It
// was NOT a silent module: the trace shows the "600 ms capture window"
// collapsed to a SINGLE analyser peek on both attempts —
//
//     attempt     ONE readScopeSnapshot     ONE waitForTimeout(60)
//     initial          255 ms                    392 ms      → 647 ms > 600 ms
//     retry #1         325 ms                    393 ms      → 718 ms > 600 ms
//
// — because the old `readScopePeakOverWindow` polled from PLAYWRIGHT, one CDP
// round-trip per sample, on the same starved main thread as the audio graph and
// the step scheduler it was measuring. One 42 ms peek, ~250 ms after the chord
// steps were seeded, and CUBE's poly gating means an un-gated lane is EXACTLY
// 0.0000 — so "not yet sounding" and "silent" printed identically. See the
// block comment on `readScopePeakOverWindow`; the sampler now runs INSIDE the
// page and reports its own vitals.
//
// The tests that ask "does this ever make sound?" therefore observe UNTIL the
// voice is audible, bounded by a cap — the same assertion on every machine,
// where a fixed wall-clock window is a different assertion per runner (the
// CLAUDE.md frames-not-milliseconds argument, in the audio domain: a gated
// voice needs the MAIN-THREAD step scheduler to tick, and how many ticks fit in
// 600 ms is a property of the runner, not of the module). On a healthy machine
// they return in well under the old 600 ms, so this SAVES CI wall time.
//
// ── THIS FILE NEGATIVE-CONTROLS ITS OWN INSTRUMENT, ON EVERY RUN ────────────
//
// Both directions are permanent legs here rather than one-off authoring-time
// checks, so the sampler is re-validated by every run of this spec:
//
//   * MUST-READ-NONZERO — `cube back-compat` drives a free-running drone with
//     nothing patched to poly/trigger. No gate, no scheduler, no envelope: the
//     signal is unconditionally present. If the sampler ever stops seeing audio
//     that is there, that test goes RED.
//   * MUST-READ-ZERO — `cube no-stray-drone` patches a TRIGGER that never fires
//     and asserts SILENCE over the FULL window (deliberately no `untilPeak`).
//     If the sampler ever manufactures signal, or the early-exit leaks into a
//     silence assertion, that test goes RED.
//
// And `readScopePeakOverWindow` itself throws when it took ZERO samples, so
// "the instrument never looked" can no longer print as "the module is silent".

import { test, expect } from './_fixtures';
import { spawnPatch, seedKriaGate } from './_helpers';
import { readScopePeakOverWindow, describeScopeWindow } from './_module-coverage-helpers';

test.describe.configure({ mode: 'parallel' });

/** Full-window observation for the SILENCE assertion — no early exit, because
 *  "it never got loud" is only meaningful if we watched the whole time. */
const SILENCE_WINDOW_MS = 600;

/** CAP on the "wait until audible" observation. BOUNDS THE FAILURE; it is NOT
 *  the gate — a sounding voice ends the window the moment it crosses the floor,
 *  typically in a couple of hundred ms. Sized for a contended CI shard where a
 *  main-thread step scheduler can stall for most of a second at a time (the
 *  trace above measured a single `waitForTimeout(60)` taking 392 ms). */
const AUDIBLE_CAP_MS = 8_000;

/** The audible floor every "does it make sound?" assertion in this file uses.
 *  Shared so the wait target and the assertion can never drift apart. */
const AUDIBLE_FLOOR = 0.01;

function timeoutFor(captureWindows: number): number {
  return 30_000 + captureWindows * 12_000;
}

/** Seed a SEQUENCER with always-on C4 steps so its gate fires every step. */
async function seedSeqSteps(page: import('@playwright/test').Page, seqId: string): Promise<void> {
  await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const t = w.__patch.nodes[id];
      if (!t) return;
      if (!t.data) t.data = {};
      (t.data as Record<string, unknown>).steps = Array.from({ length: 32 }, () => ({ on: true, midi: 60, chord: 'mono' }));
    });
  }, seqId);
}

test('dx7 master-ADSR: a gated poly note carries audio through the master VCA', async ({ page, rack, errorWatch }) => {
  test.setTimeout(timeoutFor(1));


  // Drive DX7 via the poly bus (the proven dx7.spec path): SEQUENCER.pitch →
  // DX7.poly, with seeded always-on steps so a gate fires every step. Each gate
  // rising edge fires noteOn → the master VCA shapes the voice on top of the
  // operator EGs. A slow master attack + held sustain keeps the OUT alive.
  await spawnPatch(
    page,
    [
      { id: 'seq', type: 'kria', position: { x: 40, y: 60 }, domain: 'audio', params: { bpm: 240, running: 1} },
      { id: 'dx', type: 'dx7', position: { x: 360, y: 60 }, domain: 'audio', params: { algorithm: 5, voiceCount: 5, attack: 0.05, decay: 0.2, sustain: 0.9, release: 0.3, level: 1 } },
      { id: 'sc', type: 'scope', position: { x: 900, y: 60 }, domain: 'audio', params: { timeMs: 50 } },
    ],
    [
      { id: 'e_seq_clk', from: { nodeId: 'seq-clk', portId: 'gate1' }, to: { nodeId: 'seq', portId: 'clock' }, sourceType: 'gate', targetType: 'gate' },
      { id: 'e_seq_dx', from: { nodeId: 'seq', portId: 'pitch' }, to: { nodeId: 'dx', portId: 'poly' }, sourceType: 'polyPitchGate', targetType: 'polyPitchGate' },
      { id: 'e_dx_sc',  from: { nodeId: 'dx', portId: 'out' },    to: { nodeId: 'sc', portId: 'ch1' },  sourceType: 'audio', targetType: 'audio' },
    ],
  );

  // Seed always-on steps so the sequencer's gate fires (default steps may be off).
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const t = w.__patch.nodes['seq'];
      if (!t) return;
      if (!t.data) t.data = {};
      (t.data as Record<string, unknown>).steps = Array.from({ length: 32 }, () => ({ on: true, midi: 60, chord: 'mono' }));
    });
  });

  const w = await readScopePeakOverWindow(page, 'sc', AUDIBLE_CAP_MS, {
    untilPeak: AUDIBLE_FLOOR,
  });
  expect(
    w.peak,
    `DX7 OUT should carry audio when gated (master ADSR open) — ${describeScopeWindow(w)}`,
  ).toBeGreaterThan(AUDIBLE_FLOOR);
});

test('cube mono TRIGGER gates the per-voice envelope (audio opens on trigger)', async ({ page, rack, errorWatch }) => {
  test.setTimeout(timeoutFor(1));


  await spawnPatch(
    page,
    [
      { id: 'seq', type: 'kria', position: { x: 40, y: 60 }, domain: 'audio', params: { bpm: 240, running: 1} },
      { id: 'cb', type: 'cube', position: { x: 360, y: 60 }, domain: 'audio', params: { attack: 0.02, decay: 0.1, sustain: 0.9, release: 0.2, level: 1 } },
      { id: 'sc', type: 'scope', position: { x: 900, y: 60 }, domain: 'audio', params: { timeMs: 50 } },
    ],
    [
      { id: 'e_seq_cb', from: { nodeId: 'seq', portId: 'gate' }, to: { nodeId: 'cb', portId: 'trigger' }, sourceType: 'gate', targetType: 'gate' },
      { id: 'e_cb_sc', from: { nodeId: 'cb', portId: 'L' }, to: { nodeId: 'sc', portId: 'ch1' }, sourceType: 'audio', targetType: 'audio' },
    ],
  );
  await seedSeqSteps(page, 'seq');

  const w = await readScopePeakOverWindow(page, 'sc', AUDIBLE_CAP_MS, {
    untilPeak: AUDIBLE_FLOOR,
  });
  expect(
    w.peak,
    `CUBE L should carry audio when the TRIGGER gate fires — ${describeScopeWindow(w)}`,
  ).toBeGreaterThan(AUDIBLE_FLOOR);
});

test('cube back-compat: an unpatched TRIGGER keeps CUBE droning (env skipped)', async ({ page, rack, errorWatch }) => {
  test.setTimeout(timeoutFor(1));


  // CUBE with NOTHING patched to TRIGGER (and no poly) → free-running drone.
  await spawnPatch(
    page,
    [
      { id: 'cb', type: 'cube', position: { x: 360, y: 60 }, domain: 'audio', params: { level: 1 } },
      { id: 'sc', type: 'scope', position: { x: 900, y: 60 }, domain: 'audio', params: { timeMs: 50 } },
    ],
    [
      { id: 'e_cb_sc', from: { nodeId: 'cb', portId: 'L' }, to: { nodeId: 'sc', portId: 'ch1' }, sourceType: 'audio', targetType: 'audio' },
    ],
  );

  // PERMANENT NEGATIVE CONTROL, must-read-NONZERO direction: an unconditional
  // drone — no gate, no scheduler, no envelope. If the sampler ever goes blind
  // to audio that is genuinely present, this is the test that says so.
  const w = await readScopePeakOverWindow(page, 'sc', AUDIBLE_CAP_MS, {
    untilPeak: AUDIBLE_FLOOR,
  });
  expect(
    w.peak,
    `CUBE must keep droning with no TRIGGER patched (legacy free-run) — ${describeScopeWindow(w)}`,
  ).toBeGreaterThan(AUDIBLE_FLOOR);
});

test('cube no-stray-drone: a TRIGGER patched but NEVER gated is SILENT (gated, not droning)', async ({ page, rack, errorWatch }) => {
  test.setTimeout(timeoutFor(1));


  // TRIGGER patched from a sequencer that is NOT playing (gate stays 0) → the
  // gate is PATCHED but NEVER goes high. Per the no-stray-drone fix, a patched
  // TRIGGER puts CUBE into GATED mode: a voice sounds only while gated-or-
  // releasing, so a never-gated TRIGGER is SILENT (it does NOT fall through to
  // the legacy drone — that was the bug). The continuous raw VCO is only the
  // truly-unpatched case (covered by the back-compat test above).
  await spawnPatch(
    page,
    [
      { id: 'seq', type: 'kria', position: { x: 40, y: 60 }, domain: 'audio', params: { bpm: 240, running: 0} },
      { id: 'cb', type: 'cube', position: { x: 360, y: 60 }, domain: 'audio', params: { level: 1 } },
      { id: 'sc', type: 'scope', position: { x: 900, y: 60 }, domain: 'audio', params: { timeMs: 50 } },
    ],
    [
      { id: 'e_seq_cb', from: { nodeId: 'seq', portId: 'gate' }, to: { nodeId: 'cb', portId: 'trigger' }, sourceType: 'gate', targetType: 'gate' },
      { id: 'e_cb_sc', from: { nodeId: 'cb', portId: 'L' }, to: { nodeId: 'sc', portId: 'ch1' }, sourceType: 'audio', targetType: 'audio' },
    ],
  );

  // PERMANENT NEGATIVE CONTROL, must-read-ZERO direction: the FULL window, no
  // `untilPeak` (an early exit has no meaning for an assertion of silence, and
  // omitting it here also proves the early exit cannot leak into one). If the
  // sampler ever manufactures signal, this is the test that says so.
  const w = await readScopePeakOverWindow(page, 'sc', SILENCE_WINDOW_MS);
  expect(
    w.peak,
    `a patched-but-never-gated TRIGGER must keep CUBE SILENT (no stray drone) — ${describeScopeWindow(w)}`,
  ).toBeLessThan(AUDIBLE_FLOOR);
});

test('wavecel mono TRIGGER gates the per-voice envelope (audio opens on trigger)', async ({ page, rack, errorWatch }) => {
  test.setTimeout(timeoutFor(1));


  await spawnPatch(
    page,
    [
      { id: 'seq', type: 'kria', position: { x: 40, y: 60 }, domain: 'audio', params: { bpm: 240, running: 1} },
      { id: 'wc', type: 'wavecel', position: { x: 360, y: 60 }, domain: 'audio', params: { attack: 0.02, decay: 0.1, sustain: 0.9, release: 0.2 } },
      { id: 'sc', type: 'scope', position: { x: 900, y: 60 }, domain: 'audio', params: { timeMs: 50 } },
    ],
    [
      { id: 'e_seq_wc', from: { nodeId: 'seq', portId: 'gate' }, to: { nodeId: 'wc', portId: 'trigger' }, sourceType: 'gate', targetType: 'gate' },
      { id: 'e_wc_sc', from: { nodeId: 'wc', portId: 'out_l' }, to: { nodeId: 'sc', portId: 'ch1' }, sourceType: 'audio', targetType: 'audio' },
    ],
  );
  await seedSeqSteps(page, 'seq');

  const w = await readScopePeakOverWindow(page, 'sc', AUDIBLE_CAP_MS, {
    untilPeak: AUDIBLE_FLOOR,
  });
  expect(
    w.peak,
    `WAVECEL out_l should carry audio when the TRIGGER gate fires — ${describeScopeWindow(w)}`,
  ).toBeGreaterThan(AUDIBLE_FLOOR);
});

test('cube poly chord (POLYSEQZ → poly) drives the per-voice envelopes', async ({ page, rack, errorWatch }) => {
  test.setTimeout(timeoutFor(1));


  await spawnPatch(
    page,
    [
      { id: 'seq-clk', type: 'kria', position: { x: 40, y: 440 }, domain: 'audio', params: { bpm: 240, running: 1 } },
      { id: 'seq', type: 'cartesian', position: { x: 40, y: 60 }, domain: 'audio' },
      { id: 'cb', type: 'cube', position: { x: 360, y: 60 }, domain: 'audio', params: { attack: 0.02, decay: 0.1, sustain: 0.9, release: 0.2, level: 1 } },
      { id: 'sc', type: 'scope', position: { x: 900, y: 60 }, domain: 'audio', params: { timeMs: 50 } },
    ],
    [
      { id: 'e_seq_cb', from: { nodeId: 'seq', portId: 'pitch' }, to: { nodeId: 'cb', portId: 'poly' }, sourceType: 'polyPitchGate', targetType: 'polyPitchGate' },
      { id: 'e_cb_sc', from: { nodeId: 'cb', portId: 'L' }, to: { nodeId: 'sc', portId: 'ch1' }, sourceType: 'audio', targetType: 'audio' },
    ],
  );

  // Seed a gated chord so multiple voices play (each lane drives its own env).
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes['seq'];
      if (!n) return;
      if (!n.data) n.data = {};
      n.data.cells = Array.from({ length: 16 }, (_, i) => [
          { on: true, midi: 60, chord: 'maj' },
          { on: true, midi: 64, chord: 'min' },
          { on: true, midi: 67, chord: 'maj' },
          { on: true, midi: 72, chord: 'maj' },
        ][i % 4]);
    });
  });
    await seedKriaGate(page, 'seq-clk');

  // THE REGRESSION THIS FILE'S REWRITE EXISTS FOR. CUBE's poly gating makes an
  // un-gated lane contribute EXACTLY 0.0000 (packages/dsp/src/cube.ts — the
  // no-stray-drone rule), and POLYSEQZ's first gated chord cannot reach the
  // audio thread until the MAIN-THREAD step scheduler ticks past its 200 ms
  // lookahead with the freshly-seeded steps. Observing for a fixed 600 ms of
  // Playwright wall clock asked a question whose answer depended on the
  // runner's load; observing UNTIL audible, bounded, asks the module.
  const w = await readScopePeakOverWindow(page, 'sc', AUDIBLE_CAP_MS, {
    untilPeak: AUDIBLE_FLOOR,
  });
  expect(
    w.peak,
    `CUBE L should carry audio when a poly chord gates the voices — ${describeScopeWindow(w)}`,
  ).toBeGreaterThan(AUDIBLE_FLOOR);
});
