// packages/web/src/lib/control/push2/push2-control.svelte.ts
//
// Ableton Push 2 CONTROL — binds a Push 2 to a focused `clipplayer` (Phase 1).
// The Push drives the FULL Launchpad clip-launch / note-editor / arm / scene /
// KEYS PARITY surface by INJECTING itself as the control surface of the shipped
// launchpad-control singleton (decision A, plan §3): a small adapter remaps Push
// MIDI ⇄ the Launchpad event/frame vocabulary, so no parity logic is forked.
//
// ON TOP of parity, three ADDITIVE Push-only features live HERE (they never
// touch launchpad-control):
//   · 8 buttons above the display → select channel 1-8 (Push-LOCAL state) + the
//     card shows "CH n · <instrument>" + the selected top button lights bright.
//   · 11 encoders → MixMasters: 8 display encoders = ch1-8 volume, the 2 left
//     encoders = send1/send2 of the SELECTED channel, the master encoder =
//     master volume — all through the electra streaming-CC pump (transient
//     engine push + coalesced bare store write, NEVER a MIDI-rate Y.Doc storm).
//   · D-Pad → CLIP-view nav (± window, +SHIFT = ×8) via launchpad-control's
//     shared launchpadDpadNav seam.
// START/STOP moves to the Push Play button (routed through the parity top row).
//
// The WebUSB 960×160 display is DEFERRED to Phase 2 — Phase 1 shows the channel
// name in the CARD. Binding + selected-channel are per-machine LOCAL; LED frames
// are local render state, never synced.

import { patch } from '$lib/graph/store';
import { getModuleDef } from '$lib/audio/module-registry';
import { resolveDisplayName } from '$lib/multiplayer/module-naming';
import type { ModuleNode } from '$lib/graph/types';
import { laneAssignedModules, laneColorEff, type ClipPlayerData } from '$lib/audio/modules/clip-types';
import { MIXMSTRS_CHANNELS } from '$lib/audio/modules/mixmstrs';
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
  type ControlSurfacePort,
} from '$lib/control/launchpad/launchpad-control.svelte';
import * as push2Device from './push2-device.svelte';
import { pushColorIndex, type Push2RxEvent } from './push2-sysex';
import {
  classifyPush2,
  push2FrameToLeds,
  PUSH_CC_SHIFT,
  PUSH_CC_ABOVE_DISPLAY_BASE,
  type EncoderTarget,
  type Push2LedSpec,
} from './push2-map';
import type { LaunchpadKeyEvent } from './push2-types';

const STORAGE_KEY_CHANNEL = 'pt.push2.selectedChannel';

// ---------------------------------------------------------------------------
// Push-LOCAL surface state (never synced — like the launchpad's activeView).
// ---------------------------------------------------------------------------
let selectedChannel = readSelectedChannel(); // 0..7
let shiftHeld = false; // the Push Shift button (for the D-Pad ×8)
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
  if (raw.type === 'cc' && raw.cc === PUSH_CC_SHIFT) shiftHeld = raw.s === 1;

  const action = classifyPush2(raw);
  if (!action) return;
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
  }
}

// ---------------------------------------------------------------------------
// Additive 5a — channel select (Push-LOCAL). Picks which channel the 2 left
// encoders' send1/send2 address + which name the card's top bar shows.
// ---------------------------------------------------------------------------
export function selectChannel(channel: number): void {
  if (channel < 0 || channel >= MIXMSTRS_CHANNELS.length) return;
  selectedChannel = channel;
  try {
    localStorage.setItem(STORAGE_KEY_CHANNEL, String(channel));
  } catch {
    /* private mode — session-only */
  }
  bump(); // card re-renders the name; the LED repaints on the next render tick
}
export function selectedChannelIndex(): number {
  return selectedChannel;
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
// Additive 5b — encoders → MixMasters, through the electra streaming-CC pump
// (transient engine push per tick + a coalesced bare store write — NEVER a
// MIDI-rate Y.Doc write-storm; memory midi-cc-write-storm-fix).
// ---------------------------------------------------------------------------
const ENCODER_STEP = 0.01; // per detent, over the 0..1 MixMasters ranges

/** The first `mixmstrs` node in the patch (the encoders' target), or null. */
export function firstMixmstrs(): string | null {
  for (const [id, n] of Object.entries(patch.nodes)) {
    if ((n as { type?: string } | undefined)?.type === 'mixmstrs') return id;
  }
  return null;
}

function paramForTarget(target: EncoderTarget): string | null {
  switch (target.param) {
    case 'volume':
      return target.channel >= 0 && target.channel < MIXMSTRS_CHANNELS.length
        ? `ch${target.channel + 1}_volume`
        : null;
    case 'send1':
      return `ch${selectedChannel + 1}_send1`;
    case 'send2':
      return `ch${selectedChannel + 1}_send2`;
    case 'master':
      return 'master_volume';
  }
}

function applyEncoder(target: EncoderTarget, delta: number): void {
  const mixId = firstMixmstrs();
  if (!mixId) return; // no mixer — a no-op (the card shows a hint)
  const paramId = paramForTarget(target);
  if (!paramId) return;
  const node = patch.nodes[mixId] as ModuleNode | undefined;
  const cur = Number(node?.params?.[paramId] ?? 0.8);
  const next = Math.max(0, Math.min(1, cur + delta * ENCODER_STEP));
  ccPumpFor(mixId, paramId).push(next);
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
        if (!active) notifyAutomationRelease({ nodeId: moduleId, paramId }, 'midi');
      },
    });
    ccPumps.set(key, pump);
  }
  return pump;
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
  selectedChannel = 0;
  for (const pump of ccPumps.values()) pump.dispose();
  ccPumps.clear();
}
