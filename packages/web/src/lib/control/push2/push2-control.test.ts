// packages/web/src/lib/control/push2/push2-control.test.ts
//
// Integration test for the Push 2 control layer — the ADDITIVE features (lane
// select, the PUSH CARD and its encoders, channel name) + the PARITY adapter (a
// simulated Push pad press flows through the injected control surface into the
// shipped launchpad-control brain and launches a clip).
//
// EVERY case here drives the REAL rx path: a raw MIDI byte run is fed to the
// simulated Push, decoded by the shipping codec, classified by the shipping
// map, and handled by the shipping control layer. Nothing calls a handler
// directly, so "the wiring is connected" is part of what is asserted rather
// than assumed. The REAL push2-device (simulated transport), the REAL
// launchpad-control singleton, the REAL cc pump and the REAL graph store are
// all in the loop; only the scheduler-clock is mocked so the LED/display render
// tick can be stepped by hand.
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
import { __test_resetBinding, boundClipNode, __test_mode } from '$lib/control/launchpad/launchpad-control.svelte';
import { drainAudition, clearAudition } from '$lib/audio/modules/clip-audition';
import { __test_resetPush2 } from './push2-device.svelte';
import {
  installSimulatedPush2AndBind,
  __test_resetPush2Control,
  selectChannel,
  selectedChannelIndex,
  channelName,
  channelButtonValue,
  firstMixmstrs,
  focusedModuleId,
  currentPushCardView,
  setPushCardPainter,
  setLaunchpadView,
} from './push2-control.svelte';
import {
  PUSH_CC_ABOVE_DISPLAY_BASE,
  PUSH_CC_SCENE_BASE,
  PUSH_CC_ENCODER_BASE,
  PUSH_CC_ENCODER_SWING,
  PUSH_CC_ENCODER_MASTER,
} from './push2-map';
import { pushColorIndex } from './push2-sysex';
import { hexToRgb127 } from '$lib/control/launchpad/launchpad-map';
import { laneColorEff } from '$lib/audio/modules/clip-types';
import { PINNED_MIXER_ID } from '$lib/graph/column-reconcile';
import { pushCardSignature, type PushDrawOp } from './push-screen-layout';
import { lastViewed, __test_resetPushView } from './push2-view.svelte';
import { PUSH_DISPLAY_RGBA_BYTES } from './push2-display-frame';
import {
  installSimulatedPush2Display,
  flushDisplayWrites,
  __test_resetPush2Display,
  __test_setDisplayClock,
  type SimulatedPush2Display,
} from './push2-display.svelte';
import '$lib/audio/modules'; // register the real defs the push cards resolve from
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
  __test_resetPushView();
  __test_resetPush2Control();
  __test_resetPush2();
  __test_resetPush2Display();
  __test_resetBinding();
  clearAudition(CP);
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

describe('channel-select LEDs mirror the lane colour (selected bright / others dim)', () => {
  // The 8 above-display buttons (CC 102..109) are RGB: their CC value is a stock-
  // palette index. Each shows its channel's EFFECTIVE lane colour — the picked
  // colour if set, else the lane's default hue (mirroring the card swatch and the
  // Launchpad LEDs) — the selected one FULL, the rest ~30% dimmed, computed via the
  // SAME hexToRgb127→pushColorIndex path the pads use. Only no bound clip at all is
  // OFF.
  const dim = (c: number) => Math.round(c * 0.3);
  const idxFull = (hex: string) => pushColorIndex(...hexToRgb127(hex));
  const idxDim = (hex: string) => {
    const [r, g, b] = hexToRgb127(hex);
    return pushColorIndex(dim(r), dim(g), dim(b));
  };
  /** The effective hex for an UN-picked lane: its default hue (no data ⇒ null pick
   *  ⇒ `defaultLaneColorHex(lane)`) — the single source of truth the module uses. */
  const effHex = (lane: number) => laneColorEff(undefined, lane);
  /** The value the device believes channel `ch`'s button LED holds. */
  const ledFor = (ch: number) => sim.ledAt('b' + (PUSH_CC_ABOVE_DISPLAY_BASE + ch));

  it('selected picked = FULL, unselected picked = ~30% dim, an un-picked lane shows its default hue (not off)', async () => {
    const c0 = '#2040ff'; // ch1 (lane 0) — a saturated colour (hue survives at full brightness)
    const c1 = '#ffffff'; // ch2 (lane 1) — a bright colour whose dim is a visible neutral
    // ch3 (lane 2) and up: no picked colour → shows its EFFECTIVE default hue.
    seedClipPlayer({ laneColor: [c0, c1, null] });
    sim = await installSimulatedPush2AndBind(CP);
    selectChannel(0);
    hoisted.tick?.(); // repaint the LED frame with the current selection

    // The pure per-channel value.
    expect(channelButtonValue(0)).toBe(idxFull(c0)); // selected picked → full
    expect(channelButtonValue(1)).toBe(idxDim(c1)); // unselected picked → ~30% dim
    // An un-picked lane now renders its EFFECTIVE default hue (dimmed while
    // unselected), NOT the forced-OFF it used to be.
    expect(channelButtonValue(2)).toBe(idxDim(effHex(2)));
    for (let ch = 3; ch < 8; ch++) expect(channelButtonValue(ch)).toBe(idxDim(effHex(ch)));

    // The three states must be VISIBLY distinct (guards a swapped bright/dim), and
    // the selected one must be its FULL, not dimmed, index.
    expect(idxFull(c0)).not.toBe(0);
    expect(idxFull(c0)).not.toBe(idxDim(c0));
    expect(new Set([channelButtonValue(0), channelButtonValue(1), channelButtonValue(2)]).size).toBe(3);

    // The REAL render path emitted those exact palette indices to the Push buttons.
    expect(ledFor(0)).toBe(idxFull(c0));
    expect(ledFor(1)).toBe(idxDim(c1));
    expect(ledFor(2)).toBe(idxDim(effHex(2)));

    // SELECTING an un-picked lane lights it at its FULL effective hue — a clearly
    // non-off palette index. This is the crux of the owner change: a lane with no
    // explicit colour is no longer forced OFF, it shows its default hue like the
    // card swatch and the Launchpad LEDs (a dim un-picked hue may still snap to a
    // near-black palette entry, but the effective hue drives it, not a hard 0).
    selectChannel(2);
    hoisted.tick?.();
    expect(channelButtonValue(2)).toBe(idxFull(effHex(2))); // un-picked, selected → full default hue
    expect(channelButtonValue(2)).not.toBe(0); // proves it is NOT the old forced-off
    expect(ledFor(2)).toBe(idxFull(effHex(2)));
  });

  it('re-selecting a channel repaints: the newly-selected → full, the old → dim', async () => {
    const c0 = '#2040ff';
    const c1 = '#ffffff';
    seedClipPlayer({ laneColor: [c0, c1] });
    sim = await installSimulatedPush2AndBind(CP);
    selectChannel(0);
    hoisted.tick?.();
    expect(ledFor(0)).toBe(idxFull(c0)); // ch1 full
    expect(ledFor(1)).toBe(idxDim(c1)); // ch2 dim

    selectChannel(1);
    hoisted.tick?.();
    expect(ledFor(1)).toBe(idxFull(c1)); // ch2 now full
    expect(ledFor(0)).toBe(idxDim(c0)); // ch1 now dim
  });

  it('with no bound clip every channel button is OFF (no colours to mirror)', () => {
    // beforeEach leaves the binding reset — boundClipNode() is null.
    for (let ch = 0; ch < 8; ch++) expect(channelButtonValue(ch)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// THE PUSH CARD — the owner's spec, driven through the REAL rx path.
//
// WHAT WAS DELETED HERE, and why it is the owner's intent:
//   · 'a display encoder nudges the matching channel volume' — the 8 display
//     encoders are no longer a MixMasters channel-volume strip. "we'll lose the
//     8-knobs-as-audio-mixer function for now"; they are the push card's eight
//     controls, replaced by 'a display encoder writes the FOCUSED module's
//     strip-N param' below.
//   · 'the Tempo encoder drives the SELECTED channel send1' — CC 14 is
//     deliberately unbound in v1 and CC 15 flips push cards instead. Replaced
//     by the card-flip block.
//   · 'with no mixmstrs node the encoder is a harmless no-op' — replaced by
//     'an empty lane makes every encoder a harmless no-op', the same guarantee
//     against the new target.
//   · 'the Master encoder drives master_volume, clamped' — KEPT. The master
//     encoder is not one of the eight; dropping it would be a regression the
//     spec never asked for.
// ---------------------------------------------------------------------------

/** A workflow rack's pinned mixer: it carries the per-lane member ORDER, and
 *  it is also the `mixmstrs` the master encoder drives. */
function seedPinnedMixer(columns: Record<string, string[]> = {}, params: Record<string, number> = {}) {
  livePatch.nodes[PINNED_MIXER_ID] = {
    id: PINNED_MIXER_ID, type: 'mixmstrs', domain: 'audio', position: { x: 0, y: 0 },
    params: { master_volume: 0.8, ...params }, data: { columns },
  } as never;
}

/** A lane member: `data.channel` is the membership truth the reconciler reads. */
function seedMember(id: string, type: string, channel: number, params: Record<string, number> = {}) {
  livePatch.nodes[id] = {
    id, type, domain: 'audio', position: { x: 0, y: 0 }, params, data: { channel },
  } as never;
}

/** Rewrite one lane's member ORDER, exactly as an add/reorder on canvas does. */
function setLaneOrder(lane: number, ids: string[]) {
  (livePatch.nodes[PINNED_MIXER_ID]!.data as { columns: Record<string, string[]> }).columns[
    String(lane)
  ] = ids;
}

/** The id the Push card is currently showing, for the SELECTED lane. */
const shown = () => currentPushCardView().moduleType;

describe('lane select — the 8 buttons above the display (CC 102..109)', () => {
  it('selecting a lane switches the screen to THAT lane\'s push card', async () => {
    seedClipPlayer();
    seedPinnedMixer({ '1': ['env1'], '2': ['gain1'] });
    seedMember('env1', 'adsr', 1);
    seedMember('gain1', 'vca', 2);
    sim = await installSimulatedPush2AndBind(CP);

    sim.cc(PUSH_CC_ABOVE_DISPLAY_BASE, 127); // lane 1
    expect(selectedChannelIndex()).toBe(0);
    expect(focusedModuleId()).toBe('env1');
    expect(shown()).toBe('adsr');

    sim.cc(PUSH_CC_ABOVE_DISPLAY_BASE + 1, 127); // lane 2
    expect(focusedModuleId()).toBe('gain1');
    expect(shown(), 'the CARD changed, not just the lane number').toBe('vca');
    expect(currentPushCardView().lane).toBe(2);
  });

  it('the DEFAULT card is the MOST RECENTLY ADDED module (the column tail)', async () => {
    seedClipPlayer();
    seedPinnedMixer({ '1': ['env1', 'gain1'] }); // gain1 added second
    seedMember('env1', 'adsr', 1);
    seedMember('gain1', 'vca', 1);
    sim = await installSimulatedPush2AndBind(CP);
    sim.cc(PUSH_CC_ABOVE_DISPLAY_BASE, 127);
    expect(focusedModuleId()).toBe('gain1');

    // ORDER NEGATIVE CONTROL: append a third module and the default must FOLLOW
    // it. Reading the array HEAD would leave the focus on env1 through both
    // halves of this test, so the "most recent" claim would be untested.
    seedMember('lfo1', 'lfo', 1);
    setLaneOrder(1, ['env1', 'gain1', 'lfo1']);
    __test_resetPushView(); // a genuinely fresh rack — nothing viewed yet
    __test_resetPush2Control();
    sim.cc(PUSH_CC_ABOVE_DISPLAY_BASE, 127);
    expect(focusedModuleId(), 'the newest module wins').toBe('lfo1');
    expect(currentPushCardView().index, 'and it reads as N/N').toBe(3);
    expect(currentPushCardView().count).toBe(3);
  });

  it('a lane VIEWED BEFORE reopens on the module you left it on', async () => {
    seedClipPlayer();
    seedPinnedMixer({ '1': ['env1', 'gain1'], '2': ['lfo1'] });
    seedMember('env1', 'adsr', 1);
    seedMember('gain1', 'vca', 1);
    seedMember('lfo1', 'lfo', 2);
    sim = await installSimulatedPush2AndBind(CP);

    sim.cc(PUSH_CC_ABOVE_DISPLAY_BASE, 127); // lane 1 → default = gain1 (tail)
    sim.cc(PUSH_CC_ENCODER_SWING, 127); // flip back one → env1
    expect(focusedModuleId()).toBe('env1');

    sim.cc(PUSH_CC_ABOVE_DISPLAY_BASE + 1, 127); // away to lane 2
    expect(focusedModuleId()).toBe('lfo1');

    sim.cc(PUSH_CC_ABOVE_DISPLAY_BASE, 127); // …and back
    expect(focusedModuleId(), 'the VIEWED module wins over the newest').toBe('env1');
  });

  it('the lane you left off on SURVIVES A RELOAD (the memory is durable, not session state)', async () => {
    // A negative control found this: an in-memory-only focus map passes the
    // "reopens on the module you left it on" test above, because that never
    // leaves the session. Resetting the CONTROL singleton but NOT the view
    // store is exactly a page reload, and is the only thing that separates the
    // two implementations.
    seedClipPlayer();
    seedPinnedMixer({ '1': ['env1', 'gain1'] });
    seedMember('env1', 'adsr', 1);
    seedMember('gain1', 'vca', 1);
    sim = await installSimulatedPush2AndBind(CP);
    sim.cc(PUSH_CC_ABOVE_DISPLAY_BASE, 127);
    sim.cc(PUSH_CC_ENCODER_SWING, 127); // flip off the default, onto env1
    expect(focusedModuleId()).toBe('env1');

    __test_resetPush2Control(); // ← the reload: in-memory state is gone
    sim = await installSimulatedPush2AndBind(CP);
    sim.cc(PUSH_CC_ABOVE_DISPLAY_BASE, 127);
    expect(focusedModuleId(), 'still on the module we left it on').toBe('env1');
  });

  it('a remembered module that LEFT the lane falls back to the newest, and the memory converges', async () => {
    seedClipPlayer();
    seedPinnedMixer({ '1': ['env1', 'gain1'] });
    seedMember('env1', 'adsr', 1);
    seedMember('gain1', 'vca', 1);
    sim = await installSimulatedPush2AndBind(CP);
    sim.cc(PUSH_CC_ABOVE_DISPLAY_BASE, 127);
    sim.cc(PUSH_CC_ENCODER_SWING, 127); // remember env1
    expect(lastViewed(1)).toBe('env1');

    // env1 is deleted (or moved, or removed by a peer — identical here).
    delete livePatch.nodes['env1'];
    setLaneOrder(1, ['gain1']);
    expect(focusedModuleId()).toBe('gain1');
    expect(lastViewed(1), 'the memory is REWRITTEN, not left dangling').toBe('gain1');
  });

  it('a rack with no channel columns says so (a dawless rack has no lanes)', async () => {
    seedClipPlayer();
    sim = await installSimulatedPush2AndBind(CP);
    const v = currentPushCardView();
    expect(v.empty).toBe('no-lane');
    expect(v.lane, 'the header still tells you which button is lit').toBe(1);
  });

  it('an EMPTY lane shows the empty card, not a stale one', async () => {
    seedClipPlayer();
    seedPinnedMixer({ '1': ['env1'] });
    seedMember('env1', 'adsr', 1);
    sim = await installSimulatedPush2AndBind(CP);
    sim.cc(PUSH_CC_ABOVE_DISPLAY_BASE, 127);
    expect(shown()).toBe('adsr');
    sim.cc(PUSH_CC_ABOVE_DISPLAY_BASE + 4, 127); // lane 5 — nothing in it
    expect(currentPushCardView().empty).toBe('no-modules');
    expect(focusedModuleId()).toBeNull();
  });
});

describe('card flip — the #2-from-the-left encoder (CC 15)', () => {
  async function threeInLane1() {
    seedClipPlayer();
    seedPinnedMixer({ '1': ['env1', 'gain1', 'lfo1'] });
    seedMember('env1', 'adsr', 1);
    seedMember('gain1', 'vca', 1);
    seedMember('lfo1', 'lfo', 1);
    sim = await installSimulatedPush2AndBind(CP);
    sim.cc(PUSH_CC_ABOVE_DISPLAY_BASE, 127);
  }

  it('steps ONE card per detent, in both directions', async () => {
    await threeInLane1();
    expect(focusedModuleId()).toBe('lfo1'); // the tail
    sim.cc(PUSH_CC_ENCODER_SWING, 127); // −1
    expect(focusedModuleId()).toBe('gain1');
    expect(shown()).toBe('vca');
    sim.cc(PUSH_CC_ENCODER_SWING, 127); // −1
    expect(focusedModuleId()).toBe('env1');
    sim.cc(PUSH_CC_ENCODER_SWING, 1); // +1
    expect(focusedModuleId()).toBe('gain1');
  });

  it('WRAPS at both ends rather than sticking', async () => {
    await threeInLane1();
    sim.cc(PUSH_CC_ENCODER_SWING, 1); // from the tail, forward → wraps to head
    expect(focusedModuleId()).toBe('env1');
    sim.cc(PUSH_CC_ENCODER_SWING, 127); // back off the head → wraps to tail
    expect(focusedModuleId()).toBe('lfo1');
  });

  it('a HARD FLICK is clamped so it cannot jump the whole list', async () => {
    await threeInLane1();
    // decodeRelativeCc(65) = −63. Unclamped that would land anywhere; clamped
    // to −4 across 3 members it lands deterministically 4 back from the tail.
    sim.cc(PUSH_CC_ENCODER_SWING, 65);
    expect(focusedModuleId()).toBe('gain1'); // (2 − 4) mod 3 = 1
  });

  it('the card flip does NOT write the graph — it is view state', async () => {
    await threeInLane1();
    const before = JSON.stringify(livePatch.nodes['env1']);
    sim.cc(PUSH_CC_ENCODER_SWING, 127);
    flushAllCcCommits();
    expect(JSON.stringify(livePatch.nodes['env1'])).toBe(before);
  });

  it('flipping in an EMPTY lane is a harmless no-op', async () => {
    seedClipPlayer();
    seedPinnedMixer({});
    sim = await installSimulatedPush2AndBind(CP);
    expect(() => sim.cc(PUSH_CC_ENCODER_SWING, 1)).not.toThrow();
    expect(focusedModuleId()).toBeNull();
  });
});

describe('param edit — the 8 display encoders drive the current card', () => {
  async function adsrInLane1(params: Record<string, number> = {}) {
    seedClipPlayer();
    seedPinnedMixer({ '1': ['env1'] });
    seedMember('env1', 'adsr', 1, params);
    sim = await installSimulatedPush2AndBind(CP);
    sim.cc(PUSH_CC_ABOVE_DISPLAY_BASE, 127);
  }

  it('encoder 1 writes the focused module\'s FIRST control, into the real graph', async () => {
    // adsr's push card is authored as [attack, decay, sustain, release].
    await adsrInLane1({ attack: 0.005 });
    const before = livePatch.nodes['env1']!.params!.attack;
    sim.cc(PUSH_CC_ENCODER_BASE, 5); // +5 detents
    flushAllCcCommits();
    const after = livePatch.nodes['env1']!.params!.attack;
    expect(after, 'the GRAPH changed').toBeGreaterThan(before);
    // attack is log 0.001..10, so +5 % of the ARC is a small multiplicative
    // move — a linear step would have added 0.05 s (10× more).
    expect(after).toBeLessThan(0.01);
  });

  it('each encoder writes its OWN control (the strip mapping is real)', async () => {
    await adsrInLane1({ attack: 0.005, decay: 0.1, sustain: 0.7, release: 0.3 });
    sim.cc(PUSH_CC_ENCODER_BASE + 2, 3); // encoder 3 → sustain (linear 0..1)
    flushAllCcCommits();
    expect(livePatch.nodes['env1']!.params!.sustain).toBeCloseTo(0.73, 5);
    // …and nothing else moved.
    expect(livePatch.nodes['env1']!.params!.attack).toBe(0.005);
    expect(livePatch.nodes['env1']!.params!.decay).toBe(0.1);
    expect(livePatch.nodes['env1']!.params!.release).toBe(0.3);
  });

  it('a single message is CLAMPED to 4 detents (a hard flick is not a leap)', async () => {
    // decodeRelativeCc reports up to ±63 for one physical flick. Unclamped,
    // sustain would jump 0.63 of its range on one message.
    await adsrInLane1({ sustain: 0.2 });
    sim.cc(PUSH_CC_ENCODER_BASE + 2, 63);
    flushAllCcCommits();
    expect(livePatch.nodes['env1']!.params!.sustain, '4 detents, not 63').toBeCloseTo(0.24, 5);
  });

  it('after a LANE SWITCH the same encoder writes a DIFFERENT module', async () => {
    seedClipPlayer();
    seedPinnedMixer({ '1': ['env1'], '2': ['gain1'] });
    seedMember('env1', 'adsr', 1, { attack: 0.005 });
    seedMember('gain1', 'vca', 2, { base: 0.5 });
    sim = await installSimulatedPush2AndBind(CP);

    sim.cc(PUSH_CC_ABOVE_DISPLAY_BASE, 127);
    sim.cc(PUSH_CC_ENCODER_BASE, 3);
    flushAllCcCommits();
    expect(livePatch.nodes['env1']!.params!.attack).toBeGreaterThan(0.005);

    const envAfterLane1 = livePatch.nodes['env1']!.params!.attack;
    sim.cc(PUSH_CC_ABOVE_DISPLAY_BASE + 1, 127); // lane 2 → vca
    sim.cc(PUSH_CC_ENCODER_BASE, 3); // the SAME physical encoder
    flushAllCcCommits();
    expect(livePatch.nodes['gain1']!.params!.base, 'now it drives the vca').toBeCloseTo(0.53, 5);
    expect(livePatch.nodes['env1']!.params!.attack, 'and the adsr is untouched').toBe(envAfterLane1);
  });

  it('after a CARD FLIP the same encoder writes the newly-shown module', async () => {
    seedClipPlayer();
    seedPinnedMixer({ '1': ['env1', 'gain1'] });
    seedMember('env1', 'adsr', 1, { attack: 0.005 });
    seedMember('gain1', 'vca', 1, { base: 0.5 });
    sim = await installSimulatedPush2AndBind(CP);
    sim.cc(PUSH_CC_ABOVE_DISPLAY_BASE, 127); // default = gain1 (the tail)
    sim.cc(PUSH_CC_ENCODER_SWING, 127); // flip to env1
    sim.cc(PUSH_CC_ENCODER_BASE, 3);
    flushAllCcCommits();
    expect(livePatch.nodes['env1']!.params!.attack).toBeGreaterThan(0.005);
    expect(livePatch.nodes['gain1']!.params!.base, 'the card we flipped AWAY from is untouched').toBe(0.5);
  });

  it('a BIPOLAR control moves either side of zero', async () => {
    seedClipPlayer();
    seedPinnedMixer({ '1': ['gain1'] });
    seedMember('gain1', 'vca', 1, { base: 0.5, cvAmount: 0 });
    sim = await installSimulatedPush2AndBind(CP);
    sim.cc(PUSH_CC_ABOVE_DISPLAY_BASE, 127);
    sim.cc(PUSH_CC_ENCODER_BASE + 1, 127); // encoder 2 → cvAmount, −1 detent
    flushAllCcCommits();
    expect(livePatch.nodes['gain1']!.params!.cvAmount).toBeCloseTo(-0.02, 5); // 1 % of a 2-wide range
  });

  it('a FAST BURST moves the param by every detent, not just the first', async () => {
    // THE COALESCING TRAP. The pump's durable write is throttled to ~7 Hz while
    // a stream is hot, so `node.params[id]` LAGS. An implementation that read
    // the store for its increment source would compute the same next value for
    // every message inside the window: 20 detents would move the param ONE step
    // and then go dead. The in-flight value cache is what makes this pass.
    await adsrInLane1({ sustain: 0.2 });
    for (let i = 0; i < 20; i++) sim.cc(PUSH_CC_ENCODER_BASE + 2, 1); // sustain +1 × 20
    flushAllCcCommits();
    expect(livePatch.nodes['env1']!.params!.sustain, '0.2 + 20 × 0.01').toBeCloseTo(0.4, 5);
  });

  it('the SCREEN tracks a burst at full rate, not at the commit cadence', async () => {
    await adsrInLane1({ sustain: 0.2 });
    for (let i = 0; i < 5; i++) sim.cc(PUSH_CC_ENCODER_BASE + 2, 1);
    // No flush: the durable write has NOT landed yet…
    const strip = currentPushCardView().strips[2];
    expect(strip.paramId).toBe('sustain');
    expect(strip.value, '…but the card already shows the in-flight value').toBeCloseTo(0.25, 5);
  });

  it('a BLANK strip is a silent no-op (vca has only 2 controls)', async () => {
    seedClipPlayer();
    seedPinnedMixer({ '1': ['gain1'] });
    seedMember('gain1', 'vca', 1, { base: 0.5, cvAmount: 0 });
    sim = await installSimulatedPush2AndBind(CP);
    sim.cc(PUSH_CC_ABOVE_DISPLAY_BASE, 127);
    const before = JSON.stringify(livePatch.nodes['gain1']!.params);
    for (let i = 2; i < 8; i++) sim.cc(PUSH_CC_ENCODER_BASE + i, 5); // encoders 3..8
    flushAllCcCommits();
    expect(JSON.stringify(livePatch.nodes['gain1']!.params)).toBe(before);
  });

  it('an EMPTY lane makes every encoder a harmless no-op', async () => {
    seedClipPlayer();
    seedPinnedMixer({});
    sim = await installSimulatedPush2AndBind(CP);
    expect(() => {
      for (let i = 0; i < 8; i++) sim.cc(PUSH_CC_ENCODER_BASE + i, 5);
      flushAllCcCommits();
    }).not.toThrow();
  });

  it('the write goes through the CC PUMP — the Y.Doc is not stormed per message', async () => {
    // The pump is what keeps a streaming encoder off the per-transaction
    // cascade. Prove the durable write is COALESCED: mid-burst the store still
    // holds an older value, and only the flush settles it.
    await adsrInLane1({ sustain: 0.2 });
    for (let i = 0; i < 10; i++) sim.cc(PUSH_CC_ENCODER_BASE + 2, 1);
    const midBurst = livePatch.nodes['env1']!.params!.sustain;
    expect(midBurst, 'the store lags the stream (that is the point)').toBeLessThan(0.3);
    flushAllCcCommits();
    expect(livePatch.nodes['env1']!.params!.sustain, 'the settle lands the LAST value').toBeCloseTo(0.3, 5);
  });
});

describe('the MASTER encoder survives the mixer rework (CC 79)', () => {
  it('drives master_volume, clamped to [0,1]', async () => {
    seedClipPlayer();
    seedMixmstrs({ master_volume: 0.98 });
    sim = await installSimulatedPush2AndBind(CP);
    sim.cc(PUSH_CC_ENCODER_MASTER, 10); // +10 → clamped to +4 detents → 1.02 → 1
    flushAllCcCommits();
    expect(livePatch.nodes[MIX]!.params!.master_volume).toBeCloseTo(1, 5);
  });

  it('with no mixmstrs node it is a harmless no-op', async () => {
    seedClipPlayer();
    sim = await installSimulatedPush2AndBind(CP);
    expect(firstMixmstrs()).toBeNull();
    expect(() => { sim.cc(PUSH_CC_ENCODER_MASTER, 5); flushAllCcCommits(); }).not.toThrow();
  });
});

describe('the display shows the card that is selected', () => {
  /** A painter that turns the card's draw ops into DISTINCT pixels, so the
   *  bytes that actually reach the panel can be compared between cards. The
   *  real painter needs a canvas the node lane has not got — but every step
   *  after it (dirty check, RGBA → BGR565 pack, chunking, transferOut) is the
   *  shipping code. */
  function hashPainter(ops: readonly PushDrawOp[]): Uint8ClampedArray {
    const sig = pushCardSignature(ops);
    let h = 2166136261 >>> 0;
    for (let i = 0; i < sig.length; i++) h = Math.imul(h ^ sig.charCodeAt(i), 16777619) >>> 0;
    const rgba = new Uint8ClampedArray(PUSH_DISPLAY_RGBA_BYTES);
    // Spread the hash over 4 pixels: the panel is 5/6/5-bit, so one pixel
    // would throw away most of it and two cards could collide.
    for (let px = 0; px < 4; px++) {
      const b = (h >>> (px * 8)) & 0xff;
      rgba[px * 4] = b;
      rgba[px * 4 + 1] = b;
      rgba[px * 4 + 2] = b;
      rgba[px * 4 + 3] = 255;
    }
    return rgba;
  }

  /** The first 16 packed bytes of the last frame the panel received. */
  function panelHead(display: SimulatedPush2Display): string {
    const f = display.lastFrame();
    return f ? Array.from(f.subarray(0, 16)).join(',') : '';
  }

  async function withDisplay() {
    seedClipPlayer();
    seedPinnedMixer({ '1': ['env1', 'gain1'], '2': ['lfo1'] });
    seedMember('env1', 'adsr', 1, { attack: 0.005, sustain: 0.7 });
    seedMember('gain1', 'vca', 1, { base: 0.5 });
    seedMember('lfo1', 'lfo', 2);
    sim = await installSimulatedPush2AndBind(CP);
    let t = 0;
    __test_setDisplayClock(() => (t += 1000)); // always past the 33 ms frame gate
    const display = await installSimulatedPush2Display();
    setPushCardPainter(hashPainter);
    return display;
  }

  it('a frame reaches the panel, and it CHANGES when the lane changes', async () => {
    const display = await withDisplay();
    sim.cc(PUSH_CC_ABOVE_DISPLAY_BASE, 127); // lane 1 → gain1's card
    await flushDisplayWrites();
    expect(display.frameCount(), 'the panel got a frame').toBeGreaterThan(0);
    const lane1 = panelHead(display);

    sim.cc(PUSH_CC_ABOVE_DISPLAY_BASE + 1, 127); // lane 2 → lfo1's card
    await flushDisplayWrites();
    expect(panelHead(display), 'the BYTES on the panel changed').not.toBe(lane1);
  });

  it('a CARD FLIP repaints the panel', async () => {
    const display = await withDisplay();
    sim.cc(PUSH_CC_ABOVE_DISPLAY_BASE, 127);
    await flushDisplayWrites();
    const first = panelHead(display);
    sim.cc(PUSH_CC_ENCODER_SWING, 127); // gain1 → env1
    await flushDisplayWrites();
    expect(panelHead(display)).not.toBe(first);
  });

  it('turning a control repaints the panel', async () => {
    const display = await withDisplay();
    sim.cc(PUSH_CC_ABOVE_DISPLAY_BASE, 127);
    sim.cc(PUSH_CC_ENCODER_SWING, 127); // env1 (4 controls)
    await flushDisplayWrites();
    const before = panelHead(display);
    sim.cc(PUSH_CC_ENCODER_BASE + 2, 5); // sustain
    await flushDisplayWrites();
    expect(panelHead(display)).not.toBe(before);
  });

  it('an IDLE render tick does NOT re-send a frame (the dirty check works)', async () => {
    // NEGATIVE CONTROL for the repaint trigger: if the tick repainted
    // unconditionally the panel would eat a 320 KB transfer ~40×/s forever.
    const display = await withDisplay();
    sim.cc(PUSH_CC_ABOVE_DISPLAY_BASE, 127);
    await flushDisplayWrites();
    const n = display.frameCount();
    for (let i = 0; i < 5; i++) hoisted.tick?.();
    await flushDisplayWrites();
    expect(display.frameCount()).toBe(n);
  });

  it('a GRAPH change repaints on the next render tick (no new listener needed)', async () => {
    const display = await withDisplay();
    sim.cc(PUSH_CC_ABOVE_DISPLAY_BASE + 1, 127); // lane 2, showing lfo1
    await flushDisplayWrites();
    const before = panelHead(display);
    // Someone else (a mouse, a peer, automation) moves a param on the shown
    // module. Nothing calls into push2-control at all.
    livePatch.nodes['lfo1']!.params!.rate = 3;
    hoisted.tick?.();
    await flushDisplayWrites();
    expect(panelHead(display), 'the tick noticed').not.toBe(before);
  });

  it('a machine with NO CANVAS gives up after ONE attempt, not once per tick', async () => {
    // Another negative-control find: without the give-up flag the repaint path
    // still returns harmlessly (the painter returns null), so the behaviour is
    // identical and the guard is invisible — except that it rebuilds a ~100-op
    // list ~40×/s forever on every machine that cannot paint. Counting painter
    // calls is what makes the guard observable through the public seam.
    seedClipPlayer();
    seedPinnedMixer({ '1': ['env1'] });
    seedMember('env1', 'adsr', 1);
    sim = await installSimulatedPush2AndBind(CP);
    let t = 0;
    __test_setDisplayClock(() => (t += 1000));
    await installSimulatedPush2Display();
    let calls = 0;
    setPushCardPainter(() => {
      calls++;
      return null; // "no canvas here"
    });
    sim.cc(PUSH_CC_ABOVE_DISPLAY_BASE, 127);
    for (let i = 0; i < 10; i++) hoisted.tick?.();
    expect(calls, 'one probe, then it stops trying').toBe(1);
  });

  it('with NO display attached everything still works — a missing panel is not an error', async () => {
    seedClipPlayer();
    seedPinnedMixer({ '1': ['env1'] });
    seedMember('env1', 'adsr', 1, { sustain: 0.2 });
    sim = await installSimulatedPush2AndBind(CP);
    setPushCardPainter(hashPainter);
    expect(() => {
      sim.cc(PUSH_CC_ABOVE_DISPLAY_BASE, 127);
      sim.cc(PUSH_CC_ENCODER_BASE + 2, 3);
      hoisted.tick?.();
      flushAllCcCommits();
    }).not.toThrow();
    expect(livePatch.nodes['env1']!.params!.sustain, 'the encoder still wrote the graph').toBeCloseTo(0.23, 5);
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

  it('the sim writes the Set-LIVE-mode SysEx + LED bytes to the Push (surface is live)', async () => {
    seedClipPlayer({ clips: {} });
    sim = await installSimulatedPush2AndBind(CP);
    // Set-LIVE-mode SysEx (F0 00 21 1D 01 01 0A 00 F7) was sent on bind — the
    // default the Live-port path uses (NOT the finicky User mode).
    const live = sim.writes().some((w) => w[0] === 0xf0 && w[6] === 0x0a && w[7] === 0x00);
    expect(live).toBe(true);
    // No User-mode SysEx (0A 01) is ever sent.
    const user = sim.writes().some((w) => w[0] === 0xf0 && w[6] === 0x0a && w[7] === 0x01);
    expect(user).toBe(false);
    // Step a render tick → the surface paints LED bytes (Note-On pad colours) —
    // in LIVE mode these light the grid on the Live port with no further SysEx.
    hoisted.tick?.();
    expect(sim.writes().some((w) => (w[0] & 0xf0) === 0x90)).toBe(true);
  });
});

describe('velocity capture — the Push pads ARE velocity-sensitive', () => {
  // Push scene CC for the KEYS button: the clip-right column index 3 = Keys →
  // Launchpad SCENE_CCS[3]; the Push scene column is bottom-origin base 36, so
  // that scene sits at Push CC 36 + (7-3) = 40.
  const CC_KEYS = PUSH_CC_SCENE_BASE + 4;

  function noteClip(steps: unknown[] = []) {
    return { kind: 'note', lengthSteps: 16, root: 48, loop: true, steps };
  }
  function editedClipSteps(): { velocity: number }[] {
    const d = livePatch.nodes[CP]!.data as { clips: Record<string, { steps: { velocity: number }[] }> };
    return d.clips['0'].steps;
  }

  it('NOTE ENTRY records the pad HIT VELOCITY, not the constant default', async () => {
    seedClipPlayer({ clips: { '0': noteClip() } });
    sim = await installSimulatedPush2AndBind(CP);
    setLaunchpadView('clip'); // the note editor
    // Tap the bottom-left editor cell HARD (velocity 121). Press captures the
    // velocity; release toggles the note ON with it.
    sim.press(0, 0, 121);
    sim.release(0, 0);
    const steps = editedClipSteps();
    expect(steps.length, 'a note was placed').toBe(1);
    expect(steps[0].velocity, 'the recorded velocity is the pad hit, not VEL_DEFAULT (76)').toBe(121);
  });

  it('NOTE ENTRY at a SOFT hit records that softer velocity (proves it varies, not a constant)', async () => {
    seedClipPlayer({ clips: { '0': noteClip() } });
    sim = await installSimulatedPush2AndBind(CP);
    setLaunchpadView('clip');
    sim.press(0, 0, 29); // a soft hit
    sim.release(0, 0);
    expect(editedClipSteps()[0].velocity).toBe(29);
  });

  it('KEYS keyboard note-on plays the pad HIT VELOCITY (audition carries it)', async () => {
    seedClipPlayer({ clips: { '0': noteClip() } });
    sim = await installSimulatedPush2AndBind(CP);
    setLaunchpadView('clip');
    sim.cc(CC_KEYS, 127); // Clip → KEYS keyboard
    sim.cc(CC_KEYS, 0);
    expect(__test_mode().mode, 'entered KEYS mode').toBe('keys');
    drainAudition(CP); // discard any entry noise
    // Play a keyboard note cell at velocity 96.
    sim.press(2, 1, 96);
    const on = drainAudition(CP).find((e) => e.on);
    expect(on, 'a note-on auditioned').toBeTruthy();
    expect(on!.velocity, 'the played velocity is the pad hit, not VEL_DEFAULT (76)').toBe(96);
  });
});
