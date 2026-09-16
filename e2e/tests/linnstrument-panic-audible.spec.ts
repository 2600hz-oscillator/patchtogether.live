// ═════════ PANIC vs A LATCHED ARP — AT THE REAL CUBE AUDIO OUTPUT ═════════
//
// The audible half of the 2026-09-15 review's F01 (contracts: R03 in
// packages/web/src/lib/midi/linnstrument-review-contracts.test.ts). The chain
// is the module's real default-mode source chain (AGENTS.md rule 8):
//
//   [simulated LinnStrument, User Firmware Mode bytes on the wire]
//     → connectLinnstrument() → decodePhysicalMidi → mapSurface → registry
//     → linnstrument runtime (arp, latch) → keys_poly → CUBE.poly → CUBE.L → SCOPE
//
// THE DEFECT IT PINS. With the keys arp ON and HOLD (latch) ON, one key is
// pressed and RELEASED: the arp keeps walking the latched pool with no voice
// alive. PANIC from the control column (the D17 recommendation's bottom cell)
// then reached `arp.cancel()`, which cleared the playing marker and the step
// clock but KEPT the latched pool; `panicMpe` had no live voice to end; and the
// next scheduler tick re-anchored the clock and played the note again. Three
// runs read a post-PANIC peak of 0.9998 / RMS 0.635 against a 0.01 floor.
//
// WHAT IS ASSERTED, IN ORDER
//   * NEGATIVE CONTROL first, over a full window: the patched chain is silent
//     before any device exists;
//   * POSITIVE CONTROL: the latched arp is audible after the finger has lifted
//     (`active.keys` 0, `arp.keys.running` true — the real latch precondition);
//   * PANIC: one full window absorbs CUBE's declared 0.2 s release tail and
//     the analyser ring, then a SECOND 1.2 s window — long enough for several
//     125 ms arp steps — must stay under the floor (sample twice, assert on
//     the second). The runtime snapshot is logged with the readings.
//
// ⚠ FILENAME: `linnstrument-panic-audible.spec.ts` matches none of
// e2e/webgl-heavy-globs.ts, so it runs in the sharded `e2e` matrix. A name
// colliding with one of those prefixes would remove it from CI entirely.

import { test, expect } from './_fixtures';
import { type Page } from '@playwright/test';
import { spawnPatch, type SpawnNode, type SpawnEdge } from './_helpers';
import { readScopePeakOverWindow, describeScopeWindow } from './_module-coverage-helpers';
import { sampleScopeRms } from '../_helpers/scope-poll';
import {
  AUDIBLE_CAP_MS,
  CONTROL_COL,
  CUBE_FLOOR,
  KEY_A,
  PANIC_ROW,
  SILENCE_WINDOW_MS,
  cellNote,
  installSim,
  linnState,
  sim,
  timeoutFor,
} from './_linnstrument-helpers';

test.describe.configure({ mode: 'parallel' });

// ── THE KEYS CHAIN: linnstrument.keys_poly → CUBE.poly → SCOPE ────────────
async function buildKeysChain(page: Page, linnParams: Record<string, number> = {}): Promise<void> {
  const nodes: SpawnNode[] = [
    { id: 'ln', type: 'linnstrument', position: { x: 60, y: 60 }, domain: 'audio', params: linnParams },
    // The adsr-poly-midilane CUBE: a fast per-voice envelope, high sustain, so a
    // held key is a held tone and a released key decays in 0.2 s.
    { id: 'cb', type: 'cube', position: { x: 420, y: 60 }, domain: 'audio', params: { attack: 0.02, decay: 0.1, sustain: 0.9, release: 0.2, level: 1 } },
    { id: 'scp', type: 'scope', position: { x: 900, y: 60 }, domain: 'audio', params: { timeMs: 50 } },
  ];
  const edges: SpawnEdge[] = [
    { id: 'e-poly', from: { nodeId: 'ln', portId: 'keys_poly' }, to: { nodeId: 'cb', portId: 'poly' }, sourceType: 'polyPitchGate', targetType: 'polyPitchGate' },
    { id: 'e-out', from: { nodeId: 'cb', portId: 'L' }, to: { nodeId: 'scp', portId: 'ch1' }, sourceType: 'audio', targetType: 'audio' },
  ];
  await spawnPatch(page, nodes, edges);
  await expect(page.locator('.svelte-flow__node:has([data-shell-type="linnstrument"])')).toHaveCount(1);
}

test('@linnstrument PANIC stops a released, latched arp note at the real CUBE audio output', async ({ page, rack, errorWatch }) => {
  void rack;
  test.setTimeout(timeoutFor(6));
  await buildKeysChain(page, { keys_arp_on: 1, keys_arp_latch: 1, keys_arp_div: 1 });
  // NEGATIVE CONTROL, full window: nothing exists yet, the chain is silent.
  const empty = await readScopePeakOverWindow(page, 'scp', SILENCE_WINDOW_MS);
  expect(empty.polls, 'the SCOPE was actually sampled').toBeGreaterThan(0);
  expect(empty.peak, describeScopeWindow(empty)).toBeLessThan(CUBE_FLOOR);
  expect(await installSim(page)).toBe(true);
  await sim(page, 'ackUserMode', true);
  await expect.poll(() => linnState(page, 'ln').then((s) => s?.session.userMode)).toBe(true);
  // POSITIVE CONTROL: press, and the latched arp is audible AFTER the release —
  // no live voice, the arp running on a frozen pool (the real latch precondition).
  await sim(page, 'touch', KEY_A.col, KEY_A.row, { x: 500 });
  const positive = await readScopePeakOverWindow(page, 'scp', AUDIBLE_CAP_MS, { untilRms: CUBE_FLOOR, untilNonzeroSamples: 50 });
  expect(positive.rms, describeScopeWindow(positive)).toBeGreaterThan(CUBE_FLOOR);
  await sim(page, 'release', KEY_A.col, KEY_A.row);
  await expect.poll(() => linnState(page, 'ln').then((s) => s?.active.keys)).toBe(0);
  expect((await linnState(page, 'ln'))?.arp.keys, 'released, latched, still walking').toMatchObject({ running: true, params: { latch: true }, held: [], effective: [cellNote(KEY_A.col, KEY_A.row)] });
  const stillPlaying = await readScopePeakOverWindow(page, 'scp', AUDIBLE_CAP_MS, { untilRms: CUBE_FLOOR, untilNonzeroSamples: 50 });
  expect(stillPlaying.rms, `the latched note sounds with no finger down — ${describeScopeWindow(stillPlaying)}`).toBeGreaterThan(CUBE_FLOOR);

  // PANIC from the control column: the wire → control_edge → the reducer's
  // panic effect → the runtime. The STATE half first: the arp has forgotten
  // its pool, so no later tick has anything to play (F01's mechanism).
  await sim(page, 'touch', CONTROL_COL, PANIC_ROW);
  await sim(page, 'release', CONTROL_COL, PANIC_ROW);
  const afterPanic = await linnState(page, 'ln');
  expect(afterPanic?.arp.keys, 'PANIC forgets the latched pool').toMatchObject({ running: false, held: [], effective: [], playing: null });
  expect(afterPanic?.active.keys).toBe(0);

  // THE AUDIBLE HALF — a bounded condition, then a full window (the sibling
  // spec's settledSilence shape). CUBE's gate closes NOW but its per-voice
  // envelope rings out: the release is an exponential TIME CONSTANT
  // (adsr-env.ts `value *= exp(-1 / (sr * release))`), so 0.2 s reaches the
  // 0.01 floor only after ~4.5τ ≈ 0.9 s plus the analyser ring — measured
  // here as 0.61 → 0.16 → 0.018 → 0.0006 over consecutive 200 ms polls, and
  // ~0.06 peak still standing a full 600 ms window after PANIC. A fixed
  // absorption window therefore cannot tell a tail from a restart; this can:
  // a restarted arp NEVER reaches the floor and fails at the cap, a stuck gate
  // (sustain 0.9) never reaches it either, only a closing gate does. Then the
  // SECOND window — 1.2 s, nearly ten 125 ms arp steps — must stay under the
  // floor (sample twice, assert on the second).
  const settling: number[] = [];
  await expect
    .poll(
      async () => {
        const hi = (await sampleScopeRms(page, 'scp', 10, 20)).hi;
        settling.push(hi);
        return hi;
      },
      { timeout: AUDIBLE_CAP_MS, message: 'PANIC — the output must reach silence within the cap (a restarted arp never does)' },
    )
    .toBeLessThan(CUBE_FLOOR);
  const after = await readScopePeakOverWindow(page, 'scp', 1200);
  console.log('PANIC_AUDIO', JSON.stringify({ empty, positive, stillPlaying, settling: settling.map((v) => +v.toFixed(4)), after, state: await linnState(page, 'ln') }));
  expect(after.polls, 'the SCOPE was sampled across the whole post-PANIC window').toBeGreaterThan(0);
  expect(after.peak, `PANIC must STAY silent through further arp ticks: ${describeScopeWindow(after)}`).toBeLessThan(CUBE_FLOOR);
  expect((await linnState(page, 'ln'))?.arp.keys, 'and the arp is still stopped at the end of the window').toMatchObject({ running: false, effective: [] });
  errorWatch.assertClean();
});
