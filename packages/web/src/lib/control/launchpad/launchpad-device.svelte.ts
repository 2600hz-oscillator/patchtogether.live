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

/** Is a port name a Launchpad Mini Mk3 **MIDI** port (not the DAW port)? The
 *  owner confirmed the port is named like `LPMiniMK3 MIDI`. We match the
 *  family loosely (case-insensitive `launchpad`/`lpmini`/`mk3`) AND require the
 *  word "MIDI" while EXCLUDING "DAW" — programmer mode lives on the MIDI port. */
export function isLaunchpadMidiPortName(name: string | null | undefined): boolean {
  const n = (name ?? '').toLowerCase();
  const isLaunchpad = n.includes('launchpad') || n.includes('lpmini') || n.includes('lp mini') || n.includes('mk3');
  if (!isLaunchpad) return false;
  if (n.includes('daw')) return false; // the DAW port — not programmer mode
  return n.includes('midi') || (!n.includes('daw')); // prefer explicit MIDI, accept the non-DAW one
}

/**
 * Enumerate the Launchpad **MIDI** ports as input/output PAIRS (matched by a
 * shared name stem). Each entry can be lit + pressed during pairing. Returns []
 * when no access / no Launchpad ports. PURE-ish (reads the access map only).
 */
export function enumerateLaunchpadPorts(): LaunchpadPort[] {
  if (!access) return [];
  const out: LaunchpadPort[] = [];
  for (const inp of access.inputs.values()) {
    if (!isLaunchpadMidiPortName(inp.name)) continue;
    // Pair with the output whose name best matches this input's name.
    const stem = portStem(inp.name);
    let bestOut: MidiOutputLike | null = null;
    let bestScore = -1;
    for (const o of access.outputs.values()) {
      if (!isLaunchpadMidiPortName(o.name)) continue;
      const score = nameMatchScore(stem, portStem(o.name));
      if (score > bestScore) {
        bestScore = score;
        bestOut = o;
      }
    }
    if (bestOut) {
      out.push({ inputId: inp.id, outputId: bestOut.id, name: inp.name ?? bestOut.name ?? inp.id });
    }
  }
  return out;
}

/** Strip an "In"/"Out"/"MIDI" suffix so an input + output of the same unit
 *  share a stem (e.g. "LPMiniMK3 MIDI In" / "… Out" → "lpminimk3 midi"). */
function portStem(name: string | null | undefined): string {
  return (name ?? '')
    .toLowerCase()
    .replace(/\b(in|out|input|output|port)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
function nameMatchScore(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 100;
  // longest shared prefix length as a coarse score
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
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
  // Detach a prior input on this unit before re-wiring.
  if (u.input && u.input !== input) u.input.onmidimessage = null;
  u.inputId = inputId;
  u.outputId = outputId;
  u.input = input;
  u.output = output;
  u.lastRgb.clear();
  input.onmidimessage = (ev: MidiEventLike) => handleInbound(unit, ev);
  enterProgrammerMode(unit);
  bumpStatus();
  return true;
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

/**
 * Push a full LED frame to a unit, diffed against the last frame so only
 * CHANGED LEDs are emitted, batched into ONE lighting SysEx (the Mini accepts a
 * whole-surface repaint, up to ~81 specs, per message). Indices that were lit
 * last frame but are absent this frame are blanked (RGB 0,0,0).
 */
export function setFrame(unit: LaunchpadUnit, frame: LaunchpadFrame): void {
  const u = units[unit];
  if (!u.output) return;
  const specs: RgbSpec[] = [];
  const nextSeen = new Map<number, string>();
  for (const [index, [r, g, b]] of frame.leds) {
    const key = rgbKey(r, g, b);
    nextSeen.set(index, key);
    if (u.lastRgb.get(index) !== key) {
      specs.push({ index, r, g, b });
    }
  }
  // Blank LEDs that were lit last frame but are gone now.
  for (const index of u.lastRgb.keys()) {
    if (!nextSeen.has(index)) {
      specs.push({ index, r: 0, g: 0, b: 0 });
      nextSeen.set(index, rgbKey(0, 0, 0));
    }
  }
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
  for (const cc of [91, 92, 93, 94, 95, 96, 97, 98, 99, 89, 79, 69, 59, 49, 39, 29, 19]) {
    specs.push({ index: cc, r: 0, g: 0, b: 0 });
  }
  units[unit].lastRgb.clear();
  for (const s of specs) units[unit].lastRgb.set(s.index, rgbKey(0, 0, 0));
  sendRaw(unit, encodeLedRgbBatch(specs));
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
    const input: MidiInputLike = {
      id: inId,
      name: `LPMiniMK3 ${unit} MIDI In`,
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
      name: `LPMiniMK3 ${unit} MIDI Out`,
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
}

/** Inject a fake access directly (advanced tests / pairing-flow tests). */
export function __test_setAccess(fake: MidiFullAccessLike | null): void {
  access = fake;
  connectStarted = !!fake;
  connectFailed = false;
}

/** Read the count of addressable LEDs on a unit (for tests / parity). */
export const LAUNCHPAD_CELLS = LP_CELLS;
