// e2e/tests/sixstrum-poly.spec.ts
//
// Bespoke E2E for SIX STRUM — proves the end-to-end audio path in the REAL
// worklet (the pure-fn core + worklet-unit tests cover the DSP; this is the
// mandatory poly-module real-source-chain coverage per CLAUDE.md: a real graph
// SOURCE → the module → audible RMS at OUT; an engine-direct/behavioral test
// does NOT satisfy it — POLYHELM #674 shipped green-but-silent that way):
//   - POLY: a SEQUENCER chord bus into `poly` plucks the strings → OUT carries
//     audio (the 6-lane poly path the 16-lane bus exists for).
//   - STRUM: a self-clocking gate into `strum1` barres all six strings
//     (normalled #1→all) → OUT carries audio.
//
// CI is a software renderer; audio-capture e2e is slow there, so timeouts scale
// with the number of capture windows and the capture count stays modest.

import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';
import { readScopePeakOverWindow } from './_module-coverage-helpers';

test.describe.configure({ mode: 'parallel' });

const CAPTURE_MS = 600;
function timeoutFor(captureWindows: number): number {
  return 30_000 + captureWindows * 8_000;
}

/** Seed a SEQUENCER with always-on C4 steps so a gate fires every step. */
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

test('sixstrum POLY: a SEQUENCER chord into `poly` plucks the strings → OUT carries audio', async ({ page, rack, errorWatch }) => {
  test.setTimeout(timeoutFor(1));

  // SEQUENCER.pitch (a real default-mode polyPitchGate source) → SIX STRUM.poly.
  // Each step's gate rising edge is a poly note-on → the mapped string plucks.
  await spawnPatch(
    page,
    [
      { id: 'seq', type: 'sequencer', position: { x: 40, y: 60 }, domain: 'audio', params: { bpm: 240, length: 4, isPlaying: 1 } },
      { id: 'ss', type: 'sixstrum', position: { x: 360, y: 60 }, domain: 'audio', params: { ring: 3, level: 6 } },
      { id: 'sc', type: 'scope', position: { x: 900, y: 60 }, domain: 'audio', params: { timeMs: 50 } },
    ],
    [
      { id: 'e_seq_ss', from: { nodeId: 'seq', portId: 'pitch' }, to: { nodeId: 'ss', portId: 'poly' }, sourceType: 'polyPitchGate', targetType: 'polyPitchGate' },
      { id: 'e_ss_sc',  from: { nodeId: 'ss', portId: 'out' },    to: { nodeId: 'sc', portId: 'ch1' },  sourceType: 'audio', targetType: 'audio' },
    ],
  );
  await seedSeqSteps(page, 'seq');

  const { peak } = await readScopePeakOverWindow(page, 'sc', CAPTURE_MS);
  expect(peak, 'SIX STRUM OUT should carry audio when a poly chord plucks the strings').toBeGreaterThan(0.01);
});

test('sixstrum STRUM: a gate into `strum1` barres all six strings → OUT carries audio', async ({ page, rack, errorWatch }) => {
  test.setTimeout(timeoutFor(1));

  // SEQUENCER.gate is the registry's self-clocking gate source; each rising
  // edge into strum1 strums the whole (normalled) chord → OUT carries audio.
  await spawnPatch(
    page,
    [
      { id: 'seq', type: 'sequencer', position: { x: 40, y: 60 }, domain: 'audio', params: { bpm: 240, length: 4, isPlaying: 1 } },
      { id: 'ss', type: 'sixstrum', position: { x: 360, y: 60 }, domain: 'audio', params: { ring: 3, level: 6 } },
      { id: 'sc', type: 'scope', position: { x: 900, y: 60 }, domain: 'audio', params: { timeMs: 50 } },
    ],
    [
      { id: 'e_seq_ss', from: { nodeId: 'seq', portId: 'gate' }, to: { nodeId: 'ss', portId: 'strum1' }, sourceType: 'gate', targetType: 'gate' },
      { id: 'e_ss_sc',  from: { nodeId: 'ss', portId: 'out' },   to: { nodeId: 'sc', portId: 'ch1' },    sourceType: 'audio', targetType: 'audio' },
    ],
  );
  await seedSeqSteps(page, 'seq');

  const { peak } = await readScopePeakOverWindow(page, 'sc', CAPTURE_MS);
  expect(peak, 'SIX STRUM OUT should carry audio when strum1 barres the strings').toBeGreaterThan(0.01);
});
