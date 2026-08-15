// art/scenarios/cv-display-param-reach/cv-display-param-reach.test.ts
//
// CV REACH FOR *DISPLAY* PARAMS — "does a cable patched into this input reach
// the number the module actually DRAWS with?"
//
// ---------------------------------------------------------------------------
// WHY A SECOND SWEEP (#1664)
// ---------------------------------------------------------------------------
//
// `cv-param-reach` measures RENDERED AUDIO, and says so: its own header names
// "NON-AUDIO CONSUMERS" as a structural blind spot — "a param whose only
// consumer is the CARD, a video output, or a MIDI stream is invisible here even
// when its CV path is perfect."
//
// SCOPE and RASTERIZE are exactly that shape. Every one of their 13 CV inputs
// drives a DISPLAY parameter: a timebase, a vertical scale, a scan cursor. None
// of them touches audio, ON PURPOSE — SCOPE's own docs promise "Display-only —
// none of the controls touch the audio path", and RASTERIZE's THRU is
// documented as "the input signal unchanged".
//
// So on the audio metric a correctly-fixed SCOPE reads 0.0000e+0 on BOTH legs,
// which is that sweep's honest "the instrument cannot see this control" state
// and not a pass. This file supplies the observable it cannot: the module's own
// `read('drawParams')` — the very record its painter and its video bridge draw
// from — measured across a real `OfflineAudioContext` render.
//
// ---------------------------------------------------------------------------
// WHAT IT ASSERTS, per (module, port)
// ---------------------------------------------------------------------------
//
//   REACH        a ConstantSource wired the way `AudioEngine.addEdge` wires one
//                (engine.ts, the `din.param` branch) moves that port's draw
//                param to knob + cable — through the WHOLE delivery chain the
//                app uses: cable → the port's own AudioParam AND the per-port
//                tap analyser `addEdge` tees off it, `readParam`'s
//                `knob + tap sample` arithmetic, the card's push, and finally
//                the module's draw record. No step is stubbed.
//   KNOB         `setParam` at the same effective value lands on the same
//                number — the two legs meet at ONE junction rather than racing.
//   NO CROSSTALK  a cable on port P moves ONLY P's draw param. This is the
//                #1664 aliasing class measured in VALUES rather than in object
//                identity: nine SCOPE ports once published one `gain1.gain`.
//   AUDIO INERT   the module's audio outputs are BIT-IDENTICAL with and without
//                the cable. This is the leg that would have caught the headline
//                defect: `rasterize.cursor` took a ±0.5 signal to ±314 600 —
//                a 629 000× blow-up down THRU toward the speaker bus — because
//                the published AudioParam was the live passthrough gain.
//
// ---------------------------------------------------------------------------
// MEMBERSHIP IS DERIVED, AND SO IS THE PORT LIST
// ---------------------------------------------------------------------------
//
// There is no list of modules here. A def is enrolled iff its materialised
// handle answers `read('drawParams')` with an object — a property of the
// ARTIFACT, re-derived every run. Its keys are then asserted to be EXACTLY the
// `paramTarget`s of its CV inputs, both directions, so neither a new port
// without a draw param nor a draw param without a port can pass unnoticed.
//
// ---------------------------------------------------------------------------
// WHAT THIS GATE STRUCTURALLY CANNOT SEE
// ---------------------------------------------------------------------------
//
//  1. WHETHER THE PICTURE IS RIGHT. It asserts the NUMBER the painter is handed,
//     not the pixels it produces. A draw routine that ignored `timeMs` entirely
//     would still pass here; VRT owns that.
//  2. MODULES THAT DO NOT EXPOSE `drawParams`. A module could apply a
//     JS-consumed param without publishing it, and it would simply not be
//     enrolled. That hole is why the CONTROLS below are permanent legs rather
//     than setup: the negative control is a def built the #1664 way, and it must
//     FAIL the same predicates the real modules pass.
//  3. THE MAIN-THREAD PATH. The push and `read('drawParams')` happen here after
//     `startRendering()` returns; the browser does both on a rAF tick. So this
//     proves the chain COMPUTES the right number, not that a card is ticking.
//     ⚠ Concretely: a module whose card is unmounted or collapsed has nobody
//     pushing, and its video-out then renders the KNOB. That is a real gap this
//     gate cannot see, and it is the price of not owning a per-port analyser.
//  4. THE ENGINE'S OWN ARITHMETIC. `AudioEngine.readParam` is REPLICATED here
//     (knob + tap tail) rather than called, because the engine needs a live
//     AudioContext and a graph. If the engine changed that formula this gate
//     would keep passing; `engine-cv-scale` / the per-port sweeps own that.

import { describe, expect, it, beforeAll } from 'vitest';
import { OfflineAudioContext } from 'node-web-audio-api';
import { collectAudioDefs } from '../../../packages/web/src/lib/audio/modules';
import type { AudioModuleDef } from '../../../packages/web/src/lib/audio/module-registry';
import { isVideoCableType } from '../../../packages/web/src/lib/graph/types';
import { vcoTestSignal, gateTrain, triggerTrain, clockTrain, C4_HZ } from '../../setup/drivers';

const SR = 48_000;
/** Long enough for the analyser ring the shadows are read from to be full of
 *  rendered signal (32 samples ≈ 0.67 ms), short enough to stay cheap. */
const DURATION_S = 0.05;

/** Relative tolerance for a value that made a round trip through a
 *  Float32Array analyser buffer. `rasterize.cursor` probes at 629 145.6, which
 *  is not representable in f32 — an ABSOLUTE tolerance would either fail there
 *  or be meaninglessly loose on `intensity` (0..1). */
const REL_TOL = 1e-6;

function expectClose(actual: number, expected: number, what: string): void {
  const tol = REL_TOL * Math.max(1, Math.abs(expected));
  expect(
    Math.abs(actual - expected),
    `${what}: got ${actual}, want ${expected} (±${tol}, absolute units of the param; `
      + 'the round trip is through a Float32Array analyser buffer)',
  ).toBeLessThanOrEqual(tol);
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function audioIshOutputs(def: AudioModuleDef): string[] {
  return def.outputs
    .filter((o) => !isVideoCableType(o.type) && !/midi/i.test(String(o.type)))
    .map((o) => o.id);
}

/** The same driver vocabulary `cv-param-reach` uses, so "driven" means one
 *  thing across the lane. */
function driverFor(type: string, edge: string | undefined): Float32Array | null {
  if (type === 'audio') {
    return vcoTestSignal({ totalS: DURATION_S, freqHz: C4_HZ, shape: 'saw', sampleRate: SR });
  }
  if (type === 'gate') {
    return edge === 'trigger'
      ? triggerTrain({ totalS: DURATION_S, bpm: 480, sampleRate: SR })
      : gateTrain({ totalS: DURATION_S, bpm: 480, gateS: 0.02, sampleRate: SR });
  }
  if (type === 'clock') return clockTrain(DURATION_S, SR);
  if (type === 'cv') {
    const b = new Float32Array(Math.round(SR * DURATION_S));
    for (let i = 0; i < b.length; i++) b[i] = Math.sin((2 * Math.PI * 3 * i) / SR);
    return b;
  }
  return null;
}

interface LegResult {
  /** The module's own draw record, read after the render completed. */
  readonly draw: Record<string, number>;
  /** Every audio-ish output, captured sample-exact. */
  readonly channels: readonly Float32Array[];
}

interface LegRequest {
  /** Wire a ConstantSource into this port EXACTLY as `addEdge` does. */
  cv?: { portId: string; paramId: string; value: number };
  /** Apply this param by the knob path. */
  knob?: { paramId: string; value: number };
}

async function renderLeg(
  def: AudioModuleDef,
  outIds: readonly string[],
  req: LegRequest,
): Promise<LegResult | null> {
  const ctx = new OfflineAudioContext({
    numberOfChannels: Math.max(1, outIds.length),
    length: Math.round(SR * DURATION_S),
    sampleRate: SR,
  });
  const handle = await def.factory(ctx as never, {
    id: 'cv-display-param-reach', type: def.type, domain: 'audio',
    position: { x: 0, y: 0 }, params: {},
  } as never);

  for (const port of def.inputs) {
    if (port.paramTarget) continue;
    const ref = handle.inputs.get(port.id);
    if (!ref) continue;
    const data = driverFor(String(port.type), port.edge);
    if (!data) continue;
    const buf = ctx.createBuffer(1, data.length, SR);
    buf.copyToChannel(new Float32Array(data), 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ref.node, 0, ref.input);
    src.start(0);
  }

  // The per-port TAP, replicating `AudioEngine.addEdge`: after connecting the
  // source to the AudioParam it tees the SAME source into an AnalyserNode
  // (`getOrCreateParamTap`), and `AudioEngine.readParam` returns
  // `knob intrinsic + that analyser's newest sample`. That tap is the ONLY
  // audio-rate readback in this design — the module owns none, because an
  // AnalyserNode costs a permanently retained Blink handler.
  let tap: AnalyserNode | null = null;
  if (req.cv) {
    const ref = handle.inputs.get(req.cv.portId);
    if (!ref) return null;
    const cs = ctx.createConstantSource();
    cs.offset.value = req.cv.value;
    cs.start(0);
    // The engine's own branch: an exposed AudioParam wins, else the node input.
    if (ref.param) {
      cs.connect(ref.param);
      tap = ctx.createAnalyser();
      tap.fftSize = 32;
      tap.smoothingTimeConstant = 0;
      cs.connect(tap);
    } else {
      cs.connect(ref.node, 0, ref.input);
    }
  }
  // Before rendering, so the knob is in force for the whole window — the same
  // ordering the engine uses when it seeds a materialised node's params.
  if (req.knob) handle.setParam(req.knob.paramId, req.knob.value);

  const merger = ctx.createChannelMerger(Math.max(1, outIds.length));
  outIds.forEach((id, k) => {
    const out = handle.outputs.get(id);
    if (out) out.node.connect(merger, out.output, k);
  });
  merger.connect(ctx.destination);
  const rendered = await ctx.startRendering();

  // What a CARD does every frame: read the engine's combined value and push it
  // into the module. Only the port under test is pushed, so a draw param that
  // moves without being pushed is two ports sharing one landing pad — the
  // #1664 aliasing class, caught in VALUES rather than in object identity.
  if (req.cv && tap) {
    const tbuf = new Float32Array(new ArrayBuffer(tap.fftSize * 4));
    tap.getFloatTimeDomainData(tbuf);
    const knob = handle.readParam?.(req.cv.paramId) ?? 0;
    handle.write?.('cvCombined', {
      [req.cv.paramId]: knob + (tbuf[tbuf.length - 1] ?? 0),
    });
  }

  const draw = handle.read?.('drawParams') as Record<string, number> | undefined;
  return {
    draw: draw ?? {},
    channels: outIds.map((_, k) => rendered.getChannelData(k).slice()),
  };
}

/** A far-from-default point inside the param's declared range. */
function probeValue(min: number, max: number, dflt: number): number {
  return (dflt - min) < (max - dflt) ? min + 0.8 * (max - min) : min + 0.2 * (max - min);
}

/** Does a def expose a draw record at all? Materialised once, cheaply. */
async function drawParamKeys(def: AudioModuleDef): Promise<string[] | null> {
  const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: 128, sampleRate: SR });
  try {
    const handle = await def.factory(ctx as never, {
      id: 'probe', type: def.type, domain: 'audio', position: { x: 0, y: 0 }, params: {},
    } as never);
    const dp = handle.read?.('drawParams');
    if (!dp || typeof dp !== 'object') return null;
    return Object.keys(dp as Record<string, number>);
  } catch {
    return null;
  }
}

/** Peak |Δsample| across every captured output — the SAME metric, in the same
 *  units, that `cv-param-reach` reports its numbers in. */
function peakDelta(a: LegResult, b: LegResult): number {
  let m = 0;
  for (let c = 0; c < a.channels.length; c++) {
    const x = a.channels[c]!;
    const y = b.channels[c]!;
    for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i]! - y[i]!));
  }
  return m;
}

// ---------------------------------------------------------------------------
// The two synthetic control defs. Both run through the SAME renderLeg and the
// SAME assertions as every real module.
// ---------------------------------------------------------------------------

/**
 * `broken: true` reproduces the #1664 graph EXACTLY: every CV port publishes
 * ONE shared AudioParam which is the live in→out passthrough gain, and the
 * params are kept in a JS record that only `setParam` writes. `broken: false`
 * is the shadow shape the real fix uses.
 */
function makeControlDef(type: string, broken: boolean): AudioModuleDef {
  return {
    type, domain: 'audio', label: type, category: 'utility',
    palette: { top: 'Utility', sub: 'Utility' },
    inputs: [
      { id: 'in', type: 'audio' },
      { id: 'a', type: 'cv', paramTarget: 'a' },
      { id: 'b', type: 'cv', paramTarget: 'b' },
    ],
    outputs: [{ id: 'thru', type: 'audio' }],
    params: [
      { id: 'a', label: 'A', defaultValue: 0, min: 0, max: 1, curve: 'linear' },
      { id: 'b', label: 'B', defaultValue: 0, min: 0, max: 1, curve: 'linear' },
    ],
    async factory(ctx: BaseAudioContext) {
      const thru = ctx.createGain();
      thru.gain.value = 1;

      /** knob per param, and the pushed combined value when one has arrived. */
      const knob: Record<string, number> = { a: 0, b: 0 };
      const combined: Record<string, number | undefined> = {};
      const pads = new Map<string, GainNode>();
      if (!broken) {
        for (const id of ['a', 'b']) {
          const g = ctx.createGain();
          g.gain.value = 0;
          pads.set(id, g); // out of the audio path, and NO AnalyserNode
        }
      }

      const inputs = new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        ['in', { node: thru, input: 0 }],
      ]);
      for (const id of ['a', 'b']) {
        const g = pads.get(id);
        inputs.set(id, g
          ? { node: g, input: 0, param: g.gain }
          // The defect: the LIVE passthrough gain, shared by both ports.
          : { node: thru, input: 0, param: thru.gain });
      }

      return {
        domain: 'audio',
        inputs,
        outputs: new Map([['thru', { node: thru, output: 0 }]]),
        setParam(id: string, v: number) {
          if (!(id in knob)) return;
          knob[id] = v;
          combined[id] = undefined;
          pads.get(id)?.gain.setValueAtTime(v, ctx.currentTime);
        },
        readParam(id: string) { return knob[id]; },
        read(key: string) {
          if (key !== 'drawParams') return undefined;
          const out: Record<string, number> = {};
          for (const id of ['a', 'b']) out[id] = combined[id] ?? knob[id]!;
          return out;
        },
        // The BROKEN control deliberately does not implement `write`, because
        // the #1664 modules had no delivery path at all — that is the defect.
        ...(broken ? {} : {
          write(key: string, value: unknown) {
            if (key !== 'cvCombined' || typeof value !== 'object' || value === null) return;
            for (const [id, v] of Object.entries(value as Record<string, number>)) {
              if (id in knob) combined[id] = v;
            }
          },
        }),
        dispose() { /* */ },
      };
    },
  } as unknown as AudioModuleDef;
}

// ---------------------------------------------------------------------------
// THE PREDICATES. Every leg of this file — the sweep and both controls — calls
// THESE, so a control cannot drift away from the check it controls for.
// ---------------------------------------------------------------------------

export interface PortVerdict {
  module: string;
  port: string;
  paramId: string;
  /** knob + cable, as the module reports it to its painter. */
  cvDraw: number;
  /** the same effective value applied by the knob path. */
  knobDraw: number;
  /** what BOTH legs should read. */
  want: number;
  /** draw params OTHER than this port's that the cable disturbed. */
  crosstalk: string[];
  /** peak |Δsample| the cable caused on the module's AUDIO outputs. */
  audioDelta: number;
}

/** The cable reaches the drawn value, the knob reaches the same one, the cable
 *  disturbs nothing else, and the audio path never notices any of it. */
function passes(v: PortVerdict): boolean {
  const tol = REL_TOL * Math.max(1, Math.abs(v.want));
  return Math.abs(v.cvDraw - v.want) <= tol
    && Math.abs(v.knobDraw - v.want) <= tol
    && v.crosstalk.length === 0
    && v.audioDelta === 0;
}

function describe1(v: PortVerdict): string {
  return `${v.module}.${v.port} → draw param '${v.paramId}': `
    + `cable=${v.cvDraw}, knob=${v.knobDraw}, want=${v.want} (param units) | `
    + `crosstalk=[${v.crosstalk.join(', ')}] | `
    + `audio Δ=${v.audioDelta.toExponential(4)} (peak |Δsample|, linear amplitude — MUST be 0)`;
}

async function measureDef(def: AudioModuleDef): Promise<PortVerdict[]> {
  const outIds = audioIshOutputs(def);
  const targets = def.inputs.filter((p) => p.paramTarget);
  const base = await renderLeg(def, outIds, {});
  if (!base) return [];

  const verdicts: PortVerdict[] = [];
  for (const port of targets) {
    const pd = def.params.find((p) => p.id === port.paramTarget)!;
    const want = probeValue(pd.min, pd.max, pd.defaultValue);
    // The cable SUMS with the knob intrinsic, so the offset that lands the
    // effective value on `want` is `want - default`.
    const cv = await renderLeg(def, outIds, {
      cv: { portId: port.id, paramId: pd.id, value: want - pd.defaultValue },
    });
    const knob = await renderLeg(def, outIds, { knob: { paramId: pd.id, value: want } });
    if (!cv || !knob) continue;

    const crosstalk: string[] = [];
    for (const [key, value] of Object.entries(cv.draw)) {
      if (key === pd.id) continue;
      const undisturbed = base.draw[key];
      if (undisturbed === undefined || value !== undisturbed) {
        crosstalk.push(`${key} moved ${undisturbed} → ${value}`);
      }
    }

    verdicts.push({
      module: def.type, port: port.id, paramId: pd.id,
      cvDraw: cv.draw[pd.id] ?? NaN,
      knobDraw: knob.draw[pd.id] ?? NaN,
      want,
      crosstalk,
      audioDelta: peakDelta(base, cv),
    });
  }
  return verdicts;
}

// ---------------------------------------------------------------------------

let ENROLLED: { def: AudioModuleDef; keys: string[] }[] = [];
let VERDICTS: PortVerdict[] = [];

describe('CV reach for DISPLAY params — the cable must move the number the module DRAWS with', () => {
  beforeAll(async () => {
    const defs = (collectAudioDefs() as AudioModuleDef[])
      .filter((d) => d.inputs?.some((p) => p.paramTarget))
      .sort((a, b) => a.type.localeCompare(b.type));
    for (const def of defs) {
      const keys = await drawParamKeys(def);
      if (!keys) continue;
      ENROLLED.push({ def, keys });
      VERDICTS = VERDICTS.concat(await measureDef(def));
    }
  }, 600_000);

  // -------------------------------------------------------------------------
  // Controls. Permanent legs, run through the SAME predicate as the sweep: if
  // the harness ever stops being able to see a working display-CV path, or
  // stops being able to see the #1664 one, every green below is worthless.
  // -------------------------------------------------------------------------

  it('POSITIVE CONTROL (mechanism): ConstantSource → GainNode.gain is observable off an UNCONNECTED analyser here', async () => {
    // The whole shadow design rests on this: a GainNode reachable from nothing
    // but its own analyser is still PROCESSED, and the analyser sees the
    // summed (intrinsic + connected) value while `.value` sees only the
    // intrinsic. Without this leg a bit-exact zero downstream could equally
    // mean "node-web-audio-api never pulled the shadow".
    const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: 480, sampleRate: SR });
    const g = ctx.createGain();
    g.gain.value = 20;
    const carrier = ctx.createConstantSource();
    carrier.offset.value = 1;
    carrier.start();
    carrier.connect(g);
    const an = ctx.createAnalyser();
    an.fftSize = 32;
    an.smoothingTimeConstant = 0;
    g.connect(an);
    const cable = ctx.createConstantSource();
    cable.offset.value = 30;
    cable.start();
    cable.connect(g.gain);
    // Something must reach the destination or there is no render at all.
    const dc = ctx.createConstantSource();
    dc.offset.value = 0.5;
    dc.start();
    dc.connect(ctx.destination);
    await ctx.startRendering();
    const buf = new Float32Array(new ArrayBuffer(an.fftSize * 4));
    an.getFloatTimeDomainData(buf);
    expect(buf[buf.length - 1], 'shadow analyser must read knob 20 + cable 30 (param units)').toBe(50);
    expect(g.gain.value, 'AudioParam.value must read the INTRINSIC ONLY — this is why it cannot be used').toBe(20);
  });

  it('POSITIVE CONTROL (predicate): a per-port shadow out of the audio path PASSES', async () => {
    const v = await measureDef(makeControlDef('__control_shadow', false));
    expect(v).toHaveLength(2);
    for (const one of v) expect(passes(one), describe1(one)).toBe(true);
  });

  it('NEGATIVE CONTROL (predicate): the #1664 graph — one SHARED live passthrough gain — FAILS', async () => {
    const v = await measureDef(makeControlDef('__control_shared_live_gain', true));
    expect(v).toHaveLength(2);
    for (const one of v) expect(passes(one), describe1(one)).toBe(false);
    // And fail for the RIGHT REASONS, in both directions — a negative control
    // that merely goes red proves the probe can move, not that it reads the
    // thing under test.
    const a = v[0]!;
    expect(a.cvDraw, 'the cable must never reach the drawn value (it lands on an AudioParam nobody reads)').toBe(0);
    expect(
      a.audioDelta,
      'and it must instead CORRUPT the audio — this is the leg that sees rasterize.cursor 5.0e-1 → 3.146e+5',
    ).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // The sweep.
  // -------------------------------------------------------------------------

  it('every display CV input reaches its draw param, and NOTHING else', () => {
    const offenders = VERDICTS.filter((v) => !passes(v)).map(describe1);
    expect(offenders, 'display CV inputs that miss their draw param, bleed into another, or move audio (#1664)').toEqual([]);
  });

  it('a cable on a display CV input leaves the audio path BIT-IDENTICAL', () => {
    // Called out separately from the predicate above because it is the leg with
    // the safety consequence: the pre-fix `rasterize.cursor` multiplied a ±0.5
    // signal by 629 000 straight down THRU. An assertion this one cannot be
    // satisfied by "the audio changed", which is what a naive reach check
    // rewards.
    const offenders = VERDICTS
      .filter((v) => v.audioDelta !== 0)
      .map((v) => `${v.module}.${v.port}: peak |Δsample| ${v.audioDelta.toExponential(4)} (linear amplitude) — a DISPLAY param moved the signal path`);
    expect(offenders).toEqual([]);
  });

  it('every enrolled module draws with EXACTLY the params its CV inputs target', () => {
    // Derived membership, asserted both directions: a port with no draw param
    // is a cable into nothing; a draw param with no port is a control the CV
    // system cannot reach. Neither can hide behind the other.
    const problems: string[] = [];
    for (const { def, keys } of ENROLLED) {
      const declared = new Set(
        def.inputs.filter((p) => p.paramTarget).map((p) => String(p.paramTarget)),
      );
      const drawn = new Set(keys);
      for (const id of declared) {
        if (!drawn.has(id)) problems.push(`${def.type}: port targets '${id}' but drawParams has no such key`);
      }
      for (const id of drawn) {
        if (!declared.has(id)) problems.push(`${def.type}: drawParams exposes '${id}' but no CV input targets it`);
      }
    }
    expect(problems, 'draw params and paramTarget ports must be the same set').toEqual([]);
  });

  it('states its own coverage: which modules it enrolled, and what it still cannot see', () => {
    const names = ENROLLED.map((e) => e.def.type).join(', ');
    // eslint-disable-next-line no-console
    console.log(
      `[cv-display-param-reach] enrolled (DERIVED — every def whose handle answers read('drawParams')): `
      + `${names || '(none)'} | ports measured=${VERDICTS.length} `
      + '| BLIND TO: whether the PICTURE is right (VRT owns that); modules that apply a JS-consumed '
      + 'param without publishing drawParams; the rAF loop that does the push in the browser, so a '
      + 'card that is unmounted or collapsed leaves its video-out on the KNOB; and the engine\'s own '
      + 'readParam formula, which is replicated here rather than called.',
    );
  });
});
