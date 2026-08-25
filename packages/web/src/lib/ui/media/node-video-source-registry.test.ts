// packages/web/src/lib/ui/media/node-video-source-registry.test.ts
//
// The node-owned video source lifecycle (LEG-02, #1511), driven against fakes.
//
// WHAT THIS GATE IS FOR. The defect class is "the source exists only because a
// card is mounted", and its tell is that everything looks fine while a card
// happens to be there. So every leg below runs with NO card anywhere — there is
// no component in this file at all — and asserts the source works regardless.
// A leg that needed a mount would be re-testing the bug.
//
// ⚠ AND THE NEGATIVE CONTROL MATTERS MORE THAN USUAL HERE, because the failure
// mode is silence: an unattached element still exists, still holds its url, and
// still reports a filename. `attach` is the only observable that separates "the
// source is live" from "the source is a decoded file nobody is sampling", so the
// controls below perturb the ENGINE and confirm the reading moves.

import { describe, it, expect } from 'vitest';
import type { ModuleNode } from '$lib/graph/types';
// Side-effect imports register the globs; the list functions then see them.
import '$lib/audio/modules';
import '$lib/video/modules';
import { listModuleDefs } from '$lib/audio/module-registry';
import { listVideoModuleDefs } from '$lib/video/module-registry';
import {
  createNodeVideoSourceRegistry,
  NODE_VIDEO_SOURCE_TYPES,
  NO_VIDEO_SOURCE,
  VIDEO_SOURCE_SLOT,
  DRIFT_INTERVAL_MS,
  GATE_INTERVAL_MS,
  type VideoSourceDeps,
  type VideoSourceEngine,
  type VideoSourceStatus,
} from './node-video-source-registry';

// ---------------------------------------------------------------------------
// The fake world
// ---------------------------------------------------------------------------

interface FakeEl {
  src: string | null;
  muted: boolean;
  time: number;
  paused: boolean;
  dur: number;
}

/** A controllable clock: timers only fire when the test advances them, so a leg
 *  asserting "the drift loop corrected" cannot pass on a real-timer accident. */
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
    /** Fire every timer registered at `ms`, `times` times. */
    tick(ms: number, times = 1): void {
      for (let i = 0; i < times; i++) {
        for (const t of [...timers.values()]) if (t.ms === ms) t.fn();
      }
    },
    advance(byMs: number): void { now += byMs; },
    live: () => timers.size,
  };
}

function makeEngine(overrides: Partial<VideoSourceEngine> = {}) {
  const attached = new Map<string, unknown>();
  let audioWired = false;
  let materialized = true;
  const params = new Map<string, number>();
  const engine: VideoSourceEngine = {
    attach: (nodeId, el) => { if (materialized) attached.set(nodeId, el); },
    hasElement: (nodeId) => attached.get(nodeId) != null,
    extras: (nodeId) =>
      materialized && attached.get(nodeId) != null
        ? { wireAudio: () => { audioWired = true; }, isAudioWired: () => audioWired }
        : null,
    readParam: (node, p) => params.get(`${node.id}:${p}`),
    ...overrides,
  };
  return {
    engine,
    attached,
    isAudioWired: () => audioWired,
    setMaterialized: (v: boolean) => { materialized = v; },
    setParam: (nodeId: string, p: string, v: number) => params.set(`${nodeId}:${p}`, v),
  };
}

interface Harness {
  deps: VideoSourceDeps<FakeEl>;
  els: Map<string, FakeEl>;
  urls: Map<string, string | null>;
  names: Map<string, string | null>;
  writes: Array<{ nodeId: string; isPlaying: boolean; pos: number }>;
  metas: Array<{ nodeId: string; name: string; resetPlayhead: boolean }>;
  statuses: Array<{ nodeId: string; status: VideoSourceStatus }>;
  exports: Map<string, () => Promise<unknown>>;
  state: Map<string, { fileMeta: { name: string; duration: number; handleId?: string } | null; isPlaying: boolean; lastSyncTime: number; lastSyncPosition: number }>;
}

function makeHarness(clock: ReturnType<typeof makeClock>['clock'], engine: VideoSourceEngine | null): Harness {
  const els = new Map<string, FakeEl>();
  const urls = new Map<string, string | null>();
  const names = new Map<string, string | null>();
  const writes: Harness['writes'] = [];
  const metas: Harness['metas'] = [];
  const statuses: Harness['statuses'] = [];
  const exports = new Map<string, () => Promise<unknown>>();
  const state: Harness['state'] = new Map();
  const key = (n: string, s: string) => `${n}::${s}`;
  const deps: VideoSourceDeps<FakeEl> = {
    engine,
    doc: {
      read: (nodeId) => state.get(nodeId) ?? null,
      writeSync: (nodeId, next) => {
        writes.push({ nodeId, isPlaying: next.isPlaying, pos: next.currentPositionSec });
        const s = state.get(nodeId);
        if (s) { s.isPlaying = next.isPlaying; s.lastSyncPosition = next.currentPositionSec; s.lastSyncTime = 1_000; }
      },
      writeFileMeta: (nodeId, meta, opts) => {
        metas.push({ nodeId, name: meta.name, resetPlayhead: opts.resetPlayhead });
        const s = state.get(nodeId);
        if (s) s.fileMeta = { name: meta.name, duration: meta.duration, handleId: meta.handleId };
      },
    },
    media: {
      ensure: (nodeId, slot) => {
        const k = key(nodeId, slot);
        let el = els.get(k);
        if (!el) { el = { src: null, muted: true, time: 0, paused: true, dur: 10 }; els.set(k, el); }
        return el;
      },
      objectUrl: (nodeId, slot) => urls.get(key(nodeId, slot)) ?? null,
      setObjectUrl: (nodeId, slot, url, name) => {
        urls.set(key(nodeId, slot), url);
        names.set(key(nodeId, slot), url === null ? null : (name ?? null));
      },
      mediaName: (nodeId, slot) => names.get(key(nodeId, slot)) ?? null,
    },
    el: {
      setSrc: (el, url) => { el.src = url; },
      setMuted: (el, m) => { el.muted = m; },
      currentTime: (el) => el.time,
      seek: (el, to) => { el.time = to; },
      paused: (el) => el.paused,
      play: (el) => { el.paused = false; },
      pause: (el) => { el.paused = true; },
      duration: (el) => el.dur,
      awaitMetadata: () => Promise.resolve(),
    },
    clock,
    createObjectUrl: (file) => `blob:${file.name}`,
    registerExport: (nodeId, resolve) => { exports.set(nodeId, resolve); },
    unregisterExport: (nodeId) => { exports.delete(nodeId); },
    fetchBytes: async () => new Uint8Array([1, 2, 3]),
    onStatus: (nodeId, status) => { statuses.push({ nodeId, status }); },
  };
  return { deps, els, urls, names, writes, metas, statuses, exports, state };
}

function videoboxNode(id: string): ModuleNode {
  return { id, type: 'videobox', domain: 'video' } as unknown as ModuleNode;
}

function fakeFile(name: string, type = 'video/mp4'): File {
  return { name, type, size: 1234 } as unknown as File;
}

// ---------------------------------------------------------------------------

describe('NODE_VIDEO_SOURCE_TYPES — the ownership declaration', () => {
  it('every declared type is a REGISTERED module def', () => {
    const known = new Set<string>([
      ...listModuleDefs().map((d) => (d as { type: string }).type),
      ...listVideoModuleDefs().map((d) => (d as { type: string }).type),
    ]);
    const ghosts = [...NODE_VIDEO_SOURCE_TYPES].filter((t) => !known.has(t));
    expect(ghosts, `declared owner type(s) with no module def: ${ghosts.join(', ')}`).toEqual([]);
  });

  it('is non-empty — an empty owner set makes every disjointness claim vacuous', () => {
    expect(NODE_VIDEO_SOURCE_TYPES.size).toBeGreaterThan(0);
  });
});

describe('the source exists because the NODE exists — no card, ever', () => {
  it('ensures and ATTACHES the element on sync, with nothing mounted', () => {
    const c = makeClock();
    const eng = makeEngine();
    const h = makeHarness(c.clock, eng.engine);
    const reg = createNodeVideoSourceRegistry(h.deps);

    expect(eng.attached.has('v1'), 'attached before any sync').toBe(false);
    reg.sync([videoboxNode('v1')], eng.engine);

    // THE WHOLE POINT: an element exists and the engine holds it, and no card
    // has been mounted at any moment in this test.
    expect(h.els.get(`v1::${VIDEO_SOURCE_SLOT}`), 'no element was ensured').toBeDefined();
    expect(eng.attached.get('v1'), 'the engine was never handed the element').toBeDefined();
    expect(reg.view('v1').attached).toBe(true);
  });

  it('NEGATIVE CONTROL: with the node NOT materialized, attach reads FALSE', () => {
    // The instrument must be able to say NO. Without this, `attached: true` could
    // be a constant and every leg above would pass against a build where nothing
    // is ever handed over.
    const c = makeClock();
    const eng = makeEngine();
    eng.setMaterialized(false);
    const h = makeHarness(c.clock, eng.engine);
    const reg = createNodeVideoSourceRegistry(h.deps);
    reg.sync([videoboxNode('v1')], eng.engine);
    expect(eng.attached.has('v1')).toBe(false);
    expect(reg.view('v1').attached).toBe(false);

    // ...and POSITIVE CONTROL in the same leg: once the node materializes, the
    // retry that is already running lands it. This is the engine's async
    // `addNode` race, which is why the retry exists at all.
    eng.setMaterialized(true);
    c.tick(100);
    expect(eng.attached.get('v1'), 'the retry never converged after materialization').toBeDefined();
    expect(reg.view('v1').attached).toBe(true);
  });

  it('a node LEAVING the graph disposes its controller and stops every loop', () => {
    const c = makeClock();
    const eng = makeEngine();
    const h = makeHarness(c.clock, eng.engine);
    const reg = createNodeVideoSourceRegistry(h.deps);
    reg.sync([videoboxNode('v1')], eng.engine);
    expect(reg.has('v1')).toBe(true);
    const livePrior = c.live();
    expect(livePrior, 'no loops were started').toBeGreaterThan(0);

    reg.sync([], eng.engine);
    expect(reg.has('v1')).toBe(false);
    expect(c.live(), 'timers outlived the node').toBe(0);
    expect(h.exports.has('v1'), 'the export resolver outlived the node').toBe(false);
    expect(reg.view('v1')).toEqual(NO_VIDEO_SOURCE);
  });

  it('does NOT detach or revoke on dispose — nodeMedia owns that, keyed to the graph', () => {
    // ⚠ The teardown this controller deliberately does NOT do. A controller
    // disposed and immediately re-created by a graph tick must not blank a
    // source that never needed to go away — that is the #1511 bug one level up.
    const c = makeClock();
    const eng = makeEngine();
    const h = makeHarness(c.clock, eng.engine);
    const reg = createNodeVideoSourceRegistry(h.deps);
    reg.sync([videoboxNode('v1')], eng.engine);
    h.names.set(`v1::${VIDEO_SOURCE_SLOT}`, 'clip.mp4');
    h.urls.set(`v1::${VIDEO_SOURCE_SLOT}`, 'blob:clip.mp4');

    reg.disposeNode('v1');
    expect(h.urls.get(`v1::${VIDEO_SOURCE_SLOT}`), 'the controller revoked a url it does not own').toBe('blob:clip.mp4');
    expect(eng.attached.get('v1'), 'the controller detached the engine source on dispose').toBeDefined();
  });
});

describe('loading — the GESTURE belongs to the surface, the LIFECYCLE does not', () => {
  it('a delivered load sets src, publishes the name and writes fileMeta', async () => {
    const c = makeClock();
    const eng = makeEngine();
    const h = makeHarness(c.clock, eng.engine);
    h.state.set('v1', { fileMeta: null, isPlaying: false, lastSyncTime: 0, lastSyncPosition: 0 });
    const reg = createNodeVideoSourceRegistry(h.deps);
    reg.sync([videoboxNode('v1')], eng.engine);

    const res = reg.request('v1', { kind: 'load', file: fakeFile('clip.mp4') });
    expect(res.delivered).toBe(true);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    expect(h.els.get(`v1::${VIDEO_SOURCE_SLOT}`)!.src).toBe('blob:clip.mp4');
    expect(reg.view('v1').fileName).toBe('clip.mp4');
    expect(h.metas.map((m) => m.name)).toContain('clip.mp4');
    // A genuinely NEW file resets the shared playhead; the same file reloaded
    // must not (that was an independent cause of "it stopped playing").
    expect(h.metas.at(-1)!.resetPlayhead).toBe(true);
  });

  it('reports delivered:false for a node with no controller — never silently drops', () => {
    const c = makeClock();
    const h = makeHarness(c.clock, makeEngine().engine);
    const reg = createNodeVideoSourceRegistry(h.deps);
    const res = reg.request('ghost', { kind: 'load', file: fakeFile('x.mp4') });
    expect(res.delivered, 'a command to a nonexistent node reported as delivered').toBe(false);
  });

  it('refuses a non-video file and publishes WHY', async () => {
    const c = makeClock();
    const eng = makeEngine();
    const h = makeHarness(c.clock, eng.engine);
    const reg = createNodeVideoSourceRegistry(h.deps);
    reg.sync([videoboxNode('v1')], eng.engine);
    reg.request('v1', { kind: 'load', file: fakeFile('notes.txt', 'text/plain') });
    await Promise.resolve();
    expect(reg.view('v1').error).toMatch(/Not a video file/);
    expect(h.els.get(`v1::${VIDEO_SOURCE_SLOT}`)!.src, 'a rejected file still set src').toBeNull();
  });

  it('wires AUDIO after a load — the silent-output half of the same bug', async () => {
    const c = makeClock();
    const eng = makeEngine();
    const h = makeHarness(c.clock, eng.engine);
    h.state.set('v1', { fileMeta: null, isPlaying: false, lastSyncTime: 0, lastSyncPosition: 0 });
    const reg = createNodeVideoSourceRegistry(h.deps);
    reg.sync([videoboxNode('v1')], eng.engine);
    expect(eng.isAudioWired(), 'audio wired before any file was loaded').toBe(false);

    reg.request('v1', { kind: 'load', file: fakeFile('clip.mp4') });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    c.tick(100);
    expect(eng.isAudioWired(), 'the element never reached the cross-domain audio bridge').toBe(true);
  });
});

describe('the three loops that used to need a mounted card', () => {
  it('DRIFT: a peer play/seek reaches the element with no card anywhere', () => {
    const c = makeClock();
    const eng = makeEngine();
    const h = makeHarness(c.clock, eng.engine);
    // A rack where a PEER has the transport running and this browser's element
    // is sitting at 0 — the exact state a collapsed card used to freeze in.
    h.state.set('v1', {
      fileMeta: { name: 'clip.mp4', duration: 30 },
      isPlaying: true,
      lastSyncTime: 1_000,
      lastSyncPosition: 12,
    });
    const reg = createNodeVideoSourceRegistry(h.deps);
    reg.sync([videoboxNode('v1')], eng.engine);
    h.names.set(`v1::${VIDEO_SOURCE_SLOT}`, 'clip.mp4');
    const el = h.els.get(`v1::${VIDEO_SOURCE_SLOT}`)!;
    expect(el.paused).toBe(true);
    expect(el.time).toBe(0);

    c.tick(DRIFT_INTERVAL_MS);

    expect(el.paused, 'the shared state said PLAYING and the element stayed paused').toBe(false);
    expect(el.time, 'the element never caught up to the shared playhead').toBeGreaterThan(1);
  });

  it('GATE: a play_trigger rising edge toggles transport with no card anywhere', () => {
    const c = makeClock();
    const eng = makeEngine();
    const h = makeHarness(c.clock, eng.engine);
    h.state.set('v1', { fileMeta: { name: 'c.mp4', duration: 30 }, isPlaying: false, lastSyncTime: 0, lastSyncPosition: 0 });
    const reg = createNodeVideoSourceRegistry(h.deps);
    reg.sync([videoboxNode('v1')], eng.engine);
    h.names.set(`v1::${VIDEO_SOURCE_SLOT}`, 'c.mp4');

    // Low, then a rising edge. Only the EDGE may write.
    eng.setParam('v1', 'cv_play_trigger', 0);
    c.tick(GATE_INTERVAL_MS);
    expect(h.writes.length, 'a LOW gate wrote transport state').toBe(0);

    eng.setParam('v1', 'cv_play_trigger', 1);
    c.tick(GATE_INTERVAL_MS);
    expect(h.writes.length, 'the rising edge did not toggle transport').toBe(1);
    expect(h.writes[0]!.isPlaying).toBe(true);

    // ...and a HELD high level must not re-fire: this is a TRIGGER, and
    // re-firing every 33 ms is the "one pulse advances two steps" shape.
    c.tick(GATE_INTERVAL_MS, 3);
    expect(h.writes.length, 'a held-high gate re-fired — edge detection is broken').toBe(1);
  });

  it('SYNC: togglePlay and seek write the shared triple through the controller', () => {
    const c = makeClock();
    const eng = makeEngine();
    const h = makeHarness(c.clock, eng.engine);
    h.state.set('v1', { fileMeta: { name: 'c.mp4', duration: 30 }, isPlaying: false, lastSyncTime: 0, lastSyncPosition: 0 });
    const reg = createNodeVideoSourceRegistry(h.deps);
    reg.sync([videoboxNode('v1')], eng.engine);
    h.names.set(`v1::${VIDEO_SOURCE_SLOT}`, 'c.mp4');
    h.els.get(`v1::${VIDEO_SOURCE_SLOT}`)!.time = 7;

    reg.request('v1', { kind: 'togglePlay' });
    expect(h.writes.at(-1)).toMatchObject({ isPlaying: true, pos: 7 });

    reg.request('v1', { kind: 'seek', toSec: 19 });
    expect(h.els.get(`v1::${VIDEO_SOURCE_SLOT}`)!.time).toBe(19);
    expect(h.writes.at(-1)!.pos).toBe(19);
  });

  it('REGRESSION: play reaches the element IMMEDIATELY, with no drift tick', () => {
    // ⚠ THIS IS A REAL DEFECT THIS CONVERSION SHIPPED AND THIS SUITE MISSED.
    // The card applied the synced triple through a Svelte `$effect`, so play
    // reached the element the moment the Y.Doc changed. The first controller
    // applied it only on the DRIFT loop — so a play click left the element
    // paused for up to DRIFT_INTERVAL_MS.
    //
    // MEASURED (videobox-output.spec.ts, `VIDEOBOX -> BENTBOX -> VIDEO-OUT`):
    // the render burst read frame 0 and BENTBOX's FBO came back a FLAT FILL,
    // while `uploads > 0` and the whole chain reported wired. Every liveness
    // guard passed; the picture was a still frame. NO drift tick is fired below
    // — that is the entire point of the leg.
    const c = makeClock();
    const eng = makeEngine();
    const h = makeHarness(c.clock, eng.engine);
    h.state.set('v1', { fileMeta: { name: 'c.mp4', duration: 30 }, isPlaying: false, lastSyncTime: 0, lastSyncPosition: 0 });
    const reg = createNodeVideoSourceRegistry(h.deps);
    reg.sync([videoboxNode('v1')], eng.engine);
    h.names.set(`v1::${VIDEO_SOURCE_SLOT}`, 'c.mp4');
    const el = h.els.get(`v1::${VIDEO_SOURCE_SLOT}`)!;
    expect(el.paused, 'precondition: the element starts paused').toBe(true);

    reg.request('v1', { kind: 'togglePlay' });

    expect(
      el.paused,
      'the element is still paused straight after a play command — transport is waiting on the drift interval',
    ).toBe(false);
  });

  it('REGRESSION: a PEER change applies on the graph tick, not on the drift tick', () => {
    // The other half of the same defect. A remote play arrives as a Y.Doc
    // change, which re-runs Canvas's sync effect — so `sync()` is the reactive
    // seam and must apply it. Again: no drift tick is fired.
    const c = makeClock();
    const eng = makeEngine();
    const h = makeHarness(c.clock, eng.engine);
    h.state.set('v1', { fileMeta: { name: 'c.mp4', duration: 30 }, isPlaying: false, lastSyncTime: 1_000, lastSyncPosition: 0 });
    const reg = createNodeVideoSourceRegistry(h.deps);
    reg.sync([videoboxNode('v1')], eng.engine);
    h.names.set(`v1::${VIDEO_SOURCE_SLOT}`, 'c.mp4');
    const el = h.els.get(`v1::${VIDEO_SOURCE_SLOT}`)!;
    expect(el.paused).toBe(true);

    // A peer presses play: the triple changes, then the graph ticks.
    h.state.get('v1')!.isPlaying = true;
    reg.sync([videoboxNode('v1')], eng.engine);

    expect(el.paused, "a peer's play never reached the local element on the graph tick").toBe(false);
  });

  it('a seek with NO local copy still writes for peers who have one', () => {
    const c = makeClock();
    const eng = makeEngine();
    const h = makeHarness(c.clock, eng.engine);
    h.state.set('v1', { fileMeta: { name: 'c.mp4', duration: 30 }, isPlaying: false, lastSyncTime: 0, lastSyncPosition: 0 });
    const reg = createNodeVideoSourceRegistry(h.deps);
    reg.sync([videoboxNode('v1')], eng.engine);
    // names map deliberately left empty: this browser never loaded the bytes.
    reg.request('v1', { kind: 'seek', toSec: 5 });
    expect(h.writes.at(-1)!.pos, 'a copy-less peer stopped propagating seeks').toBe(5);
  });
});

describe('status publication', () => {
  it('PUSHES a status on every change rather than waiting to be polled', async () => {
    const c = makeClock();
    const eng = makeEngine();
    const h = makeHarness(c.clock, eng.engine);
    h.state.set('v1', { fileMeta: null, isPlaying: false, lastSyncTime: 0, lastSyncPosition: 0 });
    const reg = createNodeVideoSourceRegistry(h.deps);
    reg.sync([videoboxNode('v1')], eng.engine);
    const before = h.statuses.length;
    reg.request('v1', { kind: 'load', file: fakeFile('clip.mp4') });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(h.statuses.length, 'no status was pushed across a load').toBeGreaterThan(before);
    expect(h.statuses.at(-1)!.nodeId).toBe('v1');
  });

  it('a surface throwing in onStatus cannot break the lifecycle', () => {
    // A view is untrusted from here: it is someone else's component. If a render
    // error could kill the controller, the source would die from a UI bug —
    // which is the dependency this whole epic removes.
    const c = makeClock();
    const eng = makeEngine();
    const h = makeHarness(c.clock, eng.engine);
    h.deps.onStatus = () => { throw new Error('render blew up'); };
    const reg = createNodeVideoSourceRegistry(h.deps);
    expect(() => reg.sync([videoboxNode('v1')], eng.engine)).not.toThrow();
    expect(eng.attached.get('v1'), 'a throwing surface prevented the attach').toBeDefined();
  });

  it('view() reports NO_VIDEO_SOURCE for an unknown node instead of throwing', () => {
    const c = makeClock();
    const h = makeHarness(c.clock, makeEngine().engine);
    const reg = createNodeVideoSourceRegistry(h.deps);
    expect(reg.view('nope')).toEqual(NO_VIDEO_SOURCE);
  });
});

describe('SCOPE — what this gate structurally cannot see', () => {
  it('reads no pixels and mounts no component, stated as an assertion', () => {
    // Every element here is a plain object. Whether the engine actually SAMPLES
    // the attached element into its FBO is the e2e's job
    // (videobox-node-lifetime.spec.ts), and no amount of green here implies it.
    const c = makeClock();
    const h = makeHarness(c.clock, makeEngine().engine);
    const reg = createNodeVideoSourceRegistry(h.deps);
    reg.sync([videoboxNode('v1')], makeEngine().engine);
    const el = h.els.get(`v1::${VIDEO_SOURCE_SLOT}`)!;
    expect(
      typeof (el as unknown as { getContext?: unknown }).getContext,
      'the fake element grew a real DOM surface — this suite would then be asserting about a browser it does not have',
    ).toBe('undefined');
  });
});
