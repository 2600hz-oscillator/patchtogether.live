// packages/web/src/lib/audio/modules/midi-lane.test.ts
//
// Unit + factory tests for MIDI LANE — the per-channel instrument-demux.
//
// Two layers:
//   1. Pure helpers (channel-set expansion, channel match, CC parse + scale,
//      poly-lane allocation) — no AudioContext.
//   2. Factory wiring: mock requestMIDIAccess + drive synthetic MIDI bytes
//      through the handler, then inspect the ConstantSourceNode automation
//      logs. This is the "MIDI byte arrived → output offset got automated"
//      path — channel demux, CC tap → CV, by-note gate, poly chord, retrig.
//
// Web Audio is mocked just enough for the factory to run in node. The
// note-priority / velocity / bend / held-stack math is reused verbatim from
// midi-cv-buddy and exhaustively covered by midi-cv-buddy.test.ts; here we
// test the LANE-SPECIFIC behavior (multi-channel filter, CC taps, by-note
// gate, poly output).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  midiLaneDef,
  expandLaneChannels,
  laneChannelMatches,
  parseCc,
  ccToCv,
  buildPolyLanes,
  MAX_POLY_VOICES,
  NOTE_GATE_PULSE_S,
  DEFAULT_DATA,
  type MidiLaneApi,
} from './midi-lane';
import { midiToVOct } from '$lib/audio/note-entry';
import type { ModuleNode } from '$lib/graph/types';
import type { MidiAccessLike, MidiEventLike, MidiInputLike } from './midi-cv-buddy';

// ---------------- mocks ----------------

interface RecordedSchedule {
  kind: 'cancel' | 'set';
  value?: number;
  time: number;
}

interface FakeAudioParam {
  value: number;
  setValueAtTime: (v: number, t: number) => void;
  cancelScheduledValues: (t: number) => void;
  events: RecordedSchedule[];
}

function makeParam(initial = 0): FakeAudioParam {
  const events: RecordedSchedule[] = [];
  const p: FakeAudioParam = {
    value: initial,
    setValueAtTime(v, t) {
      p.value = v;
      events.push({ kind: 'set', value: v, time: t });
    },
    cancelScheduledValues(t) {
      events.push({ kind: 'cancel', time: t });
    },
    events,
  };
  return p;
}

class FakeConstantSourceNode {
  offset = makeParam(0);
  start = vi.fn();
  stop = vi.fn();
  /** Records (target, srcChannel, dstChannel) so the poly-sender's per-lane
   *  merger wiring (pitch→even input, gate→odd input) is recoverable. */
  connections: Array<{ target: unknown; srcCh?: number; dstCh?: number }> = [];
  connect = vi.fn((target: unknown, srcCh?: number, dstCh?: number) => {
    this.connections.push({ target, srcCh, dstCh });
  });
  disconnect = vi.fn();
}

class FakeChannelMergerNode {
  connect = vi.fn();
  disconnect = vi.fn();
}

interface FakeAudioCtx {
  currentTime: number;
  sampleRate: number;
  createConstantSource: () => FakeConstantSourceNode;
  createChannelMerger: (n: number) => FakeChannelMergerNode;
  /** All ConstantSources created by this ctx (mono outs + the 10 poly-sender
   *  sources), in creation order — so tests can find the poly gate sources. */
  __allSources: FakeConstantSourceNode[];
  __mergers: FakeChannelMergerNode[];
}

function makeMockCtx(): FakeAudioCtx {
  const __allSources: FakeConstantSourceNode[] = [];
  const __mergers: FakeChannelMergerNode[] = [];
  return {
    currentTime: 0,
    sampleRate: 48000,
    createConstantSource: () => {
      const s = new FakeConstantSourceNode();
      __allSources.push(s);
      return s;
    },
    createChannelMerger: () => {
      const m = new FakeChannelMergerNode();
      __mergers.push(m);
      return m;
    },
    __allSources,
    __mergers,
  };
}

/** Find the poly-sender's gate ConstantSources: those connected to the poly
 *  merger at an ODD input channel (gate lanes are at merger inputs 1,3,5,7,9).
 *  Returned in lane order (input 1 → lane 0, …). */
function polyGateSources(ctx: FakeAudioCtx): FakeConstantSourceNode[] {
  const merger = ctx.__mergers[0];
  const found: Array<{ lane: number; src: FakeConstantSourceNode }> = [];
  for (const s of ctx.__allSources) {
    for (const c of s.connections) {
      if (c.target === merger && typeof c.dstCh === 'number' && c.dstCh % 2 === 1) {
        found.push({ lane: (c.dstCh - 1) / 2, src: s });
      }
    }
  }
  found.sort((a, b) => a.lane - b.lane);
  return found.map((f) => f.src);
}

function makeNode(data?: Record<string, unknown>): ModuleNode {
  return {
    id: 'midi-lane-test',
    type: 'midiLane',
    domain: 'audio',
    position: { x: 0, y: 0 },
    params: {},
    data: data ?? {},
  };
}

function makeMidiInput(id: string): MidiInputLike & { fire: (ev: MidiEventLike) => void } {
  let handler: ((ev: MidiEventLike) => void) | null = null;
  return {
    id,
    name: id,
    state: 'connected',
    get onmidimessage() { return handler; },
    set onmidimessage(fn) { handler = fn as ((ev: MidiEventLike) => void) | null; },
    fire(ev) { if (handler) handler(ev); },
  };
}

function makeMidiAccess(...inputs: ReturnType<typeof makeMidiInput>[]): MidiAccessLike {
  const map = new Map<string, MidiInputLike>();
  for (const i of inputs) map.set(i.id, i);
  return { inputs: map, onstatechange: null };
}

// ════════════════════════════════════════════════════════════════════
// 1. Module-def shape
// ════════════════════════════════════════════════════════════════════

describe('midiLaneDef: module shape', () => {
  it('declares no inputs (MIDI source is external) and 7 outputs', () => {
    expect(midiLaneDef.inputs).toEqual([]);
    const outIds = midiLaneDef.outputs.map((o) => o.id);
    expect(outIds).toEqual([
      'pitch_cv', 'gate', 'velocity_cv', 'cc_a', 'cc_b', 'note_gate', 'poly',
    ]);
  });

  it('output cable types are correct (cv / gate / polyPitchGate)', () => {
    const byId = Object.fromEntries(midiLaneDef.outputs.map((o) => [o.id, o.type]));
    expect(byId.pitch_cv).toBe('cv');
    expect(byId.gate).toBe('gate');
    expect(byId.velocity_cv).toBe('cv');
    expect(byId.cc_a).toBe('cv');
    expect(byId.cc_b).toBe('cv');
    expect(byId.note_gate).toBe('gate');
    expect(byId.poly).toBe('polyPitchGate');
  });

  it('lives in the MIDI palette + sources category, with no AudioParams', () => {
    expect(midiLaneDef.palette).toEqual({ top: 'MIDI', sub: 'MIDI' });
    expect(midiLaneDef.category).toBe('sources');
    expect(midiLaneDef.params).toEqual([]);
  });

  it('defaults are sensible: all channels, mono, last, retrig, CC1=A, kick=36', () => {
    expect(DEFAULT_DATA.channels).toBeNull();
    expect(DEFAULT_DATA.mode).toBe('mono');
    expect(DEFAULT_DATA.priority).toBe('last');
    expect(DEFAULT_DATA.retrig).toBe(true);
    expect(DEFAULT_DATA.ccA).toBe(1);
    expect(DEFAULT_DATA.ccB).toBeNull();
    expect(DEFAULT_DATA.noteGateNote).toBe(36);
  });
});

// ════════════════════════════════════════════════════════════════════
// 2. Pure helpers
// ════════════════════════════════════════════════════════════════════

describe('expandLaneChannels: channel-set normalization', () => {
  it('null → null (all channels)', () => {
    expect(expandLaneChannels(null)).toBeNull();
  });
  it('array → Set, dropping out-of-range + non-integers', () => {
    const s = expandLaneChannels([0, 5, 15, 16, -1, 3.5, 7]);
    expect([...s!].sort((a, b) => a - b)).toEqual([0, 5, 7, 15]);
  });
  it('empty array → empty Set (matches nothing — distinct from null)', () => {
    const s = expandLaneChannels([]);
    expect(s).not.toBeNull();
    expect(s!.size).toBe(0);
  });
});

describe('laneChannelMatches: per-message channel gate', () => {
  it('null set matches every channel', () => {
    for (let ch = 0; ch < 16; ch++) {
      expect(laneChannelMatches(0x90 | ch, null)).toBe(true);
    }
  });
  it('matches only channels in the set', () => {
    const s = new Set([0, 4]);
    expect(laneChannelMatches(0x90 | 0, s)).toBe(true);
    expect(laneChannelMatches(0x90 | 4, s)).toBe(true);
    expect(laneChannelMatches(0x90 | 1, s)).toBe(false);
    expect(laneChannelMatches(0xb0 | 4, s)).toBe(true); // CC on ch4
  });
  it('empty set matches nothing', () => {
    const s = new Set<number>();
    for (let ch = 0; ch < 16; ch++) {
      expect(laneChannelMatches(0x90 | ch, s)).toBe(false);
    }
  });
});

describe('parseCc / ccToCv', () => {
  it('parseCc extracts cc# + value from a CC message', () => {
    expect(parseCc(new Uint8Array([0xb0, 7, 100]))).toEqual({ cc: 7, value: 100 });
    expect(parseCc(new Uint8Array([0xb5, 1, 64]))).toEqual({ cc: 1, value: 64 }); // ch5
  });
  it('parseCc returns null on non-CC / truncated', () => {
    expect(parseCc(new Uint8Array([0x90, 60, 100]))).toBeNull();
    expect(parseCc(new Uint8Array([0xb0, 7]))).toBeNull();
  });
  it('ccToCv maps 0..127 → 0..1', () => {
    expect(ccToCv(0)).toBe(0);
    expect(ccToCv(127)).toBeCloseTo(1, 8);
    expect(ccToCv(64)).toBeCloseTo(64 / 127, 6);
    expect(ccToCv(-5)).toBe(0);
    expect(ccToCv(200)).toBeCloseTo(1, 8);
    expect(ccToCv(NaN)).toBe(0);
  });
});

describe('buildPolyLanes: chord allocation', () => {
  it('empty stack → all lanes gate 0', () => {
    const lanes = buildPolyLanes([], 0);
    expect(lanes).toHaveLength(MAX_POLY_VOICES);
    expect(lanes.every((l) => l.gate === 0)).toBe(true);
  });
  it('a triad lights 3 lanes with the right pitches, rest off', () => {
    const lanes = buildPolyLanes([60, 64, 67], 0);
    expect(lanes[0]).toEqual({ pitch: midiToVOct(60), gate: 1 });
    expect(lanes[1]).toEqual({ pitch: midiToVOct(64), gate: 1 });
    expect(lanes[2]).toEqual({ pitch: midiToVOct(67), gate: 1 });
    expect(lanes[3].gate).toBe(0);
    expect(lanes[4].gate).toBe(0);
  });
  it('bend is summed into every active voice pitch', () => {
    const bend = 0.05;
    const lanes = buildPolyLanes([60, 64], bend);
    expect(lanes[0].pitch).toBeCloseTo(midiToVOct(60) + bend, 8);
    expect(lanes[1].pitch).toBeCloseTo(midiToVOct(64) + bend, 8);
  });
  it('more than MAX_POLY_VOICES held → keeps the most-recent (steal-oldest)', () => {
    // 6 notes held; only the newest 5 survive.
    const lanes = buildPolyLanes([60, 61, 62, 63, 64, 65], 0);
    const pitches = lanes.map((l) => l.pitch);
    // Note 60 (the oldest) should NOT be present.
    expect(pitches).not.toContain(midiToVOct(60));
    expect(pitches).toContain(midiToVOct(65));
    expect(lanes.every((l) => l.gate === 1)).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════
// 3. Factory wiring (mock requestMIDIAccess + drive synthetic MIDI)
// ════════════════════════════════════════════════════════════════════

describe('midiLaneDef.factory — MIDI demux → ConstantSourceNode automation', () => {
  let originalRequestMIDIAccess: unknown;

  beforeEach(() => {
    originalRequestMIDIAccess = (
      globalThis as { navigator?: { requestMIDIAccess?: unknown } }
    ).navigator?.requestMIDIAccess;
  });

  function installFakeMidi(access: MidiAccessLike): void {
    const nav = (globalThis as unknown as { navigator?: Record<string, unknown> }).navigator;
    if (!nav) {
      (globalThis as unknown as { navigator?: Record<string, unknown> }).navigator = {
        requestMIDIAccess: vi.fn(async () => access),
      };
    } else {
      nav.requestMIDIAccess = vi.fn(async () => access);
    }
  }

  function restoreMidi(): void {
    const nav = (globalThis as unknown as { navigator?: Record<string, unknown> }).navigator;
    if (nav && originalRequestMIDIAccess === undefined) {
      delete nav.requestMIDIAccess;
    } else if (nav) {
      nav.requestMIDIAccess = originalRequestMIDIAccess;
    }
  }

  async function setupConnected(data?: Record<string, unknown>) {
    const input = makeMidiInput('test-port');
    const access = makeMidiAccess(input);
    installFakeMidi(access);
    const ctx = makeMockCtx();
    const handle = await midiLaneDef.factory(ctx as unknown as AudioContext, makeNode(data));
    const api = handle.read?.('card-api') as MidiLaneApi;
    expect(api, 'card-api exposed').toBeDefined();
    const ok = await api.connect();
    expect(ok, 'connected').toBe(true);
    return { input, ctx, handle, api };
  }

  it('note-on on the selected channel raises pitch_cv + gate; off-channel is ignored', async () => {
    const { input, handle } = await setupConnected({ channels: [2] }); // ch3 (0-indexed 2)
    try {
      const pitchSrc = handle.outputs.get('pitch_cv')!.node as unknown as FakeConstantSourceNode;
      const gateSrc = handle.outputs.get('gate')!.node as unknown as FakeConstantSourceNode;

      // Off-channel note (ch1) — ignored.
      input.fire({ data: new Uint8Array([0x90 | 0, 72, 100]), timeStamp: 0 });
      expect(gateSrc.offset.events.some((e) => e.kind === 'set' && e.value === 1)).toBe(false);

      // On-channel note (ch3 = 0x92) → pitch_cv = +1 V/oct (MIDI 72 = C5), gate 1.
      input.fire({ data: new Uint8Array([0x90 | 2, 72, 100]), timeStamp: 0 });
      const pHigh = pitchSrc.offset.events.filter((e) => e.kind === 'set' && e.value === 1);
      expect(pHigh.length).toBeGreaterThan(0); // C5 = +1.0 V/oct
      expect(gateSrc.offset.events.some((e) => e.kind === 'set' && e.value === 1)).toBe(true);
    } finally {
      restoreMidi();
    }
  });

  it('preserves inter-note spacing under handler-dispatch jitter (regression: timestamp projection, not dispatch-time)', async () => {
    // The dominant MIDI-jitter bug: notes were scheduled to handler-dispatch
    // time (currentTime + 8 ms), discarding event.timeStamp. Two note-ons
    // whose timeStamps are 20 ms apart but whose handlers dispatch in the
    // SAME main-thread turn (a burst after a stall — what heavy video load
    // causes) collapsed to the SAME audio time (spacing → 0). The shared
    // timestamp projection keeps them 20 ms apart on the audio clock.
    const perfSpy = vi.spyOn(performance, 'now').mockReturnValue(1000);
    try {
      const { input, handle } = await setupConnected({ channels: [0] });
      const pitchSrc = handle.outputs.get('pitch_cv')!.node as unknown as FakeConstantSourceNode;
      // ctx.currentTime stays 0 across both synchronous fires, so any spacing
      // in the schedule comes ONLY from the projected timestamps.
      input.fire({ data: new Uint8Array([0x90, 60, 100]), timeStamp: 980 }); // 20 ms lag
      input.fire({ data: new Uint8Array([0x90, 72, 100]), timeStamp: 1000 }); // 0 ms lag
      const setTimes = [
        ...new Set(pitchSrc.offset.events.filter((e) => e.kind === 'set').map((e) => e.time)),
      ].sort((a, b) => a - b);
      // Pre-fix: both notes scheduled at the same time → a single distinct
      // time. Post-fix: two distinct times 20 ms apart.
      expect(setTimes.length, 'two distinct schedule times').toBeGreaterThanOrEqual(2);
      expect(setTimes[1]! - setTimes[0]!).toBeCloseTo(0.02, 6);
    } finally {
      perfSpy.mockRestore();
      restoreMidi();
    }
  });

  it('cc_a tracks the assigned CC (default CC1); cc_b tracks its assigned CC', async () => {
    const { input, handle } = await setupConnected({ ccA: 1, ccB: 7 });
    try {
      const ccA = handle.outputs.get('cc_a')!.node as unknown as FakeConstantSourceNode;
      const ccB = handle.outputs.get('cc_b')!.node as unknown as FakeConstantSourceNode;

      // CC1 = 127 → cc_a = 1.0
      input.fire({ data: new Uint8Array([0xb0, 1, 127]), timeStamp: 0 });
      expect(ccA.offset.value).toBeCloseTo(1, 6);
      // cc_b unchanged (no CC7 yet).
      expect(ccB.offset.events.filter((e) => e.kind === 'set').length).toBe(0);

      // CC7 = 64 → cc_b ≈ 0.504
      input.fire({ data: new Uint8Array([0xb0, 7, 64]), timeStamp: 0 });
      expect(ccB.offset.value).toBeCloseTo(64 / 127, 4);

      // An UNASSIGNED CC (e.g. CC10) drives neither tap.
      const ccAEventsBefore = ccA.offset.events.length;
      const ccBEventsBefore = ccB.offset.events.length;
      input.fire({ data: new Uint8Array([0xb0, 10, 100]), timeStamp: 0 });
      expect(ccA.offset.events.length).toBe(ccAEventsBefore);
      expect(ccB.offset.events.length).toBe(ccBEventsBefore);
    } finally {
      restoreMidi();
    }
  });

  it('learnCcA captures the next CC# and routes it to cc_a', async () => {
    const { input, handle, api } = await setupConnected({ ccA: null });
    try {
      const ccA = handle.outputs.get('cc_a')!.node as unknown as FakeConstantSourceNode;
      api.learnCcA();
      expect(api.getState().learningCcA).toBe(true);

      // Wiggle CC20 → it becomes cc_a's assignment, captured value applied.
      input.fire({ data: new Uint8Array([0xb0, 20, 127]), timeStamp: 0 });
      expect(api.getState().learningCcA).toBe(false);
      expect(api.getState().ccANum).toBe(20);
      expect(ccA.offset.value).toBeCloseTo(1, 6);

      // Subsequent CC20 messages keep driving cc_a.
      input.fire({ data: new Uint8Array([0xb0, 20, 0]), timeStamp: 0 });
      expect(ccA.offset.value).toBe(0);
    } finally {
      restoreMidi();
    }
  });

  it('note_gate fires a one-shot pulse ONLY on the selected note number', async () => {
    const { input, handle } = await setupConnected({ noteGateNote: 36 });
    try {
      const ng = handle.outputs.get('note_gate')!.node as unknown as FakeConstantSourceNode;

      // A non-matching note (MIDI 60) → no note_gate pulse.
      input.fire({ data: new Uint8Array([0x90, 60, 100]), timeStamp: 0 });
      expect(ng.offset.events.some((e) => e.kind === 'set' && e.value === 1)).toBe(false);

      // The selected note (MIDI 36 = GM kick) → pulse: set(1, t), set(0, t+PULSE).
      input.fire({ data: new Uint8Array([0x90, 36, 100]), timeStamp: 0 });
      const setHigh = ng.offset.events.find((e) => e.kind === 'set' && e.value === 1);
      const setLow = ng.offset.events.find(
        (e) => e.kind === 'set' && e.value === 0
          && setHigh && Math.abs(e.time - (setHigh.time + NOTE_GATE_PULSE_S)) < 1e-9,
      );
      expect(setHigh, 'note_gate raised').toBeDefined();
      expect(setLow, `note_gate lowered at +${NOTE_GATE_PULSE_S}s`).toBeDefined();
    } finally {
      restoreMidi();
    }
  });

  it('poly mode: a triad lights three poly voices (mono gate stays low)', async () => {
    const { input, ctx, handle } = await setupConnected({ mode: 'poly' });
    try {
      const polyMerger = handle.outputs.get('poly')!.node;
      const gateSrc = handle.outputs.get('gate')!.node as unknown as FakeConstantSourceNode;
      expect(polyMerger).toBeDefined();

      input.fire({ data: new Uint8Array([0x90, 60, 100]), timeStamp: 0 });
      input.fire({ data: new Uint8Array([0x90, 64, 100]), timeStamp: 0 });
      input.fire({ data: new Uint8Array([0x90, 67, 100]), timeStamp: 0 });

      // The poly bus raises 3 lane gates (the triad).
      const gates = polyGateSources(ctx);
      expect(gates.length).toBe(5);
      const high = gates.filter((g) => g.offset.events.some((e) => e.kind === 'set' && e.value === 1));
      expect(high.length, 'three poly lane gates raised for the triad').toBe(3);

      // In poly mode the MONO gate output is never raised (chord drives poly).
      expect(gateSrc.offset.events.some((e) => e.kind === 'set' && e.value === 1)).toBe(false);
    } finally {
      restoreMidi();
    }
  });

  it('REGRESSION (#674): the POLY port carries the chord in DEFAULT MONO mode too', async () => {
    // The "POLYHELM produces no audio" bug: a user wires MIDI LANE.poly → a
    // poly synth and plays notes, but the lane is in its DEFAULT mono mode, so
    // the poly bus fed silent gates → the synth never received a note-on. The
    // fix makes the dedicated POLY port ALWAYS live (mode only governs the MONO
    // outputs). This is the unit-level guard; the live worklet chain is covered
    // by e2e/tests/polyhelm-poly-chain.spec.ts.
    const { input, ctx, handle } = await setupConnected(); // no data → DEFAULT mono mode
    try {
      const gateSrc = handle.outputs.get('gate')!.node as unknown as FakeConstantSourceNode;

      input.fire({ data: new Uint8Array([0x90, 60, 100]), timeStamp: 0 }); // C
      input.fire({ data: new Uint8Array([0x90, 64, 100]), timeStamp: 0 }); // E
      input.fire({ data: new Uint8Array([0x90, 67, 100]), timeStamp: 0 }); // G

      // The POLY port raises all three lane gates EVEN in mono mode (the bug
      // was that these stayed at 0, so the downstream poly synth was silent).
      const gates = polyGateSources(ctx);
      expect(gates.length).toBe(5);
      const high = gates.filter((g) => g.offset.events.some((e) => e.kind === 'set' && e.value === 1));
      expect(high.length, 'poly lane gates raised in DEFAULT mono mode').toBe(3);

      // Mono mode STILL drives the MONO gate too (the mono synth path is intact
      // — the poly port being live is additive, not a replacement).
      expect(gateSrc.offset.events.some((e) => e.kind === 'set' && e.value === 1)).toBe(true);
    } finally {
      restoreMidi();
    }
  });

  it('switching channels (setChannels) drops the gate so a held note can\'t strand it high', async () => {
    const { input, handle, api } = await setupConnected({ channels: null });
    try {
      const gateSrc = handle.outputs.get('gate')!.node as unknown as FakeConstantSourceNode;
      input.fire({ data: new Uint8Array([0x90, 72, 100]), timeStamp: 0 });
      expect(gateSrc.offset.value).toBe(1);

      // Switch the lane to a different channel while a note is held — the
      // panic() path must drop the gate to 0.
      api.setChannels([5]);
      expect(gateSrc.offset.value).toBe(0);
    } finally {
      restoreMidi();
    }
  });

  it('retrig: a second overlapping note-on dips the gate to 0 then back to 1', async () => {
    const { input, handle } = await setupConnected({ retrig: true, priority: 'last' });
    try {
      const gateSrc = handle.outputs.get('gate')!.node as unknown as FakeConstantSourceNode;
      input.fire({ data: new Uint8Array([0x90, 60, 100]), timeStamp: 0 });
      // Second note while the first is held → retrig dip.
      input.fire({ data: new Uint8Array([0x90, 64, 100]), timeStamp: 0 });
      // The retrig path schedules set(0, t) then set(1, t+0.003).
      const sets = gateSrc.offset.events.filter((e) => e.kind === 'set');
      const hasDip = sets.some((e) => e.value === 0) && sets.some((e) => e.value === 1);
      expect(hasDip).toBe(true);
    } finally {
      restoreMidi();
    }
  });
});
