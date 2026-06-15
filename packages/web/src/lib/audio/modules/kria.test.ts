// packages/web/src/lib/audio/modules/kria.test.ts
//
// Drives the REAL kria factory + tick loop against a fake AudioContext
// (advanceable currentTime) + the live graph store, asserting per-track
// pitch/gate emit, TIMELORDE clock lock, external-clock advance, reset
// re-anchor, and pattern-cue quantize. The audible end-to-end chain
// (TIMELORDE → KRIA → voice → RMS) is covered by the e2e spec.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { midiToVOct } from '$lib/audio/note-entry';

const hoisted = vi.hoisted(() => ({ tick: null as null | (() => void) }));
vi.mock('$lib/audio/scheduler-clock', () => ({
  SCHEDULER_TICK_MS: 25,
  getSchedulerClock: () => ({
    subscribe: (fn: () => void) => {
      hoisted.tick = fn;
      return () => {
        hoisted.tick = null;
      };
    },
    usingWorker: false,
    dispose: () => {},
  }),
}));

import { patch as livePatch } from '$lib/graph/store';

// ---- Minimal fake AudioContext (same shape as clipplayer.test) ----
interface SchedEvent {
  value: number;
  time: number;
}
class FakeParam {
  value = 0;
  events: SchedEvent[] = [];
  setValueAtTime(value: number, time: number) {
    this.events.push({ value, time });
    this.value = value;
    return this;
  }
  linearRampToValueAtTime(value: number, time: number) {
    this.events.push({ value, time });
    this.value = value;
    return this;
  }
  cancelScheduledValues(fromTime: number) {
    this.events = this.events.filter((e) => e.time < fromTime);
    return this;
  }
}
class FakeConstantSource {
  offset = new FakeParam();
  start() {}
  stop() {}
  connect() {}
  disconnect() {}
}
class FakeGain {
  gain = new FakeParam();
  injected: Float32Array | null = null;
  connect(node: unknown) {
    if (node instanceof FakeAnalyser) node._source = this;
  }
  disconnect() {}
}
class FakeAnalyser {
  fftSize = 2048;
  _source: FakeGain | null = null;
  connect() {}
  disconnect() {}
  getFloatTimeDomainData(out: Float32Array) {
    const buf = this._source?.injected;
    if (buf) out.set(buf.subarray(0, out.length));
    else out.fill(0);
  }
}
class FakeAudioContext {
  currentTime = 0;
  sampleRate = 48000;
  createConstantSource() {
    return new FakeConstantSource() as unknown as ConstantSourceNode;
  }
  createGain() {
    return new FakeGain() as unknown as GainNode;
  }
  createAnalyser() {
    return new FakeAnalyser() as unknown as AnalyserNode;
  }
}

function pulseBuffer(len = 2048): Float32Array {
  const b = new Float32Array(len);
  for (let i = len - 64; i < len; i++) b[i] = 1;
  return b;
}

import { kriaDef } from './kria';
import {
  defaultPattern,
  setNote,
  setOctave,
  toggleTrig,
  type KriaPattern,
  type KriaTrack,
  KRIA_TRACKS,
} from './kria-types';

const NODE_ID = 'k1';

function clearPatch() {
  for (const k of Object.keys(livePatch.nodes)) delete livePatch.nodes[k];
  for (const k of Object.keys(livePatch.edges)) delete livePatch.edges[k];
}

/** Build a pattern where every track trigs every step at degree 0 + octave 2
 *  (MIDI 72 = +1 V/oct), so per-track pitch/gate are unambiguous. */
function runningPattern(): KriaPattern {
  const p = defaultPattern();
  p.tracks = p.tracks.map((t) => {
    let nt: KriaTrack = t;
    for (let s = 0; s < 16; s++) {
      nt = toggleTrig(nt, s);
      nt = setNote(nt, s, 0);
      nt = setOctave(nt, s, 2);
    }
    return nt;
  });
  return p;
}

/** String-keyed pattern bank from a positional list (SyncedStore-safe). */
function bank(...pats: KriaPattern[]): Record<string, KriaPattern> {
  const out: Record<string, KriaPattern> = {};
  pats.forEach((p, i) => (out[String(i)] = p));
  return out;
}
function seed(params: Record<string, number>, data: Record<string, unknown>) {
  clearPatch();
  livePatch.nodes[NODE_ID] = {
    id: NODE_ID,
    type: 'kria',
    domain: 'audio',
    position: { x: 0, y: 0 },
    params,
    data,
  } as never;
}
function addTimelorde(bpm: number, running: number) {
  livePatch.nodes['tl'] = {
    id: 'tl',
    type: 'timelorde',
    domain: 'audio',
    position: { x: 0, y: 0 },
    params: { bpm, running },
    data: {},
  } as never;
}
function patchClock() {
  livePatch.edges['e-clock'] = {
    id: 'e-clock',
    source: { nodeId: 'src', portId: 'out' },
    target: { nodeId: NODE_ID, portId: 'clock' },
  } as never;
}
function hasHighEvent(param: FakeParam): boolean {
  return param.events.some((e) => e.value >= 0.5);
}
async function build(ctx: FakeAudioContext) {
  return kriaDef.factory(
    ctx as unknown as AudioContext,
    { id: NODE_ID, type: 'kria', params: livePatch.nodes[NODE_ID]!.params } as never,
  );
}
function run(ctx: FakeAudioContext, fromS: number, toS: number, tickMs = 0.025) {
  for (let t = fromS; t < toS; t += tickMs) {
    ctx.currentTime = t;
    hoisted.tick!();
  }
}
function gateParam(handle: Awaited<ReturnType<typeof build>>, track: number): FakeParam {
  return (handle.outputs.get(`gate${track}`)!.node as unknown as FakeConstantSource)
    .offset as unknown as FakeParam;
}

beforeEach(() => {
  hoisted.tick = null;
  clearPatch();
});

describe('kria: module def', () => {
  it('registers as audio-domain "kria" with a lowercase label', () => {
    expect(kriaDef.type).toBe('kria');
    expect(kriaDef.domain).toBe('audio');
    expect(kriaDef.label).toBe('kria');
    expect(kriaDef.label).toBe(kriaDef.label.toLowerCase());
    expect(kriaDef.category).toBe('modulation');
  });
  it('declares 4 pitch + 4 gate outputs (Ansible Kria shape) + clock/reset ins', () => {
    expect(kriaDef.inputs.map((p) => p.id).sort()).toEqual(['clock', 'reset']);
    const outs = kriaDef.outputs.map((p) => `${p.id}:${p.type}`).sort();
    expect(outs).toEqual([
      'gate1:gate', 'gate2:gate', 'gate3:gate', 'gate4:gate',
      'pitch1:pitch', 'pitch2:pitch', 'pitch3:pitch', 'pitch4:pitch',
    ]);
  });
});

describe('kria: playback', () => {
  it('does NOT run when stopped (running=0, no TIMELORDE, no clock)', async () => {
    seed({ bpm: 240, running: 0 }, { active: 0, patterns: bank(runningPattern()) });
    const ctx = new FakeAudioContext();
    const handle = await build(ctx);
    run(ctx, 0, 0.5);
    for (let t = 1; t <= KRIA_TRACKS; t++) {
      expect(hasHighEvent(gateParam(handle, t)), `gate${t} silent`).toBe(false);
    }
  });

  it('runs from the local RUN param + emits pitch/gate on all 4 tracks', async () => {
    seed({ bpm: 240, running: 1 }, { active: 0, patterns: bank(runningPattern()) });
    const ctx = new FakeAudioContext();
    const handle = await build(ctx);
    run(ctx, 0, 0.5);
    for (let t = 1; t <= KRIA_TRACKS; t++) {
      expect(hasHighEvent(gateParam(handle, t)), `gate${t} fires`).toBe(true);
      expect(handle.read!(`gateValue:${t - 1}`)).toBe(1);
      expect(handle.read!(`pitchVOct:${t - 1}`)).toBeCloseTo(midiToVOct(72), 5); // +1 V/oct
    }
    expect((handle.read!('totalAdvances') as number)).toBeGreaterThan(0);
  });

  it('locks to TIMELORDE: runs while TIMELORDE.running, halts when it stops', async () => {
    seed({ bpm: 120, running: 0 }, { active: 0, patterns: bank(runningPattern()) });
    addTimelorde(240, 1);
    const ctx = new FakeAudioContext();
    const handle = await build(ctx);
    run(ctx, 0, 0.4);
    expect(hasHighEvent(gateParam(handle, 1))).toBe(true);

    // Stop TIMELORDE → no NEW gate-highs after the stop time.
    livePatch.nodes['tl']!.params!.running = 0;
    run(ctx, 0.4, 0.45); // process the stop transition (silenceAll)
    const g = gateParam(handle, 1);
    const cut = ctx.currentTime;
    run(ctx, 0.45, 0.9);
    const after = g.events.filter((e) => e.value >= 0.5 && e.time > cut);
    expect(after, 'no new gate-highs after TIMELORDE stops').toHaveLength(0);
  });

  it('does NOT run when TIMELORDE is present but not running', async () => {
    seed({ bpm: 120, running: 1 }, { active: 0, patterns: bank(runningPattern()) });
    addTimelorde(240, 0); // TIMELORDE present + stopped → wins over local running=1
    const ctx = new FakeAudioContext();
    const handle = await build(ctx);
    run(ctx, 0, 0.5);
    expect(hasHighEvent(gateParam(handle, 1))).toBe(false);
  });
});

describe('kria: external clock', () => {
  it('advances one base tick per rising edge when clock is patched', async () => {
    seed({ bpm: 240, running: 0 }, { active: 0, patterns: bank(runningPattern()) });
    patchClock(); // clock patched → clock-only run mode
    const ctx = new FakeAudioContext();
    const handle = await build(ctx);
    // No edges yet → no advance.
    run(ctx, 0, 0.1);
    const before = handle.read!('totalAdvances') as number;
    expect(before).toBe(0);
    // Inject a rising edge on clock.
    const clockGain = handle.inputs.get('clock')!.node as unknown as FakeGain;
    clockGain.injected = pulseBuffer();
    run(ctx, 0.1, 0.15);
    const after = handle.read!('totalAdvances') as number;
    expect(after).toBeGreaterThan(before);
    expect(hasHighEvent(gateParam(handle, 1))).toBe(true);
  });
});

describe('kria: reset', () => {
  it('reset rising edge re-anchors every track to its loop start (clock-driven)', async () => {
    // External clock so each advance is exactly one edge (no lookahead burst),
    // giving deterministic control over the playhead position.
    seed({ bpm: 240, running: 0 }, { active: 0, patterns: bank(runningPattern()) });
    patchClock();
    const ctx = new FakeAudioContext();
    const handle = await build(ctx);
    const clockGain = handle.inputs.get('clock')!.node as unknown as FakeGain;
    const resetGain = handle.inputs.get('reset')!.node as unknown as FakeGain;

    // Advance a few steps. Each tick with a held pulse buffer = ~one new edge.
    clockGain.injected = pulseBuffer();
    run(ctx, 0, 0.1);
    expect(handle.read!('currentStep:0') as number).toBeGreaterThan(0);

    // Pulse reset → cursor re-anchored to loop start (pos 0 of window).
    clockGain.injected = null;
    resetGain.injected = pulseBuffer();
    run(ctx, 0.1, 0.12);
    resetGain.injected = null;

    // The next single clock edge after reset advances from loop start (pos 0)
    // to pos 1 = step 1 (forward). The playhead is therefore at the very start
    // of the loop, NOT wherever it was before.
    clockGain.injected = pulseBuffer();
    ctx.currentTime = 0.13;
    hoisted.tick!();
    expect(handle.read!('currentStep:0') as number).toBeLessThanOrEqual(1);
  });
});

describe('kria: pattern-cue quantize', () => {
  it('a cued pattern takes over on the track-0 loop boundary (cueSteps=0)', async () => {
    const patA = runningPattern();
    // Pattern B: degree 0 octave 1 → MIDI 60 = 0 V/oct, distinct from A's +1.
    const patB = (() => {
      const p = defaultPattern();
      p.tracks = p.tracks.map((t) => {
        let nt = t;
        for (let s = 0; s < 16; s++) {
          nt = toggleTrig(nt, s);
          nt = setNote(nt, s, 0);
          nt = setOctave(nt, s, 3); // MIDI 84 = +2 V/oct
        }
        return nt;
      });
      return p;
    })();
    seed(
      { bpm: 240, running: 1 },
      { active: 0, cued: null, cueSteps: 0, patterns: bank(patA, patB) },
    );
    const ctx = new FakeAudioContext();
    const handle = await build(ctx);
    run(ctx, 0, 0.1);
    expect(handle.read!('activePattern')).toBe(0);
    expect(handle.read!('pitchVOct:0')).toBeCloseTo(midiToVOct(72), 5);

    // Cue pattern 1 (loop is 16 steps; at 240bpm 16ths a loop is ~1.0s).
    (livePatch.nodes[NODE_ID]!.data as Record<string, unknown>).cued = 1;
    // Run past a full loop boundary so the quantized switch fires.
    run(ctx, 0.1, 1.5);
    expect(handle.read!('activePattern')).toBe(1);
    expect(handle.read!('pitchVOct:0')).toBeCloseTo(midiToVOct(84), 5);
  });
});
