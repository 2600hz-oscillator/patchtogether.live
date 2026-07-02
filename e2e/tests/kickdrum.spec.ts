// e2e/tests/kickdrum.spec.ts
//
// KICK DRUM — REAL-SOURCE-CHAIN e2e (the poly/MIDI-adjacent discipline from
// CLAUDE.md: a per-port "edge materializes" assert does NOT count as chain
// coverage). One test drives the full default-mode chain:
//
//   SEQUENCER (internal clock, ON steps) → kickdrum.trigger_in
//   kickdrum.audio_l / audio_r → AUDIOOUT.L / R
//   kickdrum.audio_l → SCOPE.ch1 (the _module-coverage-helpers scope tap)
//
// and asserts (1) AUDIBLE RMS at the output via windowed MAX-HOLD
// (readScopePeakOverWindow — flake-safe for percussive/decaying voices: a
// single analyser snapshot can land in the inter-hit gap), and (2) a
// SPECTRAL check that the <120 Hz band DOMINATES the voice — the "deep sub"
// claim of the build plan (.myrobots/plans/kick-drum-voice-2026-07-01.md §6),
// measured with windowed max-hold Goertzel band energies on the scope's
// time-domain tap.
//
// AUDIO-AVAILABILITY GATING (plan adversarial-review resolution 5): this is
// an audio-only spec — no WebGL/renderer tolerance needed. The spectral
// assert is gated on the SAME captured frames having real energy (the RMS
// liveness assert runs FIRST on the max-hold window, and the spectral loop
// only scores frames above an energy floor), so a CI environment where the
// audio graph genuinely didn't run fails the liveness assert loudly rather
// than passing a vacuous spectral check.
//
// Per-sample kick SHAPE (decay laws, strike determinism, sr-calibration) is
// pinned deterministically in the DSP unit tier
// (packages/dsp/src/lib/kickdrum-dsp.test.ts) and the raw audio profile in
// ART (art/scenarios/kickdrum/profile.test.ts); this e2e proves the LIVE
// trigger→kick→audible-deep-sub chain.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { readScopePeakOverWindow, readScopeSnapshot } from './_module-coverage-helpers';

test.describe.configure({ mode: 'parallel' });

/** Hann-windowed Goertzel power at `hz` (the analog-vco-fm-sync helper). */
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

// Band probes: SUB band (<120 Hz — where the tuned fundamental at 50 Hz and
// the settled body at ~100 Hz live) vs everything meaningfully above it.
const LOW_BAND_HZ = [30, 45, 60, 75, 90, 105];
const HIGH_BAND_HZ = [200, 300, 500, 800, 1600, 3200, 4800];

test('KICK DRUM real chain: SEQUENCER → trigger_in → stereo AUDIOOUT — audible RMS + sub-dominant spectrum', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await spawnPatch(
    page,
    [
      // The REAL default-mode trigger source: the sequencer's own internal
      // clock (isPlaying=1), not a synthetic gate injection.
      { id: 'a-seq', type: 'sequencer', position: { x: 60,  y: 60 }, domain: 'audio',
        params: { bpm: 120, length: 4, isPlaying: 1, gateLength: 0.25 } },
      { id: 'a-kd',  type: 'kickdrum',  position: { x: 360, y: 60 }, domain: 'audio',
        params: { level: 0 } }, // shipping defaults otherwise (clean-deep kick)
      { id: 'a-out', type: 'audioOut',  position: { x: 820, y: 60 }, domain: 'audio',
        params: { master: 0.3 } },
      { id: 'a-scp', type: 'scope',     position: { x: 820, y: 320 }, domain: 'audio',
        params: { timeMs: 200 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'a-seq', portId: 'gate' },    to: { nodeId: 'a-kd',  portId: 'trigger_in' },
        sourceType: 'gate', targetType: 'gate' },
      { id: 'e2', from: { nodeId: 'a-kd',  portId: 'audio_l' }, to: { nodeId: 'a-out', portId: 'L' },
        sourceType: 'audio', targetType: 'audio' },
      { id: 'e3', from: { nodeId: 'a-kd',  portId: 'audio_r' }, to: { nodeId: 'a-out', portId: 'R' },
        sourceType: 'audio', targetType: 'audio' },
      { id: 'e4', from: { nodeId: 'a-kd',  portId: 'audio_l' }, to: { nodeId: 'a-scp', portId: 'ch1' } },
    ],
  );

  const card = page.locator('.svelte-flow__node-kickdrum');
  await expect(card).toHaveCount(1);
  // The title renders the auto-assigned node name (type-uppercased →
  // "KICKDRUM", possibly numbered) or the def label ("kick drum" uppercased).
  await expect(card).toContainText(/KICK ?DRUM/);

  // Seed a few ON steps so the internal clock fires the kick (steps 0 + 2 →
  // one strike every second at BPM 120 / length 4).
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const seq = w.__patch.nodes['a-seq'];
      if (!seq.data) seq.data = {};
      seq.data.steps = [
        { on: true, midi: 60 },
        { on: false, midi: null },
        { on: true, midi: 60 },
        { on: false, midi: null },
        ...Array.from({ length: 28 }, () => ({ on: false, midi: null })),
      ];
    });
  });

  // ── 1. AUDIBLE RMS at the output (windowed MAX-HOLD — a strike lands
  // every ~1 s, so a 2.5 s capture always straddles ≥2 attacks; max-hold
  // deterministically observes the loud attack frame regardless of
  // analyser phase). A silent / wire-broken / never-triggered kick never
  // crosses these floors in ANY frame. ──
  const CAPTURE_MS = 2500;
  const hold = await readScopePeakOverWindow(page, 'a-scp', CAPTURE_MS);
  expect(hold.polls, 'SCOPE was polled across the capture window').toBeGreaterThan(0);
  expect(hold.peak).toBeGreaterThan(0.05);
  expect(hold.rms).toBeGreaterThan(0.001);
  expect(hold.nonzeroSamples).toBeGreaterThan(50);

  // ── 2. SPECTRAL: the <120 Hz band dominates (windowed max-hold band
  // energies). Only frames with real energy are scored — the liveness
  // assert above already proved audio is available, so requiring scored
  // frames here keeps the spectral claim non-vacuous. ──
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
        for (const hz of LOW_BAND_HZ) lo += goertzelPower(buf, snap.sampleRate, hz);
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
  // The best-observed frame is overwhelmingly sub (the long 450 ms sub tail
  // between body transients is nearly pure <120 Hz energy)…
  expect(bestRatio).toBeGreaterThan(0.85);
  // …and across ALL scored frames the sub band carries more total energy
  // than everything above it — "<120 Hz dominates", not just "exists".
  expect(sumLow).toBeGreaterThan(sumHigh);
  // Max-hold agreement: the loudest sub frame beats the loudest high frame.
  expect(maxLow).toBeGreaterThan(maxHigh);

  expect(errors, `console/page errors: ${errors.join('; ')}`).toEqual([]);
});
