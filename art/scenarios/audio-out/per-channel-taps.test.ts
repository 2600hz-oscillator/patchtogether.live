// art/scenarios/audio-out/per-channel-taps.test.ts
//
// THE INSTRUMENT, NOT THE MODULE. audio-out's `read('outputSnapshot')` is the
// terminal audibility probe ~8 e2e specs assert on — and it is STRUCTURALLY
// BLIND TO STEREO. An AnalyserNode analyses a MONO DOWNMIX per spec, so on the
// stereo terminal bus:
//
//   - only-L and only-R are INDISTINGUISHABLE (both read exactly half level);
//   - an anti-phase pair reads ~0, i.e. "silent" and "cancelling" are one number.
//
// The stereo-normalization sequence ships a "patch only L / only R" feature
// whose e2e must assert L audible AND R silent. That assertion is impossible on
// the mono key. `outputSnapshotL` / `outputSnapshotR` (ChannelSplitter(2) off
// the same post-limiter `tail` node) make it possible — and this file is the
// negative control that proves they are two DIFFERENT channels rather than two
// analysers on the same one, which is the single most likely wiring bug and
// would make every future only-L/R e2e vacuous.
//
// Every leg below is asserted in BOTH directions on EVERY run (permanent
// negative control, not an author-time check):
//
//   feed L only → L loud AND R silent
//   feed R only → R loud AND L silent
//
// Wire both taps to ch0 → leg 1's "R silent" reddens. Both to ch1 → leg 1's
// "L loud" reddens. Swap them → both legs redden. There is no single-node
// mis-wiring that survives.
//
// It runs HERE (ART) and not in the web unit lane because the web vitest config
// deliberately runs in `node` and "does NOT pull in the audio module factories
// (which import WASM/worklet `?url` assets that only Vite can resolve)" — see
// packages/web/vitest.config.ts. ART is the lane with node-web-audio-api, the
// `?url`→filesystem worklet seam (art/vitest.config.ts `workletFsUrl`) and the
// two sibling audio-out scenarios that already drive `audioOutDef.factory` for
// real. ART is a REQUIRED CI check.

import { describe, expect, it } from 'vitest';
import { OfflineAudioContext } from 'node-web-audio-api';
import { audioOutDef } from '../../../packages/web/src/lib/audio/modules/audio-out';
import { MASTER_CEILING } from '../../../packages/dsp/src/lib/master-limiter-dsp';

const SAMPLE_RATE = 48000;
const FFT_SIZE = 2048;
/** 0.512 s — an exact multiple of both the 128-sample render quantum and the
 *  2048-sample analyser window, so the tap's ring and the rendered tail line up
 *  block-for-block (leg 3 asserts they do). */
const RENDER_LEN = FFT_SIZE * 12;
const TONE_HZ = 300; // well above the 5 Hz DC blocker; well below Nyquist.

interface Snapshot {
  samples: Float32Array;
  sampleRate: number;
}

interface RenderResult {
  /** What ctx.destination actually received — the ARTIFACT the taps are
   *  anchored to, independent of any analyser. */
  destination: { left: Float32Array; right: Float32Array };
  /** `handle.read(key)`, snapshotted (copied) at end-of-render. */
  snap: (key: string) => Snapshot | undefined;
  rawRead: (key: string) => unknown;
}

/** Drive audioOut's L and/or R input with a sine of the given amplitude
 *  (0 / omitted = leave the jack unpatched, the real "silent side" shape) and
 *  return both the destination render and the terminal taps. */
async function renderAudioOut(opts: {
  ampL?: number;
  ampR?: number;
  master?: number;
}): Promise<RenderResult> {
  const ctx = new OfflineAudioContext({
    numberOfChannels: 2,
    length: RENDER_LEN,
    sampleRate: SAMPLE_RATE,
  });

  const node = {
    id: 'audioOut-1',
    type: 'audioOut',
    domain: 'audio' as const,
    position: { x: 0, y: 0 },
    params: { master: opts.master ?? 1.0 },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handle = await audioOutDef.factory(ctx as any, node);

  const patch = (portId: 'L' | 'R', amp: number) => {
    const buf = ctx.createBuffer(1, RENDER_LEN, SAMPLE_RATE);
    const d = buf.getChannelData(0);
    for (let i = 0; i < RENDER_LEN; i++) {
      d[i] = amp * Math.sin((2 * Math.PI * TONE_HZ * i) / SAMPLE_RATE);
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const din = handle.inputs.get(portId);
    if (!din) throw new Error(`audioOut has no '${portId}' input`);
    src.connect(din.node, 0, din.input);
    src.start(0);
  };
  if (opts.ampL) patch('L', opts.ampL);
  if (opts.ampR) patch('R', opts.ampR);

  const rendered = await ctx.startRendering();

  const rawRead = (key: string) => handle.read?.(key);
  const snap = (key: string): Snapshot | undefined => {
    const v = rawRead(key) as Snapshot | undefined;
    if (!v) return undefined;
    // COPY: the module reuses one Float32Array per key, so two reads of the
    // same key alias. Comparing aliased buffers would make any "L differs from
    // R" assertion trivially true or trivially false depending on read order.
    return { samples: v.samples.slice(), sampleRate: v.sampleRate };
  };

  return {
    destination: {
      left: rendered.getChannelData(0).slice(),
      right: rendered.getChannelData(1).slice(),
    },
    snap,
    rawRead,
  };
}

function rms(b: Float32Array): number {
  let s = 0;
  for (const v of b) s += v * v;
  return Math.sqrt(s / b.length);
}

function peak(b: Float32Array): number {
  let p = 0;
  for (const v of b) {
    const a = Math.abs(v);
    if (a > p) p = a;
  }
  return p;
}

/** A 0.5-amplitude sine has RMS 0.3536; over a 2048-sample window at 300 Hz
 *  (12.8 cycles) the partial cycle moves it by well under 1 %. */
const LOUD_RMS_MIN = 0.30;
/** Nothing patched → the side is genuinely zero, not merely quiet. Kept
 *  generous enough to survive worklet float noise, tight enough that "half
 *  level" (0.17) could never pass it. */
const SILENT_RMS_MAX = 1e-6;

describe('audio-out per-channel terminal taps — the stereo instrument', () => {
  it('leg 1 — L only: outputSnapshotL is LOUD and outputSnapshotR is SILENT', async () => {
    const r = await renderAudioOut({ ampL: 0.5 });
    const l = r.snap('outputSnapshotL');
    const right = r.snap('outputSnapshotR');
    expect(l, 'read("outputSnapshotL") returned nothing').toBeDefined();
    expect(right, 'read("outputSnapshotR") returned nothing').toBeDefined();

    const lRms = rms(l!.samples);
    const rRms = rms(right!.samples);
    expect(lRms, `L-fed: left tap RMS ${lRms} (linear amplitude)`).toBeGreaterThan(LOUD_RMS_MIN);
    // The cross-assertion. Both taps on ch0 → this is the one that reddens.
    expect(rRms, `L-fed: right tap RMS ${rRms} must be silence, not half-level`)
      .toBeLessThan(SILENT_RMS_MAX);
  });

  it('leg 2 — R only: outputSnapshotR is LOUD and outputSnapshotL is SILENT', async () => {
    const r = await renderAudioOut({ ampR: 0.5 });
    const l = r.snap('outputSnapshotL')!;
    const right = r.snap('outputSnapshotR')!;

    const lRms = rms(l.samples);
    const rRms = rms(right.samples);
    expect(rRms, `R-fed: right tap RMS ${rRms} (linear amplitude)`).toBeGreaterThan(LOUD_RMS_MIN);
    // Both taps on ch1 → this is the one that reddens.
    expect(lRms, `R-fed: left tap RMS ${lRms} must be silence, not half-level`)
      .toBeLessThan(SILENT_RMS_MAX);
  });

  it('the two taps are not the same node — L-fed and R-fed swap which key is loud', async () => {
    // Legs 1+2 restated as ONE inequality, so a future refactor that greens
    // both by accident (e.g. both keys returning the mono buffer, which would
    // fail the silence bound — but also e.g. both returning a copy of the same
    // channel) has to defeat the difference itself.
    const fedL = await renderAudioOut({ ampL: 0.5 });
    const fedR = await renderAudioOut({ ampR: 0.5 });
    const a = rms(fedL.snap('outputSnapshotL')!.samples); // loud
    const b = rms(fedL.snap('outputSnapshotR')!.samples); // silent
    const c = rms(fedR.snap('outputSnapshotL')!.samples); // silent
    const d = rms(fedR.snap('outputSnapshotR')!.samples); // loud
    expect(
      a > b && d > c,
      `tap RMS matrix [fedL: L=${a} R=${b}] [fedR: L=${c} R=${d}] — ` +
        'the loud side must follow the fed side',
    ).toBe(true);
  });

  it('leg 3 — each tap equals the corresponding ctx.destination channel (anchored to the ARTIFACT)', async () => {
    // A tap can only be trusted as "what the speakers get" if it matches what
    // the destination actually received. Compare against the rendered buffer,
    // not against the other tap: this is the one assertion that does not take
    // any analyser's word for anything.
    const r = await renderAudioOut({ ampL: 0.5, ampR: 0.3 });
    const l = r.snap('outputSnapshotL')!.samples;
    const right = r.snap('outputSnapshotR')!.samples;
    const destL = r.destination.left.slice(-FFT_SIZE);
    const destR = r.destination.right.slice(-FFT_SIZE);

    let maxErrL = 0;
    let maxErrR = 0;
    for (let i = 0; i < FFT_SIZE; i++) {
      maxErrL = Math.max(maxErrL, Math.abs(l[i] - destL[i]));
      maxErrR = Math.max(maxErrR, Math.abs(right[i] - destR[i]));
    }
    expect(maxErrL, `L tap vs destination ch0, max |err| ${maxErrL} over the last ${FFT_SIZE} samples`)
      .toBeLessThan(1e-6);
    expect(maxErrR, `R tap vs destination ch1, max |err| ${maxErrR} over the last ${FFT_SIZE} samples`)
      .toBeLessThan(1e-6);
    // …and the two channels genuinely carry different levels in this render,
    // so a byte-identical L/R render could not have satisfied the above.
    const lr = rms(l);
    const rr = rms(right);
    expect(lr / rr, `L/R level ratio ${lr / rr} (fed 0.5 vs 0.3)`).toBeGreaterThan(1.4);
  });

  it('leg 4 — the taps are POST-LIMITER: an over-ceiling input reads bounded, not raw', async () => {
    // Amplitude 1.5 (+3.5 dBFS). A tap on the pre-limiter merger or on the
    // DC-blocker outputs would report ~1.5 here.
    const r = await renderAudioOut({ ampL: 1.5 });
    const p = peak(r.snap('outputSnapshotL')!.samples);
    expect(p, `L tap peak ${p} for a 1.5 input; ceiling ${MASTER_CEILING}`)
      .toBeLessThanOrEqual(MASTER_CEILING);
    // …bounded by turning it DOWN, not by muting — otherwise "post-limiter"
    // would also be satisfiable by a dead tap.
    expect(p, `L tap peak ${p} is not silence`).toBeGreaterThan(0.5);
  });

  it('leg 5 — the taps are POST-master-gain: master 0 silences both', async () => {
    // Proves the taps sit in the real signal path rather than on a phantom
    // branch: a tap upstream of `master` would still read 0.35 here.
    const r = await renderAudioOut({ ampL: 0.5, ampR: 0.5, master: 0 });
    const lRms = rms(r.snap('outputSnapshotL')!.samples);
    const rRms = rms(r.snap('outputSnapshotR')!.samples);
    expect(lRms, `master=0: left tap RMS ${lRms}`).toBeLessThan(SILENT_RMS_MAX);
    expect(rRms, `master=0: right tap RMS ${rRms}`).toBeLessThan(SILENT_RMS_MAX);
  });
});

describe('audio-out mono outputSnapshot — REGRESSION GUARD (must not change)', () => {
  it('still exists, still returns { samples, sampleRate } of the same shape', async () => {
    const r = await renderAudioOut({ ampL: 0.5 });
    const mono = r.snap('outputSnapshot');
    expect(mono, 'read("outputSnapshot") returned nothing').toBeDefined();
    expect(mono!.sampleRate).toBe(SAMPLE_RATE);
    expect(mono!.samples.length).toBe(FFT_SIZE);
    // All three keys agree on shape, so every existing helper works unchanged.
    for (const key of ['outputSnapshotL', 'outputSnapshotR'] as const) {
      const s = r.snap(key)!;
      expect(s.sampleRate, `${key}.sampleRate`).toBe(mono!.sampleRate);
      expect(s.samples.length, `${key}.samples.length`).toBe(mono!.samples.length);
    }
    expect(r.rawRead('nope-not-a-key'), 'unknown read key still returns undefined')
      .toBeUndefined();
  });

  it('is STILL the mono downmix — half level, and only-L reads the same as only-R', async () => {
    // This is the blindness the per-channel taps exist to work around, pinned
    // rather than described. It is also the guard on requirement "do not change
    // or re-route the existing key": if someone ever points `outputSnapshot` at
    // one channel, or at the pre-limiter bus, this goes red.
    const fedL = await renderAudioOut({ ampL: 0.5 });
    const fedR = await renderAudioOut({ ampR: 0.5 });
    const monoL = rms(fedL.snap('outputSnapshot')!.samples);
    const monoR = rms(fedR.snap('outputSnapshot')!.samples);
    const chanL = rms(fedL.snap('outputSnapshotL')!.samples);

    expect(monoL, `mono tap RMS ${monoL} (L-fed) vs ${monoR} (R-fed) — the downmix cannot tell them apart`)
      .toBeCloseTo(monoR, 6);
    // …and it reads exactly HALF the per-channel level, which is the mechanism.
    expect(monoL / chanL, `mono/channel RMS ratio ${monoL / chanL} — expected 0.5 (downmix)`)
      .toBeCloseTo(0.5, 3);
  });
});
