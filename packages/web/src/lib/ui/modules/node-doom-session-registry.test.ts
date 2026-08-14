// node-doom-session-registry.test.ts
//
// The contract that makes a DOOM netgame survive a card unmount (#1590, the
// last row of the #1583 audit).
//
// ⚠ WHAT THESE LEGS ARE FOR. The defect was NOT "the netcode stopped" — it was
// "the netcode stopped BECAUSE A COMPONENT UNMOUNTED", and a card unmounts for
// reasons that have nothing to do with the player leaving: collapse, dock LRU
// eviction, ESC, M/E, navigation. Mid-netgame that unmount froze EVERY peer:
// `netcode.stop()` closed the peer connections + unbound Module.PTNet from the
// running WASM, and the card rAF that died with it was the lockstep pump — a
// starved barrier PAUSES by design (#345 consistency-abort semantics). So every
// leg below is about WHO may stop the session and WHEN, and about the PUMP
// outliving the mount — not about whether stopping works.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { nodeDoomSession, type DoomSessionWiring } from './node-doom-session-registry.svelte';
import type { DoomNetcode } from '$lib/doom/doom-netcode';

/** A DoomNetcode stub recording the calls the registry is allowed to make. */
function makeNetcode() {
  return {
    started: 0,
    stopped: 0,
    start() {
      this.started += 1;
    },
    stop() {
      this.stopped += 1;
    },
    isArbiter: () => true,
    debugStats: () => ({ peers: ['peer-b'], isArbiter: true, ticLag: 0, transport: 'webrtc' }),
  };
}

function makeWiring(overrides: Partial<DoomSessionWiring> = {}) {
  const calls = {
    pump: 0,
    detach: 0,
    onSweep: 0,
    gameStarts: [] as unknown[],
    ticcmds: [] as unknown[],
    arbiter: [] as boolean[],
  };
  const wiring: DoomSessionWiring = {
    pump: () => {
      calls.pump += 1;
    },
    detach: () => {
      calls.detach += 1;
    },
    onArbiter: (v) => {
      calls.arbiter.push(v);
    },
    onGameStart: (env) => {
      calls.gameStarts.push(env);
    },
    onRemoteTiccmd: (env) => {
      calls.ticcmds.push(env);
    },
    probeExtras: () => ({ gametic: 123, ptnetBound: true }),
    onSweep: () => {
      calls.onSweep += 1;
    },
    ...overrides,
  };
  return { wiring, calls };
}

afterEach(() => {
  // The registry is a singleton; each test sweeps its ids away.
  nodeDoomSession.sweep([]);
  vi.useRealTimers();
});

describe('the card ADOPTS; it never creates or destroys', () => {
  it('re-adopt (a REMOUNT) is non-destructive — netcode, launch state and cursors survive', () => {
    const m1 = makeWiring();
    nodeDoomSession.adopt('d1', m1.wiring);
    const nc = makeNetcode();
    nodeDoomSession.ensureNetcode('d1', () => nc as unknown as DoomNetcode);
    const s = nodeDoomSession.session('d1');
    s.launched = true;
    s.lockstepGeneration = 7;
    s.lockstepAppendedThru = 41;

    // Collapse → expand: a NEW mount adopts with fresh wiring.
    const m2 = makeWiring();
    nodeDoomSession.adopt('d1', m2.wiring);

    expect(nc.stopped, 'a re-adopt must never stop the netcode — that IS #1590').toBe(0);
    expect(nc.started, 'and must not double-start it').toBe(1);
    const after = nodeDoomSession.session('d1');
    expect(after.netcode, 'the remounted card adopts the LIVE netcode instance').toBe(nc);
    expect(after.netStarted).toBe(true);
    expect(after.launched, 'launch state is a property of the SESSION, not of a mount').toBe(true);
    expect(
      after.lockstepAppendedThru,
      'the gap-free append cursor survives — a reset cursor would starve the barrier at the current tic',
    ).toBe(41);
    expect(after.lockstepGeneration).toBe(7);
    // Exactly one wiring live per node: the OLD mount observers were detached.
    expect(m1.calls.detach, "the previous mount's observers are detached ON REPLACE").toBe(1);
    expect(m2.calls.detach, "…never the new mount's").toBe(0);
  });

  it('ensureNetcode is create-once — a second call adopts, it does not build a rival transport', () => {
    nodeDoomSession.adopt('d2', makeWiring().wiring);
    const nc = makeNetcode();
    const first = nodeDoomSession.ensureNetcode('d2', () => nc as unknown as DoomNetcode);
    let secondFactoryRan = false;
    const second = nodeDoomSession.ensureNetcode('d2', () => {
      secondFactoryRan = true;
      return makeNetcode() as unknown as DoomNetcode;
    });
    expect(second).toBe(first);
    expect(secondFactoryRan, 'the factory must not even run when an instance is live').toBe(false);
    expect(nodeDoomSession.session('d2').isNetArbiter, 'arbiter status is read off the instance').toBe(true);
  });

  it('the session record is readable before adopt — a card reads it during component init', () => {
    const s = nodeDoomSession.session('never-adopted');
    expect(s.launched).toBe(false);
    expect(s.netcode).toBeNull();
    expect(s.lockstepAppendedThru).toBe(-1);
  });
});

describe('netcode events reach the CURRENT wiring — trampolines, not captured closures', () => {
  it('after a remount, dispatch() routes to the new mount, never the dead one', () => {
    const m1 = makeWiring();
    nodeDoomSession.adopt('d3', m1.wiring);
    nodeDoomSession.dispatch('d3').onGameStart({ launchId: 1, settings: {} as never });
    expect(m1.calls.gameStarts.length).toBe(1);

    const m2 = makeWiring();
    nodeDoomSession.adopt('d3', m2.wiring); // remount
    nodeDoomSession.dispatch('d3').onGameStart({ launchId: 2, settings: {} as never });
    nodeDoomSession.dispatch('d3').onArbiter(false);

    expect(m1.calls.gameStarts.length, 'the dead mount must not receive events').toBe(1);
    expect(m2.calls.gameStarts.length).toBe(1);
    expect(m2.calls.arbiter).toEqual([false]);
  });

  it('dispatch on an unknown id is a callable no-op, not a TypeError inside an awareness handler', () => {
    expect(() => nodeDoomSession.dispatch('ghost').onRemoteTiccmd({} as never)).not.toThrow();
  });
});

describe('THE PUMP outlives the mount — the mechanism whose death froze every peer', () => {
  it('the registry frame loop keeps invoking the wiring pump; a throw does not kill the loop', () => {
    vi.useFakeTimers(); // node has no rAF → the registry falls back to 16 ms timeouts
    const counts = { pump: 0 };
    let throwOnce = true;
    const m = makeWiring({
      pump: () => {
        counts.pump += 1;
        if (throwOnce) {
          throwOnce = false;
          throw new Error('one bad frame');
        }
      },
    });
    nodeDoomSession.adopt('d4', m.wiring);

    vi.advanceTimersByTime(16 * 10);
    expect(
      counts.pump,
      'units: pump invocations across 10 frames — the loop must survive frame 1 throwing',
    ).toBeGreaterThanOrEqual(9);

    // The probe's causal counter counts SUCCESSFUL pump runs only.
    const probe = nodeDoomSession.probe('d4') as { pumpRuns: number };
    expect(probe.pumpRuns).toBe(counts.pump - 1);
  });

  it('sweep stops the loop — pumpRuns freezes once the node leaves the graph', () => {
    vi.useFakeTimers();
    const m = makeWiring();
    nodeDoomSession.adopt('d5', m.wiring);
    vi.advanceTimersByTime(16 * 5);
    const before = m.calls.pump;
    expect(before, 'baseline: the pump must be live before the sweep').toBeGreaterThan(0);

    nodeDoomSession.sweep([]);
    vi.advanceTimersByTime(16 * 10);
    expect(m.calls.pump, 'a swept node must not keep pumping — that would be a leak').toBe(before);
  });
});

describe('THE DEFECT: only a USER ACTION or the GRAPH SWEEP may stop the session', () => {
  it('a node still in the graph keeps its netcode across a sweep', () => {
    nodeDoomSession.adopt('d6', makeWiring().wiring);
    const nc = makeNetcode();
    nodeDoomSession.ensureNetcode('d6', () => nc as unknown as DoomNetcode);

    // The graph still holds the node — this is every collapse, every LRU
    // eviction, every ESC. Nothing may be released.
    nodeDoomSession.sweep(['d6', 'other']);

    expect(nc.stopped, 'a live node was swept away while still in the graph').toBe(0);
    expect(nodeDoomSession.session('d6').netStarted).toBe(true);
  });

  it('the sweep DOES release a node the graph no longer has — stop, onSweep, detach, entry gone', () => {
    const m = makeWiring();
    nodeDoomSession.adopt('d7', m.wiring);
    const nc = makeNetcode();
    nodeDoomSession.ensureNetcode('d7', () => nc as unknown as DoomNetcode);

    nodeDoomSession.sweep([]); // node deleted from the graph

    expect(nc.stopped, 'a deleted node must stop its netcode').toBe(1);
    expect(m.calls.onSweep, 'graph teardown runs the wiring onSweep (barrier disarm + floor clear)').toBe(1);
    expect(m.calls.detach, 'and detaches the last mount observers').toBe(1);
    expect((nodeDoomSession.probe('d7') as { hasEntry: boolean }).hasEntry).toBe(false);
  });

  it('leaveGame() is the USER control and does release the transport — it is not dead code', () => {
    nodeDoomSession.adopt('d8', makeWiring().wiring);
    const nc = makeNetcode();
    nodeDoomSession.ensureNetcode('d8', () => nc as unknown as DoomNetcode);
    const s = nodeDoomSession.session('d8');
    s.launched = true;
    s.lockstepActive = true;
    s.lockstepAppendedThru = 9;

    nodeDoomSession.leaveGame('d8');

    expect(nc.stopped).toBe(1);
    expect(s.netcode).toBeNull();
    expect(s.netStarted).toBe(false);
    expect(s.isNetArbiter).toBe(false);
    expect(s.lockstepActive).toBe(false);
    expect(s.lockstep).toBeNull();
    expect(s.lockstepNextTic).toBe(0);
    expect(s.lockstepAppendedThru).toBe(-1);
    // Field-for-field parity with the old card-side stopNetcode(): `launched`
    // was NOT reset there and is not reset here — a pruned peer's card still
    // knows a game is running (it spectates it).
    expect(s.launched).toBe(true);
  });
});

describe('THE STRUCTURAL GUARD — there is no card-lifecycle teardown to call', () => {
  // The regression this file exists to prevent is a future `onDestroy` that
  // reaches for a teardown method. The defence is that no such method EXISTS,
  // so `tsc` refuses the call before any test runs. This leg pins that, and is
  // deliberately a PERMANENT NEGATIVE CONTROL: it fails the moment someone adds
  // one back, which is exactly when a human should be asked why.
  const LIFECYCLE_NAMES = ['dispose', 'destroy', 'teardown', 'unmount', 'onCardUnmount', 'release'];

  it('exposes no method named for a component lifecycle event', () => {
    const surface = new Set<string>();
    let proto: object | null = Object.getPrototypeOf(nodeDoomSession);
    while (proto && proto !== Object.prototype) {
      for (const k of Object.getOwnPropertyNames(proto)) surface.add(k);
      proto = Object.getPrototypeOf(proto);
    }
    const offenders = LIFECYCLE_NAMES.filter((n) => surface.has(n));
    expect(
      offenders,
      `a lifecycle-named method is an invitation to call it from onDestroy — which IS #1590 ` +
        `(mid-netgame it freezes EVERY peer, #345 semantics). The two legitimate releases are ` +
        `leaveGame() (the user lost/gave up its seat) and sweep() (the graph lost the node).`,
    ).toEqual([]);
  });

  it('…and the guard is not vacuous: it CAN see a method that is present', () => {
    const surface = new Set(Object.getOwnPropertyNames(Object.getPrototypeOf(nodeDoomSession)));
    // Positive control on the same predicate the leg above uses: `leaveGame`
    // and `sweep` really are on the surface, so an empty offender list means
    // "none of those names", not "the reflection found nothing".
    expect(surface.has('leaveGame')).toBe(true);
    expect(surface.has('sweep')).toBe(true);
  });
});

describe('the probe reads more than the registry opinion', () => {
  it('folds LIVE wiring readings (engine tics, PTNet bound) into the node record', () => {
    nodeDoomSession.adopt('d9', makeWiring().wiring);
    const nc = makeNetcode();
    nodeDoomSession.ensureNetcode('d9', () => nc as unknown as DoomNetcode);
    nodeDoomSession.session('d9').launched = true;

    const p = nodeDoomSession.probe('d9') as Record<string, unknown>;
    expect(p.hasEntry).toBe(true);
    expect(p.wired).toBe(true);
    expect(p.launched).toBe(true);
    expect(p.netcodePeers).toEqual(['peer-b']);
    expect(p.gametic, 'engine-side reading came through the wiring').toBe(123);
    expect(p.ptnetBound).toBe(true);
  });

  it('an unknown node reads as absent, not as a throw', () => {
    expect(nodeDoomSession.probe('nope')).toEqual({ hasEntry: false, wired: false, pumpRuns: -1 });
  });

  it('a throwing probeExtras is reported, not fatal', () => {
    nodeDoomSession.adopt('d10', makeWiring({
      probeExtras: () => {
        throw new Error('extras gone');
      },
    }).wiring);
    const p = nodeDoomSession.probe('d10') as Record<string, unknown>;
    expect(p.hasEntry).toBe(true);
    expect(p.probeExtrasThrew).toBe(true);
  });
});
