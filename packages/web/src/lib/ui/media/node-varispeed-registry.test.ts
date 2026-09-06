// packages/web/src/lib/ui/media/node-varispeed-registry.test.ts
//
// The node-owned varispeed transport (LEG-02 P2, #1511), driven against fakes.
//
// Every leg runs with NO card anywhere — there is no component in this file at
// all — because the defect class is "it only works while a card happens to be
// mounted", and a leg that needed a mount would be re-testing the bug.
//
// TWO of these are REGRESSION legs for defects that are LIVE ON MAIN today, not
// hypotheticals the refactor might introduce:
//
//   * the five CV triggers are dead whenever no card is mounted (a collapsed
//     group, a canvas-hidden node), so a clip player wired into ASSET PITCH /
//     ASSET GATE stops switching clips the moment someone collapses the group;
//   * `activeSlot` and the seven virtual playheads reset on every card remount,
//     which an ordinary expand/collapse performs.
//
// Both are asserted here as properties of the controller, and again end-to-end
// in `node-source-videovarispeed.spec.ts` against a real clip player.

import { describe, it, expect } from 'vitest';
import type { ModuleNode } from '$lib/graph/types';
import '$lib/audio/modules';
import '$lib/video/modules';
import { listModuleDefs } from '$lib/audio/module-registry';
import { listVideoModuleDefs } from '$lib/video/module-registry';
import { DOM_SOURCE_LANE_TYPES } from '$lib/ui/workflow/dom-source-modules';
import { ASSET_SLOTS, ASSET_SLOT_NOTES } from '$lib/video/asset-select';
import { VIDEOVARISPEED_MAX_SLOT_BYTES } from '$lib/video/modules/videovarispeed';
import {
  createNodeVarispeedRegistry,
  varispeedSlotKey,
  NODE_VARISPEED_TYPES,
  NO_VARISPEED,
  CV_INTERVAL_MS,
  HOUSEKEEPING_INTERVAL_MS,
  VARISPEED_DEFAULT_LOOP,
  type VarispeedDeps,
  type VarispeedEngine,
  type VarispeedStatus,
} from './node-varispeed-registry';
import type { VideoSourceHandleHooks } from './node-video-source-registry';

interface FakeEl {
  time: number;
  paused: boolean;
  muted: boolean;
  rate: number;
  dur: number;
  src?: string | null;
}

function makeClock() {
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let next = 1;
  let now = 1_000;
  return {
    clock: {
      now: () => now,
      setInterval: (fn: () => void, ms: number) => { timers.set(next, { fn, ms }); return next++; },
      clearInterval: (h: unknown) => { timers.delete(h as number); },
    },
    tick(ms: number, times = 1): void {
      for (let i = 0; i < times; i++) for (const t of [...timers.values()]) if (t.ms === ms) t.fn();
    },
    live: () => timers.size,
  };
}

/** A hand-driven frame loop: the transport only advances when the test says so,
 *  so no assertion here can pass on a real rAF arriving by luck. */
function makeFrames() {
  let cb: ((nowMs: number) => void) | null = null;
  let running = false;
  return {
    frames: {
      start(tick: (nowMs: number) => void) { cb = tick; running = true; return { id: 1 }; },
      stop() { running = false; cb = null; },
    },
    frame(nowMs: number): void { if (running && cb) cb(nowMs); },
    running: () => running,
  };
}

function makeEngine() {
  const attached = new Map<string, unknown>();
  const params = new Map<string, number>();
  const connected = new Set<string>();
  /** KNOB values — `node.params` with the def's default. Deliberately a SEPARATE
   *  map from `params` (the engine reader), because conflating the two is the
   *  defect the regression leg below pins. */
  const knobs = new Map<string, number>([['start', 0], ['end', 1], ['speed', 0.5]]);
  const keptAlive: unknown[] = [];
  const crops: unknown[] = [];
  let audioWired = false;
  const engine: VarispeedEngine = {
    attach: (nodeId, el) => { attached.set(nodeId, el); },
    hasElement: (nodeId) => attached.get(nodeId) != null,
    extras: (nodeId) =>
      attached.get(nodeId) != null
        ? {
            wireAudio: () => { audioWired = true; },
            isAudioWired: () => audioWired,
            keepSlotAlive: (el: unknown) => { keptAlive.push(el); },
            setCrop: (rect: unknown | null) => { crops.push(rect); },
          }
        : null,
    readParam: (node, p) => params.get(`${node.id}:${p}`),
    knob: (_node, p) => knobs.get(p) ?? 0,
    isConnected: (node, portId) => connected.has(`${node.id}:${portId}`),
  };
  return {
    engine,
    attached,
    keptAlive,
    crops,
    isAudioWired: () => audioWired,
    setParam: (nodeId: string, p: string, v: number) => params.set(`${nodeId}:${p}`, v),
    setKnob: (p: string, v: number) => knobs.set(p, v),
    connect: (nodeId: string, portId: string) => connected.add(`${nodeId}:${portId}`),
  };
}

interface HarnessState {
  isPlaying: boolean;
  loop?: boolean;
  crop: unknown | null;
  rawCrop?: { x: number; y: number; w: number } | null;
  outAspect?: number;
  fileMeta?: { name: string; duration: number; size?: number; handleId?: string } | null;
  slotMeta?: ({ name: string; duration: number; size?: number; handleId?: string } | null)[];
}

interface Harness {
  deps: VarispeedDeps<FakeEl>;
  hooks: VideoSourceHandleHooks;
  els: Map<string, FakeEl>;
  names: Map<string, string | null>;
  urls: Map<string, string | null>;
  statuses: Array<{ nodeId: string; status: VarispeedStatus }>;
  state: Map<string, HarnessState>;
  playWrites: Array<{ nodeId: string; v: boolean }>;
  loopWrites: Array<{ nodeId: string; v: boolean }>;
  metaWrites: Array<{ nodeId: string; slot: number | 'file'; meta: unknown }>;
  cropWrites: Array<{ nodeId: string; active: boolean; rect: { x: number; y: number; w: number } }>;
  exports: Map<string, () => Promise<unknown>>;
  /** Handles this fake IDB holds, by id, with their permission state. */
  handles: Map<string, { perm: 'granted' | 'prompt' | 'denied'; file: File }>;
  bytes: Map<string, Uint8Array>;
}

function makeHarness(
  clock: ReturnType<typeof makeClock>['clock'],
  frames: ReturnType<typeof makeFrames>['frames'],
  engine: VarispeedEngine | null,
): Harness {
  const els = new Map<string, FakeEl>();
  const names = new Map<string, string | null>();
  const statuses: Harness['statuses'] = [];
  const state: Harness['state'] = new Map();
  const playWrites: Harness['playWrites'] = [];
  const loopWrites: Harness['loopWrites'] = [];
  const metaWrites: Harness['metaWrites'] = [];
  const cropWrites: Harness['cropWrites'] = [];
  const urls = new Map<string, string | null>();
  const exports = new Map<string, () => Promise<unknown>>();
  const handles: Harness['handles'] = new Map();
  const bytes = new Map<string, Uint8Array>();
  const k = (n: string, s: string) => `${n}::${s}`;
  const hooks: VideoSourceHandleHooks = {
    canPersist: () => true,
    newId: () => `id-${handles.size + 1}`,
    put: async (id, handle) => { handles.set(id, handle as { perm: 'granted' | 'prompt' | 'denied'; file: File }); },
    get: async (id) => handles.get(id) ?? null,
    queryPermission: async (h) => (h as { perm: 'granted' | 'prompt' | 'denied' }).perm,
    requestPermission: async () => 'granted',
    getFile: async (h) => (h as { file: File }).file,
  };
  const deps: VarispeedDeps<FakeEl> = {
    engine,
    doc: {
      read: (nodeId) => state.get(nodeId) ?? null,
      writePlaying: (nodeId, v) => {
        playWrites.push({ nodeId, v });
        const s = state.get(nodeId); if (s) s.isPlaying = v;
      },
      writeLoop: (nodeId, v) => {
        loopWrites.push({ nodeId, v });
        const s = state.get(nodeId); if (s) s.loop = v;
      },
      writeFileMeta: (nodeId, meta) => {
        metaWrites.push({ nodeId, slot: 'file', meta });
        const s = state.get(nodeId); if (s) s.fileMeta = { ...meta };
      },
      writeSlotMeta: (nodeId, slot, meta) => {
        metaWrites.push({ nodeId, slot, meta });
        const s = state.get(nodeId);
        if (s) {
          const arr = s.slotMeta ? [...s.slotMeta] : new Array(ASSET_SLOTS).fill(null);
          arr[slot] = meta ? { ...meta } : null;
          s.slotMeta = arr;
        }
      },
      readMeta: (nodeId) => {
        const st = state.get(nodeId);
        if (!st) return null;
        return {
          fileMeta: st.fileMeta ?? null,
          slotMeta: st.slotMeta ?? new Array(ASSET_SLOTS).fill(null),
        };
      },
      writeCrop: (nodeId, active, rect) => {
        cropWrites.push({ nodeId, active, rect: { ...rect } });
        const s = state.get(nodeId);
        if (s) { s.rawCrop = { ...rect }; s.crop = { ...rect }; }
      },
    },
    media: {
      ensure: (nodeId, slot) => {
        const key = k(nodeId, slot);
        let el = els.get(key);
        if (!el) { el = { time: 0, paused: true, muted: false, rate: 1, dur: 10 }; els.set(key, el); }
        return el;
      },
      mediaName: (nodeId, slot) => names.get(k(nodeId, slot)) ?? null,
      objectUrl: (nodeId, slot) => urls.get(k(nodeId, slot)) ?? null,
      setObjectUrl: (nodeId, slot, url, name) => {
        urls.set(k(nodeId, slot), url);
        names.set(k(nodeId, slot), url === null ? null : (name ?? null));
      },
    },
    el: {
      currentTime: (el) => el.time,
      seek: (el, to) => { el.time = to; },
      paused: (el) => el.paused,
      play: (el) => { el.paused = false; },
      pause: (el) => { el.paused = true; },
      setMuted: (el, m) => { el.muted = m; },
      setPlaybackRate: (el, r) => { el.rate = r; },
      playbackRate: (el) => el.rate,
      duration: (el) => el.dur,
      setSrc: (el, url) => { el.src = url; },
      clearSrc: (el) => { el.src = null; },
      awaitMetadata: async () => { /* the fake element has metadata already */ },
    },
    clock,
    frames,
    createObjectUrl: (file) => `blob:${file.name}`,
    registerExport: (nodeId, resolve) => { exports.set(nodeId, resolve); },
    unregisterExport: (nodeId) => { exports.delete(nodeId); },
    fetchBytes: async (url) => bytes.get(url) ?? new Uint8Array(0),
    onStatus: (nodeId, status) => { statuses.push({ nodeId, status }); },
  };
  return {
    deps, hooks, els, names, urls, statuses, state,
    playWrites, loopWrites, metaWrites, cropWrites, exports, handles, bytes,
  };
}

function vvNode(id: string): ModuleNode {
  return { id, type: 'videovarispeed', domain: 'video' } as unknown as ModuleNode;
}

/** Load bytes into a slot and give it a sane window (full clip). */
function loadSlot(h: Harness, nodeId: string, slot: number, name = `clip${slot}.mp4`): void {
  h.names.set(`${nodeId}::${varispeedSlotKey(slot)}`, name);
}

/** A full-clip window: start slider 0, end slider 1. */
function openWindow(eng: ReturnType<typeof makeEngine>, _nodeId: string): void {
  eng.setKnob('start', 0);
  eng.setKnob('end', 1);
  eng.setKnob('speed', 0.5); // midpoint knob == 1x
}

// ---------------------------------------------------------------------------

describe('NODE_VARISPEED_TYPES — the ownership declaration', () => {
  it('every declared type is a REGISTERED module def', () => {
    const known = new Set<string>([
      ...listModuleDefs().map((d) => (d as { type: string }).type),
      ...listVideoModuleDefs().map((d) => (d as { type: string }).type),
    ]);
    const ghosts = [...NODE_VARISPEED_TYPES].filter((t) => !known.has(t));
    expect(ghosts, `declared owner type(s) with no module def: ${ghosts.join(', ')}`).toEqual([]);
  });

  it('is DISJOINT from DOM_SOURCE_LANE_TYPES — one owner per module, never two', () => {
    // Membership of both would mean the CARD attaches and the CONTROLLER
    // attaches: two attach sites for one element, whichever ran last winning
    // non-deterministically. A PR that adds the controller without removing the
    // card's attach reddens here.
    const both = [...NODE_VARISPEED_TYPES].filter((t) => DOM_SOURCE_LANE_TYPES.has(t));
    expect(both, `type(s) claimed by BOTH a card attach and a node controller: ${both.join(', ')}`)
      .toEqual([]);
    expect(NODE_VARISPEED_TYPES.size, 'an empty owner set makes the disjointness vacuous')
      .toBeGreaterThan(0);
  });

  it('the slot key matches the one the CARD has always written', () => {
    // ⚠ `slot0`, not `main`. nodeMedia is keyed (nodeId, slot); a controller
    // that ensured a different spelling would mint a second empty element and
    // orphan the bytes of every rack already saved.
    expect(varispeedSlotKey(0)).toBe('slot0');
    expect(varispeedSlotKey(3)).toBe('slot3');
  });
});

describe('the player exists because the NODE exists — no card, ever', () => {
  it('ensures ALL seven slot elements and attaches the active one', () => {
    const c = makeClock(); const f = makeFrames(); const eng = makeEngine();
    const h = makeHarness(c.clock, f.frames, eng.engine);
    const reg = createNodeVarispeedRegistry(h.deps);
    reg.sync([vvNode('v1')], eng.engine);

    for (let i = 0; i < ASSET_SLOTS; i++) {
      expect(h.els.get(`v1::${varispeedSlotKey(i)}`), `slot ${i} was never ensured`).toBeDefined();
    }
    expect(eng.attached.get('v1'), 'the engine never received the active element').toBeDefined();
    expect(reg.view('v1').attached).toBe(true);
  });

  it('holds every LOADED slot warm — a switch must not land on a throttled frame', () => {
    const c = makeClock(); const f = makeFrames(); const eng = makeEngine();
    const h = makeHarness(c.clock, f.frames, eng.engine);
    const reg = createNodeVarispeedRegistry(h.deps);
    h.state.set('v1', { isPlaying: false, loop: false, crop: null });
    loadSlot(h, 'v1', 0); loadSlot(h, 'v1', 2);
    reg.sync([vvNode('v1')], eng.engine);
    c.tick(100);
    expect(eng.keptAlive.length, 'no slot was kept alive').toBeGreaterThan(0);
  });

  it('disposes every timer AND the frame loop when the node leaves the graph', () => {
    const c = makeClock(); const f = makeFrames(); const eng = makeEngine();
    const h = makeHarness(c.clock, f.frames, eng.engine);
    const reg = createNodeVarispeedRegistry(h.deps);
    reg.sync([vvNode('v1')], eng.engine);
    expect(f.running(), 'the transport loop never started').toBe(true);

    reg.sync([], eng.engine);
    expect(reg.has('v1')).toBe(false);
    expect(c.live(), 'timers outlived the node').toBe(0);
    expect(f.running(), 'the transport frame loop outlived the node').toBe(false);
    expect(reg.view('v1')).toEqual(NO_VARISPEED);
  });

  it('does NOT detach on dispose — nodeMedia owns the elements, keyed to the graph', () => {
    const c = makeClock(); const f = makeFrames(); const eng = makeEngine();
    const h = makeHarness(c.clock, f.frames, eng.engine);
    const reg = createNodeVarispeedRegistry(h.deps);
    reg.sync([vvNode('v1')], eng.engine);
    reg.disposeNode('v1');
    expect(eng.attached.get('v1'), 'the controller detached the engine source on dispose').toBeDefined();
  });
});

describe('REGRESSION: the five CV triggers were dead with no card mounted', () => {
  // On main these run only while a card is mounted, and a collapsed-group or
  // canvas-hidden varispeed has NO card anywhere. Nothing below mounts one.

  it('ASSET GATE + ASSET PITCH switch the on-air slot — the clip-player path', () => {
    const c = makeClock(); const f = makeFrames(); const eng = makeEngine();
    const h = makeHarness(c.clock, f.frames, eng.engine);
    h.state.set('v1', { isPlaying: false, loop: false, crop: null });
    loadSlot(h, 'v1', 0); loadSlot(h, 'v1', 2);
    openWindow(eng, 'v1');
    const reg = createNodeVarispeedRegistry(h.deps);
    reg.sync([vvNode('v1')], eng.engine);
    expect(reg.view('v1').activeSlot).toBe(0);

    // Slot 2's note as V/oct — the same mapping a clip player's PITCH out sends.
    const voct = (ASSET_SLOT_NOTES[2]! - 60) / 12;
    eng.setParam('v1', 'asset_pitch', voct);
    eng.setParam('v1', 'asset_gate', 0);
    c.tick(CV_INTERVAL_MS);
    expect(reg.view('v1').activeSlot, 'a LOW gate switched the slot').toBe(0);

    eng.setParam('v1', 'asset_gate', 1);
    c.tick(CV_INTERVAL_MS);
    expect(reg.view('v1').activeSlot, 'the ASSET GATE rising edge did not switch the slot').toBe(2);

    // A HELD-high gate must not re-fire: this is a TRIGGER.
    eng.setParam('v1', 'asset_pitch', 0);
    c.tick(CV_INTERVAL_MS, 3);
    expect(reg.view('v1').activeSlot, 'a held-high gate re-fired and switched again').toBe(2);
  });

  it('an ASSET GATE naming an EMPTY slot is ignored, not an error', () => {
    const c = makeClock(); const f = makeFrames(); const eng = makeEngine();
    const h = makeHarness(c.clock, f.frames, eng.engine);
    h.state.set('v1', { isPlaying: false, loop: false, crop: null });
    loadSlot(h, 'v1', 0); // slot 4 deliberately empty
    openWindow(eng, 'v1');
    const reg = createNodeVarispeedRegistry(h.deps);
    reg.sync([vvNode('v1')], eng.engine);
    eng.setParam('v1', 'asset_pitch', (ASSET_SLOT_NOTES[4]! - 60) / 12);
    eng.setParam('v1', 'asset_gate', 1);
    c.tick(CV_INTERVAL_MS);
    expect(reg.view('v1').activeSlot, 'switched to a slot holding no bytes').toBe(0);
  });

  it('cv_start / cv_pause / cv_loop_toggle all reach the graph', () => {
    const c = makeClock(); const f = makeFrames(); const eng = makeEngine();
    const h = makeHarness(c.clock, f.frames, eng.engine);
    h.state.set('v1', { isPlaying: false, loop: false, crop: null });
    loadSlot(h, 'v1', 0);
    openWindow(eng, 'v1');
    const reg = createNodeVarispeedRegistry(h.deps);
    reg.sync([vvNode('v1')], eng.engine);

    eng.setParam('v1', 'cv_start', 1);
    c.tick(CV_INTERVAL_MS);
    expect(h.playWrites.at(-1), 'cv_start did not start transport').toMatchObject({ v: true });

    eng.setParam('v1', 'cv_pause', 1);
    c.tick(CV_INTERVAL_MS);
    expect(h.playWrites.at(-1), 'cv_pause did not toggle transport').toMatchObject({ v: false });

    eng.setParam('v1', 'cv_loop_toggle', 1);
    c.tick(CV_INTERVAL_MS);
    expect(h.loopWrites.at(-1), 'cv_loop_toggle did not reach the graph').toMatchObject({ v: true });
  });

  it('cv_reset rewinds the active slot to its window start', () => {
    const c = makeClock(); const f = makeFrames(); const eng = makeEngine();
    const h = makeHarness(c.clock, f.frames, eng.engine);
    h.state.set('v1', { isPlaying: false, loop: false, crop: null });
    loadSlot(h, 'v1', 0);
    openWindow(eng, 'v1');
    const reg = createNodeVarispeedRegistry(h.deps);
    reg.sync([vvNode('v1')], eng.engine);
    h.els.get('v1::slot0')!.time = 7;

    eng.setParam('v1', 'cv_reset', 1);
    c.tick(CV_INTERVAL_MS);
    expect(h.els.get('v1::slot0')!.time, 'cv_reset did not rewind the element').toBe(0);
  });
});

describe('REGRESSION: slot + playheads survive anything a VIEW does', () => {
  it('activeSlot is NODE state — nothing a surface does can reset it', () => {
    // On main `activeSlot` is card `$state(0)` with no persistence path, so
    // every remount (an expand, a collapse) snapped the player back to slot 0.
    // Here the only thing that can end it is the node leaving the graph.
    const c = makeClock(); const f = makeFrames(); const eng = makeEngine();
    const h = makeHarness(c.clock, f.frames, eng.engine);
    h.state.set('v1', { isPlaying: false, loop: false, crop: null });
    loadSlot(h, 'v1', 0); loadSlot(h, 'v1', 3);
    openWindow(eng, 'v1');
    const reg = createNodeVarispeedRegistry(h.deps);
    reg.sync([vvNode('v1')], eng.engine);

    reg.request('v1', { kind: 'selectSlot', slot: 3 });
    expect(reg.view('v1').activeSlot).toBe(3);

    // Every graph tick a mount/unmount would produce. The slot must not move.
    for (let i = 0; i < 5; i++) reg.sync([vvNode('v1')], eng.engine);
    expect(reg.view('v1').activeSlot, 'a graph tick reset the on-air slot').toBe(3);
  });

  it('a switch AWAY snapshots the outgoing time and a switch BACK resumes there', () => {
    const c = makeClock(); const f = makeFrames(); const eng = makeEngine();
    const h = makeHarness(c.clock, f.frames, eng.engine);
    h.state.set('v1', { isPlaying: false, loop: false, crop: null });
    loadSlot(h, 'v1', 0); loadSlot(h, 'v1', 1);
    openWindow(eng, 'v1');
    const reg = createNodeVarispeedRegistry(h.deps);
    reg.sync([vvNode('v1')], eng.engine);

    h.els.get('v1::slot0')!.time = 4.25;
    reg.request('v1', { kind: 'selectSlot', slot: 1 });
    h.els.get('v1::slot1')!.time = 9;
    reg.request('v1', { kind: 'selectSlot', slot: 0 });

    expect(
      h.els.get('v1::slot0')!.time,
      'switching back did not resume the slot where it was left',
    ).toBeCloseTo(4.25, 5);
  });

  it('re-triggering the LIVE slot restarts it from the window start', () => {
    const c = makeClock(); const f = makeFrames(); const eng = makeEngine();
    const h = makeHarness(c.clock, f.frames, eng.engine);
    h.state.set('v1', { isPlaying: false, loop: false, crop: null });
    loadSlot(h, 'v1', 0);
    openWindow(eng, 'v1');
    const reg = createNodeVarispeedRegistry(h.deps);
    reg.sync([vvNode('v1')], eng.engine);
    h.els.get('v1::slot0')!.time = 6;

    reg.request('v1', { kind: 'selectSlot', slot: 0 });
    expect(h.els.get('v1::slot0')!.time, 'a re-strike of the live slot did not restart it').toBe(0);
  });

  it('a slot switch RE-POINTS the engine attach and re-wires audio', () => {
    const c = makeClock(); const f = makeFrames(); const eng = makeEngine();
    const h = makeHarness(c.clock, f.frames, eng.engine);
    h.state.set('v1', { isPlaying: false, loop: false, crop: null });
    loadSlot(h, 'v1', 0); loadSlot(h, 'v1', 5);
    openWindow(eng, 'v1');
    const reg = createNodeVarispeedRegistry(h.deps);
    reg.sync([vvNode('v1')], eng.engine);
    expect(eng.attached.get('v1')).toBe(h.els.get('v1::slot0'));

    reg.request('v1', { kind: 'selectSlot', slot: 5 });
    expect(
      eng.attached.get('v1'),
      'the engine is still pointed at the OLD slot after a switch — the picture would not change',
    ).toBe(h.els.get('v1::slot5'));
  });
});

describe('REGRESSION: the persisted CROP reached the engine only from a card', () => {
  it('pushes the saved crop at node creation, with no card anywhere', () => {
    // ⚠ THE THIRD DEFECT OF THE FAMILY. The rect is persisted on `node.data`,
    // but the only thing that ever pushed it to the engine was a card
    // `$effect` — so a rack saved WITH a crop and reopened with the module
    // collapsed applied NO crop, silently, while the control still showed one.
    const c = makeClock(); const f = makeFrames(); const eng = makeEngine();
    const h = makeHarness(c.clock, f.frames, eng.engine);
    h.state.set('v1', { isPlaying: false, loop: false, crop: { x: 0.1, y: 0.2, w: 0.5 } });
    loadSlot(h, 'v1', 0);
    const reg = createNodeVarispeedRegistry(h.deps);
    reg.sync([vvNode('v1')], eng.engine);
    c.tick(100);
    expect(eng.crops.at(-1), 'the saved crop never reached the engine').toEqual({ x: 0.1, y: 0.2, w: 0.5 });
  });

  it('a null crop is pushed as passthrough rather than skipped', () => {
    const c = makeClock(); const f = makeFrames(); const eng = makeEngine();
    const h = makeHarness(c.clock, f.frames, eng.engine);
    h.state.set('v1', { isPlaying: false, loop: false, crop: null });
    loadSlot(h, 'v1', 0);
    const reg = createNodeVarispeedRegistry(h.deps);
    reg.sync([vvNode('v1')], eng.engine);
    c.tick(100);
    expect(eng.crops.length, 'no crop call at all — passthrough must be pushed explicitly').toBeGreaterThan(0);
    expect(eng.crops.at(-1)).toBeNull();
  });
});

describe('the transport loop', () => {
  it('drives forward playback rate and plays the active element', () => {
    const c = makeClock(); const f = makeFrames(); const eng = makeEngine();
    const h = makeHarness(c.clock, f.frames, eng.engine);
    h.state.set('v1', { isPlaying: true, loop: true, crop: null });
    loadSlot(h, 'v1', 0);
    openWindow(eng, 'v1');
    const reg = createNodeVarispeedRegistry(h.deps);
    reg.sync([vvNode('v1')], eng.engine);

    f.frame(1000);
    f.frame(1016);
    const el = h.els.get('v1::slot0')!;
    expect(el.paused, 'the transport never started the active element').toBe(false);
    expect(el.rate, 'playbackRate was not driven').toBeGreaterThan(0);
  });

  it('advances the OFF-AIR virtual playheads so a switch lands de-synced', () => {
    const c = makeClock(); const f = makeFrames(); const eng = makeEngine();
    const h = makeHarness(c.clock, f.frames, eng.engine);
    h.state.set('v1', { isPlaying: true, loop: true, crop: null });
    loadSlot(h, 'v1', 0); loadSlot(h, 'v1', 1);
    openWindow(eng, 'v1');
    const reg = createNodeVarispeedRegistry(h.deps);
    reg.sync([vvNode('v1')], eng.engine);

    f.frame(1000);
    f.frame(2000); // one second of transport
    // Switching to slot 1 should land on its ADVANCED virtual playhead, not 0.
    reg.request('v1', { kind: 'selectSlot', slot: 1 });
    expect(
      h.els.get('v1::slot1')!.time,
      'the off-air slot did not advance — a switch would land where the clip was abandoned',
    ).toBeGreaterThan(0);
  });

  it('the frame loop is a no-op once the controller is disposed', () => {
    const c = makeClock(); const f = makeFrames(); const eng = makeEngine();
    const h = makeHarness(c.clock, f.frames, eng.engine);
    h.state.set('v1', { isPlaying: true, loop: true, crop: null });
    loadSlot(h, 'v1', 0);
    openWindow(eng, 'v1');
    const reg = createNodeVarispeedRegistry(h.deps);
    reg.sync([vvNode('v1')], eng.engine);
    reg.disposeNode('v1');
    expect(() => f.frame(5000)).not.toThrow();
  });
});

describe('REGRESSION: the window reads the KNOB, not the engine param', () => {
  it('an untouched END keeps the window OPEN — reading the engine would close it', () => {
    // ⚠ A DEFECT THIS CONVERSION SHIPPED AND THIS SUITE CAUGHT ONLY IN E2E.
    // The card read `speed`/`start`/`end` through its `paramVal` helper —
    // `node.params[id]` with the DEF'S DEFAULT as fallback. The first controller
    // read them through `engine.readParam`, which returns 0 for a param the user
    // has never touched. `end` defaults to 1, so it read 0, `startSec < endSec`
    // was false, `hasWindow` was false, and the transport PAUSED the element:
    // `videovarispeed-switch.spec.ts` failed with "engine frame uploads must
    // climb after the switch (was 40)". Two readers that look interchangeable
    // and are not.
    const c = makeClock(); const f = makeFrames(); const eng = makeEngine();
    const h = makeHarness(c.clock, f.frames, eng.engine);
    h.state.set('v1', { isPlaying: true, loop: true, crop: null });
    loadSlot(h, 'v1', 0);
    // NOTHING is set on the engine reader — every window param is at its default,
    // exactly as on a freshly spawned node.
    const reg = createNodeVarispeedRegistry(h.deps);
    reg.sync([vvNode('v1')], eng.engine);
    f.frame(1000);
    f.frame(1016);
    expect(
      h.els.get('v1::slot0')!.paused,
      'the element is paused on a default node — the window read empty, which is the engine-reader bug',
    ).toBe(false);
  });
});

describe('REGRESSION: LOOP defaults ON, so a fresh node does not latch one-shot', () => {
  it('an UNSET loop keeps playing past the window end', () => {
    // ⚠ SHIPPED AND CAUGHT IN E2E ONLY. The doc binding defaulted `loop` to
    // FALSE while the card had always read `data.loop ?? true`. A fresh node
    // therefore ran as ONE-SHOT: the transport reached the window END, latched
    // `oneShotEnded`, PAUSED the element, and the engine stopped uploading.
    // `videovarispeed-switch.spec.ts` failed with "engine frame uploads must
    // climb after the switch (was 38)" while PASSING on main. The default now
    // has ONE owner (VARISPEED_DEFAULT_LOOP) that both sides read.
    expect(VARISPEED_DEFAULT_LOOP, 'LOOP is ON by default for this module').toBe(true);

    const c = makeClock(); const f = makeFrames(); const eng = makeEngine();
    const h = makeHarness(c.clock, f.frames, eng.engine);
    // `loop` deliberately OMITTED — the state a node that nobody has toggled is in.
    h.state.set('v1', { isPlaying: true, crop: null } as never);
    loadSlot(h, 'v1', 0);
    openWindow(eng, 'v1');
    const reg = createNodeVarispeedRegistry(h.deps);
    reg.sync([vvNode('v1')], eng.engine);

    const el = h.els.get('v1::slot0')!;
    // Drive the element past the window END across several frames.
    let t = 1000;
    for (let i = 0; i < 8; i++) { el.time = 9.9; f.frame((t += 100)); }
    expect(
      el.paused,
      'the element latched one-shot and paused on a node whose loop was never set — the default disagreed',
    ).toBe(false);
  });
});

describe('command delivery + robustness', () => {
  it('reports delivered:false for a node with no controller', () => {
    const c = makeClock(); const f = makeFrames();
    const h = makeHarness(c.clock, f.frames, makeEngine().engine);
    const reg = createNodeVarispeedRegistry(h.deps);
    expect(reg.request('ghost', { kind: 'togglePlay' }).delivered).toBe(false);
  });

  it('a surface throwing in onStatus cannot break the lifecycle', () => {
    const c = makeClock(); const f = makeFrames(); const eng = makeEngine();
    const h = makeHarness(c.clock, f.frames, eng.engine);
    h.deps.onStatus = () => { throw new Error('render blew up'); };
    const reg = createNodeVarispeedRegistry(h.deps);
    expect(() => reg.sync([vvNode('v1')], eng.engine)).not.toThrow();
    expect(eng.attached.get('v1'), 'a throwing surface prevented the attach').toBeDefined();
  });

  it('SCOPE: no pixels, no components — the e2e owns "does the picture change"', () => {
    const c = makeClock(); const f = makeFrames();
    const h = makeHarness(c.clock, f.frames, makeEngine().engine);
    const reg = createNodeVarispeedRegistry(h.deps);
    reg.sync([vvNode('v1')], makeEngine().engine);
    const el = h.els.get('v1::slot0')! as unknown as { getContext?: unknown };
    expect(
      typeof el.getContext,
      'the fake element grew a real DOM surface — this suite would be asserting about a browser it does not have',
    ).toBe('undefined');
  });
});

// ---------------------------------------------------------------------------
// THE LOADER, THE RESTORE, THE EXPORT AND THE ASPECT RE-FIT (wave-4 face PR)
//
// ⚠ THESE FOUR WERE THE CARD'S, AND WERE THEREFORE DOCK-GATED ON `main`.
// videovarispeed is in neither `DOM_SOURCE_LANE_TYPES` nor
// `CARD_PRODUCER_LANE_TYPES`, so it gets no headless host: on the default shell
// no card is mounted anywhere, and the card's `$effect` on `fileMeta.handleId`
// was the delivery mechanism for the Loaded-Assets picker spawn, the rebind
// sweep and the perf-zip restore. Every leg below therefore runs with NO card
// — there is no component in this file at all — because "it only works while a
// surface happens to be mounted" IS the defect class.
// ---------------------------------------------------------------------------

/** A `File` the node-env test lane can build. */
function fakeVideo(name = 'clip.webm', size = 1_000, type = 'video/webm'): File {
  return { name, size, type } as unknown as File;
}

describe('the per-slot LOADER lives on the node', () => {
  function boot() {
    const c = makeClock(); const f = makeFrames(); const eng = makeEngine();
    const h = makeHarness(c.clock, f.frames, eng.engine);
    h.state.set('v1', { isPlaying: false, loop: true, crop: null });
    const reg = createNodeVarispeedRegistry(h.deps, h.hooks);
    reg.sync([vvNode('v1')], eng.engine);
    return { c, f, eng, h, reg };
  }

  it('loads bytes into a slot with NO surface mounted, and publishes the name', async () => {
    const { h, reg } = boot();
    reg.request('v1', { kind: 'loadFile', slot: 3, file: fakeVideo('three.webm') });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(h.urls.get('v1::slot3'), 'no object url reached the node registry').toBe('blob:three.webm');
    expect(reg.view('v1').slotNames[3]).toBe('three.webm');
  });

  it('slot 0 writes BOTH the legacy fileMeta and the slotMeta row', async () => {
    const { h, reg } = boot();
    reg.request('v1', { kind: 'loadFile', slot: 0, file: fakeVideo('zero.webm') });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    // `fileMeta` is the key the perf-zip loader, the asset picker and the
    // rebind sweep all read — a loader that wrote only `slotMeta` would leave
    // all three writing into a field nothing restores from.
    expect(h.metaWrites.some((w) => w.slot === 'file')).toBe(true);
    expect(h.metaWrites.some((w) => w.slot === 0)).toBe(true);
  });

  it('a slot 1..6 load writes ONLY its own slotMeta row', async () => {
    const { h, reg } = boot();
    reg.request('v1', { kind: 'loadFile', slot: 5, file: fakeVideo('five.webm') });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(h.metaWrites.some((w) => w.slot === 'file')).toBe(false);
    expect(h.metaWrites.filter((w) => w.slot === 5)).toHaveLength(1);
  });

  it('refuses a non-video file and PUBLISHES the reason', async () => {
    const { h, reg } = boot();
    reg.request('v1', { kind: 'loadFile', slot: 0, file: fakeVideo('notes.txt', 10, 'text/plain') });
    await Promise.resolve();
    expect(reg.view('v1').error).toMatch(/Not a video file/);
    expect(h.urls.get('v1::slot0') ?? null, 'a refused file still created a url').toBeNull();
  });

  it('refuses a file over the DEF-declared per-slot cap, and names the cap', async () => {
    const { reg } = boot();
    reg.request('v1', {
      kind: 'loadFile',
      slot: 0,
      file: fakeVideo('huge.webm', VIDEOVARISPEED_MAX_SLOT_BYTES + 1),
    });
    await Promise.resolve();
    // The cap comes from the def, never re-typed here — a card that widened it
    // would silently admit files the module documents as refused.
    expect(reg.view('v1').error).toContain(`${Math.round(VIDEOVARISPEED_MAX_SLOT_BYTES / (1024 * 1024))} MB`);
  });

  it('clearError dismisses it after a surface has shown it', async () => {
    const { reg } = boot();
    reg.request('v1', { kind: 'loadFile', slot: 0, file: fakeVideo('x.txt', 10, 'text/plain') });
    await Promise.resolve();
    expect(reg.view('v1').error).not.toBeNull();
    reg.request('v1', { kind: 'clearError' });
    expect(reg.view('v1').error).toBeNull();
  });

  it('an explicit CLEAR frees the slot and falls back to slot 0', async () => {
    const { h, reg } = boot();
    loadSlot(h, 'v1', 0);
    loadSlot(h, 'v1', 2);
    reg.request('v1', { kind: 'selectSlot', slot: 2 });
    expect(reg.view('v1').activeSlot).toBe(2);
    reg.request('v1', { kind: 'clearSlot', slot: 2 });
    expect(h.names.get('v1::slot2') ?? null).toBeNull();
    expect(reg.view('v1').activeSlot, 'clearing the ON-AIR slot left the player on nothing').toBe(0);
  });
});

describe('the SAVED-HANDLE RESTORE runs on node creation, with no surface', () => {
  it('a GRANTED handle reloads slot 0 with no card and no gesture', async () => {
    const c = makeClock(); const f = makeFrames(); const eng = makeEngine();
    const h = makeHarness(c.clock, f.frames, eng.engine);
    h.handles.set('h-0', { perm: 'granted', file: fakeVideo('saved.webm') });
    h.state.set('v1', {
      isPlaying: false, loop: true, crop: null,
      fileMeta: { name: 'saved.webm', duration: 10, handleId: 'h-0' },
    });
    const reg = createNodeVarispeedRegistry(h.deps, h.hooks);
    reg.sync([vvNode('v1')], eng.engine);
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(
      reg.view('v1').slotNames[0],
      'a rack saved with a clip came back empty because nothing was mounted to notice',
    ).toBe('saved.webm');
  });

  it('a LAPSED (prompt) handle loads nothing and publishes the name for a click', async () => {
    const c = makeClock(); const f = makeFrames(); const eng = makeEngine();
    const h = makeHarness(c.clock, f.frames, eng.engine);
    h.handles.set('h-0', { perm: 'prompt', file: fakeVideo('saved.webm') });
    h.state.set('v1', {
      isPlaying: false, loop: true, crop: null,
      fileMeta: { name: 'saved.webm', duration: 10, handleId: 'h-0' },
    });
    const reg = createNodeVarispeedRegistry(h.deps, h.hooks);
    reg.sync([vvNode('v1')], eng.engine);
    for (let i = 0; i < 8; i++) await Promise.resolve();
    // requestPermission() is honoured only inside a real user gesture, so the
    // controller can OFFER the re-allow and must not perform it.
    expect(reg.view('v1').slotNames[0]).toBeNull();
    expect(reg.view('v1').pendingHandleName).toBe('saved.webm');
  });

  it('slots 1..6 restore from their OWN slotMeta handles — the Fix B multi-slot path', async () => {
    const c = makeClock(); const f = makeFrames(); const eng = makeEngine();
    const h = makeHarness(c.clock, f.frames, eng.engine);
    h.handles.set('h-4', { perm: 'granted', file: fakeVideo('four.webm') });
    const slotMeta = new Array(ASSET_SLOTS).fill(null);
    slotMeta[4] = { name: 'four.webm', duration: 3, handleId: 'h-4' };
    h.state.set('v1', { isPlaying: false, loop: true, crop: null, slotMeta });
    const reg = createNodeVarispeedRegistry(h.deps, h.hooks);
    reg.sync([vvNode('v1')], eng.engine);
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(reg.view('v1').slotNames[4]).toBe('four.webm');
  });

  it('a LATE slotMeta (a peer write, a perf-zip load) still gets its one attempt', async () => {
    const c = makeClock(); const f = makeFrames(); const eng = makeEngine();
    const h = makeHarness(c.clock, f.frames, eng.engine);
    h.state.set('v1', { isPlaying: false, loop: true, crop: null });
    const reg = createNodeVarispeedRegistry(h.deps, h.hooks);
    reg.sync([vvNode('v1')], eng.engine);
    // The bytes arrive AFTER the controller was built — the perf-zip shape.
    h.handles.set('h-1', { perm: 'granted', file: fakeVideo('late.webm') });
    const slotMeta = new Array(ASSET_SLOTS).fill(null);
    slotMeta[1] = { name: 'late.webm', duration: 3, handleId: 'h-1' };
    h.state.get('v1')!.slotMeta = slotMeta;
    c.tick(HOUSEKEEPING_INTERVAL_MS);
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(reg.view('v1').slotNames[1]).toBe('late.webm');
  });
});

describe('the MULTI-SLOT export resolver is registered on NODE lifetime', () => {
  it('registers on creation and yields EVERY populated slot, each tagged', async () => {
    const c = makeClock(); const f = makeFrames(); const eng = makeEngine();
    const h = makeHarness(c.clock, f.frames, eng.engine);
    h.state.set('v1', { isPlaying: false, loop: true, crop: null });
    const reg = createNodeVarispeedRegistry(h.deps, h.hooks);
    reg.sync([vvNode('v1')], eng.engine);
    expect(h.exports.has('v1'), 'nothing registered — a rack export would carry no varispeed bytes').toBe(true);

    h.urls.set('v1::slot0', 'blob:a'); h.names.set('v1::slot0', 'a.webm');
    h.urls.set('v1::slot2', 'blob:c'); h.names.set('v1::slot2', 'c.webm');
    h.bytes.set('blob:a', new Uint8Array([1, 2, 3]));
    h.bytes.set('blob:c', new Uint8Array([4, 5]));

    const out = await h.exports.get('v1')!() as Array<{ slot: number; name: string }>;
    // The single-slot resolver dropped slots 1..6 from the portable .zip: a
    // performance with 7 videos lost 6 of them.
    expect(out.map((r) => r.slot)).toEqual([0, 2]);
    expect(out.map((r) => r.name)).toEqual(['a.webm', 'c.webm']);
  });

  it('yields null when nothing is loaded, and UNREGISTERS on dispose', async () => {
    const c = makeClock(); const f = makeFrames(); const eng = makeEngine();
    const h = makeHarness(c.clock, f.frames, eng.engine);
    h.state.set('v1', { isPlaying: false, loop: true, crop: null });
    const reg = createNodeVarispeedRegistry(h.deps, h.hooks);
    reg.sync([vvNode('v1')], eng.engine);
    expect(await h.exports.get('v1')!()).toBeNull();
    reg.sweep([]);
    expect(h.exports.has('v1'), 'a deleted node left a resolver behind').toBe(false);
  });
});

describe('the crop ASPECT RE-FIT is the node\'s, not a card $effect', () => {
  it('re-persists the stored rect when the OUTPUT aspect flips', () => {
    const c = makeClock(); const f = makeFrames(); const eng = makeEngine();
    const h = makeHarness(c.clock, f.frames, eng.engine);
    // The binding coerces the raw rect against the live aspect, so `crop` is
    // ALREADY the re-fitted value; the controller's job is noticing the aspect
    // moved and writing that value back.
    h.state.set('v1', {
      isPlaying: false, loop: true,
      outAspect: 4 / 3,
      rawCrop: { x: 0.1, y: 0.2, w: 0.5 },
      crop: { x: 0.1, y: 0.2, w: 0.5 },
    });
    const reg = createNodeVarispeedRegistry(h.deps, h.hooks);
    reg.sync([vvNode('v1')], eng.engine);
    c.tick(HOUSEKEEPING_INTERVAL_MS);
    expect(h.cropWrites, 'an unchanged rect was re-written — a write storm').toHaveLength(0);

    const s = h.state.get('v1')!;
    s.outAspect = 16 / 9;
    s.crop = { x: 0.1, y: 0.25, w: 0.5 }; // what the new aspect coerces it to
    c.tick(HOUSEKEEPING_INTERVAL_MS);
    expect(
      h.cropWrites,
      'a rack whose aspect flipped with no surface mounted kept a rect invalid for the new aspect',
    ).toHaveLength(1);
    expect(h.cropWrites[0]!.rect.y).toBeCloseTo(0.25, 10);
  });

  it('writes nothing when there is no ACTIVE crop', () => {
    const c = makeClock(); const f = makeFrames(); const eng = makeEngine();
    const h = makeHarness(c.clock, f.frames, eng.engine);
    h.state.set('v1', { isPlaying: false, loop: true, crop: null, outAspect: 4 / 3 });
    const reg = createNodeVarispeedRegistry(h.deps, h.hooks);
    reg.sync([vvNode('v1')], eng.engine);
    h.state.get('v1')!.outAspect = 16 / 9;
    c.tick(HOUSEKEEPING_INTERVAL_MS);
    expect(h.cropWrites).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// ⚠ SAME-SESSION LOAD AT A REUSED ID (fleet audit 2026-09-06, finding #3)
//
// Same shape as videobox, per slot: `loadEnvelopeIntoStore` re-inserts the
// node at its SAME id, the controller and its seven elements survive, and
// patch v2's per-slot handle ids arrive as a DOC CHANGE on slots still
// holding v1's bytes. The reload pump used to latch "attempted" per slot and
// short-circuit on "has bytes", so v1 kept PLAYING — ×7 slots. The asset
// picker writing a fresh `fileMeta` onto a populated node is the same case.
// ---------------------------------------------------------------------------

describe('⚠ SAME-SESSION LOAD AT A REUSED ID — a slot re-attaches on a CHANGE of handle id', () => {
  async function settle(): Promise<void> {
    for (let i = 0; i < 16; i++) await Promise.resolve();
  }
  function countingGets(h: Harness): string[] {
    const gets: string[] = [];
    const orig = h.hooks.get;
    h.hooks.get = async (id) => { gets.push(id); return orig(id); };
    return gets;
  }

  it('patch v2 at the SAME node id REPLACES slot 0\'s bytes on air', async () => {
    const c = makeClock(); const f = makeFrames(); const eng = makeEngine();
    const h = makeHarness(c.clock, f.frames, eng.engine);
    h.handles.set('h-v1', { perm: 'granted', file: fakeVideo('v1.webm') });
    h.handles.set('h-v2', { perm: 'granted', file: fakeVideo('v2.webm') });
    h.state.set('v1', {
      isPlaying: true, loop: true, crop: null,
      fileMeta: { name: 'v1.webm', duration: 10, handleId: 'h-v1' },
    });
    const reg = createNodeVarispeedRegistry(h.deps, h.hooks);
    reg.sync([vvNode('v1')], eng.engine);
    await settle();
    const el0 = h.els.get(`v1::${varispeedSlotKey(0)}`)!;
    expect(el0.src, 'the saved rack restores v1').toBe('blob:v1.webm');
    expect(reg.view('v1').slotNames[0]).toBe('v1.webm');

    // THE LOAD: the doc's slot-0 meta moves to v2's handle; the node id,
    // the controller and the element are all the same.
    h.state.get('v1')!.fileMeta = { name: 'v2.webm', duration: 10, handleId: 'h-v2' };
    c.tick(HOUSEKEEPING_INTERVAL_MS);
    await settle();
    expect(el0.src, 'v2\'s bytes are on the element').toBe('blob:v2.webm');
    expect(reg.view('v1').slotNames[0]).toBe('v2.webm');
    expect(h.metaWrites.at(-1)?.meta).toMatchObject({ name: 'v2.webm', handleId: 'h-v2' });
  });

  it('slots 1..6 re-attach from their OWN slotMeta row, and untouched slots stay put', async () => {
    const c = makeClock(); const f = makeFrames(); const eng = makeEngine();
    const h = makeHarness(c.clock, f.frames, eng.engine);
    h.handles.set('h-3a', { perm: 'granted', file: fakeVideo('three-a.webm') });
    h.handles.set('h-3b', { perm: 'granted', file: fakeVideo('three-b.webm') });
    h.handles.set('h-5', { perm: 'granted', file: fakeVideo('five.webm') });
    const slotMeta = new Array(ASSET_SLOTS).fill(null);
    slotMeta[3] = { name: 'three-a.webm', duration: 3, handleId: 'h-3a' };
    slotMeta[5] = { name: 'five.webm', duration: 5, handleId: 'h-5' };
    h.state.set('v1', { isPlaying: false, loop: true, crop: null, slotMeta });
    const reg = createNodeVarispeedRegistry(h.deps, h.hooks);
    reg.sync([vvNode('v1')], eng.engine);
    await settle();
    expect(reg.view('v1').slotNames[3]).toBe('three-a.webm');
    expect(reg.view('v1').slotNames[5]).toBe('five.webm');
    const gets = countingGets(h);

    const loaded = [...h.state.get('v1')!.slotMeta!];
    loaded[3] = { name: 'three-b.webm', duration: 3, handleId: 'h-3b' };
    h.state.get('v1')!.slotMeta = loaded;
    c.tick(HOUSEKEEPING_INTERVAL_MS);
    await settle();
    expect(h.els.get(`v1::${varispeedSlotKey(3)}`)!.src).toBe('blob:three-b.webm');
    expect(reg.view('v1').slotNames[3]).toBe('three-b.webm');
    expect(reg.view('v1').slotNames[5], 'slot 5 was not touched').toBe('five.webm');
    expect(gets, 'only the CHANGED slot hit the store').toEqual(['h-3b']);
  });

  it('STEADY STATE is quiet, and a PEER\'s unknown handle is tried once with v1 kept on air', async () => {
    const c = makeClock(); const f = makeFrames(); const eng = makeEngine();
    const h = makeHarness(c.clock, f.frames, eng.engine);
    h.handles.set('h-v1', { perm: 'granted', file: fakeVideo('v1.webm') });
    h.state.set('v1', {
      isPlaying: false, loop: true, crop: null,
      fileMeta: { name: 'v1.webm', duration: 10, handleId: 'h-v1' },
    });
    const reg = createNodeVarispeedRegistry(h.deps, h.hooks);
    reg.sync([vvNode('v1')], eng.engine);
    await settle();
    const gets = countingGets(h);
    const writes = h.metaWrites.length;
    for (let i = 0; i < 8; i++) { c.tick(HOUSEKEEPING_INTERVAL_MS); await settle(); }
    expect(gets, 'an unchanged doc never reads the store').toEqual([]);
    expect(h.metaWrites.length, 'and never re-writes').toBe(writes);

    h.state.get('v1')!.fileMeta = { name: 'peer.webm', duration: 3, handleId: 'h-peer' };
    for (let i = 0; i < 5; i++) { c.tick(HOUSEKEEPING_INTERVAL_MS); await settle(); }
    expect(gets, 'one attempt for the peer id, not one per pump').toEqual(['h-peer']);
    expect(h.els.get(`v1::${varispeedSlotKey(0)}`)!.src, 'local bytes not blanked').toBe('blob:v1.webm');
  });

  it('a controller RE-CREATED over live bytes records the saved handles instead of re-loading', async () => {
    const c = makeClock(); const f = makeFrames(); const eng = makeEngine();
    const h = makeHarness(c.clock, f.frames, eng.engine);
    h.handles.set('h-v1', { perm: 'granted', file: fakeVideo('v1.webm') });
    h.handles.set('h-v2', { perm: 'granted', file: fakeVideo('v2.webm') });
    h.state.set('v1', {
      isPlaying: false, loop: true, crop: null,
      fileMeta: { name: 'v1.webm', duration: 10, handleId: 'h-v1' },
    });
    const reg = createNodeVarispeedRegistry(h.deps, h.hooks);
    reg.sync([vvNode('v1')], eng.engine);
    await settle();
    const gets = countingGets(h);
    reg.disposeNode('v1');
    reg.sync([vvNode('v1')], eng.engine);
    c.tick(HOUSEKEEPING_INTERVAL_MS);
    await settle();
    expect(gets, 'bytes already on air are not re-read').toEqual([]);
    h.state.get('v1')!.fileMeta = { name: 'v2.webm', duration: 10, handleId: 'h-v2' };
    c.tick(HOUSEKEEPING_INTERVAL_MS);
    await settle();
    expect(h.els.get(`v1::${varispeedSlotKey(0)}`)!.src).toBe('blob:v2.webm');
  });
});
