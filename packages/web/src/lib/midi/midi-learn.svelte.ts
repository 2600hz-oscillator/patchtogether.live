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
import {
  parseNoteMessage,
  noteMatches,
  isCcBinding,
  isNoteBinding,
  bindingAddress,
  dedupeBindingsByAddress,
  type MidiBinding,
  type MidiCcBinding,
  type MidiNoteBinding,
} from './note-binding';

export {
  isCcBinding,
  isNoteBinding,
  type MidiBinding,
  type MidiCcBinding,
  type MidiNoteBinding,
} from './note-binding';

const STORAGE_KEY = 'pt.midi-bindings.v1';

/** Migrate a raw persisted/imported record to the discriminated union. Legacy
 *  records (saved before NOTE bindings existed) carry a `cc` but no `kind`, so
 *  they default to a CC binding. Returns null when the record is unusable. */
function normalizeBinding(raw: unknown): MidiBinding | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.key !== 'string' || !Number.isFinite(r.channel)) return null;
  const learnedAt = Number.isFinite(r.learnedAt) ? (r.learnedAt as number) : Date.now();
  if (r.kind === 'note') {
    if (!Number.isFinite(r.note)) return null;
    return { kind: 'note', key: r.key, channel: r.channel as number, note: r.note as number, learnedAt };
  }
  // Default (kind 'cc' or absent): require a finite cc.
  if (!Number.isFinite(r.cc)) return null;
  return { kind: 'cc', key: r.key, channel: r.channel as number, cc: r.cc as number, learnedAt };
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

/** The shape callers pass to beginNoteLearn — capture the next NOTE and bind
 *  it to this gate input / button, then route subsequent NOTE on/off events to
 *  the gate callback. `onGate(true)` on NOTE-on, `onGate(false)` on NOTE-off. */
export interface NoteLearnSpec {
  moduleId: string;
  paramId: string;
  /** Driven on every matching NOTE: true on note-on (gate high / press),
   *  false on note-off (gate low / release). */
  onGate: (high: boolean) => void;
}

/** A registered gate setter — the live callback driven by inbound NOTE events.
 *  Kept in a map DECOUPLED from `bindings` (same rationale as `setters`). */
interface GateSetter {
  onGate: (high: boolean) => void;
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

/** Map of bindingKey → binding metadata (channel/cc|note/learnedAt). The live
 *  setter is kept in a SEPARATE map (`setters` / `noteSetters` below) so the
 *  order of card-mount vs binding-population doesn't matter — see the comment on
 *  `setters` for why this decoupling is required for performance load. ONE
 *  binding per key — CC or NOTE, never both (begin*Learn overwrites). */
const bindings = $state<Map<string, MidiBinding>>(new Map());

/** Map of bindingKey → live CC setter, populated by `registerSetter` on
 *  Fader / Knob mount and read by the CC dispatch loop. Decoupled from
 *  `bindings` so a card that mounts BEFORE its binding exists (the
 *  Save/Load Local Performance order: cards mount as the patch loads,
 *  THEN `importBindings` runs) still has its setter wired the moment the
 *  binding is added. Without this split, registerSetter found no binding,
 *  silently no-op'd, and the binding was created later with a missing
 *  setter — fixing only via a manual re-learn (which went through the
 *  applyLearn path that wrote setter + binding together). */
const setters = new Map<string, { min: number; max: number; onchange: (v: number) => void }>();

/** Map of bindingKey → live GATE setter (the NOTE analogue of `setters`),
 *  populated by `registerGateSetter` on gate-input row / button mount and read
 *  by the NOTE dispatch loop. Decoupled from `bindings` for the same
 *  load-order reason. */
const noteSetters = new Map<string, GateSetter>();

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

// ---------------- One-owner-per-address invariant ----------------
//
// A binding's ADDRESS is the physical message it listens for — (channel, cc) or
// (channel, note). If two keys share one address, a single physical knob/pad
// drives BOTH params: the Electra "controls on different pages collide" bug
// (one CC was learned/imported onto multiple params across regenerates). We keep
// at-most-one binding per address, newest wins. Enforced on EVERY add path
// (learn, import, load) so dispatch naturally fires exactly one param.

/** Remove any OTHER key's binding that shares `addr` (drops its setters too).
 *  Called after a fresh learn so the just-learned control becomes the sole
 *  owner of its (channel, cc|note). Returns the number evicted. */
function evictAddressOwners(addr: string, exceptKey: string): number {
  let removed = 0;
  for (const [k, b] of bindings) {
    if (k === exceptKey) continue;
    if (bindingAddress(b) === addr) {
      bindings.delete(k);
      setters.delete(k);
      noteSetters.delete(k);
      removed++;
    }
  }
  return removed;
}

/** Collapse the whole bindings map to one owner per address (newest wins) and
 *  drop the losers' setters. Returns the number of colliding bindings removed.
 *  Used after a bulk add (import / storage load) and exposed publicly so a
 *  "repair MIDI map" action / test can repair an already-loaded colliding set. */
export function repairBindingCollisions(): number {
  const survivors = new Set(dedupeBindingsByAddress([...bindings.values()]).map((b) => b.key));
  let removed = 0;
  for (const k of [...bindings.keys()]) {
    if (!survivors.has(k)) {
      bindings.delete(k);
      setters.delete(k);
      noteSetters.delete(k);
      removed++;
    }
  }
  if (removed) touchBindings();
  return removed;
}

/** Currently-active CC learn request (null when not learning). Reactive so
 *  the Fader / Knob with `spec.moduleId/paramId` matching can show a
 *  pulsing border. */
let learnSpec = $state<LearnSpec | null>(null);

/** Currently-active NOTE learn request (null when not learning). SEPARATE from
 *  `learnSpec` so a CC arriving mid-note-learn doesn't cancel the note learn
 *  (and vice versa) — each learn captures only its own message type. */
let noteLearnSpec = $state<NoteLearnSpec | null>(null);

// ---------------- Persistence ----------------

function loadFromStorage(): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as unknown[];
    if (!Array.isArray(parsed)) return;
    for (const r of parsed) {
      const b = normalizeBinding(r);
      if (b) bindings.set(b.key, b);
    }
    // Repair a stale, colliding localStorage on boot (one owner per address).
    repairBindingCollisions();
    touchBindings();
  } catch {
    // Corrupt storage — ignore. A fresh learn overwrites.
  }
}

function saveToStorage(): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...bindings.values()]));
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
  // A single message is EITHER a CC or a NOTE (or neither). Parse both and
  // route to the matching learn/dispatch path; each learn captures only its
  // own message type so a stray CC can't cancel an in-flight note learn.
  const cc = parseCcMessage(ev.data);
  if (cc) {
    handleCc(cc);
    return;
  }
  const note = parseNoteMessage(ev.data);
  if (note) {
    handleNote(note);
    return;
  }
}

function handleCc(parsed: { channel: number; cc: number; value: number }): void {
  // 1. CC learn mode wins — capture the next CC for the in-flight knob.
  if (learnSpec) {
    const spec = learnSpec;
    const key = bindingKey(spec.moduleId, spec.paramId);
    // One binding per key — a fresh CC learn overwrites any prior CC OR note.
    bindings.set(key, {
      kind: 'cc',
      key,
      channel: parsed.channel,
      cc: parsed.cc,
      learnedAt: Date.now(),
    });
    setters.set(key, { min: spec.min, max: spec.max, onchange: spec.onchange });
    noteSetters.delete(key); // the key is now CC; drop any stale gate setter
    // Sole owner of this (channel, cc): a physical knob controls ONE param — drop
    // any other key previously learned/imported onto the same CC (collision fix).
    evictAddressOwners(`cc:${parsed.channel}:${parsed.cc}`, key);
    touchBindings();
    saveToStorage();
    learnSpec = null;
    // Apply the captured value immediately so the user sees the knob jump.
    spec.onchange(ccValueToParamValue(parsed.value, spec.min, spec.max));
    return;
  }

  // 2. Dispatch to whichever CC binding (if any) owns this CC. Setter lookup
  //    goes through the SEPARATE `setters` map. The intersection of "binding
  //    present" + "setter registered" activates dispatch; either alone is silent.
  for (const b of bindings.values()) {
    if (isCcBinding(b) && b.channel === parsed.channel && b.cc === parsed.cc) {
      const s = setters.get(b.key);
      if (s) s.onchange(ccValueToParamValue(parsed.value, s.min, s.max));
    }
  }
}

function handleNote(parsed: ReturnType<typeof parseNoteMessage>): void {
  if (!parsed) return;
  // 1. NOTE learn mode wins — capture the next NOTE-ON for the in-flight gate /
  //    button. Only a note-ON arms the binding (a note-off during learn is
  //    ignored, so releasing a previously-held key doesn't capture).
  if (noteLearnSpec && parsed.kind === 'on') {
    const spec = noteLearnSpec;
    const key = bindingKey(spec.moduleId, spec.paramId);
    bindings.set(key, {
      kind: 'note',
      key,
      channel: parsed.channel,
      note: parsed.note,
      learnedAt: Date.now(),
    });
    noteSetters.set(key, { onGate: spec.onGate });
    setters.delete(key); // the key is now NOTE; drop any stale CC setter
    // Sole owner of this (channel, note): a physical pad drives ONE gate/button.
    evictAddressOwners(`note:${parsed.channel}:${parsed.note}`, key);
    touchBindings();
    saveToStorage();
    noteLearnSpec = null;
    // Fire the gate high immediately so the captured press is felt.
    spec.onGate(true);
    return;
  }

  // 2. Dispatch to whichever NOTE binding (if any) owns this note. on → gate
  //    high, off → gate low (momentary). Setter lookup via `noteSetters`.
  for (const b of bindings.values()) {
    if (isNoteBinding(b) && noteMatches(b, parsed)) {
      const s = noteSetters.get(b.key);
      if (s) s.onGate(parsed.kind === 'on');
    }
  }
}

// ---------------- Public API ----------------

/** Enter CC learn mode for one knob. Cancels any in-flight learn (CC or NOTE)
 *  first. Auto-`connect()`s if MIDIAccess hasn't been requested yet. */
export async function beginLearn(spec: LearnSpec): Promise<void> {
  await connect();
  noteLearnSpec = null; // a CC learn supersedes any in-flight note learn
  learnSpec = spec;
  // Register the setter eagerly so this knob responds the moment the learn
  // captures (and on future loads where bindings rehydrate before a card mounts).
  registerSetter(spec.moduleId, spec.paramId, { min: spec.min, max: spec.max, onchange: spec.onchange });
}

/** Enter NOTE learn mode for one gate input / button. Cancels any in-flight
 *  learn (CC or NOTE) first. Auto-`connect()`s. */
export async function beginNoteLearn(spec: NoteLearnSpec): Promise<void> {
  await connect();
  learnSpec = null; // a NOTE learn supersedes any in-flight CC learn
  noteLearnSpec = spec;
  // Register the gate setter eagerly (same load-order rationale as beginLearn).
  registerGateSetter(spec.moduleId, spec.paramId, { onGate: spec.onGate });
}

/** Cancel an in-flight learn (CC and/or NOTE). */
export function cancelLearn(): void {
  learnSpec = null;
  noteLearnSpec = null;
}

/** Register / refresh the live setter for a knob. Called by Fader / Knob
 *  on mount. Stored in the `setters` map UNCONDITIONALLY (no dependence on
 *  whether a binding for this key exists yet) so a card mounted BEFORE its
 *  binding is loaded (Save/Load Local Performance flow) gets wired the
 *  moment the binding arrives. Idempotent. */
export function registerSetter(moduleId: string, paramId: string, args: {
  min: number; max: number; onchange: (v: number) => void;
}): void {
  setters.set(bindingKey(moduleId, paramId), { ...args });
}

/** Drop the live CC setter (called on Fader / Knob unmount). The persisted
 *  binding stays — re-mounting the card re-registers its setter. */
export function unregisterSetter(moduleId: string, paramId: string): void {
  setters.delete(bindingKey(moduleId, paramId));
}

/** Register / refresh the live GATE setter for a gate input / button. The NOTE
 *  analogue of registerSetter — stored in `noteSetters` UNCONDITIONALLY (no
 *  dependence on a binding existing yet) so a gate row / button mounted BEFORE
 *  its binding loads (Save/Load Performance flow) gets wired the moment the
 *  binding arrives. Idempotent. */
export function registerGateSetter(moduleId: string, paramId: string, args: GateSetter): void {
  noteSetters.set(bindingKey(moduleId, paramId), { onGate: args.onGate });
}

/** Drop the live gate setter (called on gate-row / button unmount). */
export function unregisterGateSetter(moduleId: string, paramId: string): void {
  noteSetters.delete(bindingKey(moduleId, paramId));
}

/** Look up the persisted binding (CC or NOTE) for a control. */
export function getBinding(moduleId: string, paramId: string): MidiBinding | undefined {
  return bindings.get(bindingKey(moduleId, paramId));
}

/** Remove a binding entirely (also drops both setter maps for the key). */
export function clearBinding(moduleId: string, paramId: string): void {
  const key = bindingKey(moduleId, paramId);
  bindings.delete(key);
  setters.delete(key);
  noteSetters.delete(key);
  touchBindings();
  saveToStorage();
}

/** Reactive getter for the in-flight CC learn spec — Fader / Knob reads this
 *  to know whether to show the pulsing border. */
export function learnSpecRune(): LearnSpec | null {
  return learnSpec;
}

/** Reactive getter for the in-flight NOTE learn spec — gate rows / buttons read
 *  this to know whether to show the pulsing "assign" border. */
export function noteLearnSpecRune(): NoteLearnSpec | null {
  return noteLearnSpec;
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
  // Shallow-copy each record so external mutation can't corrupt live state.
  return [...bindings.values()].map((b) => ({ ...b }));
}

/**
 * Merge imported bindings into the live set + persist. Bundle wins per `key`
 * (this performance's modules); other-patch bindings are preserved (design
 * risk #6 — don't clobber the user's unrelated mappings). Existing live
 * setters are kept where the key already had one so a mounted card keeps
 * driving without a remount. */
export function importBindings(incoming: unknown[]): void {
  for (const raw of incoming) {
    const b = normalizeBinding(raw);
    if (!b) continue;
    // No setter to preserve / restore — the `setters` / `noteSetters` maps are
    // independent of `bindings`, so a card whose setter is already registered
    // just starts dispatching the moment this binding lands, and a card that
    // mounts later finds the binding waiting for it.
    bindings.set(b.key, b);
  }
  // Enforce one-owner-per-address: an Electra re-connect imports the fresh
  // allocation table (newest learnedAt), which SUPERSEDES any stale binding still
  // parked on the same CC from a prior regenerate — repairing the user's already-
  // saved colliding map without a manual re-learn.
  repairBindingCollisions();
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

/** Wipe in-memory bindings + setters + learn state (does not touch localStorage). */
export function __test_clearBindings(): void {
  bindings.clear();
  setters.clear();
  noteSetters.clear();
  touchBindings();
  learnSpec = null;
  noteLearnSpec = null;
}

// ---------------- Dev-only simulated-MIDI device ----------------
//
// Installs an in-memory fake MIDIAccess so an e2e (or manual dev poke) can
// drive MIDI Learn + CC dispatch without real hardware or the Web MIDI
// permission prompt. Returns a `sendCc` that pushes a Control-Change message
// through exactly the same `handleMidi` path a real device uses, so learn
// capture + binding dispatch are exercised end-to-end.
//
// Guarded behind `testHooksEnabled()` at the call site (Canvas.svelte) so
// the window hook is absent from plain production bundles but present in the
// preview/autotest bundle built with VITE_E2E_HOOKS=1.
let simSender: ((channel: number, cc: number, value: number) => void) | null = null;
let simNoteSender: ((channel: number, note: number, velocity: number) => void) | null = null;
/** The installed sim device's raw handler — both senders push through it. */
let simHandler: ((ev: MidiEventLike) => void) | null = null;

function ensureSimDevice(): void {
  if (access) return; // already installed (sim or real) — reuse it
  const input: MidiInputLike = {
    id: 'pt-sim-midi-0',
    name: 'PatchTogether Simulated MIDI',
    manufacturer: 'patchtogether',
    state: 'connected',
    get onmidimessage() { return simHandler; },
    set onmidimessage(h) { simHandler = h; },
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
}

export function installSimulatedMidiDevice(): (channel: number, cc: number, value: number) => void {
  if (simSender) return simSender;
  ensureSimDevice();
  simSender = (channel: number, cc: number, value: number) => {
    if (!simHandler) return;
    simHandler({
      data: new Uint8Array([0xb0 | (channel & 0x0f), cc & 0x7f, value & 0x7f]),
      timeStamp: 0,
    });
  };
  return simSender;
}

/** Sibling of installSimulatedMidiDevice: returns a `sendNote` that pushes a
 *  NOTE on/off (velocity 0 = note-off) through the same dispatch path real
 *  hardware uses, so NOTE learn + gate dispatch are exercised end-to-end. */
export function installSimulatedNoteDevice(): (channel: number, note: number, velocity: number) => void {
  if (simNoteSender) return simNoteSender;
  ensureSimDevice();
  simNoteSender = (channel: number, note: number, velocity: number) => {
    if (!simHandler) return;
    const v = velocity & 0x7f;
    // velocity 0 → note-off (0x8n); else note-on (0x9n).
    const status = (v > 0 ? 0x90 : 0x80) | (channel & 0x0f);
    simHandler({
      data: new Uint8Array([status, note & 0x7f, v]),
      timeStamp: 0,
    });
  };
  return simNoteSender;
}
