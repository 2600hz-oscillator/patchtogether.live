// packages/web/src/lib/audio/modules/snaredrum-factory-strike.test.ts
//
// THE HOST-SIDE AUDIO WIRING FOR THE TWO AUDITIONS, against the REAL factory.
//
// ⚠ WHY THIS FILE EXISTS — the kickdrum #1277 lesson, applied before it bites.
// Every OTHER gate around this feature drives a FAKE. `manual-strike-actions
// .test.ts` injects a `fakeEngine()`; `snaredrum-face.test.ts` reads selector
// projections; `module-face-lint`, `contract-lock` and `module-docs-*` read the
// DEF; faces-parity presses the button and asserts `aria-pressed` moved. Delete
// `hitCs`/`rollCs` and the whole `read(key)` block from `snaredrum.ts` and ALL
// of them stay green — the only red would be one workflow-mode e2e. That is a
// shipped feature resting on a single browser assertion.
//
// The harness is the moog905 / kickdrum idiom: a minimal Web Audio mock driving
// the REAL `snaredrumDef.factory`, so every assertion below is about the
// shipped wiring rather than about a stub.
//
// THE INPUT INDEX IS THE ASSERTION, not a detail. snaredrum has SIX worklet
// inputs and the two auditions target two different ones (0 = trigger_in,
// 1 = gate_in). A hit source landing on input 1 would hold the ROLL gate at a
// 5 ms pulse (silently nothing), and a roll source landing on input 0 would
// fire one hit and then hold the trigger high FOREVER, choking the voice. Both
// "work" as graph edges. Only the index tells them apart.

import { describe, it, expect, vi } from 'vitest';
import { snaredrumDef } from './snaredrum';
import { MANUAL_GATE_KEY, MANUAL_STRIKE_KEY } from '$lib/ui/modules/manual-strike-actions';
import { GATE_HI, TRIGGER_PULSE_S } from '$lib/audio/gate-trigger';
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

const NOW = 7; // a non-zero "now" so the emitted times are checkable

function makeMockCtx() {
  const sources: ReturnType<typeof mockConstantSource>[] = [];
  const worklet = {
    parameters: new Map(snaredrumDef.params.map((p) => [p.id, mockParam(p.defaultValue)])),
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
    currentTime: NOW,
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
  ({ id: 'sd-factory', type: 'snaredrum', domain: 'audio', position: { x: 0, y: 0 }, params: {}, data: {} }) as ModuleNode;

/** The worklet input indices the FACTORY's own port map declares. Read off the
 *  handle rather than hardcoded, so this file cannot drift from the map. */
async function build() {
  const m = makeMockCtx();
  const handle = await snaredrumDef.factory!(m.ctx, node());
  const triggerInput = handle.inputs.get('trigger_in')!.input;
  const gateInput = handle.inputs.get('gate_in')!.input;
  // The KEEP-ALIVE source connects to all six inputs; the two audition sources
  // connect exactly once each, and they are told apart by WHICH input.
  const single = m.sources.filter((s) => s.connections.length === 1);
  const hit = single.find((s) => s.connections[0]!.input === triggerInput)!;
  const roll = single.find((s) => s.connections[0]!.input === gateInput)!;
  const silence = m.sources.find((s) => s.connections.length === 6)!;
  return { ...m, handle, triggerInput, gateInput, hit, roll, silence };
}

describe('snaredrum factory — the two auditions are really wired to their own inputs', () => {
  it('the trigger and gate inputs are DIFFERENT worklet inputs (the premise)', async () => {
    const { triggerInput, gateInput } = await build();
    expect(triggerInput).toBe(0);
    expect(gateInput).toBe(1);
    expect(triggerInput, 'two strike inputs, two indices').not.toBe(gateInput);
  });

  it('answers BOTH read keys with a callable, and nothing else', async () => {
    const { handle } = await build();
    expect(typeof handle.read?.(MANUAL_STRIKE_KEY)).toBe('function');
    expect(typeof handle.read?.(MANUAL_GATE_KEY)).toBe('function');
    expect(handle.read?.('somethingElse'), 'the seam is not a catch-all').toBeUndefined();
    expect(handle.read?.('manual'), 'nor a prefix match').toBeUndefined();
  });

  it('has TWO dedicated sources, one per strike input, distinct from the keep-alive', async () => {
    const { sources, hit, roll, silence } = await build();
    expect(sources.length, 'silence keep-alive + hit source + roll source').toBe(3);
    expect(hit, 'a dedicated source on trigger_in').toBeDefined();
    expect(roll, 'a dedicated source on gate_in').toBeDefined();
    expect(silence, 'the 6-input silence keep-alive').toBeDefined();
    expect(hit).not.toBe(roll);
    expect(hit).not.toBe(silence);

    for (const [name, s] of [['hit', hit], ['roll', roll]] as const) {
      expect(s.started, `${name}: a ConstantSource that is never started emits nothing`).toBe(1);
      expect(s.offset.value, `${name}: must REST at 0 — a source resting high holds its input`).toBe(0);
    }
  });

  it('HIT emits the SHARED canonical trigger pulse, and only on the trigger source', async () => {
    const { handle, hit, roll } = await build();
    hit.offset.events.length = 0;
    roll.offset.events.length = 0;
    (handle.read!(MANUAL_STRIKE_KEY) as () => void)();

    // The `$lib/audio/gate-trigger` triangle — asserted against the SHARED
    // constant, never a re-typed 0.005.
    expect(hit.offset.events).toEqual([
      { kind: 'set', value: 0, time: NOW },
      { kind: 'ramp', value: 1, time: NOW + TRIGGER_PULSE_S / 2 },
      { kind: 'ramp', value: 0, time: NOW + TRIGGER_PULSE_S },
    ]);
    expect(roll.offset.events, 'a HIT must not touch the roll gate').toEqual([]);
  });

  it('a second HIT is a second pulse — never a latch', async () => {
    const { handle, hit } = await build();
    const fire = handle.read!(MANUAL_STRIKE_KEY) as () => void;
    hit.offset.events.length = 0;
    fire();
    fire();
    expect(hit.offset.events.filter((e) => e.value === 1)).toHaveLength(2);
    expect(
      hit.offset.events.at(-1),
      'the last event must return to 0 — a stuck-high trigger chokes the voice',
    ).toEqual({ kind: 'ramp', value: 0, time: NOW + TRIGGER_PULSE_S });
  });

  it('ROLL holds its gate HIGH while true and returns to 0 on false', async () => {
    const { handle, hit, roll } = await build();
    hit.offset.events.length = 0;
    roll.offset.events.length = 0;
    const setGate = handle.read!(MANUAL_GATE_KEY) as (high: boolean) => void;

    setGate(true);
    expect(roll.offset.events).toEqual([{ kind: 'set', value: 1, time: NOW }]);
    // A HELD gate is a level, not a pulse: it must NOT schedule its own return.
    // If it did, a long roll would stop on its own after 5 ms.
    expect(roll.offset.value, `held HIGH, and above GATE_HI (${GATE_HI})`).toBeGreaterThan(GATE_HI);

    setGate(false);
    expect(roll.offset.events.at(-1)).toEqual({ kind: 'set', value: 0, time: NOW });
    expect(roll.offset.value, 'the release returns it below the gate threshold').toBeLessThan(GATE_HI);
    expect(hit.offset.events, 'a ROLL must not touch the trigger source').toEqual([]);
  });

  it('dispose() CLOSES the roll gate before stopping its source', async () => {
    // The leak that matters most: a node deleted mid-hold. `<Button>` unmounts
    // with the pane, so no pointerup ever reaches it, and the last thing the
    // graph saw was `openGate`. Order is load-bearing — closing AFTER stop()
    // would schedule onto a stopped source.
    const { handle, hit, roll } = await build();
    const setGate = handle.read!(MANUAL_GATE_KEY) as (high: boolean) => void;
    setGate(true);
    roll.offset.events.length = 0;

    handle.dispose?.();

    expect(
      roll.offset.events,
      'dispose must write the gate LOW — a node deleted mid-hold would roll forever',
    ).toEqual([{ kind: 'set', value: 0, time: NOW }]);
    expect(roll.stopped, 'and then stop the source (a live ConstantSource is a leak)').toBe(1);
    expect(hit.stopped).toBe(1);
  });
});
