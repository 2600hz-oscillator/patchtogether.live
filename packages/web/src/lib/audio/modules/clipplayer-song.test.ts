// packages/web/src/lib/audio/modules/clipplayer-song.test.ts
//
// Drives the REAL clipplayer factory + tick loop (SONG MODE v2 — the printed
// performance) against a fake AudioContext + the live graph store:
//   - RECORD (PRINT): perform a launched clip in SESSION under a SONG-REC arm →
//     the concrete emitted notes print into song.notes[lane] at song-beats;
//   - PLAYBACK (authoritative): song time drives the printed channels straight
//     out the lane pitch/gate/vel outputs, and clips do NOT launch live;
//   - ENTERING SONG stops the session (authoritative, no punch-over).
// The audible end-to-end RMS chain (TIMELORDE → clipplayer → voice) is an e2e
// follow-up (deferred — Phase 1 verify is engine/unit only).

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

// ---- Minimal fake AudioContext (same shape as clipplayer.test.ts) ----
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
  cancelScheduledValues(fromTime: number) {
    this.events = this.events.filter((e) => e.time < fromTime);
    return this;
  }
}
class FakeConstantSource {
  offset = new FakeParam();
  start() {}
  stop() {}
  connect(target?: unknown, _output?: number, input?: number) {
    const t = target as { _inputs?: Record<number, FakeConstantSource> } | undefined;
    if (t && t._inputs && typeof input === 'number') t._inputs[input] = this;
  }
  disconnect() {}
}
class FakeGain {
  gain = new FakeParam();
  injected: Float32Array | null = null;
  _inputs: Record<number, FakeConstantSource> = {};
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
  createChannelMerger() {
    return new FakeGain() as unknown as ChannelMergerNode;
  }
}

import { clipplayerDef } from './clipplayer';
import { clipIndex, type NoteClipRecord } from './clip-types';
import { coerceSongData, type SongData } from './clip-song';

const NODE_ID = 'cp1';

function clearPatch() {
  for (const k of Object.keys(livePatch.nodes)) delete livePatch.nodes[k];
  for (const k of Object.keys(livePatch.edges)) delete livePatch.edges[k];
}
function noteClip(midi: number, lengthSteps = 4): NoteClipRecord {
  return {
    kind: 'note',
    steps: [{ step: 0, midi, velocity: 100, lengthSteps: 1 }],
    lengthSteps,
    root: 48,
    loop: true,
  };
}
function lane8<T>(lane: number, val: T, fill: T): T[] {
  const a = new Array<T>(8).fill(fill);
  a[lane] = val;
  return a;
}
function seed(params: Record<string, number>, data: Record<string, unknown>) {
  clearPatch();
  livePatch.nodes[NODE_ID] = {
    id: NODE_ID, type: 'clipplayer', domain: 'audio', position: { x: 0, y: 0 }, params, data,
  } as never;
}
function seedTimelorde(running: number, bpm = 120) {
  livePatch.nodes['tl'] = {
    id: 'tl', type: 'timelorde', domain: 'audio', position: { x: 0, y: 0 }, params: { running, bpm }, data: {},
  } as never;
}
function gateOf(handle: { outputs: Map<string, { node: unknown }> }, lane: number): FakeParam {
  return (handle.outputs.get(`gate${lane + 1}`)!.node as unknown as FakeConstantSource)
    .offset as unknown as FakeParam;
}
function polyGateOf(handle: { outputs: Map<string, { node: unknown }> }, lane: number, voice = 0): FakeParam {
  const merger = handle.outputs.get(`pitch${lane + 1}`)!.node as unknown as FakeGain;
  return (merger._inputs[voice * 2 + 1] as unknown as FakeConstantSource).offset as unknown as FakeParam;
}
function hasHighEvent(param: FakeParam): boolean {
  return param.events.some((e) => e.value >= 0.5);
}
async function build(ctx: FakeAudioContext) {
  return clipplayerDef.factory(
    ctx as unknown as AudioContext,
    { id: NODE_ID, type: 'clipplayer', params: livePatch.nodes[NODE_ID]!.params } as never,
  );
}
function run(ctx: FakeAudioContext, fromS: number, toS: number, tickMs = 0.025) {
  for (let t = fromS; t < toS; t += tickMs) {
    ctx.currentTime = t;
    hoisted.tick!();
  }
}
function songOf(): SongData {
  return coerceSongData((livePatch.nodes[NODE_ID]!.data as { song?: unknown }).song);
}

beforeEach(() => {
  hoisted.tick = null;
  clearPatch();
});

describe('clipplayer SONG-REC: print the emitted performance', () => {
  it('captures a launched clip\'s emitted notes into song.notes[lane] over song time', async () => {
    // stepDiv 2 (4 steps/beat) @120bpm → 0.125 s/step; a 4-step clip = 1 beat.
    // Note at step 0 → one onset per beat. Perform lane 0 for several bars.
    seed(
      { stepDiv: 2, quantize: 0, octave: 0, gateLength: 0.9, snh: 1 },
      {
        clips: { [clipIndex(0, 0)]: noteClip(72) },
        queued: lane8(0, 0, null),
        clipMode: 'session',
        songRec: { armed: true, mode: 'replace' }, // no recorderId → this client records
      },
    );
    seedTimelorde(1);
    const ctx = new FakeAudioContext();
    const handle = await build(ctx);
    run(ctx, 0, 4.4); // ~8.8 beats → onsets at beats 0..8 (commits at bars 4, 8)
    // Disarm → punch out (final flush of the in-flight buffer).
    (livePatch.nodes[NODE_ID]!.data as { songRec?: unknown }).songRec = null;
    run(ctx, 4.4, 4.5);

    const song = songOf();
    const ch = song.notes?.['0'];
    expect(ch, 'lane 0 printed a channel').toBeTruthy();
    const events = ch!.events;
    expect(events.length, 'several bars of onsets captured').toBeGreaterThanOrEqual(6);
    // Every printed onset is the clip's note (midi 72), beat-sorted, ~1 beat apart.
    expect(events.every((e) => e.midi === 72)).toBe(true);
    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.beat).toBeGreaterThan(events[i - 1]!.beat); // sorted, distinct
      expect(events[i]!.beat - events[i - 1]!.beat).toBeGreaterThan(0.6);
      expect(events[i]!.beat - events[i - 1]!.beat).toBeLessThan(1.4);
    }
    expect(events[0]!.beat).toBeLessThan(0.4); // first onset near bar 1
    // A lane that never played prints nothing.
    expect(song.notes?.['1']).toBeUndefined();
  });

  it('REPLACE re-arm clears the prior print (fresh take from bar 1)', async () => {
    seed(
      { stepDiv: 2, quantize: 0, octave: 0, gateLength: 0.9, snh: 1 },
      {
        clips: { [clipIndex(0, 0)]: noteClip(72) },
        queued: lane8(0, 0, null),
        clipMode: 'session',
        songRec: { armed: true, mode: 'replace' },
      },
    );
    seedTimelorde(1);
    const ctx = new FakeAudioContext();
    await build(ctx);
    run(ctx, 0, 2.2);
    (livePatch.nodes[NODE_ID]!.data as { songRec?: unknown }).songRec = null;
    run(ctx, 2.2, 2.3);
    const firstCount = songOf().notes?.['0']?.events.length ?? 0;
    expect(firstCount).toBeGreaterThan(0);

    // Re-arm REPLACE → the rising edge clears the old print.
    (livePatch.nodes[NODE_ID]!.data as { songRec?: unknown }).songRec = { armed: true, mode: 'replace' };
    run(ctx, 2.3, 2.4);
    expect(songOf().notes?.['0']?.events.length ?? 0).toBe(0); // cleared on re-arm
    run(ctx, 2.4, 3.5);
    (livePatch.nodes[NODE_ID]!.data as { songRec?: unknown }).songRec = null;
    run(ctx, 3.5, 3.6);
    expect(songOf().notes?.['0']?.events.length ?? 0).toBeGreaterThan(0); // fresh take
  });
});

describe('clipplayer SONG playback (authoritative)', () => {
  it('song time drives the printed channels out the lane outputs; clips do NOT launch', async () => {
    const song: SongData = {
      v: 1,
      lengthBeats: 0,
      loop: true,
      notes: {
        '0': {
          events: [
            { beat: 0, midi: 72, velocity: 100, lengthBeats: 0.25 },
            { beat: 1, midi: 74, velocity: 100, lengthBeats: 0.25 },
          ],
        },
      },
    };
    seed(
      { stepDiv: 2, quantize: 0, octave: 0, gateLength: 0.9, snh: 1 },
      { clips: { [clipIndex(0, 0)]: noteClip(60) }, clipMode: 'song', song },
    );
    seedTimelorde(1);
    const ctx = new FakeAudioContext();
    const handle = await build(ctx);
    run(ctx, 0, 1.6); // 3.2 beats → onsets at beat 0 (midi72) + beat 1 (midi74)

    // The printed channel drove lane 0's gate + poly gate (audible output).
    expect(hasHighEvent(gateOf(handle, 0)), 'lane 0 mono gate driven').toBe(true);
    expect(hasHighEvent(polyGateOf(handle, 0)), 'lane 0 poly gate driven').toBe(true);
    // Pitch followed the printed notes (last = beat-1 note midi 74, OCT 0).
    expect(handle.read!('pitchVOct:0')).toBeCloseTo(midiToVOct(74), 5);
    // Clips do NOT launch in SONG mode — no active clip on the lane.
    expect(handle.read!('activeLane:0')).toBe(-1);
    // A lane with no printed channel stays silent.
    expect(hasHighEvent(gateOf(handle, 1))).toBe(false);
  });

  it('OCT transposes SONG playback pitch live (OCT not baked into the print)', async () => {
    const song: SongData = {
      v: 1, lengthBeats: 0, loop: true,
      notes: { '0': { events: [{ beat: 0, midi: 72, velocity: 100, lengthBeats: 0.25 }] } },
    };
    seed(
      { stepDiv: 2, quantize: 0, octave: 1, gateLength: 0.9, snh: 1 }, // OCT +1
      { clipMode: 'song', song },
    );
    seedTimelorde(1);
    const ctx = new FakeAudioContext();
    const handle = await build(ctx);
    run(ctx, 0, 0.6);
    expect(handle.read!('pitchVOct:0')).toBeCloseTo(midiToVOct(72) + 1, 5); // +1 octave
  });

  it('entering SONG mode stops a playing SESSION clip (authoritative)', async () => {
    seed(
      { stepDiv: 2, quantize: 0, octave: 0, gateLength: 0.9, snh: 1 },
      { clips: { [clipIndex(0, 0)]: noteClip(72) }, queued: lane8(0, 0, null), clipMode: 'session' },
    );
    seedTimelorde(1);
    const ctx = new FakeAudioContext();
    const handle = await build(ctx);
    run(ctx, 0, 1); // session clip playing
    expect(handle.read!('activeLane:0')).toBe(0);

    // Switch to SONG (empty song) → the session clip stops; song drives nothing.
    (livePatch.nodes[NODE_ID]!.data as { clipMode?: string }).clipMode = 'song';
    run(ctx, 1, 1.3);
    expect(handle.read!('activeLane:0')).toBe(-1); // clip dropped (authoritative)
    expect(handle.read!('gateValue:0')).toBe(0); // silenced
  });
});
