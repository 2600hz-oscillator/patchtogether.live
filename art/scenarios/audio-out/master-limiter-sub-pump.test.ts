// art/scenarios/audio-out/master-limiter-sub-pump.test.ts
//
// P0-A1 REGRESSION GATE — "the master bus must not gain-duck the sub when a
// transient hits" (.myrobots/plans/dsp-stack-bass-freq-audit-2026-07-01.md,
// item P0-A1: "assert the sub band (30-80 Hz) gain-reduction ripple at the kick
// rate drops below a threshold … this is the load-bearing proof").
//
// THE DEFECT this file pins shut. The terminal stage used to be a full-band,
// stereo-linked `DynamicsCompressorNode` (threshold −6 dB, ratio 4, knee 6,
// attack 3 ms, release 50 ms) feeding `ctx.destination`. Measured here, driving
// a sustained 40 Hz sub plus a kick every 500 ms through it:
//
//   in peak     LEGACY ripple / mean gain / out peak   SHIPPED (this PR)
//   −8.92 dBFS      0.000 dB / +1.35 dB / 0.4130       0.000 / 0.00 / 0.3536
//   −2.90 dBFS      0.210 dB / +1.32 dB / 0.8048       0.000 / 0.00 / 0.7071
//   −0.96 dBFS      0.693 dB / +1.22 dB / 0.9482       0.126 / −0.09 / 0.8786
//   +0.62 dBFS      1.353 dB / +1.05 dB / 1.0654 ✗     0.424 / −1.27 / 0.8913
//   +3.12 dBFS      2.671 dB / +0.48 dB / 1.2395 ✗     1.203 / −3.33 / 0.8913
//   +9.14 dBFS      4.279 dB / −2.63 dB / 1.6022 ✗     3.136 / −8.36 / 0.8913
//                                            ✗ = above full scale, i.e. CLIPS
//
// Three findings, all of which this file holds:
//   * The old node pumped the sub by 0.2–4.3 dB per strike once the programme
//     approached full scale — and this app's mixers routinely sum there.
//   * It never actually bounded the output. A 4:1 compressor is not a limiter:
//     at +9 dBFS in it still handed 1.60 to the device. The one job it existed
//     for, it did not do.
//   * It added a constant +1.35 dB of automatic makeup to EVERY patch, which
//     is why the new bus is ~1.35 dB quieter on a normally levelled mix.
//
// ────────────────────────────────────────────────────────────────────────────
// THE INSTRUMENT, AND WHY IT IS TRUSTWORTHY (CLAUDE.md: "validate the
// instrument — a wrong metric reads exactly like a finding")
//
// The metric is the GAIN the master bus applies over time, measured as the
// short-time RMS ratio of a chain's output to a `bypass` render — the identical
// chain with its dynamics stage removed. Numerator and denominator carry
// IDENTICAL programme content, so the ratio is the applied gain and nothing
// else; the kick's own energy cannot be mistaken for ducking.
//
// It is measured FULL-BAND rather than band-limited to 30–80 Hz, on purpose.
// Both topologies apply ONE gain across the whole spectrum — that is the defect
// A1 names — so the sub-band gain and the full-band gain are the same number,
// and a band-pass only adds its own ring: on a KNOWN 2.000 dB dip a 30–80 Hz
// version read 2.113 dB where full-band read 2.013 dB (and 4.18 dB at a 5 ms
// window). Cross-checked at every level in the table above; the two agree to
// ≤ 0.17 dB.
//
// ⚠ THE FIRST INSTRUMENT FOR THIS FILE WAS WRONG IN EXACTLY THE WAY THE
// STANDARD WARNS ABOUT, and it is worth recording. It was a 40 Hz lock-in
// detector with a 5 Hz low-pass, positive-controlled with a 2 dB SINUSOIDAL
// modulation — which it read perfectly. But real pumping is a ~50 ms dip with a
// 3 ms edge, and a 5 Hz detector integrates that away: it reported 0.18 dB
// where the true figure at that level is 2.67 dB, and it would have certified
// the UNFIXED master bus as clean. The metric was invariant to the TIME SCALE
// of the very thing under test. Hence:
//
//   POSITIVE CONTROL (permanent leg, every CI pass) — inject a KNOWN 2.00 dB
//   gain dip of exactly the SHAPE the defect produces (50 ms, 5 ms cosine
//   edges, once per kick) into a dynamics-free chain. The probe must read
//   2.00 dB. That validates magnitude AND time resolution together; the old
//   instrument failed this and passed a sinusoid.
//
//   NEGATIVE CONTROL (permanent leg) — sub + kick through that same
//   dynamics-free chain, with no gain modulation anywhere. The probe must read
//   ≈ 0, proving it does not mistake the programme's own dynamics (a violent
//   transient every 500 ms) for bus gain movement.
//
// And the OLD topology is kept, rebuilt inline, as the standing negative
// control on the FIX: `legacy` must FAIL every bound `shipped` passes. A green
// run therefore proves the gate can still go red.

// This scenario drives the REAL shipped factory, worklet included. Two seams
// make that possible in Node and both are load-bearing: `workletFsUrl()` in
// art/vitest.config.ts (Vite's `?url` → a filesystem path `addModule()` can
// open) and art/setup/node-audio-globals.ts (the `AudioWorkletNode` global the
// factory constructs). If either regresses, audio-out falls back to its
// hard-clip path and the ripple numbers below would silently describe the wrong
// topology — which is why the transparency case asserts the exact look-ahead
// latency: the fallback has none.
import { describe, expect, it } from 'vitest';
import { OfflineAudioContext } from 'node-web-audio-api';
import { audioOutDef } from '../../../packages/web/src/lib/audio/modules/audio-out';
import {
  MASTER_CEILING,
  MASTER_LOOKAHEAD_S,
} from '../../../packages/dsp/src/lib/master-limiter-dsp';

const SR = 48_000;
const SUB_HZ = 40; // the sustained sub under test
const KICK_RATE_HZ = 2; // strikes per second
const DUR_S = 3.0;
/** Skip chain settling (5 Hz DC blocker ring-in, first strike) before measuring. */
const ANALYSE_FROM_S = 0.8;

// ---------------------------------------------------------------------------
// Signal generator — a bass-heavy programme: sustained 40 Hz sub + a 2 Hz kick.
// ---------------------------------------------------------------------------

interface SigOpts {
  /** Sustained 40 Hz sine amplitude (linear). */
  subAmp: number;
  /** Kick peak amplitude (linear); 0 = no kick. */
  kickAmp: number;
  /** Inject a KNOWN gain dip of this depth (dB) once per kick period, with the
   *  SHAPE real pumping has. The probe's POSITIVE control — nothing else uses it. */
  injectDipDb?: number;
}

const INJ_DIP_S = 0.05; // 50 ms — the old node's release time
const INJ_EDGE_S = 0.005; // 5 ms cosine edges (a bare step would ring the chain)

function buildSignal(o: SigOpts): Float32Array {
  const n = Math.round(SR * DUR_S);
  const buf = new Float32Array(n);
  const kickPeriod = SR / KICK_RATE_HZ; // 24000 samples — exact
  const AMP_TAU = 0.16; // kick amplitude decay
  const F_TAU = 0.03; // kick pitch-sweep decay
  const F_END = 70;
  const F_SPAN = 90; // 160 Hz → 70 Hz
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const tk = (i % kickPeriod) / SR; // seconds since the last strike
    let v = o.subAmp * Math.sin(2 * Math.PI * SUB_HZ * t);
    if (o.kickAmp > 0) {
      const env = Math.exp(-tk / AMP_TAU);
      // Analytic phase of the swept body: ∫₀^tk f(τ)dτ with
      // f(τ) = F_END + F_SPAN·e^(−τ/F_TAU).
      const ph = F_END * tk + F_SPAN * F_TAU * (1 - Math.exp(-tk / F_TAU));
      v += o.kickAmp * env * Math.sin(2 * Math.PI * ph);
      // A real transient for a 3 ms attack to chase (700 Hz half-cycle, 1.4 ms).
      if (tk < 0.0014) {
        v += o.kickAmp * 0.5 * (1 - tk / 0.0014) * Math.sin(2 * Math.PI * 700 * tk);
      }
    }
    if (o.injectDipDb) {
      let d = 0; // 0 → 1 dip weight
      if (tk < INJ_EDGE_S) d = 0.5 * (1 - Math.cos((Math.PI * tk) / INJ_EDGE_S));
      else if (tk < INJ_DIP_S - INJ_EDGE_S) d = 1;
      else if (tk < INJ_DIP_S) {
        d = 0.5 * (1 + Math.cos((Math.PI * (tk - (INJ_DIP_S - INJ_EDGE_S))) / INJ_EDGE_S));
      }
      v *= Math.pow(10, (-o.injectDipDb * d) / 20);
    }
    buf[i] = v;
  }
  return buf;
}

// ---------------------------------------------------------------------------
// The chains under test.
// ---------------------------------------------------------------------------

type ChainKind =
  /** The REAL shipped terminal stage — `audioOutDef.factory`, real worklet. */
  | 'shipped'
  /** The PRE-FIX topology, rebuilt inline: the standing negative control. */
  | 'legacy'
  /** DC blocker + merger only — no dynamics of any kind. The instrument's
   *  reference chain (linear and time-invariant by construction). */
  | 'bypass';

/** The five numbers this file exists to retire — the exact pre-fix settings. */
const LEGACY_COMP = {
  threshold: -6,
  ratio: 4,
  knee: 6,
  attack: 0.003,
  release: 0.05,
} as const;

function dcBlockedMerger(ctx: OfflineAudioContext, master: number) {
  const gainL = ctx.createGain();
  const gainR = ctx.createGain();
  gainL.gain.value = master;
  gainR.gain.value = master;
  const mk = () => {
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 5;
    f.Q.value = 0.707;
    return f;
  };
  const dcL = mk();
  const dcR = mk();
  gainL.connect(dcL);
  gainR.connect(dcR);
  const merger = ctx.createChannelMerger(2);
  dcL.connect(merger, 0, 0);
  dcR.connect(merger, 0, 1);
  return { gainL, gainR, merger };
}

/** Drive a chain with `sig` on BOTH inputs and return the rendered L channel. */
async function render(kind: ChainKind, sig: Float32Array, master = 1.0): Promise<Float32Array> {
  const length = sig.length;
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length, sampleRate: SR });

  const inputBuf = ctx.createBuffer(1, length, SR);
  inputBuf.getChannelData(0).set(sig);

  let inL: { node: AudioNode; input: number };
  let inR: { node: AudioNode; input: number };

  if (kind === 'shipped') {
    const node = {
      id: 'audioOut-1',
      type: 'audioOut',
      domain: 'audio' as const,
      position: { x: 0, y: 0 },
      params: { master },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handle = await audioOutDef.factory(ctx as any, node);
    inL = handle.inputs.get('L')!;
    inR = handle.inputs.get('R')!;
  } else {
    const { gainL, gainR, merger } = dcBlockedMerger(ctx, master);
    if (kind === 'legacy') {
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = LEGACY_COMP.threshold;
      comp.ratio.value = LEGACY_COMP.ratio;
      comp.knee.value = LEGACY_COMP.knee;
      comp.attack.value = LEGACY_COMP.attack;
      comp.release.value = LEGACY_COMP.release;
      merger.connect(comp);
      comp.connect(ctx.destination);
    } else {
      merger.connect(ctx.destination);
    }
    inL = { node: gainL, input: 0 };
    inR = { node: gainR, input: 0 };
  }

  const srcL = ctx.createBufferSource();
  srcL.buffer = inputBuf;
  const srcR = ctx.createBufferSource();
  srcR.buffer = inputBuf;
  srcL.connect(inL.node, 0, inL.input);
  srcR.connect(inR.node, 0, inR.input);
  srcL.start(0);
  srcR.start(0);

  const rendered = await ctx.startRendering();
  return rendered.getChannelData(0).slice();
}

// ---------------------------------------------------------------------------
// The instrument: applied bus gain over time, by RMS ratio against `bypass`.
// ---------------------------------------------------------------------------

/** RMS window for the gain trace. 25 ms = exactly one 40 Hz period, so the
 *  measurement is phase-independent, and it still fully resolves the ~50 ms dip
 *  the old node produced (the discarded 5 Hz-detector instrument did not). */
const WIN_S = 0.025;
const HOP_S = 0.001;
/** Largest processing latency the aligner will search for. A look-ahead limiter
 *  legitimately delays the signal; anything past this is a defect, not a delay. */
const MAX_LAG_MS = 10;

function rms(x: Float32Array, from: number, len: number): number {
  let s = 0;
  for (let i = from; i < from + len; i++) s += x[i]! * x[i]!;
  return Math.sqrt(s / len);
}

interface GainTrace {
  /** dB, one entry per HOP_S. */
  db: number[];
  /** Peak-to-trough excursion — THE pumping metric. */
  rippleDb: number;
  /** Average applied gain (0 = the bus is transparent). */
  meanDb: number;
  /** Processing latency the aligner found, in SAMPLES. */
  lagSamples: number;
}

/**
 * The gain a chain applies, sampled every `HOP_S`. `out` and `ref` must be
 * renders of the SAME input through chains that differ ONLY by the dynamics
 * stage under test.
 */
function gainTrace(out: Float32Array, ref: Float32Array): GainTrace {
  // Align: find the integer lag (out is DELAYED by `lag` relative to ref) that
  // maximises correlation over a mid-render span. Reported in every assertion
  // message so a surprise latency is visible rather than silently absorbed.
  const maxLag = Math.round((MAX_LAG_MS / 1000) * SR);
  const probeFrom = Math.round(1.0 * SR);
  const probeLen = Math.round(0.5 * SR);
  let lagSamples = 0;
  let bestCorr = -Infinity;
  for (let lag = 0; lag <= maxLag; lag++) {
    let c = 0;
    for (let i = 0; i < probeLen; i += 4) c += out[probeFrom + lag + i]! * ref[probeFrom + i]!;
    if (c > bestCorr) {
      bestCorr = c;
      lagSamples = lag;
    }
  }

  const win = Math.round(WIN_S * SR);
  const hop = Math.round(HOP_S * SR);
  const from = Math.round(ANALYSE_FROM_S * SR);
  const end = Math.min(out.length - lagSamples, ref.length) - win;
  const db: number[] = [];
  for (let t = from; t < end; t += hop) {
    const den = rms(ref, t, win);
    if (den < 1e-4) continue; // never happens with a sustained sub; guards ÷0
    db.push(20 * Math.log10(rms(out, t + lagSamples, win) / den));
  }
  return {
    db,
    rippleDb: Math.max(...db) - Math.min(...db),
    meanDb: db.reduce((a, b) => a + b, 0) / db.length,
    lagSamples,
  };
}

function peakOf(x: Float32Array, fromS = 0): number {
  let p = 0;
  for (let n = Math.round(fromS * SR); n < x.length; n++) {
    const a = Math.abs(x[n]!);
    if (a > p) p = a;
  }
  return p;
}

function describeTrace(label: string, t: GainTrace): string {
  return `${label}: ripple ${t.rippleDb.toFixed(3)} dB, mean gain ${t.meanDb.toFixed(2)} dB, latency ${t.lagSamples} samples`;
}

// ---------------------------------------------------------------------------
// Programme levels.
// ---------------------------------------------------------------------------

/** A normally levelled bass-heavy mix: pre-master peak ≈ 0.72 (−2.9 dBFS).
 *  Below the −1 dBFS ceiling, so a correct master bus must be TRANSPARENT. */
const MIX_NORMAL = { subAmp: 0.28, kickAmp: 0.5 } as const;
/** The same mix pushed 4 dB past the ceiling (+3.1 dBFS) — a limiter MUST act
 *  here, and the question is whether it acts steadily or breathes at the beat. */
const MIX_HOT = { subAmp: 0.56, kickAmp: 1.0 } as const;
/** A runaway patch: +9.1 dBFS. */
const MIX_RUNAWAY = { subAmp: 1.12, kickAmp: 2.0 } as const;

/** Bound for "the bus is transparent". Measured: shipped 0.000, legacy 0.210. */
const TRANSPARENT_MAX_DB = 0.05;
/** Bound for "even when it MUST act, it does not breathe at the beat".
 *  Measured at +3.1 dBFS: shipped 1.203, legacy 2.671. */
const HOT_RIPPLE_MAX_DB = 1.6;

describe('audio-out master bus: the sub must not duck when a transient hits', () => {
  it('[instrument, positive control] reads a KNOWN 2.00 dB / 50 ms gain dip as 2.00 dB', async () => {
    // Magnitude AND time resolution in one assertion. The discarded instrument
    // (a 5 Hz lock-in) passed a sinusoidal control and read this shape as
    // 0.18 dB — it would have certified the unfixed bus as clean.
    const t = gainTrace(
      await render('bypass', buildSignal({ ...MIX_NORMAL, injectDipDb: 2.0 })),
      await render('bypass', buildSignal(MIX_NORMAL)),
    );
    expect(t.rippleDb, describeTrace('injected 2.00 dB / 50 ms dip', t)).toBeGreaterThan(1.9);
    expect(t.rippleDb).toBeLessThan(2.1);
  });

  it('[instrument, negative control] reads ≈0 dB when no gain modulation exists at all', async () => {
    // Sub + a violent transient every 500 ms through a chain that applies a
    // constant gain. Proves the probe does not mistake PROGRAMME dynamics for
    // BUS gain movement.
    const t = gainTrace(
      await render('bypass', buildSignal(MIX_NORMAL)),
      await render('bypass', buildSignal(MIX_NORMAL)),
    );
    expect(t.rippleDb, describeTrace('unmodulated chain', t)).toBeLessThan(0.01);
  });

  it('[negative control on the FIX] the OLD topology pumps the sub AND colours the level', async () => {
    // The pre-fix DynamicsCompressorNode, rebuilt inline. It must FAIL every
    // bound the shipped chain passes — otherwise those gates prove nothing.
    const ref = await render('bypass', buildSignal(MIX_NORMAL));
    const t = gainTrace(await render('legacy', buildSignal(MIX_NORMAL)), ref);
    expect(
      t.rippleDb,
      `legacy (comp ${JSON.stringify(LEGACY_COMP)}) — ${describeTrace('at −2.9 dBFS', t)}`,
    ).toBeGreaterThan(TRANSPARENT_MAX_DB);
    // …and it was never unity either: the node applies automatic makeup gain to
    // every patch that never comes near its threshold.
    expect(Math.abs(t.meanDb), `legacy mean gain ${t.meanDb.toFixed(2)} dB`).toBeGreaterThan(1.0);
  });

  it('is TRANSPARENT on a normally levelled mix — no ducking, and no makeup either', async () => {
    const ref = await render('bypass', buildSignal(MIX_NORMAL));
    const t = gainTrace(await render('shipped', buildSignal(MIX_NORMAL)), ref);
    expect(t.rippleDb, describeTrace('shipped at −2.9 dBFS', t)).toBeLessThan(TRANSPARENT_MAX_DB);
    expect(Math.abs(t.meanDb), describeTrace('shipped at −2.9 dBFS', t)).toBeLessThan(0.02);
    // The latency IS the look-ahead — assert it rather than absorb it.
    expect(t.lagSamples, 'look-ahead latency, samples').toBe(
      Math.round(MASTER_LOOKAHEAD_S * SR),
    );
  });

  it('does not breathe at the beat even when it MUST act (4 dB past the ceiling)', async () => {
    // Removing the pumping by never limiting would be a clipping hazard, so the
    // interesting case is the one where a limiter is genuinely engaged.
    const ref = await render('bypass', buildSignal(MIX_HOT));
    const shipped = gainTrace(await render('shipped', buildSignal(MIX_HOT)), ref);
    const legacy = gainTrace(await render('legacy', buildSignal(MIX_HOT)), ref);
    expect(shipped.rippleDb, describeTrace('shipped at +3.1 dBFS', shipped))
      .toBeLessThan(HOT_RIPPLE_MAX_DB);
    // Standing negative control: the old node must fail the same bound.
    expect(legacy.rippleDb, describeTrace('legacy at +3.1 dBFS', legacy))
      .toBeGreaterThan(HOT_RIPPLE_MAX_DB);
  });

  it('bounds a runaway patch at the ceiling — which the OLD node never did', async () => {
    const sig = buildSignal(MIX_RUNAWAY);
    const shipped = peakOf(await render('shipped', sig), 0.05);
    const legacy = peakOf(await render('legacy', sig), 0.05);
    expect(
      shipped,
      `+9.1 dBFS in → shipped out peak ${shipped.toFixed(4)} (ceiling ${MASTER_CEILING.toFixed(4)})`,
    ).toBeLessThanOrEqual(MASTER_CEILING * 1.001);
    // …still audible: a ceiling that mutes is not protection.
    expect(shipped, `shipped out peak ${shipped.toFixed(4)} is not silence`).toBeGreaterThan(0.5);
    // Standing negative control: the old node handed the device a clipped signal.
    expect(
      legacy,
      `legacy out peak ${legacy.toFixed(4)} — above 1.0 clips at the device`,
    ).toBeGreaterThan(1.0);
  });
});
