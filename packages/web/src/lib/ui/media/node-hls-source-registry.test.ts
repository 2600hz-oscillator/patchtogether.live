// packages/web/src/lib/ui/media/node-hls-source-registry.test.ts
//
// The unit gate for the NODE-OWNED HLS TUNER (LEG-02 P3, #1511).
//
// ⚠ WHAT THIS FILE IS FOR, stated first because it decides what belongs here.
// The claim under test is an OWNERSHIP claim — "the stream exists because the
// node exists" — and ownership is invisible to any test that mounts a card,
// because a mounted card makes the module work either way. So every scenario
// below runs with NO CARD AT ALL, which the pure core makes possible by
// construction: the browser, hls.js, the Y.Doc and the engine are all injected.
//
// ⚠ WHAT IT STILL CANNOT SEE, stated inside the gate (see the SCOPE test):
// nothing here mounts Canvas, so nothing here proves the graph effect CALLS
// `sync`/`sweep`; nothing here decodes a frame, so nothing proves a picture
// arrives. `e2e/tests/node-source-hls.spec.ts` is the behavioural net for both,
// and `peertube.spec.ts` / `tv-librarian-audio.spec.ts` remain the real-media
// audio guards.

import { describe, it, expect } from 'vitest';

import '$lib/audio/modules';
import '$lib/video/modules';
import '$lib/meta/modules';
import { listVideoModuleDefs } from '$lib/video/module-registry';

import type { ModuleNode } from '$lib/graph/types';
import {
  createNodeHlsSourceRegistry,
  advanceByKey,
  hlsTunerProfile,
  HLS_SOURCE_SLOT,
  HLS_TUNER_PROFILES,
  NODE_HLS_SOURCE_TYPES,
  NO_HLS_SOURCE,
  PEERTUBE_PROFILE,
  TV_LIBRARIAN_PROFILE,
  GATE_INTERVAL_MS,
  PLAYHEAD_INTERVAL_MS,
  RETRY_INTERVAL_MS,
  RETRY_ATTEMPTS,
  UNAVAILABLE_SKIP_MS,
  type HlsCandidate,
  type HlsSourceStatus,
  type HlsTunerExtras,
} from './node-hls-source-registry';
import {
  CARD_PRODUCER_LANE_TYPES,
  DOM_SOURCE_LANE_TYPES,
} from '$lib/ui/workflow/dom-source-modules';

// ---------------------------------------------------------------------------
// A fake world
// ---------------------------------------------------------------------------

/** A manual clock. Intervals and timeouts fire only when `tick(ms)` is called,
 *  so nothing here depends on wall time and there is no polling to flake on. */
function fakeClock() {
  let now = 0;
  let seq = 0;
  const intervals = new Map<number, { fn: () => void; ms: number; next: number }>();
  const timeouts = new Map<number, { fn: () => void; at: number }>();
  let rng = 0;
  return {
    api: {
      setInterval(fn: () => void, ms: number) {
        const h = ++seq;
        intervals.set(h, { fn, ms, next: now + ms });
        return h;
      },
      clearInterval(h: unknown) {
        intervals.delete(h as number);
      },
      setTimeout(fn: () => void, ms: number) {
        const h = ++seq;
        timeouts.set(h, { fn, at: now + ms });
        return h;
      },
      clearTimeout(h: unknown) {
        timeouts.delete(h as number);
      },
      random: () => rng,
    },
    setRandom(v: number) {
      rng = v;
    },
    /** Advance in 1 ms steps so ordering between an interval and a timeout is
     *  the real ordering rather than a batch. */
    tick(ms: number) {
      for (let i = 0; i < ms; i++) {
        now++;
        for (const [h, t] of [...timeouts]) {
          if (t.at <= now) {
            timeouts.delete(h);
            t.fn();
          }
        }
        for (const [, iv] of [...intervals]) {
          if (iv.next <= now) {
            iv.next = now + iv.ms;
            iv.fn();
          }
        }
      }
    },
    liveIntervals: () => intervals.size,
  };
}

interface FakeEl {
  id: string;
  muted: boolean;
  src: string | null;
  paused: boolean;
  ended: boolean;
  frac: number;
  ready: boolean;
  testId: string | null;
  listeners: Map<string, Set<() => void>>;
}

function makeEl(id: string): FakeEl {
  return {
    id,
    muted: false,
    src: null,
    paused: true,
    ended: false,
    frac: 0,
    ready: false,
    testId: null,
    listeners: new Map(),
  };
}

function emit(el: FakeEl, event: string): void {
  for (const fn of [...(el.listeners.get(event) ?? [])]) fn();
}

interface Harness {
  registry: ReturnType<typeof createNodeHlsSourceRegistry<FakeEl>>;
  clock: ReturnType<typeof fakeClock>;
  els: Map<string, FakeEl>;
  data: Map<string, Record<string, unknown>>;
  /** Every `attachExternalSource` call, as `(nodeId, elementId | null)`. */
  attaches: Array<[string, string | null]>;
  /** Every hls.js instance built, as `(nodeId, url)`. */
  creates: Array<[string, string]>;
  destroys: string[];
  disposers: Map<string, (() => void) | null>;
  /** Every URL the profiles fetched, in order. */
  fetched: string[];
  /** What `fetchJson` answers, keyed by a substring of the url. */
  responses: Array<[string, unknown]>;
  fetchFails: Set<string>;
  extras: Map<string, RecordingExtras>;
  statuses: Array<[string, HlsSourceStatus]>;
  engineUp: boolean;
  params: Map<string, number>;
  node(id: string, type: string): ModuleNode;
}

interface RecordingExtras extends HlsTunerExtras {
  wired: boolean;
  wireCalls: number;
  online: boolean[];
  playing: boolean[];
  playheads: number[];
  loaded: number;
  ended: number;
  channelChanged: number;
}

function recordingExtras(): RecordingExtras {
  const e: RecordingExtras = {
    wired: false,
    wireCalls: 0,
    online: [],
    playing: [],
    playheads: [],
    loaded: 0,
    ended: 0,
    channelChanged: 0,
    wireAudio() {
      e.wireCalls++;
      e.wired = true;
    },
    unwireAudio() {
      e.wired = false;
    },
    isAudioWired: () => e.wired,
    setPlaying: (on) => {
      e.playing.push(on);
    },
    setPlayhead: (f) => {
      e.playheads.push(f);
    },
    fireLoaded: () => {
      e.loaded++;
    },
    fireEnded: () => {
      e.ended++;
    },
    setStreamOnline: (on) => {
      e.online.push(on);
    },
    pulseChannelChanged: () => {
      e.channelChanged++;
    },
  };
  return e;
}

function harness(opts: { engineUp?: boolean } = {}): Harness {
  const clock = fakeClock();
  const els = new Map<string, FakeEl>();
  const data = new Map<string, Record<string, unknown>>();
  const attaches: Array<[string, string | null]> = [];
  const creates: Array<[string, string]> = [];
  const destroys: string[] = [];
  const disposers = new Map<string, (() => void) | null>();
  const fetched: string[] = [];
  const responses: Array<[string, unknown]> = [];
  const fetchFails = new Set<string>();
  const extras = new Map<string, RecordingExtras>();
  const statuses: Array<[string, HlsSourceStatus]> = [];
  const params = new Map<string, number>();

  const h = {
    clock,
    els,
    data,
    attaches,
    creates,
    destroys,
    disposers,
    fetched,
    responses,
    fetchFails,
    extras,
    statuses,
    params,
    engineUp: opts.engineUp ?? true,
    node(id: string, type: string): ModuleNode {
      return { id, type, domain: 'video', position: { x: 0, y: 0 }, params: {} } as ModuleNode;
    },
  } as Harness;

  h.registry = createNodeHlsSourceRegistry<FakeEl>({
    engine: null,
    doc: {
      read: (nodeId) => data.get(nodeId) ?? null,
      write: (nodeId, next) => {
        const d = data.get(nodeId) ?? {};
        for (const [k, v] of Object.entries(next)) d[k] = v;
        data.set(nodeId, d);
      },
    },
    media: {
      ensure: (nodeId, slot, o) => {
        const key = `${nodeId}::${slot}`;
        let el = els.get(key);
        if (!el) {
          el = makeEl(key);
          el.testId = o.testId;
          o.init(el);
          els.set(key, el);
        }
        return el;
      },
      setDisposer: (nodeId, slot, dispose) => {
        disposers.set(`${nodeId}::${slot}`, dispose);
      },
    },
    el: {
      setSrc: (el, url) => {
        el.src = url;
      },
      clearSrc: (el) => {
        el.src = null;
      },
      setMuted: (el, muted) => {
        el.muted = muted;
      },
      play: (el) => {
        el.paused = false;
      },
      pause: (el) => {
        el.paused = true;
      },
      paused: (el) => el.paused,
      positionFrac: (el) => el.frac,
      ended: (el) => el.ended,
      hasCurrentData: (el) => el.ready,
      canPlayNativeHls: () => false,
      on: (el, event, fn) => {
        let set = el.listeners.get(event);
        if (!set) {
          set = new Set();
          el.listeners.set(event, set);
        }
        set.add(fn);
        return () => set!.delete(fn);
      },
    },
    player: {
      supported: () => true,
      create: (nodeId, _el, url, handlers) => {
        creates.push([nodeId, url]);
        (h as unknown as { handlers: Record<string, typeof handlers> }).handlers ??= {};
        (h as unknown as { handlers: Record<string, typeof handlers> }).handlers[nodeId] = handlers;
      },
      destroy: (nodeId) => {
        destroys.push(nodeId);
      },
    },
    clock: clock.api,
    io: {
      fetchJson: async (url) => {
        fetched.push(url);
        for (const frag of fetchFails) {
          if (url.includes(frag)) throw new Error(`HTTP 500 for ${frag}`);
        }
        for (const [frag, body] of responses) {
          if (url.includes(frag)) return body;
        }
        throw new Error(`no mock for ${url}`);
      },
    },
    onStatus: (nodeId, status) => {
      statuses.push([nodeId, status]);
    },
  });

  return h;
}

/** The engine adapter, built per-call so `engineUp` can flip mid-test. */
function engineOf(h: Harness) {
  return {
    attach: (nodeId: string, el: unknown) => {
      if (!h.engineUp) throw new Error('engine not ready');
      h.attaches.push([nodeId, (el as FakeEl | null)?.id ?? null]);
    },
    hasElement: (nodeId: string) =>
      h.engineUp && h.attaches.some(([id, el]) => id === nodeId && el !== null),
    extras: (nodeId: string) => {
      if (!h.engineUp) return null;
      let e = h.extras.get(nodeId);
      if (!e) {
        e = recordingExtras();
        h.extras.set(nodeId, e);
      }
      return e;
    },
    readParam: (node: ModuleNode, paramId: string) => h.params.get(`${node.id}::${paramId}`),
  };
}

function elOf(h: Harness, nodeId: string): FakeEl {
  return h.els.get(`${nodeId}::${HLS_SOURCE_SLOT}`)!;
}

function fireHls(h: Harness, nodeId: string, which: 'onManifestParsed' | 'onFatalError'): void {
  const handlers = (h as unknown as { handlers?: Record<string, Record<string, () => void>> })
    .handlers;
  handlers?.[nodeId]?.[which]?.();
}

/** Drain the microtask queue. The profiles chain three async hops (loadCatalogue
 *  -> fetchCatalogue -> fetchJson), so a fixed pair of awaits is a race dressed
 *  up as a wait — and one that would pass or fail by how many `await`s the
 *  IMPLEMENTATION happens to use, which is not what any of these tests are
 *  about. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** Two playable US channels + one youtube-only, in the famelack shape. */
const TV_CHANNELS = [
  { nanoid: 'usa1', name: 'Mock News USA', country: 'US', languages: ['eng'], stream_urls: ['https://x/usa1.m3u8'] },
  { nanoid: 'usa2', name: 'Mock Sports USA', country: 'US', languages: ['eng'], isGeoBlocked: true, stream_urls: ['https://x/usa2.m3u8'] },
  { nanoid: 'usa3', name: 'Mock Tube USA', country: 'US', languages: ['eng'], youtube_urls: ['https://youtube/x'] },
];

/** Two Sepia-Search rows. */
const PT_SEARCH = {
  data: [
    { uuid: 'u1', name: 'Clip One', duration: 12, account: { host: 'a.example' }, channel: { displayName: 'Chan A' }, thumbnailPath: '/t1.jpg' },
    { uuid: 'u2', name: 'Clip Two', duration: 20, account: { host: 'b.example' }, channel: { displayName: 'Chan B' }, thumbnailPath: '/t2.jpg' },
  ],
  total: 2,
};

const PT_DETAILS_HLS = { name: 'Clip One', streamingPlaylists: [{ playlistUrl: 'https://a.example/master.m3u8' }] };

// ---------------------------------------------------------------------------

describe('NODE_HLS_SOURCE_TYPES — the ownership anchor', () => {
  it('is DERIVED from the profiles, and every member is a registered video module', () => {
    // Derived, so a profile added without an entry (or an entry with no profile)
    // is impossible rather than merely discouraged.
    expect([...NODE_HLS_SOURCE_TYPES].sort()).toEqual(HLS_TUNER_PROFILES.map((p) => p.type).sort());
    const known = new Set(listVideoModuleDefs().map((d) => d.type));
    const ghosts = [...NODE_HLS_SOURCE_TYPES].filter((t) => !known.has(t));
    expect(ghosts, `owned type(s) with no registered video module def: ${ghosts.join(', ')}`).toEqual([]);
    expect(NODE_HLS_SOURCE_TYPES.size, 'the registry owns nothing').toBeGreaterThan(0);
  });

  it('is DISJOINT from DOM_SOURCE_LANE_TYPES — one owner per module', () => {
    // The direction that costs: a type in both would be two attach sites for one
    // element, and whichever ran last would win non-deterministically.
    const both = [...NODE_HLS_SOURCE_TYPES].filter((t) => DOM_SOURCE_LANE_TYPES.has(t));
    expect(both, `claimed by BOTH a card attach and this controller: ${both.join(', ')}`).toEqual([]);
  });

  it('every profile declares a real reason for every trigger it polls', () => {
    for (const p of HLS_TUNER_PROFILES) {
      expect(p.triggers.length, `${p.type} polls nothing`).toBeGreaterThan(0);
      for (const t of p.triggers) {
        expect(t.why.length, `${p.type}/${t.paramId} needs a real why`).toBeGreaterThan(40);
      }
    }
  });

  it('hlsTunerProfile resolves a member and refuses a non-member', () => {
    expect(hlsTunerProfile('peertube')).toBe(PEERTUBE_PROFILE);
    expect(hlsTunerProfile('tvLibrarian')).toBe(TV_LIBRARIAN_PROFILE);
    expect(hlsTunerProfile('acidwarp')).toBeNull();
  });
});

describe('THE FOUR LANE STATES — retired with the decision they measured', () => {
  // ⚠ THIS DESCRIBE USED TO DRIVE `needsHeadlessSourceMount` OVER THE FOUR LANE
  // KINDS (legacy / shell / placeholder / stub), and every leg in it retired in
  // steps its own prose predicted:
  //   * "a card-owned tuner has NO CARD AT ALL in two of the four states" ran
  //     out of subjects when `DOM_SOURCE_LANE_TYPES` emptied (S1) and was kept
  //     as a population-gone assertion;
  //   * "the DECISION still distinguishes the two halves" read its producer
  //     subject from `CARD_PRODUCER_LANE_TYPES`, which emptied in S1.5;
  //   * "a CONVERTED tuner is never hosted" became structural the moment the
  //     decision and `<HeadlessSourceHost>` were deleted — there is no host
  //     left for ANY module on ANY lane state, which is a stronger form of the
  //     payoff than the enumeration was.
  // What survives is the population statement, so a member returning to either
  // set reddens HERE and whoever brings it back knows the four-state table has
  // to come back with a real subject and a real decision — not be re-pointed
  // at a synthetic type. See dom-source-modules.ts for the retirement record.

  it('both card-owned populations are EMPTY — the state the retirement rests on', () => {
    expect(
      DOM_SOURCE_LANE_TYPES.size,
      'a card-owned DOM source exists again — the four-state table (and an owner for it) has to ' +
        'come back before this module can rely on the structural no-host guarantee',
    ).toBe(0);
    expect(
      CARD_PRODUCER_LANE_TYPES.size,
      'a card producer exists again — same consequence, producer half',
    ).toBe(0);
  });
});

describe('the controller exists BECAUSE THE NODE DOES — no card anywhere', () => {
  it('sync creates one per node, ensures a PARKED element and attaches it', () => {
    const h = harness();
    h.registry.sync([h.node('tv1', 'tvLibrarian'), h.node('pt1', 'peertube')], engineOf(h));
    expect(h.registry.has('tv1')).toBe(true);
    expect(h.registry.has('pt1')).toBe(true);
    // The ELEMENT exists with nothing mounted — that is what makes the source
    // exist before any card.
    expect(elOf(h, 'tv1')).toBeTruthy();
    expect(elOf(h, 'pt1')).toBeTruthy();
    // Created MUTED (so the programmatic play() is allowed) and carrying the
    // testid the module's own e2e locates it by. `init` runs once EVER per
    // (node, slot), so whoever CREATES the element has to apply it.
    expect(elOf(h, 'tv1').muted).toBe(true);
    expect(elOf(h, 'tv1').testId).toBe(TV_LIBRARIAN_PROFILE.elementTestId);
    expect(elOf(h, 'pt1').testId).toBe(PEERTUBE_PROFILE.elementTestId);
    // ATTACHED, with no card and without waiting for a retry tick.
    expect(h.attaches.map(([id]) => id).sort()).toEqual(['pt1', 'tv1']);
    expect(h.registry.view('tv1').attached).toBe(true);
    // Teardown is registered on the NODE, not on a card.
    expect(h.disposers.get(`tv1::${HLS_SOURCE_SLOT}`)).toBeTypeOf('function');
  });

  it('a node that does not materialize until later still gets attached, by RETRY', () => {
    const h = harness();
    h.engineUp = false;
    h.registry.sync([h.node('tv1', 'tvLibrarian')], engineOf(h));
    expect(h.attaches).toEqual([]);
    expect(h.registry.view('tv1').attached).toBe(false);
    h.engineUp = true;
    h.clock.tick(RETRY_INTERVAL_MS + 1);
    expect(h.registry.view('tv1').attached).toBe(true);
  });

  it('the retry gives up rather than spinning for the life of the rack', () => {
    const h = harness();
    h.engineUp = false;
    h.registry.sync([h.node('tv1', 'tvLibrarian')], engineOf(h));
    const before = h.clock.liveIntervals();
    h.clock.tick(RETRY_INTERVAL_MS * (RETRY_ATTEMPTS + 2));
    expect(h.clock.liveIntervals(), 'the attach retry is still running past its ceiling')
      .toBeLessThan(before);
  });

  it('sweep and disposeNode end a controller; a card never can, because there is none', () => {
    const h = harness();
    h.registry.sync([h.node('tv1', 'tvLibrarian')], engineOf(h));
    const running = h.clock.liveIntervals();
    expect(running).toBeGreaterThan(0);
    h.registry.sweep([]);
    expect(h.registry.has('tv1')).toBe(false);
    expect(h.clock.liveIntervals(), 'a disposed controller left a timer running').toBe(0);
    expect(h.registry.view('tv1')).toEqual(NO_HLS_SOURCE);
    // ⚠ DELIBERATELY ABSENT from dispose: no detach and no player.destroy. The
    // element and its demuxer belong to nodeMedia and are freed by ITS sweep, so
    // a controller re-created by a graph churn cannot blank a live stream.
    expect(h.attaches.some(([, el]) => el === null), 'dispose detached the element').toBe(false);
    expect(h.destroys, 'dispose destroyed the demuxer').toEqual([]);
    // ...and the disposer it registered is still there for `nodeMedia`'s own
    // sweep to run when the ELEMENT goes, which is the only correct moment.
    expect(h.disposers.get(`tv1::${HLS_SOURCE_SLOT}`)).toBeTypeOf('function');
  });

  it('a snapshot reports PROPERTIES per node, never a population count', () => {
    const h = harness();
    h.registry.sync([h.node('tv1', 'tvLibrarian')], engineOf(h));
    expect(h.registry.snapshot().map((s) => [s.nodeId, s.type, s.attached])).toEqual([
      ['tv1', 'tvLibrarian', true],
    ]);
  });
});

describe('DEFECT 1 — the CV poll, the catalogue and the selection run with no card', () => {
  function tunedTv(): Harness {
    const h = harness();
    h.responses.push(['/us.json', TV_CHANNELS]);
    h.data.set('tv1', { countryCode: 'us' });
    h.registry.sync([h.node('tv1', 'tvLibrarian')], engineOf(h));
    return h;
  }

  it('tvLibrarian AUTO-LOADS its channel catalogue from a persisted country', async () => {
    const h = tunedTv();
    await flush();
    const view = h.registry.view('tv1');
    // The youtube-only row is filtered out by the module's own predicate.
    expect(view.catalogue.map((c) => c.key)).toEqual(['usa1', 'usa2']);
    expect(view.catalogue[1]!.badge, 'the geo-blocked row keeps its marker').toBe('geo');
  });

  it("a rising edge on `next` advances the channel — and a HELD gate does not re-fire", async () => {
    const h = tunedTv();
    await flush();
    // Rising edge.
    h.params.set('tv1::cv_next', 1);
    h.clock.tick(GATE_INTERVAL_MS + 1);
    await flush();
    expect(h.data.get('tv1')!.channel, 'the first edge tuned nothing').toBeTruthy();
    const first = (h.data.get('tv1')!.channel as { nanoid: string }).nanoid;
    expect(first).toBe('usa1');
    // HELD HIGH — no second fire. This is the property an edge detector has and
    // a level read does not.
    h.clock.tick(GATE_INTERVAL_MS * 5);
    await flush();
    expect((h.data.get('tv1')!.channel as { nanoid: string }).nanoid).toBe('usa1');
    // Fall, then rise again -> the NEXT channel.
    h.params.set('tv1::cv_next', 0);
    h.clock.tick(GATE_INTERVAL_MS + 1);
    h.params.set('tv1::cv_next', 1);
    h.clock.tick(GATE_INTERVAL_MS + 1);
    await flush();
    expect((h.data.get('tv1')!.channel as { nanoid: string }).nanoid).toBe('usa2');
  });

  it('`random` picks a DIFFERENT one, through the module\'s own tested helper', async () => {
    const h = tunedTv();
    await flush();
    h.registry.request('tv1', { kind: 'select', candidateKey: 'usa1' });
    await flush();
    h.clock.setRandom(0);
    h.params.set('tv1::cv_random', 1);
    h.clock.tick(GATE_INTERVAL_MS + 1);
    await flush();
    // rng 0 over a pool that EXCLUDES the current one -> usa2, not usa1.
    expect((h.data.get('tv1')!.channel as { nanoid: string }).nanoid).toBe('usa2');
  });

  it('a SAVED rack tunes itself with no catalogue and no card — candidateFromData', async () => {
    const h = harness();
    // No country, so no catalogue will ever load. The persisted CHANNEL alone
    // has to be enough, which is why it is persisted in full.
    h.data.set('tv1', {
      channel: { nanoid: 'usa9', name: 'Saved', streamUrl: 'https://x/saved.m3u8', country: 'us', languages: ['eng'] },
    });
    h.registry.sync([h.node('tv1', 'tvLibrarian')], engineOf(h));
    await flush();
    expect(h.creates, 'a saved selection did not reach hls.js').toEqual([['tv1', 'https://x/saved.m3u8']]);
    expect(h.registry.view('tv1').catalogue, 'no catalogue was needed').toEqual([]);
  });

  it("a PEER's tune lands through the graph tick, with no card and no local gesture", async () => {
    const h = harness();
    h.data.set('tv1', {});
    const node = h.node('tv1', 'tvLibrarian');
    h.registry.sync([node], engineOf(h));
    expect(h.creates).toEqual([]);
    // A remote change arrives in node.data; Canvas re-runs the sync effect.
    h.data.set('tv1', {
      channel: { nanoid: 'remote', name: 'Remote', streamUrl: 'https://x/remote.m3u8', country: 'fr', languages: [] },
    });
    h.registry.sync([node], engineOf(h));
    await flush();
    expect(h.creates).toEqual([['tv1', 'https://x/remote.m3u8']]);
  });

  it('peertube publishes a PLAYHEAD and a PLAYING gate on node lifetime', () => {
    const h = harness();
    h.registry.sync([h.node('pt1', 'peertube')], engineOf(h));
    const el = elOf(h, 'pt1');
    el.paused = false;
    el.frac = 0.25;
    h.clock.tick(PLAYHEAD_INTERVAL_MS + 1);
    const ex = h.extras.get('pt1')!;
    expect(ex.playheads.at(-1)).toBe(0.25);
    expect(ex.playing.at(-1)).toBe(true);
    expect(h.registry.view('pt1').playheadFrac).toBe(0.25);
  });

  it('tvLibrarian runs NO playhead loop — a live tuner has no position to publish', () => {
    const h = harness();
    h.registry.sync([h.node('tv1', 'tvLibrarian')], engineOf(h));
    elOf(h, 'tv1').frac = 0.5;
    h.clock.tick(PLAYHEAD_INTERVAL_MS * 4);
    expect(h.extras.get('tv1')?.playheads ?? []).toEqual([]);
  });

  it('NEGATIVE CONTROL: a module with NO controller receives nothing, and says so', () => {
    const h = harness();
    expect(h.registry.view('ghost')).toEqual(NO_HLS_SOURCE);
    // ⚠ DELIVERY IS REPORTED, NEVER DROPPED. A caller that discarded this flag
    // would make "the button works" and "the button is wired to nothing"
    // indistinguishable from the output.
    expect(h.registry.request('ghost', { kind: 'next' })).toEqual({ delivered: false, error: null });
    h.registry.sync([h.node('ghost', 'tvLibrarian')], engineOf(h));
    expect(h.registry.request('ghost', { kind: 'next' }).delivered).toBe(true);
  });
});

describe('DEFECT 2 — a remount must not re-buffer a stream that is already playing', () => {
  it('re-running sync with UNCHANGED data attaches nothing a second time', async () => {
    const h = harness();
    h.data.set('tv1', {
      channel: { nanoid: 'c1', name: 'One', streamUrl: 'https://x/one.m3u8', country: 'us', languages: [] },
    });
    const node = h.node('tv1', 'tvLibrarian');
    h.registry.sync([node], engineOf(h));
    await flush();
    expect(h.creates).toHaveLength(1);
    // Ten more graph ticks — a pan, a param move, a peer's cursor. On the CARD
    // this was `lastAttachedUrl`, a component-scope let, so every REMOUNT reset
    // it and tore down the live demuxer. Node-owned, it cannot be reset by a
    // view appearing.
    const destroysAfterFirstAttach = h.destroys.length;
    for (let i = 0; i < 10; i++) h.registry.sync([node], engineOf(h));
    await flush();
    expect(h.creates, 'the live stream was rebuilt by a graph tick').toHaveLength(1);
    // ⚠ COMPARED AGAINST THE POST-ATTACH BASELINE, not against zero: every
    // attach begins with an idempotent `destroy` of whatever was there, so the
    // first one legitimately records a (no-op) destroy. Asserting `[]` would
    // have been a test that could only pass by accident of that ordering.
    expect(h.destroys.length, 'the live demuxer was destroyed by a graph tick')
      .toBe(destroysAfterFirstAttach);
  });

  it('POSITIVE CONTROL: a CHANGED selection really does re-attach', async () => {
    const h = harness();
    h.data.set('tv1', {
      channel: { nanoid: 'c1', name: 'One', streamUrl: 'https://x/one.m3u8', country: 'us', languages: [] },
    });
    const node = h.node('tv1', 'tvLibrarian');
    h.registry.sync([node], engineOf(h));
    await flush();
    h.data.set('tv1', {
      channel: { nanoid: 'c2', name: 'Two', streamUrl: 'https://x/two.m3u8', country: 'us', languages: [] },
    });
    h.registry.sync([node], engineOf(h));
    await flush();
    expect(h.creates.map(([, url]) => url)).toEqual(['https://x/one.m3u8', 'https://x/two.m3u8']);
    // A genuine SWAP does tear the old demuxer down — which is the behaviour the
    // negative control above must not be confused with.
    expect(h.destroys.length).toBeGreaterThan(0);
  });
});

describe('DEFECT 3 — the audio wire + un-mute outlive every surface', () => {
  it('un-mutes only AFTER the tap is wired, never before', async () => {
    const h = harness();
    h.data.set('pt1', { selectedHost: 'a.example', uuid: 'u1' });
    h.responses.push(['/videos/u1', PT_DETAILS_HLS]);
    h.registry.sync([h.node('pt1', 'peertube')], engineOf(h));
    await flush();
    const el = elOf(h, 'pt1');
    // Re-muted for THIS stream's autoplay attempt.
    expect(el.muted, 'the element must be muted while it autoplays').toBe(true);
    // The stream reaches a playable state.
    el.ready = true;
    emit(el, 'playing');
    // The wire + un-mute is a RETRY, so it lands on a tick rather than instantly.
    h.clock.tick(RETRY_INTERVAL_MS + 1);
    expect(h.extras.get('pt1')!.wired).toBe(true);
    expect(el.muted, 'the element is still muted after the tap was wired — audio_l/r carry silence')
      .toBe(false);
    expect(h.registry.view('pt1').audioWired).toBe(true);
    // peertube's `loaded` trigger fires off the same success.
    expect(h.extras.get('pt1')!.loaded).toBeGreaterThan(0);
  });

  it('a wire that is not ready yet keeps retrying — nothing can cancel it but the GRAPH', () => {
    const h = harness();
    h.engineUp = false;
    h.registry.sync([h.node('pt1', 'peertube')], engineOf(h));
    const el = elOf(h, 'pt1');
    el.ready = true;
    emit(el, 'playing');
    // Several seconds pass with the engine still down. On the CARD this window
    // was where a collapse killed the retry and left the element muted forever.
    h.clock.tick(RETRY_INTERVAL_MS * 20);
    expect(el.muted).toBe(true);
    h.engineUp = true;
    h.clock.tick(RETRY_INTERVAL_MS + 1);
    expect(el.muted, 'the retry did not survive to perform the un-mute').toBe(false);
  });

  it('NEGATIVE CONTROL: disposing the NODE does stop it — the one thing that may', () => {
    const h = harness();
    h.engineUp = false;
    h.registry.sync([h.node('pt1', 'peertube')], engineOf(h));
    const el = elOf(h, 'pt1');
    el.ready = true;
    emit(el, 'playing');
    h.registry.sweep([]);
    h.engineUp = true;
    h.clock.tick(RETRY_INTERVAL_MS * 5);
    expect(el.muted, 'a swept controller kept working').toBe(true);
  });
});

describe('the stream lifecycle — timeout, fatal error, auto-skip', () => {
  function tunedTv(): Harness {
    const h = harness();
    h.responses.push(['/us.json', TV_CHANNELS]);
    h.data.set('tv1', { countryCode: 'us' });
    h.registry.sync([h.node('tv1', 'tvLibrarian')], engineOf(h));
    return h;
  }

  it('a stream that never produces a frame becomes UNAVAILABLE and skips onward', async () => {
    const h = tunedTv();
    await flush();
    h.registry.request('tv1', { kind: 'select', candidateKey: 'usa1' });
    await flush();
    expect(h.registry.view('tv1').streamState).toBe('loading');
    h.clock.tick(TV_LIBRARIAN_PROFILE.loadTimeoutMs + 1);
    expect(h.registry.view('tv1').streamState).toBe('unavailable');
    expect(h.registry.view('tv1').error).toMatch(/timed out/i);
    // ...and it does not HANG there: the auto-skip advances.
    h.clock.tick(UNAVAILABLE_SKIP_MS + 1);
    await flush();
    expect(h.creates.map(([, u]) => u)).toEqual(['https://x/usa1.m3u8', 'https://x/usa2.m3u8']);
  });

  it('a FATAL hls error is unavailable too — a CORS block fails LOUD, never silent', async () => {
    const h = tunedTv();
    await flush();
    h.registry.request('tv1', { kind: 'select', candidateKey: 'usa1' });
    await flush();
    fireHls(h, 'tv1', 'onFatalError');
    expect(h.registry.view('tv1').streamState).toBe('unavailable');
    expect(h.registry.view('tv1').error).toMatch(/CORS|unavailable/i);
    // `stream_online` really went low at the jack, not just in the UI.
    expect(h.extras.get('tv1')!.online.at(-1)).toBe(false);
  });

  it('reaching PLAYING raises stream_online and clears the timeout', async () => {
    const h = tunedTv();
    await flush();
    h.registry.request('tv1', { kind: 'select', candidateKey: 'usa1' });
    await flush();
    fireHls(h, 'tv1', 'onManifestParsed');
    const el = elOf(h, 'tv1');
    expect(el.paused, 'the manifest arrived and nothing pressed play').toBe(false);
    el.ready = true;
    emit(el, 'playing');
    expect(h.registry.view('tv1').streamState).toBe('playing');
    expect(h.extras.get('tv1')!.online.at(-1)).toBe(true);
    // The load timeout must NOT then fire and undo it.
    h.clock.tick(TV_LIBRARIAN_PROFILE.loadTimeoutMs * 2);
    expect(h.registry.view('tv1').streamState).toBe('playing');
  });

  it('a selection change PULSES channel_changed exactly once per pick', async () => {
    const h = tunedTv();
    await flush();
    h.registry.request('tv1', { kind: 'select', candidateKey: 'usa1' });
    await flush();
    expect(h.extras.get('tv1')!.channelChanged).toBe(1);
  });

  it('a catalogue fetch that fails reports it rather than hanging on "loading"', async () => {
    const h = harness();
    h.fetchFails.add('/us.json');
    h.data.set('tv1', { countryCode: 'us' });
    h.registry.sync([h.node('tv1', 'tvLibrarian')], engineOf(h));
    await flush();
    const view = h.registry.view('tv1');
    expect(view.loadingCatalogue).toBe(false);
    expect(view.error).toMatch(/could not load/i);
  });
});

describe('the two PROFILES — what genuinely differs, and why', () => {
  it('peertube does NOT auto-load: its catalogue key is a term typed one character at a time', async () => {
    const h = harness();
    h.responses.push(['sepiasearch', PT_SEARCH]);
    // A persisted search term — exactly what a saved rack, or a peer watching
    // someone type, carries.
    h.data.set('pt1', { searchTerm: 'blen' });
    h.registry.sync([h.node('pt1', 'peertube')], engineOf(h));
    await flush();
    expect(h.fetched, 'a keystroke fired a Sepia Search').toEqual([]);
    // The SURFACE debounces and asks explicitly.
    h.registry.request('pt1', { kind: 'catalogue', key: 'blender' });
    await flush();
    expect(h.fetched).toHaveLength(1);
    expect(h.registry.view('pt1').catalogue.map((c) => c.key)).toEqual([
      'a.example::u1',
      'b.example::u2',
    ]);
  });

  it('POSITIVE CONTROL: tvLibrarian DOES auto-load, because a country moves once per pick', async () => {
    const h = harness();
    h.responses.push(['/us.json', TV_CHANNELS]);
    h.data.set('tv1', { countryCode: 'us' });
    h.registry.sync([h.node('tv1', 'tvLibrarian')], engineOf(h));
    await flush();
    expect(h.fetched).toHaveLength(1);
    expect(h.registry.view('tv1').catalogue).not.toEqual([]);
  });

  it('`next` on an EMPTY catalogue fetches one first — a trigger on a cold rack still does something', async () => {
    const h = harness();
    h.responses.push(['sepiasearch', PT_SEARCH]);
    h.responses.push(['/videos/u1', PT_DETAILS_HLS]);
    h.data.set('pt1', { searchTerm: 'blender' });
    h.registry.sync([h.node('pt1', 'peertube')], engineOf(h));
    await flush();
    expect(h.registry.view('pt1').catalogue).toEqual([]);
    h.params.set('pt1::cv_next_trigger', 1);
    h.clock.tick(GATE_INTERVAL_MS + 1);
    await flush();
    expect(h.data.get('pt1')!.uuid, 'the trigger tuned nothing on a cold catalogue').toBe('u1');
  });

  it('peertube resolves through the per-instance DETAILS hop; tvLibrarian has a direct url', async () => {
    const h = harness();
    h.responses.push(['sepiasearch', PT_SEARCH]);
    h.responses.push(['/videos/u1', PT_DETAILS_HLS]);
    h.registry.sync([h.node('pt1', 'peertube')], engineOf(h));
    h.registry.request('pt1', { kind: 'catalogue', key: 'blender' });
    await flush();
    h.registry.request('pt1', { kind: 'select', candidateKey: 'a.example::u1' });
    await flush();
    expect(h.fetched.some((u) => u.includes('/videos/u1')), 'no details hop').toBe(true);
    expect(h.creates).toEqual([['pt1', 'https://a.example/master.m3u8']]);
    // The peertube key is `host::uuid`: a uuid alone is not unique across the
    // fediverse, and the persisted pair reflects that.
    expect(h.data.get('pt1')).toMatchObject({ selectedHost: 'a.example', uuid: 'u1' });
  });

  it('peertube `play_trigger` toggles transport, which tvLibrarian deliberately has no cable for', () => {
    const h = harness();
    h.registry.sync([h.node('pt1', 'peertube')], engineOf(h));
    const el = elOf(h, 'pt1');
    expect(el.paused).toBe(true);
    h.params.set('pt1::cv_play_trigger', 1);
    h.clock.tick(GATE_INTERVAL_MS + 1);
    expect(el.paused).toBe(false);
    h.params.set('pt1::cv_play_trigger', 0);
    h.clock.tick(GATE_INTERVAL_MS + 1);
    h.params.set('pt1::cv_play_trigger', 1);
    h.clock.tick(GATE_INTERVAL_MS + 1);
    expect(el.paused).toBe(true);
    expect(
      TV_LIBRARIAN_PROFILE.triggers.map((t) => t.command),
      'a live TV tuner has no transport to toggle',
    ).not.toContain('togglePlay');
  });
});

describe('advanceByKey — the shared wrap, and the one profile that overrides it', () => {
  const list: HlsCandidate[] = ['a', 'b', 'c'].map((k) => ({
    key: k,
    label: k,
    sublabel: '',
    thumbnailUrl: null,
    badge: null,
    item: null,
  }));

  it('next wraps, and starts at the head from nothing or from an unknown key', () => {
    expect(advanceByKey(list, null, 'next', () => 0)!.key).toBe('a');
    expect(advanceByKey(list, 'a', 'next', () => 0)!.key).toBe('b');
    expect(advanceByKey(list, 'c', 'next', () => 0)!.key).toBe('a');
    expect(advanceByKey(list, 'zz', 'next', () => 0)!.key).toBe('a');
    expect(advanceByKey([], 'a', 'next', () => 0)).toBeNull();
  });

  it('random excludes the current one, and degrades sanely on a list of one', () => {
    expect(advanceByKey(list, 'a', 'random', () => 0)!.key).toBe('b');
    expect(advanceByKey(list, 'a', 'random', () => 0.99)!.key).toBe('c');
    expect(advanceByKey(list.slice(0, 1), 'a', 'random', () => 0)!.key).toBe('a');
  });

  it('the tvLibrarian profile delegates rather than re-deriving — same answers, one owner', () => {
    // The delegation is the point: `nextChannel`/`randomChannel` are the
    // module's own tested helpers, so "what does next do" has ONE answer for
    // tvLibrarian and the existing tv-librarian-data coverage still describes
    // the shipping behaviour.
    const channels: HlsCandidate[] = TV_CHANNELS.slice(0, 2).map((c, i) => ({
      key: c.nanoid,
      label: c.name,
      sublabel: '',
      thumbnailUrl: null,
      badge: null,
      item: { nanoid: c.nanoid, name: c.name, streamUrl: `u${i}`, languages: [], country: 'us', isGeoBlocked: false, youtubeOnly: false },
    }));
    expect(TV_LIBRARIAN_PROFILE.advance(channels, null, 'next', () => 0)!.key).toBe('usa1');
    expect(TV_LIBRARIAN_PROFILE.advance(channels, 'usa1', 'next', () => 0)!.key).toBe('usa2');
    expect(TV_LIBRARIAN_PROFILE.advance(channels, 'usa2', 'next', () => 0)!.key).toBe('usa1');
    expect(TV_LIBRARIAN_PROFILE.advance(channels, 'usa1', 'random', () => 0)!.key).toBe('usa2');
    expect(PEERTUBE_PROFILE.advance, 'peertube has no published ordering of its own')
      .toBe(advanceByKey);
  });
});

describe('SCOPE: what this gate cannot see, stated as an assertion', () => {
  it('nothing here mounts Canvas, so nothing here proves the graph effect calls sync', () => {
    // Stated inside the gate per the blind-gate discipline. The pure core is
    // reachable with no DOM precisely because every edge is injected — which
    // also means it is BLIND to whether anything real is wired to it.
    // `e2e/tests/node-source-hls.spec.ts` is the behavioural net: it asserts a
    // controller exists for a node with NO card anywhere in the document.
    expect(typeof createNodeHlsSourceRegistry).toBe('function');
    // ...and blind to pixels and to real audio. `peertube.spec.ts` and
    // `tv-librarian-audio.spec.ts` drive real hls.js over a mocked AVC/AAC
    // fixture and assert a non-zero peak at an AUDIO OUT terminal.
    expect(NO_HLS_SOURCE.audioWired, 'the null status must not claim a wire').toBe(false);
  });
});
