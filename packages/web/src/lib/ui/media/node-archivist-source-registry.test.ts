// packages/web/src/lib/ui/media/node-archivist-source-registry.test.ts
//
// The node-owned ARCHIVIST source lifecycle (legacy-removal S1), driven against
// fakes. Every leg runs with NO card anywhere — there is no component in this
// file — because "the source exists only because a card is mounted" is the
// defect class, and a leg that needed a mount would be re-testing it.
//
// ⚠ THE RE-ENTRANCY LEG IS THE REASON THIS FILE MATTERS MOST, and it is written
// from a bug this extraction actually shipped into the branch before an e2e leg
// caught it. `loadItem` writes the item to the Y.Doc BEFORE attaching; that
// write moves `snapshot.nodes`, which re-runs Canvas's sync effect, which sees
// `item.identifier !== attachedIdentifier` and calls `attachMedia` AGAIN — on
// the same element, concurrently. Setting `src` restarts the resource-selection
// algorithm, so each call cancels the load the previous one was awaiting, and
// `writeDuration` writes the doc again, making the churn self-sustaining.
//
// MEASURED in the browser before the fix: `readyState 0, networkState 2
// (LOADING), buffered 0, duration NaN`, indefinitely, while `paused` was false
// and the face reported the item loaded. EVERY assertion about the search, the
// item, the graph, the transport and the element's `src` stayed GREEN. The only
// thing that could see it was a leg measuring MEDIA PROGRESS. A unit leg is
// cheaper than that and runs on every commit, so it is here.

import { describe, it, expect } from 'vitest';
import type { ModuleNode } from '$lib/graph/types';
import type { ArchivistItemMeta } from '$lib/video/modules/archivist';
import type { ArchivistDoc } from '$lib/video/modules/archivist-query';
import {
  createNodeArchivistSourceRegistry,
  ARCHIVIST_SLOTS,
  DISPLAY_INTERVAL_MS,
  GATE_INTERVAL_MS,
  NO_ARCHIVIST_SOURCE,
  NODE_ARCHIVIST_SOURCE_TYPES,
  type ArchivistSourceDeps,
  type ArchivistSourceStatus,
} from './node-archivist-source-registry';

// ---------------------------------------------------------------------------
// The fake world
// ---------------------------------------------------------------------------

function node(id: string, type = 'archivist'): ModuleNode {
  return { id, type, domain: 'video', position: { x: 0, y: 0 }, params: {} } as unknown as ModuleNode;
}

/** A fake element that RECORDS every `src` write, so a restart is visible. */
interface FakeEl {
  slot: string;
  srcWrites: string[];
  crossOrigin: string | null;
  time: number;
  dur: number;
  paused: boolean;
  ended: boolean;
  endedListeners: Set<() => void>;
}

function makeClock() {
  const iv = new Map<number, { fn: () => void; ms: number }>();
  const to = new Map<number, { fn: () => void; ms: number }>();
  let next = 1;
  return {
    clock: {
      setInterval: (fn: () => void, ms: number) => { iv.set(next, { fn, ms }); return next++; },
      clearInterval: (h: unknown) => { iv.delete(h as number); },
      setTimeout: (fn: () => void, ms: number) => { to.set(next, { fn, ms }); return next++; },
      clearTimeout: (h: unknown) => { to.delete(h as number); },
    },
    tick(ms: number, times = 1): void {
      for (let i = 0; i < times; i++) for (const t of [...iv.values()]) if (t.ms === ms) t.fn();
    },
    intervals: () => iv.size,
    timeouts: () => to.size,
  };
}

const DOC_A: ArchivistDoc = { identifier: 'ident-a', title: 'Item A', mediatype: 'movies' } as ArchivistDoc;
const DOC_B: ArchivistDoc = { identifier: 'ident-b', title: 'Item B', mediatype: 'movies' } as ArchivistDoc;

function makeHarness() {
  const elements = new Map<string, FakeEl>();
  const attaches: Array<{ nodeId: string; kind: string; el: unknown }> = [];
  const statuses: Array<{ nodeId: string; status: ArchivistSourceStatus }> = [];
  const docItem = new Map<string, ArchivistItemMeta | null>();
  const docPlaying = new Map<string, boolean>();
  const docWrites: string[] = [];
  const extrasCalls: string[] = [];
  const clock = makeClock();
  let audioWired = false;
  let hasSource = false;
  let params = new Map<string, number>();
  let searchDocs: ArchivistDoc[] = [DOC_A];
  let fetchFails = false;
  let metadataOk = true;
  let concreteType: 'video' | 'audio' | 'image' = 'video';
  /** How the fake element resolves its metadata wait. */
  let metaResolves = true;
  let pickCursor = 0;

  const el = (slot: string): FakeEl => {
    let e = elements.get(slot);
    if (!e) {
      e = {
        slot, srcWrites: [], crossOrigin: null, time: 0, dur: 120,
        paused: true, ended: false, endedListeners: new Set(),
      };
      elements.set(slot, e);
    }
    return e;
  };

  const deps: ArchivistSourceDeps<FakeEl> = {
    engine: {
      attach: (nodeId, kind, e) => { attaches.push({ nodeId, kind, el: e }); hasSource = e !== null; },
      hasSource: () => hasSource,
      extras: () => ({
        wireAudio: () => { extrasCalls.push('wireAudio'); audioWired = true; },
        unwireAudio: () => { extrasCalls.push('unwireAudio'); audioWired = false; },
        isAudioWired: () => audioWired,
        setPlayhead: (f) => { extrasCalls.push(`playhead:${f.toFixed(2)}`); },
        setPlaying: (on) => { extrasCalls.push(`playing:${on}`); },
        fireLoaded: () => { extrasCalls.push('loaded'); },
        fireEnded: () => { extrasCalls.push('ended'); },
      }),
      readParam: (_n, p) => params.get(p),
    },
    media: { ensure: (_nodeId, slot) => el(slot) },
    el: {
      setCrossOrigin: (e, v) => { e.crossOrigin = v; },
      setSrc: (e, url) => { e.srcWrites.push(url); e.time = 0; },
      awaitImageLoad: async () => metaResolves,
      awaitMetadata: async () => metaResolves,
      duration: (e) => e.dur,
      currentTime: (e) => e.time,
      seek: (e, t) => { e.time = t; },
      paused: (e) => e.paused,
      ended: (e) => e.ended,
      play: (e) => { e.paused = false; },
      pause: (e) => { e.paused = true; },
      onEnded: (e, fn) => { e.endedListeners.add(fn); return () => e.endedListeners.delete(fn); },
    },
    io: {
      searchUrl: () => 'https://mock/search',
      fetchJson: async () => {
        if (fetchFails) throw new Error('offline');
        return {};
      },
      metadataUrl: (id) => `https://mock/metadata/${id}`,
      parseSearch: () => searchDocs,
      parseMetadata: (_j, id) =>
        ({
          identifier: id,
          title: `Title ${id}`,
          restricted: !metadataOk,
          files: [{ name: 'f.webm', format: 'webm' }],
        }) as never,
      // ⚠ ROTATES rather than always returning [0]. The real `pickRandomDoc` is
      // random and `loadRandomFromDocs` skips docs it has already tried, so a
      // fake that always answers the same one makes the auto-advance loop exit
      // after ONE attempt — and the leg that measures advancing past an
      // unplayable derivative would pass without ever advancing.
      pickRandomDoc: (docs) => docs[pickCursor++ % docs.length] ?? null,
      pickBestFile: (files) => files[0] ?? null,
      fileUrl: (_m, name) => `https://mock/file/${name}`,
      concreteTypeFromMediatype: () => concreteType,
      hasCleanOutput: () => true,
    },
    doc: {
      query: () => ({ term: 'x', mediatype: concreteType, yearFrom: null, yearTo: null }),
      item: (nodeId) => docItem.get(nodeId) ?? null,
      isPlaying: (nodeId) => docPlaying.get(nodeId) ?? false,
      writeItem: (nodeId, meta) => { docWrites.push(`item:${meta?.identifier ?? 'null'}`); docItem.set(nodeId, meta); docPlaying.set(nodeId, false); },
      writePlaying: (nodeId, on) => { docWrites.push(`playing:${on}`); docPlaying.set(nodeId, on); },
      writeDuration: (nodeId, identifier, d) => {
        docWrites.push(`duration:${d}`);
        const cur = docItem.get(nodeId);
        if (cur && cur.identifier === identifier) docItem.set(nodeId, { ...cur, duration: d });
      },
    },
    clock: clock.clock,
    onStatus: (nodeId, status) => { statuses.push({ nodeId, status }); },
  };

  return {
    deps, elements, attaches, statuses, docItem, docPlaying, docWrites, extrasCalls, clock,
    el,
    setSearchDocs: (d: ArchivistDoc[]) => { searchDocs = d; },
    setFetchFails: (v: boolean) => { fetchFails = v; },
    setMetadataOk: (v: boolean) => { metadataOk = v; },
    setMetaResolves: (v: boolean) => { metaResolves = v; },
    setConcreteType: (t: 'video' | 'audio' | 'image') => { concreteType = t; },
    setParam: (p: string, v: number) => { params.set(p, v); },
    async settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); },
  };
}

type Harness = ReturnType<typeof makeHarness>;
const build = (h: Harness) => createNodeArchivistSourceRegistry(h.deps);

// ---------------------------------------------------------------------------

describe('NODE_ARCHIVIST_SOURCE_TYPES', () => {
  it('names archivist and nothing else, and is non-empty', () => {
    expect([...NODE_ARCHIVIST_SOURCE_TYPES].sort()).toEqual(['archivist']);
    expect(NODE_ARCHIVIST_SOURCE_TYPES.size).toBeGreaterThan(0);
  });
});

describe('sync — three elements per node, on GRAPH lifetime', () => {
  it('ensures all THREE slots with no host, and ignores other types', () => {
    const h = makeHarness();
    const r = build(h);
    r.sync([node('a'), node('b', 'loopback')], h.deps.engine);
    expect([...h.elements.keys()].sort()).toEqual(['audio', 'image', 'video']);
    expect(r.has('a')).toBe(true);
    expect(r.has('b')).toBe(false);
  });

  it('arms BOTH polling loops, and a node leaving the graph ends them', () => {
    const h = makeHarness();
    const r = build(h);
    r.sync([node('a')], h.deps.engine);
    expect(h.clock.intervals()).toBe(2); // the gate poll + the display refresh
    r.sync([], h.deps.engine);
    expect(h.clock.intervals()).toBe(0);
    expect(r.view('a')).toEqual(NO_ARCHIVIST_SOURCE);
  });
});

describe('⚠ RE-ENTRANCY — the bug an e2e progress leg caught and every other gate missed', () => {
  it('a sync provoked by the load\'s OWN doc write does NOT restart the element', async () => {
    // The exact sequence: search → writeItem → (Canvas re-syncs on that write) →
    // attachMedia called again while the first is awaiting metadata. ONE `src`
    // write must reach the element; a second cancels the first load.
    const h = makeHarness();
    const r = build(h);
    r.sync([node('a')], h.deps.engine);
    r.request('a', { kind: 'search' });
    // Interleave graph ticks the way Canvas does, while the load is in flight.
    for (let i = 0; i < 5; i++) {
      r.sync([node('a')], h.deps.engine);
      await Promise.resolve();
    }
    await h.settle();
    r.sync([node('a')], h.deps.engine);
    await h.settle();
    expect(
      h.el('video').srcWrites,
      'the element was re-src\'d — each write restarts the load and cancels the previous one',
    ).toEqual(['https://mock/file/f.webm']);
  });

  it('NEGATIVE CONTROL: a genuinely DIFFERENT item DOES re-src', async () => {
    // The guard must not become "never attach again", which would leave a peer's
    // tune sitting in the document — the defect the sync reaction exists for.
    const h = makeHarness();
    const r = build(h);
    r.sync([node('a')], h.deps.engine);
    r.request('a', { kind: 'search' });
    await h.settle();
    expect(h.el('video').srcWrites).toHaveLength(1);
    h.setSearchDocs([DOC_B]);
    r.request('a', { kind: 'search' });
    await h.settle();
    expect(h.el('video').srcWrites).toHaveLength(2);
  });

  it('a PEER\'s item lands through the graph tick, with no local gesture', async () => {
    const h = makeHarness();
    const r = build(h);
    r.sync([node('a')], h.deps.engine);
    await h.settle();
    expect(h.el('video').srcWrites).toHaveLength(0);
    // A rack-mate writes an item into the shared document.
    h.docItem.set('a', {
      identifier: 'peer-1', title: 'Peer pick', type: 'video',
      fileUrl: 'https://mock/file/peer.webm', duration: 0, cleanOutput: true,
    });
    r.sync([node('a')], h.deps.engine);
    await h.settle();
    expect(h.el('video').srcWrites).toEqual(['https://mock/file/peer.webm']);
  });

  it('a failed attach RELEASES the claim, so the next candidate can attach', async () => {
    const h = makeHarness();
    h.setSearchDocs([DOC_A, DOC_B]);
    h.setMetaResolves(false);
    const r = build(h);
    r.sync([node('a')], h.deps.engine);
    r.request('a', { kind: 'search' });
    await h.settle();
    // Every candidate was tried rather than the first one wedging the claim.
    expect(h.el('video').srcWrites.length).toBeGreaterThan(1);
    expect(r.view('a').errorMsg).toMatch(/Could not find a playable item/);
  });
});

describe('the load chain', () => {
  it('a search attaches, wires audio, fires LOADED and writes the duration', async () => {
    const h = makeHarness();
    const r = build(h);
    r.sync([node('a')], h.deps.engine);
    r.request('a', { kind: 'search' });
    await h.settle();
    expect(h.docItem.get('a')?.identifier).toBe('ident-a');
    expect(h.attaches.at(-1)).toMatchObject({ nodeId: 'a', kind: 'video' });
    expect(h.extrasCalls).toContain('wireAudio');
    expect(h.extrasCalls).toContain('loaded');
    expect(h.docWrites).toContain('duration:120');
    expect(r.view('a').loading).toBe(false);
    expect(r.view('a').errorMsg).toBeNull();
  });

  it('an IMAGE item attaches on the image kind and never wires audio', async () => {
    const h = makeHarness();
    h.setConcreteType('image');
    const r = build(h);
    r.sync([node('a')], h.deps.engine);
    h.extrasCalls.length = 0;
    r.request('a', { kind: 'search' });
    await h.settle();
    expect(h.attaches.at(-1)).toMatchObject({ kind: 'image' });
    expect(h.extrasCalls).not.toContain('wireAudio');
    // ⚠ AND NO DURATION IS WRITTEN — an image has none, and writing 0 would put
    // a seek bar with a zero max on every surface.
    expect(h.docWrites.some((w) => w.startsWith('duration:'))).toBe(false);
  });

  it('crossOrigin is set per TYPE — and REMOVED for video, never blanked', async () => {
    // ⚠ NOT INTERCHANGEABLE. archive.org video lacks CORS, and setting
    // crossorigin at all BLOCKS PLAYBACK ENTIRELY; audio and images need
    // 'anonymous' or their output is tainted and silent/unsampleable.
    const h = makeHarness();
    const r = build(h);
    r.sync([node('a')], h.deps.engine);
    r.request('a', { kind: 'search' });
    await h.settle();
    expect(h.el('video').crossOrigin).toBeNull();

    const h2 = makeHarness();
    h2.setConcreteType('audio');
    const r2 = build(h2);
    r2.sync([node('a')], h2.deps.engine);
    r2.request('a', { kind: 'search' });
    await h2.settle();
    expect(h2.el('audio').crossOrigin).toBe('anonymous');
  });

  it('a failed SEARCH reports recovery text and stops loading', async () => {
    const h = makeHarness();
    h.setFetchFails(true);
    const r = build(h);
    r.sync([node('a')], h.deps.engine);
    r.request('a', { kind: 'search' });
    await h.settle();
    expect(r.view('a').errorMsg).toMatch(/Search failed/);
    expect(r.view('a').loading).toBe(false);
  });

  it('an EMPTY result set says so rather than spinning', async () => {
    const h = makeHarness();
    h.setSearchDocs([]);
    const r = build(h);
    r.sync([node('a')], h.deps.engine);
    r.request('a', { kind: 'search' });
    await h.settle();
    expect(r.view('a').errorMsg).toMatch(/No results/);
    expect(r.view('a').docCount).toBe(0);
  });

  it('↻ NEXT re-rolls the SAME page rather than refetching', async () => {
    const h = makeHarness();
    h.setSearchDocs([DOC_A, DOC_B]);
    const r = build(h);
    r.sync([node('a')], h.deps.engine);
    r.request('a', { kind: 'search' });
    await h.settle();
    const writesAfterSearch = h.el('video').srcWrites.length;
    r.request('a', { kind: 'next' });
    await h.settle();
    // A re-roll re-attaches (a different doc), but does NOT run a fresh search.
    expect(r.view('a').docCount).toBe(2);
    expect(h.el('video').srcWrites.length).toBeGreaterThanOrEqual(writesAfterSearch);
  });

  it('↻ NEXT with NO page runs a search instead of doing nothing', async () => {
    const h = makeHarness();
    const r = build(h);
    r.sync([node('a')], h.deps.engine);
    r.request('a', { kind: 'next' });
    await h.settle();
    expect(h.docItem.get('a')?.identifier).toBe('ident-a');
  });
});

describe('a SAVED rack comes back attached, with no card and no gesture', () => {
  it('an item already on the node is attached when the CONTROLLER is created', async () => {
    // ⚠ THE CARD DID THIS IN `onMount`, so it happened when a CARD mounted
    // rather than when the node appeared — and on the default shell it happened
    // at all only because the headless host mounted one.
    const h = makeHarness();
    h.docItem.set('a', {
      identifier: 'saved-1', title: 'Saved', type: 'video',
      fileUrl: 'https://mock/file/saved.webm', duration: 90, cleanOutput: true,
    });
    const r = build(h);
    r.sync([node('a')], h.deps.engine);
    await h.settle();
    expect(h.el('video').srcWrites).toEqual(['https://mock/file/saved.webm']);
    expect(h.attaches.at(-1)).toMatchObject({ kind: 'video' });
  });
});

describe('the transport', () => {
  async function loaded() {
    const h = makeHarness();
    const r = build(h);
    r.sync([node('a')], h.deps.engine);
    r.request('a', { kind: 'search' });
    await h.settle();
    return { h, r };
  }

  it('togglePlay writes the SHARED flag and drives the element', async () => {
    const { h, r } = await loaded();
    r.request('a', { kind: 'togglePlay' });
    expect(h.docPlaying.get('a')).toBe(true);
    expect(h.el('video').paused).toBe(false);
    r.request('a', { kind: 'togglePlay' });
    expect(h.docPlaying.get('a')).toBe(false);
    expect(h.el('video').paused).toBe(true);
  });

  it('a PEER\'s transport press lands through the graph tick', async () => {
    const { h, r } = await loaded();
    h.docPlaying.set('a', true); // a rack-mate pressed play
    r.sync([node('a')], h.deps.engine);
    expect(h.el('video').paused).toBe(false);
  });

  it('seek CLAMPS to the loaded item\'s duration, which only the owner has', async () => {
    const { h, r } = await loaded();
    r.request('a', { kind: 'seek', positionS: 9_999 });
    expect(h.el('video').time).toBeLessThanOrEqual(120);
    r.request('a', { kind: 'seek', positionS: -5 });
    expect(h.el('video').time).toBeGreaterThanOrEqual(0);
  });

  it('skip moves relative, and jumpRandom lands inside the item', async () => {
    const { h, r } = await loaded();
    r.request('a', { kind: 'seek', positionS: 10 });
    r.request('a', { kind: 'skip', deltaS: 10 });
    expect(h.el('video').time).toBeCloseTo(20, 5);
    r.request('a', { kind: 'jumpRandom' });
    expect(h.el('video').time).toBeGreaterThanOrEqual(0);
    expect(h.el('video').time).toBeLessThanOrEqual(120);
  });

  it('the ENDED event clears the shared flag and fires the gate', async () => {
    const { h, r } = await loaded();
    r.request('a', { kind: 'togglePlay' });
    for (const fn of [...h.el('video').endedListeners]) fn();
    expect(h.docPlaying.get('a')).toBe(false);
    expect(h.extrasCalls).toContain('ended');
  });
});

describe('the two polling loops', () => {
  it('a RISING EDGE on cv_play_trigger toggles play; a HELD gate does not re-fire', async () => {
    const h = makeHarness();
    const r = build(h);
    r.sync([node('a')], h.deps.engine);
    r.request('a', { kind: 'search' });
    await h.settle();
    h.setParam('cv_play_trigger', 0);
    h.clock.tick(GATE_INTERVAL_MS);
    expect(h.docPlaying.get('a')).toBe(false);
    h.setParam('cv_play_trigger', 1);
    h.clock.tick(GATE_INTERVAL_MS);
    expect(h.docPlaying.get('a')).toBe(true);
    // HELD high — the level must not re-toggle.
    h.clock.tick(GATE_INTERVAL_MS, 3);
    expect(h.docPlaying.get('a')).toBe(true);
  });

  it('the display refresh publishes the position and pushes the playhead', async () => {
    const h = makeHarness();
    const r = build(h);
    r.sync([node('a')], h.deps.engine);
    r.request('a', { kind: 'search' });
    await h.settle();
    h.el('video').time = 30;
    // The element must actually be PLAYING for `setPlaying(true)` to be the
    // right answer — reading it off a paused element would assert the loop
    // reports whatever it happens to see.
    r.request('a', { kind: 'togglePlay' });
    h.extrasCalls.length = 0;
    h.clock.tick(DISPLAY_INTERVAL_MS);
    expect(r.view('a').positionSec).toBe(30);
    expect(h.extrasCalls).toContain('playhead:0.25');
    expect(h.extrasCalls).toContain('playing:true');
  });

  it('⚠ THE POSITION IS PUBLISHED, NEVER WRITTEN TO THE DOC', async () => {
    // It ticks ten times a second. A Y.Doc write at that rate is the
    // CV-modulation write-storm shape this repo has paid for once already.
    const h = makeHarness();
    const r = build(h);
    r.sync([node('a')], h.deps.engine);
    r.request('a', { kind: 'search' });
    await h.settle();
    const before = h.docWrites.length;
    h.el('video').time = 5;
    h.clock.tick(DISPLAY_INTERVAL_MS, 10);
    expect(h.docWrites.length, 'the display refresh wrote to the graph').toBe(before);
    expect(r.view('a').positionSec).toBe(5);
  });
});

describe('the audio wire retry', () => {
  it('gives up rather than retrying for the life of the tab', async () => {
    const h = makeHarness();
    // An engine whose extras never report wired.
    h.deps.engine = {
      ...h.deps.engine!,
      extras: () => ({
        wireAudio: () => {}, unwireAudio: () => {}, isAudioWired: () => false,
        setPlayhead: () => {}, setPlaying: () => {}, fireLoaded: () => {}, fireEnded: () => {},
      }),
    };
    const r = build(h);
    r.sync([node('a')], h.deps.engine);
    r.request('a', { kind: 'search' });
    await h.settle();
    // One pending retry at a time, never a pile.
    expect(h.clock.timeouts()).toBeLessThanOrEqual(1);
  });
});

describe('teardown is a CONTENT event, never a view one', () => {
  it('disposeNode stops the loops and does NOT detach the source', async () => {
    const h = makeHarness();
    const r = build(h);
    r.sync([node('a')], h.deps.engine);
    r.request('a', { kind: 'search' });
    await h.settle();
    const attachesBefore = h.attaches.length;
    r.disposeNode('a');
    expect(h.clock.intervals()).toBe(0);
    // ⚠ NO detach. `nodeMedia.disposeNode` retires the elements when the node
    // leaves the graph; detaching here would only race that, and on a REBUILD
    // (a sync race, an undo round-trip) it would blank a live item.
    expect(h.attaches.length).toBe(attachesBefore);
  });

  it('sweep retires exactly the nodes the graph no longer has', () => {
    const h = makeHarness();
    const r = build(h);
    r.sync([node('a'), node('b')], h.deps.engine);
    r.sweep(['a']);
    expect(r.has('a')).toBe(true);
    expect(r.has('b')).toBe(false);
  });
});

describe('the status seam', () => {
  it('publishes an initial status, and request on an unknown node is not delivered', () => {
    const h = makeHarness();
    const r = build(h);
    r.sync([node('a')], h.deps.engine);
    expect(h.statuses[0]).toMatchObject({ nodeId: 'a' });
    expect(r.request('nope', { kind: 'search' })).toEqual({ delivered: false, error: null });
  });

  it('the three slots are the keys a surface adopts', () => {
    // If these drift, the controller ensures three elements and every surface
    // adopts three different empty ones — a black preview over a live item.
    expect(ARCHIVIST_SLOTS).toEqual({ video: 'video', audio: 'audio', image: 'image' });
  });
});
