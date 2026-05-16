// e2e/tests/coverage-group-2-sources.spec.ts
//
// Group 2 of the module-coverage roadmap (see e2e/MODULE-COVERAGE-PLAN.md):
// audio sources (oscillators + noise). Every audio-source module must
// emit audio at its declared `audio` outputs when given default knob
// values. For modules that need a pitch input, we wire either a
// sequencer (sequencer-driven sources) OR rely on the worklet's
// 0V-pitch fallback (analog VCO defaults to C4 ≈ 261 Hz, wavetable VCO
// likewise).
//
// Covered audio sources:
//   - analogVco, wavetableVco — VA + WT oscillators with default-fallback pitch
//   - noise — free-running white/pink/brown
//   - dx7 — pure-TS FM synth; gate-ping triggers a tone
//   - macrooscillator — Plaits-style; trig + default params yield a tone
//   - vizvco, wavviz, swolevco — extra video-out VCOs (audio side only here)
//   - wavecel — stereo wavetable VCO
//
// We deliberately don't test multiple shape outputs on the analog VCO
// (saw/square/triangle/sine) — that's covered by ART. Here we just
// require ONE declared audio output emits audio.

import { test, expect } from '@playwright/test';
import { spawnPatch, type SpawnNode, type SpawnEdge } from './_helpers';
import { readScopeSnapshot, summarize, runFor } from './_module-coverage-helpers';

test.describe.configure({ mode: 'parallel' });

interface SourceCase {
  /** Module type id. */
  type: string;
  /** Output port id whose audio we'll route through the test scope. */
  outputPort: string;
  /** Default knob values to pass to this source's spawn. */
  params?: Record<string, number>;
  /** If true, wire a sequencer pitch+gate into the source. Used for
   *  modules that don't emit at idle (DX7 has a gate; macrooscillator
   *  has a trig). */
  withSequencer?: boolean;
  /** Optional: alternate input port names if the module doesn't use
   *  the canonical { pitch, gate, trig } names. */
  pitchPort?: string;
  gatePort?: string;
}

const SOURCES: SourceCase[] = [
  // Free-running (no pitch input needed).
  { type: 'noise',         outputPort: 'white', params: { level: 0.6 } },
  // analog VCO at 0V pitch defaults to C4 (261 Hz). Sine output is
  // bandlimited; scope sees the full ~261 Hz sinusoid.
  { type: 'analogVco',     outputPort: 'sine',  params: { tune: 0, fine: 0, pmAmount: 0, fmAmount: 0 } },
  // Wavetable VCO same — 0V pitch -> default frequency.
  { type: 'wavetableVco',  outputPort: 'audio', params: { tune: 0, fine: 0, wavePos: 0.5, fmAmount: 0, pmAmount: 0 } },
  // VIZVCO sister of analog VCO with foldAmount; 0V pitch -> C4.
  { type: 'vizvco',        outputPort: 'sine',  params: { tune: 0, fine: 0, foldAmount: 0 } },
  // WAVVIZ sister of wavetable VCO; 0V pitch -> default.
  { type: 'wavviz',        outputPort: 'audio', params: { tune: 0, fine: 0, wavePos: 0.5, fmAmount: 0, foldAmount: 0 } },
  // SWOLEVCO (Buchla 259-style); `out` is the primary; 0V pitch -> default.
  { type: 'swolevco',      outputPort: 'out',   params: { tune: 0, fine: 0, timbre: 0.3, symmetry: 0.5, fold: 0, ratio: 0 } },
  // WAVECEL stereo wavetable; out_l is the left channel.
  { type: 'wavecel',       outputPort: 'out_l', params: { morph: 0, spread: 1, fold: 0 } },
  // DX7 + MACROOSCILLATOR need a gate/trig to sound. Drive with a fast
  // sequencer so we get pings inside the 500ms test window.
  { type: 'dx7',           outputPort: 'out',   params: { algorithm: 5, voiceCount: 1, level: 0.7, transpose: 0 }, withSequencer: true, gatePort: 'gate', pitchPort: 'pitch_cv' },
  { type: 'macrooscillator', outputPort: 'out', params: { model: 0, note: 0, harmonics: 0.3, timbre: 0.3, morph: 0.5, level: 0.8 }, withSequencer: true, gatePort: 'trig' },
];

for (const src of SOURCES) {
  test(`source ${src.type}: emits audio at ${src.outputPort}`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const nodes: SpawnNode[] = [
      { id: 'src', type: src.type, params: src.params },
      { id: 'scp', type: 'scope',  params: { timeMs: 50 } },
    ];
    const edges: SpawnEdge[] = [
      { id: 'e_src_scp', from: { nodeId: 'src', portId: src.outputPort }, to: { nodeId: 'scp', portId: 'ch1' } },
    ];

    if (src.withSequencer) {
      // 240 BPM = ~63 ms per 16th — get several gate pings inside our
      // 800ms test window so transient envelopes don't fool us.
      nodes.unshift({
        id: 'seq',
        type: 'sequencer',
        params: { bpm: 240, length: 4, isPlaying: 1, gateLength: 0.5 },
      });
      if (src.pitchPort) {
        edges.unshift({
          id: 'e_seq_p',
          from: { nodeId: 'seq', portId: 'pitch' },
          to: { nodeId: 'src', portId: src.pitchPort },
          sourceType: 'pitch',
          targetType: 'cv',
        });
      }
      if (src.gatePort) {
        edges.unshift({
          id: 'e_seq_g',
          from: { nodeId: 'seq', portId: 'gate' },
          to: { nodeId: 'src', portId: src.gatePort },
          sourceType: 'gate',
          targetType: src.gatePort === 'trig' ? 'gate' : 'gate',
        });
      }
    }

    await spawnPatch(page, nodes, edges);

    if (src.withSequencer) {
      // Lay down a few audible steps so the gate/trig fires repeatedly.
      await page.evaluate(() => {
        const w = globalThis as unknown as {
          __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
          __ydoc: { transact: (fn: () => void) => void };
        };
        w.__ydoc.transact(() => {
          const seq = w.__patch.nodes['seq'];
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

    // Give the worklet/DSP a beat to spool up + emit. 800 ms covers
    // wavetable-load times for wavetableVco/wavecel and is enough for
    // several gate cycles when a sequencer is wired.
    await runFor(page, 800);

    const snap = await readScopeSnapshot(page, 'scp');
    expect(snap, `${src.type} scope snapshot`).not.toBeNull();
    const sum = summarize(snap!.ch1);

    expect(
      sum.peak,
      `${src.type} ${src.outputPort} peak (peak=${sum.peak.toFixed(4)}, rms=${sum.rms.toFixed(4)})`,
    ).toBeGreaterThan(0.005);

    expect(
      errors,
      `console/page errors during ${src.type} render: ${errors.join('; ')}`,
    ).toEqual([]);
  });
}

test('integration (Group 2): sequencer drives analogVco + wavetableVco in parallel → mixer → scope', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto('/');
  await page.waitForLoadState('networkidle');

  // Two VCOs in parallel, summed by a Mixer, read by Scope. Both pick
  // up the sequencer's pitch CV — they should produce stepped tones.
  await spawnPatch(
    page,
    [
      { id: 'seq', type: 'sequencer',    params: { bpm: 240, length: 4, isPlaying: 1, gateLength: 0.5 } },
      { id: 'a',   type: 'analogVco',    params: { tune: 0, fine: 0 } },
      { id: 'w',   type: 'wavetableVco', params: { tune: 0, fine: 0, wavePos: 0.3 } },
      { id: 'mix', type: 'mixer' },
      { id: 'scp', type: 'scope',        params: { timeMs: 50 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'seq', portId: 'pitch' }, to: { nodeId: 'a', portId: 'pitch' }, sourceType: 'pitch', targetType: 'pitch' },
      { id: 'e2', from: { nodeId: 'seq', portId: 'pitch' }, to: { nodeId: 'w', portId: 'pitch' }, sourceType: 'pitch', targetType: 'pitch' },
      { id: 'e3', from: { nodeId: 'a',   portId: 'sine'  }, to: { nodeId: 'mix', portId: 'in1' } },
      { id: 'e4', from: { nodeId: 'w',   portId: 'audio' }, to: { nodeId: 'mix', portId: 'in2' } },
      { id: 'e5', from: { nodeId: 'mix', portId: 'audio' }, to: { nodeId: 'scp', portId: 'ch1' } },
    ],
  );

  // Set step pattern.
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const seq = w.__patch.nodes['seq'];
      if (!seq.data) seq.data = {};
      seq.data.steps = [
        { on: true, midi: 60 },
        { on: true, midi: 64 },
        { on: true, midi: 67 },
        { on: true, midi: 72 },
      ];
    });
  });

  await runFor(page, 1000);

  const snap = await readScopeSnapshot(page, 'scp');
  expect(snap).not.toBeNull();
  const sum = summarize(snap!.ch1);

  // Two VCOs summed -> peak should be substantially above one. Use a
  // generous floor (>0.05) — the mixer's default channel gains and
  // master are conservative, so we don't want a tight upper bound.
  expect(
    sum.peak,
    `2x VCO sum peak=${sum.peak.toFixed(4)} rms=${sum.rms.toFixed(4)}`,
  ).toBeGreaterThan(0.05);

  expect(errors, errors.join('; ')).toEqual([]);
});
