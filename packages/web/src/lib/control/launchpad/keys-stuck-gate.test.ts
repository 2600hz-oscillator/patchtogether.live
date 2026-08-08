// packages/web/src/lib/control/launchpad/keys-stuck-gate.test.ts
//
// THE STUCK-GATE SEAM. Owner report: "playing keyboard mode on push into cv,
// first few notes work but then it hangs with an open gate … a reload of the
// page fixes it". The stuck value sits on the clipplayer lane's `gateSrc`, and
// the cause is UPSTREAM of the allocator: a KEYS note-off that names a
// DIFFERENT note than its note-on did, so `alloc.noteOff()` is a no-op and the
// pressed note is held forever. `serviceAudition` early-returns on an empty
// drain, so nothing ever re-writes the gate back to 0.
//
// WHY THIS FILE EXISTS AT ALL, given launchpad-control.test.ts already asserts
// "a note-off was pushed": that assertion is BLIND to the bug. A note-off for
// the WRONG note is still a note-off. The only instrument that can see this is
// the DOWNSTREAM one — the real clipplayer's real `gateN` ConstantSource — so
// this spec runs BOTH the real Launchpad surface and the real clipplayer
// factory against the shared clip-audition queue and asserts on the CV artifact
// the owner's ES-9 is actually reading.
//
// The instrument is negative-controlled on EVERY run (not once at authoring
// time): each stranding case is paired with the same gesture minus the state
// change, which must end with the gate at 0 — so "the gate never opened" and
// "the gate never closed" can never both read as a pass.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Two subscribers share the clock here (the LED render loop AND the clipplayer
// factory tick), so the usual single-slot mock is not enough — keep a list.
const hoisted = vi.hoisted(() => ({ subs: [] as (() => void)[] }));
vi.mock('$lib/audio/scheduler-clock', () => ({
  SCHEDULER_TICK_MS: 25,
  getSchedulerClock: () => ({
    subscribe: (fn: () => void) => {
      hoisted.subs.push(fn);
      return () => {
        hoisted.subs = hoisted.subs.filter((f) => f !== fn);
      };
    },
    usingWorker: false,
    dispose: () => {},
  }),
}));
/** Run every clock subscriber once (LED loop + clipplayer tick). */
function tick(): void {
  for (const fn of [...hoisted.subs]) fn();
}

import { patch as livePatch } from '$lib/graph/store';
import {
  installSimulatedLaunchpad,
  __test_resetLaunchpad,
  type SimulatedLaunchpad,
} from './launchpad-device.svelte';
import {
  bindLaunchpadToClip,
  unbindLaunchpad,
  __test_resetBinding,
  __test_mode,
  __test_strandAuditionNote,
} from './launchpad-control.svelte';
import {
  DECK_KEYS_REC_COL,
  DECK_KEYS_ROW,
  KEYS_CTRL_ROW,
  KEYS_OCT_UP_COL,
  KEYS_OCT_DOWN_COL,
  KEYS_PANIC_COL,
  KEYS_EXIT_COL,
} from './launchpad-map';
import { clearPlayheads } from '$lib/audio/modules/clip-playhead';
import { clearAudition } from '$lib/audio/modules/clip-audition';
import { clipplayerDef } from '$lib/audio/modules/clipplayer';
import { CLIP_LANES, clipIndex, defaultNoteClip, type NoteClipRecord } from '$lib/audio/modules/clip-types';

const NODE_ID = 'cp1';

// ── the minimal fake AudioContext (same shape as clipplayer.test.ts) ─────────
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
  _inputs: Record<number, FakeConstantSource> = {};
  connect() {}
  disconnect() {}
}
class FakeAnalyser {
  fftSize = 2048;
  connect() {}
  disconnect() {}
  getFloatTimeDomainData(out: Float32Array) {
    out.fill(0);
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

function clearPatch() {
  for (const k of Object.keys(livePatch.nodes)) delete livePatch.nodes[k];
  for (const k of Object.keys(livePatch.edges)) delete livePatch.edges[k];
}
function noteClip(): NoteClipRecord {
  return defaultNoteClip();
}
function seedClipPlayer(data: Record<string, unknown>) {
  clearPatch();
  livePatch.nodes[NODE_ID] = {
    id: NODE_ID, type: 'clipplayer', domain: 'audio', position: { x: 0, y: 0 }, params: {}, data,
  } as never;
  livePatch.nodes['tl'] = {
    id: 'tl', type: 'timelorde', domain: 'audio', position: { x: 0, y: 0 },
    params: { running: 0, bpm: 120 }, data: {},
  } as never;
}
type Handle = { outputs: Map<string, { node: unknown }>; read?: (k: string) => unknown };
async function buildClipplayer(ctx: FakeAudioContext): Promise<Handle> {
  return (await clipplayerDef.factory(
    ctx as unknown as AudioContext,
    { id: NODE_ID, type: 'clipplayer', params: livePatch.nodes[NODE_ID]!.params } as never,
  )) as unknown as Handle;
}
/** The lane's MONO gate CV — the exact ConstantSource an ES-9 `gateN` patch reads. */
function laneGate(handle: Handle, lane: number): FakeParam {
  return (handle.outputs.get(`gate${lane + 1}`)!.node as unknown as FakeConstantSource)
    .offset as unknown as FakeParam;
}

const yForLane = (lane: number) => CLIP_LANES - 1 - lane;

let sim: SimulatedLaunchpad;
let ctx: FakeAudioContext;
let handle: Handle;
/** The clock subscribers the CLIPPLAYER FACTORY registered (as opposed to the
 *  LED render loop). Lets a test advance the engine WITHOUT running the render
 *  loop's failsafe — the only way to observe the un-repaired failure state. */
let engineSubs: (() => void)[] = [];
function tickEngine(): void {
  for (const fn of [...engineSubs]) fn();
}

/** Bind the pair to a clip-player with a live clipplayer engine on the far end,
 *  then open KEYS on clip (slot 0, lane 0). Returns the lane-0 gate param. */
async function openKeys(): Promise<FakeParam> {
  seedClipPlayer({ clips: { [clipIndex(0, 0)]: noteClip() } });
  sim = await installSimulatedLaunchpad();
  bindLaunchpadToClip(NODE_ID);
  ctx = new FakeAudioContext();
  const beforeSubs = hoisted.subs.length;
  handle = await buildClipplayer(ctx);
  engineSubs = hoisted.subs.slice(beforeSubs);
  expect(engineSubs.length, 'the clipplayer factory subscribed to the clock').toBe(1);
  // KEYS entry (pair): hold note-REC on the R deck + double-tap the clip on L.
  sim.press('R', DECK_KEYS_REC_COL, DECK_KEYS_ROW);
  sim.press('L', 0, yForLane(0));
  sim.press('L', 0, yForLane(0));
  sim.release('R', DECK_KEYS_REC_COL, DECK_KEYS_ROW);
  expect(__test_mode().mode, 'KEYS opened').toBe('keys');
  tick();
  return laneGate(handle, 0);
}

// A keyboard pad on unit L. The note band is y=1..6; (x=2,y=1) → col 2 row 0 →
// midi = root(48) + 2 = 50.
const KB_X = 2;
const KB_Y = 1;

beforeEach(() => {
  hoisted.subs = [];
  engineSubs = [];
  __test_resetBinding();
  __test_resetLaunchpad();
  clearPatch();
  clearPlayheads(NODE_ID);
  clearAudition(NODE_ID);
});

describe('KEYS stuck gate — a release must name the note its PRESS emitted', () => {
  // ── the permanent negative control ────────────────────────────────────────
  // Runs on EVERY invocation of this suite. Without it, a gate that never rose
  // would satisfy every "gate is 0 after release" assertion below, and the whole
  // file would be decoration.
  it('CONTROL: a plain press/release opens the gate and closes it again', async () => {
    const gate = await openKeys();
    sim.press('L', KB_X, KB_Y);
    tick();
    expect(gate.value, 'press opened the lane gate (instrument is live)').toBe(1);
    sim.release('L', KB_X, KB_Y);
    tick();
    expect(gate.value, 'release closed the lane gate').toBe(0);
    expect(handle.read!('gateValue:0'), 'the lane read agrees').toBe(0);
    expect(__test_mode().keysOrphanFlushes, 'no failsafe involvement in the control').toBe(0);
  });

  // ── trigger 1: OCTAVE SHIFT between press and release ─────────────────────
  it('OCTAVE-UP while a pad is HELD: the release must still close the gate', async () => {
    const gate = await openKeys();
    sim.press('L', KB_X, KB_Y); // midi 50 sounds
    tick();
    expect(gate.value, 'the note is sounding').toBe(1);
    sim.press('L', KEYS_OCT_UP_COL, KEYS_CTRL_ROW); // keysOctaveShift 0 → +12
    sim.release('L', KEYS_OCT_UP_COL, KEYS_CTRL_ROW);
    tick();
    sim.release('L', KB_X, KB_Y); // pre-fix: emits midi 62 — note 50 is STRANDED
    tick();
    expect(gate.value, 'gate closed after the physical pad was released').toBe(0);
    expect(__test_mode().keysPressedCount, 'no phantom held key remains').toBe(0);
    // ⚠ THE LOAD-BEARING ASSERTION. The render-loop failsafe would have closed
    // that gate on this very tick even with the bug still present, so the gate
    // check alone can no longer fail. The counter is what distinguishes "the
    // release was correct" from "the watchdog cleaned up after it".
    expect(__test_mode().keysOrphanFlushes, 'the RELEASE was correct — the failsafe never fired').toBe(0);
  });

  it('OCTAVE-DOWN while a pad is HELD: the release must still close the gate', async () => {
    const gate = await openKeys();
    sim.press('L', KB_X, KB_Y);
    tick();
    expect(gate.value).toBe(1);
    sim.press('L', KEYS_OCT_DOWN_COL, KEYS_CTRL_ROW);
    sim.release('L', KEYS_OCT_DOWN_COL, KEYS_CTRL_ROW);
    tick();
    sim.release('L', KB_X, KB_Y);
    tick();
    expect(gate.value, 'gate closed after the physical pad was released').toBe(0);
    expect(__test_mode().keysOrphanFlushes, 'the release was correct, not repaired').toBe(0);
  });

  it('the octave shift still WORKS — a pad pressed after it sounds the shifted pitch', async () => {
    // Guards against "fixing" the strand by neutering the octave control.
    const gate = await openKeys();
    sim.press('L', KEYS_OCT_UP_COL, KEYS_CTRL_ROW);
    sim.release('L', KEYS_OCT_UP_COL, KEYS_CTRL_ROW);
    expect(__test_mode().keysOctaveShift, 'the octave really shifted').toBe(12);
    sim.press('L', KB_X, KB_Y);
    tick();
    expect(gate.value).toBe(1);
    // pitch1 lane CV: root 48 + col 2 + 12 = 62 → v/oct (60 = 0 V, 1 V/octave).
    expect(handle.read!('pitchVOct:0'), 'sounded the SHIFTED pitch (midi 62)')
      .toBeCloseTo((62 - 60) / 12, 5);
    sim.release('L', KB_X, KB_Y);
    tick();
    expect(gate.value, 'and it still releases cleanly').toBe(0);
  });

  // ── two pads held across a shift: BOTH must release ───────────────────────
  it('TWO pads held across an octave shift both release', async () => {
    const gate = await openKeys();
    sim.press('L', KB_X, KB_Y);
    sim.press('L', KB_X + 1, KB_Y);
    tick();
    expect(gate.value).toBe(1);
    sim.press('L', KEYS_OCT_UP_COL, KEYS_CTRL_ROW);
    sim.release('L', KEYS_OCT_UP_COL, KEYS_CTRL_ROW);
    tick();
    sim.release('L', KB_X, KB_Y);
    tick();
    expect(gate.value, 'still held by the second pad').toBe(1);
    sim.release('L', KB_X + 1, KB_Y);
    tick();
    expect(gate.value, 'both pads released → gate closed').toBe(0);
    expect(__test_mode().keysOrphanFlushes, 'both releases were correct').toBe(0);
  });

  // ── a shift can happen MID-CHORD, repeatedly ──────────────────────────────
  it('repeated octave shifts while playing never accumulate a stranded voice', async () => {
    // The owner's "first few notes work but then it hangs" in its most literal
    // form: play, shift, play, shift … every physical release must land.
    const gate = await openKeys();
    for (let i = 0; i < 6; i++) {
      sim.press('L', KB_X, KB_Y);
      tick();
      expect(gate.value, `note ${i} sounded`).toBe(1);
      const col = i % 2 === 0 ? KEYS_OCT_UP_COL : KEYS_OCT_DOWN_COL;
      sim.press('L', col, KEYS_CTRL_ROW);
      sim.release('L', col, KEYS_CTRL_ROW);
      tick();
      sim.release('L', KB_X, KB_Y);
      tick();
      expect(gate.value, `note ${i} released`).toBe(0);
      expect(__test_mode().keysOrphanFlushes, `note ${i} needed no failsafe repair`).toBe(0);
    }
  });

  // ── the SAME PITCH from two different pads (fourths layout overlap) ────────
  it('two DIFFERENT pads at the same pitch: releasing one does not kill the other', async () => {
    // In the LinnStrument fourths layout (col +1, row +5) pad (col 5,row 0) and
    // pad (col 0,row 1) are both midi 53. Keying held state by PITCH made the
    // second press a dedupe no-op and the FIRST release silence the still-held
    // pad — the mirror image of the strand (an early cut instead of a stick).
    const gate = await openKeys();
    sim.press('L', 5, 1); // col 5 row 0 → 48 + 5 = 53
    tick();
    expect(gate.value).toBe(1);
    sim.press('L', 0, 2); // col 0 row 1 → 48 + 5 = 53 (same pitch, other pad)
    tick();
    sim.release('L', 0, 2); // release the SECOND pad only
    tick();
    expect(gate.value, 'the first pad is still physically held → still sounding').toBe(1);
    sim.release('L', 5, 1);
    tick();
    expect(gate.value, 'both released → gate closed').toBe(0);
    expect(__test_mode().keysOrphanFlushes, 'no failsafe repair needed').toBe(0);
  });

  // ── the FAILSAFE must not paper over a real leak ──────────────────────────
  it('PANIC still closes the gate (and the failsafe does not fight it)', async () => {
    const gate = await openKeys();
    sim.press('L', KB_X, KB_Y);
    tick();
    expect(gate.value).toBe(1);
    sim.press('L', KEYS_PANIC_COL, KEYS_CTRL_ROW);
    tick();
    expect(gate.value, 'PANIC released everything').toBe(0);
    expect(__test_mode().keysOrphanFlushes, 'PANIC is a clean release, not a repair').toBe(0);
  });

  it('EXIT from KEYS with a pad still held closes the gate', async () => {
    const gate = await openKeys();
    sim.press('L', KB_X, KB_Y);
    tick();
    expect(gate.value).toBe(1);
    sim.press('L', KEYS_EXIT_COL, KEYS_CTRL_ROW); // idle → back to session
    tick();
    expect(__test_mode().mode).toBe('session');
    expect(gate.value, 'leaving KEYS flushed the held note').toBe(0);
    expect(__test_mode().keysOrphanFlushes, 'EXIT is a clean release, not a repair').toBe(0);
  });

  // ── the KEYS clip DISAPPEARS while a pad is held ──────────────────────────
  it('the KEYS clip VANISHING while a pad is held releases the note', async () => {
    // Reachable for real: a scene paste, an undo, or a collaborator can delete
    // the clip KEYS is open on. The render loop then drops KEYS to session —
    // and used to do it without releasing anything the keyboard was sounding.
    // This is also the reachable half of the `if (!clip) return` early-out on
    // the release path: with the clip gone, a recomputing release could not
    // even resolve a pitch to send.
    const gate = await openKeys();
    sim.press('L', KB_X, KB_Y);
    tick();
    expect(gate.value, 'sounding').toBe(1);
    const clips = (livePatch.nodes[NODE_ID]!.data as { clips: Record<string, unknown> }).clips;
    delete clips[String(clipIndex(0, 0))];
    tick();
    expect(__test_mode().mode, 'KEYS dropped to session').toBe('session');
    expect(gate.value, 'the held note was released on the way out').toBe(0);
    expect(__test_mode().keysOrphanFlushes, 'flushed by the exit path, not the failsafe').toBe(0);
  });

  it('a RELEASE arriving after the clip vanished still closes the gate', async () => {
    // The release path must not depend on the clip: the note-off is replayed
    // from the pad record, so it lands even with nothing left to look up.
    const gate = await openKeys();
    sim.press('L', KB_X, KB_Y);
    tickEngine(); // engine only — do NOT let the render loop drop out of KEYS
    expect(gate.value).toBe(1);
    const clips = (livePatch.nodes[NODE_ID]!.data as { clips: Record<string, unknown> }).clips;
    delete clips[String(clipIndex(0, 0))];
    sim.release('L', KB_X, KB_Y); // clip is GONE at release time
    tickEngine();
    expect(gate.value, 'the release landed without the clip').toBe(0);
    expect(__test_mode().keysOrphanFlushes, 'a real release, not a repair').toBe(0);
  });
});

// ===========================================================================
// THE FAILSAFE. keysReconcileSounding() releases any voice that no held pad and
// no running arp explains. It is only trustworthy if it is negative-controlled
// in BOTH directions on every run — a counter that cannot increment reads 0
// whether the failsafe works or is dead code, and a failsafe nobody can see
// fire is indistinguishable from one that silently masks the next leak.
// ===========================================================================
describe('KEYS stuck-gate FAILSAFE — repairs the audio AND reports the bug', () => {
  it('POSITIVE: a manufactured strand is released within one tick, counted and warned', async () => {
    const gate = await openKeys();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(__test_mode().keysOrphanFlushes, 'clean slate').toBe(0);
      // A note-on whose note-off was lost — the exact residue of the bug.
      __test_strandAuditionNote(0, 55);
      // Advance the ENGINE ONLY, so the failsafe has not run yet: this is the
      // un-repaired failure state, and it must reproduce the owner's symptom.
      tickEngine();
      expect(gate.value, 'the strand really does pin the lane gate HIGH').toBe(1);
      expect(__test_mode().keysOrphanFlushes, 'nothing has repaired it yet').toBe(0);
      // Now the render loop: reconcile (counts + warns) then the engine drains.
      tick();
      expect(__test_mode().keysOrphanFlushes, 'the failsafe COUNTED it').toBe(1);
      expect(warn, 'the failsafe was LOUD about it').toHaveBeenCalledTimes(1);
      expect(__test_mode().keysSoundingCount, 'ledger drained').toBe(0);
      expect(gate.value, 'and the gate came back down without a page reload').toBe(0);
      // It does not re-fire on an already-repaired strand.
      tick();
      tick();
      expect(__test_mode().keysOrphanFlushes, 'one orphan = one count').toBe(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('NEGATIVE: ordinary play — including across octave shifts — never trips it', async () => {
    // The other half of the control. If this could pass with the failsafe doing
    // all the work, the failsafe would be masking the real fix; the counter is
    // what makes that impossible to miss.
    const gate = await openKeys();
    for (let i = 0; i < 4; i++) {
      sim.press('L', KB_X + i, KB_Y);
      tick();
      sim.press('L', KEYS_OCT_UP_COL, KEYS_CTRL_ROW);
      sim.release('L', KEYS_OCT_UP_COL, KEYS_CTRL_ROW);
      tick();
      sim.release('L', KB_X + i, KB_Y);
      tick();
    }
    expect(gate.value, 'everything released').toBe(0);
    expect(__test_mode().keysOrphanFlushes, 'the FIX did the work, not the failsafe').toBe(0);
    expect(__test_mode().keysSoundingCount, 'nothing left sounding').toBe(0);
  });

  it('UNBINDING with a pad held releases it — the failsafe cannot cover this one', async () => {
    // Unbinding stops the render loop, which is WHERE the failsafe runs. So
    // anything still sounding at unbind would hang with nothing left to notice
    // it — the flush has to happen on the way out, not be delegated.
    const gate = await openKeys();
    sim.press('L', KB_X, KB_Y);
    tick();
    expect(gate.value, 'sounding').toBe(1);
    unbindLaunchpad();
    tickEngine(); // the render loop is gone; only the engine still ticks
    expect(gate.value, 'unbind released the held note').toBe(0);
    expect(__test_mode().keysOrphanFlushes, 'a clean flush, not a repair').toBe(0);
  });

  it('NEGATIVE: a HELD pad is never stolen by the failsafe', async () => {
    // The failure mode of a too-eager watchdog: cutting notes the player is
    // actually holding. Hold across many ticks and assert it survives.
    const gate = await openKeys();
    sim.press('L', KB_X, KB_Y);
    for (let i = 0; i < 20; i++) tick();
    expect(gate.value, 'a genuinely held pad keeps sounding').toBe(1);
    expect(__test_mode().keysOrphanFlushes, 'held ≠ orphan').toBe(0);
    sim.release('L', KB_X, KB_Y);
    tick();
    expect(gate.value).toBe(0);
    expect(__test_mode().keysOrphanFlushes).toBe(0);
  });
});
