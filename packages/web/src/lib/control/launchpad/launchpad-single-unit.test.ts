// packages/web/src/lib/control/launchpad/launchpad-single-unit.test.ts
//
// SINGLE-UNIT mode for the Launchpad clip-launcher. The owner-locked PAIR
// invariant (L = clip matrix, ALWAYS LIVE; R = deck/editor) must hold byte-for-
// byte in pair mode — the VIEW toggle exists ONLY in single mode. This file:
//
//   · pins the PAIR-mode regression first (a single-bind seam exists but pair
//     behaviour + the CC-98 no-op are unchanged),
//   · proves a single device bound to the L slot behaves identically to L-in-pair
//     for the clip matrix,
//   · proves CC 98 / the on-card toggle cycle clip↔control (probed via __test_mode),
//   · proves clip→control→clip preserves the editor window state,
//   · proves in PAIR mode CC 98 is NOT a view toggle (it stays the editor FOLLOW).
//
// Driven through the REAL launchpad-device sim (single + pair) + the REAL graph
// store, mocking only the scheduler-clock so the LED loop can be stepped.

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
import {
  installSimulatedLaunchpad,
  installSimulatedLaunchpadSingle,
  __test_resetLaunchpad,
  isSingleBound,
  isPairBound,
  type SimulatedLaunchpad,
} from './launchpad-device.svelte';
import {
  bindLaunchpadToClip,
  unbindLaunchpad,
  boundClipNode,
  toggleSingleView,
  launchpadDeployment,
  launchpadActiveView,
  __test_resetBinding,
  __test_setDeployment,
  __test_mode,
} from './launchpad-control.svelte';
import {
  DECK_EDIT_COL,
  DECK_COPY_COL,
  CC_TRANSPORT,
  CC_EDIT_ROW_UP,
  CC_EDIT_STEP_RIGHT,
  CC_EDIT_FOLLOW,
} from './launchpad-map';
import { SCENE_CCS, padNote, CC_TOP_SPARE_8 } from './launchpad-sysex';
import {
  CLIP_LANES,
  clipIndex,
  defaultNoteClip,
  type NoteClipRecord,
} from '$lib/audio/modules/clip-types';

const NODE_ID = 'cp1';

function clearPatch() {
  for (const k of Object.keys(livePatch.nodes)) delete livePatch.nodes[k];
  for (const k of Object.keys(livePatch.edges)) delete livePatch.edges[k];
}
function noteClip(): NoteClipRecord {
  return defaultNoteClip();
}
function seedClipPlayer(data: Record<string, unknown>) {
  clearPatch();
  livePatch.nodes[NODE_ID] = {
    id: NODE_ID, type: 'clipplayer', domain: 'audio', position: { x: 0, y: 0 }, params: {}, data,
  } as never;
}
function seedTimelorde(running: number) {
  livePatch.nodes['tl'] = {
    id: 'tl', type: 'timelorde', domain: 'audio', position: { x: 0, y: 0 }, params: { running }, data: {},
  } as never;
}
function liveData() {
  return livePatch.nodes[NODE_ID]!.data as Record<string, unknown>;
}
function queued() {
  return liveData().queued as (number | 'stop' | null)[] | undefined;
}

// SCENE_CCS is top→bottom (index 0 = row 7).
const sceneCcForRow = (row: number) => SCENE_CCS[7 - row];
// L matrix maps lane 0 → the TOP physical row.
const yForLane = (lane: number) => CLIP_LANES - 1 - lane;

beforeEach(() => {
  hoisted.tick = null;
  __test_resetBinding();
  __test_resetLaunchpad();
  clearPatch();
});

// ===========================================================================
// PAIR-MODE REGRESSION GUARD — the locked invariant must NOT shift. The single-
// bind seam exists, but with a real PAIR installed the deployment is 'pair', the
// matrix is always L, and CC 98 is NOT a view toggle.
// ===========================================================================
describe('PAIR regression — single-unit seam does not change pair behaviour', () => {
  let sim: SimulatedLaunchpad;
  beforeEach(async () => {
    sim = await installSimulatedLaunchpad();
  });

  it('a freshly-bound pair reports the PAIR deployment (default), never single', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: noteClip() } });
    bindLaunchpadToClip(NODE_ID);
    expect(isPairBound()).toBe(true);
    expect(isSingleBound()).toBe(false);
    expect(launchpadDeployment()).toBe('pair');
    expect(__test_mode().deployment).toBe('pair');
  });

  it('L launches + R deck still work exactly as before (matrix on L, deck on R)', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: noteClip() } });
    seedTimelorde(0);
    bindLaunchpadToClip(NODE_ID);
    // L pad → launch (matrix is L).
    sim.press('L', 0, yForLane(0));
    expect(queued()![0]).toBe(0);
    // R transport CC (deck is R).
    sim.cc('R', CC_TRANSPORT, 127);
    expect((livePatch.nodes['tl']!.params as Record<string, number>).running).toBe(1);
  });

  it('CC 98 in PAIR mode is NOT a view toggle — it stays the editor FOLLOW on R', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: noteClip() } });
    bindLaunchpadToClip(NODE_ID);
    // enter the editor on R.
    sim.press('R', DECK_EDIT_COL, 0);
    sim.press('L', 0, yForLane(0));
    sim.release('R', DECK_EDIT_COL, 0);
    expect(__test_mode().mode).toBe('edit');
    expect(__test_mode().followOn).toBe(true);
    // CC 98 on R toggles FOLLOW (the locked editor behaviour) — NOT a deployment flip.
    sim.cc('R', CC_EDIT_FOLLOW, 127);
    expect(__test_mode().followOn, 'CC 98 still = FOLLOW in pair editor').toBe(false);
    expect(launchpadDeployment(), 'deployment unchanged by CC 98 in pair').toBe('pair');
    // A CC 98 on L in pair mode is just an L event (no view concept) — no toggle.
    sim.cc('L', CC_TOP_SPARE_8, 127);
    expect(launchpadDeployment()).toBe('pair');
  });

  it('toggleSingleView() is a no-op in pair mode', () => {
    seedClipPlayer({ clips: {} });
    bindLaunchpadToClip(NODE_ID);
    toggleSingleView();
    expect(launchpadDeployment()).toBe('pair');
    expect(launchpadActiveView()).toBe('clip'); // unchanged default
  });

  it('the pair render still paints BOTH units (L matrix + R deck)', () => {
    seedClipPlayer({
      clips: { [clipIndex(0, 0)]: noteClip() },
      playing: [0, null, null, null, null, null, null, null],
    });
    seedTimelorde(1);
    bindLaunchpadToClip(NODE_ID);
    hoisted.tick!();
    // L lane0 playing → lit at the TOP row.
    const l = sim.ledAt('L', padNote(0, yForLane(0)));
    expect(l).not.toBeNull();
    expect(l![0] + l![1] + l![2]).toBeGreaterThan(0);
    // R deck EDIT pad lit (pad 11 = (0,0)).
    expect(sim.ledAt('R', 11)).not.toBeNull();
  });
});

// ===========================================================================
// SINGLE-UNIT — one device on the L slot; the clip view behaves identically to
// L-in-pair, and a view toggle flips to the R (control) functionality.
// ===========================================================================
describe('SINGLE — one device behaves like L-in-pair for the clip matrix', () => {
  let sim: SimulatedLaunchpad;
  beforeEach(async () => {
    sim = await installSimulatedLaunchpadSingle();
    __test_setDeployment('single', 'clip');
  });

  it('binds ONE device to the L slot (single-bound, not pair-bound)', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: noteClip() } });
    bindLaunchpadToClip(NODE_ID);
    expect(boundClipNode()).toBe(NODE_ID);
    expect(isSingleBound()).toBe(true);
    expect(isPairBound()).toBe(false);
    expect(launchpadDeployment()).toBe('single');
    expect(launchpadActiveView()).toBe('clip');
  });

  it('clip view: a pad press launches its clip — identical to L-in-pair', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: noteClip(), [clipIndex(1, 1)]: noteClip() } });
    bindLaunchpadToClip(NODE_ID);
    sim.press('L', 0, yForLane(0));
    expect(queued()![0]).toBe(0);
    sim.press('L', 1, yForLane(1));
    expect(queued()![1]).toBe(1);
  });

  it('clip view: the scene column launches a slot across all lanes (like L-in-pair)', () => {
    seedClipPlayer({ clips: { [clipIndex(2, 0)]: noteClip(), [clipIndex(2, 1)]: noteClip() } });
    bindLaunchpadToClip(NODE_ID);
    sim.cc('L', sceneCcForRow(2), 127);
    expect(queued()![0]).toBe(2);
    expect(queued()![1]).toBe(2);
    expect(queued()![2]).toBe('stop');
  });

  it('clip view: pressing a playing clip queues a stop (like L-in-pair)', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: noteClip() }, playing: [0, null, null, null, null, null, null, null] });
    bindLaunchpadToClip(NODE_ID);
    sim.press('L', 0, yForLane(0));
    expect(queued()![0]).toBe('stop');
  });

  it('clip view paints the matrix frame onto the lone device', () => {
    seedClipPlayer({
      clips: { [clipIndex(0, 0)]: noteClip() },
      playing: [0, null, null, null, null, null, null, null],
    });
    seedTimelorde(1);
    bindLaunchpadToClip(NODE_ID);
    hoisted.tick!();
    const l = sim.ledAt('L', padNote(0, yForLane(0)));
    expect(l).not.toBeNull();
    expect(l![0] + l![1] + l![2]).toBeGreaterThan(0);
  });
});

// ===========================================================================
// SINGLE — the VIEW toggle (CC 98 + on-card) cycles clip↔control, routing the
// lone device to handleL (clip) / handleR (control).
// ===========================================================================
describe('SINGLE — CC 98 + on-card toggle cycle clip↔control', () => {
  let sim: SimulatedLaunchpad;
  beforeEach(async () => {
    sim = await installSimulatedLaunchpadSingle();
    __test_setDeployment('single', 'clip');
  });

  it('hardware CC 98 (press) flips clip→control→clip', () => {
    seedClipPlayer({ clips: {} });
    bindLaunchpadToClip(NODE_ID);
    expect(__test_mode().activeView).toBe('clip');
    sim.cc('L', CC_TOP_SPARE_8, 127); // press CC 98
    expect(__test_mode().activeView, 'clip → control').toBe('control');
    sim.cc('L', CC_TOP_SPARE_8, 0); // release is a no-op
    expect(__test_mode().activeView).toBe('control');
    sim.cc('L', CC_TOP_SPARE_8, 127); // press again
    expect(__test_mode().activeView, 'control → clip').toBe('clip');
  });

  it('the on-card toggle (toggleSingleView) flips the view in single mode', () => {
    seedClipPlayer({ clips: {} });
    bindLaunchpadToClip(NODE_ID);
    expect(launchpadActiveView()).toBe('clip');
    toggleSingleView();
    expect(launchpadActiveView()).toBe('control');
    toggleSingleView();
    expect(launchpadActiveView()).toBe('clip');
  });

  it('control view routes pad/CC to the R deck (transport works on the one device)', () => {
    seedClipPlayer({ clips: {} });
    seedTimelorde(0);
    bindLaunchpadToClip(NODE_ID);
    toggleSingleView(); // → control
    expect(__test_mode().activeView).toBe('control');
    // CC 96 (transport) on the lone device now drives the R deck.
    sim.cc('L', CC_TRANSPORT, 127);
    expect((livePatch.nodes['tl']!.params as Record<string, number>).running).toBe(1);
  });

  it('clip view does NOT launch when CC 98 was used (CC 98 is consumed by the toggle)', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: noteClip() } });
    bindLaunchpadToClip(NODE_ID);
    sim.cc('L', CC_TOP_SPARE_8, 127); // → control (no launch side effect)
    expect(queued()?.[0] ?? null).toBeNull();
  });

  it('control view paints the R deck frame + the CC-98 view marker on the lone device', () => {
    seedClipPlayer({ clips: {} });
    seedTimelorde(1);
    bindLaunchpadToClip(NODE_ID);
    toggleSingleView(); // → control
    hoisted.tick!();
    // The EDIT deck pad (11) is lit in control view.
    expect(sim.ledAt('L', 11)).not.toBeNull();
    // The CC-98 view marker is lit on the lone device.
    const marker = sim.ledAt('L', CC_TOP_SPARE_8);
    expect(marker).not.toBeNull();
    expect(marker![0] + marker![1] + marker![2]).toBeGreaterThan(0);
  });

  it('the CC-98 view marker is lit even inside the EDITOR (control + edit mode)', () => {
    // Regression: the marker must paint after the R painter's early return in
    // edit mode (else it shows the editor FOLLOW colour, not the view marker).
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: noteClip() } });
    seedTimelorde(1);
    bindLaunchpadToClip(NODE_ID);
    // enter the editor (control view + edit mode).
    toggleSingleView(); // → control
    sim.press('L', DECK_EDIT_COL, 0);
    toggleSingleView(); // → clip (editArmed survives)
    sim.press('L', 0, yForLane(0)); // tap clip → edit
    sim.release('L', DECK_EDIT_COL, 0);
    toggleSingleView(); // → control (now the editor)
    expect(__test_mode().mode).toBe('edit');
    hoisted.tick!();
    const marker = sim.ledAt('L', CC_TOP_SPARE_8);
    expect(marker).not.toBeNull();
    expect(marker![0] + marker![1] + marker![2], 'view marker lit in the editor too').toBeGreaterThan(0);
  });

  it('flipping clip↔control clears stuck deck HOLD modifiers (COPY held → cleared)', () => {
    // Regression: a COPY held in control view never sees its release once we
    // flip to clip view (handleL ignores the release), so the flip must clear it.
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: noteClip() } });
    bindLaunchpadToClip(NODE_ID);
    toggleSingleView(); // → control
    sim.press('L', DECK_COPY_COL, 0); // hold COPY (no release)
    expect(__test_mode().copyHeld).toBe(true);
    toggleSingleView(); // → clip — the flip must clear copyHeld
    expect(__test_mode().copyHeld, 'COPY hold cleared on the view flip').toBe(false);
    // a subsequent clip tap launches (NOT a copy).
    sim.press('L', 0, yForLane(0));
    expect(queued()![0], 'clip tap launches, not copies').toBe(0);
  });

  it('EDIT hold SURVIVES the view flip (the single-unit enter-editor gesture)', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: noteClip() } });
    bindLaunchpadToClip(NODE_ID);
    toggleSingleView(); // → control
    sim.press('L', DECK_EDIT_COL, 0); // hold EDIT
    expect(__test_mode().editArmed).toBe(true);
    toggleSingleView(); // → clip — EDIT must NOT be cleared (it's the gesture)
    expect(__test_mode().editArmed, 'EDIT survives the flip').toBe(true);
  });
});

// ===========================================================================
// SINGLE — clip→control→clip preserves the editor window state (the explicit
// owner requirement). Enter the editor, scroll the window + pitch + freeze
// FOLLOW, flip clip↔control, and assert the window state survived.
// ===========================================================================
describe('SINGLE — view flip preserves editor window state', () => {
  let sim: SimulatedLaunchpad;
  beforeEach(async () => {
    sim = await installSimulatedLaunchpadSingle();
    __test_setDeployment('single', 'clip');
  });

  // Enter the editor on the single device: hold EDIT (control view) + flip to
  // clip view + tap a clip (handleL's editArmed branch creates/edits it).
  function enterEditSingle(longLen = 64) {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: { ...noteClip(), lengthSteps: longLen } } });
    bindLaunchpadToClip(NODE_ID);
    toggleSingleView();           // → control
    sim.press('L', DECK_EDIT_COL, 0); // hold EDIT (armed, persists across the flip)
    expect(__test_mode().editArmed).toBe(true);
    toggleSingleView();           // → clip (editArmed survives)
    sim.press('L', 0, yForLane(0));   // tap the clip → enter the editor
    sim.release('L', DECK_EDIT_COL, 0);
    expect(__test_mode().mode).toBe('edit');
  }

  it('editWindowStart / editRowOffset / followOn survive clip↔control↔clip', () => {
    enterEditSingle(64);
    // We're in clip view but in edit MODE; flip to control to drive the editor.
    toggleSingleView(); // → control (the editor)
    expect(__test_mode().mode).toBe('edit');
    // Scroll the step window (+1 step → freezes FOLLOW, sets editWindowStart=1).
    sim.cc('L', CC_EDIT_STEP_RIGHT, 127);
    expect(__test_mode().editWindowStart).toBe(1);
    expect(__test_mode().followOn, 'first manual scroll froze FOLLOW').toBe(false);
    // Scroll pitch up +1 row.
    sim.cc('L', CC_EDIT_ROW_UP, 127);
    expect(__test_mode().editRowOffset).toBe(1);

    const snap = {
      windowStart: __test_mode().editWindowStart,
      rowOffset: __test_mode().editRowOffset,
      followOn: __test_mode().followOn,
      mode: __test_mode().mode,
      editClipIndex: __test_mode().editClipIndex,
    };

    // Flip control → clip → control. The window state must NOT reset.
    toggleSingleView(); // → clip
    toggleSingleView(); // → control
    expect(__test_mode().editWindowStart, 'window start preserved').toBe(snap.windowStart);
    expect(__test_mode().editRowOffset, 'pitch offset preserved').toBe(snap.rowOffset);
    expect(__test_mode().followOn, 'follow flag preserved').toBe(snap.followOn);
    expect(__test_mode().mode, 'still in edit mode').toBe(snap.mode);
    expect(__test_mode().editClipIndex, 'same clip').toBe(snap.editClipIndex);
  });
});

// ===========================================================================
// SINGLE — unbind tears down the lone device.
// ===========================================================================
describe('SINGLE — unbind', () => {
  let sim: SimulatedLaunchpad;
  beforeEach(async () => {
    sim = await installSimulatedLaunchpadSingle();
    __test_setDeployment('single', 'clip');
  });

  it('unbind stops driving + a later press is a no-op', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: noteClip() } });
    bindLaunchpadToClip(NODE_ID);
    unbindLaunchpad();
    expect(boundClipNode()).toBeNull();
    sim.press('L', 0, yForLane(0));
    expect(queued()?.[0] ?? null).toBeNull();
  });
});
