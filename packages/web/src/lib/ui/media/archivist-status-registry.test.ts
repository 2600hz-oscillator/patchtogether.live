// packages/web/src/lib/ui/media/archivist-status-registry.test.ts
//
// The ARCHIVE-BROWSE STATUS SEAM's own behaviour, and the source gate that
// keeps its media-type roster honest.
//
// ⚠ WHAT THIS FILE IS STRUCTURALLY UNABLE TO SEE, stated inside the gate as the
// blind-gates rule requires: it mounts nothing. It cannot tell you the
// faceplate's Search button is visible, that the off-screen card is the mount
// that registered the commands, or that a delivered `search` reaches
// archive.org. Those are e2e's job (`face-archivist.spec.ts`). What it CAN
// prove is that the seam's contract holds under the mount/unmount ORDER that a
// promoted DOM-source module actually produces — lane → headless host → dock —
// which is the half that broke `node-media-registry` and is why that discipline
// was copied here.

import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createArchivistStatusRegistry,
  ARCHIVIST_MEDIA_TYPES,
  ARCHIVIST_STATUS_IDLE,
  type ArchivistCommands,
  type ArchivistStatus,
} from './archivist-status-registry';

const HERE = dirname(fileURLToPath(import.meta.url));

function status(over: Partial<ArchivistStatus> = {}): ArchivistStatus {
  return { ...ARCHIVIST_STATUS_IDLE, ...over };
}

/** A command owner that records what it was asked to do. */
function spyCommands(): { commands: ArchivistCommands; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    commands: {
      search: () => { calls.push('search'); },
      next: () => { calls.push('next'); },
      togglePlay: () => { calls.push('togglePlay'); },
      skip: (d) => { calls.push(`skip:${d}`); },
      seek: (p) => { calls.push(`seek:${p}`); },
      jumpRandom: () => { calls.push('jumpRandom'); },
    },
  };
}

describe('archivist status registry — publish / read', () => {
  it('read() is NULL before anything publishes, which is a real state', () => {
    // "No card is mounted" is a state a consumer must RENDER (idle, every
    // gesture disabled), not a missing value to paper over with a default.
    const r = createArchivistStatusRegistry();
    expect(r.read('a')).toBeNull();
  });

  it('publish then read returns exactly what was published', () => {
    const r = createArchivistStatusRegistry();
    const s = status({ loading: true, statusMsg: 'Loading "x"…', docCount: 12, positionSec: 4.5 });
    r.publish('a', s);
    expect(r.read('a')).toEqual(s);
  });

  it('is keyed per node — one card publishing does not answer for another', () => {
    const r = createArchivistStatusRegistry();
    r.publish('a', status({ docCount: 3 }));
    expect(r.read('b')).toBeNull();
  });
});

describe('archivist status registry — commands and delivery', () => {
  it('request() reports NOT DELIVERED when no owner is registered', () => {
    // The whole point of the flag: an action writes nothing to the graph, so
    // "the button works" and "the button is wired to nothing" are otherwise
    // indistinguishable.
    const r = createArchivistStatusRegistry();
    expect(r.request('a', { kind: 'search' })).toEqual({ delivered: false, error: null });
    expect(r.hasCommands('a')).toBe(false);
  });

  it('every one of the six commands routes to its own handler', () => {
    // ⚠ EXHAUSTIVE ON PURPOSE. The dispatch is a hand-written switch, so a new
    // member of the union added without a case would silently no-op — the
    // dead-button shape this seam exists to make impossible.
    const r = createArchivistStatusRegistry();
    const { commands, calls } = spyCommands();
    r.registerCommands('a', commands);

    r.request('a', { kind: 'search' });
    r.request('a', { kind: 'next' });
    r.request('a', { kind: 'togglePlay' });
    r.request('a', { kind: 'skip', deltaS: -10 });
    r.request('a', { kind: 'seek', positionS: 42.5 });
    r.request('a', { kind: 'jumpRandom' });

    expect(calls).toEqual([
      'search', 'next', 'togglePlay', 'skip:-10', 'seek:42.5', 'jumpRandom',
    ]);
  });

  it('carries the NUMBER for the two commands that take one', () => {
    // The reason this seam takes a discriminated union rather than the bare
    // command id its two siblings use. A seam that dropped the argument would
    // have forced a body to touch the element — the second owner this file
    // exists to prevent.
    const r = createArchivistStatusRegistry();
    const { commands, calls } = spyCommands();
    r.registerCommands('a', commands);
    r.request('a', { kind: 'skip', deltaS: 10 });
    r.request('a', { kind: 'seek', positionS: 0 });
    expect(calls).toEqual(['skip:10', 'seek:0']);
  });

  it('a THROWING handler reports delivered:true WITH the error', () => {
    // "Nobody was listening" and "the owner failed" need different fixes, so
    // they must not collapse into one answer.
    const r = createArchivistStatusRegistry();
    const boom = new Error('metadata HTTP 503');
    r.registerCommands('a', { ...spyCommands().commands, search: () => { throw boom; } });
    expect(r.request('a', { kind: 'search' })).toEqual({ delivered: true, error: boom });
  });
});

describe('archivist status registry — owner-checked hand-over', () => {
  // ⚠ THE HALF THAT MATTERS FOR A PROMOTED DOM-SOURCE MODULE. The card is
  // remounted by view moves (lane → headless host → dock rail) and Svelte gives
  // no cross-tree ordering guarantee, so the NEW mount can register before the
  // OLD one tears down. Without the owner check the stale teardown would
  // unregister the live card and every faceplate button would go dead.
  it('the NEWEST registration wins', () => {
    const r = createArchivistStatusRegistry();
    const first = spyCommands();
    const second = spyCommands();
    r.registerCommands('a', first.commands);
    r.registerCommands('a', second.commands);
    r.request('a', { kind: 'search' });
    expect(first.calls).toEqual([]);
    expect(second.calls).toEqual(['search']);
  });

  it('a STALE mount releasing AFTER a new one registered does NOT strand the slot', () => {
    const r = createArchivistStatusRegistry();
    const first = spyCommands();
    const second = spyCommands();
    const staleLease = r.registerCommands('a', first.commands);
    r.registerCommands('a', second.commands);

    staleLease.release(); // the old card's onDestroy, arriving late

    expect(r.hasCommands('a')).toBe(true);
    r.request('a', { kind: 'next' });
    expect(second.calls).toEqual(['next']);
  });

  it('release() is idempotent', () => {
    const r = createArchivistStatusRegistry();
    const lease = r.registerCommands('a', spyCommands().commands);
    lease.release();
    lease.release();
    expect(r.hasCommands('a')).toBe(false);
  });

  it('the LIVE mount releasing DOES clear the slot', () => {
    // The other direction — the release must still work when it is the current
    // owner's, or a deleted card would leave a dead command owner behind.
    const r = createArchivistStatusRegistry();
    const lease = r.registerCommands('a', spyCommands().commands);
    lease.release();
    expect(r.request('a', { kind: 'search' }).delivered).toBe(false);
  });
});

describe('archivist status registry — subscription and graph lifetime', () => {
  it('subscribe fires on publish, on register AND on release', () => {
    const r = createArchivistStatusRegistry();
    const fn = vi.fn();
    r.subscribe('a', fn);
    r.publish('a', status({ loading: true }));
    expect(fn).toHaveBeenCalledTimes(1);
    const lease = r.registerCommands('a', spyCommands().commands);
    expect(fn).toHaveBeenCalledTimes(2);
    lease.release();
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('a THROWING listener never breaks the publisher or its siblings', () => {
    const r = createArchivistStatusRegistry();
    const good = vi.fn();
    r.subscribe('a', () => { throw new Error('a broken consumer'); });
    r.subscribe('a', good);
    expect(() => r.publish('a', status())).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
  });

  it('a listener may unsubscribe ITSELF during a notify', () => {
    // The copy-before-iterate in notify(). Without it the second listener is
    // skipped when the first removes itself mid-iteration.
    const r = createArchivistStatusRegistry();
    const second = vi.fn();
    const off = r.subscribe('a', () => off());
    r.subscribe('a', second);
    r.publish('a', status());
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('unsubscribe stops delivery', () => {
    const r = createArchivistStatusRegistry();
    const fn = vi.fn();
    r.subscribe('a', fn)();
    r.publish('a', status());
    expect(fn).not.toHaveBeenCalled();
  });

  it('clear() drops status AND commands and tells consumers', () => {
    const r = createArchivistStatusRegistry();
    const fn = vi.fn();
    r.publish('a', status({ docCount: 9 }));
    r.registerCommands('a', spyCommands().commands);
    r.subscribe('a', fn);
    r.clear('a');
    expect(r.read('a')).toBeNull();
    expect(r.hasCommands('a')).toBe(false);
    expect(fn).toHaveBeenCalled();
  });

  it('sweep() retires exactly the nodes the GRAPH no longer has', () => {
    const r = createArchivistStatusRegistry();
    r.publish('gone', status({ docCount: 1 }));
    r.publish('kept', status({ docCount: 2 }));
    r.sweep(['kept']);
    expect(r.read('gone')).toBeNull();
    expect(r.read('kept')).not.toBeNull();
  });

  it('sweep() survives being DESTRUCTURED off the registry', () => {
    // ⚠ THE `this`-FREE DISCIPLINE, exercised rather than asserted in a
    // comment. `camera-status-registry` records that a `this.clear` here breaks
    // silently the first time someone writes `const { sweep } = archivistStatus`
    // — an ordinary thing to do, and Canvas's sweep block is exactly where it
    // would be done.
    const r = createArchivistStatusRegistry();
    const { sweep } = r;
    r.publish('gone', status());
    expect(() => sweep([])).not.toThrow();
    expect(r.read('gone')).toBeNull();
  });

  it('sweep() accepts a Set as well as an array', () => {
    const r = createArchivistStatusRegistry();
    r.publish('kept', status());
    r.sweep(new Set(['kept']));
    expect(r.read('kept')).not.toBeNull();
  });
});

describe('archivist media-type roster — ANCHORED to the query layer union', () => {
  // ⚠ A SOURCE GATE, because three surfaces now draw this roster and a
  // hand-copied option list is how one of them silently stops offering a type
  // the query layer supports. Both directions, so a member added to the union
  // and a member left in the roster after the union drops it are BOTH red.
  const QUERY_SRC = readFileSync(
    resolve(HERE, '../../video/modules/archivist-query.ts'),
    'utf8',
  );

  it('the declared union is exactly the roster this file exports', () => {
    const m = /export type ArchivistMediaType\s*=\s*([^;]+);/.exec(QUERY_SRC);
    expect(m, 'ArchivistMediaType is no longer declared the way this gate reads it').not.toBeNull();
    const union = [...m![1]!.matchAll(/'([a-z]+)'/g)].map((x) => x[1]!).sort();
    expect(union).toEqual([...ARCHIVIST_MEDIA_TYPES].sort());
  });

  it("'any' is present, and it is the only non-concrete member", () => {
    // `loadItem` branches on it (`concreteTypeFromMediatype(doc.mediatype)`),
    // so its presence is load-bearing rather than cosmetic.
    expect(ARCHIVIST_MEDIA_TYPES).toContain('any');
    expect(ARCHIVIST_MEDIA_TYPES.filter((t) => t === 'any')).toHaveLength(1);
  });

  it('the roster has no duplicates', () => {
    expect(new Set(ARCHIVIST_MEDIA_TYPES).size).toBe(ARCHIVIST_MEDIA_TYPES.length);
  });
});

describe('the idle status', () => {
  it('is the value a consumer paints when no card has published', () => {
    // Exported so a consumer never hand-rolls a fallback that drifts from this
    // one — three surfaces read it.
    expect(ARCHIVIST_STATUS_IDLE).toEqual({
      loading: false,
      statusMsg: null,
      errorMsg: null,
      docCount: 0,
      positionSec: 0,
    });
  });

  it('renders as "nothing in flight, nothing to re-roll"', () => {
    // The two fields that gate an affordance, named explicitly: a surface
    // reading the idle status must not offer ↻ next and must not show a
    // spinner.
    expect(ARCHIVIST_STATUS_IDLE.loading).toBe(false);
    expect(ARCHIVIST_STATUS_IDLE.docCount).toBe(0);
  });
});
