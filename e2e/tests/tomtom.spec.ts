// e2e/tests/tomtom.spec.ts
//
// TOM DRUM — REAL-SOURCE-CHAIN e2e (the CLAUDE.md discipline: a per-port
// "edge materializes" assert does NOT count as chain coverage). One test
// drives the full default-mode chain:
//
//   SEQUENCER (internal clock, ON steps) → tomtom.trigger_in
//   tomtom.audio_out → AUDIOOUT.L / R (mono voice into both sides)
//   tomtom.audio_out → SCOPE.ch1 (the _module-coverage-helpers scope tap)
//
// and asserts (1) AUDIBLE RMS at the output via windowed MAX-HOLD
// (readScopePeakOverWindow — flake-safe for percussive/decaying voices: a
// single analyser snapshot can land in the inter-hit gap), and (2) a
// SPECTRAL check that the TOM BAND (the 110 Hz default fundamental + its
// 1.59× overtone region) dominates the high band — real strikes producing
// the tuned membrane, not just "some signal" — measured with windowed
// max-hold Goertzel band energies on the scope's time-domain tap.
//
// This is an audio-only spec — no WebGL/renderer tolerance needed. The
// spectral assert is gated on the SAME captured frames having real energy
// (the RMS liveness assert runs FIRST on the max-hold window, and the
// spectral loop only scores frames above an energy floor), so a CI
// environment where the audio graph genuinely didn't run fails the
// liveness assert loudly rather than passing a vacuous spectral check.
//
// Per-sample tom SHAPE (bend/decay laws, frequency compensation, the
// sonic-range proof) is pinned deterministically in the DSP unit tier
// (packages/dsp/src/lib/tomtom-dsp.test.ts) and the raw audio profile in
// ART (art/scenarios/tomtom/profile.test.ts); this e2e proves the LIVE
// trigger→tom→audible-tuned-membrane chain.

import { test, expect } from './_fixtures';
import { spawnPatch, seedKriaWith, buildKriaMidiData } from './_helpers';
import { readScopePeakOverWindow, readScopeSnapshot } from './_module-coverage-helpers';

test.describe.configure({ mode: 'parallel' });

/** Hann-windowed Goertzel power at `hz` (the kickdrum.spec.ts helper). */
function goertzelPower(buf: ArrayLike<number>, sampleRate: number, hz: number): number {
  const n = buf.length;
  const omega = (2 * Math.PI * hz) / sampleRate;
  const coeff = 2 * Math.cos(omega);
  let q1 = 0;
  let q2 = 0;
  for (let i = 0; i < n; i++) {
    const win = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
    const q0 = coeff * q1 - q2 + (buf[i] as number) * win;
    q2 = q1;
    q1 = q0;
  }
  return q1 * q1 + q2 * q2 - q1 * q2 * coeff;
}

// Band probes: the TOM band (default tune 110 Hz — fundamental incl. its
// bend-sharp attack + the 1.59× overtone at ~175 Hz) vs the high band well
// above the ~300 Hz breath center.
const TOM_BAND_HZ = [80, 95, 110, 130, 160, 200, 240];
const HIGH_BAND_HZ = [1000, 1600, 2400, 3200, 4800, 6400];

test('TOM DRUM real chain: SEQUENCER → trigger_in → AUDIOOUT — audible RMS + tom-band-dominant spectrum', async ({ page, rack, errorWatch }) => {
  await spawnPatch(
    page,
    [
      // The REAL default-mode trigger source: the sequencer's own internal
      // clock (isPlaying=1), not a synthetic gate injection.
      { id: 'a-seq', type: 'kria', position: { x: 60,  y: 60 }, domain: 'audio',
        params: { bpm: 120, running: 1 } },
      { id: 'a-tom', type: 'tomtom',    position: { x: 360, y: 60 }, domain: 'audio',
        params: { level: 0 } }, // shipping defaults otherwise (mid tom, 7 st bend)
      { id: 'a-out', type: 'audioOut',  position: { x: 820, y: 60 }, domain: 'audio',
        params: { master: 0.3 } },
      { id: 'a-scp', type: 'scope',     position: { x: 820, y: 320 }, domain: 'audio',
        params: { timeMs: 200 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'a-seq', portId: 'gate1' },      to: { nodeId: 'a-tom', portId: 'trigger_in' },
        sourceType: 'gate', targetType: 'gate' },
      { id: 'e2', from: { nodeId: 'a-tom', portId: 'audio_out' }, to: { nodeId: 'a-out', portId: 'L' },
        sourceType: 'audio', targetType: 'audio' },
      { id: 'e3', from: { nodeId: 'a-tom', portId: 'audio_out' }, to: { nodeId: 'a-out', portId: 'R' },
        sourceType: 'audio', targetType: 'audio' },
      { id: 'e4', from: { nodeId: 'a-tom', portId: 'audio_out' }, to: { nodeId: 'a-scp', portId: 'ch1' } },
    ],
  );

  const card = page.locator('.svelte-flow__node:has([data-shell-type="tomtom"])');
  await expect(card).toHaveCount(1);
  // The title renders the auto-assigned node name (type-uppercased →
  // "TOMTOM", possibly numbered) or the def label ("tom drum" uppercased).
  await expect(card).toContainText(/TOM ?(TOM|DRUM)/);

  // Seed a few ON steps so the internal clock fires the tom (steps 0 + 2 →
  // one strike every second at BPM 120 / length 4).
  await seedKriaWith(page, 'a-seq', buildKriaMidiData([60, null, 60, null], { duration: 0.25 }));

  // ── 1. AUDIBLE RMS at the output (windowed MAX-HOLD — a strike lands
  // every ~1 s, so a 2.5 s capture always straddles ≥2 attacks; max-hold
  // deterministically observes the loud attack frame regardless of
  // analyser phase). A silent / wire-broken / never-triggered tom never
  // crosses these floors in ANY frame. ──
  const CAPTURE_MS = 2500;
  const hold = await readScopePeakOverWindow(page, 'a-scp', CAPTURE_MS);
  expect(hold.polls, 'SCOPE was polled across the capture window').toBeGreaterThan(0);
  expect(hold.peak).toBeGreaterThan(0.05);
  expect(hold.rms).toBeGreaterThan(0.001);
  expect(hold.nonzeroSamples).toBeGreaterThan(50);

  // ── 2. SPECTRAL: the tom band dominates the high band (windowed
  // max-hold band energies). Only frames with real energy are scored —
  // the liveness assert above already proved audio is available, so
  // requiring scored frames here keeps the spectral claim non-vacuous. ──
  const SPECTRAL_MS = 2500;
  const deadline = Date.now() + SPECTRAL_MS;
  let scored = 0;
  let maxLow = 0;
  let maxHigh = 0;
  let sumLow = 0;
  let sumHigh = 0;
  let bestRatio = 0;
  while (Date.now() < deadline) {
    const snap = await readScopeSnapshot(page, 'a-scp');
    if (snap) {
      const buf = snap.ch1;
      let energy = 0;
      for (let i = 0; i < buf.length; i++) energy += (buf[i] as number) ** 2;
      const rms = Math.sqrt(energy / Math.max(1, buf.length));
      if (rms > 1e-3) {
        let lo = 0;
        for (const hz of TOM_BAND_HZ) lo += goertzelPower(buf, snap.sampleRate, hz);
        let hi = 0;
        for (const hz of HIGH_BAND_HZ) hi += goertzelPower(buf, snap.sampleRate, hz);
        scored++;
        sumLow += lo;
        sumHigh += hi;
        if (lo > maxLow) maxLow = lo;
        if (hi > maxHigh) maxHigh = hi;
        const ratio = lo / Math.max(1e-12, lo + hi);
        if (ratio > bestRatio) bestRatio = ratio;
      }
    }
    await page.waitForTimeout(60);
  }
  expect(scored, 'at least one energetic frame was spectrally scored').toBeGreaterThan(0);
  // The best-observed frame is overwhelmingly the tuned membrane (the
  // 350 ms decay tail between breath transients is nearly pure tom band)…
  expect(bestRatio).toBeGreaterThan(0.8);
  // …and across ALL scored frames the tom band carries more total energy
  // than the high band — "the membrane dominates", not just "exists".
  expect(sumLow).toBeGreaterThan(sumHigh);
  // Max-hold agreement: the loudest tom-band frame beats the loudest
  // high-band frame.
  expect(maxLow).toBeGreaterThan(maxHigh);
});

// ── THE STUCK-STRIKE REGRESSION ─────────────────────────────────────────────
//
// A rack could be SAVED with tomtom's momentary STRIKE pad durable at 1, and
// that state was unrecoverable from inside the app.
//
// How it happened: the pad wrote `setNodeParam(id, 'strike', 1)` on
// pointerdown and 0 on pointerup, so a MOMENTARY action wrote DURABLE state,
// and the release edge is not guaranteed — pointer capture protects a MOVING
// pointer, not a DELETED element, so unmounting the card mid-hold (close the
// dock, delete the module, hide the tab, navigate away) left the 1 behind. It
// then persisted, synced to peers, and survived reload.
//
// Why it was fatal rather than cosmetic: `packages/dsp/src/tomtom.ts` does
// `trig = max(trigger_in[s], strike)` — it ORs the pad and the jack as LEVELS,
// not as edges. With `strike` pinned at 1 the combined trigger is permanently
// HIGH, so the rising-edge detector never fires again and **no external
// sequencer can ever strike the drum**. Save that rack and the module is dead
// for good.
//
// The fix is two-sided; this test covers the half that matters to users who
// ALREADY have such a rack: `AudioEngine.addNode` forces every declared
// `face.momentary` param to REST before the factory sees it
// ($lib/audio/momentary-params), so the persisted press never reaches the
// worklet on ANY arrival route — file load, multiplayer join, duplicate,
// reload, audio restart. (The other half — a press never becoming durable in
// the first place — is pinned in manual-strike-actions.test.ts.)
//
// ⚠ THE PATCH BELOW IS THE CORRUPT STATE ITSELF: `params: { strike: 1 }` is
// exactly what a rack saved mid-press contains. `spawnPatch` seeds the Y.Doc
// and the engine reconciles from it, which is the same path a loaded envelope
// takes — so this is a load-path test, not a simulation of one.
test('a rack SAVED with STRIKE stuck at 1 still responds to trigger_in', async ({ page, rack, errorWatch }) => {
  await spawnPatch(
    page,
    [
      { id: 'b-seq', type: 'kria', position: { x: 60,  y: 60 }, domain: 'audio',
        params: { bpm: 120, running: 1 } },
      // THE BRICKED MODULE, as persisted.
      { id: 'b-tom', type: 'tomtom',    position: { x: 360, y: 60 }, domain: 'audio',
        params: { level: 0, strike: 1 } },
      { id: 'b-scp', type: 'scope',     position: { x: 820, y: 320 }, domain: 'audio',
        params: { timeMs: 200 } },
    ],
    [
      { id: 'f1', from: { nodeId: 'b-seq', portId: 'gate1' },      to: { nodeId: 'b-tom', portId: 'trigger_in' },
        sourceType: 'gate', targetType: 'gate' },
      { id: 'f2', from: { nodeId: 'b-tom', portId: 'audio_out' }, to: { nodeId: 'b-scp', portId: 'ch1' } },
    ],
  );

  await expect(page.locator('.svelte-flow__node:has([data-shell-type="tomtom"])')).toHaveCount(1);

  await seedKriaWith(page, 'b-seq', buildKriaMidiData([60, null, 60, null], { duration: 0.25 }));

  // ⚠⚠ SETTLE FIRST — AND THIS LINE IS THE WHOLE TEST.
  //
  // Without it this test PASSES ON THE BROKEN CODE, and it did: measured
  // 1 passed with the repair disabled in all three layers. The reason is a
  // transient that looks exactly like success. The factory seeds the `strike`
  // AudioParam from `node.params` with `setValueAtTime(1, …)`, and the param's
  // own value before that is 0 — so the worklet's edge detector sees a genuine
  // 0 → 1 rising edge AT SPAWN and fires EXACTLY ONE HIT. After that the OR is
  // pinned high forever and nothing can strike it again. A capture window that
  // opens at spawn therefore records a real drum hit on a permanently-bricked
  // module.
  //
  // (That transient is also why the bug is easy to miss by hand: load the
  // saved rack, hear one thump, conclude the drum works.)
  //
  // Waiting past it means every strike this test can see must have come from
  // the SEQUENCER through `trigger_in`, which is the property under test.
  // Measured with the repair disabled and this settle in place: peak 1.9e-13
  // across 28 polls — silence to thirteen decimal places.
  await page.waitForTimeout(1500);

  // THE ASSERTION. At BPM 120 / length 4 with steps 0 and 2 ON, a strike lands
  // every ~1 s, so a 2.5 s window straddles at least two. Under the bug this is
  // flatly zero for the whole window — the trigger never has a rising edge to
  // detect, because the OR is already high.
  const hold = await readScopePeakOverWindow(page, 'b-scp', 2500);
  expect(hold.polls, 'SCOPE was polled across the capture window').toBeGreaterThan(0);
  expect(
    hold.peak,
    `peak ${hold.peak} over ${hold.polls} polls, measured AFTER the spawn transient — ` +
      `a saved STRIKE:1 must not mask trigger_in`,
  ).toBeGreaterThan(0.05);
  expect(hold.nonzeroSamples).toBeGreaterThan(50);
});
