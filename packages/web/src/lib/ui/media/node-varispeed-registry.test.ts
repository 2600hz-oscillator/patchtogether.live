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
import {
  createNodeVarispeedRegistry,
  varispeedSlotKey,
  NODE_VARISPEED_TYPES,
  NO_VARISPEED,
  CV_INTERVAL_MS,
  VARISPEED_DEFAULT_LOOP,
  type VarispeedDeps,
  type VarispeedEngine,
  type VarispeedStatus,
} from './node-varispeed-registry';

interface FakeEl {
  time: number;
  paused: boolean;
  muted: boolean;
  rate: number;
  dur: number;
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

interface Harness {
  deps: VarispeedDeps<FakeEl>;
  els: Map<string, FakeEl>;
  names: Map<string, string | null>;
  statuses: Array<{ nodeId: string; status: VarispeedStatus }>;
  state: Map<string, { isPlaying: boolean; loop?: boolean; crop: unknown | null }>;
  playWrites: Array<{ nodeId: string; v: boolean }>;
  loopWrites: Array<{ nodeId: string; v: boolean }>;
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
  const k = (n: string, s: string) => `${n}::${s}`;
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
    },
    media: {
      ensure: (nodeId, slot) => {
        const key = k(nodeId, slot);
        let el = els.get(key);
        if (!el) { el = { time: 0, paused: true, muted: false, rate: 1, dur: 10 }; els.set(key, el); }
        return el;
      },
      mediaName: (nodeId, slot) => names.get(k(nodeId, slot)) ?? null,
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
    },
    clock,
    frames,
    onStatus: (nodeId, status) => { statuses.push({ nodeId, status }); },
  };
  return { deps, els, names, statuses, state, playWrites, loopWrites };
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
