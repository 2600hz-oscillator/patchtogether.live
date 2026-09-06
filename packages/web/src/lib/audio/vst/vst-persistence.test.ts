// Tests for the VST persistence/auto-remount driver — every branch through
// injected IO and MANUAL timers (no store, no socket, no clock).

import { describe, expect, it } from 'vitest';
import {
  VST_STATE_B64_CAP,
  VstPersistenceDriver,
  type VstDriverSnapshot,
  type VstPersisted,
} from './vst-persistence';

interface FakeTimer {
  fn: () => void;
  ms: number;
  cleared: boolean;
}

function harness(initial?: VstPersisted) {
  let stored: VstPersisted | undefined = initial;
  const writes: Array<VstPersisted | undefined> = [];
  const sent: Array<Record<string, unknown>> = [];
  const timers: FakeTimer[] = [];
  const driver = new VstPersistenceDriver({
    read: () => stored,
    write: (next) => {
      stored = next;
      writes.push(next);
    },
    send: (msg) => sent.push(msg),
    setTimer: (fn, ms) => {
      const t: FakeTimer = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      (t as FakeTimer).cleared = true;
    },
  });
  const firePending = (ms?: number) => {
    for (const t of [...timers]) {
      if (!t.cleared && (ms === undefined || t.ms === ms)) {
        timers.splice(timers.indexOf(t), 1);
        t.fn();
      }
    }
  };
  const live = () => timers.filter((t) => !t.cleared);
  /** An EXTERNAL replacement of the record — what a same-session patch load
   *  does to `data.vst` (a fresh object, not a driver write). */
  const load = (next: VstPersisted | undefined) => { stored = next; };
  return { driver, sent, writes, firePending, live, load, get stored() { return stored; } };
}

function snap(over: Partial<VstDriverSnapshot> = {}): VstDriverSnapshot {
  return {
    state: 'connected',
    plugins: [{ id: 'au:x' }, { id: 'au:y' }],
    mounted: null,
    mountError: null,
    editorOpen: false,
    pluginState: null,
    unmounts: 0,
    ...over,
  };
}

const IDLE = snap({ state: 'idle', plugins: [] });

describe('cold remount (no adopt replay within the grace)', () => {
  it('mounts the persisted plugin after the grace, then applies the blob to OUR mount exactly once', () => {
    const h = harness({ pluginId: 'au:x', stateB64: 'BLOB', stateBytes: 4 });
    h.driver.onSnapshot(IDLE);
    h.driver.onSnapshot(snap());
    expect(h.sent).toEqual([]); // nothing before the grace
    h.firePending();
    expect(h.sent).toEqual([{ type: 'mount', pluginId: 'au:x' }]);
    h.driver.onSnapshot(snap({ mounted: { plugin: { id: 'au:x' } } }));
    expect(h.sent[1]).toEqual({ type: 'setState', data: 'BLOB' });
    // and never a second time
    h.driver.onSnapshot(snap({ mounted: { plugin: { id: 'au:x' } } }));
    expect(h.sent.filter((m) => m.type === 'setState')).toHaveLength(1);
  });

  it('refuses to cold-mount a plugin the helper does not list', () => {
    const h = harness({ pluginId: 'au:gone', stateB64: 'BLOB' });
    h.driver.onSnapshot(IDLE);
    h.driver.onSnapshot(snap());
    h.firePending();
    expect(h.sent).toEqual([]);
  });

  it('re-arms on a RECONNECT even though the plugin list never emptied', () => {
    const h = harness({ pluginId: 'au:x' });
    h.driver.onSnapshot(IDLE);
    h.driver.onSnapshot(snap());
    h.firePending();
    h.sent.length = 0;
    h.driver.onSnapshot(snap({ state: 'disconnected' }));
    h.driver.onSnapshot(snap()); // reconnected; plugins were already populated
    h.firePending();
    expect(h.sent).toEqual([{ type: 'mount', pluginId: 'au:x' }]);
  });

  it('a mountError for OUR pending mount drops the stashed blob — a later user mount is a capture, not a setState', () => {
    const h = harness({ pluginId: 'au:x', stateB64: 'BLOB' });
    h.driver.onSnapshot(IDLE);
    h.driver.onSnapshot(snap());
    h.firePending();
    h.driver.onSnapshot(snap({ mountError: { pluginId: 'au:x' } }));
    h.driver.onSnapshot(snap({ mounted: { plugin: { id: 'au:x' } } }));
    expect(h.sent.filter((m) => m.type === 'setState')).toHaveLength(0);
    expect(h.sent.filter((m) => m.type === 'getState')).toHaveLength(1);
  });
});

describe('adopt replay / user mounts — never setState over a live instance', () => {
  it('an adopt replay inside the grace cancels the cold mount, keeps the blob, and refreshes state', () => {
    const h = harness({ pluginId: 'au:x', stateB64: 'BLOB', stateBytes: 4 });
    h.driver.onSnapshot(IDLE);
    h.driver.onSnapshot(snap());
    h.driver.onSnapshot(snap({ mounted: { plugin: { id: 'au:x' } } })); // replay
    h.firePending(1000); // the grace timer was cancelled — must not mount
    expect(h.sent.filter((m) => m.type === 'mount')).toHaveLength(0);
    expect(h.sent.filter((m) => m.type === 'setState')).toHaveLength(0);
    expect(h.sent.filter((m) => m.type === 'getState')).toHaveLength(1);
    // Same plugin ⇒ the persisted blob SURVIVES the re-write.
    expect(h.stored).toEqual({ pluginId: 'au:x', stateB64: 'BLOB', stateBytes: 4 });
  });

  it('a user mount of a DIFFERENT plugin drops the stale blob and captures the new state', () => {
    const h = harness({ pluginId: 'au:x', stateB64: 'STALE' });
    h.driver.onSnapshot(IDLE);
    h.driver.onSnapshot(snap({ mounted: { plugin: { id: 'au:y' } } }));
    expect(h.stored).toEqual({ pluginId: 'au:y' });
    expect(h.sent).toEqual([{ type: 'getState' }]);
  });
});

describe('state capture + the cap', () => {
  it('persists a state reply with its size', () => {
    const h = harness();
    h.driver.onSnapshot(IDLE);
    h.driver.onSnapshot(snap({ mounted: { plugin: { id: 'au:x' } } }));
    h.driver.onSnapshot(snap({
      mounted: { plugin: { id: 'au:x' } },
      pluginState: { pluginId: 'au:x', data: 'QUJD' },
    }));
    expect(h.stored).toEqual({ pluginId: 'au:x', stateB64: 'QUJD', stateBytes: 4 });
  });

  it('an OVERSIZED blob keeps pluginId + size only (plan Q2: parked instance + plugin-side saving carry it)', () => {
    const h = harness();
    const big = 'A'.repeat(VST_STATE_B64_CAP + 1);
    h.driver.onSnapshot(IDLE);
    h.driver.onSnapshot(snap({ mounted: { plugin: { id: 'au:x' } } }));
    h.driver.onSnapshot(snap({
      mounted: { plugin: { id: 'au:x' } },
      pluginState: { pluginId: 'au:x', data: big },
    }));
    expect(h.stored).toEqual({ pluginId: 'au:x', stateBytes: big.length });
  });

  it('editor close triggers a state refresh', () => {
    const h = harness();
    h.driver.onSnapshot(IDLE);
    h.driver.onSnapshot(snap({ mounted: { plugin: { id: 'au:x' } }, editorOpen: true }));
    h.sent.length = 0;
    h.driver.onSnapshot(snap({ mounted: { plugin: { id: 'au:x' } }, editorOpen: false }));
    expect(h.sent).toEqual([{ type: 'getState' }]);
  });

  it('refreshes state on the slow cadence while mounted, and stops when unmounted', () => {
    const h = harness();
    h.driver.onSnapshot(IDLE);
    h.driver.onSnapshot(snap({ mounted: { plugin: { id: 'au:x' } } }));
    h.sent.length = 0;
    h.firePending(60_000);
    expect(h.sent).toEqual([{ type: 'getState' }]);
    // unmount stops the cadence
    h.driver.onSnapshot(snap({ mounted: null, unmounts: 1 }));
    expect(h.live().filter((t) => t.ms === 60_000)).toHaveLength(0);
  });
});

describe('clearing — explicit unmount ONLY', () => {
  it('an explicit unmount clears the record', () => {
    const h = harness({ pluginId: 'au:x', stateB64: 'BLOB' });
    h.driver.onSnapshot(IDLE);
    h.driver.onSnapshot(snap({ mounted: { plugin: { id: 'au:x' } } }));
    h.driver.onSnapshot(snap({ mounted: null, unmounts: 1 }));
    expect(h.stored).toBeUndefined();
  });

  it('a fresh-session stale-mount invalidation (mounted→null, NO unmounted) keeps the record — that is what auto-remount uses', () => {
    const h = harness();
    h.driver.onSnapshot(IDLE);
    h.driver.onSnapshot(snap({ mounted: { plugin: { id: 'au:x' } } }));
    h.driver.onSnapshot(snap({
      mounted: { plugin: { id: 'au:x' } },
      pluginState: { pluginId: 'au:x', data: 'BLOB' },
    }));
    expect(h.stored).toBeTruthy();
    // helper restarts: owner nulls mounted on the fresh helperInfo, unmounts unchanged
    h.driver.onSnapshot(snap({ state: 'disconnected', mounted: { plugin: { id: 'au:x' } } }));
    h.driver.onSnapshot(snap({ mounted: null }));
    expect(h.stored).toEqual({ pluginId: 'au:x', stateB64: 'BLOB', stateBytes: 4 });
    // and the grace now cold-remounts it
    h.sent.length = 0;
    h.firePending(1000);
    expect(h.sent).toEqual([{ type: 'mount', pluginId: 'au:x' }]);
  });
});

describe('same-session patch load — data.vst replaced under a LIVE driver', () => {
  // `loadEnvelopeIntoStore` deletes + re-inserts every node in one
  // transaction and the reconciler never re-materializes a reused id, so the
  // driver, its socket, and its mounted plugin all SURVIVE a load that
  // replaces the record. Pre-fix the driver never re-read it — and its next
  // state capture PERSISTED the still-mounted plugin back over the loaded
  // record, silently reverting the load in the doc.

  /** Boot to "connected, au:x mounted by the user, state S1 captured". */
  function mountedX() {
    const h = harness();
    h.driver.onSnapshot(IDLE);
    h.driver.onSnapshot(snap({ mounted: { plugin: { id: 'au:x' } } }));
    h.driver.onSnapshot(snap({
      mounted: { plugin: { id: 'au:x' } },
      pluginState: { pluginId: 'au:x', data: 'S1' },
    }));
    expect(h.stored).toEqual({ pluginId: 'au:x', stateB64: 'S1', stateBytes: 2 });
    h.sent.length = 0;
    return h;
  }

  it('a loaded DIFFERENT plugin is swap-mounted, its blob applied to OUR mount, and a stale state reply cannot revert the record', () => {
    const h = mountedX();
    h.load({ pluginId: 'au:y', stateB64: 'B2', stateBytes: 2 });

    // The very snapshot that would have reverted the doc pre-fix: au:x still
    // mounted, and a state reply for it in flight.
    h.driver.onSnapshot(snap({
      mounted: { plugin: { id: 'au:x' } },
      pluginState: { pluginId: 'au:x', data: 'S1-NEWER' },
    }));
    expect(h.stored, 'the loaded record must SURVIVE the stale capture').toEqual({
      pluginId: 'au:y', stateB64: 'B2', stateBytes: 2,
    });
    expect(h.sent).toEqual([{ type: 'mount', pluginId: 'au:y' }]);

    // The swap lands: the loaded blob is applied to OUR mount exactly once.
    h.driver.onSnapshot(snap({ mounted: { plugin: { id: 'au:y' } } }));
    expect(h.sent[1]).toEqual({ type: 'setState', data: 'B2' });

    // ...and from here captures persist normally, for the LOADED plugin.
    h.driver.onSnapshot(snap({
      mounted: { plugin: { id: 'au:y' } },
      pluginState: { pluginId: 'au:y', data: 'B2' },
    }));
    expect(h.stored).toEqual({ pluginId: 'au:y', stateB64: 'B2', stateBytes: 2 });
  });

  it('a loaded record for the SAME plugin applies its blob and re-captures', () => {
    const h = mountedX();
    h.load({ pluginId: 'au:x', stateB64: 'LOADED', stateBytes: 6 });
    h.driver.onSnapshot(snap({ mounted: { plugin: { id: 'au:x' } } }));
    expect(h.sent).toEqual([
      { type: 'setState', data: 'LOADED' },
      { type: 'getState' },
    ]);
    expect(h.stored, 'no write happened — the loaded record stands').toEqual({
      pluginId: 'au:x', stateB64: 'LOADED', stateBytes: 6,
    });
  });

  it('a loaded EMPTY record unmounts the live plugin and never re-persists it', () => {
    const h = mountedX();
    h.load(undefined);
    h.driver.onSnapshot(snap({ mounted: { plugin: { id: 'au:x' } } }));
    expect(h.sent).toEqual([{ type: 'unmount' }]);
    // The explicit unmount confirmation clears nothing the load didn't
    // already clear — and no capture may resurrect au:x in between.
    h.driver.onSnapshot(snap({
      mounted: { plugin: { id: 'au:x' } },
      pluginState: { pluginId: 'au:x', data: 'S1-NEWER' },
    }));
    expect(h.stored, 'a stale capture must not resurrect the unmounting plugin').toBeUndefined();
    h.driver.onSnapshot(snap({ mounted: null, unmounts: 1 }));
    expect(h.stored).toBeUndefined();
  });

  it('a loaded plugin the helper does not list: no mount, but the live plugin can no longer clobber the record; a USER mount lifts it', () => {
    const h = mountedX();
    h.load({ pluginId: 'au:gone', stateB64: 'B9' });
    h.driver.onSnapshot(snap({ mounted: { plugin: { id: 'au:x' } } }));
    expect(h.sent, 'nothing to mount — au:gone is not installed here').toEqual([]);

    // The still-mounted plugin's captures must not overwrite the loaded id.
    h.driver.onSnapshot(snap({
      mounted: { plugin: { id: 'au:x' } },
      pluginState: { pluginId: 'au:x', data: 'S1-NEWER' },
    }));
    expect(h.stored).toEqual({ pluginId: 'au:gone', stateB64: 'B9' });

    // The user acts: a foreign mount with nothing of ours in flight wins.
    h.driver.onSnapshot(snap({ mounted: { plugin: { id: 'au:y' } } }));
    expect(h.stored).toEqual({ pluginId: 'au:y' });
  });

  it('a load DURING the remount grace is picked up by the grace itself (no double mount)', () => {
    const h = harness({ pluginId: 'au:x', stateB64: 'OLD' });
    h.driver.onSnapshot(IDLE);
    h.driver.onSnapshot(snap()); // connected edge arms the grace
    h.load({ pluginId: 'au:y', stateB64: 'B2' });
    h.driver.onSnapshot(snap()); // a meter tick inside the grace window
    expect(h.sent, 'the grace window stays in charge').toEqual([]);
    h.firePending(1000);
    expect(h.sent).toEqual([{ type: 'mount', pluginId: 'au:y' }]);
    h.driver.onSnapshot(snap({ mounted: { plugin: { id: 'au:y' } } }));
    expect(h.sent[1]).toEqual({ type: 'setState', data: 'B2' });
  });

  it('a load while DISCONNECTED sends nothing; the reconnect cold-mounts the LOADED plugin', () => {
    const h = mountedX();
    h.driver.onSnapshot(snap({ state: 'disconnected', mounted: { plugin: { id: 'au:x' } } }));
    h.load({ pluginId: 'au:y', stateB64: 'B2' });
    h.driver.onSnapshot(snap({ state: 'disconnected', mounted: { plugin: { id: 'au:x' } } }));
    expect(h.sent).toEqual([]);
    h.driver.onSnapshot(snap({ mounted: null })); // reconnected, no adopt replay
    h.firePending(1000);
    expect(h.sent).toEqual([{ type: 'mount', pluginId: 'au:y' }]);
  });

  it('the driver’s OWN writes never read back as an external change (steady state stays quiet)', () => {
    const h = mountedX();
    for (let i = 0; i < 5; i++) {
      h.driver.onSnapshot(snap({ mounted: { plugin: { id: 'au:x' } } }));
    }
    // A fresh capture cycles through persist() and back through read().
    h.driver.onSnapshot(snap({
      mounted: { plugin: { id: 'au:x' } },
      pluginState: { pluginId: 'au:x', data: 'S2' },
    }));
    for (let i = 0; i < 5; i++) {
      h.driver.onSnapshot(snap({ mounted: { plugin: { id: 'au:x' } } }));
    }
    expect(h.sent, 'no mount/unmount/setState from echo confusion').toEqual([]);
    expect(h.stored).toEqual({ pluginId: 'au:x', stateB64: 'S2', stateBytes: 2 });
  });
});

describe('dispose', () => {
  it('cancels every timer and goes inert', () => {
    const h = harness({ pluginId: 'au:x' });
    h.driver.onSnapshot(IDLE);
    h.driver.onSnapshot(snap());
    h.driver.dispose();
    h.firePending();
    expect(h.sent).toEqual([]);
    expect(h.live()).toHaveLength(0);
  });
});
