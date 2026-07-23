// packages/web/src/lib/control/push2/push2-device.svelte.ts
//
// Ableton Push 2 — Web-MIDI device singleton (the MIDI half of the Push
// integration; the 960×160 WebUSB display is DEFERRED to Phase 2). Cloned from
// launchpad-device: ONE sysex-capable `navigator.requestMIDIAccess({sysex:true})`
// behind the on-demand permission flow (no eager prompt), hot-plug via
// `onstatechange`, a port matcher for the Push 2's LIVE port, a Set-LIVE-mode
// SysEx on bind, a diffed LED writer, an `onKey` decoded-event stream, and an
// `installSimulatedPush2` in-memory seam so e2e/unit drive pad/CC presses + assert
// emitted bytes with no hardware + no permission prompt.
//
// LIVE PORT, LIVE MODE (owner-directed, verified against the Ableton push-interface
// manual + the proven greyivy/learn-push2-with-svelte WebMIDI reference): the Push
// powers up in LIVE mode, and in Live mode BOTH the pad-press input AND the pad
// LED Note-Ons flow through the LIVE port with NO per-frame SysEx. A standalone
// browser app therefore binds the LIVE port and stays in Live mode — the User port
// only carries pads/LEDs once the device is switched to User mode, which is the
// finicky/unreliable path outside Ableton Live and was the cause of dark pads on a
// fresh device. On bind we send one Set-LIVE-mode SysEx to recover a device someone
// left in User mode; nothing else needs SysEx. (Running ALONGSIDE Ableton Live via
// the User port is a possible future toggle, not Phase 1.)
//
// WHY ITS OWN ACCESS: exactly like the Launchpad + Electra — midi-learn opens a
// `sysex:false` access and routes every inbound CC/Note into learn dispatch, so
// a Push pad press would be mis-routed there; the one Set-mode SysEx needs
// `sysex:true` (the Note-On pad LEDs do NOT). One dedicated sysex access PER
// controller family.
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
  encodeSetLiveMode,
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

/**
 * Classify a Push 2 port name as its LIVE / USER role, or 'other'. On macOS
 * CoreMIDI the ports are named "Ableton Push 2 Live Port" / "… User Port"; some
 * MIDI monitors truncate to "… Push 2 L…" / "… Push 2 U…", so when the full word
 * is absent the char right after "push 2" disambiguates. On Windows both
 * interfaces share the base name (role 'other') — the numbered-interface marker
 * splits them there. PURE.
 */
export function pushPortRole(name: string | null | undefined): 'live' | 'user' | 'other' {
  const n = (name ?? '').toLowerCase();
  if (!/push ?2/.test(n)) return 'other';
  if (n.includes('live')) return 'live';
  if (n.includes('user')) return 'user';
  const m = n.match(/push ?2\s*[-\s]?([lu])/);
  if (m) return m[1] === 'l' ? 'live' : 'user';
  return 'other';
}

/** Is a port name a Push 2 candidate? Matches the family (`/push ?2/i`) and
 *  EXCLUDES the USER port (User mode is the finicky path — we drive the LIVE port
 *  in Live mode) and any IAC / virtual bus. On macOS the name-level role suffices;
 *  on Windows both interfaces share the base name (role 'other') and the
 *  numbered-interface split in selectPush2Ports picks the (non-numbered) Live one.
 *  PURE. */
export function isPush2PortName(name: string | null | undefined): boolean {
  const n = (name ?? '').toLowerCase();
  if (!/push ?2/.test(n)) return false;
  if (n.includes('iac')) return false; // never a virtual / IAC bus
  if (pushPortRole(name) === 'user') return false; // the User-mode port, not Live
  return true;
}

/** Does this port name carry a Windows/WinMM secondary-interface marker
 *  ("MIDIIN2 (…)" / "MIDIOUT2 (…)")? On Windows the Push exposes two interfaces
 *  under the same base name. INVERTED from the Launchpad discipline: here the
 *  LIVE (pad-data + LED) port is the NON-numbered base "Ableton Push 2"; the
 *  numbered second interface is the USER port → dropped. macOS/Linux use explicit
 *  names with no numeric marker → false. PURE. */
export function hasSecondaryInterfaceMarker(name: string | null | undefined): boolean {
  return /midi\s*(in|out)\s*[2-9]/i.test(name ?? '');
}

/** A Push 2 candidate input/output PAIR. */
export interface Push2Port {
  inputId: string;
  outputId: string;
  name: string;
}

/** A minimal port reference (id + name) — the pure input to selectPush2Ports. */
interface PortRef {
  id: string;
  name: string | null | undefined;
}

/**
 * PURE Push-2 LIVE-port selection over id/name lists (unit-testable without a
 * MIDIAccess). Filters to Push 2 candidates (family, not IAC, not the User port),
 * then narrows to the LIVE port across the three host name shapes:
 *   · macOS   — explicit "Ableton Push 2 Live Port": prefer role 'live'.
 *   · Windows — two same-named interfaces; LIVE is the NON-numbered "Ableton
 *               Push 2", USER is the numbered "MIDIIN2 (…)" → keep non-numbered.
 *   · Linux   — ALSA exposes "Ableton Push 2:0" (Live) / ":1" (User): prefer ":0".
 * Returns the input/output pairs (device order); the first is the bound Push.
 */
export function selectPush2Ports(ins: PortRef[], outs: PortRef[]): Push2Port[] {
  const narrow = (list: PortRef[]): PortRef[] => {
    let c = list.filter((p) => isPush2PortName(p.name));
    if (c.some((p) => pushPortRole(p.name) === 'live')) {
      c = c.filter((p) => pushPortRole(p.name) === 'live'); // macOS
    } else if (c.some((p) => hasSecondaryInterfaceMarker(p.name))) {
      c = c.filter((p) => !hasSecondaryInterfaceMarker(p.name)); // Windows — keep non-numbered
    } else if (c.some((p) => /:0\b/.test(p.name ?? '')) && c.some((p) => !/:0\b/.test(p.name ?? ''))) {
      c = c.filter((p) => /:0\b/.test(p.name ?? '')); // Linux ALSA — prefer sub-device 0
    }
    return c;
  };
  const inCand = narrow(ins);
  const outCand = narrow(outs);
  const n = Math.min(inCand.length, outCand.length);
  const out: Push2Port[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ inputId: inCand[i].id, outputId: outCand[i].id, name: inCand[i].name ?? outCand[i].name ?? inCand[i].id });
  }
  return out;
}

/**
 * Enumerate the Push 2 LIVE port as an input/output pair (device order). Reads the
 * access maps only; the selection logic is the pure selectPush2Ports.
 */
export function enumeratePush2Ports(): Push2Port[] {
  if (!access) return [];
  const ins: PortRef[] = [...access.inputs.values()].map((p) => ({ id: p.id, name: p.name }));
  const outs: PortRef[] = [...access.outputs.values()].map((p) => ({ id: p.id, name: p.name }));
  return selectPush2Ports(ins, outs);
}

// ---------------------------------------------------------------------------
// Bind / unbind + LIVE-mode handshake.
// ---------------------------------------------------------------------------

/**
 * Bind the Push to a concrete input/output pair and set LIVE mode. Idempotent for
 * the same ids. Returns false if the ids don't resolve in the current access.
 * Console-dumps the CHOSEN in/out port names so the owner can confirm the LIVE
 * port was picked (the first diagnostic for a hardware MIDI bug).
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
  setLiveMode();
  try {
    console.info('[push2] bound — IN:', input.name ?? input.id, '· OUT:', output.name ?? output.id);
  } catch {
    /* non-fatal diagnostic */
  }
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
    setLiveMode();
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

/** Put the Push in LIVE mode (default; recovers a device left in User mode). The
 *  ONLY SysEx the Phase-1 path sends — pad input + LED Note-Ons need none. */
export function setLiveMode(): void {
  sendRaw(encodeSetLiveMode());
}

/** Unbind: blank the surface, detach the input. The device stays in LIVE mode
 *  (no mode SysEx on release — it powered up in Live and we never left it). */
export function unbind(): void {
  if (unit.output) clear();
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

/** Install a fake sysex MIDIAccess holding ONE Push-2 LIVE port pair, bind it,
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
    name: 'Ableton Push 2 Live Port',
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
    name: 'Ableton Push 2 Live Port',
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
