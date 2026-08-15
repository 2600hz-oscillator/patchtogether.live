// art/scenarios/moog-filterbank/response-model.test.ts
//
// DOES THE FACEPLATE'S RESPONSE MODEL DESCRIBE THE SHIPPING GRAPH?
//
// The 907A and 914 faceplates print three numbers (`peak` / `notch` / `tilt`)
// and a per-section table, and every one of them comes from a PURE arithmetic
// model of the bank's summed transfer function
// ($lib/ui/modules/moog-filterbank-face-model). A model is a claim about the
// audio, so it is checked against the audio: this scenario renders the REAL
// def factory's IMPULSE RESPONSE under node-web-audio-api and compares the
// model's coherent sum against the graph's own magnitude, at the exact
// frequencies the readouts evaluate.
//
// ⚠ WHY AN IMPULSE AND NOT NOISE. The bank is LTI at fixed levels, so its
// impulse response IS its transfer function — one deterministic render, no
// estimator variance, and `|H(f)|` is exact at every probe rather than
// converging to it. The unity leg below is the positive control that the
// measurement reads 0.000 dB when nothing filters.
//
// ⚠ AND IT CARRIES A NEGATIVE CONTROL, because "the model agrees with the
// graph" is worthless from a model that would agree with anything. One level is
// FALSIFIED and the same comparison must go far apart. Without that leg a model
// that ignored its `levels` argument entirely would pass the agreement leg on
// every run (CLAUDE.md: negative-control the instrument, not just the code).
//
// NO BASELINE IS PINNED HERE. This scenario asserts a RELATION between two
// computations of the same quantity, not a waveform, so it has nothing to
// re-pin and cannot go stale. The audio pins for these modules stay where they
// are (art/scenarios/moog914|moog907a/profile.test.ts).

import { describe, expect, it } from 'vitest';
import { OfflineAudioContext } from 'node-web-audio-api';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import {
  MOOG907A_BANK,
  MOOG914_BANK,
  type MoogBank,
  moogBankGrid,
  moogBankResponseDb,
  moogBankSections,
} from '$lib/ui/modules/moog-filterbank-face-model';
import { SAMPLE_RATE } from '../../setup/capture';

const SR = SAMPLE_RATE;
/** 32768 samples ≈ 0.68 s — long enough for the slowest section (Q = 4 at the
 *  914's 100 Hz corner) to ring out below the float noise floor. */
const N = 1 << 15;

async function renderImpulse(
  def: AudioModuleDef,
  params: Record<string, number>,
): Promise<Float32Array> {
  const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: N, sampleRate: SR });
  const node = {
    id: 'response-model',
    type: def.type,
    position: { x: 0, y: 0 },
    params,
  } as unknown as Parameters<typeof def.factory>[1];
  const handle = await def.factory(ctx as unknown as AudioContext, node);
  const buf = ctx.createBuffer(1, N, SR);
  const data = new Float32Array(N);
  data[0] = 1;
  buf.copyToChannel(data, 0);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const inRef = handle.inputs.get('audio')!;
  src.connect(inRef.node, 0, inRef.input);
  handle.outputs.get('audio')!.node.connect(ctx.destination);
  src.start(0);
  return (await ctx.startRendering()).getChannelData(0).slice();
}

/** POSITIVE CONTROL for the instrument: an impulse through a unity gain. */
async function renderUnity(): Promise<Float32Array> {
  const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: N, sampleRate: SR });
  const g = ctx.createGain();
  g.gain.value = 1;
  const buf = ctx.createBuffer(1, N, SR);
  const data = new Float32Array(N);
  data[0] = 1;
  buf.copyToChannel(data, 0);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(g);
  g.connect(ctx.destination);
  src.start(0);
  return (await ctx.startRendering()).getChannelData(0).slice();
}

/** |H(f)| in dB, straight off an impulse response. Units: dB re. unity. */
function measuredDb(h: Float32Array, f: number): number {
  const w = (2 * Math.PI * f) / SR;
  let re = 0;
  let im = 0;
  for (let i = 0; i < h.length; i++) {
    const v = h[i]!;
    if (v === 0) continue;
    re += v * Math.cos(w * i);
    im -= v * Math.sin(w * i);
  }
  return 20 * Math.log10(Math.max(Math.hypot(re, im), 1e-12));
}

function defaultLevels(bank: MoogBank): Record<string, number> {
  return Object.fromEntries(bank.def.params.map((p) => [p.id, p.defaultValue]));
}

const BANKS: readonly [string, MoogBank][] = [
  ['moog914', MOOG914_BANK],
  ['moog907a', MOOG907A_BANK],
];

describe('ART moog fixed filter banks / the faceplate response model vs the real graph', () => {
  it('POSITIVE CONTROL — the instrument reads 0.000 dB through a unity gain', async () => {
    const h = await renderUnity();
    for (const f of [50, 500, 5000, 15000]) {
      expect(measuredDb(h, f), `unity at ${f} Hz, dB`).toBeCloseTo(0, 5);
    }
  });

  for (const [name, bank] of BANKS) {
    it(`${name}: the model's COHERENT sum matches the shipping factory at every readout frequency`, async () => {
      const levels = defaultLevels(bank);
      const h = await renderImpulse(bank.def as AudioModuleDef, levels);
      let worst = 0;
      let worstHz = 0;
      for (const f of moogBankGrid(bank)) {
        const d = Math.abs(measuredDb(h, f) - moogBankResponseDb(bank, levels, f, SR));
        if (d > worst) {
          worst = d;
          worstHz = f;
        }
      }
      expect(
        worst,
        `${name}: worst |model − graph| = ${worst.toExponential(3)} dB at ${worstHz.toFixed(1)} Hz. ` +
          'A gap here means the face is printing numbers about a graph it no longer describes — ' +
          'most likely the Web Audio Q-units split (bandpass reads Q LINEAR, lowpass/highpass ' +
          'read it in DECIBELS) has been "tidied" into one form.',
      ).toBeLessThan(0.01);

      // ⚠ NEGATIVE CONTROL — falsify ONE level and the same comparison must
      // fail loudly. This is the leg that distinguishes a model from a function
      // that ignores its arguments.
      const falsified = { ...levels, band1: 0 };
      let apart = 0;
      for (const f of moogBankGrid(bank)) {
        apart = Math.max(
          apart,
          Math.abs(measuredDb(h, f) - moogBankResponseDb(bank, falsified, f, SR)),
        );
      }
      expect(
        apart,
        `${name}: the model was fed a WRONG level map and still matched the graph to ` +
          `${apart.toFixed(3)} dB — it is not reading its input.`,
      ).toBeGreaterThan(1);
    });

    it(`${name}: every SECTION solo matches its own biquad, including the two end shelves`, async () => {
      // Per-section, so a units error on ONE kind cannot hide inside the sum.
      for (const s of moogBankSections(bank)) {
        const solo = Object.fromEntries(bank.def.params.map((p) => [p.id, p.id === s.id ? 1 : 0]));
        const h = await renderImpulse(bank.def as AudioModuleDef, solo);
        const atCorner = measuredDb(h, s.hz);
        const model = moogBankResponseDb(bank, solo, s.hz, SR);
        expect(atCorner, `${name}.${s.id} at ${s.hz} Hz, dB`).toBeCloseTo(model, 4);
      }
    });

    it(`${name}: the end shelves are RESONANT — Q is read in dB there, not linearly`, async () => {
      // The finding this pin exists for. `FILTERBANK_Q = 4` is documented with a
      // LINEAR-Q argument (a 1/3-octave bandwidth), and the twelve bandpasses do
      // read it linearly. The two shelves do not: a Web Audio lowpass/highpass
      // reads Q in DECIBELS, so the same 4 is +4.00 dB of corner resonance and
      // NOT the +12.04 dB a linear reading predicts. If someone ever "fixes" the
      // shelves to a flat response this goes red rather than silently changing
      // how every rack with a 907A/914 in it sounds.
      for (const s of moogBankSections(bank)) {
        if (s.kind === 'bandpass') continue;
        const solo = Object.fromEntries(bank.def.params.map((p) => [p.id, p.id === s.id ? 1 : 0]));
        const h = await renderImpulse(bank.def as AudioModuleDef, solo);
        expect(
          measuredDb(h, s.hz),
          `${name}.${s.id}: corner gain in dB (linear-Q would predict ` +
            `${(20 * Math.log10(bank.spec.q)).toFixed(2)} dB)`,
        ).toBeCloseTo(bank.spec.q, 2);
      }
    });
  }

  it('the two banks are ONE design: identical section kinds and one shared Q', async () => {
    const kinds = (b: MoogBank) => moogBankSections(b).map((s) => s.kind);
    // The 914 is the 907A with more bandpasses — same shelf pair at the ends.
    expect(kinds(MOOG914_BANK)[0]).toBe('lowpass');
    expect(kinds(MOOG907A_BANK)[0]).toBe('lowpass');
    expect(kinds(MOOG914_BANK).at(-1)).toBe('highpass');
    expect(kinds(MOOG907A_BANK).at(-1)).toBe('highpass');
    expect(MOOG914_BANK.spec.q).toBe(MOOG907A_BANK.spec.q);
    expect(new Set(kinds(MOOG914_BANK).slice(1, -1))).toEqual(new Set(['bandpass']));
    expect(new Set(kinds(MOOG907A_BANK).slice(1, -1))).toEqual(new Set(['bandpass']));
  });
});
