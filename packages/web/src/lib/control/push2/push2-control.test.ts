// packages/web/src/lib/control/push2/push2-control.test.ts
//
// Integration test for the Push 2 control layer — the ADDITIVE features
// (channel-select, encoder→MixMasters, channel name) + the PARITY adapter (a
// simulated Push pad press flows through the injected control surface into the
// shipped launchpad-control brain and launches a clip). Driven through the REAL
// push2-device (simulated transport), the REAL launchpad-control singleton, and
// the REAL graph store; only the scheduler-clock is mocked so the LED render loop
// can be stepped manually.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ tick: null as null | (() => void) }));
vi.mock('$lib/audio/scheduler-clock', () => ({
  SCHEDULER_TICK_MS: 25,
  getSchedulerClock: () => ({
    subscribe: (fn: () => void) => {
      hoisted.tick = fn;
      return () => { hoisted.tick = null; };
    },
    usingWorker: false,
    dispose: () => {},
  }),
}));

import { patch as livePatch } from '$lib/graph/store';
import { flushAllCcCommits } from '$lib/ui/controls/cc-commit';
import { __test_resetBinding, boundClipNode } from '$lib/control/launchpad/launchpad-control.svelte';
import { __test_resetPush2 } from './push2-device.svelte';
import {
  installSimulatedPush2AndBind,
  __test_resetPush2Control,
  selectChannel,
  selectedChannelIndex,
  channelName,
  firstMixmstrs,
} from './push2-control.svelte';
import {
  PUSH_CC_ABOVE_DISPLAY_BASE,
  PUSH_CC_ENCODER_BASE,
  PUSH_CC_ENCODER_TEMPO,
  PUSH_CC_ENCODER_MASTER,
} from './push2-map';
import type { SimulatedPush2 } from './push2-device.svelte';

// The web vitest env is `node` (no localStorage) — the Push-local channel state
// persists there, so provide a minimal stub for the persistence assertions.
if (typeof localStorage === 'undefined') {
  const store = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  } as Storage;
}

const CP = 'cp1';
const MIX = 'mx1';

function clearPatch() {
  for (const k of Object.keys(livePatch.nodes)) delete livePatch.nodes[k];
  for (const k of Object.keys(livePatch.edges)) delete livePatch.edges[k];
}
function seedClipPlayer(data: Record<string, unknown> = {}) {
  livePatch.nodes[CP] = {
    id: CP, type: 'clipplayer', domain: 'audio', position: { x: 0, y: 0 }, params: {}, data,
  } as never;
}
function seedMixmstrs(params: Record<string, number> = {}) {
  livePatch.nodes[MIX] = {
    id: MIX, type: 'mixmstrs', domain: 'audio', position: { x: 0, y: 0 },
    params: { ch1_volume: 0.8, ch3_send1: 0, master_volume: 0.8, ...params }, data: {},
  } as never;
}

let sim: SimulatedPush2;
beforeEach(async () => {
  hoisted.tick = null;
  localStorage.clear();
  __test_resetPush2Control();
  __test_resetPush2();
  __test_resetBinding();
  clearPatch();
});

describe('channel select (Push-LOCAL 5a)', () => {
  it('selectChannel updates the index + persists to localStorage', () => {
    selectChannel(4);
    expect(selectedChannelIndex()).toBe(4);
    expect(localStorage.getItem('pt.push2.selectedChannel')).toBe('4');
    // out-of-range is ignored
    selectChannel(99);
    expect(selectedChannelIndex()).toBe(4);
  });

  it('channelName = "CH n · <instrument label>" via laneAssignedModules', () => {
    seedClipPlayer({ autoAssign: { vco1: 0, vco2: 2 } });
    livePatch.nodes['vco1'] = {
      id: 'vco1', type: 'analogVco', domain: 'audio', position: { x: 0, y: 0 }, params: {}, data: { name: 'mybass' },
    } as never;
    expect(channelName(CP, 0)).toBe('CH 1 · mybass');
    // a lane with no assigned instrument = just "CH n"
    expect(channelName(CP, 1)).toBe('CH 2');
  });
});

describe('encoders → MixMasters (additive 5b)', () => {
  it('a display encoder nudges the matching channel volume through the pump', async () => {
    seedClipPlayer();
    seedMixmstrs({ ch1_volume: 0.8 });
    sim = await installSimulatedPush2AndBind(CP);
    // Encoder 1 (CC 71) +5 detents → ch1_volume = 0.8 + 5*0.01 = 0.85.
    sim.cc(PUSH_CC_ENCODER_BASE, 5);
    flushAllCcCommits();
    expect(livePatch.nodes[MIX]!.params!.ch1_volume).toBeCloseTo(0.85, 5);
  });

  it('the Tempo encoder drives the SELECTED channel send1', async () => {
    seedClipPlayer();
    seedMixmstrs({ ch3_send1: 0 });
    sim = await installSimulatedPush2AndBind(CP);
    selectChannel(2); // channel index 2 → ch3
    sim.cc(PUSH_CC_ENCODER_TEMPO, 4); // +4 → ch3_send1 = 0.04
    flushAllCcCommits();
    expect(livePatch.nodes[MIX]!.params!.ch3_send1).toBeCloseTo(0.04, 5);
  });

  it('the Master encoder drives master_volume, clamped to [0,1]', async () => {
    seedClipPlayer();
    seedMixmstrs({ master_volume: 0.98 });
    sim = await installSimulatedPush2AndBind(CP);
    sim.cc(PUSH_CC_ENCODER_MASTER, 10); // +10 → 1.08, clamps to 1
    flushAllCcCommits();
    expect(livePatch.nodes[MIX]!.params!.master_volume).toBeCloseTo(1, 5);
  });

  it('with no mixmstrs node the encoder is a harmless no-op', async () => {
    seedClipPlayer();
    sim = await installSimulatedPush2AndBind(CP);
    expect(firstMixmstrs()).toBeNull();
    expect(() => { sim.cc(PUSH_CC_ENCODER_BASE, 5); flushAllCcCommits(); }).not.toThrow();
  });
});

describe('parity adapter — a Push pad drives the shipped clip brain', () => {
  it('a simulated pad press in GRID view launches a clip (queued written)', async () => {
    // A clip in lane 0 / slot 0 (grid pad top-left = x0,y7 → lane 0, slot 0).
    seedClipPlayer({
      clips: {
        '0': { kind: 'note', lengthSteps: 4, root: 48, loop: true, steps: [{ step: 0, midi: 72, velocity: 100, lengthSteps: 1 }] },
      },
    });
    sim = await installSimulatedPush2AndBind(CP);
    expect(boundClipNode()).toBe(CP);
    // Press the top-left pad → grid view maps it to lane 0.
    sim.press(0, 7);
    const data = livePatch.nodes[CP]!.data as { queued?: (number | 'stop' | null)[] };
    expect(Array.isArray(data.queued)).toBe(true);
    expect(data.queued![0]).not.toBeNull();
    expect(data.queued![0]).not.toBeUndefined();
  });

  it('the sim writes User-mode + LED bytes to the Push (surface is live)', async () => {
    seedClipPlayer({ clips: {} });
    sim = await installSimulatedPush2AndBind(CP);
    // Enter-User-mode SysEx (F0 00 21 1D 01 01 0A 01 F7) was sent on bind.
    const enter = sim.writes().some((w) => w[0] === 0xf0 && w[6] === 0x0a && w[7] === 0x01);
    expect(enter).toBe(true);
    // Step a render tick → the surface paints LED bytes (Note-On pad colours).
    hoisted.tick?.();
    expect(sim.writes().some((w) => (w[0] & 0xf0) === 0x90)).toBe(true);
  });
});
