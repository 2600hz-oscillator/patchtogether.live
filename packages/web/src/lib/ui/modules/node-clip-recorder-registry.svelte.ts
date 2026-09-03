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
// ⚠ THE ARM IS A PARAM, NOT A BUTTON. `ch{N}_rec` (slice 3's record band) is
// the surface: this registry POLLS the mixer's effective (knob + CV) values
// through `read('recState')` and drives the pure machine
// (clip-audio-rec-machine.ts) from edges on them. Level semantics:
//   - 0 → 1 edge while idle  = ARM SINGLE (this slice; 2/endless is slice 6,
//     and reads as "not 1" here — arming stays un-actioned until it lands);
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
import {
  CLIP_LANES,
  DEFAULT_CLIP_STEPS,
  SCENE_STRIDE,
  clipIndex,
  coerceClipRecord,
  readClip,
  audioRecState,
  type AudioClipRecord,
  type ClipPlayerData,
  type ClipRecordTap,
} from '$lib/audio/modules/clip-types';
import { laneRateIndex, laneStepDur } from '$lib/audio/modules/clip-clock';

/** How far ahead of "now" a take punches in when NOTHING is playing (no
 *  reference bar to wait for). Covers the manifest write + the arm message's
 *  trip to the audio thread; the worklet wiring itself is pre-built at graph
 *  sync, not at arm. */
export const CLIP_REC_ARM_LEAD_S = 0.12;

/** How long the commit waits for the worklet's `done` after the machine saw
 *  the stop frame pass. The worklet finishes inside the stop frame's own
 *  quantum; this bound only covers MessagePort delivery under load. */
export const CLIP_REC_DONE_TIMEOUT_MS = 3000;

const TAP_NAMES: readonly ClipRecordTap[] = ['board-in', 'post-fader', 'master'];

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
 *  the take fields exist only between arm and commit/discard. */
interface LaneRec {
  machine: ClipRecState;
  /** The clipplayer node the take commits to — latched at arm. */
  clipNodeId: string | null;
  slot: number;
  lengthSteps: number;
  tap: number;
  sampleRate: number;
  mediaId: string | null;
  writer: ClipMediaWriter | null;
  drain: ClipMediaDrain | null;
  doneFrames: number | null;
  doneWait: Promise<void> | null;
  doneResolve: (() => void) | null;
}

function freshLane(): LaneRec {
  return {
    machine: CLIP_REC_IDLE,
    clipNodeId: null,
    slot: 0,
    lengthSteps: DEFAULT_CLIP_STEPS,
    tap: 0,
    sampleRate: 48000,
    mediaId: null,
    writer: null,
    drain: null,
    doneFrames: null,
    doneWait: null,
    doneResolve: null,
  };
}

interface Entry {
  nodeId: string;
  lanes: LaneRec[];
  /** Effective arm values last seen — null until the first read ADOPTS the
   *  loaded state without firing (a loaded patch never replays a gesture). */
  prevArm: number[] | null;
  wiring: ClipRecorderWiring | null;
  wiringTap: number;
  /** Identity of the taps roster the wiring was built from — a rebuilt mixer
   *  factory hands back a new object, and stale wiring points at dead nodes. */
  tapsRef: unknown;
  wiringBuild: Promise<void> | null;
}

export interface ClipRecLaneView {
  phase: ClipRecState['phase'];
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
    return e.lanes.map((l) => ({ phase: l.machine.phase, slot: l.slot, mediaId: l.mediaId }));
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
    const mixIds = new Set<string>();
    for (const n of liveNodes) if (n?.type === 'mixmstrs') mixIds.add(n.id);
    let changed = false;
    for (const id of mixIds) {
      if (this.#entries.has(id)) continue;
      this.#entries.set(id, {
        nodeId: id,
        lanes: Array.from({ length: CLIP_LANES }, freshLane),
        prevArm: null,
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
    const mixNode = patch.nodes[entry.nodeId] as ModuleNode | undefined;
    if (!mixNode) return;
    const rec = engine.read(mixNode, 'recState') as MixRecState | undefined;
    if (!rec || !Array.isArray(rec.arm)) return;

    // Keep the worklet wiring fresh against the LIVE taps roster (a rebuilt
    // mixer factory publishes a new one and the old nodes are dead).
    this.#ensureWiring(entry, engine, ctx, mixNode, entry.wiringTap);

    const clipNode = firstOfType(patch.nodes, 'clipplayer');
    const clock = clipNode
      ? (engine.read(clipNode, 'recClock') as RecClock | undefined)
      : undefined;
    const frame = Math.floor(ctx.currentTime * ctx.sampleRate);

    const adopt = entry.prevArm === null;
    const prev = entry.prevArm ?? rec.arm.slice();
    entry.prevArm = rec.arm.slice();

    // The transport gate for THIS tick. An arm that auto-starts the transport
    // flips it here too, or the very same pass would read the pre-start clock
    // and discard the take it just armed.
    let running = clock ? clock.running : true;

    for (let lane = 0; lane < CLIP_LANES; lane++) {
      const armNow = rec.arm[lane] ?? 0;
      const armPrev = prev[lane] ?? 0;
      const st = entry.lanes[lane]!;

      if (!adopt) {
        // ARM edge: 0→1 while idle = arm single. (2 = endless, slice 6 — an
        // edge onto 2 is deliberately un-actioned here.)
        if (armNow === 1 && armPrev !== 1 && st.machine.phase === 'idle') {
          if (this.#tryArm(entry, lane, engine, ctx, mixNode, clipNode, clock, rec.tap)) {
            running = true;
          }
        } else if (
          armNow === 0 &&
          armPrev !== 0 &&
          (st.machine.phase === 'armed' ||
            st.machine.phase === 'recording' ||
            st.machine.phase === 'stopping')
        ) {
          // The arm dropped to OFF — CANCEL, the escape. Nothing commits.
          this.#dispatch(entry, lane, { type: 'cancel' });
        }
      }

      // The transport stopping mid-take discards a single take (its contract
      // is exactly one loop; a partial is not a shorter version of it).
      if (clock && !running && st.machine.phase !== 'idle') {
        this.#dispatch(entry, lane, { type: 'transportStop', frame });
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

  /** Returns true when the lane ARMED (the transport is then running — either
   *  it already was, or the arm just started it). */
  #tryArm(
    entry: Entry,
    lane: number,
    engine: ClipRecEngineLike,
    ctx: BaseAudioContext,
    mixNode: ModuleNode,
    clipNode: ModuleNode | undefined,
    clock: RecClock | undefined,
    tap: number,
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
    const slot = firstEmptySlot(data, lane);
    if (slot === null) {
      this.#refuse(entry, `lane ${lane + 1} has no empty slot (all ${SCENE_STRIDE} are full)`);
      return false;
    }
    // Auto-start the transport (Bitwig/Deluge, and what keysQueueRec already
    // does): arming with the rack stopped means "start it".
    if (!clock.running) startTransport();

    const rateIdx = laneRateIndex(data, lane);
    const laneDur = laneStepDur(clock.baseStepDur, rateIdx);
    // "One loop": the reference bar re-expressed in THIS lane's steps when
    // something is playing; one default bar (16 steps at the lane's own rate)
    // on an empty groove.
    let lengthSteps = DEFAULT_CLIP_STEPS;
    if (clock.refSeconds !== null && clock.refSeconds > 0 && laneDur > 0) {
      lengthSteps = Math.max(1, Math.round(clock.refSeconds / laneDur));
    }
    const unitFrames = clipRecUnitFrames(lengthSteps, clock.baseStepDur, rateIdx, ctx.sampleRate);
    const boundaryTime =
      clock.running && clock.boundary !== null && clock.boundary > ctx.currentTime
        ? clock.boundary
        : ctx.currentTime + CLIP_REC_ARM_LEAD_S;
    const startFrame = clipRecStartFrame(boundaryTime, ctx.sampleRate);
    const window: RecordingWindow = { startFrame, stopFrame: null, unitFrames };

    // Latch the tap for this take. A different tap re-wires only while no
    // other lane records (mid-take re-wire is a splice on THEIR take).
    const anyLive = entry.lanes.some((l) => l.machine.phase !== 'idle');
    const wantTap = Math.max(0, Math.min(2, Math.round(tap)));
    if (!anyLive && wantTap !== entry.wiringTap) {
      this.#teardownWiring(entry);
      this.#ensureWiring(entry, engine, ctx, mixNode, wantTap);
    }

    const st = entry.lanes[lane]!;
    st.clipNodeId = clipNode.id;
    st.slot = slot;
    st.lengthSteps = lengthSteps;
    st.tap = entry.wiringTap;
    st.sampleRate = ctx.sampleRate;
    st.doneFrames = null;
    st.doneWait = new Promise<void>((res) => {
      st.doneResolve = res;
    });
    this.#refusals.delete(entry.nodeId);
    this.#dispatch(entry, lane, { type: 'arm', mode: 'single', window });
    return true;
  }

  /** Spend the machine's `armWorklet` effect: manifest FIRST (the crash
   *  model), then the drain, then the arm message. Async — the lead time /
   *  boundary distance covers it; a failure cancels the take. */
  async #beginTake(entry: Entry, lane: number, window: RecordingWindow): Promise<void> {
    const st = entry.lanes[lane]!;
    const mediaId = newClipMediaId();
    try {
      // The wiring is normally pre-built at graph sync; an arm racing the very
      // first build waits for it (an arm message sent to no worklet would be a
      // take that looks armed and captures nothing).
      if (!entry.wiring && entry.wiringBuild) await entry.wiringBuild;
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
        unitFrames: window.unitFrames,
        lengthSteps: st.lengthSteps,
      };
      const writer = await this.#deps.beginTake(manifest);
      // The machine may have moved on while the manifest wrote (cancel,
      // transport stop). A take that no longer exists closes its writer and
      // frees the scratch instead of arming.
      if (entry.lanes[lane] !== st || st.machine.phase !== 'armed') {
        void writer.close().then(() => this.#deps.removeMedia(mediaId));
        return;
      }
      st.mediaId = mediaId;
      st.writer = writer;
      st.drain = new ClipMediaDrain(writer, { bytesPerFrame: CLIP_RECORDER_BYTES_PER_FRAME });
      if (entry.wiring) armClipRecorderLane(entry.wiring.node, lane, window);
      this.#version++;
    } catch (err) {
      console.warn('[clip-rec] failed to open a take', err);
      this.#dispatch(entry, lane, { type: 'cancel' });
    }
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
        void this.#beginTake(entry, lane, eff.window);
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
      if (st.doneFrames !== frames) {
        throw new Error(`captured ${st.doneFrames} frames, window demanded ${frames}`);
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
      if (existing && existing.kind === 'note') {
        // The slot was empty at arm; a peer authored notes into it since. A
        // slot holds one kind, and silently destroying authored notes is the
        // worst outcome available — keep the take as a recover candidate.
        throw new Error(`slot ${st.slot + 1} now holds a note clip`);
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

  /** Snap the arm knob back to OFF after a take ends, so the control reads
   *  disarmed and a fresh 0→1 edge is required for the next take. Through the
   *  mutation seam with a NON-TRACKED origin — a programmatic knob snap must
   *  never join anyone's undo stack. */
  #snapArmOff(entry: Entry, lane: number): void {
    setNodeParam(entry.nodeId, `ch${lane + 1}_rec`, 0, { origin: CLIP_REC_PARAM_ORIGIN });
    if (entry.prevArm) entry.prevArm[lane] = 0;
  }

  // -------------------------------------------------------------------------
  // audioRec projection — what the pads paint
  // -------------------------------------------------------------------------

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
        // Re-read: the roster may have changed while the module registered.
        const liveNode = patch.nodes[entry.nodeId] as ModuleNode | undefined;
        if (!liveNode) return;
        const liveTaps = engine.read(liveNode, 'recTaps') as MixmstrsRecTaps | undefined;
        if (!liveTaps) return;
        entry.wiring = this.#deps.wire(ctx, liveTaps, tap, {
          id: entry.nodeId,
          type: 'mixmstrs',
        });
        entry.wiringTap = tap;
        entry.tapsRef = liveTaps;
        attachClipRecorderSink(entry.wiring.node, {
          drainFor: (lane) => entry.lanes[lane]?.drain ?? null,
          onDone: (lane, frames) => {
            const st = entry.lanes[lane];
            if (!st) return;
            st.doneFrames = frames;
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
   *  KEEP scratch + manifests (recover candidates — the §4.4 sweep row),
   *  clear the pads' arm projection. */
  #abandon(entry: Entry): void {
    for (let lane = 0; lane < CLIP_LANES; lane++) {
      const st = entry.lanes[lane]!;
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
  st.mediaId = null;
  st.writer = null;
  st.drain = null;
  st.doneFrames = null;
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
