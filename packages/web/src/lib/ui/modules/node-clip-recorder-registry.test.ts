// node-clip-recorder-registry.test.ts
//
// Slice 5 — ARM-SINGLE end to end at the REGISTRY level: the lifetime rules
// (#1574: a take belongs to the NODE — there is no card method to end one),
// and the TRANSACTIONAL COMMIT PAIRING (take completes → the AudioClipRecord
// lands in clips[k] as ONE undo unit AND the media finalizes; a failed
// finalize writes NO clip record and KEEPS the scratch for recovery).
//
// Everything drives through the injected seams — no worklet, no OPFS, no
// AudioContext — but the Y.Doc store, the undo stack, the machine and the
// drain are all REAL, because they are the subject: the commit's atomicity is
// a property of how this registry sequences them.
//
// POSITIVE CONTROLS: every negative leg here (failed finalize, frame
// mismatch, foreign lease, adopt-without-firing) sits next to the green path
// driven by the same harness, so a harness that cannot reach commit at all
// cannot silently pass the refusal legs.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  NodeClipRecorderRegistry,
  firstEmptySlot,
  CLIP_REC_ARM_LEAD_S,
  type ClipRecRegistryDeps,
} from './node-clip-recorder-registry.svelte';
import { patch, ydoc } from '$lib/graph/store';
import { clipUndo, __test_resetClipUndo } from '$lib/control/clip-undo';
import { referencedClipMediaIds } from '$lib/audio/clip-media-store';
import {
  audioRecState,
  clipIndex,
  clipPadState,
  readClip,
  type ClipPlayerData,
} from '$lib/audio/modules/clip-types';
import type { ClipMediaManifest, ClipMediaWriter } from '$lib/audio/clip-media-store';
import type { ClipRecorderWiring } from '$lib/audio/modules/clip-recorder-node';

const MIX = 'mx1';
const CLIP = 'cp1';
const TL = 'tl1';
const SR = 48000;
/** 120 bpm, stepDiv 1/16 → baseStepDur 0.125 s; default lane rate ×1;
 *  DEFAULT_CLIP_STEPS 16 → one bar = 2 s = 96 000 frames. */
const UNIT_FRAMES = 96000;

function clearPatch() {
  for (const k of Object.keys(patch.nodes)) delete patch.nodes[k];
  for (const k of Object.keys(patch.edges)) delete patch.edges[k];
}

function seedGraph() {
  clearPatch();
  patch.nodes[MIX] = {
    id: MIX,
    type: 'mixmstrs',
    domain: 'audio',
    position: { x: 0, y: 0 },
    params: {},
  } as never;
  patch.nodes[CLIP] = {
    id: CLIP,
    type: 'clipplayer',
    domain: 'audio',
    position: { x: 0, y: 0 },
    params: {},
    data: {},
  } as never;
  patch.nodes[TL] = {
    id: TL,
    type: 'timelorde',
    domain: 'audio',
    position: { x: 0, y: 0 },
    params: { running: 1, bpm: 120 },
  } as never;
}

const liveNodes = () => Object.values(patch.nodes) as { id: string; type?: string }[];
const clipData = () => patch.nodes[CLIP]!.data as ClipPlayerData;

interface Harness {
  reg: NodeClipRecorderRegistry;
  ctx: { currentTime: number; sampleRate: number };
  recState: { arm: number[]; tap: number; quality: number };
  recClock: { running: boolean; baseStepDur: number; boundary: number | null; refSeconds: number | null };
  posted: Record<string, unknown>[];
  port: { postMessage: (m: unknown) => void; onmessage: ((e: MessageEvent) => void) | null };
  manifests: ClipMediaManifest[];
  finished: { id: string; frames: number; clipAlreadyNamed: boolean }[];
  removed: string[];
  writes: { position: number; bytes: number }[];
  writerClose: ReturnType<typeof vi.fn>;
  setFailWrites(v: boolean): void;
  /** Hold every media open until released — the contended-host simulation
   *  (the CI shard where an IDB open outran the punch-in). */
  gateOpens(): void;
  releaseOpens(): void;
}

function makeHarness(): Harness {
  const ctx = { currentTime: 0, sampleRate: SR };
  const recState = { arm: [0, 0, 0, 0, 0, 0, 0, 0], tap: 0, quality: 0 };
  const recClock = {
    running: true,
    baseStepDur: 0.125,
    boundary: null as number | null,
    refSeconds: null as number | null,
  };
  const taps = { board: [], postFader: [], master: [{}, {}] };
  const posted: Record<string, unknown>[] = [];
  const port: Harness['port'] = { postMessage: (m) => posted.push(m as Record<string, unknown>), onmessage: null };
  const wiring = { node: { port }, mergers: [], keepAlive: {} } as unknown as ClipRecorderWiring;
  const manifests: ClipMediaManifest[] = [];
  const finished: Harness['finished'] = [];
  const removed: string[] = [];
  const writes: { position: number; bytes: number }[] = [];
  let failWrites = false;
  const writerClose = vi.fn(async () => {});
  const makeWriter = (mediaId: string): ClipMediaWriter => ({
    mediaId,
    async write(bytes, position) {
      if (failWrites) throw new Error('disk full');
      writes.push({ position, bytes: bytes.byteLength });
    },
    close: writerClose,
  });
  let openGate: Promise<void> | null = null;
  let openRelease: (() => void) | null = null;
  const deps: ClipRecRegistryDeps = {
    engine: () => ({
      read: (node, key) => {
        if (node.id === MIX && key === 'recState') return recState;
        if (node.id === MIX && key === 'recTaps') return taps;
        if (node.id === CLIP && key === 'recClock') return recClock;
        return undefined;
      },
    }),
    audioCtx: () => ctx as unknown as BaseAudioContext,
    startTicker: () => () => {},
    ensureWorklet: async () => {},
    wire: () => wiring,
    hasStore: () => true,
    beginTake: async (m) => {
      if (openGate) await openGate;
      manifests.push({ ...m });
      return makeWriter(m.mediaId);
    },
    finishTake: async (id, frames) => {
      // Records whether the CLIP RECORD already existed at finalize time —
      // the ordering rule under test (record first, then 'done').
      const d = clipData();
      const named = referencedClipMediaIds(liveNodes() as never).has(id) && !!d;
      finished.push({ id, frames, clipAlreadyNamed: named });
    },
    removeMedia: async (id) => {
      removed.push(id);
    },
    now: () => 1_700_000_000_000,
  };
  const reg = new NodeClipRecorderRegistry(deps);
  return {
    reg,
    ctx,
    recState,
    recClock,
    posted,
    port,
    manifests,
    finished,
    removed,
    writes,
    writerClose,
    setFailWrites: (v) => {
      failWrites = v;
    },
    gateOpens: () => {
      openGate = new Promise<void>((r) => {
        openRelease = () => {
          openGate = null;
          r();
        };
      });
    },
    releaseOpens: () => openRelease?.(),
  };
}

/** Flush the registry's internal async chains (beginTake / commit). */
async function settle(times = 6) {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

/** Drive a full green single take on lane 0 and return its window. The arm is
 *  a two-step observable sequence: the edge PREPARES (async media open), the
 *  next pump CONFIRMS (resolves the window, arms machine + worklet).
 *
 *  `slipFrames` models a LATE arm: the worklet slid the window by that many
 *  frames and says so on `done`. The take is still exactly `frames` long — the
 *  length is the contract (clip-recorder.ts header) — so a slip must NOT
 *  change what commits, only what is reported. */
async function recordOneTake(h: Harness, slipFrames = 0) {
  h.reg.sync(liveNodes());
  h.reg.pump(); // builds wiring; adopts the (all-zero) arm state
  await settle();
  h.recState.arm[0] = 1;
  h.reg.pump(); // the arm edge → prepare
  await settle(); // the media open resolves
  h.reg.pump(); // confirm → the machine + worklet arm
  await settle();
  const armMsg = h.posted.find((m) => m.type === 'arm') as
    | { startFrame: number; stopFrame: number }
    | undefined;
  expect(armMsg, 'the worklet was armed').toBeTruthy();
  const { startFrame, stopFrame } = armMsg!;
  // Punch in…
  h.ctx.currentTime = startFrame / SR + 0.05;
  h.reg.pump();
  await settle();
  // …the worklet posts the take (one big chunk) and its done…
  const frames = stopFrame - startFrame;
  const data = new Float32Array(frames * 2);
  data.fill(0.25);
  h.port.onmessage?.({ data: { type: 'chunk', lane: 0, firstFrame: 0, frames, data } } as MessageEvent);
  h.port.onmessage?.({
    data: { type: 'done', lane: 0, frames, startFrame: startFrame + slipFrames },
  } as MessageEvent);
  // …and the stop frame passes.
  h.ctx.currentTime = stopFrame / SR + 0.05;
  h.reg.pump();
  await settle(12);
  return { startFrame, stopFrame, frames };
}

beforeEach(() => {
  seedGraph();
  __test_resetClipUndo();
});

describe('node-clip-recorder-registry — arm-single end to end', () => {
  it('arms as an OBSERVABLE SEQUENCE: edge → armed(startFrame null) → confirmed window → rec-active', async () => {
    const h = makeHarness();
    h.reg.sync(liveNodes());
    h.reg.pump();
    await settle();
    h.recState.arm[0] = 1;
    h.reg.pump(); // the edge — PREPARE
    // The pads read armed IMMEDIATELY, in the AudioRecState "not yet
    // resolved" shape (startFrame null) — no window exists yet, on purpose.
    const prep = audioRecState(clipData(), 0);
    expect(prep?.phase).toBe('armed');
    expect(prep?.startFrame).toBeNull();
    expect(clipPadState(clipData(), clipIndex(0, 0))).toBe('rec-armed');
    expect(h.posted.filter((m) => m.type === 'arm').length).toBe(0); // no worklet arm yet
    await settle(); // the media open resolves
    // The manifest was written BEFORE the worklet arm (crash model).
    expect(h.manifests.length).toBe(1);
    expect(h.manifests[0]!.unitFrames).toBe(UNIT_FRAMES);
    expect(h.manifests[0]!.status).toBe('recording');
    h.reg.pump(); // CONFIRM — the window resolves from the clock as of now
    const arm = h.posted.find((m) => m.type === 'arm') as {
      lane: number;
      startFrame: number;
      stopFrame: number;
    };
    expect(arm.lane).toBe(0);
    // Nothing playing → punch-in at now + lead, one default bar exactly.
    expect(arm.startFrame).toBe(Math.round(CLIP_REC_ARM_LEAD_S * SR));
    expect(arm.stopFrame - arm.startFrame).toBe(UNIT_FRAMES);
    // The projection now carries the resolved frames.
    expect(audioRecState(clipData(), 0)?.startFrame).toBe(arm.startFrame);
    // Punch-in flips the projection to rec-active.
    h.ctx.currentTime = arm.startFrame / SR + 0.01;
    h.reg.pump();
    expect(audioRecState(clipData(), 0)?.phase).toBe('recording');
    expect(clipPadState(clipData(), clipIndex(0, 0))).toBe('rec-active');
  });

  it('COLD-BOOT RACE (the CI shard): a media open slower than any lead still records a full take — the window is resolved AFTER the open', async () => {
    const h = makeHarness();
    h.reg.sync(liveNodes());
    h.reg.pump();
    await settle();
    h.gateOpens(); // the contended host: IDB/worker open stalls
    h.recState.arm[0] = 1;
    h.reg.pump(); // the edge — prepare starts, open hangs
    await settle();
    // A FULL SECOND passes — far beyond CLIP_REC_ARM_LEAD_S. Under the old
    // one-shot arm the window would already be in the past and the take dead
    // ("arm never completed"). Pumps during the stall must not punch in.
    h.ctx.currentTime = 1.0;
    h.reg.pump();
    h.reg.pump();
    expect(h.posted.filter((m) => m.type === 'arm').length).toBe(0);
    expect(h.reg.view(MIX)![0]!.preparing).toBe(true);
    expect(audioRecState(clipData(), 0)?.phase).toBe('armed'); // pad honest throughout
    h.releaseOpens();
    await settle();
    h.reg.pump(); // confirm — window from the POST-STALL clock
    await settle();
    const arm = h.posted.find((m) => m.type === 'arm') as {
      startFrame: number;
      stopFrame: number;
    };
    expect(arm, 'the take armed after the stall').toBeTruthy();
    expect(arm.startFrame).toBe(Math.round((1.0 + CLIP_REC_ARM_LEAD_S) * SR));
    expect(arm.stopFrame - arm.startFrame).toBe(UNIT_FRAMES);
    // …and the take completes to a committed clip of EXACTLY unitFrames.
    const frames = arm.stopFrame - arm.startFrame;
    h.ctx.currentTime = arm.startFrame / SR + 0.05;
    h.reg.pump();
    const data = new Float32Array(frames * 2);
    h.port.onmessage?.({ data: { type: 'chunk', lane: 0, firstFrame: 0, frames, data } } as MessageEvent);
    h.port.onmessage?.({
      data: { type: 'done', lane: 0, frames, startFrame: arm.startFrame },
    } as MessageEvent);
    h.ctx.currentTime = arm.stopFrame / SR + 0.05;
    h.reg.pump();
    await settle(12);
    const rec = readClip(clipData(), clipIndex(0, 0));
    expect(rec?.kind).toBe('audio');
    if (rec?.kind === 'audio') expect(rec.frames).toBe(UNIT_FRAMES);
    expect(h.reg.lastRefusal(MIX)).toBeNull();
  });

  it('CANCEL MID-PREPARE: the arm dropping while the media opens discards the open, arms nothing', async () => {
    const h = makeHarness();
    h.reg.sync(liveNodes());
    h.reg.pump();
    await settle();
    h.gateOpens();
    h.recState.arm[0] = 1;
    h.reg.pump(); // prepare, open hangs
    h.recState.arm[0] = 0;
    h.reg.pump(); // cancel mid-prepare
    expect(audioRecState(clipData(), 0)).toBeNull(); // pad cleared at once
    h.releaseOpens();
    await settle();
    h.reg.pump();
    await settle();
    // The stale open discarded itself: writer closed, media removed, no arm.
    expect(h.posted.filter((m) => m.type === 'arm').length).toBe(0);
    expect(h.writerClose).toHaveBeenCalled();
    expect(h.removed.length).toBe(1);
    expect(h.reg.view(MIX)![0]!.phase).toBe('idle');
  });

  it('a reference-bar boundary too close at confirm SLIPS one bar to the next wrap', async () => {
    const h = makeHarness();
    // The wrap is 20 ms away — inside the arm message's flight time. The
    // reference loop is 4 s, so the honest punch-in is the NEXT wrap.
    h.recClock.boundary = 0.02;
    h.recClock.refSeconds = 4;
    h.reg.sync(liveNodes());
    h.reg.pump();
    await settle();
    h.recState.arm[2] = 1;
    h.reg.pump();
    await settle();
    h.reg.pump(); // confirm
    const arm = h.posted.find((m) => m.type === 'arm') as { lane: number; startFrame: number };
    expect(arm.lane).toBe(2);
    expect(arm.startFrame).toBe(Math.round((0.02 + 4) * SR));
  });

  it('a loaded patch with the arm already ON is ADOPTED, never fired', async () => {
    const h = makeHarness();
    h.recState.arm[0] = 1; // saved that way
    h.reg.sync(liveNodes());
    h.reg.pump();
    await settle();
    expect(h.posted.filter((m) => m.type === 'arm').length).toBe(0);
    expect(h.reg.view(MIX)![0]!.phase).toBe('idle');
    // …and the SAME harness arms fine on a real edge (positive control).
    h.recState.arm[0] = 0;
    h.reg.pump();
    h.recState.arm[0] = 1;
    h.reg.pump(); // prepare
    await settle();
    h.reg.pump(); // confirm
    expect(h.posted.filter((m) => m.type === 'arm').length).toBe(1);
  });

  it('COMMIT is the transactional pairing: record in clips[k] as ONE undo unit, media finalized AFTER it, arm snapped off, take-over launch queued', async () => {
    const h = makeHarness();
    const { frames } = await recordOneTake(h);

    // The clip record landed, with the worklet's exact frame count.
    const rec = readClip(clipData(), clipIndex(0, 0));
    expect(rec?.kind).toBe('audio');
    if (rec?.kind !== 'audio') return;
    expect(rec.frames).toBe(frames);
    expect(rec.frames).toBe(UNIT_FRAMES); // recorded length == unitFrames exactly
    expect(rec.mediaId).toBe(h.manifests[0]!.mediaId);
    expect(rec.sampleRate).toBe(SR);
    expect(rec.src?.channel).toBe(1);
    expect(rec.src?.tap).toBe('board-in');
    // The bytes all reached the writer (one chunk, interleaved f32 stereo).
    expect(h.writes.reduce((a, w) => a + w.bytes, 0)).toBe(frames * 8);
    // Finalize ran AFTER the record write — the GC-orphan ordering rule.
    expect(h.finished).toEqual([
      { id: rec.mediaId, frames, clipAlreadyNamed: true },
    ]);
    // The machine is idle again; the pads read loaded/queued, not rec-*.
    expect(h.reg.view(MIX)![0]!.phase).toBe('idle');
    expect(audioRecState(clipData(), 0)).toBeNull();
    // "Hear it take over": the recorded slot is queued, immediately.
    expect(clipData().queued?.[0]).toBe(0);
    expect(clipData().queuedImmediate?.[0]).toBe(true);
    // ⚠ THE ARM IS CLOSED, AND THIS IS THE ASSERTION THAT ACTUALLY MATTERS.
    // It used to read the mixer knob snapping back to 0 (`ch1_rec`), which was
    // only ever a PROXY for the real property — and the knob went away with the
    // record band on 2026-09-04. The property itself is unchanged and is now
    // asserted directly: `recordOneTake` leaves the arm source HELD AT 1, and a
    // held arm must NOT start a second take. A regression here machine-guns
    // takes for as long as the control is held, which is exactly what the
    // edge-triggered design exists to prevent.
    const takesBefore = h.posted.filter((m) => m.type === 'arm').length;
    expect(h.recState.arm[0], 'the arm source is still HELD HIGH').toBe(1);
    // ⚠ DRIVE THE FULL ARM SEQUENCE, NOT ONE PUMP. Arming is prepare → media
    // open (async) → confirm, so a single pump cannot reach the worklet `arm`
    // post even when the edge DID fire — an assertion after one pump passes
    // whether or not the bug is present. This is the same pump/settle pair
    // `recordOneTake` uses to arm in the first place.
    h.reg.pump();
    await settle();
    h.reg.pump();
    await settle();
    expect(
      h.posted.filter((m) => m.type === 'arm').length,
      'a HELD arm re-armed the worklet — a fresh 0→1 edge must be required',
    ).toBe(takesBefore);
    expect(h.reg.view(MIX)![0]!.phase, 'and the machine stayed idle').toBe('idle');
    // Nothing was discarded.
    expect(h.removed).toEqual([]);
  });

  it('UNDO removes the clip record AND orphans the media for the GC — one unit', async () => {
    const h = makeHarness();
    await recordOneTake(h);
    const rec = readClip(clipData(), clipIndex(0, 0));
    expect(rec?.kind).toBe('audio');
    const mediaId = rec?.kind === 'audio' ? rec.mediaId : '';
    expect(referencedClipMediaIds(liveNodes() as never).has(mediaId)).toBe(true);
    clipUndo(CLIP);
    expect(readClip(clipData(), clipIndex(0, 0))).toBeNull();
    // The media is now unreferenced — exactly what the graph-pass GC frees.
    expect(referencedClipMediaIds(liveNodes() as never).has(mediaId)).toBe(false);
  });

  it('a FAILED finalize writes NO clip record and KEEPS the scratch (recover candidate)', async () => {
    const h = makeHarness();
    h.setFailWrites(true); // every byte write rejects → drain.error
    await recordOneTake(h);
    // No clip record, no finalize, and — the load-bearing half — no delete:
    // the manifest is still 'recording' and the bytes stay for recovery.
    expect(readClip(clipData(), clipIndex(0, 0))).toBeNull();
    expect(h.finished).toEqual([]);
    expect(h.removed).toEqual([]);
    expect(h.writerClose).toHaveBeenCalled();
    expect(h.reg.view(MIX)![0]!.phase).toBe('idle');
    expect(h.reg.lastRefusal(MIX)).toMatch(/commit failed/);
    // The arm sequence still CLOSED — a failed take must not look armed, and a
    // still-held arm must not immediately retry into the same failure.
    const armsAfterFail = h.posted.filter((m) => m.type === 'arm').length;
    h.reg.pump();
    await settle();
    h.reg.pump();
    await settle();
    expect(
      h.posted.filter((m) => m.type === 'arm').length,
      'a failed take re-armed itself while the control was held — retry storms on a broken writer',
    ).toBe(armsAfterFail);
  });

  it('a worklet frame count that misses the window is a FAILED commit, not a wrong-length clip', async () => {
    const h = makeHarness();
    h.reg.sync(liveNodes());
    h.reg.pump();
    await settle();
    h.recState.arm[0] = 1;
    h.reg.pump(); // prepare
    await settle();
    h.reg.pump(); // confirm
    const arm = h.posted.find((m) => m.type === 'arm') as { startFrame: number; stopFrame: number };
    const frames = arm.stopFrame - arm.startFrame;
    h.ctx.currentTime = arm.startFrame / SR + 0.05;
    h.reg.pump();
    // A SHORT take. The worklet no longer produces one for a late arm (it
    // slides the window instead — clip-recorder.ts header), so this is now
    // DEFENCE IN DEPTH: whatever else went wrong up there, a clip whose bytes
    // do not match its own metadata must never reach the store.
    const short = frames - 4096;
    const data = new Float32Array(short * 2);
    h.port.onmessage?.({ data: { type: 'chunk', lane: 0, firstFrame: 0, frames: short, data } } as MessageEvent);
    h.port.onmessage?.({
      data: { type: 'done', lane: 0, frames: short, startFrame: arm.startFrame },
    } as MessageEvent);
    h.ctx.currentTime = arm.stopFrame / SR + 0.05;
    h.reg.pump();
    await settle(12);
    expect(readClip(clipData(), clipIndex(0, 0))).toBeNull();
    expect(h.reg.lastRefusal(MIX)).toMatch(/captured/);
    expect(h.removed).toEqual([]); // scratch kept
  });

  it('a take that SLID commits unchanged — and says how late it punched in', async () => {
    // The take's LENGTH is what the commit checks, and a slid take is still
    // exactly `unitFrames` long, so nothing about the clip changes. What must
    // not happen is the slide being invisible: without the warning, a loaded
    // machine moves the downbeat and no one ever finds out.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const h = makeHarness();
      const { frames } = await recordOneTake(h, 3 * 128); // three quanta late
      const rec = readClip(clipData(), clipIndex(0, 0));
      expect(rec?.kind).toBe('audio'); // committed, same as an on-time take
      expect(rec?.kind === 'audio' ? rec.frames : -1).toBe(frames);
      expect(h.reg.lastRefusal(MIX)).toBeNull();
      expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(
        /punched in 384 frames late/,
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('a worklet REFUSAL (zero frames past the slide bound) fails the commit and NAMES the slip', async () => {
    const h = makeHarness();
    h.reg.sync(liveNodes());
    h.reg.pump();
    await settle();
    h.recState.arm[0] = 1;
    h.reg.pump(); // prepare
    await settle();
    h.reg.pump(); // confirm
    const arm = h.posted.find((m) => m.type === 'arm') as { startFrame: number; stopFrame: number };
    h.ctx.currentTime = arm.startFrame / SR + 0.05;
    h.reg.pump();
    // The arm drained further past its punch-in than the slide may absorb: the
    // worklet captured NOTHING and reports the frame it had reached.
    h.port.onmessage?.({
      data: { type: 'done', lane: 0, frames: 0, startFrame: arm.startFrame + 9600 },
    } as MessageEvent);
    h.ctx.currentTime = arm.stopFrame / SR + 0.05;
    h.reg.pump();
    await settle(12);
    expect(readClip(clipData(), clipIndex(0, 0))).toBeNull();
    // Loud, and diagnosable: "captured 0 frames" alone reads like a dead input.
    expect(h.reg.lastRefusal(MIX)).toMatch(/captured 0 frames/);
    expect(h.reg.lastRefusal(MIX)).toMatch(/9600 frames past its punch-in/);
    expect(h.removed).toEqual([]); // scratch kept for recovery
  });

  it('the arm dropping to OFF cancels: worklet cancelled, scratch discarded', async () => {
    const h = makeHarness();
    h.reg.sync(liveNodes());
    h.reg.pump();
    await settle();
    h.recState.arm[0] = 1;
    h.reg.pump(); // prepare
    await settle();
    h.reg.pump(); // confirm
    expect(h.reg.view(MIX)![0]!.phase).toBe('armed');
    h.recState.arm[0] = 0;
    h.reg.pump();
    await settle();
    expect(h.reg.view(MIX)![0]!.phase).toBe('idle');
    expect(h.posted.some((m) => m.type === 'cancel')).toBe(true);
    expect(h.removed.length).toBe(1); // nothing worth keeping was captured
    expect(audioRecState(clipData(), 0)).toBeNull();
  });

  it('ARM SURVIVES a card unmount (no method exists) and a reconciler pass (sync is idempotent)', async () => {
    const h = makeHarness();
    h.reg.sync(liveNodes());
    h.reg.pump();
    await settle();
    h.recState.arm[0] = 1;
    h.reg.pump(); // prepare
    await settle();
    h.reg.pump(); // confirm
    expect(h.reg.view(MIX)![0]!.phase).toBe('armed');
    // A "card unmount" is NOT an event this registry can see — the type has
    // no dispose/release/detach, so the closest thing to unmount/remount is
    // the graph pass re-running with the same nodes. Ten of them:
    for (let i = 0; i < 10; i++) h.reg.sync(liveNodes());
    h.reg.pump();
    expect(h.reg.view(MIX)![0]!.phase).toBe('armed');
    expect(audioRecState(clipData(), 0)?.phase).toBe('armed');
  });

  it('SWEEP of a deleted mixer ABANDONS the take: worklet cancelled, writer closed, scratch KEPT, pads cleared', async () => {
    const h = makeHarness();
    h.reg.sync(liveNodes());
    h.reg.pump();
    await settle();
    h.recState.arm[0] = 1;
    h.reg.pump(); // prepare
    await settle();
    h.reg.pump(); // confirm
    h.ctx.currentTime = 1;
    h.reg.pump(); // recording now
    expect(h.reg.view(MIX)![0]!.phase).toBe('recording');
    delete patch.nodes[MIX];
    h.reg.sync(liveNodes());
    expect(h.reg.view(MIX)).toBeNull();
    expect(h.posted.some((m) => m.type === 'cancel')).toBe(true);
    expect(h.writerClose).toHaveBeenCalled();
    expect(h.removed).toEqual([]); // the scratch is a RECOVER candidate
    expect(audioRecState(clipData(), 0)).toBeNull();
  });

  it("a foreign peer's lease refuses the arm (single-writer)", async () => {
    const h = makeHarness();
    ydoc.transact(() => {
      const d = clipData();
      d.audioRec = {
        '0': {
          lane: 0,
          slot: 0,
          mode: 'single',
          phase: 'recording',
          startFrame: 0,
          stopFrame: 96000,
          unitFrames: 96000,
          recorderId: ydoc.clientID + 1, // someone else
        },
      };
    });
    h.reg.sync(liveNodes());
    h.reg.pump();
    await settle();
    h.recState.arm[0] = 1;
    h.reg.pump();
    await settle();
    expect(h.reg.view(MIX)![0]!.phase).toBe('idle');
    expect(h.reg.lastRefusal(MIX)).toMatch(/another collaborator/);
    expect(h.posted.filter((m) => m.type === 'arm').length).toBe(0);
  });

  it('the reference bar sets the take length when something is playing', async () => {
    const h = makeHarness();
    // The longest playing clip loops in 4 s → 32 steps in this lane's grid.
    h.recClock.refSeconds = 4;
    h.recClock.boundary = 2.5;
    h.reg.sync(liveNodes());
    h.reg.pump();
    await settle();
    h.recState.arm[1] = 1;
    h.reg.pump(); // prepare
    await settle();
    h.reg.pump(); // confirm
    const arm = h.posted.find((m) => m.type === 'arm') as {
      lane: number;
      startFrame: number;
      stopFrame: number;
    };
    expect(arm.lane).toBe(1);
    expect(arm.startFrame).toBe(Math.round(2.5 * SR)); // ON the shared boundary
    expect(arm.stopFrame - arm.startFrame).toBe(4 * SR); // one reference bar
    expect(h.manifests[0]!.lengthSteps).toBe(32);
  });

  it('arming with the transport stopped STARTS it (Bitwig/Deluge)', async () => {
    const h = makeHarness();
    (patch.nodes[TL]!.params as Record<string, number>).running = 0;
    h.recClock.running = false;
    h.reg.sync(liveNodes());
    h.reg.pump();
    await settle();
    h.recState.arm[0] = 1;
    h.reg.pump(); // prepare — starts the transport
    expect((patch.nodes[TL]!.params as Record<string, number>).running).toBe(1);
    // The live clock now reads running (the fake mirrors the param write).
    h.recClock.running = true;
    await settle();
    h.reg.pump(); // confirm
    expect(h.reg.view(MIX)![0]!.phase).toBe('armed');
  });
});

describe('firstEmptySlot', () => {
  it('skips filled slots across the whole stride', () => {
    const d: ClipPlayerData = {
      clips: {
        [String(clipIndex(0, 2))]: { kind: 'note', steps: [], lengthSteps: 4, loop: true } as never,
        [String(clipIndex(1, 2))]: { kind: 'note', steps: [], lengthSteps: 4, loop: true } as never,
      },
    };
    expect(firstEmptySlot(d, 2)).toBe(2);
    expect(firstEmptySlot(undefined, 0)).toBe(0);
  });
});
