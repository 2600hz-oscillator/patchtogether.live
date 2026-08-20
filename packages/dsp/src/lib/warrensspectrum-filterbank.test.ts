// packages/dsp/src/lib/warrensspectrum-filterbank.test.ts
//
// Unit gates for the WARREN'S SPECTRUM 8-band FILTERBANK (phase 2) and for
// its routing through the engine.
//
// ── THE FAILURE THIS FILE EXISTS TO PREVENT ───────────────────────────────
// The upstream plugin's own ART goldens recorded a DEAD PARAMETER as green
// for months: two sweep baselines (37 ms and 200 ms) were BYTE-IDENTICAL,
// and because every baseline was only ever compared against ITSELF, nothing
// noticed that the parameter separating them did nothing at all. A per-file
// self-comparison is structurally incapable of seeing that — the check has
// to compare SIBLINGS.
//
// So every one of the five per-band controls (cutoff, Q, type, pan, send)
// plus the two global ones (WET, INPUT MIX) gets:
//   (a) a POSITIVE leg — perturb it, the output must MOVE by a stated margin;
//   (b) a NEGATIVE leg — hold it, the output must be EXACTLY unchanged; and
//   (c) `all pairwise renders are distinct` below, which compares every
//       perturbation against every OTHER perturbation. (a) alone cannot
//       catch two knobs that both accidentally drive the same thing; (c) is
//       what makes "this parameter is really its own axis" checkable.
//
// ── AND THE ONE THAT GUARDS THE SHIPPED SOUND ─────────────────────────────
// `the DEFAULT is untouched by the bank` is the unit-lane expression of the
// phase-2 promise: adding a filterbank must not re-voice a rack saved under
// phase 1. Its evidence is stronger than "the numbers look close" — at
// WET 0 the band table is scrambled to values that would be violent if they
// reached the audio, and the output must be EXACTLY equal, sample for
// sample. Its negative control is the same scramble at WET 1, which must
// change the output. (The complementary evidence is that `task art:update`
// left all three `.f32` baselines byte-identical and moved only the `.sha`.)

import { describe, expect, it } from 'vitest';
import {
  WarrensSpectrumEngine,
  WS_INPUT_MIX_MAX,
  WS_WET_MAX,
} from './warrensspectrum-dsp';
import {
  WS_BAND_CUTOFF_MAX_HZ,
  WS_BAND_CUTOFF_MIN_HZ,
  WS_BAND_DEFAULT_HZ,
  WS_BAND_DEFAULT_TYPE,
  WS_BAND_Q_MAX,
  WS_BAND_Q_MIN,
  WS_NUM_BANDS,
  WsFilterBank,
  wsDefaultBands,
  wsMorphSvf,
  wsNormalizeBands,
  type WsBandSettings,
} from './warrensspectrum-filterbank';

const SR = 48000;
const DUR_S = 0.35;

/** Deterministic broadband source — the bank is a FILTER, so it needs energy
 *  everywhere or a band's cutoff has nothing to move. Harmonics + noise. */
function source(durationS = DUR_S): Float32Array {
  const n = Math.round(durationS * SR);
  const buf = new Float32Array(n);
  let s = 0x5eed1234 >>> 0;
  for (let i = 0; i < n; i++) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    let tone = 0;
    for (let k = 1; k <= 12; k++) tone += (1 / k) * Math.sin((2 * Math.PI * 150 * k * i) / SR);
    buf[i] = 0.3 * tone + 0.4 * ((s / 4294967295) * 2 - 1);
  }
  return buf;
}

function rms(x: Float32Array, from = 0): number {
  let acc = 0;
  for (let i = from; i < x.length; i++) acc += x[i]! * x[i]!;
  return Math.sqrt(acc / Math.max(1, x.length - from));
}

/** Normalised difference: 0 = identical, ~1.4 = unrelated equal-power signals. */
function relDiff(a: Float32Array, b: Float32Array): number {
  const denom = Math.max(rms(a), rms(b), 1e-12);
  let acc = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i]! - b[i]!;
    acc += d * d;
  }
  return Math.sqrt(acc / a.length) / denom;
}

function bandsWith(i: number, patch: Partial<WsBandSettings>): WsBandSettings[] {
  const b = wsDefaultBands();
  b[i] = { ...b[i]!, ...patch };
  return b;
}

interface RenderOpts {
  wet?: number;
  inputMix?: number;
  bands?: WsBandSettings[];
}

/** Render BOTH channels at the module's shipped spectral defaults. */
function renderStereo(input: Float32Array, o: RenderOpts = {}): { l: Float32Array; r: Float32Array } {
  const e = new WarrensSpectrumEngine(SR);
  e.setPartials(64);
  e.setFloorDb(-42);
  e.setStabilityFrames(3);
  e.setLock(0.75);
  e.setResidual(0.5);
  e.setShape(0);
  e.setSlewSeconds(0.6);
  e.setSliceMs(10);
  e.setCenterCents(0);
  e.setFilterbankWet(o.wet ?? 0);
  e.setInputMix(o.inputMix ?? 0);
  e.setBands(o.bands ?? wsDefaultBands());
  const l = new Float32Array(input.length);
  const r = new Float32Array(input.length);
  const pair = new Float32Array(2);
  for (let i = 0; i < input.length; i++) {
    e.processSampleStereo(pair, input[i]!);
    l[i] = pair[0]!;
    r[i] = pair[1]!;
  }
  return { l, r };
}

const renderL = (input: Float32Array, o: RenderOpts = {}) => renderStereo(input, o).l;

/** A band table nothing sane would produce — the point is that at WET 0 it
 *  must reach the output not at all, and at WET 1 it must reach it loudly. */
function scrambledBands(): WsBandSettings[] {
  const b = wsDefaultBands();
  for (let i = 0; i < WS_NUM_BANDS; i++) {
    b[i] = {
      cutoffHz: [7000, 40, 12000, 90, 3000, 300, 19000, 1200][i]!,
      q: [18, 0.5, 12, 2, 20, 0.7, 9, 15][i]!,
      type: [0, 1, 0.25, 1, 0.5, 0, 1, 0.75][i]!,
      pan: [-1, 1, -0.5, 0.5, -0.8, 0.8, 0, -0.3][i]!,
      send: 1,
    };
  }
  return b;
}

// ---------------------------------------------------------------------------

describe('warrensspectrum filterbank — the SVF and the morph (pure functions)', () => {
  it('morphSvf crossfades LP → BP → HP and hits each response exactly', () => {
    expect(wsMorphSvf(1, 2, 3, 0)).toBe(1);
    expect(wsMorphSvf(1, 2, 3, 0.5)).toBe(2);
    expect(wsMorphSvf(1, 2, 3, 1)).toBe(3);
    // Monotone across the two halves, and continuous at the 0.5 hinge.
    expect(wsMorphSvf(0, 1, 2, 0.25)).toBeCloseTo(0.5, 12);
    expect(wsMorphSvf(0, 1, 2, 0.75)).toBeCloseTo(1.5, 12);
    // Out-of-range is CLAMPED, not extrapolated.
    expect(wsMorphSvf(1, 2, 3, -5)).toBe(1);
    expect(wsMorphSvf(1, 2, 3, 5)).toBe(3);
  });

  it('a low-cutoff LP band passes low energy and rejects high (and vice versa)', () => {
    // The instrument check for every cutoff assertion below: prove the SVF
    // actually filters before believing any test that assumes it does.
    const tone = (hz: number) => {
      const n = Math.round(0.2 * SR);
      const b = new Float32Array(n);
      for (let i = 0; i < n; i++) b[i] = Math.sin((2 * Math.PI * hz * i) / SR);
      return b;
    };
    const through = (input: Float32Array, cutoff: number, type: number) => {
      const bank = new WsFilterBank(SR);
      const bands = wsDefaultBands().map((b) => ({ ...b, send: 0 }));
      bands[0] = { cutoffHz: cutoff, q: 0.7071, type, pan: 0, send: 1 };
      bank.setBands(bands);
      const out = new Float32Array(input.length);
      for (let i = 0; i < input.length; i++) {
        bank.process(input[i]!);
        out[i] = bank.outL;
      }
      return rms(out, Math.round(0.05 * SR));
    };
    const lowThroughLp = through(tone(100), 1000, 0);
    const highThroughLp = through(tone(8000), 1000, 0);
    expect(lowThroughLp, 'LP @1 kHz should pass a 100 Hz tone').toBeGreaterThan(0.3);
    expect(highThroughLp, 'LP @1 kHz should reject an 8 kHz tone').toBeLessThan(lowThroughLp * 0.1);

    const highThroughHp = through(tone(8000), 1000, 1);
    const lowThroughHp = through(tone(100), 1000, 1);
    expect(highThroughHp, 'HP @1 kHz should pass an 8 kHz tone').toBeGreaterThan(0.3);
    expect(lowThroughHp, 'HP @1 kHz should reject a 100 Hz tone').toBeLessThan(highThroughHp * 0.1);
  });

  it('a band with send 0 is SKIPPED — it contributes exactly nothing', () => {
    const input = source(0.05);
    const allOpen = new WsFilterBank(SR);
    allOpen.setBands(wsDefaultBands());
    const oneShut = new WsFilterBank(SR);
    oneShut.setBands(bandsWith(3, { send: 0 }));
    let anyDiff = false;
    for (let i = 0; i < input.length; i++) {
      allOpen.process(input[i]!);
      oneShut.process(input[i]!);
      if (allOpen.outL !== oneShut.outL) anyDiff = true;
    }
    expect(anyDiff, 'closing one band must change the sum — else send is dead').toBe(true);
  });
});

describe('warrensspectrum filterbank — the band table is range-checked at ONE seam', () => {
  it('wsNormalizeBands always yields exactly 8 well-formed bands', () => {
    const out = wsNormalizeBands(undefined);
    expect(out).toHaveLength(WS_NUM_BANDS);
    expect(out.map((b) => b.cutoffHz)).toEqual([...WS_BAND_DEFAULT_HZ]);
    expect(out.map((b) => b.type)).toEqual([...WS_BAND_DEFAULT_TYPE]);
  });

  it('clamps every field and REPLACES non-finite values with the default', () => {
    const raw = [{ cutoffHz: NaN, q: 1e9, type: -4, pan: 12, send: 5 }];
    const out = wsNormalizeBands(raw);
    // NaN must not reach Math.tan — a NaN in the SVF state never washes out.
    expect(out[0]!.cutoffHz).toBe(WS_BAND_DEFAULT_HZ[0]);
    expect(out[0]!.q).toBe(WS_BAND_Q_MAX);
    expect(out[0]!.type).toBe(0);
    expect(out[0]!.pan).toBe(1);
    expect(out[0]!.send).toBe(1);
    // A short array is padded from the defaults, not truncated to length 1.
    expect(out).toHaveLength(WS_NUM_BANDS);
    expect(out[7]!.cutoffHz).toBe(WS_BAND_DEFAULT_HZ[7]);
  });

  it('a scrambled table cannot produce a non-finite sample', () => {
    const bands = wsNormalizeBands([{ cutoffHz: Infinity, q: -3, type: NaN, pan: NaN, send: 1 }]);
    const out = renderL(source(0.1), { wet: 1, bands });
    expect(out.every((v) => Number.isFinite(v))).toBe(true);
  });

  it('the declared bounds are the ones the normalizer enforces', () => {
    const lo = wsNormalizeBands([{ cutoffHz: -1, q: -1, type: 0, pan: 0, send: -1 }]);
    expect(lo[0]!.cutoffHz).toBe(WS_BAND_CUTOFF_MIN_HZ);
    expect(lo[0]!.q).toBe(WS_BAND_Q_MIN);
    const hi = wsNormalizeBands([{ cutoffHz: 1e9, q: 1e9, type: 9, pan: 9, send: 9 }]);
    expect(hi[0]!.cutoffHz).toBe(WS_BAND_CUTOFF_MAX_HZ);
  });
});

// ---------------------------------------------------------------------------

describe('warrensspectrum filterbank — THE DEFAULT IS UNTOUCHED (the phase-2 promise)', () => {
  const input = source();

  it('at WET 0 the band table cannot change ONE sample', () => {
    const plain = renderL(input);
    const scrambled = renderL(input, { bands: scrambledBands() });
    let firstDiff = -1;
    for (let i = 0; i < plain.length; i++) {
      if (plain[i] !== scrambled[i]) {
        firstDiff = i;
        break;
      }
    }
    expect(
      firstDiff,
      'WET 0 must bypass the bank EXACTLY — sample index of the first difference (-1 = none)',
    ).toBe(-1);
  });

  it('NEGATIVE CONTROL: the same scramble at WET 1 changes the output a lot', () => {
    // Without this leg the test above passes for a bank that is simply never
    // wired up at all.
    const plain = renderL(input, { wet: 1 });
    const scrambled = renderL(input, { wet: 1, bands: scrambledBands() });
    expect(
      relDiff(plain, scrambled),
      'relative RMS difference between the default and the scrambled bank at WET 1',
    ).toBeGreaterThan(0.5);
  });

  it('at WET 0 the bank is SKIPPED, not multiplied by zero', () => {
    // The CPU claim ("the default rack pays nothing for the bank") is only
    // true if the SVFs are never stepped. Reading the flag is what makes
    // that checkable rather than asserted.
    const e = new WarrensSpectrumEngine(SR);
    e.setFilterbankWet(0);
    for (let i = 0; i < 512; i++) e.processSample(0.2);
    expect(e.bankActive).toBe(false);
    e.setFilterbankWet(1);
    for (let i = 0; i < 512; i++) e.processSample(0.2);
    expect(e.bankActive, 'NEGATIVE CONTROL: the flag must be able to read true').toBe(true);
  });

  it('WET returning to 0 SNAPS the bank off (a one-pole alone never would)', () => {
    const e = new WarrensSpectrumEngine(SR);
    e.setFilterbankWet(1);
    for (let i = 0; i < 4800; i++) e.processSample(0.2);
    expect(e.bankActive).toBe(true);
    e.setFilterbankWet(0);
    // 100 ms is ~20 time constants — far past the snap epsilon.
    for (let i = 0; i < 4800; i++) e.processSample(0.2);
    expect(e.bankActive, 'a one-pole never reaches 0; the snap is what turns it off').toBe(false);
    // …and having snapped off, it is bit-identical to never having been on.
    const a = renderL(input);
    const b = renderL(input);
    expect(relDiff(a, b)).toBe(0);
  });

  it('at WET 0 the two channels are IDENTICAL (mono, as phase 1 shipped)', () => {
    const { l, r } = renderStereo(input);
    for (let i = 0; i < l.length; i += 149) expect(r[i]).toBe(l[i]);
  });
});

// ---------------------------------------------------------------------------

describe('warrensspectrum filterbank — every control is its own live axis', () => {
  const input = source();

  /** Each entry renders at WET 1 with ONE thing changed from the default. */
  const variants: { name: string; render: () => Float32Array }[] = [
    { name: 'baseline', render: () => renderL(input, { wet: 1 }) },
    { name: 'band3 cutoff 500→4000', render: () => renderL(input, { wet: 1, bands: bandsWith(3, { cutoffHz: 4000 }) }) },
    { name: 'band3 Q 0.7→18', render: () => renderL(input, { wet: 1, bands: bandsWith(3, { q: 18 }) }) },
    { name: 'band3 type BP→LP', render: () => renderL(input, { wet: 1, bands: bandsWith(3, { type: 0 }) }) },
    { name: 'band3 type BP→HP', render: () => renderL(input, { wet: 1, bands: bandsWith(3, { type: 1 }) }) },
    { name: 'band3 pan 0→-1', render: () => renderL(input, { wet: 1, bands: bandsWith(3, { pan: -1 }) }) },
    { name: 'band3 send 0.5→0', render: () => renderL(input, { wet: 1, bands: bandsWith(3, { send: 0 }) }) },
    { name: 'band3 send 0.5→1', render: () => renderL(input, { wet: 1, bands: bandsWith(3, { send: 1 }) }) },
    { name: 'wet 1→0.4', render: () => renderL(input, { wet: 0.4 }) },
    { name: 'inputMix 0→1', render: () => renderL(input, { wet: 1, inputMix: WS_INPUT_MIX_MAX }) },
  ];

  it('EVERY per-band and global control moves the output (positive leg)', () => {
    const base = variants[0]!.render();
    const dead: string[] = [];
    for (const v of variants.slice(1)) {
      const d = relDiff(base, v.render());
      if (d < 0.02) dead.push(`${v.name}: relDiff=${d.toFixed(6)}`);
    }
    expect(
      dead.join('\n'),
      'control(s) that did not move the output at all — a DEAD PARAMETER, the exact defect the upstream goldens hid',
    ).toBe('');
  });

  it('ALL PAIRWISE renders are distinct — no two controls are secretly the same axis', () => {
    // This is the leg the upstream ART goldens lacked. Comparing each render
    // only against the baseline cannot see two knobs wired to one thing;
    // comparing every pair can.
    const rendered = variants.map((v) => ({ name: v.name, buf: v.render() }));
    const collisions: string[] = [];
    for (let i = 0; i < rendered.length; i++) {
      for (let j = i + 1; j < rendered.length; j++) {
        const d = relDiff(rendered[i]!.buf, rendered[j]!.buf);
        if (d < 1e-9) collisions.push(`${rendered[i]!.name} == ${rendered[j]!.name} (relDiff=${d})`);
      }
    }
    expect(collisions.join('\n'), 'two variants rendered IDENTICALLY — one of those controls is dead').toBe('');
  });

  it('NEGATIVE CONTROL: re-rendering the SAME settings is byte-identical', () => {
    // Bounds the metric from below. Without it, "everything differs" could
    // simply mean the engine is non-deterministic and every relDiff is noise.
    for (const v of variants) expect(relDiff(v.render(), v.render())).toBe(0);
  });

  it('a band whose send is 0 ignores its OWN cutoff (send gates the band)', () => {
    const shut = renderL(input, { wet: 1, bands: bandsWith(3, { send: 0 }) });
    const shutMoved = renderL(input, { wet: 1, bands: bandsWith(3, { send: 0, cutoffHz: 9000 }) });
    expect(relDiff(shut, shutMoved), 'a muted band must not still be filtering into the sum').toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe('warrensspectrum filterbank — STEREO (the reason phase 2 exists)', () => {
  const input = source();

  it('per-band PAN is the only stage that makes the module stereo', () => {
    const centred = renderStereo(input, { wet: WS_WET_MAX });
    // All bands centred → equal-power split is symmetric → L == R exactly.
    for (let i = 0; i < centred.l.length; i += 149) expect(centred.r[i]).toBe(centred.l[i]);

    // Pan the low bands left and the high bands right: now the channels
    // genuinely differ, and they differ SPECTRALLY, not just in level.
    const spread = wsDefaultBands().map((b, i) => ({ ...b, pan: i < 4 ? -0.9 : 0.9 }));
    const wide = renderStereo(input, { wet: WS_WET_MAX, bands: spread });
    expect(
      relDiff(wide.l, wide.r),
      'L vs R after panning low bands left / high bands right',
    ).toBeGreaterThan(0.3);
  });

  it('equal-power pan holds the summed power roughly constant across the sweep', () => {
    const powerAt = (pan: number) => {
      const bands = wsDefaultBands().map((b) => ({ ...b, pan }));
      const { l, r } = renderStereo(input, { wet: WS_WET_MAX, bands });
      return rms(l) ** 2 + rms(r) ** 2;
    };
    const centre = powerAt(0);
    const hardL = powerAt(-1);
    const hardR = powerAt(1);
    // Equal-power means cos²+sin² = 1 for every band, so total power is
    // pan-invariant. A LINEAR pan law would drop ~3 dB at centre and fail.
    expect(hardL / centre).toBeCloseTo(1, 5);
    expect(hardR / centre).toBeCloseTo(1, 5);
  });

  it('hard-panning a band puts it in ONE channel and not the other', () => {
    const bands = wsDefaultBands().map((b, i) => ({ ...b, send: i === 5 ? 1 : 0, pan: i === 5 ? -1 : 0 }));
    const { l, r } = renderStereo(input, { wet: WS_WET_MAX, bands });
    // Measured AFTER the 5 ms WET ramp: while WET is ramping, (1-wet) is
    // legitimately non-zero and the dry sum is legitimately in both
    // channels. Windowing that out is not hiding the residue — the ramp is
    // the feature, and including it would make this test measure the
    // smoother instead of the pan law.
    // 150 ms = 30 time constants of the 5 ms one-pole. The snap needs ~14
    // (ln(1e-6) ≈ -13.8) before (1 - wet) is under the epsilon and the dry
    // term becomes exactly 0; a 50 ms window still caught 8e-8 of ramp.
    const settled = Math.round(0.15 * SR);
    expect(rms(l, settled)).toBeGreaterThan(1e-4);
    // EXACTLY zero, not "small". pan -1 gives panR = sin(0) = 0, and once
    // WET has SNAPPED to its target the dry term is 0 too — which is what
    // this caught: before the snap, the one-pole's asymptote left ~-80 dB of
    // dry in a channel the user had emptied.
    expect(rms(r, settled), 'a hard-left band must put NOTHING in the right channel').toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe('warrensspectrum filterbank — INPUT MIX is a genuinely separate path', () => {
  const input = source();

  it('INPUT MIX adds the RAW input even with the bank fully out of circuit', () => {
    const none = renderL(input, { wet: 0, inputMix: 0 });
    const some = renderL(input, { wet: 0, inputMix: 1 });
    expect(relDiff(none, some)).toBeGreaterThan(0.1);
    // …and what it adds is the raw input, exactly: out = dry + 1.0 * raw.
    for (let i = 1000; i < 1100; i++) {
      expect(some[i]!).toBeCloseTo(none[i]! + input[i]!, 5);
    }
  });

  it('INPUT MIX 0 is EXACTLY the no-mix render (negative control)', () => {
    expect(relDiff(renderL(input, { wet: 0.6 }), renderL(input, { wet: 0.6, inputMix: 0 }))).toBe(0);
  });

  it('INPUT MIX lands identically on BOTH channels (it is a mono source)', () => {
    const { l, r } = renderStereo(input, { wet: 0, inputMix: 0.7 });
    for (let i = 0; i < l.length; i += 149) expect(r[i]).toBe(l[i]);
  });
});

// ---------------------------------------------------------------------------

describe('warrensspectrum filterbank — WET is a crossfade, not a level', () => {
  const input = source();

  it('WET 1 is the bank ALONE and WET 0 is the resynth alone', () => {
    const dry = renderL(input, { wet: 0 });
    const wet = renderL(input, { wet: 1 });
    expect(relDiff(dry, wet)).toBeGreaterThan(0.2);
  });

  it('intermediate WET lies BETWEEN the endpoints, monotonically', () => {
    // A crossfade's distance from the dry endpoint must grow with WET. A
    // plain output GAIN would fail this: it would move away from dry in
    // amplitude but the *shape* distance would not order this way.
    const dry = renderL(input, { wet: 0 });
    const ds = [0.25, 0.5, 0.75, 1].map((w) => relDiff(dry, renderL(input, { wet: w })));
    for (let i = 1; i < ds.length; i++) {
      expect(ds[i], `WET distance from dry must increase: ${ds.join(' < ')}`).toBeGreaterThan(ds[i - 1]!);
    }
  });

  it('WET is SMOOTHED — a step RAMPS in over milliseconds, it does not jump', () => {
    // ⚠ INSTRUMENT NOTE. The obvious version of this test — compare the
    // sample right after the step against the settled sample — measures
    // NOTHING: the engine's output is an oscillator bank, so two samples at
    // different times differ for reasons that have nothing to do with WET.
    // The first draft of this test did exactly that and reported a
    // "jump fraction" of 7.66, a number with no meaning at all.
    //
    // What is actually measurable: how far the stepped render sits from the
    // DRY render, windowed. If WET ramps, that distance must be SMALL right
    // after the step and LARGE once settled. Both engines see the identical
    // input, so the only thing that can move the distance is the crossfade.
    const input = source(0.4);
    const stepAt = Math.round(0.2 * SR);

    const dryEngine = new WarrensSpectrumEngine(SR);
    const stepEngine = new WarrensSpectrumEngine(SR);
    dryEngine.setFilterbankWet(0);
    stepEngine.setFilterbankWet(0);

    const dry = new Float32Array(input.length);
    const stepped = new Float32Array(input.length);
    for (let i = 0; i < input.length; i++) {
      if (i === stepAt) stepEngine.setFilterbankWet(1);
      dry[i] = dryEngine.processSample(input[i]!);
      stepped[i] = stepEngine.processSample(input[i]!);
    }

    const windowDiff = (from: number, len: number) =>
      relDiff(dry.subarray(from, from + len), stepped.subarray(from, from + len));

    // 1 ms window straddling the step vs a 1 ms window 40 ms later.
    const oneMs = Math.round(0.001 * SR);
    const atStep = windowDiff(stepAt, oneMs);
    const settled = windowDiff(stepAt + Math.round(0.04 * SR), oneMs);

    expect(
      atStep,
      `distance from dry in the 1 ms AT the step (settled value is ${settled.toFixed(4)})`,
    ).toBeLessThan(settled * 0.5);
    expect(settled, 'NEGATIVE CONTROL: the settled window must be genuinely wet').toBeGreaterThan(0.2);
  });
});

// ---------------------------------------------------------------------------

describe('warrensspectrum filterbank — the per-QUANTUM CPU deadline', () => {
  // ⚠ Budgeted against the DEADLINE, not against "% of one core". A worklet
  // gets 128 samples = 2.667 ms at 48 kHz to return or the stream glitches,
  // and `analyzeFrame()` runs INLINE in the per-sample loop, so the FFT +
  // peak-pick + F0 + MQ burst all land inside ONE quantum. A "% of a core"
  // figure averages that burst away — it is invariant to the only failure
  // mode there is.
  //
  // ⚠ AND AN INSTRUMENT WARNING, learned the hard way here. The first draft
  // of this block compared the MAX-of-200 quanta with the bank on against
  // the same with it off, and reported a 2.49x blow-up. That number was
  // GARBAGE: a max over a few hundred samples is dominated by whichever
  // quantum happened to catch a GC pause. Measured properly over 3000 quanta
  // the two are indistinguishable (p99 0.645 ms ON vs 0.674 ms OFF — the
  // bank-ON run measured FASTER, which is how you know it is noise).
  //
  // So this block asserts wall-clock ONLY where the signal is far above the
  // noise (the bank in isolation), and asserts the DEFAULT's cost
  // STRUCTURALLY instead of by timing (`bankActive`, in the DEFAULT block
  // above) — a boolean cannot be flaky.
  const QUANTUM = 128;
  const DEADLINE_MS = (QUANTUM / SR) * 1000; // 2.667 ms

  /** p99 ms per quantum for `work`, over `n` quanta after a warm-up. */
  function p99QuantumMs(work: () => void, warm = 500, n = 3000): number {
    for (let q = 0; q < warm; q++) work();
    const times: number[] = [];
    for (let q = 0; q < n; q++) {
      const t0 = performance.now();
      work();
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    return times[Math.floor(times.length * 0.99)]!;
  }

  function bankQuantum(bankCount: number): () => void {
    const banks: WsFilterBank[] = [];
    for (let i = 0; i < bankCount; i++) {
      const b = new WsFilterBank(SR);
      b.setBands(wsDefaultBands());
      banks.push(b);
    }
    const buf = new Float32Array(QUANTUM);
    for (let i = 0; i < QUANTUM; i++) buf[i] = Math.sin(i * 0.031) * 0.4;
    return () => {
      for (const b of banks) for (let i = 0; i < QUANTUM; i++) b.process(buf[i]!);
    };
  }

  it('one full bank costs a SMALL fraction of one render quantum', () => {
    const p99 = p99QuantumMs(bankQuantum(1));
    // Measured on an M5: p99 ≈ 0.045 ms ≈ 1.7 % of the deadline for all 8
    // bands open. The 10 % ceiling is ~6x that headroom, so it fails on a
    // real regression (per-sample coefficient recompute, an allocation in
    // the loop) rather than on slower CI silicon.
    expect(
      p99,
      `p99 per-quantum time for all ${WS_NUM_BANDS} bands, ms — deadline is ${DEADLINE_MS.toFixed(3)} ms (${QUANTUM} samples @ ${SR} Hz)`,
    ).toBeLessThan(DEADLINE_MS * 0.1);
  });

  it('INSTRUMENT CHECK: the timer scales with the work given to it', () => {
    // Without this, the assertion above passes just as happily against a
    // timer that returns a constant, or against a bank whose `process` was
    // optimised out entirely.
    //
    // ⚠ SCALING is checked on the MEDIAN of BATCHED samples, not the p99 of
    // single calls (which the deadline leg above rightly uses — tails ARE its
    // subject). A single 1-bank quantum is ~0.04 ms, so a single-call p99 is
    // scheduler-jitter-bound, not work-bound: main went red at ratio 2.62 vs
    // a floor of 3 on a loaded runner (2026-08-19, job 96258184256) with the
    // work itself unchanged. Batching 8 quanta per sample makes the work
    // dominate timer overhead, and the median discards the jitter tail — the
    // true work ratio is ~12×, so the floor of 3 now has real margin instead
    // of sitting inside the instrument's noise.
    const BATCH = 8;
    const medianBatchedMs = (work: () => void): number => {
      for (let q = 0; q < 200; q++) work();
      const times: number[] = [];
      for (let s = 0; s < 300; s++) {
        const t0 = performance.now();
        for (let b = 0; b < BATCH; b++) work();
        times.push((performance.now() - t0) / BATCH);
      }
      times.sort((a, b) => a - b);
      return times[Math.floor(times.length / 2)]!;
    };
    const one = medianBatchedMs(bankQuantum(1));
    const twelve = medianBatchedMs(bankQuantum(12));
    expect(
      twelve / Math.max(one, 1e-6),
      `median batched ratio for 12 banks vs 1 (one=${one.toFixed(4)} ms, twelve=${twelve.toFixed(4)} ms, batch=${BATCH}) — must scale, or the timer is blind`,
    ).toBeGreaterThan(3);
  });
});
