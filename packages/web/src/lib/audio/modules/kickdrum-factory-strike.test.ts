// packages/web/src/lib/audio/modules/kickdrum-factory-strike.test.ts
//
// THE HOST-SIDE AUDIO WIRING FOR THE AUDITION, against the REAL factory.
//
// ⚠ WHY THIS FILE EXISTS. Before it, the entire host side of the STRIKE feature
// — the dedicated ConstantSource, its connection into the worklet's TRIGGER
// input, and the `read('manualTrigger')` handle key both faces call — rested on
// exactly ONE assertion anywhere in the repo: `after.peak > 0.05` in
// `e2e/tests/kickdrum-face.spec.ts`. Delete `strikeCs` and the `read(key)`
// block from `kickdrum.ts` and:
//
//   * kickdrum-face.test.ts        → 14/14 green (selector projections only)
//   * kickdrum-strike-actions.test → 5/5 green: EVERY test drives `fakeEngine()`
//                                    and never the real factory, so its
//                                    "writes NOTHING to the graph" clause would
//                                    pass against a handle with no `read` at all
//   * module-face-lint / contract-lock / module-docs-* → green
//   * faces-parity                 → green (asserts the button is enabled and
//                                    clicks it; no effect assertion)
//
// …leaving one workflow-mode e2e, on the default 30 s timeout, under
// SwiftShader, as the single point of failure for a shipped feature. That is
// the "a gate that reads one side proves nothing about the other" shape with
// the sides being MODEL and ENGINE.
//
// The harness is the moog905 idiom: a minimal Web Audio mock (addModule +
// AudioWorkletNode + createConstantSource + createChannelSplitter) driving the
// REAL `kickdrumDef.factory`, so the assertions are about the shipped wiring
// rather than about a fake.

import { describe, it, expect, vi } from 'vitest';
import { kickdrumDef } from './kickdrum';
import { KICKDRUM_STRIKE_KEY } from '$lib/ui/modules/kickdrum-strike-actions';
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
    parameters: new Map(kickdrumDef.params.map((p) => [p.id, mockParam(p.defaultValue)])),
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
  const splitter = { connect: vi.fn(), disconnect: vi.fn() };

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
    createChannelSplitter: () => splitter,
  } as unknown as AudioContext;

  return { ctx, worklet, splitter, sources };
}

const node = (): ModuleNode =>
  ({ id: 'kd-factory', type: 'kickdrum', domain: 'audio', position: { x: 0, y: 0 }, params: {}, data: {} }) as ModuleNode;

/** The kickdrum worklet's TRIGGER input index (factory comment: trigger 0,
 *  accent 1, pitch 2, choke 3) — asserted, not assumed, via the port map. */
const TRIGGER_INPUT = 0;

describe('kickdrum factory — the STRIKE audition is really wired to the trigger input', () => {
  it('answers the manualTrigger read key with a callable', async () => {
    const { ctx } = makeMockCtx();
    const handle = await kickdrumDef.factory!(ctx, node());
    expect(typeof handle.read?.(KICKDRUM_STRIKE_KEY)).toBe('function');
  });

  it('has a DEDICATED ConstantSource on the trigger input, separate from the keep-alive', async () => {
    const { ctx, sources } = makeMockCtx();
    await kickdrumDef.factory!(ctx, node());

    // Two sources: the 4-connection silence keep-alive, and the 1-connection
    // strike source. Naming them by their connection count rather than by
    // creation order keeps this from pinning an incidental ordering.
    expect(sources.length, 'silence keep-alive + strike source').toBe(2);
    const strike = sources.find((s) => s.connections.length === 1)!;
    const silence = sources.find((s) => s.connections.length === 4)!;
    expect(strike, 'a dedicated strike ConstantSource').toBeDefined();
    expect(silence, 'the 4-input silence keep-alive').toBeDefined();
    expect(strike).not.toBe(silence);

    // It must land on the TRIGGER input specifically — an accent/pitch/choke
    // connection would still "work" as a graph edge and do the wrong thing.
    expect(strike.connections[0]!.input).toBe(TRIGGER_INPUT);
    expect(strike.started, 'a ConstantSource that is never started emits nothing').toBe(1);
    expect(strike.offset.value, 'it must REST at 0 so it does not hold the trigger high').toBe(0);
  });

  it('firing the handle emits the SHARED canonical trigger pulse on that source', async () => {
    const { ctx, sources } = makeMockCtx();
    const handle = await kickdrumDef.factory!(ctx, node());
    const strike = sources.find((s) => s.connections.length === 1)!;

    strike.offset.events.length = 0;
    (handle.read!(KICKDRUM_STRIKE_KEY) as () => void)();

    // The `$lib/audio/gate-trigger` triangle: 0 at now, up to 1 at now+w/2,
    // back to 0 at now+w. Asserted against the SHARED constant, never a
    // re-typed 0.005 — the whole point of that module.
    const now = 7;
    expect(strike.offset.events).toEqual([
      { kind: 'set', value: 0, time: now },
      { kind: 'ramp', value: 1, time: now + TRIGGER_PULSE_S / 2 },
      { kind: 'ramp', value: 0, time: now + TRIGGER_PULSE_S },
    ]);
  });

  it('a second fire is a second pulse — no latching, and it never holds high', async () => {
    const { ctx, sources } = makeMockCtx();
    const handle = await kickdrumDef.factory!(ctx, node());
    const strike = sources.find((s) => s.connections.length === 1)!;
    const fire = handle.read!(KICKDRUM_STRIKE_KEY) as () => void;

    strike.offset.events.length = 0;
    fire();
    fire();
    expect(strike.offset.events.filter((e) => e.value === 1)).toHaveLength(2);
    expect(
      strike.offset.events.at(-1),
      'the last automation event must return to 0 — a stuck-high trigger chokes the voice',
    ).toEqual({ kind: 'ramp', value: 0, time: 7 + TRIGGER_PULSE_S });
  });

  it('an UNKNOWN read key is undefined — the seam is not a catch-all', async () => {
    const { ctx } = makeMockCtx();
    const handle = await kickdrumDef.factory!(ctx, node());
    expect(handle.read?.('somethingElse')).toBeUndefined();
  });

  it('dispose() stops the strike source (a live ConstantSource is a leak)', async () => {
    const { ctx, sources } = makeMockCtx();
    const handle = await kickdrumDef.factory!(ctx, node());
    const strike = sources.find((s) => s.connections.length === 1)!;
    handle.dispose?.();
    expect(strike.stopped).toBe(1);
  });
});
