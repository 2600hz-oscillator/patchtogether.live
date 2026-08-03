// packages/web/src/lib/audio/modules/ringback.test.ts
//
// Unit tests for RINGBACK — the stereo crush effect (the TWOTRACKS record-time
// artifact, made intentional). Pins the module-def shape (stereo in/out, the 4
// crush params + ranges) and the re-exported crush core math (so the card + the
// audio module share one import surface). The full per-sample DSP is unit-tested
// in packages/dsp/src/lib/ringback-core.test.ts (the code the worklet runs).

import { describe, expect, it } from 'vitest';
import {
  ringbackDef,
  RingChannel,
  ringRead,
  mixSample,
  clampFeedback,
  RINGBACK_MAX_FEEDBACK,
} from './ringback';

describe('ringback re-exports the crush core (one shared import surface)', () => {
  it('re-exports RingChannel + the pure crush helpers', () => {
    expect(typeof RingChannel).toBe('function');
    expect(ringRead(new Float32Array([0, 10]), 0.5, 2)).toBeCloseTo(5);
    expect(mixSample(1, 0, 0)).toBe(1);
    expect(clampFeedback(5)).toBe(RINGBACK_MAX_FEEDBACK);
  });

  it('a RingChannel with mix=0 is a clean passthrough (sanity)', () => {
    const ch = new RingChannel();
    for (const x of [0.1, -0.2, 0.5, -0.7]) {
      expect(ch.step(x, 1, 64, 0, 0)).toBeCloseTo(x, 6);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// STEREO — the module claims two independent outputs. It shipped with one.
//
// The worklet is `numberOfOutputs: 1, outputChannelCount: [2]`, i.e. a SINGLE
// two-channel output. The factory then mapped BOTH port handles to
// `{ node: worklet, output: 0 }` with no splitter, so `out_l` and `out_r` were
// literally the same graph edge: patch them into two mono destinations and
// Web Audio down-mixes the 2-channel bus to mono at each one, giving
// (L+R)/2 at BOTH. The module's own docs describe the two channels as
// separate, and the def declares a `stereoPairs` entry that the patch-helper
// uses to auto-wire them.
//
// Why nothing caught it: the crush core is per-channel and correct, the ART
// profile renders ONE channel by design, and every test drove the core class
// rather than the factory handle. A mono source also gives L === R, which is
// the state every casual check was in.
// ─────────────────────────────────────────────────────────────────────────
describe('ringback factory: OUT L and OUT R are actually two different signals', () => {
  function makeMockCtx() {
    const worklet = {
      parameters: new Map(ringbackDef.params.map((p) => [p.id, { value: p.defaultValue, setValueAtTime(v: number) { this.value = v; } }])),
      connections: [] as { dest: unknown; output?: number; input?: number }[],
      connect(dest: unknown, output?: number, input?: number) { this.connections.push({ dest, output, input }); },
      disconnect() {},
    };
    const splitters: Array<{ channels: number; connect: () => void; disconnect: () => void }> = [];
    class FakeAudioWorkletNode {
      parameters = worklet.parameters;
      connect = worklet.connect.bind(worklet);
      disconnect = worklet.disconnect;
      constructor(_c: unknown, _n: string, _o?: unknown) {}
    }
    (globalThis as unknown as { AudioWorkletNode: unknown }).AudioWorkletNode = FakeAudioWorkletNode;
    const ctx = {
      currentTime: 0,
      sampleRate: 48000,
      audioWorklet: { addModule: async () => {} },
      createChannelSplitter: (channels: number) => {
        const s = { channels, connect: () => {}, disconnect: () => {} };
        splitters.push(s);
        return s;
      },
    } as unknown as AudioContext;
    return { ctx, worklet, splitters };
  }

  const node = () =>
    ({ id: 'rb', type: 'ringback', domain: 'audio', position: { x: 0, y: 0 }, params: {}, data: {} }) as never;

  it('the two output handles are NOT the same node+output pair', async () => {
    const { ctx } = makeMockCtx();
    const handle = await ringbackDef.factory!(ctx, node());
    const l = handle.outputs!.get('out_l')!;
    const r = handle.outputs!.get('out_r')!;
    expect(
      l.node === r.node && (l.output ?? 0) === (r.output ?? 0),
      `out_l → output ${l.output ?? 0}, out_r → output ${r.output ?? 0} of ` +
        `${l.node === r.node ? 'the SAME node' : 'different nodes'}. If both ` +
        `resolve to one 2-channel bus, patching them into two mono ` +
        `destinations gives (L+R)/2 at BOTH — the module is not stereo.`,
    ).toBe(false);
  });

  it('goes through a 2-channel splitter fed from the worklet output', async () => {
    const { ctx, worklet, splitters } = makeMockCtx();
    const handle = await ringbackDef.factory!(ctx, node());
    expect(splitters.length, 'exactly one ChannelSplitter').toBe(1);
    expect(splitters[0]!.channels, 'a 2-channel splitter for a stereo bus').toBe(2);
    // The worklet's single stereo output must feed it.
    const toSplitter = worklet.connections.find((c) => c.dest === splitters[0]);
    expect(toSplitter, 'the worklet must connect INTO the splitter').toBeDefined();
    expect(toSplitter!.output ?? 0, 'from worklet output 0').toBe(0);
    // …and the two ports must take DIFFERENT splitter outputs.
    const l = handle.outputs!.get('out_l')!;
    const r = handle.outputs!.get('out_r')!;
    expect(l.node).toBe(splitters[0]);
    expect(r.node).toBe(splitters[0]);
    expect([l.output ?? 0, r.output ?? 0]).toEqual([0, 1]);
  });

  it('dispose tears the splitter down too (no leaked node)', async () => {
    const { ctx, splitters } = makeMockCtx();
    let disconnected = 0;
    const handle = await ringbackDef.factory!(ctx, node());
    splitters[0]!.disconnect = () => { disconnected++; };
    handle.dispose?.();
    expect(disconnected, 'the splitter must be disconnected on dispose').toBe(1);
  });
});
