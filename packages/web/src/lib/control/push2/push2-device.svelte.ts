// packages/web/src/lib/control/push2/push2-device.svelte.ts
//
// Ableton Push 2 — Web-MIDI device singleton (the MIDI half of the Push
// integration; the 960×160 WebUSB display is DEFERRED to Phase 2). Cloned from
// launchpad-device: ONE sysex-capable `navigator.requestMIDIAccess({sysex:true})`
// behind the on-demand permission flow (no eager prompt), hot-plug via
// `onstatechange`, a port matcher for the Push 2's User port, User-mode enter on
// bind, a diffed LED writer, an `onKey` decoded-event stream, and an
// `installSimulatedPush2` in-memory seam so e2e/unit drive pad/CC presses + assert
// emitted bytes with no hardware + no permission prompt.
//
// WHY ITS OWN ACCESS: exactly like the Launchpad + Electra — midi-learn opens a
// `sysex:false` access and routes every inbound CC/Note into learn dispatch, so
// a Push pad press would be mis-routed there; User mode + LED SysEx need
// `sysex:true`. One dedicated sysex access PER controller family.
//
// All I/O is PER-USER LOCAL. The clip-player's clip/playing state syncs via
// Y.Doc elsewhere (through the Launchpad control brain the Push drives); this
// file never touches the synced store. LED frames are local render state.
//
// The byte protocol lives in ./push2-sysex.ts (PURE, golden-vector tested); this
// file is the lifecycle + stream plumbing around it.

import type {
  MidiInputLike,
  MidiEventLike,
} from '$lib/audio/modules/midi-cv-buddy';
import type { MidiOutputLike } from '$lib/audio/modules/midi-out-buddy';
import { webMidiAvailable } from '$lib/audio/modules/midi-cv-buddy';
import type { MidiFullAccessLike } from '$lib/control/launchpad/launchpad-device.svelte';
import {
  encodeEnterUserMode,
  encodeExitUserMode,
  encodePadColor,
  encodeButtonLed,
  decodePush2Message,
  type Push2RxEvent,
} from './push2-sysex';
import type { Push2LedSpec } from './push2-map';

// ---------------------------------------------------------------------------
// Singleton state
// ---------------------------------------------------------------------------
let access: MidiFullAccessLike | null = null;
let connectStarted = false;
let connectFailed = false;

interface Binding {
  inputId: string | null;
  outputId: string | null;
  input: MidiInputLike | null;
  output: MidiOutputLike | null;
  /** Last value we sent per LED addr ("p<note>" | "b<cc>") — the diff source. */
  lastSent: Map<string, number>;
}
const unit: Binding = { inputId: null, outputId: null, input: null, output: null, lastSent: new Map() };

const keyListeners = new Set<(e: Push2RxEvent) => void>();

// Reactive status counter — bump to notify Svelte UI of connect/bind changes.
let statusVersion = $state(0);
export function statusRune(): number {
  return statusVersion;
}
function bumpStatus(): void {
  statusVersion++;
}

// ---------------------------------------------------------------------------
// Capability + status
// ---------------------------------------------------------------------------

/** Is Web MIDI available (Chromium)? Gates the whole feature so Safari/Firefox +
 *  CI degrade cleanly (no hardware). */
export function midiAvailable(): boolean {
  return webMidiAvailable();
}
/** True once a sysex access is held (real or simulated). */
export function hasAccess(): boolean {
  return access !== null;
}
/** Is the Push bound (input + output)? */
export function isBound(): boolean {
  return !!(unit.input && unit.output);
}

// ---------------------------------------------------------------------------
// Connect (acquire sysex access) — lazy, idempotent, gesture-gated.
// ---------------------------------------------------------------------------

/**
 * Acquire a sysex-capable MIDIAccess. MUST be called from a user gesture.
 * Returns false (never throws) when Web MIDI is unavailable, the user denies, or
 * the request fails. Idempotent.
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
    dumpPortNames();
    access.onstatechange = () => {
      reattachBoundPort();
      bumpStatus();
    };
    bumpStatus();
    return true;
  } catch {
    connectFailed = true;
    return false;
  }
}

/** Console-dump every MIDI port name on connect. Windows/WinMM names both Push
 *  interfaces identically ("Ableton Push 2" with a MIDIIN2/MIDIOUT2 prefix on
 *  the second), so a name/number-based matcher must be verified against the REAL
 *  device (memory launchpad-windows-dual-port) — this dump is the owner's first
 *  diagnostic for a hardware MIDI bug. */
function dumpPortNames(): void {
  if (!access) return;
  try {
    const ins = [...access.inputs.values()].map((p) => p.name ?? p.id);
    const outs = [...access.outputs.values()].map((p) => p.name ?? p.id);
    console.info('[push2] MIDI inputs:', ins);
    console.info('[push2] MIDI outputs:', outs);
  } catch {
    /* non-fatal diagnostic */
  }
}

// ---------------------------------------------------------------------------
// Port matching + enumeration.
// ---------------------------------------------------------------------------

/** Is a port name a Push 2 candidate? Matches the family loosely
 *  (case-insensitive "push 2" / "push2") and EXCLUDES the Live/control-surface
 *  port (name self-identifies as "live") — User mode + pad data live on the User
 *  port. On macOS CoreMIDI the ports are named "Ableton Push 2 User Port" /
 *  "… Live Port" so this name-level exclusion suffices. PURE. */
export function isPush2PortName(name: string | null | undefined): boolean {
  const n = (name ?? '').toLowerCase();
  const isPush = n.includes('push 2') || n.includes('push2');
  if (!isPush) return false;
  if (n.includes('live')) return false; // the control-surface port, not User mode
  return true;
}

/** Does this port name carry a Windows/WinMM secondary-interface marker
 *  ("MIDIIN2 (…)" / "MIDIOUT2 (…)")? On Windows the Push exposes two interfaces
 *  under the same base name; the User/pad-data port is the numbered second one
 *  (mirrors the Launchpad Mini Mk3 dual-port shape — memory
 *  launchpad-windows-dual-port). macOS/Linux use explicit names with no numeric
 *  marker → false. PURE. */
export function hasSecondaryInterfaceMarker(name: string | null | undefined): boolean {
  return /midi\s*(in|out)\s*[2-9]/i.test(name ?? '');
}

/** A Push 2 candidate input/output PAIR. */
export interface Push2Port {
  inputId: string;
  outputId: string;
  name: string;
}

/**
 * Enumerate the Push 2 User port as an input/output pair (device order). Applies
 * the Windows numbered-interface set-level drop (keep ONLY the numbered siblings
 * when any exist — the un-numbered one is the Live/control port). Returns the
 * FIRST candidate pair (one Push per host). Reads the access maps only.
 */
export function enumeratePush2Ports(): Push2Port[] {
  if (!access) return [];
  let ins: MidiInputLike[] = [];
  for (const inp of access.inputs.values()) if (isPush2PortName(inp.name)) ins.push(inp);
  let outs: MidiOutputLike[] = [];
  for (const o of access.outputs.values()) if (isPush2PortName(o.name)) outs.push(o);
  if (ins.some((p) => hasSecondaryInterfaceMarker(p.name))) {
    ins = ins.filter((p) => hasSecondaryInterfaceMarker(p.name));
  }
  if (outs.some((p) => hasSecondaryInterfaceMarker(p.name))) {
    outs = outs.filter((p) => hasSecondaryInterfaceMarker(p.name));
  }
  const n = Math.min(ins.length, outs.length);
  const out: Push2Port[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ inputId: ins[i].id, outputId: outs[i].id, name: ins[i].name ?? outs[i].name ?? ins[i].id });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Bind / unbind + User-mode handshake.
// ---------------------------------------------------------------------------

/**
 * Bind the Push to a concrete input/output pair and enter User mode. Idempotent
 * for the same ids. Returns false if the ids don't resolve in the current access.
 */
export function bind(inputId: string, outputId: string): boolean {
  if (!access) return false;
  const input = access.inputs.get(inputId) ?? null;
  const output = access.outputs.get(outputId) ?? null;
  if (!input || !output) return false;
  const prevInput = unit.input;
  unit.inputId = inputId;
  unit.outputId = outputId;
  unit.input = input;
  unit.output = output;
  unit.lastSent.clear();
  input.onmidimessage = (ev: MidiEventLike) => handleInbound(ev);
  if (prevInput && prevInput !== input) prevInput.onmidimessage = null;
  enterUserMode();
  bumpStatus();
  return true;
}

/** Auto-bind the first enumerated Push 2 pair, if any. Returns the bound pair. */
export function autoBind(): Push2Port | null {
  const ports = enumeratePush2Ports();
  if (ports.length === 0) return null;
  const p = ports[0];
  return bind(p.inputId, p.outputId) ? p : null;
}

/** Re-resolve the bound port objects from the current access after a hot-plug. */
function reattachBoundPort(): void {
  if (!access || !unit.inputId || !unit.outputId) return;
  const input = access.inputs.get(unit.inputId) ?? null;
  const output = access.outputs.get(unit.outputId) ?? null;
  if (input && input !== unit.input) {
    unit.input = input;
    input.onmidimessage = (ev: MidiEventLike) => handleInbound(ev);
  }
  if (output && output !== unit.output) {
    unit.output = output;
    unit.lastSent.clear();
    enterUserMode();
  }
}

function sendRaw(bytes: Uint8Array): void {
  if (!unit.output) return;
  try {
    unit.output.send(bytes);
  } catch {
    /* the port vanished mid-send — onstatechange will re-resolve */
  }
}

export function enterUserMode(): void {
  sendRaw(encodeEnterUserMode());
}
export function exitUserMode(): void {
  sendRaw(encodeExitUserMode());
}

/** Unbind: blank the surface, return the Push to Live mode, detach the input. */
export function unbind(): void {
  if (unit.output) {
    clear();
    exitUserMode();
  }
  if (unit.input) unit.input.onmidimessage = null;
  unit.inputId = null;
  unit.outputId = null;
  unit.input = null;
  unit.output = null;
  unit.lastSent.clear();
  bumpStatus();
}

// ---------------------------------------------------------------------------
// Inbound dispatch
// ---------------------------------------------------------------------------
function handleInbound(ev: MidiEventLike): void {
  const data = ev.data;
  if (data.length < 1) return;
  if (data[0] === 0xf0) return; // a SysEx echo — not a key event
  const decoded = decodePush2Message(data);
  if (!decoded) return;
  for (const cb of keyListeners) cb(decoded);
}

/** Subscribe to decoded Push key/CC events. Returns unsubscribe. */
export function onKey(cb: (e: Push2RxEvent) => void): () => void {
  keyListeners.add(cb);
  return () => keyListeners.delete(cb);
}

// ---------------------------------------------------------------------------
// LED output — diffed writes via the codec.
// ---------------------------------------------------------------------------
const padKey = (note: number): string => `p${note}`;
const btnKey = (cc: number): string => `b${cc}`;

/**
 * Push a full set of LED specs (from push2FrameToLeds), diffed against the last
 * send so only CHANGED LEDs are emitted, and blank any pad/button that was lit
 * last frame but is absent now. No-op if unbound.
 */
export function setLeds(specs: Push2LedSpec[]): void {
  if (!unit.output) return;
  const nextSeen = new Map<string, number>();
  const toSend: Uint8Array[] = [];
  for (const s of specs) {
    if (s.kind === 'pad') {
      const k = padKey(s.note);
      nextSeen.set(k, s.palette);
      if (unit.lastSent.get(k) !== s.palette) toSend.push(encodePadColor(s.note, s.palette));
    } else {
      const k = btnKey(s.cc);
      nextSeen.set(k, s.value);
      if (unit.lastSent.get(k) !== s.value) toSend.push(encodeButtonLed(s.cc, s.value));
    }
  }
  // Blank LEDs lit last frame but gone now.
  for (const [k, v] of unit.lastSent) {
    if (nextSeen.has(k) || v === 0) continue;
    nextSeen.set(k, 0);
    if (k[0] === 'p') toSend.push(encodePadColor(Number(k.slice(1)), 0));
    else toSend.push(encodeButtonLed(Number(k.slice(1)), 0));
  }
  unit.lastSent = nextSeen;
  for (const b of toSend) sendRaw(b);
}

/** Blank every addressable LED (all 64 pads + every touched button). */
export function clear(): void {
  if (!unit.output) return;
  const toSend: Uint8Array[] = [];
  for (let note = 36; note <= 99; note++) toSend.push(encodePadColor(note, 0));
  for (const [k] of unit.lastSent) {
    if (k[0] === 'b') toSend.push(encodeButtonLed(Number(k.slice(1)), 0));
  }
  unit.lastSent.clear();
  for (const b of toSend) sendRaw(b);
}

// ---------------------------------------------------------------------------
// Simulated-device test hook — an in-memory Push so e2e/unit can drive pad/CC
// presses + assert emitted bytes, with no hardware + no Web-MIDI prompt.
// ---------------------------------------------------------------------------
export interface SimulatedPush2 {
  /** Simulate a pad press at (x,y). */
  press(x: number, y: number, velocity?: number): void;
  /** Simulate a pad release at (x,y). */
  release(x: number, y: number): void;
  /** Simulate a CC (button press/release or encoder tick) — raw value. */
  cc(cc: number, value: number): void;
  /** Every byte run the device wrote, in order. */
  writes(): Uint8Array[];
  /** The last value the device believes an LED addr holds, or null. */
  ledAt(addr: string): number | null;
}

let simInstalled: SimulatedPush2 | null = null;

/** Install a fake sysex MIDIAccess holding ONE Push-2 User port pair, bind it,
 *  and return a driver handle. Parallel to installSimulatedLaunchpadSingle. */
export async function installSimulatedPush2(): Promise<SimulatedPush2> {
  if (simInstalled) return simInstalled;

  const writes: Uint8Array[] = [];
  const handlers = new Map<string, ((ev: MidiEventLike) => void) | null>();
  const inputs = new Map<string, MidiInputLike>();
  const outputs = new Map<string, MidiOutputLike>();

  const inId = 'pt-sim-push2-in';
  const outId = 'pt-sim-push2-out';
  handlers.set(inId, null);
  const input: MidiInputLike = {
    id: inId,
    name: 'Ableton Push 2 User Port',
    manufacturer: 'Ableton AG',
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
    name: 'Ableton Push 2 User Port',
    manufacturer: 'Ableton AG',
    state: 'connected',
    send(d: number[] | Uint8Array) {
      writes.push(d instanceof Uint8Array ? d.slice() : new Uint8Array(d));
    },
  };
  inputs.set(inId, input);
  outputs.set(outId, output);

  access = { inputs, outputs, onstatechange: null };
  connectStarted = true;
  connectFailed = false;

  bind(inId, outId);

  const feed = (bytes: number[]) => {
    const h = handlers.get(inId);
    if (h) h({ data: new Uint8Array(bytes), timeStamp: 0 });
  };

  simInstalled = {
    press: (x, y, velocity = 100) => feed([0x90, 36 + y * 8 + x, velocity & 0x7f]),
    release: (x, y) => feed([0x80, 36 + y * 8 + x, 0]),
    cc: (cc, value) => feed([0xb0, cc & 0x7f, value & 0x7f]),
    writes: () => writes.slice(),
    ledAt: (addr) => (unit.lastSent.has(addr) ? unit.lastSent.get(addr)! : null),
  };
  return simInstalled;
}

/** Reset ALL singleton state — test isolation between cases. */
export function __test_resetPush2(): void {
  if (unit.input) unit.input.onmidimessage = null;
  unit.inputId = null;
  unit.outputId = null;
  unit.input = null;
  unit.output = null;
  unit.lastSent.clear();
  access = null;
  connectStarted = false;
  connectFailed = false;
  simInstalled = null;
  keyListeners.clear();
}
