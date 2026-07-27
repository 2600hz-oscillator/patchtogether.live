// packages/dsp/src/dx7-messages.test.ts
//
// The DX7 port protocol: `patch` is the ONE destructive message (preset LOAD);
// `voice` / `opParam` / `algorithm` / `feedback` are incremental and MUST NOT
// disturb a sounding voice. This is the gate for live operator editing — the
// operator view's whole premise is that nudging op 3's decay while you are
// holding a chord does not stop the chord.
//
// The two things this file exists to pin:
//
//   1. VALUE DOMAIN. The worklet stores DERIVED values (rateCoefs =
//      rateToCoef(raw), levels/outputAmp = levelToAmp(raw)), not the raw DX7
//      0..99 bytes. If `opParam` ever stored the raw byte you would get a
//      ~1000x envelope error. Rather than duplicating the transforms here
//      (a mirror can drift), every rate/level assertion is an EQUIVALENCE
//      against the trusted whole-patch path: `opParam r0=99` must land the
//      byte-identical coefficient that a full `{type:'patch'}` carrying
//      `r[0]=99` lands.
//
//   2. NON-DESTRUCTIVENESS, including `lastGate`. `lastGate` is the
//      load-bearing one, and the failure it causes is NOT "the note goes
//      silent" — §3 below pins the two real ones, measured, not assumed:
//        * applyPatch zeroes `lastGate`, and process()'s block-rate detector
//          reads a rising edge as `isGate && !wasGate`. A gate that is still
//          HELD therefore looks like a BRAND-NEW rising edge on the very next
//          block, so the note is HARD-RETRIGGERED — envelopes back to segment
//          0, phases back to 0, master VCA soft-retriggered, a fresh
//          startSample. Audibly: a click and a re-attack mid-chord.
//        * a lane already RELEASING is killed outright; no future edge exists
//          to revive it, so the tail is chopped.
//      Both are precisely what operator MUTE (`opParam field:'level' value:0`)
//      exists to avoid, since a mute button fires on every click.
//
// NEGATIVE CONTROL (how to prove these assertions bite): give applyOpParam the
// destructive tail applyPatch has -- deactivate every voice and zero
// `lastGate` -- i.e. make an operator edit behave exactly like a whole-patch
// re-send. Three tests then fail, including "opParam does not disturb ANY live
// voice state ... or lastGate" on lastGate[0] 1 -> 0 and every voice field.
// Verified before this file was committed; the diff + output are in the PR body.
//
// The worklet entry never top-level-exports its Processor class (that would
// break the ART harness's classic-script eval), so we capture it via a
// registerProcessor shim -- the cloudseed-seed.test.ts / mandelbulb-osc.test.ts
// pattern.

import { describe, it, expect, beforeAll } from 'vitest';

const SR = 48000;
const BLOCK = 128;
const NUM_OPS = 6;
const NUM_VOICES = 5;

// ---- the private shapes we reach into (TS `private` is compile-time only) ----

interface OpPatchView {
  rateCoefs: [number, number, number, number];
  levels: [number, number, number, number];
  ratio: number;
  detuneFactor: number;
  fixedMode: boolean;
  outputAmp: number;
}
interface VoiceStateView {
  active: boolean;
  startSample: number;
  phase: Float64Array;
  envValue: Float32Array;
  envSeg: Int32Array;
  releasing: boolean;
  fbMem: number;
  opOut: Float32Array;
  laneOwner: number;
  ampEnv: { state: number; value: number };
}
interface ProcInstance {
  port: { onmessage: ((e: { data: unknown }) => void) | null };
  process: (
    i: Float32Array[][],
    o: Float32Array[][],
    p: Record<string, Float32Array>,
  ) => boolean;
  patch: { algorithm: number; feedback: number; operators: OpPatchView[]; transpose: number };
  voices: VoiceStateView[];
  lastGate: Float32Array;
}
type ProcCtor = new (options?: { processorOptions?: unknown }) => ProcInstance;

let Dx7Processor: ProcCtor | null = null;

beforeAll(async () => {
  const g = globalThis as unknown as {
    sampleRate?: number;
    AudioWorkletProcessor?: unknown;
    registerProcessor?: (n: string, c: ProcCtor) => void;
  };
  g.sampleRate = SR;
  // ALWAYS install a port-having stub base (never `if undefined`): the dsp
  // suite runs single-fork, so another worklet test may already have installed
  // a PORT-LESS stub. dx7's ctor sets `this.port.onmessage`.
  g.AudioWorkletProcessor = class {
    port = { onmessage: null as unknown, postMessage: (): void => {} };
  };
  g.registerProcessor = (_n, ctor) => {
    Dx7Processor = ctor;
  };
  await import('./dx7');
  if (!Dx7Processor) throw new Error('dx7 processor did not register');
});

// ---- fixtures -------------------------------------------------------------

/** A serialized DX7Voice payload, in the shape sendPatch() posts. */
function makeVoice(over: Partial<{ algorithm: number; feedback: number; transpose: number }> = {}) {
  const op = (level: number) => ({
    r: [70, 60, 50, 40],
    l: [99, 80, 60, 0],
    ratio: 1,
    detune: 7,
    detuneFactor: 1,
    level,
    fixedMode: false,
    velocitySens: 0,
  });
  return {
    name: 'TEST VOICE',
    algorithm: over.algorithm ?? 5,
    feedback: over.feedback ?? 4,
    // all six operators audible so an op-level edit is observable
    operators: [op(99), op(90), op(80), op(70), op(60), op(50)],
    transpose: over.transpose ?? 24, // SYX 24 = no transpose
  };
}

function send(p: ProcInstance, data: unknown): void {
  p.port.onmessage?.({ data });
}

function makeParams(): Record<string, Float32Array> {
  return {
    voiceCount: new Float32Array([5]),
    level: new Float32Array([1]),
    transpose: new Float32Array([0]),
    attack: new Float32Array([0.001]),
    decay: new Float32Array([0.1]),
    sustain: new Float32Array([1]),
    release: new Float32Array([0.005]),
  };
}

/** 10-channel polyPitchGate block: lane 0 pitch = 0 V (C4), lane 0 gate = `gate`. */
function makeInputs(gate: number): Float32Array[][] {
  const poly: Float32Array[] = [];
  for (let ch = 0; ch < 10; ch++) poly.push(new Float32Array(BLOCK));
  poly[1]!.fill(gate);
  return [poly, [], []];
}

function render(p: ProcInstance, blocks: number, gate: number): Float32Array {
  const out = new Float32Array(BLOCK);
  const params = makeParams();
  const inputs = makeInputs(gate);
  for (let b = 0; b < blocks; b++) p.process(inputs, [[out]], params);
  return out;
}

/** Deep, comparable snapshot of everything a live voice owns + lastGate. */
function snapshotVoices(p: ProcInstance) {
  return {
    voices: p.voices.map((v) => ({
      active: v.active,
      startSample: v.startSample,
      phase: Array.from(v.phase),
      envValue: Array.from(v.envValue),
      envSeg: Array.from(v.envSeg),
      releasing: v.releasing,
      fbMem: v.fbMem,
      opOut: Array.from(v.opOut),
      laneOwner: v.laneOwner,
      ampEnvState: v.ampEnv.state,
      ampEnvValue: v.ampEnv.value,
    })),
    lastGate: Array.from(p.lastGate),
  };
}

/** A processor with a patch loaded and lane 0 mid-note (gate still HIGH). */
function bootWithHeldNote(): ProcInstance {
  const p = new Dx7Processor!();
  send(p, { type: 'patch', voice: makeVoice() });
  render(p, 8, 1); // gate high: note-on, envelopes running, phases advanced
  return p;
}

/** The coefficient/amplitude a full patch message lands for a given raw byte —
 *  the trusted reference the incremental path must reproduce exactly. */
function viaWholePatch(mutate: (v: ReturnType<typeof makeVoice>) => void): OpPatchView {
  const p = new Dx7Processor!();
  const v = makeVoice();
  mutate(v);
  send(p, { type: 'patch', voice: v });
  return p.patch.operators[0]!;
}

// ---- 1. VALUE DOMAIN ------------------------------------------------------

describe('dx7 opParam: value domain matches the whole-patch transform', () => {
  const RAW = [0, 1, 37, 50, 99] as const;

  for (const seg of [0, 1, 2, 3] as const) {
    it(`r${seg} stores rateToCoef(raw), not the raw byte`, () => {
      for (const raw of RAW) {
        const p = bootWithHeldNote();
        send(p, { type: 'opParam', op: 0, field: `r${seg}`, value: raw });
        const expected = viaWholePatch((v) => { v.operators[0]!.r[seg] = raw; }).rateCoefs[seg];
        expect(p.patch.operators[0]!.rateCoefs[seg]).toBe(expected);
        // and it is emphatically NOT the raw byte (the ~1000x error)
        if (raw > 0) expect(p.patch.operators[0]!.rateCoefs[seg]).not.toBe(raw);
      }
    });

    it(`l${seg} stores levelToAmp(raw), not the raw byte`, () => {
      for (const raw of RAW) {
        const p = bootWithHeldNote();
        send(p, { type: 'opParam', op: 0, field: `l${seg}`, value: raw });
        const expected = viaWholePatch((v) => { v.operators[0]!.l[seg] = raw; }).levels[seg];
        expect(p.patch.operators[0]!.levels[seg]).toBe(expected);
        expect(p.patch.operators[0]!.levels[seg]).toBeLessThanOrEqual(1);
      }
    });
  }

  it('level stores levelToAmp(raw) into outputAmp', () => {
    for (const raw of RAW) {
      const p = bootWithHeldNote();
      send(p, { type: 'opParam', op: 0, field: 'level', value: raw });
      const expected = viaWholePatch((v) => { v.operators[0]!.level = raw; }).outputAmp;
      expect(p.patch.operators[0]!.outputAmp).toBe(expected);
    }
  });

  it('MUTE — level 0 zeroes outputAmp and silences that operator only', () => {
    const p = bootWithHeldNote();
    const before = p.patch.operators.map((o) => o.outputAmp);
    send(p, { type: 'opParam', op: 2, field: 'level', value: 0 });
    expect(p.patch.operators[2]!.outputAmp).toBe(0);
    for (let i = 0; i < NUM_OPS; i++) {
      if (i !== 2) expect(p.patch.operators[i]!.outputAmp).toBe(before[i]);
    }
  });

  it('ratio + detuneFactor are stored VERBATIM (the host already resolved them)', () => {
    const p = bootWithHeldNote();
    send(p, { type: 'opParam', op: 3, field: 'ratio', value: 3.06 });
    send(p, { type: 'opParam', op: 3, field: 'detuneFactor', value: 1.0034 });
    expect(p.patch.operators[3]!.ratio).toBe(3.06);
    expect(p.patch.operators[3]!.detuneFactor).toBe(1.0034);
  });

  it('fixedMode is coerced 0/1 → boolean', () => {
    const p = bootWithHeldNote();
    expect(p.patch.operators[1]!.fixedMode).toBe(false);
    send(p, { type: 'opParam', op: 1, field: 'fixedMode', value: 1 });
    expect(p.patch.operators[1]!.fixedMode).toBe(true);
    send(p, { type: 'opParam', op: 1, field: 'fixedMode', value: 0 });
    expect(p.patch.operators[1]!.fixedMode).toBe(false);
  });

  it('edits the ADDRESSED operator only', () => {
    const p = bootWithHeldNote();
    const others = [0, 1, 2, 3, 5].map((i) => ({ ...p.patch.operators[i]! }));
    send(p, { type: 'opParam', op: 4, field: 'ratio', value: 7 });
    expect(p.patch.operators[4]!.ratio).toBe(7);
    [0, 1, 2, 3, 5].forEach((i, k) => {
      expect(p.patch.operators[i]!.ratio).toBe(others[k]!.ratio);
      expect(p.patch.operators[i]!.outputAmp).toBe(others[k]!.outputAmp);
    });
  });

  it('ignores an out-of-range op index, an unknown field and a non-finite value', () => {
    const p = bootWithHeldNote();
    const before = p.patch.operators.map((o) => ({ ...o }));
    send(p, { type: 'opParam', op: 6, field: 'level', value: 0 });
    send(p, { type: 'opParam', op: -1, field: 'level', value: 0 });
    send(p, { type: 'opParam', op: 0, field: 'nope', value: 0 });
    send(p, { type: 'opParam', op: 0, field: 'ratio', value: Number.NaN });
    p.patch.operators.forEach((o, i) => {
      expect(o.ratio).toBe(before[i]!.ratio);
      expect(o.outputAmp).toBe(before[i]!.outputAmp);
      expect(o.rateCoefs).toEqual(before[i]!.rateCoefs);
    });
  });
});

// ---- 2. NON-DESTRUCTIVENESS (the load-bearing half) -----------------------

describe('dx7 incremental messages do not disturb live voices', () => {
  it('the fixture really is mid-note (so the assertions below can bite)', () => {
    const p = bootWithHeldNote();
    const v = p.voices[0]!;
    expect(v.active, 'voice 0 is sounding').toBe(true);
    expect(v.laneOwner).toBe(0);
    expect(p.lastGate[0], 'gate is latched HIGH').toBeGreaterThan(0.5);
    expect(Math.max(...Array.from(v.envValue)), 'envelopes are open').toBeGreaterThan(0);
    expect(Math.max(...Array.from(v.phase)), 'phases have advanced').toBeGreaterThan(0);
    expect(Math.abs(v.fbMem) + Math.max(...Array.from(v.opOut).map(Math.abs)))
      .toBeGreaterThan(0);
    expect(v.ampEnv.value, 'the master VCA is open').toBeGreaterThan(0);
  });

  it('opParam does not disturb ANY live voice state (phase/envValue/envSeg/releasing/fbMem/opOut/laneOwner/ampEnv) or lastGate', () => {
    const p = bootWithHeldNote();
    const before = snapshotVoices(p);
    // every field the protocol carries, including the MUTE gesture
    send(p, { type: 'opParam', op: 0, field: 'r0', value: 12 });
    send(p, { type: 'opParam', op: 1, field: 'r3', value: 88 });
    send(p, { type: 'opParam', op: 2, field: 'l0', value: 40 });
    send(p, { type: 'opParam', op: 3, field: 'l3', value: 70 });
    send(p, { type: 'opParam', op: 4, field: 'ratio', value: 2.5 });
    send(p, { type: 'opParam', op: 4, field: 'detuneFactor', value: 0.997 });
    send(p, { type: 'opParam', op: 5, field: 'fixedMode', value: 1 });
    send(p, { type: 'opParam', op: 2, field: 'level', value: 0 }); // MUTE
    expect(snapshotVoices(p)).toEqual(before);
  });

  it('algorithm + feedback do not disturb live voice state or lastGate', () => {
    const p = bootWithHeldNote();
    const before = snapshotVoices(p);
    send(p, { type: 'algorithm', value: 32 });
    send(p, { type: 'feedback', value: 7 });
    expect(snapshotVoices(p)).toEqual(before);
  });

  it('a `voice` message re-applies the whole patch WITHOUT resetting', () => {
    const p = bootWithHeldNote();
    const before = snapshotVoices(p);
    send(p, { type: 'voice', voice: makeVoice({ algorithm: 12, feedback: 7 }) });
    expect(p.patch.algorithm, 'the patch really was re-applied').toBe(12);
    expect(p.patch.feedback).toBeCloseTo(1, 12);
    expect(snapshotVoices(p)).toEqual(before);
  });

  it('a held note keeps SOUNDING across an opParam edit (no re-gate needed)', () => {
    const p = bootWithHeldNote();
    send(p, { type: 'opParam', op: 1, field: 'level', value: 0 }); // mute one modulator
    const out = render(p, 4, 1); // gate STILL high — never released
    let peak = 0;
    for (const s of out) peak = Math.max(peak, Math.abs(s));
    expect(peak, 'still audible after the edit').toBeGreaterThan(1e-4);
    expect(p.voices[0]!.active).toBe(true);
    expect(p.voices[0]!.releasing).toBe(false);
  });

  it('an opParam edit is AUDIBLE on the very next block', () => {
    const a = bootWithHeldNote();
    const b = bootWithHeldNote();
    // mute every carrier-capable operator on `b`
    for (let i = 0; i < NUM_OPS; i++) send(b, { type: 'opParam', op: i, field: 'level', value: 0 });
    const outA = render(a, 1, 1);
    const outB = render(b, 1, 1);
    let peakA = 0;
    let peakB = 0;
    for (let i = 0; i < BLOCK; i++) {
      peakA = Math.max(peakA, Math.abs(outA[i]!));
      peakB = Math.max(peakB, Math.abs(outB[i]!));
    }
    expect(peakA).toBeGreaterThan(1e-4);
    expect(peakB).toBeLessThan(peakA);
  });
});

// ---- 3. `patch` STAYS destructive (the counterpart the split depends on) ---

describe('dx7 patch message remains the destructive preset-LOAD path', () => {
  it('resets every voice AND zeroes lastGate — the behaviour opParam exists to avoid', () => {
    const p = bootWithHeldNote();
    expect(p.voices[0]!.active).toBe(true);
    expect(p.lastGate[0]).toBeGreaterThan(0.5);

    send(p, { type: 'patch', voice: makeVoice({ algorithm: 9 }) });

    for (const v of p.voices) {
      expect(v.active).toBe(false);
      expect(v.releasing).toBe(false);
      expect(v.laneOwner).toBe(-1);
      expect(v.fbMem).toBe(0);
      expect(v.ampEnv.value).toBe(0);
      for (let i = 0; i < NUM_OPS; i++) {
        expect(v.envValue[i]).toBe(0);
        expect(v.envSeg[i]).toBe(0);
        expect(v.phase[i]).toBe(0);
        expect(v.opOut[i]).toBe(0);
      }
    }
    for (let i = 0; i < NUM_VOICES; i++) expect(p.lastGate[i]).toBe(0);
  });

  it('a still-HELD gate is re-read as a fresh rising edge → the note HARD-RETRIGGERS', () => {
    // The measured failure mode, and the reason operator MUTE may not use this
    // message. Zeroing `lastGate` does NOT leave the note dead — it makes the
    // unchanged, still-high gate look like a brand-new note-on, so the note
    // re-articulates from the attack with a click.
    const p = bootWithHeldNote();
    const v = p.voices[0]!;
    const envBefore = v.envValue[0]!;
    const startBefore = v.startSample;
    expect(envBefore, 'the note is well into its envelope').toBeGreaterThan(0.5);

    send(p, { type: 'patch', voice: makeVoice() });
    render(p, 1, 1); // ONE block, gate never released

    const after = p.voices[0]!;
    expect(after.active, 'the lane re-triggered rather than staying dead').toBe(true);
    expect(after.startSample, 'a FRESH note-on was fired (new startSample)')
      .toBeGreaterThan(startBefore);
    expect(after.envValue[0]!, 're-attacking from 0, not continuing').toBeLessThan(envBefore);
    expect(Array.from(after.envSeg), 'back in the attack segment').toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('a lane already RELEASING is killed outright by a patch reset — the tail is chopped', () => {
    const p = bootWithHeldNote();
    render(p, 2, 0); // gate falls: the note is ringing out its release
    expect(p.voices[0]!.active).toBe(true);
    expect(p.voices[0]!.releasing).toBe(true);

    send(p, { type: 'patch', voice: makeVoice() });
    render(p, 8, 0); // gate stays low — no edge is ever available to revive it
    expect(p.voices.some((v) => v.active), 'the releasing tail never comes back').toBe(false);
  });

  it('...and `voice` / `opParam` do NEITHER of those things to the same held note', () => {
    const p = bootWithHeldNote();
    const startBefore = p.voices[0]!.startSample;
    const envBefore = p.voices[0]!.envValue[0]!;
    send(p, { type: 'opParam', op: 2, field: 'level', value: 0 }); // MUTE op 3
    send(p, { type: 'voice', voice: makeVoice() });
    render(p, 1, 1);
    const after = p.voices[0]!;
    expect(after.active).toBe(true);
    expect(after.startSample, 'no fresh note-on was fired').toBe(startBefore);
    expect(after.envValue[0]!, 'the envelope kept RISING, it did not re-attack')
      .toBeGreaterThan(envBefore);
  });
});

// ---- 4. algorithm / feedback payload handling -----------------------------

describe('dx7 algorithm + feedback messages', () => {
  it('algorithm clamps + rounds to 1..32 and lands on this.patch.algorithm', () => {
    const p = bootWithHeldNote();
    for (const [sent, want] of [[1, 1], [32, 32], [17.4, 17], [17.6, 18], [99, 32], [-3, 1]] as const) {
      send(p, { type: 'algorithm', value: sent });
      expect(p.patch.algorithm).toBe(want);
    }
  });

  it('algorithm takes effect on the next render block (process re-reads it)', () => {
    const p = bootWithHeldNote();
    send(p, { type: 'algorithm', value: 1 });
    const outA = Array.from(render(p, 1, 1));
    const q = bootWithHeldNote();
    send(q, { type: 'algorithm', value: 32 }); // all six ops are carriers
    const outB = Array.from(render(q, 1, 1));
    let diff = 0;
    for (let i = 0; i < BLOCK; i++) diff += Math.abs(outA[i]! - outB[i]!);
    expect(diff, 'alg 1 vs alg 32 render differently').toBeGreaterThan(1e-3);
  });

  it('feedback is stored NORMALIZED (÷7), clamped to 0..7', () => {
    const p = bootWithHeldNote();
    send(p, { type: 'feedback', value: 0 });
    expect(p.patch.feedback).toBe(0);
    send(p, { type: 'feedback', value: 7 });
    expect(p.patch.feedback).toBeCloseTo(1, 12);
    send(p, { type: 'feedback', value: 4 });
    expect(p.patch.feedback).toBeCloseTo(4 / 7, 12);
    send(p, { type: 'feedback', value: 99 });
    expect(p.patch.feedback).toBeCloseTo(1, 12);
    send(p, { type: 'feedback', value: -5 });
    expect(p.patch.feedback).toBe(0);
  });

  it('ignores a null/unknown message without throwing', () => {
    const p = bootWithHeldNote();
    const before = snapshotVoices(p);
    expect(() => {
      send(p, null);
      send(p, undefined);
      send(p, { type: 'nonsense' });
      send(p, {});
    }).not.toThrow();
    expect(snapshotVoices(p)).toEqual(before);
  });
});
