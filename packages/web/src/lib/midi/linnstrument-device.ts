// THE LINNSTRUMENT DEVICE LAYER — one Web MIDI binding for the whole app that
// puts a LinnStrument into User Firmware Mode, runs every raw frame through
// the pure WP-A pipeline (`decodePhysicalMidi` → `mapSurface`) and publishes
// the resulting RuntimeEvents through the shared source registry.
//
// A DIRECT browser adapter, not the native bridge the design package
// recommends (design.md:168 "an alternative transport implementation"): User
// Mode entry/exit is NRPN 245 and per-row axis enables are plain CCs, and
// LED cells are CC20/21/22 — no SysEx anywhere — so this rides the shared
// sysex-FALSE seam in `$lib/audio/midi-access` (midi-access.ts:90). Whether
// the native bridge is still wanted as a follow-on is an OWNER question (D10).
//
// ── THE FIVE CONVENTIONS (trails-device.ts:9-24) ───────────────────────────
//   1. `linnstrumentAvailable()`        — a probe, safe anywhere.
//   2. `connectLinnstrument()`          — LAZY and gesture-gated; called from a
//      click handler (/preflight, a face cell), never from a module factory.
//      Returns false and never throws.
//   3. `linnstrumentMidiVersion`        — a `svelte/store` writable status signal.
//   4. `createMidiInputClaim`           — the ONE legal owner of `onmidimessage`.
//   5. `installSimulatedLinnstrument()` — an in-memory double driving the REAL
//      decode path, for unit tests AND e2e.
//
// ── WHERE THE BINDING LIVES ────────────────────────────────────────────────
// The port pick is a property of the RIG, never the patch (ADR-011,
// records/ui-specification.md "device ownership is local"): it is read from
// `rigBindings().getLinnstrument()` (device-slot-bindings.ts) and written on
// /preflight. THE APPLY STEP IS HERE: `connectLinnstrument()` resolves the
// bound port and binds it, and a later rig change re-applies live, so no
// Canvas restore pass has to know this device exists. This file never writes
// `node.data` or the Y.Doc.
//
// ── WHAT THE LED WRITER IS AND IS NOT ──────────────────────────────────────
// It PAINTS ACKNOWLEDGED reducer state (design.md:154 "the module returns an
// authoritative state revision used for LEDs") and never decides: a selector
// press on the hardware produces a `control_edge` event and NOTHING on the
// wire until the runtime's reducer acknowledges it through `onSelection`.
// One serialized writer owns the CC20/21/22 coordinate registers
// (design.md:296 — interleaving two painters colours the wrong cell); frames
// are diffed and coalesced within one microtask.
//
// ── HARDWARE-VERIFY ITEMS (no LinnStrument was connected; design.md C02/C03)
//   · the USB product string (`LINNSTRUMENT_PORT_PATTERN` is deliberately loose)
//   · the per-row axis-enable CC numbers and their channel (`CC_ROW_*`)
//   · NRPN 245 readback on entry and what a page death leaves behind — the
//     manual mode-exit procedure stays in the runbook (design.md:304)
//   · LED colour ids are fixed-palette APPROXIMATIONS (D18)
//
// ⚠ PLAIN `.ts`, NOT `.svelte.ts` (trails-device.ts:20-24): audio defs may
// import this file and the ART node vitest loads every def with no Svelte
// compiler. Reactivity is a `svelte/store` writable.

import { writable } from 'svelte/store';
import { requestMidiAccess, midiOutcomeMessage, webMidiSupported } from '$lib/audio/midi-access';
import { createMidiInputClaim, type MidiInputClaim } from '$lib/midi/input-attach';
import type { MidiEventLike, MidiInputLike } from '$lib/audio/modules/midi-cv-buddy';
import type { MidiOutputLike } from '$lib/audio/modules/midi-out-buddy';
import {
  createMidiScheduler,
  type MidiScheduler,
  type MidiSchedulerCtx,
} from '$lib/audio/midi-timing';
import { rigBindings } from '$lib/graph/device-slot-bindings';
import {
  createRawDecodeState,
  decodePhysicalMidi,
  reconnectRawDecode,
  NRPN_USER_FIRMWARE_MODE,
  CC_SLIDE,
  CC_X_LO_BASE,
  CC_Y_BASE,
  type RawDecodeState,
} from './linnstrument/raw-decode';
import {
  appColToWireCol,
  appRowToLedRow,
  createSurfaceMapState,
  mapSurface,
  type SurfaceMapState,
} from './linnstrument/surface-map';
import { DEFAULT_LINN_PROFILE } from './linnstrument/profile';
import { setLinnstrumentSource } from './linnstrument/source-registry';
import type {
  ControlName,
  LinnProfile,
  LinnstrumentSource,
  RawEvent,
  RuntimeEvent,
  RuntimeEventListener,
  SelectionState,
  SessionEvent,
} from './linnstrument/types';

// ── Wire constants ────────────────────────────────────────────────────────

/**
 * How a LinnStrument names itself on the MIDI bus.
 *
 * ⚠ HARDWARE-VERIFY. The class-compliant port is believed to read
 * "LinnStrument MIDI"; the match is loose on purpose (any case, any suffix,
 * the WinMM `MIDIIN2 (LinnStrument MIDI)` shape included). If the real string
 * carries no "linnstrument", this is the one line that changes.
 */
export const LINNSTRUMENT_PORT_PATTERN = /linnstrument/i;

/** Per-row User Firmware Mode data enables — CC on the ROW's channel, value
 *  0/1 (firmware `user_firmware_mode.md`, pinned in design.md:188 "configure
 *  each row's slide/X/Y/Z flags explicitly"). ⚠ HARDWARE-VERIFY numbers. */
export const CC_ROW_SLIDE_ENABLE = 9;
export const CC_ROW_X_ENABLE = 10;
export const CC_ROW_Y_ENABLE = 11;
export const CC_ROW_Z_ENABLE = 12;

/** LED cell registers: column (wire 1..25), row (0..7), colour id. The three
 *  are SHARED firmware registers, hence the serialized writer. */
export const CC_LED_COLUMN = 20;
export const CC_LED_ROW = 21;
export const CC_LED_COLOR = 22;

/** A complete six-message NRPN transaction, reset included (design.md:188),
 *  on channel `channel` (0-based nibble). */
export function encodeNrpn(parameter: number, value: number, channel = 0): number[][] {
  const s = 0xb0 | (channel & 0x0f);
  return [
    [s, 99, (parameter >> 7) & 0x7f],
    [s, 98, parameter & 0x7f],
    [s, 6, (value >> 7) & 0x7f],
    [s, 38, value & 0x7f],
    [s, 101, 127],
    [s, 100, 127],
  ];
}

/** NRPN 245 = User Firmware Mode on/off. */
export function encodeUserFirmwareMode(on: boolean): number[][] {
  return encodeNrpn(NRPN_USER_FIRMWARE_MODE, on ? 1 : 0);
}

/** Slide / X / Y / Z enables for every row of the profile. The firmware
 *  RESETS these on a mode transition (design.md:188), so they are re-sent on
 *  every bind and after every readback. */
export function encodeRowAxisEnables(profile: LinnProfile): number[][] {
  const out: number[][] = [];
  for (let row = 0; row < profile.rows; row++) {
    const s = 0xb0 | row;
    out.push([s, CC_ROW_SLIDE_ENABLE, 1], [s, CC_ROW_X_ENABLE, 1], [s, CC_ROW_Y_ENABLE, 1], [s, CC_ROW_Z_ENABLE, 1]);
  }
  return out;
}

/** One LED cell as the contiguous CC20 / CC21 / CC22 triple. */
export function encodeLedCell(wireCol: number, ledRow: number, color: number): number[][] {
  return [
    [0xb0, CC_LED_COLUMN, wireCol & 0x7f],
    [0xb0, CC_LED_ROW, ledRow & 0x7f],
    [0xb0, CC_LED_COLOR, color & 0x7f],
  ];
}

// ── Status ────────────────────────────────────────────────────────────────

export type LinnstrumentStatusKind =
  | 'idle'
  | 'unsupported'
  | 'denied'
  | 'no-prompt'
  | 'no-port'
  | 'unbound'
  | 'bound';

export interface LinnstrumentStatus {
  readonly kind: LinnstrumentStatusKind;
  /** User-facing, ACTIONABLE. Every non-bound state names what to do next. */
  readonly message: string;
  /** Names of the live LinnStrument input ports the access can see. */
  readonly portNames: readonly string[];
  /** The bound input's name, or null. */
  readonly boundPortName: string | null;
  /** True once the device layer has ENTERED User Mode on the bound output. A
   *  readback from the instrument is reported through the session events. */
  readonly userMode: boolean;
  readonly epoch: number;
}

export interface LinnstrumentPort {
  inputId: string;
  name: string;
  /** The output paired by name, or the first matching output, or null. */
  outputId: string | null;
}

/** Bumped on ANY binding or roster change. Subscribe and re-read
 *  `linnstrumentStatus()`. */
export const linnstrumentMidiVersion = writable(0);

let bumpQueued = false;
function bump(): void {
  if (bumpQueued) return;
  bumpQueued = true;
  queueMicrotask(() => {
    bumpQueued = false;
    linnstrumentMidiVersion.update((n) => n + 1);
  });
}

// ── Module state ──────────────────────────────────────────────────────────

interface LinnAccessLike {
  readonly inputs: ReadonlyMap<string, MidiInputLike>;
  readonly outputs: ReadonlyMap<string, MidiOutputLike>;
  onstatechange: ((e?: unknown) => void) | null;
}
type LinnRequestFn = () => Promise<LinnAccessLike>;

interface Bound {
  inputId: string;
  outputId: string | null;
  input: MidiInputLike;
  output: MidiOutputLike | null;
  /** Bound because the rig names it (re-applied on rig change) vs. an
   *  explicit `bindLinnstrument()` call (sim / tests). The rig always wins. */
  viaRig: boolean;
}

let access: LinnAccessLike | null = null;
let accessKind: 'idle' | 'unsupported' | 'denied' | 'no-prompt' | 'granted' = 'idle';
let accessMessage = '';
let connectInFlight = false;
let simulated = false;
let bound: Bound | null = null;
let userModeEntered = false;
let unsubRig: (() => void) | null = null;
let pagehideArmed = false;

let profile: LinnProfile = DEFAULT_LINN_PROFILE;
let rawState: RawDecodeState = createRawDecodeState(1);
let mapState: SurfaceMapState = createSurfaceMapState();

let audioClock: MidiSchedulerCtx | null = null;
let scheduler: MidiScheduler | null = null;

const listeners = new Set<RuntimeEventListener>();
let lastSession: SessionEvent = { kind: 'session', epoch: 0, state: 'disconnected', userMode: false, time: 0 };

const diagnostics = { rejected: 0, malformedSlides: 0, published: 0, ledWrites: 0, sent: 0 };

const inputClaim: MidiInputClaim = createMidiInputClaim('linnstrument');

// ── Probes ────────────────────────────────────────────────────────────────

/** Is Web MIDI callable at all? Cannot prompt, cannot throw. */
export function linnstrumentAvailable(): boolean {
  return webMidiSupported();
}

/** True once an access (real or simulated) is held. */
export function linnstrumentHasAccess(): boolean {
  return access !== null;
}

function isLinnPort(p: { name?: string | null; state?: string }): boolean {
  if (p.state === 'disconnected') return false;
  return LINNSTRUMENT_PORT_PATTERN.test(p.name ?? '');
}

/** The live LinnStrument input ports the granted access can see, each paired
 *  with an output (same name first, else the first matching output). Empty
 *  before a grant. The /preflight select is populated from this. */
export function listLinnstrumentPorts(): LinnstrumentPort[] {
  if (!access) return [];
  const outs = [...access.outputs.values()].filter(isLinnPort);
  return [...access.inputs.values()]
    .filter(isLinnPort)
    .map((i) => {
      const name = i.name ?? i.id;
      const paired = outs.find((o) => (o.name ?? o.id) === name) ?? outs[0] ?? null;
      return { inputId: i.id, name, outputId: paired ? paired.id : null };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The current binding state — a PURE read, safe from a `$derived`. */
export function linnstrumentStatus(): LinnstrumentStatus {
  const portNames = [...new Set(listLinnstrumentPorts().map((p) => p.name))].sort();
  const boundPortName = bound ? (bound.input.name ?? bound.inputId) : null;
  const base = { portNames, boundPortName, userMode: userModeEntered, epoch: rawState.epoch };
  if (accessKind === 'unsupported') {
    return { kind: 'unsupported', message: midiOutcomeMessage({ kind: 'unsupported' }), ...base };
  }
  if (accessKind === 'denied') {
    return { kind: 'denied', message: midiOutcomeMessage({ kind: 'denied', message: accessMessage }), ...base };
  }
  if (accessKind === 'no-prompt') {
    return { kind: 'no-prompt', message: midiOutcomeMessage({ kind: 'no-prompt' }), ...base };
  }
  if (accessKind === 'idle') {
    return {
      kind: 'idle',
      message: 'Not connected. CONNECT asks the browser for MIDI and looks for a LinnStrument.',
      ...base,
    };
  }
  if (bound) {
    return {
      kind: 'bound',
      message: `Bound to ${boundPortName} — User Firmware Mode, streaming cells.`,
      ...base,
    };
  }
  const wanted = rigBindings().getLinnstrument()?.deviceId ?? null;
  if (portNames.length === 0) {
    return {
      kind: 'no-port',
      message: wanted
        ? `MIDI is granted but the bound LinnStrument port (${wanted}) is not present. Plug it in — it re-binds automatically — or pick another on rig setup (/preflight).`
        : 'MIDI is granted but no port named "LinnStrument" is present. Connect the instrument over USB; it appears as a class-compliant MIDI device.',
      ...base,
    };
  }
  return {
    kind: 'unbound',
    message: wanted
      ? `MIDI is granted; the bound port (${wanted}) is not among ${portNames.join(', ')}. Pick a present port on rig setup (/preflight).`
      : `MIDI is granted and ${portNames.join(', ')} is present. Pick it on rig setup (/preflight) to bind — binding enters User Firmware Mode on the instrument.`,
    ...base,
  };
}

/** Counters a diagnostics surface can read; never behaviour. */
export function linnstrumentDiagnostics(): Readonly<typeof diagnostics> {
  return { ...diagnostics };
}

/** Which clock domain `RuntimeEvent.time` is in. `audio` once a clock has
 *  been installed with `setLinnstrumentAudioClock`, else `performance`
 *  seconds (`event.timeStamp / 1000`). */
export function linnstrumentTimeDomain(): 'audio' | 'performance' {
  return scheduler ? 'audio' : 'performance';
}

/**
 * Install the audio clock the event timestamps are projected onto. Every
 * `event.timeStamp` goes through `createMidiScheduler` EXACTLY ONCE, here,
 * with the shared default lookahead (midi-timing.ts `TIMESTAMP_LOOKAHEAD_S`,
 * 25 ms). The package's ≤20 ms p95 target (design.md:310) is an OWNER
 * question about a shared seam and is deliberately not changed here.
 * Pass null to fall back to performance seconds.
 */
export function setLinnstrumentAudioClock(ctx: MidiSchedulerCtx | null, opts: { nowMs?: () => number } = {}): void {
  audioClock = ctx;
  scheduler = ctx ? createMidiScheduler(ctx, { nowMs: opts.nowMs }) : null;
}

/** Swap the profile (region rectangles, control rows, palette). The live
 *  decoder state is kept; the map is rebuilt so a running touch cannot
 *  straddle two geometries. */
export function setLinnstrumentProfile(next: LinnProfile): void {
  profile = next;
  mapState = createSurfaceMapState();
  if (bound?.output) sendAll(encodeRowAxisEnables(profile));
  led.painted.clear();
  led.scheduleFlush();
}

export function linnstrumentProfile(): LinnProfile {
  return profile;
}

// ── Time ──────────────────────────────────────────────────────────────────

function perfNowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** ONE projection per message: the scheduler when a clock is installed, else
 *  performance seconds. Every event derived from one message carries the
 *  same `time`. */
function projectTime(eventTimeStampMs: number): number {
  return scheduler ? scheduler.schedAt(eventTimeStampMs) : eventTimeStampMs / 1000;
}

function nowTime(): number {
  return projectTime(perfNowMs());
}

// ── Publishing ────────────────────────────────────────────────────────────

function fanOut(event: RuntimeEvent): void {
  if (event.kind === 'session') lastSession = event;
  diagnostics.published++;
  for (const fn of [...listeners]) {
    try {
      fn(event);
    } catch (err) {
      console.error('[linnstrument] listener threw', err);
    }
  }
}

/** Run raw events through the surface map and publish. `sessionState`
 *  overrides the session state a `mode` raw event would otherwise publish
 *  (`connected` on bind, `disconnected` on unbind). Rejections are COUNTED
 *  and never reach the registry (V14). */
function publishRaw(events: readonly RawEvent[], sessionState?: SessionEvent['state']): void {
  for (const raw of events) {
    if (raw.kind === 'rejected') {
      diagnostics.rejected++;
      if (raw.reason === 'malformed_slide') diagnostics.malformedSlides++;
      continue;
    }
    const m = mapSurface(mapState, raw, profile);
    mapState = m.state;
    for (const e of m.events) {
      if (e.kind === 'session' && sessionState) fanOut({ ...e, state: sessionState });
      else fanOut(e);
    }
  }
}

/** The app-wide source object handed to the registry. ONE object for the
 *  life of the module so `setLinnstrumentSource` stays idempotent. */
const deviceSource: LinnstrumentSource = {
  id: 'linnstrument-user-mode',
  get kind() {
    return simulated ? ('simulated' as const) : ('user_mode' as const);
  },
  subscribe(listener) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  snapshot() {
    return lastSession;
  },
  onSelection(state) {
    led.ack(state);
  },
};

// ── Output ────────────────────────────────────────────────────────────────

function sendAll(messages: readonly number[][]): void {
  const out = bound?.output;
  if (!out) return;
  for (const m of messages) {
    try {
      out.send(m);
      diagnostics.sent++;
    } catch {
      /* the port vanished mid-send — onstatechange re-resolves */
    }
  }
}

/**
 * THE ONE LED WRITER. Holds the last ACKNOWLEDGED selection state, diffs the
 * frame it implies against what is already painted, and flushes each changed
 * cell as one contiguous CC20/21/22 transaction inside a single microtask, so
 * two acks in one tick cost one repaint and no other painter can interleave.
 */
const led = {
  lastAck: null as SelectionState | null,
  painted: new Map<string, number>(),
  flushQueued: false,
  ack(state: SelectionState): void {
    led.lastAck = state;
    led.scheduleFlush();
  },
  scheduleFlush(): void {
    if (led.flushQueued) return;
    led.flushQueued = true;
    queueMicrotask(() => {
      led.flushQueued = false;
      led.flush();
    });
  },
  flush(): void {
    if (!bound?.output || !led.lastAck) return;
    for (const cell of ledFrame(led.lastAck, profile)) {
      const key = `${cell.wireCol},${cell.ledRow}`;
      if (led.painted.get(key) === cell.color) continue;
      sendAll(encodeLedCell(cell.wireCol, cell.ledRow, cell.color));
      led.painted.set(key, cell.color);
      diagnostics.ledWrites++;
    }
  },
};

export interface LedCell {
  wireCol: number;
  ledRow: number;
  color: number;
}

/** The control-column frame acknowledged state implies. Selector cells show
 *  their colour when selected and `off` otherwise; the lower five are lit
 *  only while `extraControlsEnabled` (D17 recommendation). Colour ids are
 *  the profile palette — fixed-firmware APPROXIMATIONS (D18). Pure. */
export function ledFrame(state: SelectionState, p: LinnProfile): LedCell[] {
  const controls = p.regions.controls;
  const wireCol = appColToWireCol(controls.left);
  const colourOf = (name: ControlName): number => {
    if (name === 'r') return state.mask.r ? p.palette.red : p.palette.off;
    if (name === 'g') return state.mask.g ? p.palette.green : p.palette.off;
    if (name === 'b') return state.mask.b ? p.palette.blue : p.palette.off;
    return p.extraControlsEnabled ? p.palette.orange : p.palette.off;
  };
  return (Object.keys(p.controlRows) as ControlName[])
    .map((name) => ({ wireCol, ledRow: appRowToLedRow(controls.bottom + p.controlRows[name]), color: colourOf(name) }))
    .sort((a, b) => b.ledRow - a.ledRow);
}

// ── Input ─────────────────────────────────────────────────────────────────

/** ONE stable handler reference so the claim recognises its own slot. */
function onFrame(ev: MidiEventLike): void {
  if (!bound) return;
  const time = projectTime(ev.timeStamp);
  const r = decodePhysicalMidi(rawState, ev.data, time);
  rawState = r.state;
  publishRaw(r.events);
  // EVERY mode notification resets the firmware's axis enables (design.md:188)
  // — the readback of our own entry included — so a readback saying "User
  // Mode on" re-arms them and repaints from acknowledged state.
  if (r.events.some((e) => e.kind === 'mode' && e.userMode)) {
    sendAll(encodeRowAxisEnables(profile));
    led.painted.clear();
    led.scheduleFlush();
  }
}

// ── Bind / unbind ─────────────────────────────────────────────────────────

function pairedOutput(input: MidiInputLike): MidiOutputLike | null {
  if (!access) return null;
  const outs = [...access.outputs.values()].filter(isLinnPort);
  const name = input.name ?? input.id;
  return outs.find((o) => (o.name ?? o.id) === name) ?? outs[0] ?? null;
}

function armPagehide(): void {
  if (pagehideArmed || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  pagehideArmed = true;
  window.addEventListener('pagehide', () => {
    // Best effort: release the temporary User Mode layer when the page dies
    // (design.md:296). A killed tab cannot send — the runbook's manual exit
    // procedure covers that case.
    unbindLinnstrument();
  });
}

/**
 * Bind ONE input (by id) and enter User Firmware Mode on its paired output.
 * Idempotent for the same port objects: a second call re-sends nothing and
 * publishes nothing. Returns false when the id does not resolve to a live
 * LinnStrument port on the current access.
 */
export function bindLinnstrument(inputId: string, opts: { viaRig?: boolean } = {}): boolean {
  if (!access) return false;
  const input = access.inputs.get(inputId) ?? null;
  if (!input || !isLinnPort(input)) return false;
  const output = pairedOutput(input);
  if (bound && bound.input === input && bound.output === output) {
    bound.viaRig = opts.viaRig ?? bound.viaRig;
    return true;
  }
  if (bound) releaseBound(true);

  bound = { inputId, outputId: output ? output.id : null, input, output, viaRig: opts.viaRig ?? false };
  // Listen on EXACTLY this port; the previous one is released only if it still
  // holds OUR handler (never another subsystem's).
  inputClaim.attachOnly([input], onFrame);

  // A fresh session: stale contacts end, the epoch advances, the map restarts.
  const rc = reconnectRawDecode(rawState, nowTime(), true);
  rawState = rc.state;
  mapState = createSurfaceMapState();
  led.painted.clear();

  sendAll(encodeUserFirmwareMode(true));
  sendAll(encodeRowAxisEnables(profile));
  userModeEntered = output !== null;

  publishRaw(rc.events, 'connected');
  led.scheduleFlush();
  armPagehide();
  try {
    console.info('[linnstrument] bound — IN:', input.name ?? input.id, '· OUT:', output ? (output.name ?? output.id) : 'none');
  } catch {
    /* diagnostic only */
  }
  bump();
  return true;
}

/** Tear the binding down. `restore` sends the User Mode exit; false when the
 *  port is already gone (nothing to send to). */
function releaseBound(restore: boolean): void {
  if (!bound) return;
  if (restore) sendAll(encodeUserFirmwareMode(false));
  inputClaim.detach();
  const rc = reconnectRawDecode(rawState, nowTime(), false);
  rawState = rc.state;
  bound = null;
  userModeEntered = false;
  led.painted.clear();
  publishRaw(rc.events, 'disconnected');
  mapState = createSurfaceMapState();
}

/** Leave User Firmware Mode and release the port. Safe when unbound. */
export function unbindLinnstrument(): void {
  if (!bound) return;
  releaseBound(true);
  bump();
}

/**
 * THE APPLY STEP. Re-resolve the port roster against the current access and
 * the rig binding: bind the rig's port when it is present, re-attach when the
 * port OBJECT changed under the same id (a hot-plug — push2-device's
 * `reattachBoundPort` shape), release without a restore when it vanished, and
 * release with a restore when the rig binding was cleared.
 */
function resolvePorts(): void {
  if (!access) {
    if (bound) releaseBound(false);
    bump();
    return;
  }
  const wanted = rigBindings().getLinnstrument()?.deviceId ?? null;
  if (wanted) {
    const input = access.inputs.get(wanted) ?? null;
    if (input && isLinnPort(input)) {
      if (!bound || bound.input !== input || bound.output !== pairedOutput(input)) bindLinnstrument(wanted, { viaRig: true });
      else bound.viaRig = true;
    } else if (bound && bound.inputId === wanted) {
      releaseBound(false);
    }
  } else if (bound?.viaRig) {
    releaseBound(true);
  } else if (bound && !isLinnPort(bound.input)) {
    releaseBound(false);
  }
  bump();
}

function adoptAccess(a: LinnAccessLike): void {
  access = a;
  accessKind = 'granted';
  accessMessage = '';
  access.onstatechange = () => resolvePorts();
  setLinnstrumentSource(deviceSource);
  if (!unsubRig) unsubRig = rigBindings().subscribe(() => resolvePorts());
  resolvePorts();
}

/**
 * Ask for Web MIDI (sysex:false) and apply the rig binding.
 *
 * MUST be called synchronously from a user gesture — an `await` above the
 * request spends the activation and Chromium refuses to prompt. Safe to call
 * again: with access held it just re-resolves. NEVER THROWS. Returns true
 * only when a port is actually bound.
 */
export async function connectLinnstrument(request?: LinnRequestFn): Promise<boolean> {
  if (access) {
    resolvePorts();
    return bound !== null;
  }
  if (connectInFlight) return false;

  if (request) {
    connectInFlight = true;
    try {
      adoptAccess(await request());
    } catch {
      accessKind = 'denied';
      accessMessage = 'Permission denied';
      bump();
    } finally {
      connectInFlight = false;
    }
    return bound !== null;
  }

  if (!linnstrumentAvailable()) {
    accessKind = 'unsupported';
    bump();
    return false;
  }

  connectInFlight = true;
  try {
    const outcome = await requestMidiAccess({
      onLateResolve: (a) => adoptAccess(a as unknown as LinnAccessLike),
    });
    if (outcome.kind === 'granted') {
      adoptAccess(outcome.access as unknown as LinnAccessLike);
    } else {
      accessKind = outcome.kind;
      accessMessage = outcome.kind === 'denied' ? outcome.message : '';
      bump();
    }
  } catch {
    accessKind = 'denied';
    accessMessage = 'Permission denied';
    bump();
  } finally {
    connectInFlight = false;
  }
  return bound !== null;
}

// ── The simulated device ──────────────────────────────────────────────────
//
// ⚠ IT DRIVES THE REAL CODE PATH. A fake access handed to
// `connectLinnstrument()`: the port match, the claim, the decoder, the surface
// map, the registry fan-out and the LED writer all run exactly as on hardware;
// only the USB cable is replaced. Coordinates on this handle are APPLICATION
// coordinates (col 0..24, row 0..7, bottom-left origin); it spells the wire
// bytes itself (col+1 note, row channel) so a test that calls `touch(0,0)` is
// exercising the +1 asymmetry, not bypassing it.

export interface SimulatedLinnstrument {
  readonly portName: string;
  readonly inputId: string;
  readonly outputId: string;
  /** Push raw bytes as if the instrument had sent them. */
  send(bytes: readonly number[], timeStampMs?: number): void;
  /** Fresh press at APP (col,row) with optional raw X (0..16383), local Y and Z. */
  touch(col: number, row: number, opts?: { velocity?: number; x?: number; y?: number; z?: number }): void;
  /** Expression on a held cell. */
  move(col: number, row: number, opts: { x?: number; y?: number; z?: number }): void;
  release(col: number, row: number, velocity?: number): void;
  /** The documented transfer transaction: CC119 source, Note On dest, Note Off source. */
  slide(fromCol: number, toCol: number, row: number): void;
  /** Echo the NRPN 245 readback the firmware emits on a mode transition. */
  ackUserMode(on?: boolean): void;
  /** Every message the app sent to the output, oldest first. */
  writes(): number[][];
  clearWrites(): void;
  attached(): boolean;
  /** Flip the ports to 'disconnected' / 'connected' and fire statechange. */
  unplug(): void;
  plug(): void;
  uninstall(): void;
}

export interface SimulatedLinnstrumentOptions {
  portName?: string;
  /** Bind explicitly after connecting when the rig names no port. Default true. */
  bind?: boolean;
  /** A port that must NOT match — the negative control. */
  decoyPortName?: string;
}

interface SimInput extends MidiInputLike {
  onmidimessage: ((ev: MidiEventLike) => void) | null;
}

function makeSimInput(id: string, name: string): SimInput {
  return { id, name, manufacturer: 'Roger Linn Design', state: 'connected', onmidimessage: null };
}

export async function installSimulatedLinnstrument(
  opts: SimulatedLinnstrumentOptions = {},
): Promise<SimulatedLinnstrument> {
  const portName = opts.portName ?? 'LinnStrument MIDI';
  const inputId = 'sim-linnstrument-in';
  const outputId = 'sim-linnstrument-out';
  const inputs = new Map<string, SimInput>();
  const outputs = new Map<string, MidiOutputLike>();
  const writes: number[][] = [];
  const input = makeSimInput(inputId, portName);
  const output: MidiOutputLike = {
    id: outputId,
    name: portName,
    manufacturer: 'Roger Linn Design',
    state: 'connected',
    send(d) {
      if (output.state === 'disconnected') throw new Error('port is disconnected');
      writes.push(Array.from(d));
    },
  };
  inputs.set(inputId, input);
  outputs.set(outputId, output);
  if (opts.decoyPortName) {
    inputs.set('sim-decoy-in', makeSimInput('sim-decoy-in', opts.decoyPortName));
  }
  const simAccess: LinnAccessLike = { inputs, outputs, onstatechange: null };
  simulated = true;
  await connectLinnstrument(async () => simAccess);
  if (opts.bind !== false && !bound && access === simAccess) bindLinnstrument(inputId);

  const wire = (col: number): number => appColToWireCol(col);
  function send(bytes: readonly number[], timeStampMs = perfNowMs()): void {
    const handler = input.onmidimessage;
    if (typeof handler === 'function') handler({ data: Uint8Array.from(bytes), timeStamp: timeStampMs });
  }
  function move(col: number, row: number, o: { x?: number; y?: number; z?: number }): void {
    const s = 0xb0 | row;
    if (o.x !== undefined) {
      const x = Math.max(0, Math.min(16383, Math.round(o.x)));
      // Low bits first, then high — the pinned firmware order (design.md:186).
      send([s, wire(col) + CC_X_LO_BASE, x & 0x7f]);
      send([s, wire(col), (x >> 7) & 0x7f]);
    }
    if (o.y !== undefined) send([s, wire(col) + CC_Y_BASE, Math.max(0, Math.min(127, Math.round(o.y)))]);
    if (o.z !== undefined) send([0xa0 | row, wire(col), Math.max(0, Math.min(127, Math.round(o.z)))]);
  }
  function setState(state: string): void {
    input.state = state;
    output.state = state;
    simAccess.onstatechange?.({ port: input });
  }

  return {
    portName,
    inputId,
    outputId,
    send,
    touch(col, row, o = {}) {
      send([0x90 | row, wire(col), o.velocity ?? 100]);
      move(col, row, o);
    },
    move,
    release(col, row, velocity = 0) {
      send([0x80 | row, wire(col), velocity]);
    },
    slide(fromCol, toCol, row) {
      send([0xb0 | row, CC_SLIDE, wire(fromCol)]);
      send([0x90 | row, wire(toCol), 100]);
      send([0x80 | row, wire(fromCol), 0]);
    },
    ackUserMode(on = true) {
      for (const m of encodeNrpn(NRPN_USER_FIRMWARE_MODE, on ? 1 : 0)) send(m);
    },
    writes: () => writes.map((w) => [...w]),
    clearWrites() {
      writes.length = 0;
    },
    attached: () => typeof input.onmidimessage === 'function',
    unplug: () => setState('disconnected'),
    plug: () => setState('connected'),
    uninstall() {
      if (bound) releaseBound(true);
      if (access === simAccess) {
        access.onstatechange = null;
        access = null;
        accessKind = 'idle';
        setLinnstrumentSource(null);
      }
      simulated = false;
      bump();
    },
  };
}

/** Drop every binding, subscriber and counter. Unit-test hygiene only. */
export function __resetLinnstrumentForTest(): void {
  if (bound) releaseBound(false);
  inputClaim.detach();
  listeners.clear();
  if (access) access.onstatechange = null;
  access = null;
  accessKind = 'idle';
  accessMessage = '';
  connectInFlight = false;
  simulated = false;
  userModeEntered = false;
  unsubRig?.();
  unsubRig = null;
  pagehideArmed = false;
  profile = DEFAULT_LINN_PROFILE;
  rawState = createRawDecodeState(1);
  mapState = createSurfaceMapState();
  audioClock = null;
  scheduler = null;
  lastSession = { kind: 'session', epoch: 0, state: 'disconnected', userMode: false, time: 0 };
  led.lastAck = null;
  led.painted.clear();
  led.flushQueued = false;
  diagnostics.rejected = 0;
  diagnostics.malformedSlides = 0;
  diagnostics.published = 0;
  diagnostics.ledWrites = 0;
  diagnostics.sent = 0;
  setLinnstrumentSource(null);
}

/** The installed audio clock, for a diagnostics surface. */
export function linnstrumentAudioClock(): MidiSchedulerCtx | null {
  return audioClock;
}

