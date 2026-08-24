// packages/web/src/lib/ui/media/loopback-status-registry.test.ts
//
// The LOOPBACK capture-status seam, driven as a unit — plus the SOURCE-level
// gates that keep its state union SINGLE, which no runtime test can see.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi } from 'vitest';

import {
  createLoopbackStatusRegistry,
  loopbackStatus,
  type LoopbackStatus,
} from './loopback-status-registry';

const CARD_PATH = fileURLToPath(new URL('../modules/LoopbackCard.svelte', import.meta.url));
const ACQUIRE_PATH = fileURLToPath(new URL('../viewport-acquire.ts', import.meta.url));
const REGISTRY_PATH = fileURLToPath(new URL('./loopback-status-registry.ts', import.meta.url));

function status(over: Partial<LoopbackStatus> = {}): LoopbackStatus {
  return { state: 'idle', errorMsg: null, supported: true, ...over };
}

function commands(over: Partial<{ acquire: () => void; stop: () => void }> = {}) {
  return { acquire: vi.fn(), stop: vi.fn(), ...over };
}

describe('loopback-status-registry — publish / read', () => {
  it('reads back what the owning card published', () => {
    const r = createLoopbackStatusRegistry();
    expect(r.read('n1'), 'nothing published yet').toBeNull();
    r.publish('n1', status({ state: 'capturing' }));
    expect(r.read('n1')?.state).toBe('capturing');
  });

  it('NULL IS A REAL STATE, not a missing value — no card has published', () => {
    // The consumer must be able to tell "no card is mounted for this node" from
    // "a card is mounted and reports idle". Collapsing the two would let the
    // face show an idle lamp — and an OFFERABLE start button — for a node whose
    // card is gone, which is a button that can only ever do nothing.
    const r = createLoopbackStatusRegistry();
    expect(r.read('never-seen')).toBeNull();
    r.publish('n1', status({ state: 'idle' }));
    expect(r.read('n1')).not.toBeNull();
    expect(r.read('n1')!.state).toBe('idle');
  });

  it('carries `supported` SEPARATELY from `state`, because they answer different questions', () => {
    // `state` is where THIS capture is; `supported` is what this BROWSER can do.
    // A consumer disabling the acquire button needs the second one whatever the
    // first says — and the two genuinely diverge: a runtime with no Screen
    // Capture API reports `unsupported` AND `supported: false`, but an ordinary
    // failed picker reports `error` with `supported: true` and SHOULD still
    // offer a retry.
    const r = createLoopbackStatusRegistry();
    r.publish('no-api', status({ state: 'unsupported', supported: false }));
    r.publish('failed', status({ state: 'error', errorMsg: 'NotReadableError: x', supported: true }));
    expect(r.read('no-api')!.supported).toBe(false);
    expect(r.read('failed')!.supported, 'a failed picker must stay retryable').toBe(true);
  });

  it('keeps nodes independent', () => {
    const r = createLoopbackStatusRegistry();
    r.publish('a', status({ state: 'capturing' }));
    r.publish('b', status({ state: 'error', errorMsg: 'blocked' }));
    expect(r.read('a')!.state).toBe('capturing');
    expect(r.read('b')!.errorMsg).toBe('blocked');
  });
});

describe('loopback-status-registry — the COMMAND slot', () => {
  it('delivers each named command to the registered owner, and ONLY that one', () => {
    const r = createLoopbackStatusRegistry();
    const c = commands();
    r.registerCommands('n1', c);

    expect(r.request('n1', 'acquire')).toEqual({ delivered: true, error: null });
    expect(c.acquire).toHaveBeenCalledTimes(1);
    expect(c.stop, 'acquiring must not stop').not.toHaveBeenCalled();

    expect(r.request('n1', 'stop')).toEqual({ delivered: true, error: null });
    expect(c.stop).toHaveBeenCalledTimes(1);
    expect(c.acquire, 'stopping must not re-acquire — that would re-open the picker').toHaveBeenCalledTimes(1);
  });

  it('REPORTS a request nobody could receive — delivered:false, never dropped', () => {
    // An acquire writes nothing to the graph, so readParam/readData are
    // structurally blind to it. This flag is the ONLY observable that separates
    // "the button is wired" from "the button is wired to nothing".
    const r = createLoopbackStatusRegistry();
    expect(r.hasCommands('n1')).toBe(false);
    expect(r.request('n1', 'acquire')).toEqual({ delivered: false, error: null });
    expect(r.request('n1', 'stop')).toEqual({ delivered: false, error: null });
  });

  it('reports a handler that THREW as delivered-with-error, not as undelivered', () => {
    const r = createLoopbackStatusRegistry();
    const boom = new Error('getDisplayMedia exploded');
    r.registerCommands('n1', commands({ acquire: () => { throw boom; } }));
    const res = r.request('n1', 'acquire');
    expect(res.delivered, 'the owner WAS there').toBe(true);
    expect(res.error).toBe(boom);
  });

  it('HAND-OVER: the newest mount wins and the STALE lease cannot unregister it', () => {
    // The card is remounted by every view move (lane → headless host → dock),
    // and Svelte gives no cross-tree ordering guarantee. This is the property
    // that makes order not matter — verbatim node-media-registry's discipline.
    const r = createLoopbackStatusRegistry();
    const first = commands();
    const second = commands();
    const leaseA = r.registerCommands('n1', first);
    const leaseB = r.registerCommands('n1', second);

    // The stale mount tears down AFTER the new one registered.
    leaseA.release();

    expect(r.hasCommands('n1'), 'the live command survives a stale release').toBe(true);
    r.request('n1', 'acquire');
    expect(second.acquire).toHaveBeenCalledTimes(1);
    expect(first.acquire).not.toHaveBeenCalled();

    leaseB.release();
    expect(r.hasCommands('n1')).toBe(false);
  });

  it('release is idempotent', () => {
    const r = createLoopbackStatusRegistry();
    const lease = r.registerCommands('n1', commands());
    lease.release();
    lease.release();
    expect(r.hasCommands('n1')).toBe(false);
  });
});

describe('loopback-status-registry — subscription', () => {
  it('fires on publish, on register AND on release', () => {
    // All three change what a consumer paints: the lamp, and whether either
    // gesture is offerable at all.
    const r = createLoopbackStatusRegistry();
    const seen: string[] = [];
    const off = r.subscribe('n1', () => seen.push('tick'));

    r.publish('n1', status({ state: 'requesting' }));
    expect(seen.length, 'publish notified').toBe(1);

    const lease = r.registerCommands('n1', commands());
    expect(seen.length, 'register notified').toBe(2);

    lease.release();
    expect(seen.length, 'release notified').toBe(3);

    off();
    r.publish('n1', status({ state: 'capturing' }));
    expect(seen.length, 'unsubscribed').toBe(3);
  });

  it('a listener that unsubscribes itself mid-notify does not break the others', () => {
    const r = createLoopbackStatusRegistry();
    const other = vi.fn();
    const off1 = r.subscribe('n1', () => off1());
    r.subscribe('n1', other);
    r.publish('n1', status());
    expect(other).toHaveBeenCalled();
  });

  it('a THROWING listener never breaks the publisher', () => {
    const r = createLoopbackStatusRegistry();
    r.subscribe('n1', () => { throw new Error('bad consumer'); });
    const ok = vi.fn();
    r.subscribe('n1', ok);
    expect(() => r.publish('n1', status())).not.toThrow();
    expect(ok).toHaveBeenCalled();
  });

  it('only the SUBSCRIBED node notifies', () => {
    const r = createLoopbackStatusRegistry();
    const fn = vi.fn();
    r.subscribe('a', fn);
    r.publish('b', status());
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('loopback-status-registry — GRAPH-keyed teardown', () => {
  it('clear() drops status AND commands, and notifies', () => {
    const r = createLoopbackStatusRegistry();
    const fn = vi.fn();
    r.subscribe('n1', fn);
    r.publish('n1', status({ state: 'capturing' }));
    r.registerCommands('n1', commands());
    fn.mockClear();

    r.clear('n1');
    expect(fn, 'consumers hear the teardown').toHaveBeenCalled();
    expect(r.read('n1')).toBeNull();
    expect(r.hasCommands('n1')).toBe(false);
  });

  it('sweep() keeps live nodes and drops the rest', () => {
    const r = createLoopbackStatusRegistry();
    r.publish('live', status({ state: 'capturing' }));
    r.publish('gone', status({ state: 'capturing' }));
    r.sweep(['live']);
    expect(r.read('live')!.state).toBe('capturing');
    expect(r.read('gone')).toBeNull();
  });

  it('sweep survives being DESTRUCTURED off the registry (no `this` dependency)', () => {
    // `sweep` calling `this.clear(...)` binds only when invoked as
    // `registry.sweep(...)`. Canvas happens to do that, so the bug would stay
    // invisible until the first `const { sweep } = …` — an ordinary refactor
    // that would throw at runtime, in a teardown path, on node deletion.
    const r = createLoopbackStatusRegistry();
    r.publish('gone', status());
    const { sweep } = r;
    expect(() => sweep([])).not.toThrow();
    expect(r.read('gone')).toBeNull();
  });

  it('NEGATIVE CONTROL: sweep with everything live changes nothing', () => {
    // A sweep that dropped its own argument would satisfy the leg above by
    // accident — this is the direction that catches an inverted predicate.
    const r = createLoopbackStatusRegistry();
    r.publish('a', status());
    r.publish('b', status());
    r.sweep(['a', 'b']);
    expect(r.read('a')).not.toBeNull();
    expect(r.read('b')).not.toBeNull();
  });
});

describe('loopback-status-registry — the singleton', () => {
  it('exports a live registry the card and the face body share', () => {
    // Two consumers reaching two registries is the whole failure mode this file
    // exists to prevent; the singleton is what makes them one.
    const c = commands();
    const lease = loopbackStatus.registerCommands('singleton-probe', c);
    loopbackStatus.publish('singleton-probe', status({ state: 'capturing' }));
    expect(loopbackStatus.read('singleton-probe')!.state).toBe('capturing');
    expect(loopbackStatus.request('singleton-probe', 'acquire').delivered).toBe(true);
    lease.release();
    loopbackStatus.clear('singleton-probe');
  });
});

describe('SOURCE gate: the capture-state union has exactly ONE declaration', () => {
  // ⚠ NO RUNTIME TEST CAN SEE THIS. A type alias is erased, so a card that
  // re-declared its own `State` union would publish happily and the divergence
  // would surface only as a face lamp that cannot render a state the card can
  // reach — with every runtime assertion still green.
  //
  // ⚠ AND CAMERA IS THE WORKED EXAMPLE OF THE COSTLIER SHAPE. Its union is
  // declared TWICE (the card's local `State` and `camera-device.ts`'s
  // `CameraState`) under a header claiming they are kept byte-in-sync — a claim
  // nothing checked until a gate was written to compare them. That gate is
  // correct and necessary THERE. Here there is nothing to compare, because
  // there is one declaration; what has to be held is that it STAYS one.
  function unionMembers(source: string, afterMarker: string): string[] {
    const at = source.indexOf(afterMarker);
    expect(at, `${afterMarker} must be present`).toBeGreaterThan(-1);
    const tail = source.slice(at + afterMarker.length);
    const end = tail.indexOf(';');
    expect(end, 'the union must terminate').toBeGreaterThan(-1);
    return [...tail.slice(0, end).matchAll(/'([a-z-]+)'/g)].map((m) => m[1]!).sort();
  }

  it('`viewport-acquire.ts` declares the union, and it is the states the card machine uses', () => {
    const declared = unionMembers(
      readFileSync(ACQUIRE_PATH, 'utf8'),
      'export type LoopbackCaptureState =',
    );
    // Membership, not size — a scan that silently stopped matching would make a
    // size check compare 0 to 0 and pass.
    for (const s of ['idle', 'requesting', 'capturing', 'ended', 'unsupported', 'error']) {
      expect(declared, `${s} is a real capture state and the scan must see it`).toContain(s);
    }
  });

  /**
   * Source with whole-line comments dropped.
   *
   * ⚠ THIS EXISTS BECAUSE THE GATE CAUGHT ITS OWN DOCUMENTATION. The first
   * draft tested the raw file for a re-typed union, and the CARD reddened —
   * because the comment explaining the rule spells the forbidden shape out
   * (`this used to be a local type State = 'idle' | …`). "Did I match CODE or
   * PROSE about code?" is the fleet's own recorded reflex and this is a fresh
   * instance of it.
   *
   * ⚠ AND IT DROPS LINES, NOT PATTERNS. A `//`-stripping regex over the whole
   * file eats the `//` in a string like `'https://x'` — string safety is a
   * property of a parser, not of a pattern. Dropping only lines whose FIRST
   * non-space characters open a comment cannot do that: a line that begins with
   * `//` has no code on it to lose.
   */
  function codeLines(source: string): string {
    return source
      .split('\n')
      .filter((l) => {
        const t = l.trimStart();
        return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
      })
      .join('\n');
  }

  const RETYPED_UNION = /type State =\s*\n?\s*(\|\s*)?'/;

  it('the CARD imports that union instead of re-declaring one', () => {
    // ⚠ ANCHORED TO THE SHAPE, because this is the copy that would come back.
    // The card used to own a local union of string literals; an alias to the
    // imported type is fine (and is what ships), a fresh union is not.
    const card = readFileSync(CARD_PATH, 'utf8');
    expect(card, 'the card must import the shared union').toContain('LoopbackCaptureState');
    expect(
      RETYPED_UNION.test(codeLines(card)),
      'a re-typed union in the card is a second copy nothing can compare',
    ).toBe(false);
  });

  it('the REGISTRY aliases that union rather than re-typing it', () => {
    const reg = readFileSync(REGISTRY_PATH, 'utf8');
    expect(reg, 'the registry must ALIAS LoopbackCaptureState, never re-declare the members')
      .toContain('export type LoopbackStatusState = LoopbackCaptureState;');
    expect(
      /export type LoopbackStatusState =\s*\n?\s*\|/.test(reg),
      'a re-typed union here is a third copy the source gate cannot compare',
    ).toBe(false);
  });

  it('NEGATIVE CONTROL: the card predicate FIRES on the shape it forbids', () => {
    // Without this, "the card is clean" and "the regex never matches anything"
    // are the same green. Both spellings a re-declaration could take, run
    // through the SAME `codeLines` path the real check uses.
    expect(RETYPED_UNION.test(codeLines("type State = 'idle' | 'error';"))).toBe(true);
    expect(RETYPED_UNION.test(codeLines("type State =\n  | 'idle'\n  | 'error';"))).toBe(true);
    expect(
      RETYPED_UNION.test(codeLines('type State = LoopbackCaptureState;')),
      'the alias the card actually ships must NOT trip it',
    ).toBe(false);
  });

  it('NEGATIVE CONTROL: `codeLines` drops PROSE but keeps CODE — including a URL string', () => {
    // ⚠ THE SECOND HALF IS THE ONE THAT MATTERS. A comment-stripper that ate
    // `'https://x'` would silently corrupt the very lines it is meant to
    // inspect, and the scan would then be reading a file that does not exist.
    const src = [
      "// this used to be a local type State = 'idle' | 'error';",
      " * type State = 'idle' | 'error';",
      "const url = 'https://example.test/a//b';",
      'type State = LoopbackCaptureState;',
    ].join('\n');
    const kept = codeLines(src);
    expect(RETYPED_UNION.test(kept), 'the two comment lines must be gone').toBe(false);
    expect(kept, 'a URL string survives intact').toContain("'https://example.test/a//b'");
    expect(kept, 'real code survives').toContain('type State = LoopbackCaptureState;');
  });

  it('NEGATIVE CONTROL: the union parser rejects a union it cannot terminate', () => {
    expect(() => unionMembers("type State =\n  | 'idle'", 'type State =')).toThrow();
  });
});
