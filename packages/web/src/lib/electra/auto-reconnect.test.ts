// packages/web/src/lib/electra/auto-reconnect.test.ts
//
// The (load, device-connect) edge machine behind the automatic Electra
// re-flash (#2248), driven through fake deps + a manual timer so every edge,
// debounce collapse and safety rail is asserted with no Web MIDI and no clock.

import { describe, it, expect } from 'vitest';
import { ElectraAutoReconnect, type AutoReconnectDeps } from './auto-reconnect';

/** Manual scheduler: collects scheduled callbacks; `fire()` runs them all. */
function makeTimers() {
  let nextId = 1;
  const pending = new Map<number, () => void>();
  return {
    schedule: (fn: () => void, _ms: number) => {
      const id = nextId++;
      pending.set(id, fn);
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearScheduled: (t: ReturnType<typeof setTimeout>) => {
      pending.delete(t as unknown as number);
    },
    fire(): number {
      const fns = [...pending.values()];
      pending.clear();
      for (const fn of fns) fn();
      return fns.length;
    },
    pendingCount: () => pending.size,
  };
}

interface HarnessOpts {
  midiSupported?: boolean;
  permission?: 'granted' | 'denied' | 'prompt' | 'unknown';
  connectOk?: boolean;
  devicePresent?: boolean;
  nodeId?: string | null;
}

function makeHarness(opts: HarnessOpts = {}) {
  const timers = makeTimers();
  const flashes: string[] = [];
  const state = {
    permission: opts.permission ?? 'granted',
    connectOk: opts.connectOk ?? true,
    present: opts.devicePresent ?? true,
    nodeId: opts.nodeId === undefined ? 'ec-1' : opts.nodeId,
    permissionQueries: 0,
    connects: 0,
  };
  let stateChange: (() => void) | null = null;
  const deps: AutoReconnectDeps = {
    midiSupported: () => opts.midiSupported ?? true,
    permissionState: async () => {
      state.permissionQueries++;
      return state.permission;
    },
    connect: async () => {
      state.connects++;
      return state.connectOk;
    },
    devicePresent: () => state.present,
    onStateChange: (fn) => {
      stateChange = fn;
      return () => {
        if (stateChange === fn) stateChange = null;
      };
    },
    findElectraNodeId: () => state.nodeId,
    flash: (nodeId) => flashes.push(nodeId),
    schedule: timers.schedule,
    clearScheduled: timers.clearScheduled,
    settleMs: 1,
  };
  const machine = new ElectraAutoReconnect(deps);
  return {
    machine,
    flashes,
    state,
    timers,
    /** Simulate one MIDI port statechange event. */
    emitStateChange: () => stateChange?.(),
    hasStateListener: () => stateChange !== null,
    /** Let the async init settle. */
    tick: () => new Promise<void>((r) => setTimeout(r, 0)),
  };
}

describe('ElectraAutoReconnect', () => {
  it('load edge + device already present → exactly one flash, for the electra node', async () => {
    const h = makeHarness({ devicePresent: true });
    h.machine.notifyPatchLoaded();
    await h.tick();
    expect(h.flashes).toEqual(['ec-1']);
    // The armed edge is consumed — later statechange churn with the device
    // still present re-flashes nothing.
    h.emitStateChange();
    h.emitStateChange();
    h.timers.fire();
    expect(h.flashes).toEqual(['ec-1']);
  });

  it('load edge with the device ABSENT stays armed; a hot-plug flashes once', async () => {
    const h = makeHarness({ devicePresent: false });
    h.machine.notifyPatchLoaded();
    await h.tick();
    expect(h.flashes).toEqual([]);
    // Device appears — the Electra surfaces its ports as a BURST of
    // statechange events; the debounce collapses them to one evaluate.
    h.state.present = true;
    h.emitStateChange();
    h.emitStateChange();
    h.emitStateChange();
    expect(h.timers.pendingCount()).toBe(1); // collapsed, not three timers
    h.timers.fire();
    expect(h.flashes).toEqual(['ec-1']);
  });

  it('unplug → replug is a fresh device edge and re-flashes (re-wires a power-cycled device)', async () => {
    const h = makeHarness({ devicePresent: true });
    h.machine.notifyPatchLoaded();
    await h.tick();
    expect(h.flashes).toEqual(['ec-1']);
    h.state.present = false;
    h.emitStateChange();
    h.timers.fire();
    expect(h.flashes).toEqual(['ec-1']); // falling edge flashes nothing
    h.state.present = true;
    h.emitStateChange();
    h.timers.fire();
    expect(h.flashes).toEqual(['ec-1', 'ec-1']);
  });

  it('rail 1: no electraControl node → fully dormant (no permission query, no connect)', async () => {
    const h = makeHarness({ nodeId: null });
    h.machine.notifyPatchLoaded();
    await h.tick();
    expect(h.state.permissionQueries).toBe(0);
    expect(h.state.connects).toBe(0);
    expect(h.flashes).toEqual([]);
    expect(h.hasStateListener()).toBe(false);
  });

  it('rail 2: permission not already granted → queries but NEVER connects (no ungestured prompt)', async () => {
    for (const permission of ['prompt', 'denied', 'unknown'] as const) {
      const h = makeHarness({ permission });
      h.machine.notifyPatchLoaded();
      await h.tick();
      expect(h.state.permissionQueries, permission).toBe(1);
      expect(h.state.connects, permission).toBe(0);
      expect(h.flashes, permission).toEqual([]);
    }
  });

  it('no Web MIDI at all → dormant without even a permission query', async () => {
    const h = makeHarness({ midiSupported: false });
    h.machine.notifyPatchLoaded();
    await h.tick();
    expect(h.state.permissionQueries).toBe(0);
    expect(h.flashes).toEqual([]);
  });

  it('connect() failing → quiet, no flash, no listener', async () => {
    const h = makeHarness({ connectOk: false });
    h.machine.notifyPatchLoaded();
    await h.tick();
    expect(h.flashes).toEqual([]);
    expect(h.hasStateListener()).toBe(false);
  });

  it('two load arms inside one settle window coalesce to ONE flash; a later load flashes again', async () => {
    const h = makeHarness({ devicePresent: true });
    h.machine.notifyPatchLoaded();
    await h.tick(); // init tail flashed for the first arm
    expect(h.flashes).toEqual(['ec-1']);
    // A double arm (e.g. a load path that also nudges the mount latch): both
    // land before the settle timer fires → one flash, not two.
    h.machine.notifyPatchLoaded();
    h.machine.notifyPatchLoaded();
    expect(h.timers.pendingCount()).toBe(1);
    h.timers.fire();
    expect(h.flashes).toEqual(['ec-1', 'ec-1']);
    // A genuinely separate later load is its own edge.
    h.machine.notifyPatchLoaded();
    h.timers.fire();
    expect(h.flashes).toEqual(['ec-1', 'ec-1', 'ec-1']);
  });

  it('node deleted between arming and evaluate → the edge is dropped, not deferred', async () => {
    const h = makeHarness({ devicePresent: false });
    h.machine.notifyPatchLoaded();
    await h.tick();
    h.state.nodeId = null; // module deleted while the device was away
    h.state.present = true;
    h.emitStateChange();
    h.timers.fire();
    expect(h.flashes).toEqual([]);
    // And the consumed edge does not resurrect when a node appears again —
    // only a NEW load / device edge can arm.
    h.state.nodeId = 'ec-2';
    h.emitStateChange();
    h.timers.fire();
    expect(h.flashes).toEqual([]);
  });

  it('a permission-less first load stays dormant for later loads too (init runs once)', async () => {
    const h = makeHarness({ permission: 'prompt' });
    h.machine.notifyPatchLoaded();
    await h.tick();
    h.machine.notifyPatchLoaded();
    h.timers.fire();
    await h.tick();
    expect(h.state.permissionQueries).toBe(1); // init ran exactly once
    expect(h.flashes).toEqual([]);
  });

  it('stop() cancels the pending settle timer and unsubscribes', async () => {
    const h = makeHarness({ devicePresent: false });
    h.machine.notifyPatchLoaded();
    await h.tick();
    expect(h.hasStateListener()).toBe(true);
    h.state.present = true;
    h.emitStateChange();
    h.machine.stop();
    expect(h.hasStateListener()).toBe(false);
    expect(h.timers.fire()).toBe(0); // timer was cleared, nothing runs
    expect(h.flashes).toEqual([]);
  });
});
