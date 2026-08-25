// packages/web/src/lib/control/push2/push2-control.svelte.ts
//
// Ableton Push 2 CONTROL — binds a Push 2 to a focused `clipplayer` (Phase 1).
// The Push drives the FULL Launchpad clip-launch / note-editor / arm / scene /
// KEYS PARITY surface by INJECTING itself as the control surface of the shipped
// launchpad-control singleton (decision A, plan §3): a small adapter remaps Push
// MIDI ⇄ the Launchpad event/frame vocabulary, so no parity logic is forked.
//
// ON TOP of parity, the ADDITIVE Push-only features live HERE (they never touch
// launchpad-control):
//   · 8 buttons above the display → select LANE 1-8 (Push-LOCAL state), which
//     switches the 960×160 screen to that lane's PUSH CARD + lights the button.
//   · the 8 display encoders → the 8 CONTROLS of the current push card, through
//     the electra streaming-CC pump (transient engine push + coalesced bare
//     store write, NEVER a MIDI-rate Y.Doc storm).
//   · the #2-from-the-left encoder (CC 15) → FLIP through the push cards of the
//     modules in the selected lane, one at a time.
//   · the master encoder (CC 79) → mixmstrs master_volume.
//   · D-Pad → CLIP-view nav (± window, +SHIFT = ×8) via launchpad-control's
//     shared launchpadDpadNav seam.
// START/STOP moves to the Push Play button (routed through the parity top row).
//
// ── WHAT WAS DELETED, AND WHY IT IS THE OWNER'S INTENT ────────────────────
//
// The 8 display encoders used to be a MIXMASTERS CHANNEL-VOLUME strip (encoder
// n → ch{n+1}_volume) and the two left encoders were send1/send2 of the
// selected channel. The owner's spec opens with "we'll lose the 8-knobs-as-
// audio-mixer function for now" — the 8 encoders are the push card's eight
// controls, and there is no second row to put a mixer on. `master_volume` on
// the dedicated MASTER encoder SURVIVES: that encoder is not one of the eight,
// it sits beside the physical master level, and dropping it would be a pure
// regression the spec never asked for.
//
// ── THE DISPLAY REPAINT SEAM ──────────────────────────────────────────────
//
// The card is repainted from `pushSurface.setFrame` — the LED frame the
// launchpad-control render loop already emits on every scheduler tick while the
// Push is bound. That gives a repaint on ANY graph change (a module added to a
// lane, a param moved by another surface, a rename) with NO new subscription
// and, in particular, no `ydoc.on('update')` listener — whose per-transaction
// fan-out is exactly what node-versions.svelte.ts exists to avoid. A signature
// compare makes a static card cost one string comparison per tick instead of a
// 320 KB pack and a USB transfer.
//
// Binding, selected lane and lane focus are per-machine LOCAL; LED frames and
// display frames are local render state, never synced.

import { patch } from '$lib/graph/store';
import { getModuleDef } from '$lib/audio/module-registry';
import { getVideoModuleDef } from '$lib/video/module-registry';
import { getMetaModuleDef } from '$lib/meta/module-registry';
import { resolveDisplayName } from '$lib/multiplayer/module-naming';
import type { ModuleNode, ParamDef } from '$lib/graph/types';
import { laneAssignedModules, laneColorEff, type ClipPlayerData } from '$lib/audio/modules/clip-types';
import { MIXMSTRS_CHANNELS } from '$lib/audio/modules/mixmstrs';
import { PINNED_MIXER_ID } from '$lib/graph/column-reconcile';
import { hexToRgb127 } from '$lib/control/launchpad/launchpad-map';
import { createCcCommit, type CcCommit } from '$lib/ui/controls/cc-commit';
import { getCcBatcher } from '$lib/ui/controls/cc-batch-store';
import { notifyAutomationTouch, notifyAutomationRelease } from '$lib/audio/automation-touch';
import { getActiveEngine } from '$lib/audio/engine-ref';
import {
  setControlSurfacePort,
  bindLaunchpadToClip,
  unbindLaunchpad,
  launchpadDpadNav,
  boundClipNode,
  // ⚠ ALIASED, NOT RE-EXPORTED — see `setLaunchpadView` at the bottom of this
  // file for the defect the bare pass-through caused.
  setLaunchpadView as setLaunchpadViewRaw,
  launchpadLegendContext,
  type ControlSurfacePort,
} from '$lib/control/launchpad/launchpad-control.svelte';
import * as push2Device from './push2-device.svelte';
import { pushColorIndex, type Push2RxEvent } from './push2-sysex';
import {
  classifyPush2,
  push2FrameToLeds,
  PUSH_CC_SHIFT,
  PUSH_CC_LEGEND,
  PUSH_CC_ELECTRA_MODE,
  PUSH_CC_ABOVE_DISPLAY_BASE,
  type PushEncoderTarget,
  type Push2LedSpec,
} from './push2-map';
import {
  listElectraControls,
  readElectraData,
  bindingAtSlot,
  electraName,
  electraSlotLabel,
  slotIndex,
} from '$lib/graph/electra-control';
import { resolveSurfaceParam } from '$lib/graph/control-surface-params';
import {
  pushElectraView,
  electraModeEncoder,
  stepElectraRow,
  clampRow,
  ELECTRA_MODE_ROWS,
  type PushElectraView,
} from './push-electra-model';
import type { LaunchpadKeyEvent } from './push2-types';
import { resolvePushCardControls, type PushCardDefLike, type PushCardSpec } from './push-card-schema';
import { pushCardView, paramValue, type PushCardView } from './push-card-model';
import { nudgeParamValue, clampEncoderDelta, MAX_ENCODER_STEP } from './push-card-encoder';
import { laneMembers, resolveLaneFocus, stepLaneFocus, laneFocusIndex, PUSH_LANE_COUNT } from './push-lane';
import { lastViewed, setLastViewed, forgetLane } from './push2-view.svelte';
import {
  renderPushCard,
  renderPushLegend,
  renderPushElectra,
  pushCardSignature,
  type PushDrawOp,
} from './push-screen-layout';
import { pushLegendView, type PushLegendView } from './push-legend-model';
import { pushCardRgba } from './push-card-paint';
import { isDisplayConnected, sendFrame } from './push2-display.svelte';

const STORAGE_KEY_CHANNEL = 'pt.push2.selectedChannel';
/** The ElectraControl-mode ROW survives a reload; the MODE deliberately does
 *  not — see `toggleElectraMode`. */
const STORAGE_KEY_ELECTRA_ROW = 'pt.push2.electraRow';

// ---------------------------------------------------------------------------
// Push-LOCAL surface state (never synced — like the launchpad's activeView).
// ---------------------------------------------------------------------------
let selectedChannel = readSelectedChannel(); // 0..7
/** The SHIFT modifier — the permanent-row button above channel 8 (`PUSH_CC_SHIFT`
 *  = CC 27, which is also the Launchpad-shift route). Consumed by the D-Pad ×8
 *  window, the encoder fine-nudge and the LEGEND shift-layer repaint.
 *  ⚠ NOT the physical button labelled "Shift" — that is CC 49, the
 *  ElectraControl mode toggle. See push2-map.ts for why they are different. */
let shiftHeld = false;
/** LEGEND MODE: the legend button is physically held. DISPLAY-ONLY — nothing
 *  reads this except the display-ops seam, so it cannot change any routing. */
let legendHeld = false;
/** ELECTRA CONTROL MODE: latched by the lower-right "Shift" button (CC 49). */
let electraMode = false;
/** The row 1..6 that mode drives. Persisted; the mode is not. */
let electraRow = readElectraRow();
let unsubDevice: (() => void) | null = null;
/** The cb launchpad-control's start() registered through the adapter's onKey —
 *  we hand PARITY events (translated to the Launchpad vocab) to it. */
let launchpadCb: ((e: LaunchpadKeyEvent) => void) | null = null;

// Reactive status counter for the card (channel-select / connect changes).
let statusVersion = $state(0);
export function statusRune(): number {
  return statusVersion;
}
function bump(): void {
  statusVersion++;
}

function readSelectedChannel(): number {
  try {
    const n = Number(localStorage.getItem(STORAGE_KEY_CHANNEL));
    return Number.isFinite(n) && n >= 0 && n < MIXMSTRS_CHANNELS.length ? Math.trunc(n) : 0;
  } catch {
    return 0;
  }
}

function readElectraRow(): number {
  try {
    return clampRow(Number(localStorage.getItem(STORAGE_KEY_ELECTRA_ROW)));
  } catch {
    return 1;
  }
}

// ---------------------------------------------------------------------------
// The CONTROL-SURFACE ADAPTER — the Push presented in the Launchpad vocabulary.
// ---------------------------------------------------------------------------
const pushSurface: ControlSurfacePort = {
  // launchpad-control subscribes handleKey here; we store it and feed it the
  // translated PARITY events. (Additive events never reach it.)
  onKey(cb: (e: LaunchpadKeyEvent) => void): () => void {
    launchpadCb = cb;
    return () => {
      if (launchpadCb === cb) launchpadCb = null;
    };
  },
  // launchpad-control paints a LaunchpadFrame; translate it to Push LEDs (pads +
  // mapped buttons) and APPEND the additive channel-select button LEDs so they
  // survive the per-frame diff (they're never in the Launchpad frame).
  setFrame(_unit, frame): void {
    const specs: Push2LedSpec[] = push2FrameToLeds(frame);
    for (let i = 0; i < MIXMSTRS_CHANNELS.length; i++) {
      specs.push({ kind: 'button', cc: PUSH_CC_ABOVE_DISPLAY_BASE + i, value: channelButtonValue(i) });
    }
    // ELECTRA CONTROL MODE is LATCHED, so unlike every momentary button its
    // state is not visible from the panel alone — the button lights while the
    // mode is on. Appended here for the same reason the channel row is: it is
    // PUSH-LOCAL state and never appears in a Launchpad frame, so the per-frame
    // diff would otherwise drop it. CC 49 is a white/mono button (not in
    // `RGB_BUTTON_CCS`), hence a brightness rather than a palette index.
    specs.push({ kind: 'button', cc: PUSH_CC_ELECTRA_MODE, value: electraMode ? 127 : 0 });
    push2Device.setLeds(specs);
    // The LED tick is also the DISPLAY tick — see the header. Dirty-checked, so
    // a card nobody is touching costs one string compare.
    repaintDisplay();
  },
  clearUnit(): void {
    push2Device.clear();
  },
  isPairBound: () => false,
  isSingleBound: () => push2Device.isBound(),
  // Push 2 pads ARE velocity-sensitive — note entry + the KEYS keyboard record /
  // play the pad's real hit velocity (the Launchpad, which flattens velocity,
  // leaves this false).
  velocitySensitive: true,
};

// ---------------------------------------------------------------------------
// Inbound — one handler over the raw Push stream. Parity → launchpad-control;
// additive → the local handlers.
// ---------------------------------------------------------------------------
function onPushEvent(raw: Push2RxEvent): void {
  // Track the SHIFT hold locally for the D-Pad ×8 + the fine-nudge. This is the
  // permanent-row button above channel 8 (CC 27) — the same press classifyPush2
  // routes to Launchpad top CC 98, so the parity editor windowing and this local
  // copy are two readings of ONE button, not two buttons.
  if (raw.type === 'cc' && raw.cc === PUSH_CC_SHIFT) {
    shiftHeld = raw.s === 1;
    // While LEGEND MODE is held, SHIFT swaps every cell to its shift layer —
    // the owner's "both layers reachable without releasing legend". The shift
    // press still routes normally (it is a real modifier); the repaint is the
    // only thing legend adds.
    if (legendHeld) repaintDisplay();
  }

  const action = classifyPush2(raw);
  if (!action) {
    logUnboundPushCc(raw);
    return;
  }
  switch (action.kind) {
    case 'launchpad':
      launchpadCb?.({ unit: 'L', ev: action.ev });
      break;
    case 'selectChannel':
      selectChannel(action.channel);
      break;
    case 'dpad':
      launchpadDpadNav(action.dir, shiftHeld);
      break;
    case 'encoder':
      applyEncoder(action.target, action.delta);
      break;
    case 'legend':
      setLegendHeld(action.held);
      break;
    case 'electraMode':
      toggleElectraMode();
      break;
  }
}

// ---------------------------------------------------------------------------
// ELECTRA CONTROL MODE — latched, entered/left by the lower-right "Shift"
// button (CC 49). The six leftmost display encoders drive ONE ROW of the rack's
// ElectraControl 6×6 grid; the scroll encoder picks the row; encoders 7 and 8
// are inert.
//
// SCOPE, stated so it is not read as coverage: this changes the ENCODERS and the
// SCREEN and nothing else. Pads, the scene column, the function row, the D-Pad,
// the channel-select row, Play and Undo route EXACTLY as they do outside the
// mode — a deliberate choice, so entering it can never strand a transport or a
// clip launch. The owner's spec is "we're just doing the control part".
// ---------------------------------------------------------------------------

/** Enter or leave ElectraControl mode. A PLAIN TOGGLE, per the owner's spec
 *  ("we don't need to hold the key, press is a toggle"). */
export function toggleElectraMode(): void {
  setElectraMode(!electraMode);
}

/**
 * Set the mode explicitly (the card's on-screen toggle + the tests use this).
 *
 * The mode is deliberately NOT persisted. A latched mode is invisible without
 * the hardware in front of you, so restoring it on a page load would leave the
 * Push showing a surface the user never asked for and could not explain. The
 * ROW is persisted, because that is a position within the mode and costs
 * nothing to be wrong about.
 */
export function setElectraMode(on: boolean): void {
  if (electraMode === on) return;
  electraMode = on;
  bump(); // the card's DOM preview mirrors the panel
  repaintDisplay();
}

/** Is ElectraControl mode latched on? */
export function isElectraMode(): boolean {
  return electraMode;
}

/** The selected ElectraControl row, 1..6. */
export function electraRowIndex(): number {
  return electraRow;
}

/** Select an ElectraControl row (1..6), clamped. Persisted. */
export function setElectraRow(row: number): void {
  const next = clampRow(row);
  if (next === electraRow) return;
  electraRow = next;
  try {
    localStorage.setItem(STORAGE_KEY_ELECTRA_ROW, String(next));
  } catch {
    /* private mode — session-only */
  }
  bump();
  repaintDisplay();
}

/** ROW SCROLL — the scroll encoder (CC 15) in ElectraControl mode. Wraps at both
 *  ends, like the card flip it shares a knob with. */
export function scrollElectraRow(delta: number): void {
  setElectraRow(stepElectraRow(electraRow, clampEncoderDelta(delta)));
}

/** The ElectraControl node this mode drives, or null. The FIRST one, id-sorted —
 *  the SAME choice `electra/host.ts` `electraControlBindings()` makes when it
 *  builds the preset, so the Push drives the surface the hardware Electra was
 *  flashed from rather than a different one. */
export function electraSurfaceId(): string | null {
  return listElectraControls(patch.nodes as Record<string, ModuleNode | undefined>)[0]?.id ?? null;
}

/**
 * Resolve one grid slot against the live rack: the source param's def, its
 * current value, and the name the CARD shows for it (`electraSlotLabel`).
 *
 * Routed through `resolveSurfaceParam` — the SAME adapter the card, MIDI-learn
 * and the Electra flash use — so a TOYBOX nested param resolves identically on
 * the Push and an unresolvable binding yields null (a blank knob) instead of a
 * thrown render.
 */
function resolveElectraSlot(surfaceId: string, slot: number) {
  const data = readElectraData(patch.nodes[surfaceId]);
  const b = bindingAtSlot(data, slot);
  if (!b) return null;
  const source = patch.nodes[b.moduleId] as ModuleNode | undefined;
  const resolved = source ? resolveSurfaceParam(source, b.paramId) : null;
  if (!resolved) return null;
  const key = liveKey(b.moduleId, b.paramId);
  // An in-flight twist reads from the pump for the same reason the push card
  // does: the durable write is coalesced, so the store LAGS a fast turn.
  const live = ccPumps.get(key)?.active ? liveValues.get(key) : undefined;
  return {
    moduleId: b.moduleId,
    paramId: b.paramId,
    def: resolved.def,
    value: live ?? resolved.get(),
    label: electraSlotLabel(b, resolved.def.label ?? b.paramId),
  };
}

/** The slot under display encoder `knob` (1..6) of the SELECTED row, resolved
 *  against the live rack — the ONE seam the screen and the encoders share, so
 *  the value a strip draws and the value a turn increments from cannot come
 *  from two different expressions. */
function resolveElectraKnob(knob: number) {
  const surfaceId = electraSurfaceId();
  if (!surfaceId) return null;
  return resolveElectraSlot(surfaceId, slotIndex(electraRow, knob));
}

/** THE VIEW the Push screen paints in ElectraControl mode. Reads the live store;
 *  every derivation below it is pure. */
export function currentPushElectraView(): PushElectraView {
  const surfaceId = electraSurfaceId();
  return pushElectraView({
    surfaceName: surfaceId ? electraName(patch.nodes[surfaceId]) : null,
    row: electraRow,
    resolveSlot: (slot) => (surfaceId ? resolveElectraSlot(surfaceId, slot) : null),
  });
}

/**
 * Turn ElectraControl knob `knob` (1..6) of the selected row by `delta` detents.
 *
 * Writes through the SAME cc pump the push-card encoders use, so a hardware
 * twist here is indistinguishable from one on the Electra One itself: transient
 * engine push per message + a coalesced bare store write, never a MIDI-rate
 * Y.Doc storm. An empty or unresolvable slot is a silent no-op.
 */
export function electraEncoder(knob: number, delta: number): void {
  const slot = resolveElectraKnob(knob);
  if (!slot) return; // empty or unresolvable — a silent no-op, like a blank strip
  const cur = slot.value;
  const next = nudgeParamValue(slot.def, cur, delta, shiftHeld);
  if (next === cur) return; // already at the end stop — no write, no repaint
  liveValues.set(liveKey(slot.moduleId, slot.paramId), next);
  ccPumpFor(slot.moduleId, slot.paramId).push(next);
  repaintDisplay();
}

/**
 * LEGEND MODE hold. Momentary and DISPLAY-ONLY: press swaps the screen to the
 * legend, release swaps it back to whatever it was showing. There is no
 * persistence and no mode state — `legendHeld` is the entire feature's state,
 * and it is false the instant the button comes up.
 */
export function setLegendHeld(held: boolean): void {
  if (legendHeld === held) return;
  legendHeld = held;
  bump(); // the card's DOM preview mirrors the panel
  repaintDisplay();
}

/** Is the legend overlay showing? (The card preview + tests read this.) */
export function isLegendHeld(): boolean {
  return legendHeld;
}

/**
 * Print the CC of a button press we do not route — ONCE per CC, at info level.
 *
 * This exists because the Push 2's CC↔physical-button map is documented by
 * NUMBER but not by POSITION, so identifying "the black button in the far right
 * corner" from a chair with no device is guesswork. With this, the owner presses
 * the button with DevTools open and reads the answer. Bounded by construction:
 * at most one line per distinct CC for the life of the page.
 */
const loggedUnboundCcs = new Set<number>();
function logUnboundPushCc(raw: Push2RxEvent): void {
  if (raw.type !== 'cc' || raw.s !== 1) return;
  if (loggedUnboundCcs.has(raw.cc)) return;
  loggedUnboundCcs.add(raw.cc);
  try {
    console.info(`[push2] unbound button pressed: CC ${raw.cc}`);
  } catch {
    /* non-fatal diagnostic */
  }
}

// ---------------------------------------------------------------------------
// LANE SELECT — the 8 buttons above the display (CC 102..109). Push-LOCAL.
// Picks which lane's PUSH CARDS the screen shows (and which lane colour the
// button row mirrors).
// ---------------------------------------------------------------------------
/**
 * The lane INDICES the eight above-display buttons select, 0-based.
 *
 * ⚠ DERIVED FROM `MIXMSTRS_CHANNELS`, NEVER RE-TYPED, and it lives here rather
 * than beside the UI that renders it because THIS is where the rule is
 * enforced: `selectChannel` below rejects anything outside
 * `[0, MIXMSTRS_CHANNELS.length)`. A surface that painted its own
 * `[0,1,2,3,4,5,6,7]` would be a second source of truth for a population — the
 * construct the repo forbids by name — and the failure would be silent in the
 * worst direction: add a ninth mixer channel and the buttons keep saying eight
 * while the setter happily accepts the ninth from the hardware.
 */
export const PUSH2_LANE_INDICES: readonly number[] = MIXMSTRS_CHANNELS.map((_, i) => i);

export function selectChannel(channel: number): void {
  if (channel < 0 || channel >= MIXMSTRS_CHANNELS.length) return;
  selectedChannel = channel;
  try {
    localStorage.setItem(STORAGE_KEY_CHANNEL, String(channel));
  } catch {
    /* private mode — session-only */
  }
  bump(); // card re-renders; the LEDs + screen repaint on the next render tick
  repaintDisplay();
}
export function selectedChannelIndex(): number {
  return selectedChannel;
}
/** The selected LANE, 1-based (`selectedChannelIndex()` is 0-based). */
export function selectedLane(): number {
  return selectedChannel + 1;
}

// ---------------------------------------------------------------------------
// Additive 5a (LED) — the 8 channel-select buttons (CC 102..109) MIRROR each
// channel's LANE COLOUR (owner decision, replacing the placeholder red/yellow):
// the SELECTED channel at full brightness, the unselected channels dimmed, so
// the Push row matches the on-screen channel colours. Every channel shows its
// EFFECTIVE hue (the default fill for un-picked lanes) — matching Launchpad —
// so NO channel button is ever off. See `channelButtonValue` for why the old
// "no bound clip → all 8 dark" gate was removed rather than kept.
// ---------------------------------------------------------------------------

/** Unselected channel-select buttons show their colour at ~30% brightness so the
 *  SELECTED channel (full brightness) reads as the current one — `pushColorIndex`
 *  snaps the scaled RGB to the SAME HUE's dim palette entry.
 *
 *  ⚠ 0.30 of full is ~38 on the 0..127 scale, which lands in the DIM tier
 *  (peak ≤ 55) while a full lane hue lands in BRIGHT (peak > 95). That
 *  separation is what makes "selected" readable at a glance, and it is asserted
 *  in push2-control.test.ts — before the tier rework this scaling quantised to
 *  palette 0 and every unselected button went out. */
const CHANNEL_DIM = 0.3;

/**
 * The CC value for channel-select button `lane` (0..7): the channel's EFFECTIVE
 * lane colour as a stock-palette index — FULL brightness for the SELECTED
 * channel, ~30% dimmed for the rest — through the SAME `hexToRgb127`→
 * `pushColorIndex` path the pads use, so a button matches its clip column. An
 * un-picked lane shows its default hue (via `laneColorEff`, mirroring the card
 * swatch and Launchpad LEDs), NOT off. Reads the live bound clip node.
 *
 * ⚠ THERE IS NO "no bound clip → all 8 dark" GATE, and removing it was a FIX.
 * `laneColorEff` is TOTAL — `laneColor(data, lane) ?? defaultLaneColorHex(lane)`
 * — so it answers with the lane's default hue for `undefined` data just as it
 * does for a clip player with no picked colours. The old `if (!nodeId) return 0`
 * therefore did not express "there are no colours to mirror" (there always
 * are); it blanked the row.
 *
 * That mattered because THIS ROW IS NOT PART OF THE CLIP SURFACE. It is
 * Push-LOCAL lane select: it picks which lane's PUSH CARD the 960×160 display
 * shows, resolved from the pinned mixer's columns, and it keeps working with no
 * clip player bound at all. Painting eight dead-looking buttons over eight live
 * ones is the worst of both — the owner reported exactly this ("the rows at the
 * top of the lanes which should just show the channel color, do not"). So the
 * distinction the gate tried to draw is one the surface does not have: an
 * unbound Push still has eight selectable lanes, and they light.
 */
export function channelButtonValue(lane: number): number {
  const nodeId = boundClipNode();
  const node = nodeId ? (patch.nodes[nodeId] as ModuleNode | undefined) : undefined;
  const hex = laneColorEff(node?.data as ClipPlayerData | undefined, lane);
  const [r, g, b] = hexToRgb127(hex);
  if (lane === selectedChannel) return pushColorIndex(r, g, b); // selected → full brightness
  return pushColorIndex(
    Math.round(r * CHANNEL_DIM),
    Math.round(g * CHANNEL_DIM),
    Math.round(b * CHANNEL_DIM),
  ); // unselected → ~30% dim
}

/** "CH n · <instrument label>" — n is the 1-based channel; the label is the
 *  first module assigned to that lane (clip lanes have no name field, plan §6/
 *  decision 4). Just "CH n" when the lane has no assigned instrument. */
export function channelName(nodeId: string | null, channel = selectedChannel): string {
  const base = `CH ${channel + 1}`;
  if (!nodeId) return base;
  const node = patch.nodes[nodeId] as ModuleNode | undefined;
  if (!node) return base;
  const mods = laneAssignedModules(node.data as { autoAssign?: unknown } | undefined)[channel] ?? [];
  const first = mods.find((id) => patch.nodes[id]);
  if (!first) return base;
  const modNode = patch.nodes[first] as ModuleNode;
  const def = getModuleDef(modNode.type);
  const name = resolveDisplayName(modNode, patch.nodes as Record<string, ModuleNode | undefined>, def?.label ?? modNode.type);
  return `${base} · ${name}`;
}

// ---------------------------------------------------------------------------
// THE PUSH CARD — which module's card the screen shows, for the selected lane.
// ---------------------------------------------------------------------------

/** In-memory mirror of the per-lane "last viewed" memory, so the render path
 *  reads localStorage at most once per lane per session. push2-view.svelte.ts
 *  owns the durable copy. */
const liveFocus = new Map<number, string>();

/** The full def for any node type, across all three registries. Mirrors the
 *  Canvas's own `getModuleDef ?? getVideoModuleDef ?? getMetaModuleDef` chain. */
function anyDef(type: string): PushCardDefLike | undefined {
  return (getModuleDef(type) ?? getVideoModuleDef(type) ?? getMetaModuleDef(type)) as
    | PushCardDefLike
    | undefined;
}

/** The pinned mixer's `data` — where the per-lane member ORDER lives. */
function mixerColumnsData(): { columns?: Record<string, string[] | undefined> } | undefined {
  const mixer = patch.nodes[PINNED_MIXER_ID] as ModuleNode | undefined;
  return mixer?.data as { columns?: Record<string, string[] | undefined> } | undefined;
}

/** Ordered member ids of the SELECTED lane — bottom tile first, most recently
 *  ADDED last. Empty in a rack whose pinned mixer has no columns yet. */
export function selectedLaneMembers(): string[] {
  return laneMembers(
    patch.nodes as Record<string, ModuleNode | undefined>,
    mixerColumnsData(),
    selectedLane(),
  );
}

/** Does this rack have channel columns at all? A rack whose pinned mixer
 *  carries no order manifest has none. A rack with no pinned
 *  mixer, so lane select has nothing to select — the card says so rather than
 *  pretending the lane is merely empty. */
function hasLaneColumns(): boolean {
  return patch.nodes[PINNED_MIXER_ID] !== undefined;
}

function rememberedFocus(lane: number): string | null {
  const cached = liveFocus.get(lane);
  if (cached !== undefined) return cached;
  const stored = lastViewed(lane);
  if (stored) liveFocus.set(lane, stored);
  return stored;
}

/**
 * THE OWNER'S DEFAULT RULE, resolved: the most recently VIEWED module of this
 * lane if it is still there, else the most recently ADDED one.
 *
 * When the remembered module has left the lane (deleted, moved, or removed by a
 * peer) the memory is REWRITTEN to whatever we fell back to, so it converges on
 * what the screen actually shows instead of drifting.
 */
export function focusedModuleId(): string | null {
  const lane = selectedLane();
  const members = selectedLaneMembers();
  const remembered = rememberedFocus(lane);
  const resolved = resolveLaneFocus(members, remembered);
  if (resolved !== remembered) {
    if (resolved) {
      liveFocus.set(lane, resolved);
      setLastViewed(lane, resolved);
    } else {
      liveFocus.delete(lane);
      forgetLane(lane);
    }
  }
  return resolved;
}

/**
 * CARD FLIP — the #2-from-the-left encoder (CC 15). Steps through the selected
 * lane's modules, one card per detent, wrapping at both ends (see
 * `stepLaneFocus` for why wrap and not clamp).
 */
export function scrollPushCard(delta: number): void {
  const lane = selectedLane();
  const members = selectedLaneMembers();
  const next = stepLaneFocus(members, focusedModuleId(), delta);
  if (!next) return;
  if (liveFocus.get(lane) === next) return; // a no-op flick — no repaint, no write
  liveFocus.set(lane, next);
  setLastViewed(lane, next);
  bump();
  repaintDisplay();
}

/** The lane accent — the SAME `laneColorEff` hue the channel-select LED row and
 *  the on-screen lane swatch use, so the header stripe matches the lit button. */
function laneHexFor(lane0: number): string {
  const nodeId = boundClipNode();
  const node = nodeId ? (patch.nodes[nodeId] as ModuleNode | undefined) : undefined;
  return laneColorEff(node?.data as ClipPlayerData | undefined, lane0);
}

/** A blank card that still says which lane you are on. */
function emptyView(reason: 'no-lane' | 'no-modules'): PushCardView {
  return {
    moduleType: '',
    domain: 'audio',
    source: 'generic',
    title: '',
    subtitle: '',
    lane: selectedLane(),
    laneHex: laneHexFor(selectedChannel),
    index: null,
    count: reason === 'no-modules' ? 0 : null,
    strips: [],
    empty: reason,
  };
}

/**
 * THE VIEW the Push screen (and the card's DOM preview) paint. It reads the
 * live store, but every derivation below it is a pure function.
 */
export function currentPushCardView(): PushCardView {
  if (!hasLaneColumns()) return emptyView('no-lane');
  const members = selectedLaneMembers();
  const focus = focusedModuleId();
  const node = focus ? (patch.nodes[focus] as ModuleNode | undefined) : undefined;
  const def = node ? anyDef(node.type) : undefined;
  if (!focus || !node || !def) return emptyView('no-modules');

  const spec = resolvePushCardControls(def);
  return pushCardView(spec, overlayLiveValues(focus, node, spec.slots), def, {
    lane: selectedLane(),
    laneHex: laneHexFor(selectedChannel),
    index: laneFocusIndex(members, focus),
    count: members.length,
    nodes: patch.nodes as Record<string, ModuleNode | undefined>,
  });
}

// ---------------------------------------------------------------------------
// PARAM EDIT — the 8 display encoders (CC 71..78) drive the current card's 8
// controls, through the electra streaming-CC pump (transient engine push per
// tick + a coalesced bare store write — NEVER a MIDI-rate Y.Doc write-storm;
// memory midi-cc-write-storm-fix).
// ---------------------------------------------------------------------------

/**
 * IN-FLIGHT values, keyed `${moduleId}:${paramId}`.
 *
 * The pump's durable write is COALESCED to ~7 Hz while a stream is hot, so
 * `node.params[id]` LAGS a fast twist. Reading the store for the encoder's
 * "current value" would therefore compute the SAME next value for every message
 * inside a 150 ms window — the encoder moves one step and then goes dead until
 * you stop turning. This is the same reason `CcCommit` exposes `.active` for
 * knobs ("so the control never snaps back to a not-yet-committed store value");
 * the Push needs it for the INCREMENT SOURCE, not just for the visual.
 *
 * Cleared when the pump goes cold, so the store is authoritative again the
 * moment the twist settles.
 */
const liveValues = new Map<string, number>();

function liveKey(moduleId: string, paramId: string): string {
  return `${moduleId}:${paramId}`;
}

/** The value the encoder should increment FROM: the in-flight one while a
 *  stream is hot, else the store's. */
function currentValue(moduleId: string, node: ModuleNode, p: ParamDef): number {
  const key = liveKey(moduleId, p.id);
  if (ccPumps.get(key)?.active) {
    const v = liveValues.get(key);
    if (v !== undefined) return v;
  }
  return paramValue(node, p);
}

/** A shallow node view whose params carry any IN-FLIGHT values, so the screen
 *  tracks the twist at full rate instead of stepping at the commit cadence.
 *  Returns the node itself when nothing is in flight (the common case — no
 *  allocation on the idle render path). */
function overlayLiveValues(
  moduleId: string,
  node: ModuleNode,
  slots: PushCardSpec['slots'],
): ModuleNode {
  let overlay: Record<string, number> | null = null;
  for (const slot of slots) {
    if (slot.kind !== 'param') continue;
    const key = liveKey(moduleId, slot.paramId);
    if (!ccPumps.get(key)?.active) continue;
    const v = liveValues.get(key);
    if (v === undefined) continue;
    overlay ??= { ...(node.params ?? {}) };
    overlay[slot.paramId] = v;
  }
  return overlay ? ({ ...node, params: overlay } as ModuleNode) : node;
}

/**
 * Turn display encoder `index` (0..7) by `delta` detents. A strip with no param
 * — a blank slot, an empty lane, a module with no turnable controls — is a
 * silent no-op, which is what a knob that does nothing should be.
 */
export function pushCardEncoder(index: number, delta: number): void {
  const focus = focusedModuleId();
  const node = focus ? (patch.nodes[focus] as ModuleNode | undefined) : undefined;
  const def = node ? anyDef(node.type) : undefined;
  if (!focus || !node || !def) return;
  const slot = resolvePushCardControls(def).slots[index];
  if (!slot || slot.kind !== 'param') return;

  const p = slot.param;
  const cur = currentValue(focus, node, p);
  const next = nudgeParamValue(p, cur, delta, shiftHeld);
  if (next === cur) return; // already at the end stop — no write, no repaint
  liveValues.set(liveKey(focus, p.id), next);
  ccPumpFor(focus, p.id).push(next);
  repaintDisplay();
}

/** The first `mixmstrs` node in the patch (the MASTER encoder's target), or
 *  null. Retained from the mixer era for exactly one binding — CC 79. */
export function firstMixmstrs(): string | null {
  for (const [id, n] of Object.entries(patch.nodes)) {
    if ((n as { type?: string } | undefined)?.type === 'mixmstrs') return id;
  }
  return null;
}

/** Per-detent step for the MASTER encoder, over master_volume's 0..1 range —
 *  the same 0.01 the 8 display encoders used to move the mixer by. */
const MASTER_ENCODER_STEP = 0.01;

/** The MASTER encoder (CC 79) → mixmstrs `master_volume`. The one mixer binding
 *  the push-card rework keeps: it is not one of the eight, it sits beside the
 *  physical master level, and losing it would be a pure regression. */
function applyMasterEncoder(delta: number): void {
  const mixId = firstMixmstrs();
  if (!mixId) return; // no mixer — a harmless no-op
  const key = liveKey(mixId, 'master_volume');
  const node = patch.nodes[mixId] as ModuleNode | undefined;
  const stored = Number(node?.params?.['master_volume'] ?? 0.8);
  const cur = ccPumps.get(key)?.active ? (liveValues.get(key) ?? stored) : stored;
  const step = Math.max(-MAX_ENCODER_STEP, Math.min(MAX_ENCODER_STEP, Math.trunc(delta)));
  const next = Math.max(0, Math.min(1, cur + step * MASTER_ENCODER_STEP));
  if (next === cur) return;
  liveValues.set(key, next);
  ccPumpFor(mixId, 'master_volume').push(next);
}

function applyEncoder(target: PushEncoderTarget, delta: number): void {
  // ELECTRA CONTROL MODE re-interprets the SAME classified target rather than
  // consulting a second CC map — see `electraModeEncoder`. That is why there is
  // no way for the two modes to disagree about which knob is which.
  if (electraMode) {
    const role = electraModeEncoder(target);
    switch (role.kind) {
      case 'knob':
        electraEncoder(role.knob, delta);
        break;
      case 'rowScroll':
        scrollElectraRow(delta);
        break;
      case 'master':
        applyMasterEncoder(delta);
        break;
      case 'inert':
        break; // display encoders 7 and 8 — deliberately unassigned here
    }
    return;
  }
  switch (target.kind) {
    case 'strip':
      pushCardEncoder(target.index, delta);
      break;
    case 'moduleScroll':
      scrollPushCard(delta);
      break;
    case 'master':
      applyMasterEncoder(delta);
      break;
  }
}

// Reuse the electra host's per-(module,param) CC pump pattern (electra/host.ts):
// each message pushes the value TRANSIENTLY into the engine + suspends the
// param's clip-automation (holder 'midi' — the Push is a MIDI controller), and
// the durable store write is coalesced onto the shared BARE lane.
const ccPumps = new Map<string, CcCommit>();
function ccPumpFor(moduleId: string, paramId: string): CcCommit {
  const key = `${moduleId}:${paramId}`;
  let pump = ccPumps.get(key);
  if (!pump) {
    pump = createCcCommit({
      lane: 'bare',
      batcher: getCcBatcher(),
      commit: (value) => {
        const live = patch.nodes[moduleId];
        if (!live) return;
        live.params[paramId] = value; // guard:allow-raw-write — streaming hardware CC
      },
      transient: (value) => {
        notifyAutomationTouch({ nodeId: moduleId, paramId }, 'midi');
        const e = getActiveEngine();
        const node = patch.nodes[moduleId] as ModuleNode | undefined;
        if (!e || !node) return;
        try {
          e.setParam(node, paramId, value);
        } catch {
          /* no engine mapping — the settled commit still converges */
        }
      },
      onActiveChange: (active) => {
        if (!active) {
          notifyAutomationRelease({ nodeId: moduleId, paramId }, 'midi');
          liveValues.delete(key); // the store is authoritative again
        }
      },
    });
    ccPumps.set(key, pump);
  }
  return pump;
}

// ---------------------------------------------------------------------------
// THE DISPLAY — draw ops → RGBA → the WebUSB transport, dirty-checked.
// ---------------------------------------------------------------------------

/** Injectable so a node unit test can observe the exact bytes that reach the
 *  panel (the real painter needs a canvas, which the unit lane has not got). */
export type PushCardPainter = (ops: readonly PushDrawOp[]) => ArrayLike<number> | null;

let painter: PushCardPainter = pushCardRgba;
let lastSignature: string | null = null;
/** Set once the painter has proved it cannot paint here (no canvas), so the
 *  idle render tick stops building an op list nobody can use. */
let paintUnavailable = false;

/**
 * Repaint the Push display IF the card actually changed. Called from the LED
 * render tick and from every action that can change the card.
 *
 * A missing display is never an error — with no transport attached this is a
 * pure early return and the pads/encoders carry on over Web MIDI.
 */
/**
 * The CURRENT legend, for whatever the shared brain is routing right now. PURE
 * apart from reading the live routing context — which is the point: the legend
 * is a function of the router's own state, never of a copy.
 */
export function currentPushLegendView(): PushLegendView {
  return pushLegendView(launchpadLegendContext());
}

/**
 * WHAT THE PANEL SHOWS, in precedence order: the LEGEND while its button is
 * held, else ELECTRA CONTROL MODE while it is latched, else the push card.
 *
 * LEGEND WINS over ElectraControl mode, and that is not arbitrary: the legend is
 * MOMENTARY and documents the pads / scene column / function row, none of which
 * ElectraControl mode changes. So the legend is still telling the truth while
 * the mode is on, and a momentary overlay that a latched mode could suppress
 * would be a button that sometimes does nothing.
 *
 * ONE seam for all consumers — the WebUSB frame pump below and the card's DOM
 * preview canvas — so the on-screen preview cannot disagree with the hardware
 * about what is being displayed. It is also why "release restores the previous
 * display" needs no saved bitmap: the ops are re-derived, the signature returns
 * to the previous one, and the dirty check ships exactly one frame.
 */
export function pushDisplayOps(): PushDrawOp[] {
  if (legendHeld) return renderPushLegend(currentPushLegendView());
  if (electraMode) return renderPushElectra(currentPushElectraView());
  return renderPushCard(currentPushCardView());
}

export function repaintDisplay(force = false): void {
  if (!isDisplayConnected() || paintUnavailable) return;
  const ops = pushDisplayOps();
  const sig = pushCardSignature(ops);
  if (!force && sig === lastSignature) return;
  const rgba = painter(ops);
  if (!rgba) {
    paintUnavailable = true; // no canvas on this machine — stop trying
    return;
  }
  lastSignature = sig;
  sendFrame(rgba);
}

/** TEST/EMBED SEAM: swap the RGBA painter. Passing null restores the canvas
 *  one and re-arms the availability probe. */
export function setPushCardPainter(fn: PushCardPainter | null): void {
  painter = fn ?? pushCardRgba;
  paintUnavailable = false;
  lastSignature = null;
}

// ---------------------------------------------------------------------------
// Connect / bind lifecycle (gesture-gated, like the Launchpad card).
// ---------------------------------------------------------------------------

/** Is Web MIDI available (Chromium)? */
export function midiAvailable(): boolean {
  return push2Device.midiAvailable();
}
/** Is the Push connected + bound to its User port? */
export function isConnected(): boolean {
  return push2Device.isBound();
}
/** The clip-player node the Push (via launchpad-control) drives, or null. */
export { boundClipNode };

/**
 * Connect the Push (gesture-gated sysex), auto-bind its User port, and INJECT it
 * as the active control surface (single-unit render path). Returns false when
 * Web MIDI is unavailable, the user denies, or no Push is found. Idempotent.
 */
export async function connectPush(): Promise<boolean> {
  if (!midiAvailable()) return false;
  const ok = await push2Device.connect();
  if (!ok) return false;
  const port = push2Device.autoBind();
  if (!port) return false; // no Push detected
  if (!unsubDevice) unsubDevice = push2Device.onKey(onPushEvent);
  setControlSurfacePort(pushSurface, { deployment: 'single' });
  bump();
  return true;
}

/** Bind the Push to a clip-player node (drives the parity brain). */
export function bindPushToClip(nodeId: string): void {
  bindLaunchpadToClip(nodeId);
  bump();
}

/** Unbind the clip-player (blanks the surface). */
export function unbindPush(): void {
  unbindLaunchpad();
  bump();
}

/** Full teardown — unbind the clip-player, release the surface + the Push. */
export function disconnectPush(): void {
  unbindLaunchpad();
  setControlSurfacePort(null); // restore the default Launchpad surface
  if (unsubDevice) {
    unsubDevice();
    unsubDevice = null;
  }
  push2Device.unbind();
  bump();
}

/**
 * The card's / faceplate's view switcher (drives the parity single-mode view).
 *
 * ⚠ IT BUMPS, AND THE BARE RE-EXPORT IT REPLACES WAS A LIVE DEFECT. This used
 * to be `export { setLaunchpadView }` — the launchpad function, passed straight
 * through. That function bumps the LAUNCHPAD layer's `viewRune()`, and every
 * push2 surface derives on THIS module's `statusRune()`, so the two never met:
 * clicking GRID / CLIP / ARR / CTRL changed the parity brain's view and
 * repainted NOTHING. `Push2ControlCard.svelte`'s `activeView` (`$derived((statusRune(),
 * launchpadActiveView()))`) kept its old `.active` highlight and its status
 * line kept naming the previous view until some unrelated event bumped.
 *
 * Found by `push2-face.spec.ts`, which asserts the SINGLETON rather than the
 * button — the poll on `__push2Sim.state().singleView` went green (the click
 * really did reach `setLaunchpadView`) while the button's `aria-pressed` stayed
 * false. That is exactly the split an `aria-pressed`-only assertion cannot see,
 * in either direction: a button that repaints without writing, and a write that
 * does not repaint.
 *
 * Fixed HERE rather than in each surface so both of them get it: the legacy
 * card still ships and still renders under `?shell=legacy`. The faceplate body
 * additionally derives on `viewRune()` directly, which is what covers a view
 * changed FROM THE HARDWARE — a route that never passes through this function
 * at all.
 */
export function setLaunchpadView(view: Parameters<typeof setLaunchpadViewRaw>[0]): void {
  setLaunchpadViewRaw(view);
  bump();
}

// ---------------------------------------------------------------------------
// Test seams
// ---------------------------------------------------------------------------

/** Install a SIMULATED Push, inject the surface, and bind the clip-player — the
 *  e2e/unit entry point (parallel to __launchpadTestInstallSingle). Returns the
 *  sim driver so a test can drive pad/CC presses + assert emitted bytes. */
export async function installSimulatedPush2AndBind(nodeId: string) {
  const sim = await push2Device.installSimulatedPush2();
  if (!unsubDevice) unsubDevice = push2Device.onKey(onPushEvent);
  setControlSurfacePort(pushSurface, { deployment: 'single' });
  bindLaunchpadToClip(nodeId);
  bump();
  return sim;
}

/** Reset ALL Push-control singleton state — test isolation. */
export function __test_resetPush2Control(): void {
  if (unsubDevice) {
    unsubDevice();
    unsubDevice = null;
  }
  launchpadCb = null;
  shiftHeld = false;
  legendHeld = false;
  electraMode = false;
  electraRow = 1;
  loggedUnboundCcs.clear();
  selectedChannel = 0;
  for (const pump of ccPumps.values()) pump.dispose();
  ccPumps.clear();
  liveValues.clear();
  liveFocus.clear();
  lastSignature = null;
  paintUnavailable = false;
  painter = pushCardRgba;
}

/** TEST SEAM: hold/release SHIFT without a device (the fine-step modifier). */
export function __test_setShiftHeld(held: boolean): void {
  shiftHeld = held;
}
