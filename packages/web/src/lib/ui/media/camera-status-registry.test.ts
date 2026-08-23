// packages/web/src/lib/ui/media/camera-status-registry.test.ts
//
// The capture-status seam, driven as a unit — plus the SOURCE-level gate that
// keeps its state union equal to the card's, which no runtime test can see.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi } from 'vitest';

import {
  createCameraStatusRegistry,
  cameraStatus,
  type CameraCaptureState,
  type CameraStatus,
} from './camera-status-registry';

const CARD_PATH = fileURLToPath(
  new URL('../modules/CameraInputCard.svelte', import.meta.url),
);
const DEVICE_PATH = fileURLToPath(
  new URL('../../video/camera-device.ts', import.meta.url),
);

function status(over: Partial<CameraStatus> = {}): CameraStatus {
  return { state: 'idle', errorMsg: null, deviceCount: 1, ...over };
}

describe('camera-status-registry — publish / read', () => {
  it('reads back what the owning card published', () => {
    const r = createCameraStatusRegistry();
    expect(r.read('n1'), 'nothing published yet').toBeNull();
    r.publish('n1', status({ state: 'streaming' }));
    expect(r.read('n1')?.state).toBe('streaming');
  });

  it('NULL IS A REAL STATE, not a missing value — no card has published', () => {
    // The consumer must be able to tell "no card is mounted for this node" from
    // "a card is mounted and reports idle". Collapsing the two would let the
    // face show an idle lamp for a node whose card is gone.
    const r = createCameraStatusRegistry();
    expect(r.read('never-seen')).toBeNull();
    r.publish('n1', status({ state: 'idle' }));
    expect(r.read('n1')).not.toBeNull();
    expect(r.read('n1')!.state).toBe('idle');
  });

  it('keeps nodes independent', () => {
    const r = createCameraStatusRegistry();
    r.publish('a', status({ state: 'streaming' }));
    r.publish('b', status({ state: 'permission-denied', errorMsg: 'blocked' }));
    expect(r.read('a')!.state).toBe('streaming');
    expect(r.read('b')!.errorMsg).toBe('blocked');
  });
});

describe('camera-status-registry — the COMMAND slot', () => {
  it('delivers a request to the registered owner', () => {
    const r = createCameraStatusRegistry();
    const acquire = vi.fn();
    r.registerCommands('n1', { acquire });
    expect(r.request('n1')).toEqual({ delivered: true, error: null });
    expect(acquire).toHaveBeenCalledTimes(1);
  });

  it('REPORTS a request nobody could receive — delivered:false, never dropped', () => {
    // An acquire writes nothing to the graph, so readParam/readData are
    // structurally blind to it. This flag is the ONLY observable that separates
    // "the button is wired" from "the button is wired to nothing".
    const r = createCameraStatusRegistry();
    expect(r.hasCommands('n1')).toBe(false);
    expect(r.request('n1')).toEqual({ delivered: false, error: null });
  });

  it('reports a handler that THREW as delivered-with-error, not as undelivered', () => {
    const r = createCameraStatusRegistry();
    const boom = new Error('getUserMedia exploded');
    r.registerCommands('n1', { acquire: () => { throw boom; } });
    const res = r.request('n1');
    expect(res.delivered, 'the owner WAS there').toBe(true);
    expect(res.error).toBe(boom);
  });

  it('HAND-OVER: the newest mount wins and the STALE lease cannot unregister it', () => {
    // The card is remounted by every view move (lane → headless host → dock),
    // and Svelte gives no cross-tree ordering guarantee. This is the property
    // that makes order not matter — verbatim node-media-registry's discipline.
    const r = createCameraStatusRegistry();
    const first = vi.fn();
    const second = vi.fn();
    const leaseA = r.registerCommands('n1', { acquire: first });
    const leaseB = r.registerCommands('n1', { acquire: second });

    // The stale mount tears down AFTER the new one registered.
    leaseA.release();

    expect(r.hasCommands('n1'), 'the live command survives a stale release').toBe(true);
    r.request('n1');
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();

    // And the LIVE lease still works.
    leaseB.release();
    expect(r.hasCommands('n1')).toBe(false);
  });

  it('release is idempotent', () => {
    const r = createCameraStatusRegistry();
    const lease = r.registerCommands('n1', { acquire: vi.fn() });
    lease.release();
    lease.release();
    expect(r.hasCommands('n1')).toBe(false);
  });
});

describe('camera-status-registry — subscription', () => {
  it('fires on publish, on register AND on release', () => {
    // All three change what a consumer paints: the lamp, and whether the
    // acquire button is offerable at all.
    const r = createCameraStatusRegistry();
    const seen: string[] = [];
    const off = r.subscribe('n1', () => seen.push('tick'));

    r.publish('n1', status({ state: 'requesting' }));
    expect(seen.length, 'publish notified').toBe(1);

    const lease = r.registerCommands('n1', { acquire: vi.fn() });
    expect(seen.length, 'register notified').toBe(2);

    lease.release();
    expect(seen.length, 'release notified').toBe(3);

    off();
    r.publish('n1', status({ state: 'streaming' }));
    expect(seen.length, 'unsubscribed').toBe(3);
  });

  it('a listener that unsubscribes itself mid-notify does not break the others', () => {
    const r = createCameraStatusRegistry();
    const other = vi.fn();
    const off1 = r.subscribe('n1', () => off1());
    r.subscribe('n1', other);
    r.publish('n1', status());
    expect(other).toHaveBeenCalled();
  });

  it('a THROWING listener never breaks the publisher', () => {
    const r = createCameraStatusRegistry();
    r.subscribe('n1', () => { throw new Error('bad consumer'); });
    const ok = vi.fn();
    r.subscribe('n1', ok);
    expect(() => r.publish('n1', status())).not.toThrow();
    expect(ok).toHaveBeenCalled();
  });

  it('only the SUBSCRIBED node notifies', () => {
    const r = createCameraStatusRegistry();
    const fn = vi.fn();
    r.subscribe('a', fn);
    r.publish('b', status());
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('camera-status-registry — GRAPH-keyed teardown', () => {
  it('clear() drops status AND commands, and notifies', () => {
    const r = createCameraStatusRegistry();
    const fn = vi.fn();
    r.subscribe('n1', fn);
    r.publish('n1', status({ state: 'streaming' }));
    r.registerCommands('n1', { acquire: vi.fn() });
    fn.mockClear();

    r.clear('n1');
    expect(fn, 'consumers hear the teardown').toHaveBeenCalled();
    expect(r.read('n1')).toBeNull();
    expect(r.hasCommands('n1')).toBe(false);
  });

  it('sweep() keeps live nodes and drops the rest', () => {
    const r = createCameraStatusRegistry();
    r.publish('live', status({ state: 'streaming' }));
    r.publish('gone', status({ state: 'streaming' }));
    r.sweep(['live']);
    expect(r.read('live')!.state).toBe('streaming');
    expect(r.read('gone')).toBeNull();
  });

  it('sweep survives being DESTRUCTURED off the registry (no `this` dependency)', () => {
    // `sweep` used to call `this.clear(...)`, which binds only when the method
    // is invoked as `registry.sweep(...)`. Canvas happens to do that, so the
    // bug would have stayed invisible until the first `const { sweep } = …` —
    // an ordinary refactor that would have thrown at runtime, in a teardown
    // path, on node deletion.
    const r = createCameraStatusRegistry();
    r.publish('gone', status());
    const { sweep } = r;
    expect(() => sweep([])).not.toThrow();
    expect(r.read('gone')).toBeNull();
  });

  it('NEGATIVE CONTROL: sweep with everything live changes nothing', () => {
    // A sweep that dropped its own argument would satisfy the leg above by
    // accident — this is the direction that catches an inverted predicate.
    const r = createCameraStatusRegistry();
    r.publish('a', status());
    r.publish('b', status());
    r.sweep(['a', 'b']);
    expect(r.read('a')).not.toBeNull();
    expect(r.read('b')).not.toBeNull();
  });
});

describe('camera-status-registry — the singleton', () => {
  it('exports a live registry the card and the face body share', () => {
    // Two consumers reaching two registries is the whole failure mode this file
    // exists to prevent; the singleton is what makes them one.
    const acquire = vi.fn();
    const lease = cameraStatus.registerCommands('singleton-probe', { acquire });
    cameraStatus.publish('singleton-probe', status({ state: 'streaming' }));
    expect(cameraStatus.read('singleton-probe')!.state).toBe('streaming');
    expect(cameraStatus.request('singleton-probe').delivered).toBe(true);
    lease.release();
    cameraStatus.clear('singleton-probe');
  });
});

describe('SOURCE gate: `CameraState` IS the card\'s `State` — the claim nobody checked', () => {
  // ⚠ NO RUNTIME TEST CAN SEE THIS, AND THE CLAIM WAS ALREADY IN THE TREE.
  // `camera-device.ts`'s header says its union is "kept BYTE-IN-SYNC with the
  // card's `State` union" — but the card's `State` is a local type alias inside
  // a `.svelte` <script>, never exported and never imported, so nothing could
  // compare them. It was a comment, not a contract.
  //
  // It matters now that `camera-status-registry` publishes across a surface
  // boundary: a state added to the card and not to `CameraState` is a string the
  // dock face's lamp cannot render, and every runtime assertion stays green
  // because the card never annotates its publish with the narrower type.
  //
  // This gate is why the registry re-exports `CameraState` instead of declaring
  // a third copy: two definitions with one gate between them, rather than three
  // definitions and a promise.
  function unionMembers(source: string, afterMarker: string): string[] {
    const at = source.indexOf(afterMarker);
    expect(at, `${afterMarker} must be present`).toBeGreaterThan(-1);
    const tail = source.slice(at + afterMarker.length);
    const end = tail.indexOf(';');
    expect(end, 'the union must terminate').toBeGreaterThan(-1);
    return [...tail.slice(0, end).matchAll(/'([a-z-]+)'/g)].map((m) => m[1]!).sort();
  }

  it('the card and `camera-device.ts` declare the SAME capture states', () => {
    const cardStates = unionMembers(readFileSync(CARD_PATH, 'utf8'), 'type State =');
    const deviceStates = unionMembers(
      readFileSync(DEVICE_PATH, 'utf8'),
      'export type CameraState =',
    );
    expect(deviceStates, '`CameraState` must equal the card\'s `State` union').toEqual(cardStates);
  });

  it('and the registry re-exports that union rather than re-typing it', () => {
    // ⚠ ANCHORED TO THE ARTIFACT: the alias is what makes the gate above cover
    // the registry too. Someone "simplifying" it back into a literal union
    // restores the third copy the gate can no longer see, so the shape itself is
    // asserted at the source.
    const reg = readFileSync(
      fileURLToPath(new URL('./camera-status-registry.ts', import.meta.url)),
      'utf8',
    );
    expect(reg, 'the registry must ALIAS CameraState, never re-declare the members')
      .toContain('export type CameraCaptureState = CameraState;');
    expect(
      /export type CameraCaptureState =\s*\n?\s*\|/.test(reg),
      'a re-typed union here is a third copy the source gate cannot compare',
    ).toBe(false);
  });

  it('POSITIVE CONTROL: the scan really finds states, and finds the known ones', () => {
    // Membership, not size — a scan that silently stopped matching would make
    // the leg above compare [] to [] and pass.
    const cardStates = unionMembers(readFileSync(CARD_PATH, 'utf8'), 'type State =');
    for (const s of ['streaming', 'permission-denied', 'device-in-use'] as CameraCaptureState[]) {
      expect(cardStates, `${s} is a real card state and the scan must see it`).toContain(s);
    }
  });

  it('NEGATIVE CONTROL: the parser rejects a union it cannot terminate', () => {
    expect(() => unionMembers("type State =\n  | 'idle'", 'type State =')).toThrow();
  });
});
