// packages/web/src/lib/audio/modules/karplus-factory-strike.test.ts
//
// THE HOST-SIDE AUDIO WIRING FOR THE PLUCK, against the REAL factory.
//
// ⚠ WHY THIS FILE EXISTS. karplus has carried a `strikeCs` ConstantSource and a
// `read('manualTrigger')` handle key since it shipped, and NOTHING in the repo
// asserted either of them. Delete both from `karplus.ts` and, measured on this
// branch's parent:
//
//   * karplus.test.ts             → green. Its "a strike rings audibly" case
//                                   drives the WORKLET directly with a
//                                   synthesised trigger buffer; it never calls
//                                   the factory.
//   * karplus-face.test.ts        → green (pure selector projections).
//   * manual-strike-actions.test  → green: every case drives `fakeEngine()`,
//                                   so it would pass against a handle with no
//                                   `read` at all.
//   * contract-lock / module-face-lint / module-docs-lint → green.
//   * faces-parity                → green (asserts the button is enabled and
//                                   clicks it; no effect assertion).
//
// …i.e. before this file the only witness to the whole feature was one
// workflow-mode e2e under SwiftShader. That is the "a gate that reads one side
// proves nothing about the other" shape, with the sides being MODEL and ENGINE.
// This is the kickdrum-factory-strike.test.ts idiom applied to the module the
// audition matters most on: karplus has no exciter, so an unpatched, unstruck
// karplus is not quiet — it is MUTE.
//
// The harness is the moog905 idiom: a minimal Web Audio mock (addModule +
// AudioWorkletNode + createConstantSource) driving the REAL `karplusDef.factory`,
// so the assertions are about the shipped wiring rather than about a fake.

import { describe, it, expect, vi } from 'vitest';
import { karplusDef } from './karplus';
import { MANUAL_STRIKE_KEY } from '$lib/ui/modules/manual-strike-actions';
import { TRIGGER_PULSE_S } from '$lib/audio/gate-trigger';
import type { ModuleNode } from '$lib/graph/types';

/** One recorded automation write on a mock AudioParam. */
type Evt = { kind: 'set' | 'ramp'; value: number; time: number };

function mockParam(initial = 0) {
  const events: Evt[] = [];
  return {
    value: initial,
    events,
    setValueAtTime(v: number, t: number) {
      events.push({ kind: 'set', value: v, time: t });
      this.value = v;
    },
    linearRampToValueAtTime(v: number, t: number) {
      events.push({ kind: 'ramp', value: v, time: t });
    },
  };
}

/** A ConstantSource stub that records what it was connected to, and where. */
function mockConstantSource() {
  return {
    offset: mockParam(1),
    started: 0,
    stopped: 0,
    disconnects: 0,
    connections: [] as { dest: unknown; output?: number; input?: number }[],
    start() { this.started++; },
    stop() { this.stopped++; },
    connect(dest: unknown, output?: number, input?: number) {
      this.connections.push({ dest, output, input });
    },
    disconnect() { this.disconnects++; },
  };
}

function makeMockCtx() {
  const sources: ReturnType<typeof mockConstantSource>[] = [];
  const worklet = {
    parameters: new Map(karplusDef.params.map((p) => [p.id, mockParam(p.defaultValue)])),
    connect: vi.fn(),
    disconnect: vi.fn(),
  };

  class FakeAudioWorkletNode {
    parameters = worklet.parameters;
    connect = worklet.connect;
    disconnect = worklet.disconnect;
    constructor(_ctx: unknown, _name: string, _opts?: unknown) {}
  }
  (globalThis as unknown as { AudioWorkletNode: unknown }).AudioWorkletNode = FakeAudioWorkletNode;

  const ctx = {
    currentTime: 7, // a non-zero "now" so the pulse's own times are checkable
    sampleRate: 48000,
    audioWorklet: { addModule: vi.fn(async () => {}) },
    createConstantSource: () => {
      const s = mockConstantSource();
      sources.push(s);
      return s;
    },
  } as unknown as AudioContext;

  return { ctx, worklet, sources };
}

const node = (): ModuleNode =>
  ({ id: 'kp-factory', type: 'karplus', domain: 'audio', position: { x: 0, y: 0 }, params: {}, data: {} }) as ModuleNode;

/** The karplus worklet's TRIGGER input index — asserted against the handle's
 *  own port map below rather than trusted from the factory's comment. */
const TRIGGER_INPUT = 0;

describe('karplus factory — the PLUCK audition is really wired to the trigger input', () => {
  it('answers the manualTrigger read key with a callable', async () => {
    const { ctx } = makeMockCtx();
    const handle = await karplusDef.factory!(ctx, node());
    expect(typeof handle.read?.(MANUAL_STRIKE_KEY)).toBe('function');
  });

  it('has a DEDICATED ConstantSource on the trigger input, separate from the keep-alive', async () => {
    const { ctx, sources } = makeMockCtx();
    const handle = await karplusDef.factory!(ctx, node());

    // Two sources: the 4-connection silence keep-alive, and the 1-connection
    // strike source. Naming them by their connection count rather than by
    // creation order keeps this from pinning an incidental ordering.
    expect(sources.length, 'silence keep-alive + strike source').toBe(2);
    const strike = sources.find((s) => s.connections.length === 1)!;
    const silence = sources.find((s) => s.connections.length === 4)!;
    expect(strike, 'a dedicated strike ConstantSource').toBeDefined();
    expect(silence, 'the 4-input silence keep-alive').toBeDefined();
    expect(strike).not.toBe(silence);

    // It must land on the TRIGGER input specifically — a pitch/accent/damp
    // connection would still "work" as a graph edge and do the wrong thing.
    // The index is read off the handle's OWN port map, so this cannot drift
    // with the factory's comment.
    expect(handle.inputs.get('trigger_in')!.input).toBe(TRIGGER_INPUT);
    expect(strike.connections[0]!.input).toBe(TRIGGER_INPUT);
    expect(strike.started, 'a ConstantSource that is never started emits nothing').toBe(1);
    expect(strike.offset.value, 'it must REST at 0 so it does not hold the trigger high').toBe(0);
  });

  it('firing the handle emits the SHARED canonical trigger pulse on that source', async () => {
    const { ctx, sources } = makeMockCtx();
    const handle = await karplusDef.factory!(ctx, node());
    const strike = sources.find((s) => s.connections.length === 1)!;

    strike.offset.events.length = 0;
    (handle.read!(MANUAL_STRIKE_KEY) as () => void)();

    // The `$lib/audio/gate-trigger` triangle: 0 at now, up to 1 at now+w/2,
    // back to 0 at now+w. Asserted against the SHARED constant, never a
    // re-typed number — the whole point of that module.
    const now = 7;
    expect(strike.offset.events).toEqual([
      { kind: 'set', value: 0, time: now },
      { kind: 'ramp', value: 1, time: now + TRIGGER_PULSE_S / 2 },
      { kind: 'ramp', value: 0, time: now + TRIGGER_PULSE_S },
    ]);
  });

  it('a second pluck is a second pulse — no latching, and it never holds high', async () => {
    const { ctx, sources } = makeMockCtx();
    const handle = await karplusDef.factory!(ctx, node());
    const strike = sources.find((s) => s.connections.length === 1)!;
    const fire = handle.read!(MANUAL_STRIKE_KEY) as () => void;

    strike.offset.events.length = 0;
    fire();
    fire();
    expect(strike.offset.events.filter((e) => e.value === 1)).toHaveLength(2);
    expect(
      strike.offset.events.at(-1),
      'the last automation event must return to 0 — a stuck-high trigger chokes the voice',
    ).toEqual({ kind: 'ramp', value: 0, time: 7 + TRIGGER_PULSE_S });
  });

  it('the PLUCK does not disturb a patched cable: it sums into the SAME input trigger_in feeds', async () => {
    // This is the property the docs promise ("a cable already patched into
    // trigger_in keeps working while you use it"), and it is entirely a
    // consequence of the strike source landing on the port's own node input
    // rather than on a private one.
    const { ctx, sources } = makeMockCtx();
    const handle = await karplusDef.factory!(ctx, node());
    const strike = sources.find((s) => s.connections.length === 1)!;
    const port = handle.inputs.get('trigger_in')!;
    expect(strike.connections[0]!.dest, 'same destination node as the patched port').toBe(port.node);
    expect(strike.connections[0]!.input).toBe(port.input);
    expect(port.param, 'trigger_in is a NODE input, not an AudioParam target').toBeUndefined();
  });

  it('an UNKNOWN read key is undefined — the seam is not a catch-all', async () => {
    const { ctx } = makeMockCtx();
    const handle = await karplusDef.factory!(ctx, node());
    expect(handle.read?.('somethingElse')).toBeUndefined();
  });

  it('dispose() stops the strike source (a live ConstantSource is a leak)', async () => {
    const { ctx, sources } = makeMockCtx();
    const handle = await karplusDef.factory!(ctx, node());
    const strike = sources.find((s) => s.connections.length === 1)!;
    handle.dispose?.();
    expect(strike.stopped).toBe(1);
  });
});
