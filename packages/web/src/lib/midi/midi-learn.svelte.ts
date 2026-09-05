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
import { createMidiInputClaim } from './input-attach';
import {
  deliverCcToGraph,
  deliverGateToGraph,
  splitBindingKey,
  flushGraphCcCommits,
} from './graph-param-dispatch';
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
/** Identity-scoped handler-slot claim — see $lib/midi/input-attach. */
const claim = createMidiInputClaim('midi-learn');
let connectStarted = false;
let connectFailed = false;

/** Map of bindingKey → binding metadata (channel/cc|note/learnedAt). The live
 *  setter is kept in a SEPARATE map (`setters` / `noteSetters` below) so the
 *  order of card-mount vs binding-population doesn't matter — see the comment on
 *  `setters` for why this decoupling is required for performance load. ONE
 *  binding per key — CC or NOTE, never both (begin*Learn overwrites). */
const bindings = $state<Map<string, MidiBinding>>(new Map());

/** Electra-generated allocations registered for the bound-BADGE ONLY — a wholly
 *  SEPARATE namespace from `bindings`. These are NEVER dispatched, NEVER persisted,
 *  and NEVER participate in the one-owner-per-address invariant. Rationale: the
 *  physical Electra CC is already dispatched by the Electra broker/autoconfig
 *  (host.writeParam). Importing the allocation into the dispatched `bindings` map
 *  (the old `ElectraConnectButton` behaviour) caused two real bugs — (1) DOUBLE
 *  dispatch (autoconfig writes the param AND midi-learn's setter writes it again),
 *  and (2) the newest-wins collision repair silently EVICTED the user's manual
 *  bindings that shared a (channel 0) address, persisted to localStorage so it
 *  survived unplugging the Electra. Display-only + device-lifetime fixes both:
 *  replaced on each connect, cleared on disconnect, invisible to dispatch/evict/
 *  storage. See `setElectraDisplayBindings`. */
const electraDisplay = $state<Map<string, MidiBinding>>(new Map());

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

/** EVERY-PORT BY DESIGN, and now declared rather than incidental: MIDI Learn
 *  binds a knob to whatever the user physically touches, so it must hear every
 *  device. It filters by MESSAGE TYPE (CC vs note) and by ADDRESS (channel +
 *  cc/note) — never by device. See `MIDI_SUBSCRIBER_LEDGER`.
 *
 *  ⚠ Consequence, now stated where it is true instead of assumed away: control
 *  surfaces are NOT excluded. Arming a learn and then touching a Push 2 encoder
 *  or a Launchpad button captures THAT control. `push2-device.svelte.ts` used
 *  to claim its own sysex access prevented this; it does not — a separately
 *  requested MIDIAccess has its own MIDIInput objects and its own handler
 *  slots, so both subsystems receive the same physical message. Whether learn
 *  should skip bound surfaces is an owner decision, deliberately NOT taken
 *  here. */
function attachAllInputs(): void {
  if (!access) return;
  claim.attachOnly([...access.inputs.values()], handleMidi);
}

function attachInput(inp: MidiInputLike): void {
  claim.attach(inp, handleMidi);
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

  // 2. Dispatch to whichever CC binding (if any) owns this CC.
  //
  //    TWO DELIVERY PATHS, and the binding alone is enough for the second
  //    (#1727). A MOUNTED control registers a setter in the SEPARATE `setters`
  //    map and is preferred — it owns the on-screen visual and any bespoke
  //    commit the card wants. When no control is mounted the delivery is
  //    RESOLVED FROM THE GRAPH instead: the binding names (node, param), and
  //    the node outlives every view of it.
  //
  //    It used to be the intersection of "binding present" + "setter
  //    registered", so a binding to any un-migrated module on the default
  //    shell — which renders <ModuleShellPlaceholder> and mounts no control —
  //    was silently inert while looking, exporting and persisting as assigned.
  for (const b of bindings.values()) {
    if (isCcBinding(b) && b.channel === parsed.channel && b.cc === parsed.cc) {
      const s = setters.get(b.key);
      if (s) {
        s.onchange(ccValueToParamValue(parsed.value, s.min, s.max));
        continue;
      }
      const addr = splitBindingKey(b.key);
      if (addr) deliverCcToGraph(addr.moduleId, addr.paramId, parsed.value);
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
  //    high, off → gate low (momentary). Setter lookup via `noteSetters`, with
  //    the same GRAPH fallback the CC path has (#1727): a NOTE bound to a
  //    declared `gate` INPUT port resolves to `engine.setGateInput`, which is
  //    exactly what <PatchPanel>'s gate row would have registered.
  //
  //    ⚠ WHAT THIS FALLBACK CANNOT REACH, stated where it is true: a NOTE bound
  //    to a card BUTTON (a synthetic action id like 'play') has no graph
  //    meaning, so it stays card-scoped. Gate PORTS are additionally already
  //    safe on every lane render, because <PatchPanel> — which registers their
  //    setters — mounts in ModuleShell and ModuleShellPlaceholder alike; the
  //    fallback covers the case where neither is mounted at all.
  for (const b of bindings.values()) {
    if (isNoteBinding(b) && noteMatches(b, parsed)) {
      const s = noteSetters.get(b.key);
      if (s) {
        s.onGate(parsed.kind === 'on');
        continue;
      }
      const addr = splitBindingKey(b.key);
      if (addr) deliverGateToGraph(addr.moduleId, addr.paramId, parsed.kind === 'on');
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
  // HANDOFF (#1727): this control is now the delivery path. Land anything the
  // GRAPH path staged before it mounted, so a value up to CC_SETTLE_MS old
  // cannot settle AFTER the control's newer one. A flush, never a teardown —
  // dropping the setter again simply returns delivery to the graph.
  flushGraphCcCommits();
}

/** Drop the live CC setter (called on Fader / Knob unmount). The persisted
 *  binding stays — re-mounting the card re-registers its setter. */
export function unregisterSetter(moduleId: string, paramId: string): void {
  setters.delete(bindingKey(moduleId, paramId));
}

/**
 * CONTROLS WHOSE BINDING ID CHANGED — `paramId` → the legacy ids a saved
 * binding may still be filed under.
 *
 * ⚠ WHY THIS EXISTS. `bindingKey` is `${moduleId}:${paramId}` and bindings
 * persist to localStorage, so a control that changes the id it binds under
 * ORPHANS every saved binding: the record is still there, under a key nothing
 * reads any more, and the pad simply stops working with no error and nothing to
 * see. Node ids are stable across reloads, so this is not theoretical.
 *
 * ⚠ THE FIRST MEMBER IS A FACE PROMOTION, AND THE CLASS HAS MORE THAN ONE.
 * `MidiAssignButton` binds under a SYNTHETIC ACTION ID — its own doc names
 * `'play'` and `'clear'` as examples — because a bare button has no backing
 * param. A face replaces such a button with a `<Toggle>` over the REAL param,
 * so `score`'s PLAY moved from `<node>:play` to `<node>:isPlaying`. Any control
 * that trades a synthetic action id for a real param id is the same shape,
 * which is why this is a declared table rather than a module `if`.
 *
 * ⚠ ADOPTING RE-KEYS THE RECORD RATHER THAN COPYING IT, deliberately. Filing
 * the same binding under both the old and the new key would give one physical
 * pad two owners, and nothing in the read path would say which of them won.
 */
const LEGACY_BINDING_ALIASES: Readonly<Record<string, readonly string[]>> = {
  // score: a MidiAssignButton (`paramId="play"`, a synthetic action id)
  // became the faceplate's `isPlaying` Toggle, which is the same
  // `makeMidiAssignable({ kind:'note', controlType:'button' })` factory with the
  // same press-edge toggle semantics — so the AFFORDANCE survived promotion
  // intact and only the KEY moved.
  isPlaying: ['play'],
};

/**
 * Re-key a saved binding filed under a legacy id, on the control's own mount.
 *
 * DENY BY DEFAULT: it does nothing unless the target key is UNBOUND and a
 * declared legacy key for the SAME NODE is bound. A control that already has a
 * binding is never touched, so this cannot steal one.
 */
function adoptLegacyBinding(moduleId: string, paramId: string): void {
  const legacyIds = LEGACY_BINDING_ALIASES[paramId];
  if (!legacyIds) return;
  const key = bindingKey(moduleId, paramId);
  if (bindings.has(key)) return;
  for (const legacy of legacyIds) {
    const oldKey = bindingKey(moduleId, legacy);
    const b = bindings.get(oldKey);
    if (!b) continue;
    bindings.delete(oldKey);
    setters.delete(oldKey);
    noteSetters.delete(oldKey);
    bindings.set(key, { ...b, key });
    touchBindings();
    saveToStorage();
    return;
  }
}

/** Register / refresh the live GATE setter for a gate input / button. The NOTE
 *  analogue of registerSetter — stored in `noteSetters` UNCONDITIONALLY (no
 *  dependence on a binding existing yet) so a gate row / button mounted BEFORE
 *  its binding loads (Save/Load Performance flow) gets wired the moment the
 *  binding arrives. Idempotent. */
export function registerGateSetter(moduleId: string, paramId: string, args: GateSetter): void {
  adoptLegacyBinding(moduleId, paramId);
  noteSetters.set(bindingKey(moduleId, paramId), { onGate: args.onGate });
}

/** TEST SEAM for the alias table above — the adoption runs on MOUNT, which a
 *  unit lane has no component to trigger. Not for product code. */
export function _adoptLegacyBindingForTest(moduleId: string, paramId: string): void {
  adoptLegacyBinding(moduleId, paramId);
}

/** Drop the live gate setter (called on gate-row / button unmount). */
export function unregisterGateSetter(moduleId: string, paramId: string): void {
  noteSetters.delete(bindingKey(moduleId, paramId));
}

/** Look up the binding (CC or NOTE) for a control. A real dispatched/persisted
 *  binding always takes precedence; an Electra DISPLAY-only allocation is the
 *  fallback so an Electra-owned control still shows the bound badge (it is driven
 *  by the Electra broker, not by this module's dispatch). */
export function getBinding(moduleId: string, paramId: string): MidiBinding | undefined {
  const key = bindingKey(moduleId, paramId);
  return bindings.get(key) ?? electraDisplay.get(key);
}

/** Register Electra-generated allocations for the bound-BADGE ONLY, WITHOUT
 *  entering the dispatch / eviction / persistence namespace. Replaces the whole
 *  display set (device-lifetime). Does NOT touch `bindings`, so a user's manual
 *  MIDI-learn mappings survive a "Send to Electra" untouched, and the physical
 *  Electra CC dispatches exactly once (via the Electra broker/host.writeParam). */
export function setElectraDisplayBindings(incoming: unknown[]): void {
  electraDisplay.clear();
  for (const raw of incoming) {
    const b = normalizeBinding(raw);
    if (b) electraDisplay.set(b.key, b);
  }
  touchBindings();
}

/** Drop all Electra display-only allocations (call on Electra disconnect). */
export function clearElectraDisplayBindings(): void {
  if (electraDisplay.size) {
    electraDisplay.clear();
    touchBindings();
  }
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
  electraDisplay.clear();
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
