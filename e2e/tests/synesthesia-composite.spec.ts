// e2e/tests/synesthesia-composite.spec.ts
//
// Composite signal-flow coverage for SYNESTHESIA in a LIVE patch — the
// "real audio reaches the right band" proof that the per-port sweep defers
// here (synesthesia is in EXEMPT_OUTPUT_EMIT_MODULES because its outputs are
// input-conditional).
//
// Scenario A — single VCO sweep (the env-gated trigger path):
//   analogVco → vca ; sequencer → adsr → vca(cv) ; seq pitch → vco pitch ;
//   vca → scope + synesthesia.
//   For each fundamental we assert the matching MUSICAL band (1–4) is the
//   most-energized VU band on copy A, and SCOPE sees the source frequency.
//
//   FREQUENCY COMES FROM THE SEQUENCER'S V/OCT PITCH, NOT the `tune` knob.
//   analogVco's `tune` is a Faust hslider hard-clamped to ±36 semitones
//   (max = C4·2^3 = 2093 Hz), so the band-4 edge (4 kHz+) is UNREACHABLE via
//   tune alone — a `tune:54` request silently clamps to 36 → 2093 Hz, which
//   lands in band 3 and flips the strict-max assertion (the original shard-10
//   failure). The 1 V/oct `pitch` input has the VCO's full range (final freq
//   only clamps at 20 kHz), so we set the per-step MIDI note to place each
//   fundamental where we want it; a small `tune` offset fine-tunes band 4.
//
//   Each fundamental sits in the LOWER HALF of its band so the sine's
//   (non-trivial) 2nd HARMONIC (2·f) stays INSIDE the same band rather than
//   landing in — and lighting — the band above (f < upperEdge/2 ⇒ 2f <
//   upperEdge). Band 4 has no band above it, so its harmonics stay in-band by
//   construction.
//
// Scenario B — two VCOs into a mixer:
//   vco1@~130 (tune) + vco2@~5920 (seq V/oct pitch) → vca's → mixer →
//   synesthesia. Assert bands 1 AND 4 are the two lit bands; bands 2 & 3 stay
//   quiet. vco2 is driven by a (gate-less) sequencer's pitch for the same
//   tune-ceiling reason as Scenario A.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch, type SpawnNode, type SpawnEdge } from './_helpers';
import { readScopePeakOverWindow, setNodeParams, runFor } from './_module-coverage-helpers';

// Frequency is set by the sequencer's V/oct pitch (per-step MIDI note), with an
// optional `tune` offset (semitones, ±36). MIDI 60 = C4 = 261.63 Hz = 0 V/oct.
// MUSICAL bands: b1 20–200, b2 200–1k, b3 1k–4k, b4 4k+. Each fundamental is in
// the lower half of its band so its 2nd harmonic stays in-band (see header).
const TONES = [
  { freq: 65, midi: 36, tune: 0, band: 1, idx: 0 }, //  C2 ≈65    → b1; 2f=131 still b1
  { freq: 349, midi: 65, tune: 0, band: 2, idx: 1 }, //  F4 ≈349   → b2; 2f=698 still b2
  { freq: 1397, midi: 89, tune: 0, band: 3, idx: 2 }, // F6 ≈1397 → b3; 2f=2794 still b3
  { freq: 5920, midi: 108, tune: 6, band: 4, idx: 3 }, // C8+6 ≈5920 → b4 (4k+; no band above)
] as const;

/** Read SYNESTHESIA's VU snapshot ({levelsA, levelsB}) via the dev engine hook. */
async function readSynLevels(
  page: Page,
  nodeId: string,
): Promise<{ levelsA: number[]; levelsB: number[] } | null> {
  return page.evaluate((id) => {
    const w = globalThis as unknown as {
      __engine?: () => { read: (n: unknown, k: string) => unknown } | null;
      __patch: { nodes: Record<string, unknown> };
    };
    const eng = w.__engine?.();
    if (!eng) return null;
    const node = w.__patch.nodes[id];
    if (!node) return null;
    const snap = eng.read(node, 'snapshot') as
      | { levelsA: number[]; levelsB: number[] }
      | undefined;
    if (!snap) return null;
    return { levelsA: Array.from(snap.levelsA), levelsB: Array.from(snap.levelsB) };
  }, nodeId);
}

/** Poll the snapshot over `ms`, returning the per-band MAX copy-A level. The
 *  env-gated source pulses, so max-hold is robust to where the poll lands. */
async function maxBandLevels(page: Page, nodeId: string, ms: number): Promise<number[]> {
  const deadline = Date.now() + ms;
  const max = [0, 0, 0, 0];
  while (Date.now() < deadline) {
    const s = await readSynLevels(page, nodeId);
    if (s) for (let i = 0; i < 4; i++) max[i] = Math.max(max[i]!, s.levelsA[i] ?? 0);
    await page.waitForTimeout(60);
  }
  return max;
}

/** Start a sequencer: set all-on steps at `midi` + play, so its gate output
 *  pulses and its V/oct pitch output holds the note (drives the VCO pitch). */
async function startSequencer(page: Page, seqId: string, midi = 60): Promise<void> {
  await page.evaluate(({ id, midi }) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const seq = w.__patch.nodes[id];
      if (!seq.data) seq.data = {};
      seq.data.steps = Array.from({ length: 4 }, () => ({ on: true, midi }));
    });
  }, { id: seqId, midi });
}

test.describe('SYNESTHESIA composite — correct bands trigger from a live patch', () => {
  for (const { freq, midi, tune, band, idx } of TONES) {
    test(`${freq} Hz (VCO→VCA←ADSR←SEQ) lights band ${band} @audio`, async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));

      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const nodes: SpawnNode[] = [
        { id: 'seq', type: 'sequencer', position: { x: 40, y: 40 }, domain: 'audio',
          params: { bpm: 120, length: 4, gateLength: 0.9, isPlaying: 1 } },
        { id: 'vco', type: 'analogVco', position: { x: 40, y: 360 }, domain: 'audio',
          params: { tune } },
        { id: 'adsr', type: 'adsr', position: { x: 320, y: 40 }, domain: 'audio',
          params: { attack: 0.005, decay: 0.25, sustain: 0.9, release: 0.2 } },
        { id: 'vca', type: 'vca', position: { x: 320, y: 360 }, domain: 'audio',
          params: { base: 0, cvAmount: 1 } },
        { id: 'scp', type: 'scope', position: { x: 600, y: 40 }, domain: 'audio' },
        { id: 'syn', type: 'synesthesia', position: { x: 600, y: 360 }, domain: 'audio' },
      ];
      const edges: SpawnEdge[] = [
        { id: 'e_seq_adsr', from: { nodeId: 'seq', portId: 'gate' }, to: { nodeId: 'adsr', portId: 'gate' }, sourceType: 'gate', targetType: 'gate' },
        // V/oct pitch sets the fundamental (the `tune` knob caps at 2093 Hz —
        // see header). MIDI 60 = C4 = 0 V; the per-step note picks the band.
        { id: 'e_seq_pitch', from: { nodeId: 'seq', portId: 'pitch' }, to: { nodeId: 'vco', portId: 'pitch' }, sourceType: 'pitch', targetType: 'pitch' },
        { id: 'e_adsr_vca', from: { nodeId: 'adsr', portId: 'env' }, to: { nodeId: 'vca', portId: 'cv' }, sourceType: 'cv', targetType: 'cv' },
        { id: 'e_vco_vca', from: { nodeId: 'vco', portId: 'sine' }, to: { nodeId: 'vca', portId: 'audio' }, sourceType: 'audio', targetType: 'audio' },
        { id: 'e_vca_scp', from: { nodeId: 'vca', portId: 'audio' }, to: { nodeId: 'scp', portId: 'ch1' }, sourceType: 'audio', targetType: 'audio' },
        { id: 'e_vca_syn', from: { nodeId: 'vca', portId: 'audio' }, to: { nodeId: 'syn', portId: 'a_in' }, sourceType: 'audio', targetType: 'audio' },
      ];
      await spawnPatch(page, nodes, edges);
      await startSequencer(page, 'seq', midi);
      await runFor(page, 400); // let the gate train + envelope ramp up

      const levels = await maxBandLevels(page, 'syn', 1500);
      const max = Math.max(...levels);
      // The matching band is the most-energized VU band on copy A.
      expect(levels[idx], `bands=${levels.map((v) => v.toFixed(3)).join(',')}`).toBe(max);
      expect(levels[idx]!).toBeGreaterThan(0.02); // actually lit, not noise floor

      // SCOPE sees the source frequency (the gated VCO).
      const scope = await readScopePeakOverWindow(page, 'scp', 600);
      expect(scope.peak, 'scope sees the source tone').toBeGreaterThan(0.01);

      expect(errors.filter((e) => !e.includes('AudioContext'))).toEqual([]);
    });
  }

  test('two VCOs (130 + 5920 Hz) → mixer → synesthesia light bands 1 & 4', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // vco2 reaches band 4 via the seq's V/oct pitch (MIDI 108 = C8) + a small
    // tune offset — the `tune` knob alone caps at 2093 Hz (band 3). See header.
    const nodes: SpawnNode[] = [
      { id: 'seq', type: 'sequencer', position: { x: 40, y: 520 }, domain: 'audio',
        params: { bpm: 120, length: 4, gateLength: 0.9, isPlaying: 1 } },
      { id: 'vco1', type: 'analogVco', position: { x: 40, y: 40 }, domain: 'audio', params: { tune: -12 } }, // C3 ≈130 → band 1
      { id: 'vco2', type: 'analogVco', position: { x: 40, y: 280 }, domain: 'audio', params: { tune: 6 } }, // C8+6 ≈5920 → band 4
      { id: 'vca1', type: 'vca', position: { x: 300, y: 40 }, domain: 'audio', params: { base: 1, cvAmount: 0 } },
      { id: 'vca2', type: 'vca', position: { x: 300, y: 280 }, domain: 'audio', params: { base: 1, cvAmount: 0 } },
      { id: 'mix', type: 'mixer', position: { x: 560, y: 160 }, domain: 'audio' },
      { id: 'syn', type: 'synesthesia', position: { x: 820, y: 160 }, domain: 'audio' },
    ];
    const edges: SpawnEdge[] = [
      // seq V/oct pitch → vco2 (vco1 stays on its tune knob in band 1).
      { id: 'e_seq_v2', from: { nodeId: 'seq', portId: 'pitch' }, to: { nodeId: 'vco2', portId: 'pitch' }, sourceType: 'pitch', targetType: 'pitch' },
      { id: 'e_v1_a1', from: { nodeId: 'vco1', portId: 'sine' }, to: { nodeId: 'vca1', portId: 'audio' }, sourceType: 'audio', targetType: 'audio' },
      { id: 'e_v2_a2', from: { nodeId: 'vco2', portId: 'sine' }, to: { nodeId: 'vca2', portId: 'audio' }, sourceType: 'audio', targetType: 'audio' },
      { id: 'e_a1_mix', from: { nodeId: 'vca1', portId: 'audio' }, to: { nodeId: 'mix', portId: 'in1' }, sourceType: 'audio', targetType: 'audio' },
      { id: 'e_a2_mix', from: { nodeId: 'vca2', portId: 'audio' }, to: { nodeId: 'mix', portId: 'in2' }, sourceType: 'audio', targetType: 'audio' },
      { id: 'e_mix_syn', from: { nodeId: 'mix', portId: 'audio' }, to: { nodeId: 'syn', portId: 'a_in' }, sourceType: 'audio', targetType: 'audio' },
    ];
    await spawnPatch(page, nodes, edges);
    await startSequencer(page, 'seq', 108); // C8 V/oct → vco2 into band 4
    await runFor(page, 400);

    const levels = await maxBandLevels(page, 'syn', 1200);
    // The two most-energized bands are band 1 and band 4.
    const top2 = levels
      .map((v, i) => [v, i] as [number, number])
      .sort((a, b) => b[0] - a[0])
      .slice(0, 2)
      .map((x) => x[1])
      .sort((a, b) => a - b);
    expect(top2, `bands=${levels.map((v) => v.toFixed(3)).join(',')}`).toEqual([0, 3]);
    expect(Math.min(levels[0]!, levels[3]!)).toBeGreaterThan(0.02);

    expect(errors.filter((e) => !e.includes('AudioContext'))).toEqual([]);
  });
});
