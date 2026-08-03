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
  setLaunchpadView,
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
  PUSH_CC_ABOVE_DISPLAY_BASE,
  type PushEncoderTarget,
  type Push2LedSpec,
} from './push2-map';
import type { LaunchpadKeyEvent } from './push2-types';
import { resolvePushCardControls, type PushCardDefLike, type PushCardSpec } from './push-card-schema';
import { pushCardView, paramValue, type PushCardView } from './push-card-model';
import { nudgeParamValue, MAX_ENCODER_STEP } from './push-card-encoder';
import { laneMembers, resolveLaneFocus, stepLaneFocus, laneFocusIndex, PUSH_LANE_COUNT } from './push-lane';
import { lastViewed, setLastViewed, forgetLane } from './push2-view.svelte';
import {
  renderPushCard,
  renderPushLegend,
  pushCardSignature,
  type PushDrawOp,
} from './push-screen-layout';
import { pushLegendView, type PushLegendView } from './push-legend-model';
import { pushCardRgba } from './push-card-paint';
import { isDisplayConnected, sendFrame } from './push2-display.svelte';

const STORAGE_KEY_CHANNEL = 'pt.push2.selectedChannel';

// ---------------------------------------------------------------------------
// Push-LOCAL surface state (never synced — like the launchpad's activeView).
// ---------------------------------------------------------------------------
let selectedChannel = readSelectedChannel(); // 0..7
let shiftHeld = false; // the Push Shift button (for the D-Pad ×8)
/** LEGEND MODE: the legend button is physically held. DISPLAY-ONLY — nothing
 *  reads this except the display-ops seam, so it cannot change any routing. */
let legendHeld = false;
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
  // Track the Shift hold locally for the D-Pad ×8 (it is ALSO routed to the
  // Launchpad top row by classifyPush2 so the parity editor windowing works).
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
  }
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
// EFFECTIVE hue (the default fill for un-picked lanes) — matching Launchpad — so
// only a channel with no bound clip at all is OFF.
// ---------------------------------------------------------------------------

/** Unselected channel-select buttons show their colour at ~30% brightness so the
 *  SELECTED channel (full brightness) reads as the current one — `pushColorIndex`
 *  snaps the scaled RGB to a dimmer stock-palette entry. */
const CHANNEL_DIM = 0.3;

/**
 * The CC value for channel-select button `lane` (0..7): the channel's EFFECTIVE
 * lane colour as a stock-palette index — FULL brightness for the SELECTED
 * channel, ~30% dimmed for the rest — through the SAME `hexToRgb127`→
 * `pushColorIndex` path the pads use, so a button matches its clip column. An
 * un-picked lane shows its default hue (via `laneColorEff`, mirroring the card
 * swatch and Launchpad LEDs), NOT off; only no bound clip at all is OFF (0).
 * Reads the live bound clip node.
 */
export function channelButtonValue(lane: number): number {
  const nodeId = boundClipNode();
  if (!nodeId) return 0; // no bound clip → no channel colours to mirror
  const node = patch.nodes[nodeId] as ModuleNode | undefined;
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
 *  ADDED last. Empty in a non-workflow (dawless) rack, which has no columns. */
export function selectedLaneMembers(): string[] {
  return laneMembers(
    patch.nodes as Record<string, ModuleNode | undefined>,
    mixerColumnsData(),
    selectedLane(),
  );
}

/** Does this rack have channel columns at all? A dawless rack has no pinned
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
 * WHAT THE PANEL SHOWS: the LEGEND while its button is held, else the push card.
 *
 * ONE seam for both consumers — the WebUSB frame pump below and the card's DOM
 * preview canvas — so the on-screen preview cannot disagree with the hardware
 * about what is being displayed. It is also why "release restores the previous
 * display" needs no saved bitmap: the ops are re-derived, the signature returns
 * to the card's, and the dirty check ships exactly one frame.
 */
export function pushDisplayOps(): PushDrawOp[] {
  return legendHeld ? renderPushLegend(currentPushLegendView()) : renderPushCard(currentPushCardView());
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

/** Re-export the card's view switcher (drives the parity single-mode view). */
export { setLaunchpadView };

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
