// art/scenarios/moog912/face-audit.test.ts
//
// THE ADVERSARIAL AUDIT FOR MOOG912, and the permanent anchor under its
// faceplate (queue Q40, #1914).
//
// ⚠ WHY THIS FILE EXISTS AT ALL — it closes a gap the spec NAMED as open.
// §27.6 derived moog912's gate threshold ARITHMETICALLY (mean |sin| = 2/π and
// the unity DC gain of a lowpass) on top of the real curve builders, and said
// so in terms: *"no `BiquadFilterNode` was run, and that figure is load-bearing
// for Q40's rank 1"*. The whole merit of this face is that its two readouts
// print quantities nothing else prints — so shipping a readout whose number was
// never rendered would be the "a wrong metric reads exactly like a finding"
// class, on the one figure the ranking rests on.
//
// So everything below drives the SHIPPING `moog912Def.factory` through a REAL
// `node-web-audio-api` OfflineAudioContext at 48 kHz: real GainNode, real
// rectifier WaveShaper, real BiquadFilterNode, real gate WaveShaper. These are
// the delivered numbers, not a mirror's.
//
// WHAT IT PINS:
//   1. THE GATE'S THRESHOLD IN INPUT dBFS, bisected on a rendered sine — the
//      number `moog912-gate-dbfs` prints, and the number rank 1 rests on.
//   2. THE DEAD BOTTOM OF THE SENS DIAL. `GATE_THRESHOLD` is a bare constant
//      that does NOT scale with SENS, so below a certain sensitivity the gate
//      cannot fire on ANY input — asserted here against a FULL-SCALE sine,
//      which is the strongest form of "never".
//   3. THE ENVELOPE'S RESPONSE TIME, measured as a real 10–90 % rise.
//   4. THE NaN GUARD (#1914), with a POSITIVE CONTROL proving the probe can see
//      the dead state it claims to prevent.

import { describe, expect, it } from 'vitest';
import { OfflineAudioContext } from 'node-web-audio-api';
import {
  GATE_THRESHOLD,
  buildGateCurve,
  moog912Def,
  smoothingToCutoffHz,
} from '../../../packages/web/src/lib/audio/modules/moog912';
import type { ModuleNode } from '../../../packages/web/src/lib/graph/types';

const SR = 48000;
const OUT_IDS = ['env', 'gate'] as const;

const DEFAULTS: Record<string, number> = Object.fromEntries(
  moog912Def.params.map((p) => [p.id, p.defaultValue]),
);

interface Render {
  out: Record<string, Float32Array>;
  readParam: (id: string) => number | undefined;
  setParam: (id: string, v: number) => void;
}

/** Drive the SHIPPING factory through a real offline graph. */
async function render(opts: {
  params?: Record<string, number>;
  sineHz?: number;
  amp?: number;
  secs?: number;
  /** Applied through the handle's own setParam AFTER construction. */
  afterBuild?: (h: { setParam: (id: string, v: number) => void }) => void;
}): Promise<Render> {
  const secs = opts.secs ?? 0.6;
  const ctx = new OfflineAudioContext({
    numberOfChannels: OUT_IDS.length,
    length: Math.round(SR * secs),
    sampleRate: SR,
  });
  const node = {
    id: 'face-audit',
    type: moog912Def.type,
    position: { x: 0, y: 0 },
    params: { ...DEFAULTS, ...(opts.params ?? {}) },
  } as unknown as ModuleNode;
  const handle = await moog912Def.factory(ctx as unknown as AudioContext, node);

  if (opts.afterBuild) {
    opts.afterBuild({ setParam: (id, v) => handle.setParam?.(id, v) });
  }

  if (opts.sineHz !== undefined) {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = opts.sineHz;
    const g = ctx.createGain();
    g.gain.value = opts.amp ?? 0.5;
    osc.connect(g);
    const term = handle.inputs.get('audio')!;
    g.connect(term.node as never, 0, term.input);
    osc.start();
  }

  const merger = ctx.createChannelMerger(OUT_IDS.length);
  OUT_IDS.forEach((id, i) => {
    const o = handle.outputs.get(id)!;
    (o.node as never as AudioNode).connect(merger as never, o.output, i);
  });
  merger.connect(ctx.destination);
  const buf = await ctx.startRendering();

  const out: Record<string, Float32Array> = {};
  OUT_IDS.forEach((id, i) => {
    out[id] = buf.getChannelData(i) as unknown as Float32Array;
  });
  return {
    out,
    readParam: (id) => handle.readParam?.(id),
    setParam: (id, v) => handle.setParam?.(id, v),
  };
}

/** Mean of the last `frac` of a buffer — the settled value. */
function tailMean(a: Float32Array, frac = 0.25): number {
  const from = Math.round(a.length * (1 - frac));
  let s = 0;
  for (let i = from; i < a.length; i++) s += a[i];
  return s / (a.length - from);
}

/**
 * Did the gate ever reach the open state — INCLUDING the attack transient.
 *
 * ⚠ THIS IS THE TRANSIENT ANSWER, AND IT IS NOT THE ONE THE READOUT PRINTS.
 * See `gateHeldOpen` below and the two-threshold test; keeping both named
 * separately is what stopped this file's first draft from "correcting" a
 * closed form that was right.
 */
function gateEverOpened(gate: Float32Array): boolean {
  for (let i = 0; i < gate.length; i++) if (gate[i] > 0.5) return true;
  return false;
}

/** Is the gate open at STEADY STATE — i.e. does it STAY open on a held tone? */
function gateHeldOpen(gate: Float32Array): boolean {
  const from = Math.round(gate.length * 0.8);
  for (let i = from; i < gate.length; i++) if (gate[i] <= 0.5) return false;
  return true;
}

function maxOf(a: Float32Array): number {
  let m = -Infinity;
  for (let i = 0; i < a.length; i++) if (a[i] > m) m = a[i];
  return m;
}

const dbfs = (amp: number) => 20 * Math.log10(amp);

describe('moog912 — the GATE threshold, on a REAL graph', () => {
  it('the SUSTAINED threshold is the closed form, confirmed on a rendered graph', async () => {
    // The closed form §27.6 derived and never rendered: the rectified sine's DC
    // level is A·sens·(2/π), and the lowpass passes DC at unity, so the gate
    // needs A ≥ π·GATE_THRESHOLD/(2·sens). This is what `moog912-gate-dbfs`
    // prints, and it is EXACT — the rendered settled envelope matches it to six
    // decimal places (0.100001 against 0.100000 at the shipped sensitivity).
    const predicted = (Math.PI * GATE_THRESHOLD) / (2 * DEFAULTS.sensitivity);

    const atPredicted = await render({ sineHz: 220, amp: predicted });
    expect(
      tailMean(atPredicted.out.env),
      `settled ENV at the predicted amplitude (units: linear envelope level, ` +
        `gate threshold ${GATE_THRESHOLD})`,
    ).toBeCloseTo(GATE_THRESHOLD, 4);

    // Bisect the real graph for the amplitude at which the gate STAYS open.
    let lo = 0.0001, hi = 1;
    for (let i = 0; i < 20; i++) {
      const mid = (lo + hi) / 2;
      const r = await render({ sineHz: 220, amp: mid });
      if (gateHeldOpen(r.out.gate)) hi = mid; else lo = mid;
    }
    const measured = (lo + hi) / 2;

    // ⚠ The message carries the UNITS, because "amplitude" and "dBFS" are the
    // exact pair this module's readouts confuse if anyone is careless.
    expect(
      Math.abs(measured - predicted) / predicted,
      `gate HOLDS from amplitude ${measured.toFixed(6)} (${dbfs(measured).toFixed(3)} dBFS); ` +
        `the closed form predicts ${predicted.toFixed(6)} (${dbfs(predicted).toFixed(3)} dBFS). ` +
        `Units: linear amplitude of a full-scale-referenced sine, dB relative to 1.0.`,
    ).toBeLessThan(0.03);
  }, 180000);

  it('⚠ THE ATTACK TRANSIENT OPENS IT ~1.5 dB EARLIER — two thresholds, not one', async () => {
    // ⚠ THIS LEG EXISTS BECAUSE THE INSTRUMENT WAS WRONG FIRST, and it is kept
    // permanently so the same mistake cannot be made silently again.
    //
    // This file's first draft bisected on "did the gate EVER open", got
    // amplitude 0.188627 (−14.488 dBFS) against the closed form's 0.224399
    // (−12.980 dBFS), and read as though the spec's arithmetic were wrong by
    // 1.5 dB. It was not. The rendered SETTLED envelope matches that arithmetic
    // to six decimals; what the probe had actually found is that the envelope
    // OVERSHOOTS its own steady state on attack by a constant factor —
    // measured 1.1861× at every amplitude tried (0.052863/0.044567,
    // 0.118615/0.100001, 0.158575/0.133690), as a linear system must.
    //
    // So the module genuinely has TWO thresholds, and the difference is
    // musically real: a sound about 1.5 dB below the sustained threshold still
    // BLIPS the gate on its attack and then drops it. Both are asserted, in
    // both directions, so neither reading can quietly become the other.
    const sustained = (Math.PI * GATE_THRESHOLD) / (2 * DEFAULTS.sensitivity);
    const justBelow = sustained * 0.88;

    const r = await render({ sineHz: 220, amp: justBelow });
    expect(
      gateEverOpened(r.out.gate),
      `just below the sustained threshold the ATTACK still opens the gate ` +
        `(env max ${maxOf(r.out.env).toFixed(6)} vs settled ${tailMean(r.out.env).toFixed(6)})`,
    ).toBe(true);
    expect(
      gateHeldOpen(r.out.gate),
      'but it must NOT still be open at steady state — that is what makes it a transient',
    ).toBe(false);

    // The overshoot ratio itself, pinned: it is what separates the two numbers.
    const ratio = maxOf(r.out.env) / tailMean(r.out.env);
    expect(
      ratio,
      `attack overshoot ratio (units: dimensionless, env peak / env settled) = ${ratio.toFixed(4)}`,
    ).toBeGreaterThan(1.1);
  }, 120000);

  it('⚠ CANNOT FIRE AT ALL below the dead-zone sensitivity — on a FULL-SCALE sine', async () => {
    // THE FINDING (#1914). `GATE_THRESHOLD` is a bare constant that does NOT
    // scale with SENS, so there is a sensitivity below which no input can open
    // the gate. Solving A = 1 gives sens = π·0.1/2 = 0.157080 — the bottom
    // 15.71 % of a dial whose whole job is to open this output.
    const deadZone = (Math.PI * GATE_THRESHOLD) / 2;

    // A FULL-SCALE sine is the strongest possible witness: if this cannot hold
    // the gate open, nothing can.
    const dead = await render({ sineHz: 220, amp: 1, params: { sensitivity: deadZone * 0.9 } });
    expect(
      gateHeldOpen(dead.out.gate),
      `at sens ${(deadZone * 0.9).toFixed(6)} a FULL-SCALE sine must not hold the gate open ` +
        `(env settled at ${tailMean(dead.out.env).toFixed(6)}, gate threshold ${GATE_THRESHOLD})`,
    ).toBe(false);

    // POSITIVE CONTROL — the same probe, just above the dead zone, MUST open.
    // Without this leg "never opens" is indistinguishable from "the probe never
    // looked at the gate output".
    const live = await render({ sineHz: 220, amp: 1, params: { sensitivity: deadZone * 1.3 } });
    expect(
      gateHeldOpen(live.out.gate),
      `POSITIVE CONTROL: at sens ${(deadZone * 1.3).toFixed(6)} a full-scale sine MUST hold the gate open`,
    ).toBe(true);

    // And the ENV output is alive on BOTH sides — the dead zone is the GATE's,
    // not the module's, which is why it is a defect worth printing rather than
    // a broken module.
    expect(tailMean(dead.out.env)).toBeGreaterThan(0);
  }, 120000);
});

describe('moog912 — the ENVELOPE response, on a REAL graph', () => {
  it('SMOOTHING sets a real 10–90 % rise, and more smoothing is slower', async () => {
    // The readout prints ln(9)/(2π·fc). Confirm the ORDERING and the ORDER OF
    // MAGNITUDE against a rendered step, rather than trusting the closed form:
    // a biquad with Q = 0.5 is not a one-pole, so the closed form is a model.
    const riseMs = async (smoothing: number): Promise<number> => {
      const r = await render({ sineHz: 220, amp: 0.8, params: { smoothing }, secs: 1.5 });
      const env = r.out.env;
      const settled = tailMean(env);
      let t10 = -1, t90 = -1;
      for (let i = 0; i < env.length; i++) {
        if (t10 < 0 && env[i] >= 0.1 * settled) t10 = i;
        if (t90 < 0 && env[i] >= 0.9 * settled) { t90 = i; break; }
      }
      return ((t90 - t10) / SR) * 1000;
    };

    const fast = await riseMs(0);
    const mid = await riseMs(0.5);
    const slow = await riseMs(1);

    expect(
      fast < mid && mid < slow,
      `rise is monotonic in SMOOTHING (units: ms): 0 -> ${fast.toFixed(3)}, ` +
        `0.5 -> ${mid.toFixed(3)}, 1 -> ${slow.toFixed(3)}`,
    ).toBe(true);

    // The 50× span the 0..1 dial cannot suggest — the readout's whole reason.
    expect(
      slow / fast,
      `SMOOTH spans ${(slow / fast).toFixed(1)}x from end to end (fast ${fast.toFixed(2)} ms, ` +
        `slow ${slow.toFixed(2)} ms); the cutoff span is ${smoothingToCutoffHz(0).toFixed(4)} Hz ` +
        `to ${smoothingToCutoffHz(1).toFixed(4)} Hz`,
    ).toBeGreaterThan(20);

    // ⚠ AND THIS IS WHY THE FACE DOES NOT PRINT A MILLISECOND FIGURE.
    // §27.6 proposed `moog912-response-ms` = `1000·ln(9)/(2π·fc)`, the ONE-POLE
    // 10–90 % rise. The shipping filter is a BIQUAD at Q = 0.5, and a
    // `FaceReadoutValue` cannot run one, so that readout would have been a
    // MODEL. Measured here it is off by ~30 % at the fast end — rendered
    // 4.917 ms against a modelled 6.994 ms at SMOOTH 0.
    //
    // ⚠ AND THE RENDERED FIGURE IS ITSELF THE LEAST TRUSTWORTHY NUMBER IN THIS
    // FILE, which is the real reason to refuse the readout rather than to
    // re-fit it: at SMOOTH 0 the cutoff is 50 Hz while the rectified 220 Hz
    // tone ripples at 440 Hz only ~19 dB down, so the 10 % / 90 % crossings are
    // riding ripple rather than a clean contour. Two uncertain numbers do not
    // make a readout.
    //
    // The face prints `moog912-response-hz` instead — `smoothingToCutoffHz`,
    // the EXACT value the factory writes into `envFilter.frequency`, IMPORTED
    // from the module rather than modelled. Same call as moog904a's corner, for
    // the same reason. What the readout's prose actually claims is the ORDERING
    // and the SPAN, and both are asserted above, where the ripple cannot reach
    // them.
    expect(smoothingToCutoffHz(0.5)).toBeCloseTo(7.071068, 5);
  }, 180000);
});

describe('moog912 — the NaN guard (#1914)', () => {
  it('a NaN SMOOTHING write leaves the module ALIVE', async () => {
    // BEFORE the guard: `smoothingToCutoffHz(NaN)` returned NaN (`exp(NaN)`),
    // that NaN reached `envFilter.frequency`, and BOTH outputs went dead until
    // something wrote a finite value — a module bricked by one bad write.
    const r = await render({
      sineHz: 220,
      amp: 0.8,
      afterBuild: (h) => h.setParam('smoothing', Number.NaN),
    });
    const env = tailMean(r.out.env);
    expect(
      Number.isFinite(env) && env > 0,
      `after a NaN smoothing write the ENV must still follow the input; settled env = ${env}`,
    ).toBe(true);
    expect(gateEverOpened(r.out.gate)).toBe(true);
  }, 120000);

  it('the pure map is TOTAL — no input produces a non-finite cutoff', () => {
    // The boundary guard above is the product fix; this is the belt-and-braces
    // one, so no future caller can re-create the same dead state by a different
    // route.
    for (const v of [Number.NaN, Infinity, -Infinity, -5, 0, 0.5, 1, 99]) {
      const hz = smoothingToCutoffHz(v);
      expect(Number.isFinite(hz), `smoothingToCutoffHz(${v}) must be finite, got ${hz}`).toBe(true);
      expect(hz).toBeGreaterThan(0);
    }
  });

  it('POSITIVE CONTROL: the probe CAN see a dead module', async () => {
    // If `render` could not distinguish alive from dead, the guard test above
    // would pass on a still-broken module. Sensitivity 0 silences the follower
    // by design — the probe must report it as such.
    const r = await render({ sineHz: 220, amp: 0.8, params: { sensitivity: 0 } });
    expect(gateEverOpened(r.out.gate)).toBe(false);
    expect(tailMean(r.out.env)).toBeLessThan(GATE_THRESHOLD / 10);
  }, 120000);
});

describe('moog912 — the RECTIFIER never actually reaches zero (#1918)', () => {
  it('a silenced follower rests at a small POSITIVE DC on ENV, not at 0', async () => {
    // ⚠ FOUND BY THIS FILE'S OWN POSITIVE CONTROL FAILING, which is the whole
    // reason a positive control is worth writing: the leg above asserted the
    // env settles at 0 with sensitivity 0, and it settled at 9.7751e-4 instead.
    //
    // THE MECHANISM. `buildRectifyCurve(len = 1024)` samples x → |x| at
    // `x = (i/(len−1))·2 − 1`. With an EVEN length there is no `i` for which
    // x = 0: the two nearest are i = 511 (x = −9.7752e-4) and i = 512
    // (x = +9.7752e-4), both mapping to +9.7752e-4. So the curve's MINIMUM is
    // 9.7752e-4 rather than 0, and a WaveShaper interpolating between those two
    // points emits that floor for a silent input. The envelope lowpass passes
    // DC at unity, so it arrives at the ENV jack unchanged and STAYS there.
    //
    // FILED, NOT FIXED (#1918): changing the curve changes what every patch
    // downstream receives at rest, which is an audible-behaviour decision, not
    // a mechanical one. It is ~ −60 dBFS and about 1 % of GATE_THRESHOLD, so it
    // cannot false-trigger the gate — asserted below, because "harmless" is the
    // claim that makes deferring it defensible, and it should fail loudly if it
    // ever stops being true.
    const silent = await render({ sineHz: 220, amp: 0.8, params: { sensitivity: 0 } });
    const rest = tailMean(silent.out.env);

    expect(rest, `resting ENV with the follower silenced (units: linear CV level)`).toBeGreaterThan(0);
    expect(rest).toBeCloseTo(9.7752e-4, 6);

    // THE CLAIM THAT MAKES IT DEFERRABLE: it is far below the gate threshold.
    expect(
      rest / GATE_THRESHOLD,
      `resting DC as a fraction of GATE_THRESHOLD — if this ever approaches 1 the ` +
        `module starts gating on silence and #1918 stops being cosmetic`,
    ).toBeLessThan(0.02);
    expect(gateEverOpened(silent.out.gate)).toBe(false);
  }, 120000);

  it('the gate curve quantises its threshold too — same 1024-point cause', () => {
    // The step lands on the first sample at or above GATE_THRESHOLD, which is
    // x = 0.100684 rather than 0.100000. Recorded with the DC offset because it
    // is the same root cause, and because a future fix should address both.
    const curve = buildGateCurve();
    const firstOpen = curve.indexOf(1);
    const x = (firstOpen / (curve.length - 1)) * 2 - 1;
    expect(x).toBeGreaterThanOrEqual(GATE_THRESHOLD);
    expect(
      x - GATE_THRESHOLD,
      `gate curve quantisation (units: linear env level) — the realised threshold is ` +
        `${x.toFixed(6)} against a declared ${GATE_THRESHOLD}`,
    ).toBeLessThan(0.002);
  });
});
