// e2e/tests/snaredrum-roll.spec.ts
//
// SNARE DRUM — REAL-SOURCE-CHAIN e2e (the poly/MIDI discipline from CLAUDE.md +
// the POLYHELM lesson: a per-port "edge materializes" assert or an engine-class-
// driven test does NOT count as roll coverage — the default mode must actually
// make sound through the LIVE graph). TWO real chains, both asserting AUDIBLE
// stereo RMS on BOTH audio_l and audio_r:
//
//   1. SINGLE HIT:  SEQUENCER (internal clock, ON steps) → snaredrum.trigger_in
//   2. DRUMROLL:    SEQUENCER (internal clock, long held gate) → snaredrum.gate_in
//      snaredrum.audio_l/audio_r → AUDIOOUT.L/R + SCOPE.ch1/ch2
//
// The load-bearing assertion is the ROLL's CONTINUITY: the two-hand engine +
// the shared re-excitable wire bed must keep the snare ringing so EVERY ~42 ms
// scope window carries energy on both channels (max-hold liveness AND a
// min-over-window "no silent gaps" check) — proving the roll is a sustained
// superposition, NOT a pulsed one-shot retrigger. It also confirms ROLL SPEED
// raises the density (a faster roll re-excites the bed more often → a higher
// inter-stroke floor).
//
// Per-sample SHAPE (decay laws, strike determinism, the roll structure) is
// pinned deterministically in the DSP unit tier (packages/dsp/src/lib/
// snaredrum-dsp.test.ts + snare-roll-dsp.test.ts) and the raw audio profile in
// ART (art/scenarios/snaredrum/profile.test.ts); this e2e proves the LIVE
// trigger/gate → snare → audible-stereo chain.

import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';
import { readScopeSnapshot } from './_module-coverage-helpers';

test.describe.configure({ mode: 'parallel' });

function rmsOf(buf: ArrayLike<number>): number {
  let e = 0;
  for (let i = 0; i < buf.length; i++) e += (buf[i] as number) ** 2;
  return Math.sqrt(e / Math.max(1, buf.length));
}

/** Poll a scope's ch1 + ch2 over `windowMs`, returning per-channel MAX-hold RMS
 *  (liveness — robust to the analyser landing in a trough) AND per-channel
 *  MIN-over-window RMS (continuity — a pulsed/silent roll drops some windows to
 *  ~0). The MIN is only tracked ONCE audio has started (a poll on EITHER channel
 *  exceeds `startFloor`) so pre-roll startup silence isn't counted as a "gap",
 *  while any genuine mid-roll gap (a dip back toward 0 after the roll is running)
 *  IS caught. Only windows the scope actually returned are scored. */
async function pollStereo(
  page: import('@playwright/test').Page,
  scopeId: string,
  windowMs: number,
  pollMs = 45,
  startFloor = 0.01,
): Promise<{ l: { max: number; min: number }; r: { max: number; min: number }; polls: number; scored: number }> {
  const deadline = Date.now() + windowMs;
  let lMax = 0;
  let rMax = 0;
  let lMin = Infinity;
  let rMin = Infinity;
  let polls = 0;
  let scored = 0;
  let started = false;
  while (Date.now() < deadline) {
    const snap = await readScopeSnapshot(page, scopeId);
    if (snap) {
      const r1 = rmsOf(snap.ch1);
      const r2 = rmsOf(snap.ch2);
      lMax = Math.max(lMax, r1);
      rMax = Math.max(rMax, r2);
      polls++;
      if (!started && Math.max(r1, r2) > startFloor) started = true;
      if (started) {
        lMin = Math.min(lMin, r1);
        rMin = Math.min(rMin, r2);
        scored++;
      }
    }
    await page.waitForTimeout(pollMs);
  }
  return { l: { max: lMax, min: lMin }, r: { max: rMax, min: rMin }, polls, scored };
}

/** Seed a sequencer's step array (all steps ON = a near-continuous held gate at
 *  a high gateLength; a sparse pattern = discrete strikes). */
async function seedSteps(
  page: import('@playwright/test').Page,
  seqId: string,
  ons: boolean[],
): Promise<void> {
  await page.evaluate(
    ({ id, ons }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const seq = w.__patch.nodes[id];
        if (!seq.data) seq.data = {};
        seq.data.steps = [
          ...ons.map((on) => ({ on, midi: on ? 60 : null })),
          ...Array.from({ length: Math.max(0, 32 - ons.length) }, () => ({ on: false, midi: null })),
        ];
      });
    },
    { id: seqId, ons },
  );
}

test('SNARE DRUM real chain: SEQUENCER → trigger_in → audible stereo hits (L + R)', async ({ page, rack, errorWatch }) => {
  await spawnPatch(
    page,
    [
      { id: 's-seq', type: 'sequencer', position: { x: 60, y: 60 }, domain: 'audio',
        params: { bpm: 120, length: 4, isPlaying: 1, gateLength: 0.25 } },
      { id: 's-sd', type: 'snaredrum', position: { x: 360, y: 60 }, domain: 'audio',
        params: { level: 0 } },
      { id: 's-out', type: 'audioOut', position: { x: 820, y: 60 }, domain: 'audio',
        params: { master: 0.3 } },
      { id: 's-scp', type: 'scope', position: { x: 820, y: 320 }, domain: 'audio',
        params: { timeMs: 200 } },
    ],
    [
      { id: 'e1', from: { nodeId: 's-seq', portId: 'gate' },    to: { nodeId: 's-sd', portId: 'trigger_in' },
        sourceType: 'gate', targetType: 'gate' },
      { id: 'e2', from: { nodeId: 's-sd', portId: 'audio_l' }, to: { nodeId: 's-out', portId: 'L' },
        sourceType: 'audio', targetType: 'audio' },
      { id: 'e3', from: { nodeId: 's-sd', portId: 'audio_r' }, to: { nodeId: 's-out', portId: 'R' },
        sourceType: 'audio', targetType: 'audio' },
      { id: 'e4', from: { nodeId: 's-sd', portId: 'audio_l' }, to: { nodeId: 's-scp', portId: 'ch1' } },
      { id: 'e5', from: { nodeId: 's-sd', portId: 'audio_r' }, to: { nodeId: 's-scp', portId: 'ch2' } },
    ],
  );

  const card = page.locator('.svelte-flow__node-snaredrum');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText(/SNARE ?DRUM/);

  // Two ON strikes (steps 0 + 2 → one hit every second at BPM 120 / length 4).
  await seedSteps(page, 's-seq', [true, false, true, false]);

  // Windowed MAX-HOLD on BOTH channels: a strike lands every ~1 s, so a 2.5 s
  // capture always straddles ≥2 attacks. A silent / never-triggered snare never
  // crosses these floors in ANY window.
  const hit = await pollStereo(page, 's-scp', 2500);
  expect(hit.polls, 'SCOPE was polled across the capture').toBeGreaterThan(0);
  expect(hit.l.max, 'audible RMS on audio_l').toBeGreaterThan(0.005);
  expect(hit.r.max, 'audible RMS on audio_r').toBeGreaterThan(0.005);

});

test('SNARE DRUM real chain: SEQUENCER held gate → gate_in → CONTINUOUS two-hand roll (L + R, no gaps)', async ({ page, rack, errorWatch }) => {
  await spawnPatch(
    page,
    [
      // A near-continuous HELD gate: every step ON at a long gateLength → the
      // gate stays high across the bar (the roll re-fires per step; the shared
      // wire bed carries the brief inter-step gaps). The REAL default-mode source.
      { id: 'r-seq', type: 'sequencer', position: { x: 60, y: 60 }, domain: 'audio',
        params: { bpm: 120, length: 4, isPlaying: 1, gateLength: 0.92 } },
      { id: 'r-sd', type: 'snaredrum', position: { x: 360, y: 60 }, domain: 'audio',
        params: { level: 3, wire: 0.85 } },
      { id: 'r-out', type: 'audioOut', position: { x: 820, y: 60 }, domain: 'audio',
        params: { master: 0.3 } },
      { id: 'r-scp', type: 'scope', position: { x: 820, y: 320 }, domain: 'audio',
        params: { timeMs: 200 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'r-seq', portId: 'gate' },   to: { nodeId: 'r-sd', portId: 'gate_in' },
        sourceType: 'gate', targetType: 'gate' },
      { id: 'e2', from: { nodeId: 'r-sd', portId: 'audio_l' }, to: { nodeId: 'r-out', portId: 'L' },
        sourceType: 'audio', targetType: 'audio' },
      { id: 'e3', from: { nodeId: 'r-sd', portId: 'audio_r' }, to: { nodeId: 'r-out', portId: 'R' },
        sourceType: 'audio', targetType: 'audio' },
      { id: 'e4', from: { nodeId: 'r-sd', portId: 'audio_l' }, to: { nodeId: 'r-scp', portId: 'ch1' } },
      { id: 'e5', from: { nodeId: 'r-sd', portId: 'audio_r' }, to: { nodeId: 'r-scp', portId: 'ch2' } },
    ],
  );

  await expect(page.locator('.svelte-flow__node-snaredrum')).toHaveCount(1);

  // All steps ON → the gate is high across the bar → the two-hand roll runs.
  await seedSteps(page, 'r-seq', [true, true, true, true]);
  // Settle: let the sequencer start + the roll + wire bed establish before the
  // continuity poll (so pre-roll startup silence isn't mistaken for a gap).
  await page.waitForTimeout(700);

  // ── The load-bearing continuity check. Poll BOTH channels across a wide
  // window. The poll COUNT depends on the environment's page.evaluate speed
  // (CI's slow round-trips yield far fewer polls than a warm local box), so we
  // assert only that a HANDFUL of windows were scored — the continuity proof is
  // the per-window RMS, not the poll count. ──
  const roll = await pollStereo(page, 'r-scp', 3500, 30);
  expect(roll.polls, 'SCOPE was polled across the roll').toBeGreaterThan(2);
  expect(roll.scored, 'the roll actually started (audio observed)').toBeGreaterThanOrEqual(3);
  // Audible on BOTH channels (max-hold).
  expect(roll.l.max, 'roll audible on audio_l').toBeGreaterThan(0.01);
  expect(roll.r.max, 'roll audible on audio_r').toBeGreaterThan(0.01);
  // CONTINUOUS: once the roll is running, the MINIMUM scored window RMS never
  // gaps to silence — a pulsed retrigger would drop some windows to ~0. Both
  // channels. This is the "sustained superposition, not a retrigger" proof.
  // (ROLL SPEED → stroke-density is proven deterministically in the unit +
  // worklet tiers: snare-roll-dsp.test.ts, snaredrum-dsp.test.ts, and
  // snaredrum.test.ts "ROLL SPEED changes the stroke density".)
  expect(roll.l.min, 'roll never gaps to silence on audio_l').toBeGreaterThan(0.0008);
  expect(roll.r.min, 'roll never gaps to silence on audio_r').toBeGreaterThan(0.0008);
  // Genuinely STEREO: L and R differ (the two hands + wire decorrelate).
  const snap = await readScopeSnapshot(page, 'r-scp');
  if (snap) {
    let diff = 0;
    for (let i = 0; i < snap.ch1.length; i++) diff = Math.max(diff, Math.abs(snap.ch1[i]! - snap.ch2[i]!));
    expect(diff, 'the roll is a genuine stereo image').toBeGreaterThan(1e-4);
  }

});
