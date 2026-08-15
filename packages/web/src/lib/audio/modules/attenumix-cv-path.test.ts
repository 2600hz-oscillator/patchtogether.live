// packages/web/src/lib/audio/modules/attenumix-cv-path.test.ts
//
// THE CV PATH IS REAL — the two-sided check nothing else in the tree makes.
//
// The defect class this exists for is #1661 (swolevco): a module DECLARED four
// CV param inputs, every declaration-reading gate was green, and all four were
// bit-exactly audio-inert because the handle published a `GainNode.gain` whose
// node output went nowhere. Only the KNOB path did anything — and the motorized
// fader still animated, so the UI actively told the player the cable worked.
//
// ATTENUMIX cannot fail that way *by the same mechanism* — its `cv1..cv4` are
// audio-rate WORKLET INPUTS, not `paramTarget` shadows — but it can fail by the
// index-drift mechanism, which nothing here was watching:
//
//   * the DEF's handle map says `cv1 → { node: worklet, input: 4 }`
//     (`attenumix.ts` factory), and
//   * the WORKLET reads `inputs[4]?.[0]` as cv1 (`packages/dsp/src/attenumix.ts`)
//
// Those are two sides of one contract and they are written in two files. Every
// existing gate reads ONE side: `attenumix.test.ts` and
// `art/scenarios/attenumix/mix-saturation.test.ts` exercise `attenumixMath`,
// which is a PURE-MATH MIRROR — it has no input indices at all, so a swap of
// `inputs[4]` and `inputs[5]` in the worklet is invisible to every one of them.
// `art/scenarios/attenumix/profile.test.ts` does render the real worklet, but
// it hand-writes the index array (`[in1, in2, in3, null, null, cv2, ...]`), so
// it agrees with the worklet by construction and never consults the def.
//
// This test DERIVES the index from the def's factory handle map and drives the
// REAL shipped worklet at that index. If they ever disagree, the CV knob a
// player patches lands on the wrong channel — or on nothing.
//
// Every leg carries its own control, because a bit-exact zero is what a BROKEN
// INSTRUMENT returns:
//   * POSITIVE CONTROL (knob): the same metric moves when the KNOB moves, so
//     the metric can see this control dimension at all.
//   * POSITIVE CONTROL (equivalence): CV and knob reach the SAME output, which
//     is the def's stated law `att = clamp(knob + cv, 0, 1)`.
//   * INSTRUMENT NEGATIVE CONTROL: with the channel's AUDIO input unpatched the
//     metric reads exactly 0 even at full CV — so it is reading the audio, not
//     leaking the CV into the observable.
//   * ISOLATION: cv_i moves channel i and NO other channel.

import { describe, expect, it, beforeAll, vi } from 'vitest';
import { attenumixDef } from './attenumix';
import type { ModuleNode } from '$lib/graph/types';

const SR = 48000;
const BLOCK = 128;
const FRAMES = 512;

// ── side A: the DEF's handle map, derived by running the real factory ───────

interface HandlePort { node: unknown; input?: number; param?: unknown }

let inputMap = new Map<string, HandlePort>();
let outputMap = new Map<string, { node: unknown; output?: number }>();
let workletOpts: { numberOfInputs?: number; numberOfOutputs?: number } = {};

// ── side B: the REAL shipped worklet processor class ────────────────────────

interface ProcLike {
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}
let Proc: (new () => ProcLike) | null = null;

beforeAll(async () => {
  // --- A: run the factory under a stub ctx and capture what it publishes.
  const params = new Map<string, { value: number; setValueAtTime: (v: number) => void }>();
  class FakeAudioWorkletNode {
    parameters = {
      get: (k: string) => {
        let p = params.get(k);
        if (!p) {
          p = {
            value: 0,
            setValueAtTime(v: number) {
              this.value = v;
            },
          };
          params.set(k, p);
        }
        return p;
      },
    };
    connect = vi.fn();
    disconnect = vi.fn();
    constructor(_c: unknown, _n: string, opts?: { numberOfInputs?: number; numberOfOutputs?: number }) {
      workletOpts = opts ?? {};
    }
  }
  (globalThis as unknown as { AudioWorkletNode: unknown }).AudioWorkletNode = FakeAudioWorkletNode;
  const ctx = {
    currentTime: 0,
    sampleRate: SR,
    audioWorklet: { addModule: vi.fn(async () => {}) },
  };
  const node = {
    id: 'attenumix-cv-path',
    type: 'attenumix',
    domain: 'audio',
    position: { x: 0, y: 0 },
    params: {},
    data: {},
  } as unknown as ModuleNode;
  const handle = await attenumixDef.factory(ctx as never, node);
  inputMap = handle.inputs as unknown as Map<string, HandlePort>;
  outputMap = handle.outputs as unknown as Map<string, { node: unknown; output?: number }>;

  // --- B: capture the shipped processor class through the registerProcessor shim.
  const g = globalThis as unknown as {
    sampleRate?: number;
    AudioWorkletProcessor?: unknown;
    registerProcessor?: (n: string, c: new () => ProcLike) => void;
  };
  g.sampleRate = SR;
  if (typeof g.AudioWorkletProcessor === 'undefined') g.AudioWorkletProcessor = class {};
  const prev = g.registerProcessor;
  let captured: (new () => ProcLike) | null = null;
  g.registerProcessor = (_n, ctor) => {
    captured = ctor;
  };
  try {
    // @ts-expect-error TS2306 — a worklet entry is a side-effect classic script with
    // no module shape; the ctor arrives via the registerProcessor shim above.
    await import('../../../../../dsp/src/attenumix');
  } finally {
    g.registerProcessor = prev;
  }
  if (!captured) throw new Error('attenumix worklet entry did not registerProcessor()');
  Proc = captured;
});

/** Pump the REAL processor through `process()` in 128-sample blocks.
 *  `inputs` is keyed by WORKLET INPUT INDEX; null = unpatched (the worklet
 *  sees `[]`, exactly as Web Audio delivers a disconnected input). */
function render(
  inputs: ReadonlyArray<number | null>,
  knobs: Record<string, number>,
): Record<string, Float32Array> {
  const proc = new Proc!();
  const names = ['out1', 'out2', 'out3', 'out4', 'mix'];
  const outs = names.map(() => new Float32Array(FRAMES));
  const pArr: Record<string, Float32Array> = {};
  for (const [k, v] of Object.entries(knobs)) pArr[k] = new Float32Array([v]);
  for (let start = 0; start < FRAMES; start += BLOCK) {
    const len = Math.min(BLOCK, FRAMES - start);
    const inBlocks: Float32Array[][] = inputs.map((v) =>
      v === null ? [] : [new Float32Array(len).fill(v)],
    );
    const outBlocks = names.map(() => new Float32Array(len));
    proc.process(inBlocks, outBlocks.map((b) => [b]), pArr);
    outBlocks.forEach((b, i) => outs[i]!.set(b, start));
  }
  const rec: Record<string, Float32Array> = {};
  names.forEach((n, i) => (rec[n] = outs[i]!));
  return rec;
}

/** The DC value the whole render settled at — attenumix is stateless per
 *  sample, so every sample is the same number and `max|x − x[0]|` proves it. */
function dc(buf: Float32Array): number {
  let drift = 0;
  for (let i = 0; i < buf.length; i++) drift = Math.max(drift, Math.abs(buf[i]! - buf[0]!));
  expect(drift, 'attenumix is stateless per sample: the DC render must not drift').toBe(0);
  return buf[0]!;
}

const CH = [1, 2, 3, 4] as const;

/** The worklet input index the DEF publishes for a port — the number a cable
 *  actually lands on, read off the factory rather than assumed. */
function idx(portId: string): number {
  const p = inputMap.get(portId);
  expect(p, `the def must publish an input handle for '${portId}'`).toBeDefined();
  return p!.input!;
}

function drive(overrides: Record<string, number>): Array<number | null> {
  const arr: Array<number | null> = [null, null, null, null, null, null, null, null];
  for (const [port, v] of Object.entries(overrides)) arr[idx(port)] = v;
  return arr;
}

describe('attenumix: the def↔worklet INPUT-INDEX contract (two-sided)', () => {
  it('publishes 8 inputs / 5 outputs and the worklet is built with the same counts', () => {
    expect(inputMap.size).toBe(attenumixDef.inputs.length);
    expect(outputMap.size).toBe(attenumixDef.outputs.length);
    expect(workletOpts.numberOfInputs).toBe(attenumixDef.inputs.length);
    expect(workletOpts.numberOfOutputs).toBe(attenumixDef.outputs.length);
  });

  it('every declared input maps to a DISTINCT worklet input index, and to the SAME node', () => {
    const seen = new Map<number, string>();
    for (const p of attenumixDef.inputs) {
      const h = inputMap.get(p.id);
      expect(h, `input '${p.id}' is declared but the factory publishes no handle`).toBeDefined();
      expect(
        h!.node,
        `'${p.id}' must land on the worklet itself — a handle whose node is anything else ` +
          `is the #1661 shape (a shadow node whose output reaches nothing)`,
      ).toBe(inputMap.get('in1')!.node);
      expect(typeof h!.input, `'${p.id}' must publish a numeric input index`).toBe('number');
      const clash = seen.get(h!.input!);
      expect(clash, `'${p.id}' and '${clash}' both claim worklet input ${h!.input}`).toBeUndefined();
      seen.set(h!.input!, p.id);
    }
  });

  it('NO attenumix input is a paramTarget shadow — so #1661 cannot apply by mechanism', () => {
    // The swolevco defect needs a handle carrying `.param`. If a future refactor
    // ever moves a cv port onto an AudioParam, this reddens and the author has to
    // come back and prove the shadow's OUTPUT is connected to something.
    const shadowed = attenumixDef.inputs
      .filter((p) => inputMap.get(p.id)?.param !== undefined)
      .map((p) => p.id);
    expect(shadowed).toEqual([]);
    const declaredTargets = attenumixDef.inputs
      .filter((p) => (p as { paramTarget?: string }).paramTarget !== undefined)
      .map((p) => p.id);
    expect(declaredTargets).toEqual([]);
  });
});

describe('attenumix: every declared CV input MOVES THE AUDIO through the CV path', () => {
  // att 0.25 with in 0.5 → out = 0.125; +0.5 of CV opens it to 0.75 → out = 0.375.
  const ATT = 0.25;
  const IN = 0.5;
  const CV = 0.5;
  const KNOBS0 = { att1: 0, att2: 0, att3: 0, att4: 0, master: 1 };

  for (const ch of CH) {
    it(`cv${ch} → the worklet input the DEF publishes → out${ch} and the mix`, () => {
      const knobs = { ...KNOBS0, [`att${ch}`]: ATT };
      const base = render(drive({ [`in${ch}`]: IN }), knobs);
      const cved = render(drive({ [`in${ch}`]: IN, [`cv${ch}`]: CV }), knobs);

      const baseOut = dc(base[`out${ch}`]!);
      const cvOut = dc(cved[`out${ch}`]!);
      expect(
        baseOut,
        `units: linear sample amplitude. out${ch} = in × clamp(att${ch} + cv${ch}, 0, 1)`,
      ).toBeCloseTo(IN * ATT, 12);
      expect(
        cvOut - baseOut,
        `cv${ch} (worklet input ${idx(`cv${ch}`)}) must move out${ch}: ` +
          `${baseOut} → ${cvOut} (linear amplitude)`,
      ).toBeCloseTo(IN * CV, 6);

      // the summing bus sees it too (tanh at master 1)
      const baseMix = dc(base.mix!);
      const cvMix = dc(cved.mix!);
      expect(baseMix, 'units: linear amplitude, mix = tanh(sum × master)').toBeCloseTo(
        Math.tanh(IN * ATT), 6,
      );
      expect(cvMix, 'units: linear amplitude').toBeCloseTo(Math.tanh(IN * (ATT + CV)), 6);
      expect(cvMix - baseMix, `cv${ch} must move the MIX bus, not only the direct out`)
        .toBeGreaterThan(0.2);

      // POSITIVE CONTROL — the KNOB moves the same metric, by the same amount.
      // Without this leg a dead CV and a dead METRIC print identically.
      const knobbed = render(drive({ [`in${ch}`]: IN }), { ...knobs, [`att${ch}`]: ATT + CV });
      const knobOut = dc(knobbed[`out${ch}`]!);
      expect(knobOut - baseOut, `positive control: the att${ch} KNOB must move out${ch} too`)
        .toBeCloseTo(IN * CV, 6);
      // EQUIVALENCE — the def's law is att = clamp(knob + cv, 0, 1), so a CV of
      // +0.5 and a knob raised by 0.5 must land on the SAME sample, bit-exactly.
      expect(
        cvOut,
        `att${ch} + cv${ch} is one sum: knob-at-${ATT + CV} and knob-at-${ATT}+cv-${CV} ` +
          `must be bit-identical (${knobOut} vs ${cvOut})`,
      ).toBe(knobOut);

      // INSTRUMENT NEGATIVE CONTROL — unpatch the channel's AUDIO and the same
      // metric must read EXACTLY 0 at full CV. A metric that still reads
      // something here is leaking the CV into the observable.
      const silent = render(drive({ [`cv${ch}`]: 1 }), { ...knobs, [`att${ch}`]: 1 });
      expect(
        dc(silent[`out${ch}`]!),
        `negative control: no audio on in${ch}, so out${ch} must be exactly 0 ` +
          `even with cv${ch} at full — the metric reads AUDIO, not CV`,
      ).toBe(0);
      expect(dc(silent.mix!)).toBe(0);
    });
  }

  it('a CV lands on ITS OWN channel only — no index cross-talk', () => {
    // Drive all four audio inputs equally with all four knobs equal, then raise
    // exactly one CV: only that channel's direct out may move. This is what
    // catches an index SWAP, which the pure-math mirror is structurally unable
    // to see (it has no indices).
    const knobs = { att1: 0.25, att2: 0.25, att3: 0.25, att4: 0.25, master: 1 };
    const allIn = { in1: IN, in2: IN, in3: IN, in4: IN };
    const base = render(drive(allIn), knobs);
    for (const ch of CH) {
      const one = render(drive({ ...allIn, [`cv${ch}`]: CV }), knobs);
      const moved = CH.filter((c) => dc(one[`out${c}`]!) !== dc(base[`out${c}`]!));
      expect(
        moved,
        `cv${ch} (worklet input ${idx(`cv${ch}`)}) must move channel ${ch} and nothing else`,
      ).toEqual([ch]);
    }
  });

  it('the CLAMP is real in the shipped worklet: knob+cv above 1 stops at unity, below 0 mutes', () => {
    const knobs = { att1: 0.8, att2: 0.8, att3: 0.8, att4: 0.8, master: 1 };
    // +0.5 on top of 0.8 would be 1.3; the clamp pins it at 1.0.
    const hot = render(drive({ in1: IN, cv1: 0.5 }), knobs);
    expect(dc(hot.out1!), 'clamp: attenuators never boost past unity').toBeCloseTo(IN, 12);
    // −1.0 on top of 0.8 would be −0.2; the clamp mutes rather than inverting.
    const cold = render(drive({ in1: IN, cv1: -1 }), knobs);
    expect(dc(cold.out1!), 'clamp: a negative knob+cv mutes, it does not phase-flip').toBe(0);
  });
});
