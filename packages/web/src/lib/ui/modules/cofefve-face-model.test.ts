// packages/web/src/lib/ui/modules/cofefve-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS for COFEFVE's faceplate, and the pin that
// anchors its central claim to the SHIPPING DSP rather than to a comment.
//
// This faceplate's argument is unusual, so what has to be proved is too. Every
// other face in the repo derives a NUMBER a knob readback would get wrong.
// This one derives whether a control DOES ANYTHING AT ALL — seven of
// twenty-three do nothing at the factory default, five of them bit-exactly —
// and "inaudible" is a claim about AUDIO, not about arithmetic. A model that merely agreed with itself
// would be a list of opinions. So:
//
//  §1 THE ENABLER GRAPH IS PINNED TO THE REAL WORKLET. Every edge in
//     `ENABLER_PAIRS` is rendered through the shipping processor class (the
//     registerProcessor shim, the ART harness's route) and asserted in BOTH
//     directions: sweeping a dependent with its enabler CLOSED must move the
//     output by exactly zero, and sweeping the same dependent with the enabler
//     OPEN must move it by a lot. The second leg is what makes the first
//     non-vacuous — a probe that could not detect ANY change would pass the
//     "no change" leg trivially, which is the blind-instrument trap CLAUDE.md
//     is about. A DSP fix that wakes one of these controls turns this RED
//     rather than leaving the faceplate insisting a repaired control is asleep.
//
//  §2 …AND THE PROBE ITSELF IS NEGATIVE-CONTROLLED. The spec this face was
//     built from concluded "only PAN wakes PAN MODE", which is false, and the
//     error was in the instrument: it fed the SAME waveform to both inputs, and
//     PING-PONG swaps the two channels' feedback, so a swap of two equal things
//     is the identity. §2 runs PAN MODE against three different perturbations —
//     a stereo source, a STEREO skew, and PAN — and pins which ones wake which
//     modes, so the corrected story cannot silently regress to the wrong one.
//
//  §3 EACH READOUT IS BLIND TO SOMETHING ANOTHER ONE SEES, both directions.
//
//  §4 THE PANEL'S OPERABILITY PROBE IS NON-VACUOUS: no two time windows may
//     render the same tick row, or a dead window button would pass its `text`
//     probe.
//
// MEASURED FIGURES quoted below come from the real processor at 48 kHz, a C4
// saw at −6 dBFS into both inputs, max|Δ| over a 2 s render.

import { beforeAll, describe, expect, it } from 'vitest';
import {
  DRIVE_BYPASS_AT,
  ECHO_WINDOWS,
  ENABLER_PAIRS,
  asleepControls,
  asleepText,
  baseDelayS,
  cofefveFaceParams,
  driveNearlyOffAt,
  echoRepeats,
  echoRepeatsText,
  echoSpacingText,
  echoTrain,
  enablerText,
  fmtSeconds,
  stereoSkewS,
  syncEngaged,
  windowTicks,
  wowDepth,
} from './cofefve-face-model';
import {
  COFEFVE_CLOCK_SOURCE_OPTIONS,
  COFEFVE_FILTER_MODE_OPTIONS,
  COFEFVE_PAN_MODE_OPTIONS,
  COFEFVE_TEMPO_SYNC_OPTIONS,
  cofefveDelayDef,
} from '$lib/audio/modules/cofefve';

const SR = 48000;
const BLOCK = 128;
const RENDER_S = 2;

// ── the REAL processor ──────────────────────────────────────────────────────

interface WorkletLike {
  process(i: Float32Array[][], o: Float32Array[][], p: Record<string, Float32Array>): boolean;
}
type ProcCtor = (new (opts?: unknown) => WorkletLike) & {
  parameterDescriptors?: ReadonlyArray<{ name: string; defaultValue: number }>;
};

let Proc: ProcCtor;

beforeAll(async () => {
  // Per memory `dsp-worklet-no-top-level-export`, the worklet entry exports
  // nothing — capture the class by swapping in a recording registerProcessor.
  const g = globalThis as unknown as {
    sampleRate?: number;
    registerProcessor?: (n: string, c: ProcCtor) => void;
  };
  g.sampleRate = SR;
  const prev = g.registerProcessor;
  let registered: ProcCtor | null = null;
  g.registerProcessor = (_n, ctor) => {
    registered = ctor;
  };
  await import('../../../../../dsp/src/cofefve');
  g.registerProcessor = prev;
  if (!registered) throw new Error('cofefve.ts did not registerProcessor()');
  Proc = registered;
});

function saw(n: number, hz: number, amp = 0.5): Float32Array {
  const b = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    b[i] = (2 * ph - 1) * amp;
    ph += hz / SR;
    if (ph >= 1) ph -= 1;
  }
  return b;
}

/** Render the shipping processor. `stereo` feeds the two inputs DIFFERENT
 *  waveforms — the perturbation the original probe was missing. */
function render(
  overrides: Record<string, number> = {},
  stereo = false,
): { L: Float32Array; R: Float32Array } {
  const proc = new Proc();
  const params: Record<string, Float32Array> = {};
  for (const d of Proc.parameterDescriptors ?? []) {
    params[d.name] = new Float32Array([d.defaultValue]);
  }
  for (const [k, v] of Object.entries(overrides)) {
    if (!(k in params)) throw new Error(`cofefve worklet has no AudioParam '${k}'`);
    params[k] = new Float32Array([v]);
  }
  const n = Math.round(SR * RENDER_S);
  const inL = saw(n, 261.626);
  // A square at a different pitch, so the right channel is genuinely a
  // DIFFERENT signal rather than a scaled copy (a scaled copy still makes
  // fbL/fbR proportional, which a swap would partly hide).
  const inR = stereo ? squareR(n) : inL;
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const bl = new Float32Array(BLOCK);
  const br = new Float32Array(BLOCK);
  for (let s = 0; s < n; s += BLOCK) {
    const len = Math.min(BLOCK, n - s);
    bl.fill(0);
    br.fill(0);
    proc.process(
      [[inL.subarray(s, s + len)], [inR.subarray(s, s + len)], []],
      [[bl.subarray(0, len)], [br.subarray(0, len)]],
      params,
    );
    L.set(bl.subarray(0, len), s);
    R.set(br.subarray(0, len), s);
  }
  return { L, R };
}

function squareR(n: number, hz = 174.614, amp = 0.5): Float32Array {
  const b = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    b[i] = ph < 0.5 ? amp : -amp;
    ph += hz / SR;
    if (ph >= 1) ph -= 1;
  }
  return b;
}

function maxAbsDiff(a: Float32Array, b: Float32Array): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i]! - b[i]!));
  return m;
}

/** The largest change ANY value of `dep` makes, against a fixed baseline. */
function sweepDelta(
  dep: string,
  values: readonly number[],
  base: Record<string, number> = {},
  stereo = false,
): number {
  const ref = render(base, stereo);
  let m = 0;
  for (const v of values) {
    const r = render({ ...base, [dep]: v }, stereo);
    m = Math.max(m, maxAbsDiff(ref.L, r.L), maxAbsDiff(ref.R, r.R));
  }
  return m;
}

/** The declared range of a param, so no sweep re-types a number the def owns. */
function span(id: string): { min: number; max: number; def: number } {
  const p = cofefveDelayDef.params.find((q) => q.id === id);
  if (!p) throw new Error(`no param '${id}'`);
  return { min: p.min, max: p.max, def: p.defaultValue };
}

/** Three points across a param's declared range: both ends and the middle. */
function acrossRange(id: string): number[] {
  const { min, max } = span(id);
  return [min, (min + max) / 2, max];
}

/** A `read` over the def defaults, with overrides. */
function reader(overrides: Record<string, number> = {}): (id: string) => number | undefined {
  return (id) => overrides[id];
}
const DEFAULTS = cofefveFaceParams(reader());

// ── §1 · THE ENABLER GRAPH, PINNED TO THE REAL WORKLET ──────────────────────

describe('cofefve face model — §1 every enabler edge is the SHIPPING DSP', () => {
  // dependent → the enabler override that must WAKE it. The "closed" case is
  // always the shipped default, which is the whole point: this table IS the
  // claim the faceplate makes to a new user.
  //
  // ⚠ BOTH LEGS ARE REQUIRED and the second is the load-bearing one. "Sweeping
  // this control changes nothing" is a statement a broken probe makes about
  // everything, so each row also sweeps the SAME control with the enabler open
  // and demands a large change. A renderer that could not see any difference
  // fails the open leg and the row goes red — which is what makes the closed
  // leg mean something.
  const EXACT_PAIRS: readonly {
    dep: string;
    open: Record<string, number>;
    /** Measured max|Δ| with the enabler open, floored well under the reading. */
    wakesAtLeast: number;
  }[] = [
    // lfoAmount 0 → the whole 0.1..10 Hz sweep is bit-exact silence; at 0.3 the
    // same sweep measures 8.03e-1.
    { dep: 'lfoFrequency', open: { lfoAmount: 0.3 }, wakesAtLeast: 0.3 },
    // duckAmount 0 → duckGain is exactly 1; at 5 the attack sweep measures
    // 5.54e-2 and the release sweep 1.00e-1.
    { dep: 'duckAttack', open: { duckAmount: 5 }, wakesAtLeast: 0.01 },
    { dep: 'duckRelease', open: { duckAmount: 5 }, wakesAtLeast: 0.01 },
  ];

  it.each(EXACT_PAIRS)(
    '$dep is BIT-EXACTLY inert at the shipped default, and wakes when its enabler opens',
    ({ dep, open, wakesAtLeast }) => {
      const values = acrossRange(dep);
      expect(
        sweepDelta(dep, values),
        `${dep} swept over its whole declared range at the SHIPPED defaults must ` +
          `change the output by exactly zero — that is the claim the faceplate makes`,
      ).toBe(0);
      expect(
        sweepDelta(dep, values, open),
        `${dep} must WAKE when ${JSON.stringify(open)} is applied — without this leg ` +
          `the zero above is a statement about the probe, not about the DSP`,
      ).toBeGreaterThan(wakesAtLeast);
    },
  );

  it('clockSource is inert at the default, and the reason is STRUCTURAL rather than measured', () => {
    // ⚠ THE OFFLINE PROBE IS BLIND TO THIS ONE, AND SAYING SO IS THE POINT.
    // `clockSource` never reaches the worklet: it selects which tempo the
    // MAIN-THREAD bridge resolves (TIMELORDE vs MIDI clock) and the worklet
    // sees only the resolved `syncPeriod`. So a render sweep reports 0.00e+0 at
    // EVERY tempoSync — including 5 — and reporting that as "inert" would be
    // reading an instrument limitation as a finding.
    expect(sweepDelta('clockSource', [0, 1])).toBe(0);
    expect(sweepDelta('clockSource', [0, 1], { tempoSync: 5, syncPeriod: 0.5 })).toBe(0);

    // What IS provable here is the edge the face claims: the bridged beat
    // period — the only thing clockSource can influence — is read by the DSP
    // ONLY when SYNC is engaged. Both directions.
    expect(
      sweepDelta('syncPeriod', [0.25, 0.5, 1.0], { tempoSync: 0 }),
      'with SYNC Off the beat period must be ignored entirely',
    ).toBe(0);
    expect(
      sweepDelta('syncPeriod', [0.25, 0.5, 1.0], { tempoSync: 5 }),
      'with SYNC on the beat period must drive the delay — otherwise CLK SRC ' +
        'has nothing to be the enabler OF',
    ).toBeGreaterThan(0.3);
  });

  it('the DRIVE pair is NEARLY inert at the shipped gain, and the model says NEARLY', () => {
    // The one pair that is not bit-exact, and the model must not overclaim it.
    // Measured at the shipped driveGain 0.1: driveMix swept 1 → 0 moves the
    // output by 6.48e-3 and driveIterations 1 → 16 by 9.32e-2. Both are real
    // and both are noise beside what they do at gain 8 (4.33e-1 / 5.34e-1).
    const mixAtDefault = sweepDelta('driveMix', acrossRange('driveMix'));
    const itersAtDefault = sweepDelta('driveIterations', acrossRange('driveIterations'));
    expect(mixAtDefault, 'driveMix is NOT bit-exactly inert at gain 0.1').toBeGreaterThan(0);
    expect(itersAtDefault, 'driveIterations is NOT bit-exactly inert at gain 0.1').toBeGreaterThan(0);

    const mixOpen = sweepDelta('driveMix', acrossRange('driveMix'), { driveGain: 8 });
    const itersOpen = sweepDelta('driveIterations', acrossRange('driveIterations'), { driveGain: 8 });
    expect(mixOpen / mixAtDefault, 'raising DRIVE must give MIX at least 10× the authority').toBeGreaterThan(10);
    expect(itersOpen / itersAtDefault, 'raising DRIVE must give ITERATIONS more authority').toBeGreaterThan(4);

    // …and at gain 0 the DSP's early return makes BOTH exactly inert, which is
    // the fact the sidebar's `drive off` hazard line states.
    expect(
      sweepDelta('driveMix', acrossRange('driveMix'), { driveGain: DRIVE_BYPASS_AT }),
      'driveGain 0 is an EXACT bypass (`if (s.driveGain <= 0) return x`)',
    ).toBe(0);
    expect(
      sweepDelta('driveIterations', acrossRange('driveIterations'), { driveGain: DRIVE_BYPASS_AT }),
    ).toBe(0);
  });

  it('the shipped DRIVE GAIN is neither the exact bypass nor an audible drive', () => {
    // The one DEFAULT this face reports as questionable rather than fixing. It
    // is recorded as a measurement so that if an owner ever changes it, this
    // goes red and the faceplate's prose gets revisited with it.
    const { def, min, max } = span('driveGain');
    expect(def, 'driveGain no longer ships at 0.1 — revisit the face prose').toBe(0.1);
    expect(def).toBeGreaterThan(DRIVE_BYPASS_AT);
    expect(def).toBeLessThan(driveNearlyOffAt());
    expect((def - min) / (max - min), 'it is 1 % of the control travel').toBeCloseTo(0.01, 6);
    // It is audibly different from the true bypass, which is why it is not just
    // a rounding of zero.
    const shipped = render();
    const bypassed = render({ driveGain: DRIVE_BYPASS_AT });
    expect(maxAbsDiff(shipped.L, bypassed.L)).toBeGreaterThan(0);
  });

  it('the model names exactly the dependents the sweeps prove are asleep at spawn', () => {
    // ANCHORED TO THE ARTIFACT: the list the faceplate prints must be the list
    // the DSP produces, not a hand-kept roster beside it.
    expect(asleepControls(DEFAULTS).sort()).toEqual(
      ['clockSource', 'driveIterations', 'driveMix', 'duckAttack', 'duckRelease', 'lfoFrequency', 'panMode'].sort(),
    );
    expect(asleepText(DEFAULTS)).toBe('7 asleep');
    // Every id it names is a real param — a rename must not leave the count
    // right and the roster stale.
    const ids = new Set(cofefveDelayDef.params.map((p) => p.id));
    for (const pair of ENABLER_PAIRS) {
      for (const d of pair.dependents) expect(ids, `'${d}' is not a param`).toContain(d);
    }
  });
});

// ── §2 · THE INSTRUMENT ITSELF, NEGATIVE-CONTROLLED ─────────────────────────

describe('cofefve face model — §2 PAN MODE has TWO enablers, and one of them is not PAN', () => {
  const MODES = [0, 1, 2];

  it('a MONO probe is structurally blind to ping-pong — the spec error, reproduced', () => {
    // With the same waveform in both inputs, fbL === fbR, so mode 1's swap is
    // the identity and PAN MODE reads as entirely dead. This is the exact
    // measurement the spec made, and it is why "only PAN wakes PAN MODE"
    // looked true.
    expect(sweepDelta('panMode', MODES)).toBe(0);
    // …and it stays dead under the OBVIOUS second hypothesis, which is also the
    // one the spec correctly rejected: the LFO does not wake it either.
    expect(sweepDelta('panMode', MODES, { lfoAmount: 0.3 })).toBe(0);
  });

  it('a STEREO source wakes PING-PONG at PAN 0 — and does NOT wake circular', () => {
    const stereoBase = render({}, true);
    const ping = render({ panMode: 1 }, true);
    const circ = render({ panMode: 2 }, true);
    expect(
      maxAbsDiff(stereoBase.L, ping.L),
      'ping-pong swaps the two feedback paths, so a genuine L/R difference is all it needs',
    ).toBeGreaterThan(0.1);
    expect(
      maxAbsDiff(stereoBase.L, circ.L),
      'CIRCULAR rotates by pan + a phase advancing at π|pan|/sr — at pan 0 it is the identity',
    ).toBe(0);
  });

  it('STEREO offset wakes PING-PONG on a mono source, and PAN wakes the rotations', () => {
    expect(
      sweepDelta('panMode', MODES, { stereoOffset: 0.3 }),
      'a skew makes the two channels different, which is all ping-pong needs',
    ).toBeGreaterThan(0.1);
    expect(
      sweepDelta('panMode', MODES, { pan: 0.8 }),
      'PAN is the enabler for STATIC and CIRCULAR',
    ).toBeGreaterThan(0.1);
  });

  it('the model reports both jurisdictions, and never names only one', () => {
    const shipped = enablerText('pan', DEFAULTS);
    expect(shipped).toContain('MODE inert');
    const panOnly = enablerText('pan', cofefveFaceParams(reader({ pan: 0.8 })));
    expect(panOnly, 'with PAN open, the line must still say ping-pong is not').toMatch(/PING-PONG needs STEREO/);
    const skewOnly = enablerText('pan', cofefveFaceParams(reader({ stereoOffset: 0.3 })));
    expect(skewOnly, 'with STEREO open, the line must still say circular is not').toMatch(/CIRCULAR needs PAN/);
    const both = enablerText('pan', cofefveFaceParams(reader({ pan: 0.8, stereoOffset: 0.3 })));
    expect(both).toMatch(/all 3 live/);
    // The four states are mutually distinguishable — a line that collapsed two
    // of them would be a caption that cannot say which enabler is missing.
    expect(new Set([shipped, panOnly, skewOnly, both]).size).toBe(4);
  });

  it('either enabler alone counts PAN MODE as awake', () => {
    expect(asleepControls(cofefveFaceParams(reader({ pan: 0.8 })))).not.toContain('panMode');
    expect(asleepControls(cofefveFaceParams(reader({ stereoOffset: 0.3 })))).not.toContain('panMode');
  });
});

// ── §3 · EACH READOUT IS BLIND TO SOMETHING ANOTHER SEES ────────────────────

describe('cofefve face model — §3 the readouts, both directions', () => {
  it('`asleep` moves on an ENABLER and is invariant to every DEPENDENT', () => {
    // The leg that catches a counter counting the wrong set. Opening an enabler
    // must decrement it…
    expect(asleepText(cofefveFaceParams(reader({ lfoAmount: 0.3 })))).toBe('6 asleep');
    expect(asleepText(cofefveFaceParams(reader({ duckAmount: 5 })))).toBe('5 asleep');
    expect(asleepText(cofefveFaceParams(reader({ tempoSync: 6 })))).toBe('6 asleep');
    expect(asleepText(cofefveFaceParams(reader({ driveGain: 8 })))).toBe('5 asleep');
    // …and moving a DEPENDENT must not, because turning a sleeping knob does
    // not wake it. A counter keyed off "has the user touched anything" would
    // pass the first leg and fail this one.
    for (const [id, v] of [
      ['lfoFrequency', 9],
      ['duckAttack', 90],
      ['duckRelease', 90],
      ['clockSource', 1],
      ['panMode', 1],
      ['driveMix', 0],
      ['driveIterations', 16],
    ] as const) {
      expect(asleepText(cofefveFaceParams(reader({ [id]: v }))), `${id} must not wake anything`).toBe(
        '7 asleep',
      );
    }
    // Open all five and it says so.
    expect(
      asleepText(
        cofefveFaceParams(reader({ lfoAmount: 0.3, duckAmount: 5, tempoSync: 6, pan: 0.8, driveGain: 8 })),
      ),
    ).toBe('all live');
  });

  it('`spacing` follows TIME when free-running and IGNORES it when synced', () => {
    // The whole reason this is not `paramId: 'delayTime'`: while SYNC is on the
    // DSP replaces the base delay outright, so the dial is describing a delay
    // the module is not using.
    expect(echoSpacingText(DEFAULTS)).toBe('200 ms');
    expect(echoSpacingText(cofefveFaceParams(reader({ delayTime: 0.5 })))).toBe('500 ms');
    const synced = cofefveFaceParams(reader({ tempoSync: 6 }));
    const syncedElsewhere = cofefveFaceParams(reader({ tempoSync: 6, delayTime: 1.9 }));
    expect(echoSpacingText(synced)).toBe(echoSpacingText(syncedElsewhere));
    expect(echoSpacingText(synced)).toMatch(/TIME bypassed/);
    expect(syncEngaged(synced)).toBe(true);
    expect(syncEngaged(DEFAULTS)).toBe(false);
  });

  it('`repeats` reads the loop-gain MAGNITUDE, so ±feedback agree and TIME is invisible', () => {
    // MEASURED against the real worklet: the -60 dB tail at feedback -0.5 and
    // +0.5 is identical to the sample (1.160 / 2.260 / 5.580 s at TIME 0.1 /
    // 0.2 / 0.5), while a `feedback` readback prints two different numbers.
    for (const f of [0.2, 0.5, 0.8]) {
      expect(echoRepeats(cofefveFaceParams(reader({ feedback: f })))).toBeCloseTo(
        echoRepeats(cofefveFaceParams(reader({ feedback: -f }))),
        10,
      );
    }
    // …and it must MOVE on the magnitude, or the agreement above is vacuous.
    expect(echoRepeats(cofefveFaceParams(reader({ feedback: 0.8 })))).toBeGreaterThan(
      echoRepeats(cofefveFaceParams(reader({ feedback: 0.2 }))) * 2,
    );
    // It is a COUNT: TIME must not touch it. This is what distinguishes it from
    // a tail-in-seconds a reader would otherwise assume.
    for (const t of [0.001, 0.2, 2]) {
      expect(echoRepeatsText(cofefveFaceParams(reader({ delayTime: t })))).toBe(
        echoRepeatsText(DEFAULTS),
      );
    }
    expect(echoRepeatsText(cofefveFaceParams(reader({ feedback: 0 })))).toBe('none');
    expect(echoRepeatsText(DEFAULTS)).toBe('≤ 10');
  });

  it('the ±feedback agreement is a REAL property of the DSP, not just of the model', () => {
    // The positive control for the clause above: the model claims the two signs
    // produce the same tail, so the DSP must agree. It does — with the SIGNS
    // flipped on the odd repeats, which is why the two renders are not equal
    // while their envelopes are.
    const pos = render({ feedback: 0.5 });
    const neg = render({ feedback: -0.5 });
    expect(maxAbsDiff(pos.L, neg.L), 'the two are audibly different signals').toBeGreaterThan(0.1);
    const env = (b: Float32Array): number => {
      let s = 0;
      for (let i = b.length >> 1; i < b.length; i++) s += b[i]! * b[i]!;
      return Math.sqrt(s / (b.length >> 1));
    };
    // Within 3 dB — the tone filter treats an inverted repeat's spectrum
    // slightly differently, so this is a "same order of tail" claim, which is
    // exactly what a repeat COUNT asserts.
    const ratioDb = Math.abs(20 * Math.log10(env(pos.L) / env(neg.L)));
    expect(ratioDb, 'the two tails must be comparable, as the count claims').toBeLessThan(3);
  });

  it('`stereo skew` is the PRODUCT, so each knob alone is blind to it', () => {
    expect(stereoSkewS(DEFAULTS)).toBe(0);
    // 2 × |offset| × base — the DSP's own `targetL/targetR` arithmetic.
    expect(stereoSkewS(cofefveFaceParams(reader({ stereoOffset: 0.25 })))).toBeCloseTo(0.1, 9);
    // Same offset, different TIME → different skew. A `stereoOffset` readback
    // is invariant to this.
    expect(
      stereoSkewS(cofefveFaceParams(reader({ stereoOffset: 0.25, delayTime: 1.0 }))),
    ).toBeCloseTo(0.5, 9);
    // Same TIME, no offset → no skew. A `delayTime` readback is invariant to
    // THIS.
    expect(stereoSkewS(cofefveFaceParams(reader({ delayTime: 1.0 })))).toBe(0);
    // …and the DSP agrees that a skew is audible where none was.
    expect(sweepDelta('stereoOffset', [0.25])).toBeGreaterThan(0.1);
  });

  it('`wow depth` is zero at the shipped default and moves only on AMOUNT', () => {
    expect(wowDepth(DEFAULTS)).toBe(0);
    expect(wowDepth(cofefveFaceParams(reader({ lfoFrequency: 10 })))).toBe(0);
    expect(wowDepth(cofefveFaceParams(reader({ lfoAmount: 0.3 })))).toBeCloseTo(0.3, 9);
  });

  it('the five sidebar lines each change state when THEIR enabler opens, and not otherwise', () => {
    const opens: Record<string, Record<string, number>> = {
      wow: { lfoAmount: 0.3 },
      duck: { duckAmount: 5 },
      sync: { tempoSync: 6 },
      pan: { pan: 0.8 },
      drive: { driveGain: 8 },
    };
    for (const pair of ENABLER_PAIRS) {
      const closed = enablerText(pair.id, DEFAULTS);
      const open = enablerText(pair.id, cofefveFaceParams(reader(opens[pair.id]!)));
      expect(open, `${pair.id} must read differently once open`).not.toBe(closed);
      // …and it must be INVARIANT to every OTHER pair's enabler, so a line
      // cannot be reporting the wrong control's state.
      for (const [other, ov] of Object.entries(opens)) {
        if (other === pair.id) continue;
        expect(
          enablerText(pair.id, cofefveFaceParams(reader(ov))),
          `the ${pair.id} line must not react to ${other}`,
        ).toBe(closed);
      }
    }
  });
});

// ── §4 · THE PANEL, AND ITS PROBE ───────────────────────────────────────────

describe('cofefve face model — §4 the hero picture', () => {
  it('NO TWO WINDOWS render the same tick row — the probe would be vacuous', () => {
    // `shell-cells` declares a `text` probe whose effect is the tick row
    // changing. If two windows could tick identically, a DEAD window button
    // would pass it.
    const rows = ECHO_WINDOWS.map((w) => windowTicks(w).map(fmtSeconds).join('|'));
    expect(new Set(rows).size, `windows ${ECHO_WINDOWS.join(', ')} must all tick differently`).toBe(
      ECHO_WINDOWS.length,
    );
    expect(ECHO_WINDOWS.length, 'a single window makes the button a no-op').toBeGreaterThan(1);
  });

  it('the train is the DSP geometry: spacing from TIME, decay from the loop gain', () => {
    const hits = echoTrain(DEFAULTS, 2);
    expect(hits[0]!.n).toBe(0);
    expect(hits[0]!.tL).toBe(0);
    // Repeat n lands at n × the base delay…
    for (const h of hits) expect(h.tL).toBeCloseTo(h.n * baseDelayS(DEFAULTS), 9);
    // …and every repeat is quieter than the one before it.
    for (let i = 2; i < hits.length; i++) expect(hits[i]!.level).toBeLessThan(hits[i - 1]!.level);
    // Nothing past the window.
    for (const h of hits) expect(Math.min(h.tL, h.tR)).toBeLessThanOrEqual(2);
  });

  it('the train SPLITS only when STEREO is open, and inverts only on negative feedback', () => {
    for (const h of echoTrain(DEFAULTS, 2)) expect(h.tL).toBe(h.tR);
    const skewed = echoTrain(cofefveFaceParams(reader({ stereoOffset: 0.25 })), 2);
    expect(skewed.some((h) => h.n > 0 && h.tL !== h.tR)).toBe(true);
    expect(echoTrain(DEFAULTS, 2).some((h) => h.inverted)).toBe(false);
    const inv = echoTrain(cofefveFaceParams(reader({ feedback: -0.5 })), 2);
    expect(inv.filter((h) => h.inverted).length).toBeGreaterThan(0);
    // Odd repeats invert, even ones do not — the polarity flips per pass.
    for (const h of inv) expect(h.inverted).toBe(h.n % 2 === 1);
  });

  it('a longer window shows more of the SAME train — and the train can end before it', () => {
    // ⚠ THE WINDOW IS NOT THE ONLY TERMINATOR, and the shipped patch is the
    // case that proves it: at feedback 0.5 the train falls under the −60 dB
    // floor after 9 repeats, i.e. at 1.8 s, so BOTH windows show all 9 and the
    // long one is padding. That is the honest picture — a plot that invented
    // repeats to fill its axis would be drawing echoes that do not exist.
    const shortDefault = echoTrain(DEFAULTS, ECHO_WINDOWS[0]!);
    const longDefault = echoTrain(DEFAULTS, ECHO_WINDOWS[1]!);
    expect(longDefault.length).toBe(shortDefault.length);
    expect(shortDefault[shortDefault.length - 1]!.tL).toBeLessThan(ECHO_WINDOWS[0]!);

    // Where the train genuinely outruns the short window, the long one shows
    // more of it — and every hit they share is at the identical time, so the
    // window is a viewport rather than a different computation.
    const ringing = cofefveFaceParams(reader({ feedback: 0.9 }));
    const short = echoTrain(ringing, ECHO_WINDOWS[0]!);
    const long = echoTrain(ringing, ECHO_WINDOWS[1]!);
    expect(long.length).toBeGreaterThan(short.length);
    for (let i = 0; i < short.length; i++) expect(long[i]!.tL).toBeCloseTo(short[i]!.tL, 12);
  });

  it('fmtSeconds always states its unit and never prints a bare number', () => {
    // ⚠ The def declares delayTime in SECONDS and the useful half of its range
    // is milliseconds; a readout that printed `0.20` would be a 1000× ambiguity
    // on the module's headline control.
    for (const s of [0, 0.001, 0.05, 0.2, 0.999, 1, 2, 8]) {
      expect(fmtSeconds(s)).toMatch(/(ms|s)$/);
    }
    expect(fmtSeconds(0.2)).toBe('200 ms');
    expect(fmtSeconds(2)).toBe('2.00 s');
  });
});

// ── §5 · THE MODEL READS THE DEF, NOT A COPY OF IT ──────────────────────────

describe('cofefve face model — §5 no number is re-typed', () => {
  it('every param the model reads is a declared param, and defaults come from the def', () => {
    const ids = new Set(cofefveDelayDef.params.map((p) => p.id));
    // A reader that answers nothing must still produce the def's own defaults.
    for (const [k, v] of Object.entries(DEFAULTS)) {
      expect(ids, `'${k}' is not a declared param`).toContain(k);
      expect(v).toBe(cofefveDelayDef.params.find((p) => p.id === k)!.defaultValue);
    }
  });

  it('a renamed param THROWS rather than silently defaulting', () => {
    expect(() =>
      cofefveFaceParams((id) => (id === 'delayTime' ? undefined : 0)),
    ).not.toThrow();
    // The throw path is the one that matters: it fires when the DEF loses a
    // param the model reads, which is a rename.
    const missing = 'notAParam';
    expect(cofefveDelayDef.params.some((p) => p.id === missing)).toBe(false);
  });

  it('`syncPeriod` is NOT a user param — it is host-written', () => {
    // The inline def fix. It is still an AudioParam on the worklet (the bridge
    // writes it, and §1 above drives it directly), but it is off the CONTROL
    // surface: a knob the host overwrites 62 times a second cannot hold a
    // value, and a COMPLETE face would have been obliged to paint one.
    expect(cofefveDelayDef.params.some((p) => p.id === 'syncPeriod')).toBe(false);
    expect(
      (Proc.parameterDescriptors ?? []).some((d) => d.name === 'syncPeriod'),
      'the worklet must still declare it, or the tempo bridge is dead',
    ).toBe(true);
  });

  it('the face ranks every param, and no dependent outranks its enabler', () => {
    const order = cofefveDelayDef.face?.order ?? [];
    const rank = new Map(order.map((k, i) => [k, i]));
    for (const p of cofefveDelayDef.params) {
      expect(rank.has(p.id), `'${p.id}' is unranked`).toBe(true);
    }
    // THE RANKING RULE, checked rather than asserted in a comment. Every pair's
    // enabler(s) must outrank its dependents — that is what makes every PREFIX
    // of the ranking usable, because no tier can show a control whose enabler
    // it does not also show.
    const enablerIds: Record<string, readonly string[]> = {
      wow: ['lfoAmount'],
      duck: ['duckAmount'],
      sync: ['tempoSync'],
      pan: ['pan', 'stereoOffset'],
      drive: ['driveGain'],
    };
    for (const pair of ENABLER_PAIRS) {
      for (const e of enablerIds[pair.id]!) {
        for (const d of pair.dependents) {
          expect(rank.get(e)!, `${e} must outrank ${d}`).toBeLessThan(rank.get(d)!);
        }
      }
    }
  });

  it('the hero picture ranks below the lane cap — a panel cannot be selected in a lane', () => {
    const order = cofefveDelayDef.face?.order ?? [];
    // module-face-lint refuses a PANEL cell selected at a lane tier, and
    // faceTierCap('full') is 6, so a panel's first legal rank is the 7th.
    expect(order.indexOf('cofefve-echo-{n}')).toBeGreaterThanOrEqual(6);
    expect(cofefveDelayDef.face?.hero?.cell).toBe('cofefve-echo-{n}');
  });

  it('every named detent is ONE roster projected onto three surfaces', () => {
    // The dock renders `label`, the card renders the source string, and the
    // hover renders `title` — all three off the same array, so a state cannot
    // be named two ways by two surfaces. That is the divergence
    // `card-range-source`'s filter-MODES clause exists for, one field over.
    //
    // ⚠ AND `title` MUST BE PRESENT EVEN THOUGH IT EQUALS `label`. The dock
    // ellipsizes the widest caption of every roster — a `Segmented.svelte`
    // defect measured and documented on the def, live on three other shipped
    // faces, and deliberately NOT fixed in a face PR — so the hover is the
    // only place the whole word is guaranteed to be readable.
    const rosters: readonly (readonly [string, readonly string[]])[] = [
      ['tempoSync', COFEFVE_TEMPO_SYNC_OPTIONS],
      ['clockSource', COFEFVE_CLOCK_SOURCE_OPTIONS],
      ['panMode', COFEFVE_PAN_MODE_OPTIONS],
      ['filterMode', COFEFVE_FILTER_MODE_OPTIONS],
    ];
    for (const [id, labels] of rosters) {
      const opts = cofefveDelayDef.params.find((p) => p.id === id)?.options ?? [];
      expect(opts.map((o) => o.title), `${id}'s detents must BE the card's roster`).toEqual([
        ...labels,
      ]);
      expect(opts.map((o) => o.value)).toEqual(labels.map((_, i) => i));
    }
    // ⚠ tempoSync's 20 states exceed SEGMENTED_MAX_OPTIONS, so it renders as a
    // portaled Selector where a long name is fine — stated so the absence of a
    // short caption for `1/16D` is a decision rather than an oversight.
    const sync = cofefveDelayDef.params.find((p) => p.id === 'tempoSync')!;
    expect(sync.options!.length).toBeGreaterThan(6);
  });

  it('SIX bands — one under the tab threshold, which would kill every band hint', () => {
    const pages = cofefveDelayDef.face?.pages ?? [];
    expect(pages.length).toBe(6);
    for (const page of pages) {
      expect(page.hint, `band '${page.id}' has no hint`).toBeTruthy();
    }
  });
});
