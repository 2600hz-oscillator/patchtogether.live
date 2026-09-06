// packages/web/src/lib/ui/modules/node-clip-recorder-registry.svelte.ts
//
// THE CLIP-RECORD REGISTRY — the third node-keyed registry, written after
// reading node-samsloop-registry.svelte.ts:62-91 (which explains field by
// field why the first two were not merged). This one differs from BOTH, and
// the spec's §4.6 table is restated here because it is the reason a third
// registry exists at all:
//
//   | | node-recorder (video) | node-samsloop (audio) | node-clip-recorder |
//   |---|---|---|---|
//   | pump        | rAF PULL          | port PUSH        | port PUSH          |
//   | render lease| yes               | no               | no                 |
//   | concurrency | one take per node | one take per node| UP TO 8 PER NODE   |
//   | on stop     | on-disk artifact  | node.data.sample | OPFS → clips[k] on |
//   |             |                   |                  | a DIFFERENT node   |
//   | boundary    | wall clock        | byte cap         | AUDIO FRAMES       |
//   | sweep leaves| recover candidate | nothing          | recover candidate  |
//
// The last two rows are the reason it can be neither of the others: the
// recorder lives on MIXMSTRS (keyed here by that node's id) and the commit
// lands on CLIPPLAYER, and every boundary is a frame count compared against
// the worklet's own currentFrame — never a wall-clock elapsed.
//
// ⚠ THE #1574 GUARD, ADOPTED VERBATIM: no `dispose()`, no `release()`, no
// `detach()`. Its ABSENCE is the guard — a card cannot tear a take down in an
// onDestroy because there is no method to call and tsc refuses the attempt
// before any test runs. The only ways a take ends are its frame boundary,
// CANCEL (the arm param dropping to off), the transport stopping, and the
// graph-lifetime `sync()` sweeping a deleted node — which ABANDONS the take
// and leaves its scratch as a recover candidate, never deletes it.
//
// ⚠ THERE IS CURRENTLY NO ARM SURFACE AT ALL, AND THAT IS DELIBERATE. The arm
// used to be a mixmstrs param (`ch{N}_rec`, slice 3's record band): this
// registry polled the mixer's effective (knob + CV) values through
// `read('recState')` and drove the pure machine from edges on them. The owner
// ruled that surface off the mixer on 2026-09-04 — recording is a CLIPPLAYER
// feature, per clip — and the replacement per-lane toggle has not landed yet.
//
// So `read('recState')` returns `undefined` on every mixmstrs node today, the
// guard at the top of `#pumpEntry` returns, and this registry IDLES: entries are
// still created per live mixmstrs node, no wiring is built, no take can start,
// and `clipPadState` is untouched. `cliprec-registry-idles.spec.ts` pins that,
// because an absent seam that throws and an absent seam that idles look
// identical from the outside until someone boots a rack.
//
// The edge contract below is UNCHANGED and is what the clipplayer toggle will
// drive; only the SOURCE of the arm value moves. Level semantics:
//   - 0 → 1 edge while idle  = ARM SINGLE (this slice; 2/endless is slice 6,
//     and reads as "not 1" here — arming stays un-actioned until it lands).
//     The edge PREPARES (refusals, tempo latch, manifest, writer worker —
//     the I/O a cold host controls) and the machine arms only at CONFIRM,
//     with the window resolved from the clock AFTER the open — see LaneRec;
//   - → 0 while armed/recording = CANCEL (the escape — nothing committed);
//   - after a COMMIT the registry snaps the KNOB back to 0 itself, so the
//     control reads disarmed and a held CV gate must dip before it re-arms
//     (edge-triggered arm; a held high never machine-guns takes).
//   A saved rack that loads with the param already at 1 is ADOPTED without
//   arming (the resetNonce rule: a loaded patch never replays a gesture).
//
// ⚠ THE COMMIT IS THE TRANSACTIONAL PAIRING the spec defines. Order:
//   1. the take's bytes are durable (drain flushed, writer closed);
//   2. the AudioClipRecord lands in clips[k] inside ONE `clipUndoTransact`
//      — the whole take is one undo unit on the launcher's own stack;
//   3. only then `finishClipMediaTake` flips the manifest to 'done' — the
//      clip that names the media exists first, so the GC's live set covers
//      it and the status flip can no longer orphan it (the
//      clip-media-recovery ordering rule).
//   A FAILED finalize writes NO clip record and KEEPS the scratch + manifest
//   ('recording') as a recover candidate — never a half-committed clip.
//   Undoing the commit removes the record, which orphans the media for the
//   graph-pass GC (`sweepClipMedia`) — deleting a take IS the undo's job.

import type { ModuleNode } from '$lib/graph/types';
import type { AudioEngine } from '$lib/audio/engine';
import { getActiveEngine } from '$lib/audio/engine-ref';
import { patch, ydoc } from '$lib/graph/store';
import { setNodeParam } from '$lib/graph/mutate';
import { clipUndoTransact } from '$lib/control/clip-undo';
import {
  CLIP_REC_IDLE,
  clipRecStartFrame,
  clipRecUnitFrames,
  clipRecTransition,
  type ClipRecEffect,
  type ClipRecEvent,
  type ClipRecMode,
  type ClipRecState,
} from '$lib/audio/clip-audio-rec-machine';
import type { RecordingWindow } from '$lib/audio/clip-media';
import {
  beginClipMediaTake,
  finishClipMediaTake,
  hasClipMediaStore,
  newClipMediaId,
  removeClipMedia,
  type ClipMediaManifest,
  type ClipMediaWriter,
} from '$lib/audio/clip-media-store';
import { ClipMediaDrain } from '$lib/audio/clip-media-drain';
import {
  armClipRecorderLane,
  cancelClipRecorderLane,
  disconnectClipRecorderWiring,
  ensureClipRecorderWorklet,
  stopClipRecorderLane,
  wireClipRecorder,
  CLIP_RECORDER_BYTES_PER_FRAME,
  attachClipRecorderSink,
  type ClipRecorderWiring,
} from '$lib/audio/modules/clip-recorder-node';
import type { MixmstrsRecTaps } from '$lib/audio/modules/mixmstrs';
// CLAUSE 2 — the record target is the lane's SELECTED clip. The selection is a
// per-viewer authoring lens (never synced), which is also the right scope for
// recording: the take belongs in the clip the person who armed it was looking
// at, and the single-writer lease already means one peer records a given lane.
import { clipplayerSelectedSlotForLane } from '$lib/ui/modules/clipplayer/clipplayer-face-selection.svelte';
import {
  CLIP_LANES,
  DEFAULT_CLIP_STEPS,
  SCENE_STRIDE,
  clipIndex,
  coerceClipRecord,
  readClip,
  audioRecState,
  laneRecArm,
  laneRecMode,
  noteClipHasContent,
  type AudioClipRecord,
  type ClipPlayerData,
  type ClipRecordTap,
} from '$lib/audio/modules/clip-types';
import { laneRateIndex, laneStepDur } from '$lib/audio/modules/clip-clock';

/** How far ahead of "now" a take punches in when NOTHING is playing (no
 *  reference bar to wait for). By the time this is applied the media is
 *  already OPEN and the worklet wired (the prepare/confirm split below), so
 *  it only has to cover the arm message's trip to the audio thread. */
export const CLIP_REC_ARM_LEAD_S = 0.12;

/** The minimum runway to a REFERENCE-BAR boundary for the punch-in to be
 *  reliable (the arm message must reach the audio thread first). A boundary
 *  closer than this at confirm time SLIPS one reference bar to the next
 *  wrap — a take that starts one bar later is a take; a take that misses its
 *  own first samples is a failure that looks like success. */
export const CLIP_REC_MIN_BOUNDARY_LEAD_S = 0.05;

/** How long the commit waits for the worklet's `done` after the machine saw
 *  the stop frame pass. The worklet finishes inside the stop frame's own
 *  quantum; this bound only covers MessagePort delivery under load. */
export const CLIP_REC_DONE_TIMEOUT_MS = 3000;

const TAP_NAMES: readonly ClipRecordTap[] = ['board-in', 'post-fader', 'master'];

/** CLAUSE 8's capture point: `recTap` index 0 — BOARD IN, the RAW patched
 *  channel input, before EQ, the compressor and the fader. Lane N captures
 *  mixmstrs channel N (the normalled-return mapping, by array index inside
 *  `mixmstrsRecTapPair`).
 *
 *  ⚠ THE NAMED POSTMIX SEAM. The owner asked for pre-mix now and "a toggle
 *  later for postmix". This constant is the single place that decision is
 *  taken, so the later toggle replaces one value rather than threading a new
 *  parameter through the arm path. Do not inline it. */
const CLIP_REC_BOARD_IN_TAP = 0;

/** What the mixer's `read('recState')` hands back (slice 3's shape). */
interface MixRecState {
  arm: number[];
  tap: number;
  quality: number;
}

/** What the launcher's `read('recClock')` hands back (slice 5's key). */
interface RecClock {
  running: boolean;
  baseStepDur: number;
  boundary: number | null;
  refSeconds: number | null;
}

/** The engine surface this registry needs — structural, so a unit test fakes
 *  ONE method instead of a PatchEngine. */
export interface ClipRecEngineLike {
  read(node: ModuleNode, key: string): unknown;
}

/** Injectable seams (tests). Everything that touches a worklet, OPFS or the
 *  wall clock goes through here so the registry's LOGIC runs in node. */
export interface ClipRecRegistryDeps {
  engine(): ClipRecEngineLike | null;
  /** The live audio context, or null while no audio domain runs. */
  audioCtx(): BaseAudioContext | null;
  startTicker(tick: () => void): () => void;
  ensureWorklet(ctx: BaseAudioContext): Promise<void>;
  wire(
    ctx: BaseAudioContext,
    taps: MixmstrsRecTaps,
    tap: number,
    owner?: { id?: string; type?: string },
  ): ClipRecorderWiring;
  hasStore(): boolean;
  beginTake(m: ClipMediaManifest): Promise<ClipMediaWriter>;
  finishTake(mediaId: string, frames: number): Promise<void>;
  removeMedia(mediaId: string): Promise<void>;
  now(): number;
}

const DEFAULT_DEPS: ClipRecRegistryDeps = {
  engine: () => getActiveEngine(),
  audioCtx: () => {
    const e = getActiveEngine();
    if (!e || !e.hasDomain('audio')) return null;
    try {
      return e.getDomain<AudioEngine>('audio').ctx;
    } catch {
      return null;
    }
  },
  startTicker: (tick) => {
    const t = setInterval(tick, 50);
    return () => clearInterval(t);
  },
  ensureWorklet: ensureClipRecorderWorklet,
  wire: wireClipRecorder,
  hasStore: hasClipMediaStore,
  beginTake: beginClipMediaTake,
  finishTake: finishClipMediaTake,
  removeMedia: removeClipMedia,
  now: () => Date.now(),
};

/** One lane's record slot inside an entry. The machine is always present;
 *  the take fields exist only between arm and commit/discard.
 *
 *  ⚠ THE ARM IS A TWO-STEP OBSERVABLE SEQUENCE, and `preparing`/`prepared`
 *  are its states. The 0→1 edge only PREPARES: refusal checks, the manifest
 *  write, the writer worker, the wiring — all the I/O whose latency a cold,
 *  contended host controls (measured on CI: an IDB open can outrun a
 *  precomputed punch-in, and the take then "records" into media that never
 *  opened). The machine is dispatched `arm` only at CONFIRM, when the media
 *  is open — and the window is resolved from the CLOCK AT THAT MOMENT, so
 *  `armed` always means "worklet armed, media open, window in the future".
 *  The pads still read armed from the edge onward: the prep projection writes
 *  `audioRec` with `startFrame: null`, the exact "armed and not yet resolved"
 *  state the AudioRecState type declares. */
interface LaneRec {
  machine: ClipRecState;
  /** Identity of the CURRENT take's async work. Bumped at every prepare and
   *  every cancel/clear, so a media open that resolves for a dead take can
   *  only discard itself — never install into a newer one. */
  takeSeq: number;
  /** The edge was accepted; the media open is in flight. */
  preparing: boolean;
  /** The media is open + the worklet wired; the next pump confirms the arm. */
  prepared: boolean;
  /** The clipplayer node the take commits to — latched at arm. */
  clipNodeId: string | null;
  slot: number;
  lengthSteps: number;
  /** The unit loop in frames — latched at the EDGE (tempo latch, spec edge 3);
   *  only the window's start/stop wait for confirm. */
  unitFrames: number;
  tap: number;
  sampleRate: number;
  mediaId: string | null;
  writer: ClipMediaWriter | null;
  drain: ClipMediaDrain | null;
  doneFrames: number | null;
  /** The punch-in this thread ASKED the worklet for, latched when `arm` was
   *  posted, and the one it REPORTED on `done`. They differ when the arm
   *  message lost its race with the audio thread and the take slid; keeping
   *  both is what turns that from invisible into a console line. */
  armStartFrame: number | null;
  doneStartFrame: number | null;
  doneWait: Promise<void> | null;
  doneResolve: (() => void) | null;
}

function freshLane(): LaneRec {
  return {
    machine: CLIP_REC_IDLE,
    takeSeq: 0,
    preparing: false,
    prepared: false,
    clipNodeId: null,
    slot: 0,
    lengthSteps: DEFAULT_CLIP_STEPS,
    unitFrames: 0,
    tap: 0,
    sampleRate: 48000,
    mediaId: null,
    writer: null,
    drain: null,
    doneFrames: null,
    armStartFrame: null,
    doneStartFrame: null,
    doneWait: null,
    doneResolve: null,
  };
}

interface Entry {
  nodeId: string;
  lanes: LaneRec[];
  /** The transport's last observed running state, so the STOPPED→PLAYING edge
   *  is visible. `null` until the first pump adopts it without firing. Clause 4
   *  (arm while stopped, record when it plays) is the reason it exists. */
  prevRunning: boolean | null;
  wiring: ClipRecorderWiring | null;
  wiringTap: number;
  /** Identity of the taps roster the wiring was built from — a rebuilt mixer
   *  factory hands back a new object, and stale wiring points at dead nodes. */
  tapsRef: unknown;
  wiringBuild: Promise<void> | null;
}

export interface ClipRecLaneView {
  phase: ClipRecState['phase'];
  /** The observable arm sequence's I/O states (machine phase is 'idle' while
   *  either is true — the machine arms only at confirm). */
  preparing: boolean;
  prepared: boolean;
  slot: number;
  mediaId: string | null;
}

export class NodeClipRecorderRegistry {
  #entries = new Map<string, Entry>();
  #deps: ClipRecRegistryDeps;
  #stopTicker: (() => void) | null = null;
  #version = $state(0);
  /** The last refusal's reason, per mixer node — the samsloop "refuse with
   *  the numbers in the message" rule made observable. */
  #refusals = new Map<string, string>();

  constructor(deps: Partial<ClipRecRegistryDeps> = {}) {
    this.#deps = { ...DEFAULT_DEPS, ...deps };
  }

  /** Live view of one mixer node's lanes (tests + debug surfaces). */
  view(nodeId: string): ClipRecLaneView[] | null {
    void this.#version;
    const e = this.#entries.get(nodeId);
    if (!e) return null;
    return e.lanes.map((l) => ({
      phase: l.machine.phase,
      preparing: l.preparing,
      prepared: l.prepared,
      slot: l.slot,
      mediaId: l.mediaId,
    }));
  }

  lastRefusal(nodeId: string): string | null {
    void this.#version;
    return this.#refusals.get(nodeId) ?? null;
  }

  get nodeIds(): string[] {
    void this.#version;
    return [...this.#entries.keys()];
  }

  /** THE GRAPH-LIFETIME SEAM — ensure an entry per live mixmstrs node,
   *  abandon entries whose node is gone (scratch KEPT as a recover
   *  candidate). Canvas calls this from the same `$effect` that sweeps the
   *  sibling registries; a reconciler pass with an unchanged mixer set is a
   *  Map lookup per node. */
  sync(liveNodes: readonly { id: string; type?: string }[]): void {
    // ⚠ ENTRIES ARE KEYED ON THE CLIPPLAYER, NOT THE MIXER (2026-09-04). The
    // arm used to be a mixmstrs param, so an entry per mixer was the natural
    // shape. Recording is now a per-clip CLIPPLAYER feature: the toggle, the
    // mode, the target slot and the single-writer lease all live on the
    // launcher's own node, so that is what an entry tracks. The mixer is still
    // the capture SOURCE (clause 8) and is resolved per pump.
    const mixIds = new Set<string>();
    for (const n of liveNodes) if (n?.type === 'clipplayer') mixIds.add(n.id);
    let changed = false;
    for (const id of mixIds) {
      if (this.#entries.has(id)) continue;
      this.#entries.set(id, {
        nodeId: id,
        lanes: Array.from({ length: CLIP_LANES }, freshLane),
        prevRunning: null,
        wiring: null,
        wiringTap: 0,
        tapsRef: null,
        wiringBuild: null,
      });
      changed = true;
    }
    for (const [id, entry] of this.#entries) {
      if (mixIds.has(id)) continue;
      this.#abandon(entry);
      this.#entries.delete(id);
      changed = true;
    }
    if (this.#entries.size > 0 && !this.#stopTicker) {
      this.#stopTicker = this.#deps.startTicker(() => this.pump());
    } else if (this.#entries.size === 0 && this.#stopTicker) {
      this.#stopTicker();
      this.#stopTicker = null;
    }
    if (changed) this.#version++;
  }

  /** One poll: read the mixer's effective arm values, drive every lane's
   *  machine with arm edges + the context frame, spend the effects. Public so
   *  tests (and deterministic harnesses) can drive it without the ticker. */
  pump(): void {
    const engine = this.#deps.engine();
    const ctx = this.#deps.audioCtx();
    if (!engine || !ctx) return;
    for (const entry of this.#entries.values()) {
      this.#pumpEntry(entry, engine, ctx);
    }
  }

  #pumpEntry(entry: Entry, engine: ClipRecEngineLike, ctx: BaseAudioContext): void {
    // THE ENTRY IS THE LAUNCHER. The toggle, the mode, the target slot and the
    // lease are all on this node.
    const clipNode = patch.nodes[entry.nodeId] as ModuleNode | undefined;
    if (!clipNode) return;
    const data = clipNode.data as ClipPlayerData | undefined;

    // THE MIXER IS THE CAPTURE SOURCE (clause 8) and is resolved per pump, not
    // keyed on. Without one there is nothing to record FROM, so the lane simply
    // cannot arm — but the entry still exists and still idles.
    const mixNode = firstOfType(patch.nodes, 'mixmstrs');

    // ⚠ THE RECORDER IS WIRED LAZILY — ON FIRST ARM, NEVER AT GRAPH SYNC — and
    // that is a deliberate change from the pre-redesign behaviour.
    //
    // This used to run unconditionally on every pump, so ANY rack holding a
    // launcher and a mixer built an 8-input AudioWorkletNode plus 8
    // ChannelMergers wired to the mixer's board taps at boot, forever, whether
    // or not a note was ever recorded. That was invisible before only because
    // the mixer published `recState` unconditionally, so the cost had always
    // been there; #2362 then removed `recState` and the pump started returning
    // BEFORE this line, which silently switched the wiring off altogether.
    // Restoring the arm here restored the boot cost with it — measured on CI as
    // `workflow-lane-uniform-binding` REACH-UP losing a 5 s automation-binding
    // poll on a SwiftShader runner already at ~8 fps.
    //
    // Recording is now an explicit per-lane gesture rather than a param that is
    // always readable, so holding a recorder for a rack that never records buys
    // nothing. Building it at the arm is safe BY CONSTRUCTION: `#openTake`
    // already awaits `entry.wiringBuild` (an arm racing the very first build
    // waits for it), and the worklet's own late-arm SLIDE (#2348) absorbs the
    // punch-in latency that wait costs.
    //
    // A lane that is already live still refreshes against the LIVE taps roster
    // each pump — a rebuilt mixer factory publishes a new one and the old nodes
    // are dead, which is the reason this call is in the pump at all.
    const wantsRecorder =
      !!mixNode &&
      entry.lanes.some(
        (l, i) =>
          l.preparing || l.prepared || l.machine.phase !== 'idle' || laneRecArm(data, i),
      );
    if (wantsRecorder) this.#ensureWiring(entry, engine, ctx, mixNode!, entry.wiringTap);

    const clock = engine.read(clipNode, 'recClock') as RecClock | undefined;
    const frame = Math.floor(ctx.currentTime * ctx.sampleRate);

    const running = clock ? clock.running : true;
    // ⚠ CLAUSE 4 LIVES ON THIS EDGE. The toggle may be set while the transport
    // is paused or stopped; recording starts when it PLAYS. `prevRunning` is
    // adopted without firing on the first pump so a page that loads with the
    // transport already rolling does not read as a fresh start.
    const startedPlaying = entry.prevRunning === false && running;
    entry.prevRunning = running;
    void startedPlaying; // the arm below is level-triggered on (toggle AND running)

    for (let lane = 0; lane < CLIP_LANES; lane++) {
      const st = entry.lanes[lane]!;
      const armed = laneRecArm(data, lane);

      // ⚠ THE ARM IS LEVEL-TRIGGERED ON (TOGGLE AND RUNNING), NOT ON A TOGGLE
      // EDGE, and that IS clause 4. "Set the toggle while stopped, record when
      // it plays" is precisely a condition that becomes true later without the
      // toggle moving — an edge-triggered arm cannot express it, because the
      // edge already happened while the transport was stopped.
      //
      // The machine-gun this would otherwise cause is closed at the other end:
      // a take that ends SNAPS THE TOGGLE OFF (`#snapArmOff`), so the level
      // falls on its own and re-arming requires the player to press it again.
      // That is also the owner's CLIP semantics — one loop, then stop.
      if (
        armed &&
        running &&
        st.machine.phase === 'idle' &&
        !st.preparing &&
        !st.prepared
      ) {
        if (mixNode) {
          this.#beginPrepare(entry, lane, engine, ctx, mixNode, clipNode, clock, laneRecMode(data, lane));
        } else {
          this.#refuse(entry, 'no mixmstrs in the rack to record from');
          this.#writeRecArm(entry, lane, false);
        }
      } else if (!armed) {
        // THE TOGGLE WENT OFF. For an ENDLESS take this is the owner's "tap the
        // record button again": stop at the end of the CURRENT loop, keeping
        // every whole loop captured so far. For anything else it is the escape
        // — nothing commits.
        if (st.preparing || st.prepared) {
          this.#cancelPrep(entry, lane);
        } else if (st.machine.phase === 'recording' && st.machine.mode === 'endless') {
          this.#dispatch(entry, lane, { type: 'stop', frame });
        } else if (
          st.machine.phase !== 'idle' &&
          st.machine.phase !== 'committing' &&
          // ⚠ AND NOT `stopping`. The toggle stays OFF for every pump after the
          // tap, so without this an endless take was told to stop and then
          // CANCELLED on the very next tick — one gesture, two contradictory
          // dispatches, and the take died on its way to the boundary it had
          // just been asked to finish at. `stopping` is the state that gesture
          // produces; re-reading the same OFF level must not undo it.
          st.machine.phase !== 'stopping'
        ) {
          this.#dispatch(entry, lane, { type: 'cancel' });
        }
      }

      // THE TRANSPORT STOPPING ends a live take: an endless one truncates to
      // its whole loops, a single one discards (its contract is exactly one
      // loop, and a partial is not a shorter version of it).
      //
      // ⚠ A LANE THAT IS ONLY *PREPARED* SURVIVES A STOPPED TRANSPORT — this
      // is the other half of clause 4. It used to be cancelled here, which is
      // exactly what made "arm while stopped" impossible: the arm was torn down
      // on the very next pump, before play could ever start it.
      if (clock && !running && st.machine.phase !== 'idle') {
        this.#dispatch(entry, lane, { type: 'transportStop', frame });
      }

      // CONFIRM: the media opened — resolve the window from the clock AS OF
      // NOW (never the clock that existed before the slow open) and arm the
      // machine + worklet in one dispatch. While the transport is stopped this
      // simply does not fire, and the lane waits in `prepared` until it plays.
      if (st.prepared && st.machine.phase === 'idle' && running) {
        this.#confirmArm(entry, lane, ctx, clock, laneRecMode(data, lane));
      }

      this.#dispatch(entry, lane, { type: 'frame', frame });
    }
  }

  // -------------------------------------------------------------------------
  // Arming
  // -------------------------------------------------------------------------

  #refuse(entry: Entry, reason: string): void {
    this.#refusals.set(entry.nodeId, reason);
    this.#version++;
    console.warn(`[clip-rec] ${entry.nodeId}: refusing to arm — ${reason}`);
  }

  /** THE EDGE — step one of the arm sequence. Sync refusal checks, the tempo
   *  latch (lengthSteps/unitFrames), the tap latch, the armed projection
   *  (`startFrame: null` — the AudioRecState "not yet resolved" state), then
   *  the ASYNC media open. Returns true when the lane accepted the edge (the
   *  transport is then running — it already was, or the arm just started it).
   *
   *  ⚠ NO WINDOW IS RESOLVED HERE. The window's start/stop are frames on the
   *  context clock, and every millisecond of I/O between here and the worklet
   *  arm would eat into them — measured on a contended CI shard, the IDB open
   *  alone outran a precomputed punch-in. `#confirmArm` resolves the window
   *  AFTER the open, from the clock as of that moment. */
  #beginPrepare(
    entry: Entry,
    lane: number,
    engine: ClipRecEngineLike,
    ctx: BaseAudioContext,
    mixNode: ModuleNode,
    clipNode: ModuleNode | undefined,
    clock: RecClock | undefined,
    mode: ClipRecMode,
  ): boolean {
    if (!clipNode || !clock) {
      this.#refuse(entry, 'no clip launcher in the rack to record into');
      return false;
    }
    if (!this.#deps.hasStore()) {
      this.#refuse(entry, 'this browser has no OPFS clip media store (worker sync access required)');
      return false;
    }
    const data = clipNode.data as ClipPlayerData | undefined;
    // Single-writer lease: a lane another peer is recording is not ours.
    const foreign = audioRecState(data, lane);
    if (foreign && foreign.recorderId !== ydoc.clientID) {
      this.#refuse(entry, `lane ${lane + 1} is being recorded by another collaborator`);
      return false;
    }
    // ⚠ CLAUSE 2 — THE SELECTED CLIP, NOT THE FIRST EMPTY ONE. This used to be
    // `firstEmptySlot(data, lane)`, the Live/Push "New" model: arming dropped
    // the take into whatever slot happened to be free. The owner's rule is
    // "audio is recorded INTO THE SELECTED CLIP of a lane", so the target is
    // the slot the player last selected in this lane and nothing else — a
    // record button whose destination you cannot see is a record button that
    // loses takes.
    const slot = clipplayerSelectedSlotForLane(clipNode.id, lane);
    // A note clip in the target is a REFUSAL, not a silent relocation: a slot
    // holds exactly one kind, and quietly recording somewhere else would be the
    // same defect the selected-slot rule exists to remove. (The commit re-checks
    // this at the end — a peer can author notes into the slot mid-take.)
    // ⚠ ONLY AUTHORED NOTES BLOCK A TAKE. Clicking an empty pad to aim the
    // record button materialises an EMPTY note clip as a placeholder, so
    // refusing on `kind === 'note'` would refuse the very slot the player just
    // selected. An empty placeholder is recorded over; a clip with notes in it
    // is someone's work and is refused instead of silently replaced.
    if (noteClipHasContent(readClip(data, clipIndex(slot, lane)))) {
      this.#refuse(
        entry,
        `lane ${lane + 1} slot ${slot + 1} holds a note clip with notes in it — clear it or pick another slot`,
      );
      return false;
    }
    // ⚠ ARMING NO LONGER STARTS THE TRANSPORT (clause 4). It used to
    // (`if (!clock.running) startTransport()`), the Bitwig/Deluge "arm means
    // go" model. The owner ruled the opposite: the toggle can be set while
    // paused or stopped and recording begins WHEN IT PLAYS. Starting the
    // transport here would make that impossible to express — every arm would
    // also be a play.

    const rateIdx = laneRateIndex(data, lane);
    const laneDur = laneStepDur(clock.baseStepDur, rateIdx);
    // "One loop": the reference bar re-expressed in THIS lane's steps when
    // something is playing; one default bar (16 steps at the lane's own rate)
    // on an empty groove. Latched at the EDGE — the tempo latch (edge 3).
    let lengthSteps = DEFAULT_CLIP_STEPS;
    if (clock.refSeconds !== null && clock.refSeconds > 0 && laneDur > 0) {
      lengthSteps = Math.max(1, Math.round(clock.refSeconds / laneDur));
    }
    const unitFrames = clipRecUnitFrames(lengthSteps, clock.baseStepDur, rateIdx, ctx.sampleRate);

    // ⚠ CLAUSE 8 — THE TAP IS FIXED AT BOARD IN, AND THE POSTMIX SEAM IS NAMED
    // BUT NOT BUILT. "Capture source, for now: the pre-mixmstrs input that
    // corresponds to the lane… we will add a toggle later for postmix." The
    // owner asked for the seam to be left named, not implemented, so there is
    // deliberately no control that moves this.
    //
    // The SELECTION MACHINERY IS INTACT and costs nothing to keep: `recTaps`
    // still publishes all three rosters, `mixmstrsRecTapPair` still picks one,
    // and `#ensureWiring` still takes a tap index. The postmix toggle is
    // therefore a value change here plus a control, not a re-wire — which is
    // the whole point of leaving a seam rather than hard-coding the node.
    //
    // The re-wire guard the old tap latch carried (a mid-take re-wire is a
    // splice on ANOTHER lane's take) is not needed while the tap cannot move,
    // and must come back with the toggle. `CLIP_REC_BOARD_IN_TAP` is what that
    // toggle will replace.
    if (entry.wiringTap !== CLIP_REC_BOARD_IN_TAP) {
      this.#teardownWiring(entry);
      this.#ensureWiring(entry, engine, ctx, mixNode, CLIP_REC_BOARD_IN_TAP);
    }

    const st = entry.lanes[lane]!;
    st.takeSeq++;
    st.preparing = true;
    st.prepared = false;
    st.clipNodeId = clipNode.id;
    st.slot = slot;
    st.lengthSteps = lengthSteps;
    st.unitFrames = unitFrames;
    st.tap = entry.wiringTap;
    st.sampleRate = ctx.sampleRate;
    st.doneFrames = null;
    st.armStartFrame = null;
    st.doneStartFrame = null;
    st.doneWait = new Promise<void>((res) => {
      st.doneResolve = res;
    });
    this.#refusals.delete(entry.nodeId);
    this.#writePrepArmed(entry, lane);
    void this.#openTake(entry, lane, st.takeSeq);
    this.#version++;
    return true;
  }

  /** Step two, async — the media open: manifest FIRST (the crash model), then
   *  the writer worker, guarded by the take's seq so a cancel mid-open can
   *  only ever discard this open, never install into a newer take. */
  async #openTake(entry: Entry, lane: number, seq: number): Promise<void> {
    const st = entry.lanes[lane]!;
    const mediaId = newClipMediaId();
    try {
      // The wiring is normally pre-built at graph sync; an arm racing the very
      // first build waits for it (an arm message sent to no worklet would be a
      // take that looks armed and captures nothing).
      if (!entry.wiring && entry.wiringBuild) await entry.wiringBuild;
      if (!entry.wiring) throw new Error('the recorder worklet is unavailable on this context');
      const manifest: ClipMediaManifest = {
        mediaId,
        nodeId: st.clipNodeId ?? '',
        lane,
        slot: st.slot,
        startedAt: this.#deps.now(),
        status: 'recording',
        format: 'pcm-f32',
        sampleRate: st.sampleRate,
        channels: 2,
        frames: 0,
        unitFrames: st.unitFrames,
        lengthSteps: st.lengthSteps,
      };
      const writer = await this.#deps.beginTake(manifest);
      if (entry.lanes[lane] !== st || st.takeSeq !== seq) {
        // Cancelled while the media opened — the open discards itself.
        void writer.close().then(() => this.#deps.removeMedia(mediaId));
        return;
      }
      st.mediaId = mediaId;
      st.writer = writer;
      st.drain = new ClipMediaDrain(writer, { bytesPerFrame: CLIP_RECORDER_BYTES_PER_FRAME });
      st.preparing = false;
      st.prepared = true; // the next pump confirms the arm
      this.#version++;
    } catch (err) {
      if (entry.lanes[lane] === st && st.takeSeq === seq) {
        st.preparing = false;
        st.prepared = false;
        clearTake(st);
        this.#refuse(
          entry,
          `could not open a take: ${err instanceof Error ? err.message : String(err)}`,
        );
        this.#snapArmOff(entry, lane);
        this.#writeAudioRec(entry, lane); // machine is idle → clears the projection
      }
    }
  }

  /** Step three — the media is open: resolve the window from the clock AS OF
   *  NOW and dispatch `arm`. The `armWorklet` effect then posts to a worklet
   *  that provably exists, with a drain that provably exists, so a chunk can
   *  never be dropped for want of either. A reference-bar boundary too close
   *  to make reliably SLIPS one bar to the next wrap — a take that starts one
   *  bar later is a take; one that misses its own first samples is not. */
  #confirmArm(
    entry: Entry,
    lane: number,
    ctx: BaseAudioContext,
    clock: RecClock | undefined,
    mode: ClipRecMode,
  ): void {
    const st = entry.lanes[lane]!;
    st.prepared = false;
    const now = ctx.currentTime;
    let boundaryTime: number;
    if (clock && clock.running && clock.boundary !== null && clock.boundary > now) {
      boundaryTime = clock.boundary;
      if (
        boundaryTime - now < CLIP_REC_MIN_BOUNDARY_LEAD_S &&
        clock.refSeconds !== null &&
        clock.refSeconds > 0
      ) {
        boundaryTime += clock.refSeconds; // slip to the NEXT wrap
      }
    } else {
      boundaryTime = now + CLIP_REC_ARM_LEAD_S;
    }
    const startFrame = clipRecStartFrame(boundaryTime, ctx.sampleRate);
    const window: RecordingWindow = { startFrame, stopFrame: null, unitFrames: st.unitFrames };
    // ⚠ THE MODE IS THE LANE'S SWITCH (clause 5), NOT A HARDCODED 'single'.
    // The machine normalizes the window for it: CLIP ('single') resolves a
    // stopFrame of anchor + one unit, ENDLESS leaves it open until the toggle
    // is tapped again or the transport stops.
    this.#dispatch(entry, lane, { type: 'arm', mode, window });
  }

  /** Cancel a take that is still PREPARING/PREPARED (the machine never armed):
   *  invalidate the in-flight open, free whatever media exists, clear the
   *  armed projection. Nothing was captured, so nothing is kept. */
  #cancelPrep(entry: Entry, lane: number): void {
    const st = entry.lanes[lane]!;
    st.takeSeq++;
    st.preparing = false;
    st.prepared = false;
    const { mediaId, writer } = st;
    clearTake(st);
    if (writer) {
      void writer.close().then(() => (mediaId ? this.#deps.removeMedia(mediaId) : undefined));
    } else if (mediaId) {
      void this.#deps.removeMedia(mediaId);
    }
    this.#writeAudioRec(entry, lane); // machine is idle → clears the projection
    this.#version++;
  }

  // -------------------------------------------------------------------------
  // The machine + its effects
  // -------------------------------------------------------------------------

  #dispatch(entry: Entry, lane: number, event: ClipRecEvent): void {
    const st = entry.lanes[lane]!;
    const before = st.machine.phase;
    const r = clipRecTransition(st.machine, event);
    st.machine = r.state;
    for (const eff of r.effects) this.#spend(entry, lane, eff);
    if (st.machine.phase !== before) {
      this.#writeAudioRec(entry, lane);
      this.#version++;
    }
  }

  #spend(entry: Entry, lane: number, eff: ClipRecEffect): void {
    const st = entry.lanes[lane]!;
    switch (eff.kind) {
      case 'armWorklet':
        // The prepare/confirm split guarantees the wiring and the drain exist
        // by the time the machine arms — this is a plain postMessage.
        //
        // ⚠ Latch what we ASKED FOR. This is the last moment the requested
        // punch-in exists on this thread; from here the frame belongs to the
        // audio thread, which may have to slide it (clip-recorder.ts header)
        // if this message loses its race. `done` reports the start the take
        // actually got, and the difference is the only evidence of the slide.
        st.armStartFrame = eff.window.startFrame;
        if (entry.wiring) armClipRecorderLane(entry.wiring.node, lane, eff.window);
        break;
      case 'stopWorklet':
        if (entry.wiring) stopClipRecorderLane(entry.wiring.node, lane, eff.stopFrame);
        break;
      case 'cancelWorklet':
        if (entry.wiring) cancelClipRecorderLane(entry.wiring.node, lane);
        break;
      case 'discardScratch': {
        const { mediaId, writer } = st;
        clearTake(st);
        if (writer) {
          void writer.close().then(() => (mediaId ? this.#deps.removeMedia(mediaId) : undefined));
        } else if (mediaId) {
          void this.#deps.removeMedia(mediaId);
        }
        break;
      }
      case 'beginCommit':
        void this.#commit(entry, lane, eff.frames);
        break;
      case 'keepRecoverScratch': {
        // The failed-finalize path: bytes + 'recording' manifest stay on disk
        // as a recover candidate. Close the writer; free NOTHING.
        const { writer } = st;
        clearTake(st);
        if (writer) void writer.close();
        break;
      }
    }
  }

  /** THE COMMIT — one undo unit, clip record before manifest 'done'. */
  async #commit(entry: Entry, lane: number, frames: number): Promise<void> {
    const st = entry.lanes[lane]!;
    const { mediaId, writer, drain, clipNodeId } = st;
    try {
      if (!mediaId || !writer || !drain || !clipNodeId) {
        throw new Error('take has no open media (arm never completed)');
      }
      // The worklet's own frame count is the truth the metadata must match.
      if (st.doneFrames === null) {
        await Promise.race([
          st.doneWait ?? Promise.resolve(),
          new Promise<void>((res) => setTimeout(res, CLIP_REC_DONE_TIMEOUT_MS)),
        ]);
      }
      if (st.doneFrames === null) throw new Error('worklet never reported done');
      // How far the take's real punch-in slid from the one we asked for. The
      // audio thread absorbs a few quanta of message latency by sliding the
      // whole window (clip-recorder.ts header) — the LENGTH stays exact, so
      // the check below cannot fire for lateness any more, and this is the
      // only place the slide is visible at all. Report it rather than let a
      // loaded machine quietly move the downbeat.
      const slip =
        st.doneStartFrame !== null && st.armStartFrame !== null
          ? st.doneStartFrame - st.armStartFrame
          : null;
      if (slip !== null && slip > 0) {
        console.warn(
          `[clip-rec] lane ${lane + 1} punched in ${slip} frames late (arm reached the audio thread after its own start)`,
        );
      }
      // ⚠ SHORT IS A DEFECT; LONG IS BY DESIGN. This was a strict equality check
      // and it made the endless transport-stop path impossible: that path
      // resolves its stop at the LAST COMPLETED LOOP, which is in the PAST, so
      // the worklet has necessarily already captured past it and reports MORE
      // than the commit wants. Demanding equality turned every such take into a
      // failure. Truncating the surplus is exactly what `beginCommit` has
      // always documented ("truncating any surplus the worklet captured past a
      // transport-stop / cap boundary") — the promise simply was not kept.
      //
      // A SHORT take is still a hard failure, and that half must not be relaxed:
      // it is how a dead input, a dropped chunk and the worklet's own arm
      // REFUSAL (`frames: 0`) surface at all.
      if (st.doneFrames < frames) {
        // `frames: 0` is the worklet REFUSING an arm that drained further past
        // its punch-in than the slide may absorb — say which it was, because
        // "captured 0 frames" alone reads like a dead input.
        const why =
          st.doneFrames === 0 && slip !== null && slip > 0
            ? ` — arm drained ${slip} frames past its punch-in, beyond the slide bound`
            : '';
        throw new Error(`captured ${st.doneFrames} frames, window demanded ${frames}${why}`);
      }
      if (st.doneFrames > frames) {
        // The endless truncate. The scratch keeps the surplus bytes; the
        // manifest and the clip record both declare `frames`, so playback reads
        // a whole number of loops and the tail is never addressed. Named in the
        // log because a surplus on a SINGLE take would mean the window maths
        // moved, and that is worth seeing.
        console.info(
          `[clip-rec] lane ${lane + 1} truncating ${st.doneFrames - frames} surplus frames to a whole ${frames}-frame take`,
        );
      }
      await drain.flush();
      if (drain.error) throw drain.error instanceof Error ? drain.error : new Error(String(drain.error));
      if (drain.dropped !== 0) throw new Error(`drain dropped ${drain.dropped} chunks`);
      await writer.close();

      const node = patch.nodes[clipNodeId] as ModuleNode | undefined;
      if (!node) throw new Error('the clip launcher was deleted mid-take');
      const index = clipIndex(st.slot, lane);
      const existing = coerceClipRecord(
        ((node.data as ClipPlayerData | undefined)?.clips ?? {})[String(index)],
      );
      if (noteClipHasContent(existing)) {
        // The slot held nothing authored at arm; a peer wrote notes into it
        // since. A slot holds one kind, and silently destroying authored notes
        // is the worst outcome available — keep the take as a recover candidate.
        // (An EMPTY note placeholder is not content and is replaced, matching
        // the arm-time check.)
        throw new Error(`slot ${st.slot + 1} now holds a note clip with notes in it`);
      }
      const record: AudioClipRecord = {
        kind: 'audio',
        mediaId,
        lengthSteps: st.lengthSteps,
        frames,
        sampleRate: st.sampleRate,
        channels: 2,
        format: 'pcm-f32',
        takeAt: this.#deps.now(),
        loop: true,
        src: {
          nodeId: entry.nodeId,
          channel: lane + 1,
          tap: TAP_NAMES[st.tap] ?? 'board-in',
        },
      };
      clipUndoTransact(clipNodeId, () => {
        const d = (node.data ?? (node.data = {})) as ClipPlayerData;
        if (!d.clips) d.clips = {};
        d.clips[String(index)] = record;
      });
      // Only NOW is the take done: the clip that names it exists, so the GC's
      // live set covers it and the status flip cannot orphan it.
      await this.#deps.finishTake(mediaId, frames);

      // "Record a loop and hear it take over" — the second gesture the MON
      // design exists to remove. Transient launch (never undoable), immediate
      // (the take ended ON the boundary; NOW is that boundary plus the commit
      // latency, and waiting a whole reference bar would be worse).
      ydoc.transact(() => {
        const d = (node.data ?? (node.data = {})) as ClipPlayerData;
        const queued = laneArray<number | 'stop' | null>(d.queued, null);
        queued[lane] = st.slot;
        d.queued = queued;
        const qi = laneArray<boolean>(d.queuedImmediate, false);
        qi[lane] = true;
        d.queuedImmediate = qi;
      });

      clearTake(st);
      this.#snapArmOff(entry, lane);
      this.#dispatch(entry, lane, { type: 'commitOk' });
    } catch (err) {
      console.warn(`[clip-rec] commit failed on lane ${lane + 1}; scratch kept for recovery`, err);
      this.#refusals.set(entry.nodeId, `commit failed: ${err instanceof Error ? err.message : String(err)}`);
      this.#snapArmOff(entry, lane);
      this.#dispatch(entry, lane, { type: 'commitFail' });
    }
  }

  /** Drop a lane's RECORD TOGGLE after a take ends, so the control reads
   *  disarmed and the player must press it again for the next take. */
  #snapArmOff(entry: Entry, lane: number): void {
    this.#writeRecArm(entry, lane, false);
  }

  /** Write a lane's RECORD TOGGLE through the Y.Doc with a NON-TRACKED origin.
   *
   *  ⚠ THIS IS WHAT MAKES THE LEVEL-TRIGGERED ARM SAFE. `#pumpEntry` arms
   *  whenever (toggle AND running) and the lane is idle, which is what lets a
   *  toggle set while stopped record when the transport plays. The same level
   *  would re-arm forever the instant a take committed — so a take that ends
   *  drops the toggle itself, and the player has to press it again. That is
   *  also exactly the owner's CLIP semantics: one loop, then stop.
   *
   *  It replaced a `setNodeParam` write to the mixer's `ch{N}_rec` knob, which
   *  went away with the record band (2026-09-04). A programmatic snap must
   *  never join anyone's undo stack, hence the non-tracked origin — the same
   *  rule the automation arm and the transport start already follow. */
  #writeRecArm(entry: Entry, lane: number, on: boolean): void {
    const node = patch.nodes[entry.nodeId] as ModuleNode | undefined;
    if (!node) return;
    // ⚠ MUTATE IN PLACE — NEVER REBUILD A LIVE Y MAP. `node.data` is a Y.Doc
    // proxy: spreading it into a fresh object and reassigning re-inserts every
    // nested value that is ALREADY in the tree, which Yjs rejects outright
    // ("reassigning object that already occurs in the tree"). Writing the one
    // key that changed is both correct and what makes the write mergeable with
    // a peer toggling a DIFFERENT lane — the reason `recArm` is a per-key
    // record rather than an array in the first place.
    ydoc.transact(() => {
      if (!node.data) node.data = {};
      const d = node.data as ClipPlayerData;
      if (!d.recArm) d.recArm = {};
      // ⚠ WRITE `false`, NEVER `delete`. `node.data` is a Y.Doc proxy whose
      // deleteProperty trap refuses a nested key ("trap returned falsish"), and
      // the throw landed inside the COMMIT — so a take that had recorded
      // perfectly died while snapping its own toggle off. `laneRecArm` tests
      // `=== true`, so a stored `false` is exactly as disarmed as an absent key.
      d.recArm[String(lane)] = on;
    }, CLIP_REC_PARAM_ORIGIN);
    this.#version++;
  }

  // -------------------------------------------------------------------------
  // audioRec projection — what the pads paint
  // -------------------------------------------------------------------------

  /** The PREPARING projection: armed with `startFrame: null` — the exact
   *  "armed and not yet resolved" state AudioRecState declares. The pad shows
   *  rec-armed from the edge onward; the frames arrive at confirm. */
  #writePrepArmed(entry: Entry, lane: number): void {
    const st = entry.lanes[lane]!;
    const clipNodeId = st.clipNodeId;
    if (!clipNodeId) return;
    const node = patch.nodes[clipNodeId] as ModuleNode | undefined;
    if (!node) return;
    ydoc.transact(() => {
      const d = (node.data ?? (node.data = {})) as ClipPlayerData;
      if (!d.audioRec) d.audioRec = {};
      d.audioRec[String(lane)] = {
        lane,
        slot: st.slot,
        mode: 'single',
        phase: 'armed',
        startFrame: null,
        stopFrame: null,
        unitFrames: st.unitFrames,
        recorderId: ydoc.clientID,
      };
    });
  }

  #writeAudioRec(entry: Entry, lane: number): void {
    const st = entry.lanes[lane]!;
    const clipNodeId = st.clipNodeId;
    if (!clipNodeId) return;
    const node = patch.nodes[clipNodeId] as ModuleNode | undefined;
    if (!node) return;
    const m = st.machine;
    const phase =
      m.phase === 'armed' || m.phase === 'recording' || m.phase === 'stopping' ? m.phase : null;
    ydoc.transact(() => {
      const d = (node.data ?? (node.data = {})) as ClipPlayerData;
      if (!d.audioRec) d.audioRec = {};
      d.audioRec[String(lane)] =
        phase === null
          ? null
          : {
              lane,
              slot: st.slot,
              mode: m.phase === 'idle' || m.phase === 'committing' ? 'single' : m.mode,
              phase,
              startFrame: m.phase === 'idle' ? null : m.window.startFrame,
              stopFrame: m.phase === 'idle' ? null : m.window.stopFrame,
              unitFrames: m.phase === 'idle' ? 0 : m.window.unitFrames,
              recorderId: ydoc.clientID,
            };
    });
  }

  // -------------------------------------------------------------------------
  // Wiring + teardown
  // -------------------------------------------------------------------------

  #ensureWiring(
    entry: Entry,
    engine: ClipRecEngineLike,
    ctx: BaseAudioContext,
    mixNode: ModuleNode,
    tap: number,
  ): void {
    const taps = engine.read(mixNode, 'recTaps') as MixmstrsRecTaps | undefined;
    if (!taps) return;
    if (entry.wiring && entry.tapsRef === taps && entry.wiringTap === tap) return;
    if (entry.wiringBuild) return; // one build in flight
    if (entry.wiring) this.#teardownWiring(entry);
    entry.wiringBuild = this.#deps
      .ensureWorklet(ctx)
      .then(() => {
        entry.wiringBuild = null;
        // ⚠ RE-RESOLVE THE MIXER, NOT `entry.nodeId`. The entry is keyed on the
        // CLIPPLAYER now (2026-09-04); the taps come from the MIXER. This used
        // to read `patch.nodes[entry.nodeId]` because those were the same node,
        // and left that way it asks a launcher for a tap roster it does not
        // publish — the wiring then never builds and every arm refuses with
        // "the recorder worklet is unavailable".
        //
        // Re-read rather than reuse the `mixNode` above: the roster may have
        // changed while the module registered, which is the whole reason this
        // re-read exists.
        const liveMix = firstOfType(patch.nodes, 'mixmstrs');
        if (!liveMix) return;
        const liveTaps = engine.read(liveMix, 'recTaps') as MixmstrsRecTaps | undefined;
        if (!liveTaps) return;
        entry.wiring = this.#deps.wire(ctx, liveTaps, tap, {
          id: liveMix.id,
          type: 'mixmstrs',
        });
        entry.wiringTap = tap;
        entry.tapsRef = liveTaps;
        attachClipRecorderSink(entry.wiring.node, {
          drainFor: (lane) => entry.lanes[lane]?.drain ?? null,
          onDone: (lane, frames, startFrame) => {
            const st = entry.lanes[lane];
            if (!st) return;
            st.doneFrames = frames;
            st.doneStartFrame = startFrame;
            st.doneResolve?.();
          },
        });
      })
      .catch((err) => {
        entry.wiringBuild = null;
        console.warn('[clip-rec] recorder worklet unavailable', err);
      });
  }

  #teardownWiring(entry: Entry): void {
    if (entry.wiring) {
      try {
        disconnectClipRecorderWiring(entry.wiring);
      } catch {
        /* nodes already gone */
      }
      entry.wiring = null;
    }
    entry.tapsRef = null;
  }

  /** Abandon a swept node's takes: cancel the worklet lanes, close writers,
   *  KEEP scratch + manifests of LIVE takes (recover candidates — the §4.4
   *  sweep row), clear the pads' arm projection. A take still PREPARING is
   *  discarded outright — nothing was captured, so a kept scratch would be a
   *  zero-byte recover candidate the GC could never free. */
  #abandon(entry: Entry): void {
    for (let lane = 0; lane < CLIP_LANES; lane++) {
      const st = entry.lanes[lane]!;
      if (st.preparing || st.prepared) {
        this.#cancelPrep(entry, lane);
        continue;
      }
      if (st.machine.phase === 'idle') continue;
      if (entry.wiring) cancelClipRecorderLane(entry.wiring.node, lane);
      const { writer } = st;
      st.machine = CLIP_REC_IDLE;
      this.#writeAudioRec(entry, lane);
      clearTake(st);
      if (writer) void writer.close();
    }
    this.#teardownWiring(entry);
  }
}

function clearTake(st: LaneRec): void {
  st.preparing = false;
  st.prepared = false;
  st.mediaId = null;
  st.writer = null;
  st.drain = null;
  st.doneFrames = null;
  st.armStartFrame = null;
  st.doneStartFrame = null;
  st.doneWait = null;
  st.doneResolve = null;
}

function firstOfType(
  nodes: Record<string, unknown>,
  type: string,
): ModuleNode | undefined {
  for (const n of Object.values(nodes)) {
    if (n && (n as { type?: string }).type === type) return n as ModuleNode;
  }
  return undefined;
}

/** The lane's first empty slot (full stride — scenes past the visible 8 are
 *  real slots), or null when all 64 hold clips. */
export function firstEmptySlot(data: ClipPlayerData | undefined, lane: number): number | null {
  for (let slot = 0; slot < SCENE_STRIDE; slot++) {
    if (!readClip(data, clipIndex(slot, lane))) return slot;
  }
  return null;
}

/** Normalize a per-lane array for a transient write (SyncedStore arrays
 *  reject index assignment on foreign shapes — rebuild-and-reassign). */
function laneArray<T>(raw: unknown, fill: T): T[] {
  const out = new Array<T>(CLIP_LANES).fill(fill);
  if (Array.isArray(raw)) {
    for (let i = 0; i < CLIP_LANES; i++) if (i < raw.length) out[i] = raw[i] as T;
  }
  return out;
}

/** Transaction origin for the registry's programmatic param writes (the arm
 *  snap-off, the transport auto-start). NOT LOCAL_ORIGIN: neither belongs on
 *  the user's Cmd-Z stack. */
const CLIP_REC_PARAM_ORIGIN = Symbol('clip-rec-param');

/** Start TIMELORDE (arm auto-start — Bitwig/Deluge, and keysQueueRec's rule).
 *  Through the mutation seam, non-undoable. */
function startTransport(): void {
  const t = firstOfType(patch.nodes, 'timelorde');
  if (!t) return; // no TIMELORDE = free-run; nothing to start
  setNodeParam(t.id, 'running', 1, { origin: CLIP_REC_PARAM_ORIGIN });
}

/** The app-wide registry. */
export const nodeClipRecorder = new NodeClipRecorderRegistry();
