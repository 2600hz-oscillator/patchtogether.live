// packages/web/src/lib/control/launchpad/launchpad-device.svelte.ts
//
// Launchpad Mini Mk3 PAIR — Web-MIDI device singleton (the clip-launcher's
// hardware side, analogue of monome-device but over Web MIDI instead of
// WebSerial, and managing TWO units: L = the clip matrix, R = the command deck
// / note editor).
//
// One sysex-capable `navigator.requestMIDIAccess({ sysex: true })` (programmer
// mode + per-LED RGB lighting need SysEx), behind the existing on-demand MIDI
// permission flow — NO eager prompt (mirrors midi-cv-buddy / midi-learn /
// electra-broker: access is requested only when the user clicks "Connect" /
// "Pair"). Reuses the MidiInputLike / MidiOutputLike / MidiAccessLike shapes so
// a test can inject a fake pair via the SAME seam the rest of the MIDI stack
// uses (`installSimulatedLaunchpad`, parallel to `installSimulatedGrid` /
// `installSimulatedMidiDevice`).
//
// WHY ITS OWN ACCESS (not midi-learn's): midi-learn opens a `sysex:false`
// access and routes every inbound CC/Note into CC/NOTE-learn dispatch — a
// Launchpad pad press would be mis-routed there. Programmer mode also REQUIRES
// `sysex:true` for the mode-enter + the RGB lighting SysEx. So, exactly like
// the Electra broker (the in-repo precedent for a sysex Web-MIDI surface), the
// Launchpad owns a dedicated sysex access. We still reuse the shared
// MidiAccessLike/webMidiAvailable types + the inject-a-fake-access test seam, so
// there is ONE access PER controller family, never two for the same device.
//
// All I/O here is PER-USER LOCAL — the Launchpads are one person's hardware.
// The clip-player module's clip + playing state syncs via Y.Doc elsewhere; this
// file never touches the synced store. LED frames are local render state.
//
// The byte protocol lives in ./launchpad-sysex.ts (PURE, golden-vector tested).
// This file is the lifecycle + stream plumbing around it.

import type {
  MidiAccessLike,
  MidiInputLike,
  MidiEventLike,
} from '$lib/audio/modules/midi-cv-buddy';
import type { MidiOutputLike } from '$lib/audio/modules/midi-out-buddy';
import { webMidiAvailable } from '$lib/audio/modules/midi-cv-buddy';
import {
  LP_CELLS,
  LP_WIDTH,
  LP_HEIGHT,
  clampRgb,
  padNote,
  encodeEnterProgrammerMode,
  encodeExitProgrammerMode,
  encodeLedRgb,
  encodeLedRgbBatch,
  decodeMidiMessage,
  type RgbSpec,
  type LaunchpadRxEvent,
} from './launchpad-sysex';

// ---------------------------------------------------------------------------
// Combined sysex-capable access (inputs + outputs). Same shape the Electra
// broker uses; redeclared here to avoid an import cycle through electra/.
// ---------------------------------------------------------------------------
export interface MidiFullAccessLike {
  inputs: Map<string, MidiInputLike>;
  outputs: Map<string, MidiOutputLike>;
  onstatechange: ((ev: { port: MidiInputLike | MidiOutputLike }) => void) | null;
}

/** Which physical unit a callback/frame addresses. */
export type LaunchpadUnit = 'L' | 'R';

/** A decoded key/CC event tagged with the unit it came from. */
export interface LaunchpadKeyEvent {
  unit: LaunchpadUnit;
  ev: LaunchpadRxEvent;
}

/** One LED frame: a flat RGB triple per addressable LED. We track every
 *  programmer-mode index we paint (pads 11..88 + top/scene CCs + logo), keyed
 *  by index in a small map so a frame can address pads + buttons uniformly. A
 *  caller builds a frame via the LaunchpadFrame helpers below. */
export interface LaunchpadFrame {
  /** index → [r,g,b] (each 0..127). Indices absent from the map are blanked. */
  leds: Map<number, [number, number, number]>;
}

/** Build an empty frame. */
export function emptyFrame(): LaunchpadFrame {
  return { leds: new Map() };
}

// ---------------------------------------------------------------------------
// Per-unit binding. Each Launchpad is one MIDI input + one MIDI output (the
// `… MIDI` port pair, NOT the `… DAW` port — programmer mode lives on MIDI).
// ---------------------------------------------------------------------------
interface UnitBinding {
  inputId: string | null;
  outputId: string | null;
  input: MidiInputLike | null;
  output: MidiOutputLike | null;
  /** Last RGB we sent per index — diff source so setFrame emits only changes. */
  lastRgb: Map<number, string>;
}

function newUnit(): UnitBinding {
  return { inputId: null, outputId: null, input: null, output: null, lastRgb: new Map() };
}

// ---------------------------------------------------------------------------
// Singleton state
// ---------------------------------------------------------------------------
let access: MidiFullAccessLike | null = null;
let connectStarted = false;
let connectFailed = false;

const units: Record<LaunchpadUnit, UnitBinding> = { L: newUnit(), R: newUnit() };

const keyListeners = new Set<(e: LaunchpadKeyEvent) => void>();

/** Reactive status counter — bump to notify Svelte UI of connect/pair changes
 *  (mirrors monome-device.connectedRune / midi-learn's version rune). */
let statusVersion = $state(0);
function bumpStatus(): void {
  statusVersion++;
}
export function statusRune(): number {
  return statusVersion;
}

// ---------------------------------------------------------------------------
// Capability + status
// ---------------------------------------------------------------------------

/** Is Web MIDI available (Chromium)? Gates the whole feature so Safari/Firefox
 *  + CI degrade cleanly (no hardware). */
export function midiAvailable(): boolean {
  return webMidiAvailable();
}

/** True once a sysex access is held (real or simulated). */
export function hasAccess(): boolean {
  return access !== null;
}

/** Is a given unit fully bound (input + output)? */
export function isUnitBound(unit: LaunchpadUnit): boolean {
  const u = units[unit];
  return !!(u.input && u.output);
}

/** True once BOTH units are bound (the pair is ready to drive a clip-player). */
export function isPairBound(): boolean {
  return isUnitBound('L') && isUnitBound('R');
}

/** True once the SINGLE unit (the L slot) is bound — the single-unit deployment.
 *  The lone device always binds to the L slot (see launchpad-control's single
 *  bind path); the control layer flips its role between clip + control views. */
export function isSingleBound(): boolean {
  return isUnitBound('L') && !isUnitBound('R');
}

// ---------------------------------------------------------------------------
// Connect (acquire sysex access) — lazy, idempotent, gesture-gated.
// ---------------------------------------------------------------------------

/**
 * Acquire a sysex-capable MIDIAccess. MUST be called from a user gesture (the
 * permission prompt requires it). Returns false (never throws) when Web MIDI is
 * unavailable, the user denies, or the request fails. Idempotent.
 */
export async function connect(): Promise<boolean> {
  if (access) return true;
  if (connectFailed) return false;
  if (connectStarted) {
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 25));
      if (access) return true;
      if (connectFailed) return false;
    }
    return false;
  }
  if (!webMidiAvailable()) {
    connectFailed = true;
    return false;
  }
  connectStarted = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const a = await (navigator as any).requestMIDIAccess({ sysex: true });
    access = a as MidiFullAccessLike;
    access.onstatechange = () => {
      // Re-resolve bound ports on hot-plug (a unit reconnecting keeps its id).
      reattachBoundPorts();
      bumpStatus();
    };
    bumpStatus();
    return true;
  } catch {
    connectFailed = true;
    return false;
  }
}

// ---------------------------------------------------------------------------
// Port enumeration — the pairing handshake's raw material.
// ---------------------------------------------------------------------------

/** A Launchpad-MIDI candidate port (the `… MIDI` pair, not `… DAW`). */
export interface LaunchpadPort {
  inputId: string;
  outputId: string;
  name: string;
}

/** Is a port name a Launchpad Mini Mk3 candidate for the **MIDI/programmer**
 *  side (i.e. NOT the DAW/Session control-surface port)? Matches the family
 *  loosely (case-insensitive `launchpad`/`lpmini`/`mk3`) and excludes any port
 *  whose NAME self-identifies as the DAW/Session port.
 *
 *  IMPORTANT — this is a per-NAME predicate, so it can only drop ports that
 *  NAME THEMSELVES as DAW/Session, which is what macOS CoreMIDI / Linux ALSA do
 *  ("LPMiniMK3 DAW In" vs "LPMiniMK3 MIDI In"). On Windows/WinMM BOTH the
 *  Session AND the programmer port are named "LPMiniMK3 MIDI" — the programmer
 *  one only distinguished by a "MIDIIN2/MIDIOUT2" prefix — so the un-numbered
 *  Session primary is indistinguishable BY NAME ALONE here: it passes this
 *  predicate and is dropped at the SET level in enumerateLaunchpadPorts (see
 *  hasSecondaryInterfaceMarker). Programmer mode + pad data live on the MIDI
 *  (Windows: the numbered) port, never the DAW port. */
export function isLaunchpadMidiPortName(name: string | null | undefined): boolean {
  const n = (name ?? '').toLowerCase();
  const isLaunchpad = n.includes('launchpad') || n.includes('lpmini') || n.includes('lp mini') || n.includes('mk3');
  if (!isLaunchpad) return false;
  if (n.includes('daw') || n.includes('session')) return false; // control-surface port, not programmer mode
  return true;
}

/** Does this port name carry a Windows/WinMM **secondary-interface** marker —
 *  the "MIDIIN2 (...)" / "MIDIOUT2 (...)" prefix WinMM prepends to the 2nd (3rd,
 *  …) USB-MIDI interface of a multi-port device? The Launchpad Mini Mk3 exposes
 *  two interfaces BOTH named "LPMiniMK3 MIDI" on Windows; the FIRST (un-numbered)
 *  is the DAW/Session control port and the SECOND ("MIDIIN2 (LPMiniMK3 MIDI)" /
 *  "MIDIOUT2 (LPMiniMK3 MIDI)") is the User/**Programmer** port that carries the
 *  pad data. So when numbered siblings exist we keep ONLY them. macOS CoreMIDI /
 *  Linux ALSA use explicit "DAW"/"MIDI" names with NO numeric marker → false
 *  there (the macOS "LPMiniMK3 MIDI In" has no trailing digit). */
export function hasSecondaryInterfaceMarker(name: string | null | undefined): boolean {
  return /midi\s*(in|out)\s*[2-9]/i.test(name ?? '');
}

/**
 * Enumerate the Launchpad **MIDI** ports as input/output PAIRS, pairing the i-th
 * filtered input with the i-th filtered output (device/enumeration order).
 *
 * CRITICAL: two identical Launchpad Mini Mk3 units enumerate with the **exact
 * same** port names ("LPMiniMK3 MIDI In" / "LPMiniMK3 MIDI Out") — there is no
 * name to tell them apart. Matching an input to an output BY NAME therefore
 * collapses BOTH units onto the first output (every input "best-matches" the
 * first identically-named output), so only one physical unit is ever addressed
 * — it enters programmer mode + lights, the other stays stuck in its standalone
 * Keys mode. That was the real-hardware pairing bug.
 *
 * CoreMIDI / Web-MIDI enumerate a device's input and output together and in the
 * same device order, so the i-th Launchpad-MIDI input and the i-th
 * Launchpad-MIDI output belong to the SAME physical unit: in[0]↔out[0] = unit A,
 * in[1]↔out[1] = unit B. Pairing by position distinguishes two identical units.
 * (The pairing handshake then resolves which physical unit is L vs R by which
 * one the user presses — see startPairing.)
 *
 * Returns [] when no access / no Launchpad ports. Reads the access maps only.
 */
export function enumerateLaunchpadPorts(): LaunchpadPort[] {
  if (!access) return [];
  let ins: MidiInputLike[] = [];
  for (const inp of access.inputs.values()) {
    if (isLaunchpadMidiPortName(inp.name)) ins.push(inp);
  }
  let outs: MidiOutputLike[] = [];
  for (const o of access.outputs.values()) {
    if (isLaunchpadMidiPortName(o.name)) outs.push(o);
  }
  // WINDOWS/WinMM: the Launchpad exposes TWO interfaces both named "LPMiniMK3
  // MIDI" (no "DAW" token to exclude the control port at the name level). The
  // programmer + pad-data port is the SECOND, numbered "MIDIIN2/MIDIOUT2 (...)";
  // the un-numbered one is the DAW/Session port. When numbered siblings exist,
  // keep ONLY them — otherwise the index pairing below binds the DAW input while
  // the LED output still reaches the programmer side, so pads light but presses
  // never arrive (the real "buttons dead on Windows, works on macOS" bug: macOS
  // CoreMIDI names them "DAW"/"MIDI" so the name-level exclusion suffices, but
  // Windows needs this set-level drop). macOS/Linux have no numeric markers →
  // .some(...) is false → both stay unfiltered (no-op).
  if (ins.some((p) => hasSecondaryInterfaceMarker(p.name))) {
    ins = ins.filter((p) => hasSecondaryInterfaceMarker(p.name));
  }
  if (outs.some((p) => hasSecondaryInterfaceMarker(p.name))) {
    outs = outs.filter((p) => hasSecondaryInterfaceMarker(p.name));
  }
  const n = Math.min(ins.length, outs.length);
  const out: LaunchpadPort[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ inputId: ins[i].id, outputId: outs[i].id, name: ins[i].name ?? outs[i].name ?? ins[i].id });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Binding a unit to a concrete port pair + programmer-mode handshake.
// ---------------------------------------------------------------------------

/**
 * Bind a unit (L or R) to a concrete input/output port pair and enter
 * programmer mode on it. Idempotent for the same ids. Returns false if the ids
 * don't resolve in the current access (e.g. the device vanished).
 */
export function bindUnit(unit: LaunchpadUnit, inputId: string, outputId: string): boolean {
  if (!access) return false;
  const input = access.inputs.get(inputId) ?? null;
  const output = access.outputs.get(outputId) ?? null;
  if (!input || !output) return false;
  const u = units[unit];
  const prevInput = u.input;
  u.inputId = inputId;
  u.outputId = outputId;
  u.input = input;
  u.output = output;
  u.lastRgb.clear();
  input.onmidimessage = (ev: MidiEventLike) => handleInbound(unit, ev);
  // Detach this unit's PREVIOUS input — but ONLY if no unit still references it.
  // During an L↔R pairing swap, the two units exchange input objects; binding L
  // to the other unit's old input must NOT null that input (it's about to be /
  // already is owned by this unit), and re-binding R must NOT null L's new input.
  // Nulling by object-identity alone killed the freshly-wired LEFT input on real
  // hardware (LEFT pads dead, RIGHT working). Detach only a truly-orphaned input.
  if (prevInput && prevInput !== input && !inputStillBound(prevInput)) {
    prevInput.onmidimessage = null;
  }
  enterProgrammerMode(unit);
  bumpStatus();
  return true;
}

/** Is a MIDI input still referenced by EITHER bound unit? (Guards the L↔R swap
 *  detach: an input being handed from one unit to the other is NOT orphaned.) */
function inputStillBound(input: MidiInputLike): boolean {
  return units.L.input === input || units.R.input === input;
}

/** Re-resolve a unit's MidiInput/Output objects from the current access by the
 *  saved ids (after a hot-plug onstatechange). No-op if unbound. */
function reattachBoundPorts(): void {
  if (!access) return;
  for (const unit of ['L', 'R'] as const) {
    const u = units[unit];
    if (!u.inputId || !u.outputId) continue;
    const input = access.inputs.get(u.inputId) ?? null;
    const output = access.outputs.get(u.outputId) ?? null;
    if (input && input !== u.input) {
      u.input = input;
      input.onmidimessage = (ev: MidiEventLike) => handleInbound(unit, ev);
    }
    if (output && output !== u.output) {
      u.output = output;
      u.lastRgb.clear();
      enterProgrammerMode(unit);
    }
  }
}

/** Send the programmer-mode enter SysEx to a unit. */
export function enterProgrammerMode(unit: LaunchpadUnit): void {
  sendRaw(unit, encodeEnterProgrammerMode());
}
/** Send the exit-to-Live SysEx to a unit (best-effort cleanup on unbind). */
export function exitProgrammerMode(unit: LaunchpadUnit): void {
  sendRaw(unit, encodeExitProgrammerMode());
}

/** Unbind a unit: blank it, return it to Live mode, detach its input. */
export function unbindUnit(unit: LaunchpadUnit): void {
  const u = units[unit];
  if (u.output) {
    clearUnit(unit);
    exitProgrammerMode(unit);
  }
  if (u.input) u.input.onmidimessage = null;
  u.inputId = null;
  u.outputId = null;
  u.input = null;
  u.output = null;
  u.lastRgb.clear();
  bumpStatus();
}

/** Unbind both units (full teardown). */
export function unbindAll(): void {
  unbindUnit('L');
  unbindUnit('R');
}

// ---------------------------------------------------------------------------
// Inbound dispatch
// ---------------------------------------------------------------------------

function handleInbound(unit: LaunchpadUnit, ev: MidiEventLike): void {
  // A Launchpad sends 3-byte Note/CC for pad + button events in programmer
  // mode; SysEx (mode/lighting echoes) is ignored here.
  const data = ev.data;
  if (data.length < 1) return;
  if (data[0] === 0xf0) return; // a SysEx echo — not a key event
  const decoded = decodeMidiMessage(data);
  if (!decoded) return;
  for (const cb of keyListeners) cb({ unit, ev: decoded });
}

/** Subscribe to decoded key/CC events from EITHER unit. Returns unsubscribe. */
export function onKey(cb: (e: LaunchpadKeyEvent) => void): () => void {
  keyListeners.add(cb);
  return () => keyListeners.delete(cb);
}

// ---------------------------------------------------------------------------
// LED output — diffed RGB writes via the codec.
// ---------------------------------------------------------------------------

/** Send raw bytes to a unit's output (no-op if unbound). */
function sendRaw(unit: LaunchpadUnit, bytes: Uint8Array): void {
  const u = units[unit];
  if (!u.output) return;
  try {
    u.output.send(bytes);
  } catch {
    /* the port vanished mid-send — onstatechange will re-resolve */
  }
}

const rgbKey = (r: number, g: number, b: number): string =>
  `${clampRgb(r)},${clampRgb(g)},${clampRgb(b)}`;

/** Every non-pad addressable CC index (top row + right scene column + logo) —
 *  the "rest of the surface" a full blank has to cover beyond pads 11..88. */
const ALL_SURFACE_CCS = [91, 92, 93, 94, 95, 96, 97, 98, 99, 89, 79, 69, 59, 49, 39, 29, 19] as const;

/**
 * Diff an LED frame against a prior `lastRgb` map → the changed specs to send
 * PLUS the next lastRgb snapshot. Only CHANGED LEDs are emitted; indices lit
 * last frame but absent this frame are blanked (RGB 0,0,0). Shared by the L/R
 * units (setFrame) and the independent monitor bindings (setMonitorFrame).
 */
function diffFrameSpecs(
  lastRgb: Map<number, string>,
  frame: LaunchpadFrame,
): { specs: RgbSpec[]; nextSeen: Map<number, string> } {
  const specs: RgbSpec[] = [];
  const nextSeen = new Map<number, string>();
  for (const [index, [r, g, b]] of frame.leds) {
    const key = rgbKey(r, g, b);
    nextSeen.set(index, key);
    if (lastRgb.get(index) !== key) specs.push({ index, r, g, b });
  }
  // Blank LEDs that were lit last frame but are gone now.
  for (const index of lastRgb.keys()) {
    if (!nextSeen.has(index)) {
      specs.push({ index, r: 0, g: 0, b: 0 });
      nextSeen.set(index, rgbKey(0, 0, 0));
    }
  }
  return { specs, nextSeen };
}

/**
 * Push a full LED frame to a unit, diffed against the last frame so only
 * CHANGED LEDs are emitted, batched into ONE lighting SysEx (the Mini accepts a
 * whole-surface repaint, up to ~81 specs, per message). Indices that were lit
 * last frame but are absent this frame are blanked (RGB 0,0,0).
 */
export function setFrame(unit: LaunchpadUnit, frame: LaunchpadFrame): void {
  const u = units[unit];
  if (!u.output) return;
  const { specs, nextSeen } = diffFrameSpecs(u.lastRgb, frame);
  if (specs.length === 0) return;
  u.lastRgb = nextSeen;
  sendRaw(unit, encodeLedRgbBatch(specs));
}

/** Light ONE LED on a unit (by programmer-mode index), diffed. */
export function setLed(unit: LaunchpadUnit, index: number, r: number, g: number, b: number): void {
  const u = units[unit];
  if (!u.output) return;
  const key = rgbKey(r, g, b);
  if (u.lastRgb.get(index) === key) return;
  u.lastRgb.set(index, key);
  sendRaw(unit, encodeLedRgb(index, r, g, b));
}

/** Blank every LED on a unit (full repaint to black). */
export function clearUnit(unit: LaunchpadUnit): void {
  const specs: RgbSpec[] = [];
  // Pads 11..88.
  for (let y = 0; y < LP_HEIGHT; y++) {
    for (let x = 0; x < LP_WIDTH; x++) specs.push({ index: padNote(x, y), r: 0, g: 0, b: 0 });
  }
  // Top + scene + logo CCs.
  for (const cc of ALL_SURFACE_CCS) specs.push({ index: cc, r: 0, g: 0, b: 0 });
  units[unit].lastRgb.clear();
  for (const s of specs) units[unit].lastRgb.set(s.index, rgbKey(0, 0, 0));
  sendRaw(unit, encodeLedRgbBatch(specs));
}

// ---------------------------------------------------------------------------
// MONITOR bindings — the "out to launch" video-monitor path. INDEPENDENT of the
// L/R clip-launcher units: a monitor claims a Launchpad OUTPUT port (by id) and
// owns its LEDs, reusing the SAME shared sysex `access` + the pure codec. This
// is output-ONLY (a monitor never listens to pad presses — it takes the surface
// over as a screen), and keyed by an opaque token (the video node id) so MANY
// monitors on MANY devices can run at once, and so a monitor can drive a
// DIFFERENT device than the clip-launcher pair simultaneously.
//
// LED OWNERSHIP is exclusive per device: a monitor claim on an output already
// held by an L/R unit OR by another monitor is REFUSED (isOutputClaimed) — two
// owners painting the same physical surface would fight over every LED. The
// clip-launcher control and a monitor therefore cannot share ONE device, but
// they run happily on two different ones.
// ---------------------------------------------------------------------------

interface MonitorBinding {
  token: string;
  outputId: string;
  output: MidiOutputLike;
  /** Last RGB we sent per index — the diff source (mirrors UnitBinding). */
  lastRgb: Map<number, string>;
}

/** token → binding. A token (the video node id) owns at most one device. */
const monitors = new Map<string, MonitorBinding>();

/** Is an OUTPUT port currently claimed by an L/R unit? */
function outputHeldByUnit(outputId: string): boolean {
  return units.L.outputId === outputId || units.R.outputId === outputId;
}
/** Is an OUTPUT port claimed by a monitor OTHER than `exceptToken`? */
function outputHeldByOtherMonitor(outputId: string, exceptToken?: string): boolean {
  for (const m of monitors.values()) {
    if (m.outputId === outputId && m.token !== exceptToken) return true;
  }
  return false;
}

/**
 * Is a Launchpad output port already owned (by an L/R clip-launcher unit or a
 * monitor other than `exceptToken`)? The card greys out claimed ports; bindMonitor
 * refuses them. This is the "exclusive LED control" rule — one owner per surface.
 */
export function isOutputClaimed(outputId: string, exceptToken?: string): boolean {
  return outputHeldByUnit(outputId) || outputHeldByOtherMonitor(outputId, exceptToken);
}

/**
 * Bind a monitor token to a Launchpad OUTPUT port and enter programmer mode on
 * it (the monitor now owns every LED). Idempotent for the same token+port.
 * Returns false when: no access, the port id doesn't resolve, or the port is
 * already claimed by a different consumer (LED-ownership conflict).
 */
export function bindMonitor(token: string, outputId: string): boolean {
  if (!access) return false;
  const existing = monitors.get(token);
  if (existing && existing.outputId === outputId) return true; // idempotent
  if (isOutputClaimed(outputId, token)) return false; // owned elsewhere
  const output = access.outputs.get(outputId) ?? null;
  if (!output) return false;
  if (existing) unbindMonitor(token); // rebinding this token to a new device
  const m: MonitorBinding = { token, outputId, output, lastRgb: new Map() };
  monitors.set(token, m);
  try {
    output.send(encodeEnterProgrammerMode());
  } catch {
    /* port vanished mid-send — the card can re-bind */
  }
  bumpStatus();
  return true;
}

/** Is a monitor token currently bound to a device? */
export function isMonitorBound(token: string): boolean {
  return monitors.has(token);
}
/** The output id a monitor token is bound to, or null. */
export function monitorOutputId(token: string): string | null {
  return monitors.get(token)?.outputId ?? null;
}

/**
 * Push a full LED frame to a monitor, diffed + batched into ONE lighting SysEx
 * (same whole-surface repaint the L/R units use). No-op if the token isn't
 * bound. Indices lit last frame but absent now are blanked.
 */
export function setMonitorFrame(token: string, frame: LaunchpadFrame): void {
  const m = monitors.get(token);
  if (!m) return;
  const { specs, nextSeen } = diffFrameSpecs(m.lastRgb, frame);
  if (specs.length === 0) return;
  m.lastRgb = nextSeen;
  try {
    m.output.send(encodeLedRgbBatch(specs));
  } catch {
    /* port vanished mid-send — onstatechange handling lives on the pair path */
  }
}

/**
 * Unbind a monitor: blank the whole surface, return the device to Live mode, and
 * release the claim. Idempotent (no-op if the token isn't bound). Called on card
 * unbind + on node delete so the device is never left stuck in programmer mode.
 */
export function unbindMonitor(token: string): void {
  const m = monitors.get(token);
  if (!m) return;
  try {
    const specs: RgbSpec[] = [];
    for (let y = 0; y < LP_HEIGHT; y++) {
      for (let x = 0; x < LP_WIDTH; x++) specs.push({ index: padNote(x, y), r: 0, g: 0, b: 0 });
    }
    for (const cc of ALL_SURFACE_CCS) specs.push({ index: cc, r: 0, g: 0, b: 0 });
    m.output.send(encodeLedRgbBatch(specs));
    m.output.send(encodeExitProgrammerMode());
  } catch {
    /* best-effort cleanup — the device may already be gone */
  }
  monitors.delete(token);
  bumpStatus();
}

// ---------------------------------------------------------------------------
// Simulated-device test hook — installs an in-memory pair so e2e/unit can drive
// pad presses + assert the LED bytes the device emitted, with no hardware + no
// Web-MIDI permission prompt. Parallel to installSimulatedGrid /
// installSimulatedMidiDevice. The handle's senders push through the SAME
// decode/dispatch path real hardware uses, and `writes(unit)` captures every
// byte run sent to each unit.
// ---------------------------------------------------------------------------

export interface SimulatedLaunchpad {
  /** Simulate a pad press at (x,y) on a unit. */
  press(unit: LaunchpadUnit, x: number, y: number, velocity?: number): void;
  /** Simulate a pad release at (x,y) on a unit. */
  release(unit: LaunchpadUnit, x: number, y: number): void;
  /** Simulate a top-row / scene / logo CC down (value>0) or up (0) on a unit. */
  cc(unit: LaunchpadUnit, cc: number, value: number): void;
  /** Every byte run the device wrote to a unit, in order. */
  writes(unit: LaunchpadUnit): Uint8Array[];
  /** The last RGB the device believes a unit's LED index holds, or null. */
  ledAt(unit: LaunchpadUnit, index: number): [number, number, number] | null;
}

let simInstalled: SimulatedLaunchpad | null = null;

/** Build a fake sysex MIDIAccess holding a Launchpad-MIDI input/output pair per
 *  unit (4 ports total), bind both units, and return a driver handle. */
export async function installSimulatedLaunchpad(): Promise<SimulatedLaunchpad> {
  if (simInstalled) return simInstalled;

  const writesByPort = new Map<string, Uint8Array[]>();
  const handlers = new Map<string, ((ev: MidiEventLike) => void) | null>();

  const inputs = new Map<string, MidiInputLike>();
  const outputs = new Map<string, MidiOutputLike>();

  const makePair = (unit: LaunchpadUnit) => {
    const inId = `pt-sim-lp-${unit}-in`;
    const outId = `pt-sim-lp-${unit}-out`;
    writesByPort.set(outId, []);
    handlers.set(inId, null);
    // IDENTICAL names for both units — exactly like two real Launchpad Mini Mk3
    // units (no per-unit discriminator in the port name). Only the port `id`
    // differs. This makes enumerateLaunchpadPorts' by-index pairing the only way
    // to tell the units apart (and guards the identical-name regression).
    const input: MidiInputLike = {
      id: inId,
      name: `LPMiniMK3 MIDI In`,
      manufacturer: 'Focusrite - Novation',
      state: 'connected',
      get onmidimessage() {
        return handlers.get(inId) ?? null;
      },
      set onmidimessage(h) {
        handlers.set(inId, h);
      },
    };
    const output: MidiOutputLike = {
      id: outId,
      name: `LPMiniMK3 MIDI Out`,
      manufacturer: 'Focusrite - Novation',
      state: 'connected',
      send(d: number[] | Uint8Array) {
        writesByPort.get(outId)!.push(d instanceof Uint8Array ? d.slice() : new Uint8Array(d));
      },
    };
    inputs.set(inId, input);
    outputs.set(outId, output);
    return { inId, outId };
  };

  const L = makePair('L');
  const R = makePair('R');

  const fake: MidiFullAccessLike = { inputs, outputs, onstatechange: null };
  access = fake;
  connectStarted = true;
  connectFailed = false;

  bindUnit('L', L.inId, L.outId);
  bindUnit('R', R.inId, R.outId);

  const feed = (inId: string, bytes: number[]) => {
    const h = handlers.get(inId);
    if (h) h({ data: new Uint8Array(bytes), timeStamp: 0 });
  };
  const inIdFor = (unit: LaunchpadUnit) => (unit === 'L' ? L.inId : R.inId);
  const outIdFor = (unit: LaunchpadUnit) => (unit === 'L' ? L.outId : R.outId);

  simInstalled = {
    press: (unit, x, y, velocity = 100) => feed(inIdFor(unit), [0x90, padNote(x, y), velocity & 0x7f]),
    release: (unit, x, y) => feed(inIdFor(unit), [0x80, padNote(x, y), 0]),
    cc: (unit, cc, value) => feed(inIdFor(unit), [0xb0, cc & 0x7f, value & 0x7f]),
    writes: (unit) => (writesByPort.get(outIdFor(unit)) ?? []).slice(),
    ledAt: (unit, index) => {
      const k = units[unit].lastRgb.get(index);
      if (!k) return null;
      const [r, g, b] = k.split(',').map((n) => parseInt(n, 10));
      return [r, g, b];
    },
  };
  return simInstalled;
}

/**
 * Single-unit simulated Launchpad — installs an in-memory access holding ONE
 * Launchpad-MIDI port pair and binds it to the L slot (the single-unit
 * deployment: one device, the control layer flips its role). Parallel to
 * installSimulatedLaunchpad, but with a single port + L-only senders. The
 * control layer routes presses to handleL/handleR by the active VIEW (not the
 * unit tag), so every sim event is sent on unit 'L'.
 */
export async function installSimulatedLaunchpadSingle(): Promise<SimulatedLaunchpad> {
  if (simInstalled) return simInstalled;

  const writesByPort = new Map<string, Uint8Array[]>();
  const handlers = new Map<string, ((ev: MidiEventLike) => void) | null>();
  const inputs = new Map<string, MidiInputLike>();
  const outputs = new Map<string, MidiOutputLike>();

  const inId = 'pt-sim-lp-single-in';
  const outId = 'pt-sim-lp-single-out';
  writesByPort.set(outId, []);
  handlers.set(inId, null);
  const input: MidiInputLike = {
    id: inId,
    name: `LPMiniMK3 MIDI In`,
    manufacturer: 'Focusrite - Novation',
    state: 'connected',
    get onmidimessage() {
      return handlers.get(inId) ?? null;
    },
    set onmidimessage(h) {
      handlers.set(inId, h);
    },
  };
  const output: MidiOutputLike = {
    id: outId,
    name: `LPMiniMK3 MIDI Out`,
    manufacturer: 'Focusrite - Novation',
    state: 'connected',
    send(d: number[] | Uint8Array) {
      writesByPort.get(outId)!.push(d instanceof Uint8Array ? d.slice() : new Uint8Array(d));
    },
  };
  inputs.set(inId, input);
  outputs.set(outId, output);

  const fake: MidiFullAccessLike = { inputs, outputs, onstatechange: null };
  access = fake;
  connectStarted = true;
  connectFailed = false;

  // Bind the lone device to the L slot — the single-unit deployment.
  bindUnit('L', inId, outId);

  const feed = (bytes: number[]) => {
    const h = handlers.get(inId);
    if (h) h({ data: new Uint8Array(bytes), timeStamp: 0 });
  };

  simInstalled = {
    // The lone device is the L slot; all sim events flow on unit 'L'. (The unit
    // tag passed by callers is ignored here — there is only one device.)
    press: (_unit, x, y, velocity = 100) => feed([0x90, padNote(x, y), velocity & 0x7f]),
    release: (_unit, x, y) => feed([0x80, padNote(x, y), 0]),
    cc: (_unit, cc, value) => feed([0xb0, cc & 0x7f, value & 0x7f]),
    writes: () => (writesByPort.get(outId) ?? []).slice(),
    ledAt: (_unit, index) => {
      const k = units.L.lastRgb.get(index);
      if (!k) return null;
      const [r, g, b] = k.split(',').map((n) => parseInt(n, 10));
      return [r, g, b];
    },
  };
  return simInstalled;
}

/** Reset ALL singleton state — test isolation between cases. */
export function __test_resetLaunchpad(): void {
  for (const unit of ['L', 'R'] as const) {
    const u = units[unit];
    if (u.input) u.input.onmidimessage = null;
    units[unit] = newUnit();
  }
  access = null;
  connectStarted = false;
  connectFailed = false;
  simInstalled = null;
  keyListeners.clear();
  monitors.clear();
}

/** Inject a fake access directly (advanced tests / pairing-flow tests). */
export function __test_setAccess(fake: MidiFullAccessLike | null): void {
  access = fake;
  connectStarted = !!fake;
  connectFailed = false;
}

/** Read the count of addressable LEDs on a unit (for tests / parity). */
export const LAUNCHPAD_CELLS = LP_CELLS;
