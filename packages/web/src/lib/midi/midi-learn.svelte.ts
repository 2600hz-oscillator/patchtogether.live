// packages/web/src/lib/midi/midi-learn.svelte.ts
//
// MIDI Learn singleton. One shared `navigator.requestMIDIAccess()` for
// every Fader / Knob in the rack; right-click → "MIDI Learn" → wiggle a
// CC on the connected controller → permanent binding. Subsequent CC
// messages drive the bound param via the bound `onchange`.
//
// Persistence: localStorage (per-machine). Rationale: MIDI controllers
// are personal — syncing my Launchpad mapping over Yjs would clobber my
// collaborator's Push mapping. Keyed under PT_MIDI_BINDINGS_KEY.
//
// Reuses MidiAccessLike / MidiInputLike / MidiEventLike + webMidiAvailable
// from midi-cv-buddy so a test can inject a fake access.

import type {
  MidiAccessLike,
  MidiInputLike,
  MidiEventLike,
} from '$lib/audio/modules/midi-cv-buddy';
import { webMidiAvailable } from '$lib/audio/modules/midi-cv-buddy';

const STORAGE_KEY = 'pt.midi-bindings.v1';

/** A learned MIDI CC → param binding. */
export interface MidiBinding {
  /** Composite "moduleId:paramId" — unique per knob on the rack. */
  key: string;
  /** MIDI channel 0..15 the CC arrived on. */
  channel: number;
  /** CC number 0..127. */
  cc: number;
  /** When the binding was learned (epoch ms). For UI "recently learned"
   *  hint + future least-recently-used eviction if the binding list grows
   *  unwieldy. */
  learnedAt: number;
}

/** The shape callers pass to beginLearn — everything the singleton needs
 *  to (a) capture the next CC and bind it to this knob, and (b) route
 *  subsequent CCs back to the right setter. */
export interface LearnSpec {
  /** Node id from the patch graph. */
  moduleId: string;
  /** Param id on that node. */
  paramId: string;
  /** Knob's natural range — the CC's 0..127 value gets linearly remapped
   *  to [min, max] before being written. */
  min: number;
  max: number;
  /** The setter the Fader / Knob already uses — same signature so we just
   *  pipe the scaled value through. */
  onchange: (v: number) => void;
}

/** Compose the bindings-map key. */
export function bindingKey(moduleId: string, paramId: string): string {
  return `${moduleId}:${paramId}`;
}

/** Pure helper: map a 7-bit CC value into a knob's natural range. */
export function ccValueToParamValue(ccValue: number, min: number, max: number): number {
  const norm = Math.max(0, Math.min(127, ccValue)) / 127;
  return min + norm * (max - min);
}

/** Pure helper: parse a raw MIDI message; returns null if it isn't a CC. */
export function parseCcMessage(data: Uint8Array): { channel: number; cc: number; value: number } | null {
  if (data.length < 3) return null;
  const status = data[0]!;
  // 0xB0..0xBF = Control Change.
  if ((status & 0xf0) !== 0xb0) return null;
  return {
    channel: status & 0x0f,
    cc: data[1]!,
    value: data[2]!,
  };
}

// ---------------- Internal singleton state ----------------

let access: MidiAccessLike | null = null;
let connectStarted = false;
let connectFailed = false;

/** Map of bindingKey → binding metadata + live setter (setter is registered
 *  by the Fader / Knob via `registerSetter`; if no setter is registered
 *  for a binding, CCs land silently). */
interface ActiveBinding extends MidiBinding {
  setter?: { min: number; max: number; onchange: (v: number) => void };
}
const bindings = $state<Map<string, ActiveBinding>>(new Map());

/** Monotonic version stamped on every binding add/remove. Components read it
 *  via `bindingsRune()` inside a `$derived` so a binding captured by the
 *  engine (e.g. when an injected/real CC completes a learn) reactively
 *  surfaces the bound-state badge — not just bindings created by a local
 *  click handler. Bumped by `touchBindings()`. */
let bindingsVersion = $state(0);
function touchBindings(): void { bindingsVersion++; }

/** Reactive getter — read this inside a `$derived` to re-evaluate whenever
 *  any binding is added or removed. */
export function bindingsRune(): number { return bindingsVersion; }

/** Currently-active learn request (null when not learning). Reactive so
 *  the Fader / Knob with `spec.moduleId/paramId` matching can show a
 *  pulsing border. */
let learnSpec = $state<LearnSpec | null>(null);

// ---------------- Persistence ----------------

function loadFromStorage(): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as MidiBinding[];
    if (!Array.isArray(parsed)) return;
    for (const b of parsed) {
      if (typeof b?.key === 'string'
          && Number.isFinite(b.channel)
          && Number.isFinite(b.cc)) {
        bindings.set(b.key, { ...b });
      }
    }
    touchBindings();
  } catch {
    // Corrupt storage — ignore. A fresh learn overwrites.
  }
}

function saveToStorage(): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    const arr: MidiBinding[] = [];
    for (const b of bindings.values()) {
      arr.push({ key: b.key, channel: b.channel, cc: b.cc, learnedAt: b.learnedAt });
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(arr));
  } catch {
    // QuotaExceeded etc — non-fatal.
  }
}

// Boot.
if (typeof window !== 'undefined') loadFromStorage();

// ---------------- Connection lifecycle ----------------

/** Lazy MIDIAccess request. Idempotent — second call is a no-op while
 *  the first is in flight. Returns true on success, false otherwise.
 *  Test path: inject a fake MidiAccessLike via `__test_setAccess`. */
export async function connect(): Promise<boolean> {
  if (access) return true;
  if (connectFailed) return false;
  if (connectStarted) {
    // Spin briefly for the in-flight request.
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
    const a = await (navigator as any).requestMIDIAccess({ sysex: false });
    access = a as MidiAccessLike;
    attachAllInputs();
    access.onstatechange = (ev) => {
      // Re-attach when a new device shows up.
      if (ev.port.state === 'connected') attachInput(ev.port);
    };
    return true;
  } catch {
    connectFailed = true;
    return false;
  }
}

function attachAllInputs(): void {
  if (!access) return;
  for (const inp of access.inputs.values()) attachInput(inp);
}

function attachInput(inp: MidiInputLike): void {
  inp.onmidimessage = handleMidi;
}

// ---------------- Incoming CC dispatch ----------------

function handleMidi(ev: MidiEventLike): void {
  const parsed = parseCcMessage(ev.data);
  if (!parsed) return;

  // 1. Learn mode wins — capture the next CC.
  if (learnSpec) {
    const spec = learnSpec;
    const key = bindingKey(spec.moduleId, spec.paramId);
    // If this knob already had a binding, overwrite it.
    const newBinding: ActiveBinding = {
      key,
      channel: parsed.channel,
      cc: parsed.cc,
      learnedAt: Date.now(),
      setter: { min: spec.min, max: spec.max, onchange: spec.onchange },
    };
    bindings.set(key, newBinding);
    touchBindings();
    saveToStorage();
    learnSpec = null;
    // Apply the captured value immediately so the user sees the knob jump.
    spec.onchange(ccValueToParamValue(parsed.value, spec.min, spec.max));
    return;
  }

  // 2. Otherwise dispatch to whichever binding (if any) owns this CC.
  for (const b of bindings.values()) {
    if (b.channel === parsed.channel && b.cc === parsed.cc && b.setter) {
      b.setter.onchange(ccValueToParamValue(parsed.value, b.setter.min, b.setter.max));
    }
  }
}

// ---------------- Public API ----------------

/** Enter learn mode for one knob. Cancels any in-flight learn first.
 *  Auto-`connect()`s if MIDIAccess hasn't been requested yet. */
export async function beginLearn(spec: LearnSpec): Promise<void> {
  await connect();
  learnSpec = spec;
  // Also register the setter so this knob continues to respond after the
  // learn captures (and on future page loads where bindings rehydrate
  // without setters until a card mounts).
  const key = bindingKey(spec.moduleId, spec.paramId);
  const existing = bindings.get(key);
  if (existing) {
    existing.setter = { min: spec.min, max: spec.max, onchange: spec.onchange };
  }
}

/** Cancel an in-flight learn. */
export function cancelLearn(): void {
  learnSpec = null;
}

/** Register / refresh the live setter for a knob. Called by Fader / Knob
 *  on mount so a binding that was loaded from localStorage starts driving
 *  the knob as soon as the card mounts. Idempotent. */
export function registerSetter(moduleId: string, paramId: string, args: {
  min: number; max: number; onchange: (v: number) => void;
}): void {
  const key = bindingKey(moduleId, paramId);
  const b = bindings.get(key);
  if (b) {
    b.setter = { ...args };
  }
}

/** Drop the live setter (called on Fader / Knob unmount). The persisted
 *  binding stays — re-mounting the card re-registers its setter. */
export function unregisterSetter(moduleId: string, paramId: string): void {
  const key = bindingKey(moduleId, paramId);
  const b = bindings.get(key);
  if (b) b.setter = undefined;
}

/** Look up the persisted binding for a knob (no setter info). */
export function getBinding(moduleId: string, paramId: string): MidiBinding | undefined {
  const b = bindings.get(bindingKey(moduleId, paramId));
  return b ? { key: b.key, channel: b.channel, cc: b.cc, learnedAt: b.learnedAt } : undefined;
}

/** Remove a binding entirely. */
export function clearBinding(moduleId: string, paramId: string): void {
  bindings.delete(bindingKey(moduleId, paramId));
  touchBindings();
  saveToStorage();
}

/** Reactive getter for the in-flight learn spec — Fader / Knob reads this
 *  to know whether to show the pulsing border. */
export function learnSpecRune(): LearnSpec | null {
  return learnSpec;
}

/** Reactive getter for the bindings map — exposed for the future
 *  "show all learned bindings" UI. */
export function allBindings(): ReadonlyMap<string, MidiBinding> {
  return bindings;
}

// ---------------- Performance bundle export / import ----------------
//
// The Save/Load Local Performance feature bundles these device-agnostic CC
// maps so a "complete track" re-binds its MIDI Learn knobs on reload. Bindings
// are keyed by `moduleId:paramId` (not device), so importing them re-arms the
// CCs for this performance's modules across whatever controller is connected.

/** Snapshot the current bindings as plain export records (no live setters). */
export function exportBindings(): MidiBinding[] {
  const arr: MidiBinding[] = [];
  for (const b of bindings.values()) {
    arr.push({ key: b.key, channel: b.channel, cc: b.cc, learnedAt: b.learnedAt });
  }
  return arr;
}

/**
 * Merge imported bindings into the live set + persist. Bundle wins per `key`
 * (this performance's modules); other-patch bindings are preserved (design
 * risk #6 — don't clobber the user's unrelated mappings). Existing live
 * setters are kept where the key already had one so a mounted card keeps
 * driving without a remount. */
export function importBindings(incoming: MidiBinding[]): void {
  for (const b of incoming) {
    if (typeof b?.key !== 'string' || !Number.isFinite(b.channel) || !Number.isFinite(b.cc)) {
      continue;
    }
    const prev = bindings.get(b.key);
    bindings.set(b.key, {
      key: b.key,
      channel: b.channel,
      cc: b.cc,
      learnedAt: b.learnedAt,
      setter: prev?.setter,
    });
  }
  touchBindings();
  saveToStorage();
}

// ---------------- Test-only hooks ----------------

/** Replace the singleton's MIDIAccess with a fake. Bindings + learn state
 *  are preserved. Call with `null` to reset. */
export function __test_setAccess(fake: MidiAccessLike | null): void {
  access = fake;
  connectStarted = !!fake;
  connectFailed = false;
  if (fake) attachAllInputs();
}

/** Wipe in-memory bindings (does not touch localStorage). */
export function __test_clearBindings(): void {
  bindings.clear();
  touchBindings();
  learnSpec = null;
}

// ---------------- Dev-only simulated-MIDI device ----------------
//
// Installs an in-memory fake MIDIAccess so an e2e (or manual dev poke) can
// drive MIDI Learn + CC dispatch without real hardware or the Web MIDI
// permission prompt. Returns a `sendCc` that pushes a Control-Change message
// through exactly the same `handleMidi` path a real device uses, so learn
// capture + binding dispatch are exercised end-to-end.
//
// Guarded behind `import.meta.env.DEV` at the call site (Canvas.svelte) so
// the window hook is stripped from production bundles.
let simSender: ((channel: number, cc: number, value: number) => void) | null = null;

export function installSimulatedMidiDevice(): (channel: number, cc: number, value: number) => void {
  if (simSender) return simSender;
  let handler: ((ev: MidiEventLike) => void) | null = null;
  const input: MidiInputLike = {
    id: 'pt-sim-midi-0',
    name: 'PatchTogether Simulated MIDI',
    manufacturer: 'patchtogether',
    state: 'connected',
    get onmidimessage() { return handler; },
    set onmidimessage(h) { handler = h; },
  };
  const inputs = new Map<string, MidiInputLike>();
  inputs.set(input.id, input);
  const fake: MidiAccessLike = { inputs, onstatechange: null };
  // Short-circuit connect() so beginLearn() resolves immediately against the
  // fake device instead of waiting on navigator.requestMIDIAccess().
  access = fake;
  connectStarted = true;
  connectFailed = false;
  attachAllInputs();
  simSender = (channel: number, cc: number, value: number) => {
    if (!handler) return;
    handler({
      data: new Uint8Array([0xb0 | (channel & 0x0f), cc & 0x7f, value & 0x7f]),
      timeStamp: 0,
    });
  };
  return simSender;
}
