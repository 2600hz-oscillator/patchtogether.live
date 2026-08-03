// packages/web/src/lib/audio/modules/twotracks-stereo.test.ts
//
// TWOTRACKS — OUT L and OUT R must be two DIFFERENT graph edges.
//
// ── THE DEFECT ────────────────────────────────────────────────────────────
// The worklet is `numberOfOutputs: 1, outputChannelCount: [2]` — ONE output
// carrying TWO channels. The factory mapped BOTH port handles at
// `{ node: workletNode, output: 0 }`, so `out_l` and `out_r` were literally
// the same edge: patch them into two mono destinations and Web Audio
// down-mixes the 2-channel bus to (L+R)/2 at BOTH. The stereo image was not
// separable at the patch points.
//
// The INPUT side was always right (reel A → worklet inputs 0/1, reel B → 2/3),
// which is what makes this an output-side mistake rather than a mono design.
// Same failure and same fix as RINGBACK — see ringback.ts / ringback.test.ts.
//
// ── WHAT THIS FILE CAN AND CANNOT PROVE ───────────────────────────────────
// This is the `node` vitest lane: there is no AudioWorklet and no
// AudioContext, so nothing here can render a sample. What it CAN pin is the
// GRAPH SHAPE the factory builds, which is exactly where the bug lived — the
// old code and the new code differ only in which node+output each port names.
//
// The SIGNAL-level proof — that the two jacks carry genuinely different
// audio in a real browser — is `e2e/tests/twotracks-stereo.spec.ts`, which
// sums `out_l` against an inverted `out_r` in the audio graph itself and
// asserts the difference is EXACTLY zero on a mono drive and loud on a
// stereo drive. Neither test replaces the other: this one runs in the fast
// lane on every unit sweep, that one runs the real worklet.

import { describe, expect, it } from 'vitest';
import { twotracksDef } from './twotracks';

/** A mock AudioContext + AudioWorkletNode good enough to run the factory and
 *  inspect the graph it builds. Records every `connect(...)` so the
 *  worklet → splitter wiring can be asserted, not just assumed. */
function makeMockCtx() {
  const connections: { from: string; dest: unknown; output?: number; input?: number }[] = [];
  const splitters: Array<{ kind: 'splitter'; channels: number; disconnect: () => void }> = [];
  const gains: Array<{ kind: 'gain'; gain: { value: number }; disconnect: () => void }> = [];

  // Every worklet param the factory reaches for via `params.get(...)`.
  const params = new Map<string, { value: number; setValueAtTime(v: number): void }>();
  const param = (name: string) => {
    if (!params.has(name)) {
      params.set(name, {
        value: 0,
        setValueAtTime(v: number) {
          this.value = v;
        },
      });
    }
    return params.get(name)!;
  };
  // Seed the names the factory looks up by hand (a real worklet declares them).
  for (const n of [
    'rate', 'mode', 'echoes', 'start', 'end', 'overdub_toggle', 'rec_start', 'rec_arm',
    'rate_b', 'mode_b', 'echoes_b', 'start_b', 'end_b', 'overdub_toggle_b', 'rec_start_b', 'rec_arm_b',
    'eqLow_a', 'eqMid_a', 'eqHigh_a', 'filterMode_a', 'cutoff_a', 'reso_a',
    'eqLow_b', 'eqMid_b', 'eqHigh_b', 'filterMode_b', 'cutoff_b', 'reso_b',
    'ab', 'a2b', 'b2a', 'lofi', 'monitor', 'scrubVelocity_a', 'scrubVelocity_b',
  ]) param(n);

  const workletNode = {
    kind: 'worklet' as const,
    parameters: params,
    port: { onmessage: null as unknown, postMessage() {} },
    connect(dest: unknown, output?: number, input?: number) {
      connections.push({ from: 'worklet', dest, output, input });
    },
    disconnect() {},
  };

  class FakeAudioWorkletNode {
    parameters = workletNode.parameters;
    port = workletNode.port;
    connect = workletNode.connect.bind(workletNode);
    disconnect = workletNode.disconnect;
    constructor(_ctx: unknown, _name: string, _opts?: unknown) {}
  }
  (globalThis as unknown as { AudioWorkletNode: unknown }).AudioWorkletNode = FakeAudioWorkletNode;

  const ctx = {
    currentTime: 0,
    sampleRate: 48000,
    destination: { kind: 'destination' },
    audioWorklet: { addModule: async () => {} },
    createChannelSplitter: (channels: number) => {
      const s = { kind: 'splitter' as const, channels, disconnect: () => {} };
      splitters.push(s);
      return s;
    },
    createGain: () => {
      const g = {
        kind: 'gain' as const,
        gain: { value: 1 },
        connect(dest: unknown, output?: number, input?: number) {
          connections.push({ from: 'gain', dest, output, input });
        },
        disconnect: () => {},
      };
      gains.push(g);
      return g;
    },
  } as unknown as AudioContext;

  return { ctx, workletNode, splitters, gains, connections };
}

const node = () =>
  ({ id: 'tt', type: 'twotracks', domain: 'audio', position: { x: 0, y: 0 }, params: {}, data: {} }) as never;

describe('twotracks factory: OUT L and OUT R are actually two different edges', () => {
  it('the two output handles are NOT the same node+output pair', async () => {
    const { ctx } = makeMockCtx();
    const handle = await twotracksDef.factory!(ctx, node());
    try {
      const l = handle.outputs!.get('out_l')!;
      const r = handle.outputs!.get('out_r')!;
      expect(
        l.node === r.node && (l.output ?? 0) === (r.output ?? 0),
        `out_l → output ${l.output ?? 0}, out_r → output ${r.output ?? 0} of ` +
          `${l.node === r.node ? 'the SAME node' : 'different nodes'}. If both resolve ` +
          `to one 2-channel bus, patching them into two mono destinations gives ` +
          `(L+R)/2 at BOTH — the module is not stereo at its patch points.`,
      ).toBe(false);
    } finally {
      handle.dispose?.();
    }
  });

  it('goes through a 2-channel splitter fed from the worklet output', async () => {
    const { ctx, splitters, connections } = makeMockCtx();
    const handle = await twotracksDef.factory!(ctx, node());
    try {
      expect(splitters.length, 'exactly one ChannelSplitter').toBe(1);
      expect(splitters[0]!.channels, 'a 2-channel splitter for a stereo bus').toBe(2);

      // The worklet's single stereo output must actually feed it.
      const toSplitter = connections.find((c) => c.from === 'worklet' && c.dest === splitters[0]);
      expect(toSplitter, 'the worklet must connect INTO the splitter').toBeDefined();
      expect(toSplitter!.output ?? 0, 'from worklet output 0').toBe(0);
      expect(toSplitter!.input ?? 0, 'into splitter input 0').toBe(0);

      // …and the two ports must take DIFFERENT splitter outputs, L then R.
      const l = handle.outputs!.get('out_l')!;
      const r = handle.outputs!.get('out_r')!;
      expect(l.node, 'out_l comes off the splitter').toBe(splitters[0]);
      expect(r.node, 'out_r comes off the splitter').toBe(splitters[0]);
      expect(
        [l.output ?? 0, r.output ?? 0],
        'out_l = splitter output 0 (left channel), out_r = splitter output 1 (right channel)',
      ).toEqual([0, 1]);
    } finally {
      handle.dispose?.();
    }
  });

  it('the muted keep-alive sink still hangs off the WORKLET, not the splitter', async () => {
    // The sink exists to keep the worklet pulled even with nothing patched.
    // Moving it onto the splitter would silently change what keeps the node
    // alive, so pin where it hangs.
    const { ctx, gains, connections } = makeMockCtx();
    const handle = await twotracksDef.factory!(ctx, node());
    try {
      const sink = gains[0];
      expect(sink, 'the keep-alive gain must exist').toBeDefined();
      expect(sink!.gain.value, 'the keep-alive sink is MUTED').toBe(0);
      expect(
        connections.some((c) => c.from === 'worklet' && c.dest === sink),
        'the worklet must still feed the muted keep-alive sink',
      ).toBe(true);
    } finally {
      handle.dispose?.();
    }
  });

  it('dispose tears the splitter down too (no leaked node)', async () => {
    const { ctx, splitters } = makeMockCtx();
    const handle = await twotracksDef.factory!(ctx, node());
    let disconnected = 0;
    splitters[0]!.disconnect = () => {
      disconnected++;
    };
    handle.dispose?.();
    expect(disconnected, 'the splitter must be disconnected on dispose').toBe(1);
  });

  it('the INPUT side was never the bug — reel A takes 0/1 and reel B 2/3', async () => {
    // The contrast that identifies this as an output-side mistake. If a future
    // change collapses the inputs the same way, this catches it.
    const { ctx } = makeMockCtx();
    const handle = await twotracksDef.factory!(ctx, node());
    try {
      const ins = handle.inputs!;
      expect(ins.get('audio_l_in_a')!.input).toBe(0);
      expect(ins.get('audio_r_in_a')!.input).toBe(1);
      expect(ins.get('audio_l_in_b')!.input).toBe(2);
      expect(ins.get('audio_r_in_b')!.input).toBe(3);
    } finally {
      handle.dispose?.();
    }
  });
});

describe('twotracks def: the stereo topology is DECLARED', () => {
  it('declares all three stereo pairs (reel A in, reel B in, mixed out)', () => {
    // `stereoPairs` is what the auto-wire planner reads. Without it, patching
    // one side of a stereo pair leaves the other side unwired — the UI half of
    // the same "this module is stereo" claim the splitter fixes in the graph.
    expect(twotracksDef.stereoPairs).toEqual([
      ['audio_l_in_a', 'audio_r_in_a'],
      ['audio_l_in_b', 'audio_r_in_b'],
      ['out_l', 'out_r'],
    ]);
  });

  it('every declared pair member is a REAL port, on the right side', () => {
    // Anchor to the artifact, not the list: a pair naming a port that does not
    // exist (or lives on the other side) is dead declaration, and
    // planStereoAutowire would silently return null for it.
    const inIds = new Set(twotracksDef.inputs.map((p) => p.id));
    const outIds = new Set(twotracksDef.outputs.map((p) => p.id));
    for (const [l, r] of twotracksDef.stereoPairs!) {
      const side = inIds.has(l) ? 'input' : outIds.has(l) ? 'output' : 'NOWHERE';
      expect(side, `pair member "${l}" must exist as a port`).not.toBe('NOWHERE');
      const rSide = inIds.has(r) ? 'input' : outIds.has(r) ? 'output' : 'NOWHERE';
      expect(rSide, `pair member "${r}" must exist as a port`).toBe(side);
    }
  });

  it('chainWiring still wins over stereoPairs (precedence 0) — reel A in, A/B out', () => {
    // Adding stereoPairs must NOT move the column/chain wiring. The override is
    // consulted first in resolveMainAudioIn/Out; this pins that it is still
    // declared, so the resolution asserted in patch-convenience-columns.test.ts
    // cannot drift as a side effect of this change.
    expect(twotracksDef.chainWiring).toEqual({
      role: 'both',
      inPorts: ['audio_l_in_a', 'audio_r_in_a'],
      outPorts: ['out_l', 'out_r'],
    });
  });
});
