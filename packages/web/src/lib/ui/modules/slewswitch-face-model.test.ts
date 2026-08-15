// packages/web/src/lib/ui/modules/slewswitch-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS for SLEWSWITCH's faceplate (queue Q14).
//
// A derived readout is only worth publishing if it is checked on the input a
// KNOB READBACK WOULD BE BLIND TO — permanently, not once at authoring time
// (module-faceplates.md, the kick-drum TAIL trap). This file is that check for
// all nine of this face's readouts, plus the two claims the face's ranking
// rests on and the glyph decision, each driven against the REAL worklet where
// the claim is behavioural rather than arithmetic.
//
// WHAT IS ASSERTED, and why each one needs to be:
//
//  1. GLYPH. `primaryAudioOutPortId` returns NULL here and EVERY candidate
//     glyph would have resolved `{ kind: 'static' }` — so `glyph: 'none'` is a
//     decision, not an omission. Carried with a POSITIVE control, because a
//     null from a broken probe reads exactly like a null from a correct one.
//  2. THE OUTPUT TABLE is anchored to `outputs` in BOTH directions and in
//     order: seven jacks, seven rows, no count anywhere.
//  3. THE REACH MATRIX — for every (param, readout) pair, whether the param
//     moves the row. Deny-by-default over the FULL cross product, so a readout
//     that silently stopped depending on a dial reddens, and so does one that
//     started. This is the negative-control half that makes the positives mean
//     something.
//  4. THE LAP LAW against the real processor: EOC pulses counted over a clock
//     train in all three modes and at every length, compared with what the
//     faceplate prints. The face claims pendulum laps in 2(len-1); nothing else
//     in the tree checks that, and it is not a number either dial suggests.
//  5. THE RANKING'S TWO CLAIMS, both measured, because a rank defended by a
//     fact nobody checks is declaration order with a story attached:
//       (a) channel N is in the scan at (5-N) of the four LENGTH settings —
//           the reason the four "interchangeable" slew dials have an order;
//       (b) MODE / LENGTH / XFADE are bit-exactly inert with no `step_clock`
//           patched — the reason the whole switch half ranks below the slew
//           half.
//  6. TOTALITY. A readout runs on every render, so a throw takes the faceplate
//     down mid-drag: fresh node, NaN, ±Infinity and out-of-range all resolve to
//     a string.

import { describe, it, expect, beforeAll } from 'vitest';
import { slewSwitchDef, SLEWSWITCH_OUTPUT_READOUTS } from '$lib/audio/modules/slewswitch';
import {
  glyphBinding,
  primaryAudioOutPortId,
} from '$lib/ui/workflow/shell-glyph-live';
import { faceReadoutValueFor } from '$lib/ui/workflow/face-readout-values';
import {
  SETTLE_TAUS,
  SLEW_PARAM_IDS,
  activeLength,
  lapClocks,
  scanMode,
  slewSwitchFaceParams,
  slewSpread,
  slowestSettleS,
  stepIdxSpacing,
} from './slewswitch-face-model';

const SR = 48000;
const BLOCK = 128;

// ── the readout seam, exactly as the shell reaches it ────────────────────────

/** A param reader over a SPARSE overlay — the shape `node.params` really has. */
const reader = (over: Record<string, number> = {}) => (id: string) => over[id];

/** Resolve a readout through the REGISTRY, not by calling the model directly:
 *  that is the path ModuleShell takes, so a readout registered under the wrong
 *  id fails here rather than passing on a function nothing renders. */
function readout(valueId: string, over: Record<string, number> = {}): string {
  const fn = faceReadoutValueFor(valueId);
  if (!fn) throw new Error(`readout '${valueId}' is not registered`);
  return fn(reader(over));
}

const DEFAULTS: Record<string, number> = Object.fromEntries(
  slewSwitchDef.params.map((p) => [p.id, p.defaultValue]),
);

/** Every valueId this face publishes — hero rows plus the output table,
 *  DERIVED from the face itself rather than listed. */
const FACE_VALUE_IDS: readonly string[] = [
  ...new Set([
    ...(slewSwitchDef.face?.hero?.readouts ?? []).flatMap((r) => (r.valueId ? [r.valueId] : [])),
    ...SLEWSWITCH_OUTPUT_READOUTS.map((r) => r.valueId),
  ]),
];

// ── the real worklet, for the behavioural legs ───────────────────────────────

class StubAudioWorkletProcessor {
  readonly port = { onmessage: null as ((e: { data: unknown }) => void) | null, postMessage: () => {} };
}
type ProcInstance = {
  process: (i: Float32Array[][], o: Float32Array[][], p: Record<string, Float32Array>) => boolean;
};
type ProcCtor = new (opts?: { processorOptions?: { seed?: number } }) => ProcInstance;
let capturedProc: ProcCtor | null = null;

async function loadProcessor(): Promise<ProcCtor> {
  if (capturedProc) return capturedProc;
  const g = globalThis as unknown as {
    registerProcessor?: (n: string, c: ProcCtor) => void;
    AudioWorkletProcessor?: unknown;
    sampleRate?: number;
  };
  g.sampleRate = SR;
  const prevBase = g.AudioWorkletProcessor;
  g.AudioWorkletProcessor = StubAudioWorkletProcessor;
  const prev = g.registerProcessor;
  let registered: ProcCtor | null = null;
  g.registerProcessor = (_n, ctor) => { registered = ctor; };
  await import(/* @vite-ignore */ new URL('../../../../../dsp/src/slewswitch.ts', import.meta.url).href);
  g.registerProcessor = prev;
  g.AudioWorkletProcessor = prevBase;
  if (!registered) throw new Error('slewswitch processor did not register');
  capturedProc = registered;
  return capturedProc;
}

const OUT_NAMES = ['out1', 'out2', 'out3', 'out4', 'switched', 'step_idx', 'eoc'] as const;

/** Render the real processor with one clock pulse every `everyBlocks` blocks. */
async function renderClocked(opts: {
  clocks: number;
  everyBlocks?: number;
  mode?: number;
  length?: number;
  levels?: [number, number, number, number];
  /** Omit the clock entirely — the ENABLER leg. */
  noClock?: boolean;
  xfadeTime?: number;
}): Promise<Record<(typeof OUT_NAMES)[number], Float32Array>> {
  const Ctor = await loadProcessor();
  const proc = new Ctor({ processorOptions: { seed: 12345 } });
  const everyBlocks = opts.everyBlocks ?? 4;
  const blocks = (opts.clocks + 2) * everyBlocks;
  const levels = opts.levels ?? [0.2, 0.4, 0.6, 0.8];
  const params: Record<string, Float32Array> = {
    slew1: new Float32Array([0.001]), slew2: new Float32Array([0.001]),
    slew3: new Float32Array([0.001]), slew4: new Float32Array([0.001]),
    mode: new Float32Array([opts.mode ?? 0]),
    length: new Float32Array([opts.length ?? 4]),
    xfadeTime: new Float32Array([opts.xfadeTime ?? 0.001]),
  };
  const acc = Object.fromEntries(
    OUT_NAMES.map((n) => [n, new Float32Array(blocks * BLOCK)]),
  ) as Record<(typeof OUT_NAMES)[number], Float32Array>;
  const ins = levels.map((v) => new Float32Array(BLOCK).fill(v));
  for (let b = 0; b < blocks; b++) {
    const clk = new Float32Array(BLOCK);
    if (!opts.noClock && b > 0 && b % everyBlocks === 0 && b / everyBlocks <= opts.clocks) clk[0] = 1;
    const outs = OUT_NAMES.map(() => new Float32Array(BLOCK));
    proc.process(
      [[ins[0]!], [ins[1]!], [ins[2]!], [ins[3]!], [clk], [new Float32Array(BLOCK)]],
      outs.map((x) => [x]),
      params,
    );
    OUT_NAMES.forEach((n, k) => acc[n].set(outs[k]!, b * BLOCK));
  }
  return acc;
}

function risingEdges(x: Float32Array): number {
  let n = 0;
  for (let i = 1; i < x.length; i++) if (x[i - 1]! <= 0.5 && x[i]! > 0.5) n++;
  return n;
}

beforeAll(async () => { await loadProcessor(); });

// ── 1. the glyph ────────────────────────────────────────────────────────────

describe('slewSwitch face / the glyph is NONE, and every alternative was checked', () => {
  it('primaryAudioOutPortId is NULL — six cv outputs, one gate, no audio', () => {
    expect(primaryAudioOutPortId(slewSwitchDef)).toBeNull();
    // DERIVED, so the claim in the face comment cannot go stale silently: the
    // point is that NO output is typed audio, not that there are six of one
    // kind and one of another.
    expect(
      slewSwitchDef.outputs.filter((o) => o.type === 'audio').map((o) => o.id),
      'an `audio` output would make every glyph resolve live-audio and change this decision',
    ).toEqual([]);
  });

  it('POSITIVE CONTROL — the same probe DOES resolve a port on a def that has one', () => {
    // Without this, "null because there is no audio output" and "null because
    // the probe is broken" are the same output. Same function, same shape of
    // input, one audio output added.
    expect(
      primaryAudioOutPortId({ outputs: [...slewSwitchDef.outputs, { id: 'x', type: 'audio' }] }),
    ).toBe('x');
    expect(
      glyphBinding({
        face: { order: [], glyph: 'scope' },
        outputs: [{ id: 'x', type: 'audio' }],
      }),
    ).toEqual({ kind: 'live-audio', portId: 'x' });
  });

  it('EVERY candidate glyph would have resolved `static` on THIS def', () => {
    // The ninelives hazard with no escape hatch. ninelives could declare
    // 'waveform' honestly because it has a `shape` param 0..2 shared by all
    // nine taps; this module has no `shape`, no ADSR quartet and no
    // `algorithm`, so there is no honest picture at any setting.
    for (const glyph of ['scope', 'meter', 'waveform', 'envelope', 'algorithm'] as const) {
      expect(
        glyphBinding({ ...slewSwitchDef, face: { ...slewSwitchDef.face!, glyph } }),
        `glyph '${glyph}' on slewSwitch — a deterministic trace tapping nothing`,
      ).toEqual({ kind: 'static' });
    }
  });

  it('the DECLARED glyph resolves `none`, and the face declares exactly that', () => {
    expect(slewSwitchDef.face?.glyph).toBe('none');
    expect(glyphBinding(slewSwitchDef)).toEqual({ kind: 'none' });
  });

  it('NEGATIVE CONTROL on the `waveform` branch — a `shape` param WOULD change the answer', () => {
    // States what the 'static' above actually depends on. If someone later adds
    // a `shape` param 0..2 to this module, 'waveform' becomes honest and this
    // face should be revisited — so the dependency is asserted, not assumed.
    expect(
      glyphBinding({
        face: { order: [], glyph: 'waveform' },
        outputs: slewSwitchDef.outputs,
        params: [{ id: 'shape', min: 0, max: 2 }],
      }).kind,
    ).toBe('wave-morph');
  });
});

// ── 2. the output table ─────────────────────────────────────────────────────

describe('slewSwitch face / the output table is anchored to the declared jacks', () => {
  it('one row per jack, in order, BOTH directions', () => {
    expect(
      SLEWSWITCH_OUTPUT_READOUTS.map((r) => r.port),
      'the table and the def must name the same jacks in the same order',
    ).toEqual(slewSwitchDef.outputs.map((o) => o.id));
  });

  it('every row resolves a REGISTERED readout', () => {
    for (const r of SLEWSWITCH_OUTPUT_READOUTS) {
      expect(faceReadoutValueFor(r.valueId), `${r.port} → ${r.valueId}`).not.toBeNull();
    }
  });

  it('the sidebar the face declares IS this roster', () => {
    const block = slewSwitchDef.face?.sidebar?.[0];
    expect(block?.kind).toBe('readouts');
    expect(
      block?.kind === 'readouts' ? block.entries.map((e) => e.valueId) : [],
    ).toEqual(SLEWSWITCH_OUTPUT_READOUTS.map((r) => r.valueId));
  });

  it('the slew roster is non-vacuous and matches the def', () => {
    // Every "derived from the def" claim in the model is worthless if the
    // filter silently matches nothing.
    expect(SLEW_PARAM_IDS.length).toBeGreaterThan(0);
    expect(SLEW_PARAM_IDS).toEqual(
      slewSwitchDef.params.filter((p) => /^slew\d+$/.test(p.id)).map((p) => p.id),
    );
  });
});

// ── 3. the reach matrix ─────────────────────────────────────────────────────

describe('slewSwitch face / WHICH dial moves WHICH readout — the full cross product', () => {
  /** A perturbation big enough to move any row it can reach. */
  const PERTURB: Record<string, number> = {
    slew1: 5, slew2: 5, slew3: 5, slew4: 5,
    mode: 1, length: 2, xfadeTime: 2,
  };

  /** The EXPECTED reach, declared as data so the assertion below is over the
   *  whole cross product rather than a handful of spot checks. Every cell is a
   *  claim in both directions: `true` rows must move, `false` rows must NOT. */
  const REACH: Record<string, readonly string[]> = {
    slew1: ['slewswitch-settle', 'slewswitch-spread', 'slewswitch-slew1-settle'],
    slew2: ['slewswitch-settle', 'slewswitch-spread', 'slewswitch-slew2-settle'],
    slew3: ['slewswitch-settle', 'slewswitch-spread', 'slewswitch-slew3-settle'],
    slew4: ['slewswitch-settle', 'slewswitch-spread', 'slewswitch-slew4-settle'],
    // MODE reaches exactly ONE row of the nine.
    mode: ['slewswitch-lap'],
    length: ['slewswitch-lap', 'slewswitch-switched', 'slewswitch-step-idx'],
    // …and so does XFADE. Two dials, one row each, on a face with nine rows —
    // the table's own negative control on every run.
    xfadeTime: ['slewswitch-switched'],
  };

  it('every param has a declared reach row (deny-by-default over the def)', () => {
    expect(Object.keys(REACH).sort()).toEqual(slewSwitchDef.params.map((p) => p.id).sort());
  });

  it('the matrix holds in BOTH directions — moved rows move, unmoved rows do not', () => {
    const wrong: string[] = [];
    for (const p of slewSwitchDef.params) {
      const expected = new Set(REACH[p.id]!);
      for (const valueId of FACE_VALUE_IDS) {
        const before = readout(valueId, DEFAULTS);
        const after = readout(valueId, { ...DEFAULTS, [p.id]: PERTURB[p.id]! });
        const moved = before !== after;
        if (moved !== expected.has(valueId)) {
          wrong.push(
            `${p.id} → ${valueId}: ${moved ? 'MOVED' : 'did not move'} ` +
            `(expected ${expected.has(valueId) ? 'to move' : 'no change'}); ` +
            `'${before}' → '${after}'`,
          );
        }
      }
    }
    expect(wrong, `reach matrix violations:\n${wrong.join('\n')}`).toEqual([]);
  });

  it('SETTLE and SPREAD are each other\'s blind spot', () => {
    // The clap-q / clap-bandwidth-hz shape, stated as the two invariances that
    // make publishing BOTH worth more than publishing either.
    const base = { ...DEFAULTS, slew1: 0.1, slew2: 0.2, slew3: 0.4, slew4: 0.8 };
    // Scaling all four together: SETTLE moves, SPREAD cannot.
    const scaled = { ...base, slew1: 0.2, slew2: 0.4, slew3: 0.8, slew4: 1.6 };
    expect(readout('slewswitch-settle', scaled)).not.toBe(readout('slewswitch-settle', base));
    expect(readout('slewswitch-spread', scaled), 'spread is invariant to a uniform scale')
      .toBe(readout('slewswitch-spread', base));
    // Lowering only the FASTEST channel: SPREAD moves, SETTLE cannot.
    const faster = { ...base, slew1: 0.01 };
    expect(readout('slewswitch-spread', faster)).not.toBe(readout('slewswitch-spread', base));
    expect(readout('slewswitch-settle', faster), 'settle reads the SLOWEST channel only')
      .toBe(readout('slewswitch-settle', base));
  });

  it('SETTLE is 4.605x what the dial says — the readout the audit produced (#1712)', () => {
    // The whole reason this row exists: the dial and the answer differ by a
    // fixed factor at every position, and no control on the module prints it.
    expect(SETTLE_TAUS).toBeCloseTo(4.60517, 5);
    expect(slowestSettleS(slewSwitchFaceParams(reader(DEFAULTS))))
      .toBeCloseTo(0.5 * Math.log(100), 9);
    expect(readout('slewswitch-settle', DEFAULTS), 'at the shipped 0.5 s default').toBe('2.30 s');
    expect(readout('slewswitch-settle', { ...DEFAULTS, slew1: 5, slew2: 5, slew3: 5, slew4: 5 }))
      .toBe('23.03 s');
  });

  it('SPREAD names the flat case instead of printing 1.00x', () => {
    expect(readout('slewswitch-spread', DEFAULTS)).toBe('all alike');
    expect(slewSpread(slewSwitchFaceParams(reader(DEFAULTS)))).toBe(1);
    // Both branches of the formatter: two decimals below 10x, whole numbers
    // above, so a 3-decade span does not print as `10000.00× span`.
    expect(readout('slewswitch-spread', { ...DEFAULTS, slew4: 2 })).toBe('4.00× span');
    expect(readout('slewswitch-spread', { ...DEFAULTS, slew4: 5 })).toBe('10× span');
    expect(readout('slewswitch-spread', { ...DEFAULTS, slew1: 0.001, slew4: 5 }))
      .toBe('5000× span');
  });

  it('STEP IDX prints the spacing LENGTH changes, which no dial says', () => {
    const spacing = (length: number) => stepIdxSpacing(slewSwitchFaceParams(reader({ ...DEFAULTS, length })));
    expect(spacing(4)).toBeCloseTo(2 / 3, 9);
    expect(spacing(3)).toBe(1);
    expect(spacing(2)).toBe(2);
    expect(spacing(1), 'length 1 has no spread — the jack is a constant 0').toBe(0);
    expect(readout('slewswitch-step-idx', DEFAULTS)).toBe('4 steps, 0.667 apart');
    expect(readout('slewswitch-step-idx', { ...DEFAULTS, length: 1 })).toBe('flat at 0');
  });
});

// ── 4. the lap law, against the REAL processor ──────────────────────────────

describe('slewSwitch face / the LAP the panel prints is the EOC period the worklet emits', () => {
  // The face claims forward laps in `length` clocks, pendulum in 2(length-1),
  // random every step, and `held` at length 1. Only the first is obvious, and
  // NOTHING else in the tree checks the other three. Each is compared against
  // the pulses the shipped processor actually emits.
  const MODES = [
    { mode: 0, name: 'forward' as const },
    { mode: 1, name: 'pendulum' as const },
    { mode: 2, name: 'random' as const },
  ];

  it('the printed lap predicts the measured EOC count at every mode and length', async () => {
    const CLOCKS = 24;
    const rows: string[] = [];
    const wrong: string[] = [];
    for (const { mode, name } of MODES) {
      for (const length of [1, 2, 3, 4]) {
        const bufs = await renderClocked({ clocks: CLOCKS, mode, length });
        const measured = risingEdges(bufs.eoc);
        const p = slewSwitchFaceParams(reader({ ...DEFAULTS, mode, length }));
        const lap = lapClocks(p);
        expect(scanMode(p), `${name} @ len ${length}`).toBe(name);
        expect(activeLength(p)).toBe(length);
        // `null` = no cycle: `advance()` returns before arming the pulse.
        const predicted = lap === null ? 0 : Math.floor(CLOCKS / lap);
        rows.push(`${name} len${length}: lap=${lap ?? 'held'} predicted=${predicted} measured=${measured}`);
        if (measured !== predicted) {
          wrong.push(`${name} len${length}: printed lap ${lap ?? 'held'} ⇒ ${predicted} EOC, worklet emitted ${measured}`);
        }
      }
    }
    expect(wrong, `the faceplate's lap disagrees with the worklet:\n${rows.join('\n')}`).toEqual([]);
  });

  it('PENDULUM is 2(len-1), not `len` — the term neither dial suggests', async () => {
    // Called out separately because it is the whole reason `lap` is a derived
    // readout rather than a LENGTH readback: at length 4 the same dial gives 4
    // in forward and 6 in pendulum, and MODE reads a bare word in both.
    expect(readout('slewswitch-lap', { ...DEFAULTS, mode: 0, length: 4 })).toBe('4 clk');
    expect(readout('slewswitch-lap', { ...DEFAULTS, mode: 1, length: 4 })).toBe('6 clk');
    expect(readout('slewswitch-lap', { ...DEFAULTS, mode: 2, length: 4 })).toBe('every clk');
    expect(readout('slewswitch-lap', { ...DEFAULTS, length: 1 }), 'EOC never fires at length 1')
      .toBe('held');
    const held = await renderClocked({ clocks: 24, mode: 0, length: 1 });
    expect(risingEdges(held.eoc), 'length 1: advance() returns before arming the pulse').toBe(0);
  });
});

// ── 5. the ranking's two measured claims ────────────────────────────────────

describe('slewSwitch face / the RANKING rests on two facts, and both are measured', () => {
  it('channel N is in the scan at (5-N) of the four LENGTH settings', async () => {
    // WHY THE FOUR "INTERCHANGEABLE" SLEW DIALS HAVE AN ORDER. Driven by
    // reading which channel `switched` actually lands on over a full lap, with
    // the four inputs at distinct levels, so the claim is about the SHIPPED
    // scan and not about reading `advance()`.
    const LEVELS: [number, number, number, number] = [0.2, 0.4, 0.6, 0.8];
    const nearest = (v: number) =>
      LEVELS.reduce((best, c) => (Math.abs(c - v) < Math.abs(best - v) ? c : best));
    const inclusion: number[] = [];
    for (const ch of [0, 1, 2, 3]) {
      let lengthsIncluding = 0;
      for (const length of [1, 2, 3, 4]) {
        const bufs = await renderClocked({ clocks: 12, length, levels: LEVELS, everyBlocks: 4 });
        const seen = new Set<number>();
        for (let b = 1; b <= 13; b++) seen.add(nearest(bufs.switched[b * 4 * BLOCK - 1]!));
        if (seen.has(LEVELS[ch]!)) lengthsIncluding++;
      }
      inclusion.push(lengthsIncluding);
    }
    expect(inclusion, 'channels 1..4, counting the LENGTH settings that scan them')
      .toEqual([4, 3, 2, 1]);
    // …and that IS the face's rank order for the four dials.
    expect(slewSwitchDef.face?.order.slice(0, 4)).toEqual(SLEW_PARAM_IDS);
  });

  it('MODE / LENGTH / XFADE are bit-exactly inert with no clock patched', async () => {
    // WHY THE SWITCH HALF RANKS BELOW THE SLEW HALF. There is no internal
    // clock, so with `step_clock` unpatched none of the three changes a single
    // sample on any output — while the slew dials work with no cable but the
    // signal. Compared over EVERY output, not just `switched`.
    const base = await renderClocked({ clocks: 0, noClock: true });
    for (const variant of [
      { name: 'mode=random', mode: 2 },
      { name: 'mode=pendulum', mode: 1 },
      { name: 'length=2', length: 2 },
      { name: 'xfadeTime=2', xfadeTime: 2 },
    ]) {
      const other = await renderClocked({ clocks: 0, noClock: true, ...variant });
      for (const name of OUT_NAMES) {
        let peak = 0;
        for (let i = 0; i < base[name].length; i++) {
          peak = Math.max(peak, Math.abs(base[name][i]! - other[name][i]!));
        }
        expect(peak, `${variant.name} with no clock: peak |Δsample| on ${name}, linear CV units`)
          .toBe(0);
      }
    }
  });

  it('POSITIVE CONTROL — the same comparison DOES move once a clock is patched', async () => {
    // Otherwise the four zeros above are indistinguishable from a harness that
    // renders the same buffer twice.
    const fwd = await renderClocked({ clocks: 8, mode: 0 });
    const pnd = await renderClocked({ clocks: 8, mode: 1 });
    let peak = 0;
    for (let i = 0; i < fwd.switched.length; i++) {
      peak = Math.max(peak, Math.abs(fwd.switched[i]! - pnd.switched[i]!));
    }
    expect(peak, 'forward vs pendulum WITH a clock: peak |Δsample| on switched').toBeGreaterThan(0);
  });
});

// ── 6. totality ─────────────────────────────────────────────────────────────

describe('slewSwitch face / every readout is TOTAL — a throw takes the faceplate down', () => {
  const HOSTILE: Record<string, Record<string, number>> = {
    'a fresh node (no params at all)': {},
    NaN: Object.fromEntries(slewSwitchDef.params.map((p) => [p.id, NaN])),
    '+Infinity': Object.fromEntries(slewSwitchDef.params.map((p) => [p.id, Infinity])),
    '-Infinity': Object.fromEntries(slewSwitchDef.params.map((p) => [p.id, -Infinity])),
    'far out of range': Object.fromEntries(slewSwitchDef.params.map((p) => [p.id, 1e9])),
    'negative out of range': Object.fromEntries(slewSwitchDef.params.map((p) => [p.id, -1e9])),
  };

  it('resolves to a non-empty string under every hostile input', () => {
    for (const [label, over] of Object.entries(HOSTILE)) {
      for (const valueId of FACE_VALUE_IDS) {
        const out = readout(valueId, over);
        expect(typeof out, `${valueId} under ${label}`).toBe('string');
        expect(out.length, `${valueId} under ${label} must print something`).toBeGreaterThan(0);
      }
    }
  });

  it('a fresh node reads the DEF DEFAULTS, not zero', () => {
    // `node.params` is a sparse overlay, so "untouched" must mean "the value
    // the module actually spawned with".
    for (const valueId of FACE_VALUE_IDS) {
      expect(readout(valueId, {}), `${valueId} on a fresh node`).toBe(readout(valueId, DEFAULTS));
    }
  });
});
