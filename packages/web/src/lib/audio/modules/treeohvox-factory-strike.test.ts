// packages/web/src/lib/audio/modules/treeohvox-factory-strike.test.ts
//
// THE HOST-SIDE AUDIO WIRING FOR THE MANUAL GATE, against the REAL factory.
//
// ⚠ WHY THIS FILE EXISTS — and it is a MEASUREMENT, not a hunch (#1658).
// TREE.oh.VOX shipped with no way for a player to sound it. Driven for real in
// chromium on `/rack`, with the module spawned and nothing patched:
//
//   * every one of the TWENTY-FIVE pressables on the card clicked (the name
//     label, both patch triggers, the eleven jacks, the knobs) →
//     `audio_out` peak = 0.000e+0 over 145 accumulated frames;
//   * the same on the default rack's shell face and in its dock full-view →
//     0.000e+0 over 146 frames;
//   * `engine.read(node, 'manualTrigger')` and `…'manualGate'` → BOTH
//     `undefined`;
//   * POSITIVE CONTROL, same analyser, same page: a sequencer gate patched into
//     `gate_in` → peak 3.390e-1 over 182 frames.
//
// So the zero was the module, not the instrument. That is the rings/sixstrum
// class exactly: a voice with no internal exciter and no surface that can
// excite it.
//
// WHAT WAS GREEN THROUGHOUT, i.e. what this file has to add that nothing else
// could see:
//   * `treeohvox-dsp.test.ts` / `-envelope` / `-brightness` — the DSP, driven
//     directly with a synthesised gate. Green on a module no user can play.
//   * `art/scenarios/treeohvox/voice-character.test.ts` — the engine class with
//     a synthetic note source. Same blindness.
//   * `per-module-per-port` — asserts the gate EDGE MATERIALISES from an
//     upstream sequencer, which is the case where treeohvox already worked.
//   * `contract-lock` / `module-docs-lint` — read the DEF.
// The observable is "can a person sound this from a surface", and nothing asked
// it. This asserts the ENGINE half; `e2e/tests/treeohvox-strike.spec.ts`
// asserts the surface half against real audio.
//
// The harness is the karplus/kickdrum-factory-strike idiom: a minimal Web Audio
// mock driving the REAL `treeohvoxDef.factory`, so the assertions are about the
// shipped wiring rather than about a fake.

import { describe, it, expect, vi } from 'vitest';
import { treeohvoxDef } from './treeohvox';
import { MANUAL_GATE_KEY, MANUAL_STRIKE_KEY } from '$lib/ui/modules/manual-strike-actions';
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
    parameters: new Map(treeohvoxDef.params.map((p) => [p.id, mockParam(p.defaultValue)])),
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
    currentTime: 7, // a non-zero "now" so the edge times are checkable
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
  ({ id: 'tv-factory', type: 'treeohvox', domain: 'audio', position: { x: 0, y: 0 }, params: {}, data: {} }) as ModuleNode;

/** The gate source is the ONE-connection ConstantSource; `silence` fans out to
 *  three inputs. Named by connection count rather than creation order so this
 *  does not pin an incidental ordering. */
const gateSourceOf = (sources: ReturnType<typeof mockConstantSource>[]) =>
  sources.find((s) => s.connections.length === 1)!;
const silenceOf = (sources: ReturnType<typeof mockConstantSource>[]) =>
  sources.find((s) => s.connections.length === 3)!;

describe('treeohvox factory — the manual GATE is really wired to gate_in', () => {
  it('answers the manualGate read key with a callable', async () => {
    const { ctx } = makeMockCtx();
    const handle = await treeohvoxDef.factory!(ctx, node());
    expect(typeof handle.read?.(MANUAL_GATE_KEY)).toBe('function');
  });

  it('DOES NOT answer manualTrigger — the def says gate, and the omission is load-bearing', async () => {
    // `gate_in` declares `edge: 'gate'` and the processor acts on BOTH edges, so
    // the note lasts as long as the level is high. The shared one-shot is a 5 ms
    // pulse, which would end every auditioned note 5 ms after it began. A caller
    // reaching for the wrong shape must get `undefined` — the audition ledger
    // then records `delivered: false`, which is the honest answer — rather than
    // a blip that looks like the feature working.
    const { ctx } = makeMockCtx();
    const handle = await treeohvoxDef.factory!(ctx, node());
    expect(handle.read?.(MANUAL_STRIKE_KEY)).toBeUndefined();
  });

  it('the port DECLARES the gate shape this seam implements', async () => {
    // The other half of the two-sided contract: a def-reading gate cannot see
    // the factory, and the factory assertions above cannot see the def. If
    // someone re-declares `gate_in` as `edge: 'trigger'`, the seam above becomes
    // the wrong shape and nothing else in the suite would say so.
    const gateIn = treeohvoxDef.inputs.find((p) => p.id === 'gate_in')!;
    expect(gateIn.edge, "gate_in must stay edge:'gate' — the manualGate seam depends on it").toBe('gate');
  });

  it('has a DEDICATED ConstantSource on gate_in, separate from the keep-alive', async () => {
    const { ctx, sources } = makeMockCtx();
    const handle = await treeohvoxDef.factory!(ctx, node());

    expect(sources.length, 'the 3-input silence keep-alive + the gate source').toBe(2);
    const gate = gateSourceOf(sources);
    const silence = silenceOf(sources);
    expect(gate, 'a dedicated gate ConstantSource').toBeDefined();
    expect(silence, 'the 3-input silence keep-alive').toBeDefined();
    expect(gate).not.toBe(silence);

    // ⚠ IT MUST LAND ON gate_in SPECIFICALLY. `silence` fans out to inputs
    // 0/1/2, so driving IT would also drive PITCH and ACCENT: every audition
    // would transpose the voice and latch an accent. The index is read off the
    // handle's OWN port map, so this cannot drift with the factory's comment.
    const port = handle.inputs.get('gate_in')!;
    expect(gate.connections[0]!.input).toBe(port.input);
    expect(port.param, 'gate_in is a NODE input, not an AudioParam target').toBeUndefined();
    expect(gate.started, 'a ConstantSource that is never started emits nothing').toBe(1);
    expect(gate.offset.value, 'it must REST at 0 so it does not hold the note on forever').toBe(0);
  });

  it('NEGATIVE CONTROL: the gate source is NOT on pitch_in or accent_in', async () => {
    // The mis-wiring this file most needs to catch is not "no source" but
    // "a source on the wrong input" — that still sounds, and sounds wrong.
    const { ctx, sources } = makeMockCtx();
    const handle = await treeohvoxDef.factory!(ctx, node());
    const gate = gateSourceOf(sources);
    for (const wrong of ['pitch_in', 'accent_in'] as const) {
      expect(
        gate.connections[0]!.input,
        `the gate source must not land on ${wrong}`,
      ).not.toBe(handle.inputs.get(wrong)!.input);
    }
  });

  it('press → HELD HIGH, release → back to 0 (both edges, at the context clock)', async () => {
    const { ctx, sources } = makeMockCtx();
    const handle = await treeohvoxDef.factory!(ctx, node());
    const gate = gateSourceOf(sources);
    const setGate = handle.read!(MANUAL_GATE_KEY) as (high: boolean) => void;

    gate.offset.events.length = 0;
    setGate(true);
    expect(
      gate.offset.events,
      'the press must HOLD the level high — a pulse here would end the note 5 ms in',
    ).toEqual([{ kind: 'set', value: 1, time: 7 }]);

    setGate(false);
    expect(
      gate.offset.events.at(-1),
      'the release must return to 0 — a gate that never closes is a note that never ends',
    ).toEqual({ kind: 'set', value: 0, time: 7 });
  });

  it('the audition does not disturb a patched cable: it sums into the SAME input gate_in feeds', async () => {
    // The property the docs promise ("a real patched gate keeps working
    // alongside it"), and it is entirely a consequence of the gate source
    // landing on the port's own node input rather than on a private one.
    const { ctx, sources } = makeMockCtx();
    const handle = await treeohvoxDef.factory!(ctx, node());
    const gate = gateSourceOf(sources);
    const port = handle.inputs.get('gate_in')!;
    expect(gate.connections[0]!.dest, 'same destination node as the patched port').toBe(port.node);
    expect(gate.connections[0]!.input).toBe(port.input);
  });

  it('an UNKNOWN read key is undefined — the seam is not a catch-all', async () => {
    const { ctx } = makeMockCtx();
    const handle = await treeohvoxDef.factory!(ctx, node());
    expect(handle.read?.('somethingElse')).toBeUndefined();
  });

  it('dispose() CLOSES the gate before stopping its source', async () => {
    // A node deleted mid-hold is a release the pad itself can never see: its
    // button unmounts with the card. Stopping the source without closing it
    // first leaves the last scheduled value high.
    const { ctx, sources } = makeMockCtx();
    const handle = await treeohvoxDef.factory!(ctx, node());
    const gate = gateSourceOf(sources);
    (handle.read!(MANUAL_GATE_KEY) as (high: boolean) => void)(true);

    gate.offset.events.length = 0;
    handle.dispose?.();
    expect(gate.offset.events, 'dispose must schedule the close').toEqual([
      { kind: 'set', value: 0, time: 7 },
    ]);
    expect(gate.stopped, 'a live ConstantSource is a leak').toBe(1);
  });
});
