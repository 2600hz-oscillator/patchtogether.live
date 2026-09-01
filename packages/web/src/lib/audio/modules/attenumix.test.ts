// packages/web/src/lib/audio/modules/attenumix.test.ts
//
// Unit tests for ATTENUMIX — the simple 4-channel attenuating mixer.
// Pin per-channel attenuation, the 0..1 clamp at the channel level, the
// mix-sum identity, the master+tanh saturation curve, the CV+knob sum,
// and the module-def shape.
//
// The final block pins the AUDIO-**OR**-CV channel contract: which cables the
// four channel inputs take, which type each direct out emits, that `mix` is
// deliberately NOT type-transparent, and that the scaling a CV receives is
// exactly linear and DC-coupled.

import { describe, expect, it } from 'vitest';
import { attenumixMath, attenumixDef } from './attenumix';
import { buildPatchSnapshot } from '$lib/graph/snapshot';
import { makeAdoptionGraph, validateEdge } from '$lib/graph/validate-edge';
import type { CableType, Edge, ModuleNode, PortDef } from '$lib/graph/types';
import { lfoDef } from './lfo';
import { noiseDef } from './noise';
import { kriaDef } from './kria';
import { filterDef } from './filter';
import { toyboxDef } from '$lib/video/modules/toybox';

describe('attenumixMath.channelAtt: per-channel attenuator clamp', () => {
  it('passes 0..1 through identically', () => {
    for (const x of [0, 0.1, 0.25, 0.5, 0.75, 1.0]) {
      expect(attenumixMath.channelAtt(x, 0)).toBeCloseTo(x, 12);
    }
  });

  it('clamps negative knob+cv to 0 (attenuators never invert phase)', () => {
    for (const k of [-0.5, -1, -2]) {
      expect(attenumixMath.channelAtt(k, 0)).toBe(0);
    }
    // Negative net even when knob is positive (CV drives below 0).
    expect(attenumixMath.channelAtt(0.3, -0.5)).toBe(0);
  });

  it('clamps above-unity knob+cv to 1 (attenuators never boost)', () => {
    for (const c of [0.5, 1, 2]) {
      expect(attenumixMath.channelAtt(1.0, c)).toBe(1);
    }
    // CV-only over-drive caps at 1.
    expect(attenumixMath.channelAtt(0, 2)).toBe(1);
    // Knob+CV = 1.5 → caps at 1.
    expect(attenumixMath.channelAtt(0.7, 0.8)).toBe(1);
  });

  it('CV summed with knob in the 0..1 interior region', () => {
    expect(attenumixMath.channelAtt(0.3, 0.4)).toBeCloseTo(0.7, 12);
    expect(attenumixMath.channelAtt(0.0, 0.5)).toBeCloseTo(0.5, 12);
    expect(attenumixMath.channelAtt(0.6, -0.2)).toBeCloseTo(0.4, 12);
  });
});

describe('attenumixMath.channelSample: per-channel multiply', () => {
  it('att=1 passes audio through unchanged', () => {
    for (const x of [-0.9, -0.5, 0, 0.25, 0.7]) {
      expect(attenumixMath.channelSample(x, 1, 0)).toBeCloseTo(x, 12);
    }
  });

  it('att=0 mutes regardless of input', () => {
    // -1 * 0 yields -0 in IEEE-754; both ±0 are "muted" — compare magnitudes.
    for (const x of [-1, -0.5, 0, 0.5, 1]) {
      expect(Math.abs(attenumixMath.channelSample(x, 0, 0))).toBe(0);
    }
  });

  it('att=0.5 halves the audio', () => {
    expect(attenumixMath.channelSample(0.8, 0.5, 0)).toBeCloseTo(0.4, 12);
    expect(attenumixMath.channelSample(-0.6, 0.5, 0)).toBeCloseTo(-0.3, 12);
  });

  it('CV at +1V at knob=0 fully opens the channel (full-range sweep)', () => {
    // The whole point of PASSTHROUGH_BY_DESIGN on CV: ±1V already spans
    // the natural range of [0, 1]. Knob=0 + CV=+1 → att=1 → input passes.
    expect(attenumixMath.channelSample(0.4, 0, 1)).toBeCloseTo(0.4, 12);
  });
});

describe('attenumixMath.mixSample: master+tanh soft-clip', () => {
  it('master=1, small sum: nearly linear passthrough', () => {
    // tanh is ~linear near zero. Small sums get gentle saturation.
    expect(attenumixMath.mixSample(0, 1)).toBe(0);
    expect(attenumixMath.mixSample(0.1, 1)).toBeCloseTo(Math.tanh(0.1), 12);
    // tanh(0.05)/0.05 ≈ 0.999 — linear within 0.1%.
    expect(attenumixMath.mixSample(0.05, 1) / 0.05).toBeGreaterThan(0.99);
  });

  it('master=2 doubles the drive into the tanh — saturation onset earlier', () => {
    // sum=0.5 at master=1 → tanh(0.5) ≈ 0.462
    // sum=0.5 at master=2 → tanh(1.0) ≈ 0.762 — much warmer.
    expect(attenumixMath.mixSample(0.5, 2)).toBeCloseTo(Math.tanh(1.0), 6);
    expect(attenumixMath.mixSample(0.5, 2)).toBeGreaterThan(
      attenumixMath.mixSample(0.5, 1),
    );
  });

  it('master=0 fully mutes the mix', () => {
    // sum*0 may yield -0 in IEEE-754; both ±0 are "muted" — compare magnitudes.
    for (const sum of [-2, -0.5, 0, 0.5, 2]) {
      expect(Math.abs(attenumixMath.mixSample(sum, 0))).toBe(0);
    }
  });

  it('saturation bounded asymptotically at ±1 — no digital hard-clip', () => {
    // tanh approaches 1 at finite arguments — for double-precision floats
    // tanh(x) is < 1 for x < ~19.06 and rounds to exactly 1.0 above that.
    // Pin the asymptote within the audible range we'd actually reach.
    expect(attenumixMath.mixSample(3, 2)).toBeLessThan(1);
    expect(attenumixMath.mixSample(3, 2)).toBeGreaterThan(0.99);
    expect(attenumixMath.mixSample(-3, 2)).toBeGreaterThan(-1);
    expect(attenumixMath.mixSample(-3, 2)).toBeLessThan(-0.99);
  });

  it('symmetric around 0 — bipolar audio preserved at the mix', () => {
    for (const sum of [0.5, 1.0, 2.0, 5.0]) {
      for (const m of [0.5, 1, 2]) {
        expect(attenumixMath.mixSample(-sum, m)).toBeCloseTo(
          -attenumixMath.mixSample(sum, m),
          12,
        );
      }
    }
  });
});

describe('attenumixMath.render: per-channel independence + mix sum', () => {
  it('silent (unpatched) channels do not leak into the mix', () => {
    // Only ch1 patched (in=0.5, knob=1). Other channels' outs must be 0
    // AND the mix must equal tanh(out1 * master) — proving no leakage.
    const N = 16;
    const in1 = new Float32Array(N).fill(0.5);
    const { outs, mix } = attenumixMath.render(
      [in1, null, null, null],
      [null, null, null, null],
      [1, 0, 0, 0],
      1,
      N,
    );
    for (let i = 0; i < N; i++) {
      expect(outs[1]![i]).toBe(0);
      expect(outs[2]![i]).toBe(0);
      expect(outs[3]![i]).toBe(0);
      expect(outs[0]![i]).toBeCloseTo(0.5, 12);
      expect(mix[i]).toBeCloseTo(Math.tanh(0.5), 6);
    }
  });

  it('mix = tanh((out1+out2+out3+out4) * master) sample-by-sample', () => {
    const N = 8;
    const in1 = new Float32Array(N).fill(0.1);
    const in2 = new Float32Array(N).fill(0.1);
    const in3 = new Float32Array(N).fill(0.1);
    const in4 = new Float32Array(N).fill(0.1);
    const { outs, mix } = attenumixMath.render(
      [in1, in2, in3, in4],
      [null, null, null, null],
      [1, 1, 1, 1],
      1.5,
      N,
    );
    for (let i = 0; i < N; i++) {
      const sum = (outs[0]![i] ?? 0) + (outs[1]![i] ?? 0) + (outs[2]![i] ?? 0) + (outs[3]![i] ?? 0);
      expect(mix[i]).toBeCloseTo(Math.tanh(sum * 1.5), 6);
    }
  });

  it('channels are fully independent — different knobs do not cross-talk', () => {
    const N = 4;
    const in1 = new Float32Array(N).fill(0.4);
    const in2 = new Float32Array(N).fill(-0.3);
    const in3 = new Float32Array(N).fill(0.2);
    const in4 = new Float32Array(N).fill(0.1);
    const cv1 = new Float32Array(N).fill(0);
    const cv2 = new Float32Array(N).fill(0.5);
    const cv3 = new Float32Array(N).fill(0);
    const cv4 = new Float32Array(N).fill(0);
    const { outs } = attenumixMath.render(
      [in1, in2, in3, in4],
      [cv1, cv2, cv3, cv4],
      [1.0, 0.3, 0.0, 0.5],
      1,
      N,
    );
    // ch1: 0.4 * clamp(1.0+0)=1.0   = 0.4
    // ch2: -0.3 * clamp(0.3+0.5)=0.8= -0.24
    // ch3: 0.2 * clamp(0+0)=0       = 0  (zero knob+CV mutes)
    // ch4: 0.1 * clamp(0.5+0)=0.5   = 0.05
    expect(outs[0]![0]).toBeCloseTo(0.4,   6);
    expect(outs[1]![0]).toBeCloseTo(-0.24, 6);
    expect(outs[2]![0]).toBe(0);
    expect(outs[3]![0]).toBeCloseTo(0.05,  6);
  });

  it('master>1 + 4 channels full open: mix saturates near ±1 (overdrive story)', () => {
    // 4 channels each at audio=0.5, knob=1.0 → each out = 0.5, sum = 2.0.
    // master=1.5 → tanh(3.0) ≈ 0.9951 — heavy saturation, but not clipped.
    const N = 4;
    const buf = new Float32Array(N).fill(0.5);
    const { mix } = attenumixMath.render(
      [buf, buf, buf, buf],
      [null, null, null, null],
      [1, 1, 1, 1],
      1.5,
      N,
    );
    for (let i = 0; i < N; i++) {
      expect(mix[i]).toBeCloseTo(Math.tanh(3.0), 5);
      expect(Math.abs(mix[i] ?? 0)).toBeLessThan(1);
    }
  });
});

// ── THE CHANNELS TAKE AUDIO **OR** CV ───────────────────────────────────────
//
// Before this contract the four channel inputs were bare `audio`, so
// `canConnect('cv', 'audio')` refused every CV cable and ATTENUMIX could not
// touch a control voltage at all — while its DSP is a per-sample multiply that
// is indifferent to the class of signal it scales.
//
// Both sides are pinned here, because a one-sided version of this test is the
// SCALER defect shape: the input widening alone lets a CV IN, and a hard-`audio`
// direct out then hands it to the cross-domain bridge's RMS envelope follower,
// which rectifies and clamps it — the cable looks patched and the attenuator
// does nothing. So we assert (a) which cables the inputs accept, (b) which type
// each direct out actually EMITS once resolved against a real upstream, through
// the SHIPPING resolver (`buildPatchSnapshot`) and against REAL registry defs.
//
// ⚠ REAL SOURCES ARE LOAD-BEARING, not decoration. `resolveUpstreamType` reads
// the SOURCE PORT'S DECLARED TYPE off the def and only falls back to the stored
// `edge.sourceType`. A fixture that patched one convenient module and merely
// relabelled its edges would therefore be answered by that module's def, not by
// the label — the first draft of this file did exactly that and its "audio"
// negative control resolved to `cv`. Each cable class here comes from a module
// that genuinely emits it, and every port id is DERIVED by type from the def.
//
// The `mix` leg is a DECISION, not an omission — see the def header. It is
// asserted explicitly so that flipping it later is a visible change of contract.

const REAL_DEFS: Record<string, { inputs: readonly PortDef[]; outputs: readonly PortDef[] }> = {
  attenumix: attenumixDef,
  lfo: lfoDef,
  noise: noiseDef,
  kria: kriaDef,
  filter: filterDef,
  toybox: toyboxDef as unknown as { inputs: readonly PortDef[]; outputs: readonly PortDef[] },
};
const resolveRealDef = (t: string) => REAL_DEFS[t];

/** A real module that genuinely EMITS each cable class, with the jack found by
 *  type rather than typed in — a rename or retype upstream fails this file
 *  loudly instead of quietly re-answering the question. */
const SOURCE_OF: Record<string, { type: string; port: string }> = {
  audio: { type: 'noise', port: portOfType(noiseDef.outputs, 'audio') },
  cv: { type: 'lfo', port: portOfType(lfoDef.outputs, 'cv') },
  pitch: { type: 'kria', port: portOfType(kriaDef.outputs, 'pitch') },
  gate: { type: 'kria', port: portOfType(kriaDef.outputs, 'gate') },
};

function portOfType(ports: readonly PortDef[], type: CableType): string {
  const p = ports.find((q) => q.type === type);
  if (!p) throw new Error(`no ${type} port among [${ports.map((q) => `${q.id}:${q.type}`).join(', ')}]`);
  return p.id;
}

function mkNode(id: string, type: string, domain = 'audio'): ModuleNode {
  return { id, type, domain, position: { x: 0, y: 0 }, params: {} } as ModuleNode;
}
function mkEdge(
  id: string,
  source: [string, string],
  target: [string, string],
  sourceType: CableType,
  targetType: CableType,
): Edge {
  return {
    id,
    source: { nodeId: source[0], portId: source[1] },
    target: { nodeId: target[0], portId: target[1] },
    sourceType,
    targetType,
  };
}

/** The first `modsignal` modulation hole on TOYBOX — DERIVED from the def. It
 *  is the one destination class an adopting `audio` output can legally reach
 *  today AND that also accepts cv/pitch/gate, which is exactly what makes the
 *  emitted type OBSERVABLE there rather than forced by the canConnect guard. */
const TOYBOX_MOD_PORT = toyboxDef.inputs.find((p) => p.type === 'modsignal')?.id;

const CHANNELS = [1, 2, 3, 4] as const;

describe('attenumix def: the channel inputs accept the CV family', () => {
  it('in1..in4 are audio-typed and accept cv / pitch / gate', () => {
    for (const i of CHANNELS) {
      const port = attenumixDef.inputs.find((p) => p.id === `in${i}`);
      expect(port, `in${i} exists`).toBeDefined();
      expect(port!.type).toBe('audio');
      expect([...(port!.accepts ?? [])].sort()).toEqual(['cv', 'gate', 'pitch']);
    }
  });

  it('the ATTENUATOR cv1..cv4 holes are untouched — still plain cv, no widening', () => {
    // These are modulation for the KNOB, not channel signal. Repurposing them
    // would silently move a player's LFO from "sweep the attenuator" to
    // "be the thing attenuated".
    for (const i of CHANNELS) {
      const port = attenumixDef.inputs.find((p) => p.id === `cv${i}`);
      expect(port, `cv${i} exists`).toBeDefined();
      expect(port!.type).toBe('cv');
      expect(port!.accepts).toBeUndefined();
      expect(port!.paramTarget).toBeUndefined();
    }
  });

  it('each direct out adopts its OWN channel; mix adopts nothing', () => {
    for (const i of CHANNELS) {
      const port = attenumixDef.outputs.find((p) => p.id === `out${i}`);
      expect(port, `out${i} exists`).toBeDefined();
      expect(port!.type).toBe('audio'); // the nothing-patched-upstream fallback
      expect(port!.adoptsUpstreamFrom).toBe(`in${i}`);
    }
    const mix = attenumixDef.outputs.find((p) => p.id === 'mix');
    expect(mix!.type).toBe('audio');
    // DELIBERATE: `mix` sums four channels that may carry different classes and
    // then bends them through tanh. `adoptsUpstreamFrom` names ONE port, and
    // there is no primary channel to name. See the def header for the argument.
    expect(mix!.adoptsUpstreamFrom).toBeUndefined();
  });
});

describe('attenumix reachability: a CV source can actually be patched in', () => {
  const nodes = [
    mkNode('l', SOURCE_OF.cv!.type),
    mkNode('a', 'attenumix'),
    mkNode('f', 'filter'),
  ];

  it('the real LFO cv output validates into every channel input (it did not before)', () => {
    for (const i of CHANNELS) {
      const verdict = validateEdge(
        mkEdge('e', ['l', SOURCE_OF.cv!.port], ['a', `in${i}`], 'cv', 'audio'),
        nodes,
        resolveRealDef,
      );
      expect(verdict.ok, `cv → attenumix.in${i}: ${verdict.reason}`).toBe(true);
    }
  });

  it('real pitch and gate sources validate too, and audio still does', () => {
    for (const cls of ['pitch', 'gate', 'audio'] as const) {
      const src = SOURCE_OF[cls]!;
      const verdict = validateEdge(
        mkEdge('e', ['s', src.port], ['a', 'in1'], cls, 'audio'),
        [...nodes, mkNode('s', src.type)],
        resolveRealDef,
      );
      expect(verdict.ok, `${cls} → attenumix.in1: ${verdict.reason}`).toBe(true);
    }
  });

  // ── AND OUT AGAIN, TO A CV JACK ──────────────────────────────────────────
  //
  // The gesture the owner reported as broken on SCALER — *"scaler's output wont
  // patch to cv ins"* — with ATTENUMIX in the middle. Connection legality is
  // decided on what an output EMITS, so a channel fed by an LFO offers a CV to
  // `filter.cutoff`; a channel fed by nothing still offers `audio` and is
  // refused. Both legs matter: the second is what keeps `canConnect`'s
  // audio→cv rule load-bearing instead of quietly widened.
  const cvSrc = () => mkNode('l', SOURCE_OF.cv!.type);
  const feedChannel = (ch: number) =>
    mkEdge(`u${ch}`, ['l', SOURCE_OF.cv!.port], ['a', `in${ch}`], 'cv', 'audio');

  it('a CV-fed channel’s direct out CONNECTS to a strictly-cv jack', () => {
    const graphNodes = [cvSrc(), mkNode('a', 'attenumix'), mkNode('f', 'filter')];
    const adoption = makeAdoptionGraph(graphNodes, [feedChannel(1)], resolveRealDef);
    const verdict = validateEdge(
      mkEdge('d', ['a', 'out1'], ['f', 'cutoff'], 'audio', 'cv'),
      graphNodes,
      resolveRealDef,
      adoption,
    );
    expect(verdict.ok, verdict.reason).toBe(true);
  });

  it('POSITIVE CONTROL: without the adoption graph the same cable is refused', () => {
    // Omitting the argument is the reverted fix — the exact shipped bug.
    const graphNodes = [cvSrc(), mkNode('a', 'attenumix'), mkNode('f', 'filter')];
    const verdict = validateEdge(
      mkEdge('d', ['a', 'out1'], ['f', 'cutoff'], 'audio', 'cv'),
      graphNodes,
      resolveRealDef,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/incompatible cable types audio → cv/);
  });

  it('a channel with NOTHING patched in is still refused by the cv jack', () => {
    // Per-channel, not per-module: feeding ch1 does not open ch2's direct out.
    const graphNodes = [cvSrc(), mkNode('a', 'attenumix'), mkNode('f', 'filter')];
    const adoption = makeAdoptionGraph(graphNodes, [feedChannel(1)], resolveRealDef);
    const verdict = validateEdge(
      mkEdge('d', ['a', 'out2'], ['f', 'cutoff'], 'audio', 'cv'),
      graphNodes,
      resolveRealDef,
      adoption,
    );
    expect(verdict.ok).toBe(false);
  });

  it('MIX is refused by a cv jack even with all four channels carrying CV', () => {
    // `mix` declares no adoption, so it is judged `audio` — the summing bus is
    // an audio bus by construction (tanh), and this is the connect-time face of
    // that decision rather than a second, drifting statement of it.
    const graphNodes = [cvSrc(), mkNode('a', 'attenumix'), mkNode('f', 'filter')];
    const adoption = makeAdoptionGraph(
      graphNodes,
      CHANNELS.map((ch) => feedChannel(ch)),
      resolveRealDef,
    );
    const verdict = validateEdge(
      mkEdge('d', ['a', 'mix'], ['f', 'cutoff'], 'audio', 'cv'),
      graphNodes,
      resolveRealDef,
      adoption,
    );
    expect(verdict.ok).toBe(false);
  });
});

describe('attenumix type transparency: the shipping resolver, real defs', () => {
  /** Patch `<a real source of class X> → attenumix.inN → toybox.<modsignal>` and
   *  return the RESOLVED sourceType of each downstream edge by id. Downstream
   *  edges are stored as `audio` — what a plain connect path writes from the
   *  declared port type — so a green result means the resolver REWROTE them
   *  rather than the fixture having pre-answered the question. */
  function resolveDownstream(
    upstream: Array<{ ch: 1 | 2 | 3 | 4; cls: 'audio' | 'cv' | 'pitch' | 'gate' }>,
    downstream: Array<{ id: string; from: string }>,
  ): Record<string, CableType> {
    expect(TOYBOX_MOD_PORT, 'toybox still declares a modsignal input').toBeDefined();
    const nodes: Record<string, ModuleNode> = {
      a: mkNode('a', 'attenumix'),
      t: mkNode('t', 'toybox', 'video'),
    };
    const edges: Record<string, Edge> = {};
    for (const { ch, cls } of upstream) {
      const src = SOURCE_OF[cls]!;
      const srcId = `s${ch}`;
      nodes[srcId] = mkNode(srcId, src.type);
      edges[`u${ch}`] = mkEdge(`u${ch}`, [srcId, src.port], ['a', `in${ch}`], cls, 'audio');
    }
    for (const { id, from } of downstream) {
      edges[id] = mkEdge(id, ['a', from], ['t', TOYBOX_MOD_PORT!], 'audio', 'modsignal');
    }
    const snap = buildPatchSnapshot({ nodes, edges } as never, resolveRealDef as never);
    const out: Record<string, CableType> = {};
    for (const { id } of downstream) out[id] = snap.edges.find((e) => e.id === id)!.sourceType;
    return out;
  }

  it('a CV into a channel makes THAT channel’s direct out emit cv', () => {
    for (const ch of CHANNELS) {
      const got = resolveDownstream([{ ch, cls: 'cv' }], [{ id: 'd', from: `out${ch}` }]);
      expect(got.d, `out${ch} with a cv upstream`).toBe('cv');
    }
  });

  it('NEGATIVE CONTROL: a real AUDIO upstream leaves the direct out audio', () => {
    // The instrument can distinguish. Without this leg a resolver that
    // unconditionally stamped `cv` would pass the block above.
    const got = resolveDownstream([{ ch: 1, cls: 'audio' }], [{ id: 'd', from: 'out1' }]);
    expect(got.d).toBe('audio');
  });

  it('NEGATIVE CONTROL: an UNPATCHED channel falls back to the declared audio', () => {
    const got = resolveDownstream([], [{ id: 'd', from: 'out3' }]);
    expect(got.d).toBe('audio');
  });

  it('adoption is PER CHANNEL — a cv on ch1 does not re-type ch2’s out', () => {
    const got = resolveDownstream(
      [
        { ch: 1, cls: 'cv' },
        { ch: 2, cls: 'audio' },
      ],
      [
        { id: 'd1', from: 'out1' },
        { id: 'd2', from: 'out2' },
      ],
    );
    expect(got.d1).toBe('cv');
    expect(got.d2).toBe('audio');
  });

  it('pitch and gate are carried through as themselves, not flattened to cv', () => {
    for (const cls of ['pitch', 'gate'] as const) {
      const got = resolveDownstream([{ ch: 4, cls }], [{ id: 'd', from: 'out4' }]);
      expect(got.d).toBe(cls);
    }
  });

  it('mix stays AUDIO even when all four channels carry cv (the decision)', () => {
    const got = resolveDownstream(
      CHANNELS.map((ch) => ({ ch, cls: 'cv' as const })),
      [{ id: 'd', from: 'mix' }],
    );
    // The all-agree case is the one where adopting would be most defensible,
    // and it is still refused: `mix` is tanh(sum · master), so what leaves it
    // is not the voltage that went in. The exactly-linear CV route is out1..4.
    expect(got.d).toBe('audio');
  });
});

describe('attenumix CV scaling: exactly linear, DC-coupled, sign-preserving', () => {
  // The failure class the def header names is a path that AC-couples or
  // envelope-follows a control voltage, so a steady CV arrives as zero or as a
  // rectified magnitude. A CV is DC: the honest check is that a CONSTANT input
  // comes out as a constant, scaled by exactly the attenuator, with its sign.
  //
  // `Math.fround` throughout, because the render buffers are Float32Array — the
  // channel is one multiply and we want EXACT equality, so the expectation has
  // to live in the same precision the signal does rather than be loosened to a
  // tolerance that would also swallow a real DC leak.
  const DC = [-0.75, -0.2, 0.2, 0.75] as const;

  it('a steady CV survives the channel as dc × att, exactly, with its sign', () => {
    for (const dc of DC) {
      for (const att of [0.25, 0.5, 1.0]) {
        const N = 8;
        const buf = new Float32Array(N).fill(dc);
        const { outs } = attenumixMath.render(
          [buf, null, null, null],
          [null, null, null, null],
          [att, 0, 0, 0],
          1,
          N,
        );
        const expected = Math.fround(Math.fround(dc) * att);
        for (let i = 0; i < N; i++) {
          expect(outs[0]![i]).toBe(expected);
          expect(Math.sign(outs[0]![i] ?? 0)).toBe(Math.sign(dc));
        }
      }
    }
  });

  it('att=1 is a BIT-EXACT passthrough — the CV is untouched', () => {
    const N = 8;
    const buf = new Float32Array(N).fill(-0.6);
    const { outs } = attenumixMath.render(
      [null, buf, null, null],
      [null, null, null, null],
      [0, 1, 0, 0],
      1,
      N,
    );
    for (let i = 0; i < N; i++) expect(outs[1]![i]).toBe(Math.fround(-0.6));
  });

  it('distinct ATT settings give DISTINCT, ordered CV — the knob is not dead', () => {
    // The dead-knob signature is several settings collapsing onto one value.
    const N = 4;
    const buf = new Float32Array(N).fill(0.8);
    const atts = [0.25, 0.5, 0.75, 1.0];
    const seen = atts.map((att) => {
      const { outs } = attenumixMath.render(
        [buf, null, null, null],
        [null, null, null, null],
        [att, 0, 0, 0],
        1,
        N,
      );
      return outs[0]![0]!;
    });
    expect(seen).toEqual(atts.map((att) => Math.fround(Math.fround(0.8) * att)));
    for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeGreaterThan(seen[i - 1]!);
  });

  it('and WHY mix is not the CV route: tanh bends it even at unity', () => {
    // This is the number quoted in the def header and the docs prose. One
    // channel, att=1, master=1: the direct out is exactly the input, the mix is
    // not — so routing a control voltage through the summing bus is a warp.
    const N = 2;
    const buf = new Float32Array(N).fill(0.4);
    const { outs, mix } = attenumixMath.render(
      [buf, null, null, null],
      [null, null, null, null],
      [1, 0, 0, 0],
      1,
      N,
    );
    expect(outs[0]![0]).toBe(Math.fround(0.4));
    expect(mix[0]).toBe(Math.fround(Math.tanh(Math.fround(0.4))));
    expect(mix[0]).toBeCloseTo(0.3799, 4);
    expect(mix[0]).not.toBe(outs[0]![0]);
  });
});
