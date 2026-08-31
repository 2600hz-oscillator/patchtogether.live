// PT-PTZ binding layer — ONE sysex MIDI access for the whole app (the shared
// `$lib/audio/midi-access` seam is sysex:false BY DESIGN; this follows the
// electra-broker one-access-per-family convention and reuses the shared
// outcome COPY), fanned out into per-camera BINDINGS. The multicam helper
// exposes one virtual pair per camera, named `PT-PTZ-<SHORT>`; a binding
// resolves one pair by exact name (or the first PT-PTZ-prefixed pair for the
// auto default), does the caps handshake, and is refcounted so two modules on
// one camera share the input claim instead of evicting each other.
//
// Never requests access at load — `midi.spec.ts` pins "page load never
// requests Web-MIDI access". `connectPtzMidi()` is called synchronously from
// a card's click handler.
//
// Plain .ts, not .svelte.ts, ON PURPOSE: the ptzcam DEF imports this module,
// and the art workspace's node vitest imports every audio def with no svelte
// compiler in the loop — a rune here throws at collection. Reactivity is
// svelte/store writables (plain runtime JS): a global `ptzMidiVersion` bumped
// on any binding/port change.

import { writable } from 'svelte/store';
import {
  MIDI_PROMPT_TIMEOUT_MS,
  midiOutcomeMessage,
  type MidiAccessOutcome,
} from '$lib/audio/midi-access';
import { createMidiInputClaim, type MidiInputClaim } from '$lib/midi/input-attach';
import type { MidiInputLike } from '$lib/audio/modules/midi-cv-buddy';
import { buildCapsRequest, buildStopAll, parsePtzFrame, type PtzCaps } from '$lib/audio/ptz-sysex';

export const PTZ_PORT_PREFIX = 'PT-PTZ';
const CAPS_REPLY_TIMEOUT_MS = 3000;

export type PtzBindKind =
  | 'idle'
  | 'unsupported'
  | 'denied'
  | 'no-prompt'
  | 'no-port'
  | 'binding'
  | 'no-reply'
  | 'bound'
  | 'camera-absent';

export interface PtzStatus {
  readonly kind: PtzBindKind;
  readonly message: string;
  readonly caps: PtzCaps | null;
  readonly portName: string | null;
}

interface MidiPortLike {
  readonly id: string;
  readonly name?: string | null;
  /** Real WebMIDI keeps DISCONNECTED ports in the maps (a dead helper's pairs
   *  linger with state 'disconnected' and the same names — measured on
   *  hardware: duplicate names crashed the card's keyed each). */
  readonly state?: string;
}
interface MidiOutputLike extends MidiPortLike {
  send(data: number[] | Uint8Array): void;
}
export interface PtzMidiAccessLike {
  readonly inputs: ReadonlyMap<string, MidiInputLike>;
  readonly outputs: ReadonlyMap<string, MidiOutputLike>;
  onstatechange: ((e?: unknown) => void) | null;
}
type PtzRequestFn = () => Promise<PtzMidiAccessLike>;

export interface PtzBinding {
  /** The port selector this binding was acquired with (null = auto/first). */
  readonly selector: string | null;
  status(): PtzStatus;
  caps(): PtzCaps | null;
  send(bytes: Uint8Array): boolean;
  release(): void;
}

/** Bumped on ANY binding-state or port-roster change — `$ptzMidiVersion` in a
 *  component (or subscribe) and re-read status(). */
export const ptzMidiVersion = writable(0);
// Deferred to a microtask: a bump can be triggered from inside a Svelte
// derived evaluation (a card read path racing a resolve), and a synchronous
// store set would run subscribers that write rune state mid-derived —
// `state_unsafe_mutation`, which permanently poisons the card's deriveds
// (measured). A microtask always lands outside the evaluation.
let bumpQueued = false;
function bump(): void {
  if (bumpQueued) return;
  bumpQueued = true;
  queueMicrotask(() => {
    bumpQueued = false;
    ptzMidiVersion.update((n) => n + 1);
  });
}

let access: PtzMidiAccessLike | null = null;
let accessKind: 'idle' | 'unsupported' | 'denied' | 'no-prompt' | 'granted' = 'idle';
let connectInFlight = false;

function isPtzName(name: string | null | undefined): boolean {
  return (name ?? '').toUpperCase().startsWith(PTZ_PORT_PREFIX);
}

function isLive(p: MidiPortLike): boolean {
  return p.state !== 'disconnected';
}

export function listPtzOutputNames(): string[] {
  if (!access) return [];
  return [
    ...new Set(
      [...access.outputs.values()]
        .filter((o) => isLive(o) && isPtzName(o.name))
        .map((o) => o.name ?? ''),
    ),
  ].sort();
}

// ── shared input dispatcher ─────────────────────────────────────────────────
// Two bindings can resolve to the SAME input (an explicit-name binding and the
// @auto default both landing on the first camera). `onmidimessage` is a
// single-slot property, so per-binding claims would evict each other — ONE
// claim owns every PT-PTZ input and fans frames out to whichever bindings are
// resolved to it (measured: the evicted binding sat in 'binding' forever).
const inputBindings = new Map<MidiInputLike, Set<BindingImpl>>();
const inputClaim: MidiInputClaim = createMidiInputClaim('pt-ptz');

function setBindingInput(impl: BindingImpl, inp: MidiInputLike | null): void {
  for (const set of inputBindings.values()) {
    set.delete(impl);
  }
  if (inp) {
    let set = inputBindings.get(inp);
    if (!set) {
      set = new Set();
      inputBindings.set(inp, set);
      inputClaim.attach(inp, (e) => {
        for (const b of inputBindings.get(inp) ?? []) b.onFrame(e.data);
      });
    }
    set.add(impl);
  }
  for (const [input, set] of [...inputBindings]) {
    if (set.size === 0) {
      inputBindings.delete(input);
      inputClaim.detachFrom(input);
    }
  }
}

class BindingImpl {
  readonly selector: string | null;
  refs = 0;
  private output: MidiOutputLike | null = null;
  private capsValue: PtzCaps | null = null;
  private kind: PtzBindKind = 'idle';
  private resolvedName: string | null = null;
  private capsTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(selector: string | null) {
    this.selector = selector;
  }

  private setKind(next: PtzBindKind): void {
    if (this.kind === next) return;
    this.kind = next;
    bump();
  }

  private clearCapsTimer(): void {
    if (this.capsTimer !== null) clearTimeout(this.capsTimer);
    this.capsTimer = null;
  }

  onFrame(data: ArrayLike<number> | null): void {
    if (!data) return;
    const frame = parsePtzFrame(data);
    if (!frame) return;
    this.clearCapsTimer();
    if (frame.kind === 'caps') {
      this.capsValue = frame.caps;
      this.setKind('bound');
      bump();
    } else if (frame.name === 'camera-absent') {
      this.setKind('camera-absent');
    }
  }

  resolve(): void {
    if (!access) {
      this.setKind(
        accessKind === 'unsupported' || accessKind === 'denied' || accessKind === 'no-prompt'
          ? accessKind
          : 'idle',
      );
      return;
    }
    const match = (p: MidiPortLike): boolean =>
      isLive(p) && (this.selector === null ? isPtzName(p.name) : (p.name ?? '') === this.selector);
    const out = [...access.outputs.values()].find(match) ?? null;
    const inp = [...access.inputs.values()].find((i) => match(i as MidiPortLike)) ?? null;
    // A re-resolve that lands on the SAME pair while a handshake is done (or
    // in flight) must be a no-op: resolveAll() runs on every connect() and
    // statechange, and re-requesting caps would tear a healthy bound state
    // down to 'no-reply' (measured — module 2's Connect broke module 1).
    if (
      out !== null &&
      out === this.output &&
      inp !== null &&
      inputBindings.get(inp)?.has(this) &&
      (this.kind === 'bound' || this.kind === 'binding')
    ) {
      return;
    }
    this.output = out;
    this.resolvedName = out?.name ?? null;
    if (!out || !inp) {
      setBindingInput(this, null);
      this.capsValue = null;
      this.setKind('no-port');
      bump();
      return;
    }
    setBindingInput(this, inp);
    this.requestCaps();
  }

  private requestCaps(): void {
    if (!this.output) return;
    this.setKind('binding');
    this.clearCapsTimer();
    try {
      this.output.send(buildCapsRequest());
    } catch {
      this.resolve();
      return;
    }
    this.capsTimer = setTimeout(() => {
      if (this.kind === 'binding') this.setKind('no-reply');
    }, CAPS_REPLY_TIMEOUT_MS);
  }

  caps(): PtzCaps | null {
    return this.capsValue;
  }

  send(bytes: Uint8Array): boolean {
    if (!this.output) return false;
    try {
      this.output.send(bytes);
      return true;
    } catch {
      this.resolve();
      return false;
    }
  }

  status(): PtzStatus {
    const kind = this.kind;
    let message = '';
    const shared: Partial<Record<PtzBindKind, MidiAccessOutcome>> = {
      unsupported: { kind: 'unsupported' },
      'no-prompt': { kind: 'no-prompt' },
      denied: { kind: 'denied', message: '' },
    };
    const outcome = shared[kind];
    if (outcome) message = midiOutcomeMessage(outcome);
    else if (kind === 'idle') message = 'Not connected. Connect grants MIDI and finds the PT-PTZ helper.';
    else if (kind === 'no-port')
      message =
        this.selector === null
          ? `No MIDI port named ${PTZ_PORT_PREFIX}-*. Start the helper (start_ptz.sh) — it binds the moment a camera pair appears.`
          : `No MIDI port named ${this.selector}. Start the helper (start_ptz.sh), or pick another camera.`;
    else if (kind === 'binding') message = `${this.resolvedName ?? 'helper'} found — requesting camera caps…`;
    else if (kind === 'no-reply')
      message =
        'Helper port found but no caps reply. If the helper log is quiet, the browser is dropping sysex — relaunch it with --disable-features=MidiMacUmp (start_edge.sh).';
    else if (kind === 'camera-absent')
      message = 'Helper is running but this camera is absent. Plug it in — it rebinds automatically.';
    else if (kind === 'bound') message = `Bound to ${this.resolvedName} — camera caps received.`;
    return { kind, message, caps: this.capsValue, portName: this.resolvedName };
  }

  teardown(): void {
    this.clearCapsTimer();
    // Best-effort halt of any velocity motion this binding may have commanded;
    // the helper's watchdog is the backstop when this cannot be delivered.
    if (this.output && this.kind === 'bound') {
      try {
        this.output.send(buildStopAll());
      } catch {
        /* port already gone */
      }
    }
    setBindingInput(this, null);
    this.output = null;
    this.capsValue = null;
  }
}

const bindings = new Map<string, BindingImpl>();
const keyFor = (selector: string | null): string => selector ?? '@auto';

export function acquirePtzBinding(selector: string | null): PtzBinding {
  const key = keyFor(selector);
  let impl = bindings.get(key);
  if (!impl) {
    impl = new BindingImpl(selector);
    bindings.set(key, impl);
    if (access) impl.resolve();
  }
  impl.refs++;
  const handle: PtzBinding = {
    selector,
    status: () => impl.status(),
    caps: () => impl.caps(),
    send: (bytes) => impl.send(bytes),
    release: () => {
      impl.refs--;
      if (impl.refs <= 0) {
        impl.teardown();
        bindings.delete(key);
        bump();
      }
    },
  };
  return handle;
}

function resolveAll(): void {
  for (const impl of bindings.values()) impl.resolve();
  bump();
}

const defaultRequest: PtzRequestFn = () =>
  (navigator as unknown as { requestMIDIAccess: (o: { sysex: boolean }) => Promise<PtzMidiAccessLike> })
    .requestMIDIAccess({ sysex: true });

/** Call synchronously from a user gesture. Safe to call again — re-resolves. */
export function connectPtzMidi(request?: PtzRequestFn): Promise<void> {
  if (access) {
    resolveAll();
    return Promise.resolve();
  }
  if (connectInFlight) return Promise.resolve();
  if (
    !request &&
    (typeof navigator === 'undefined' ||
      typeof (navigator as { requestMIDIAccess?: unknown }).requestMIDIAccess !== 'function')
  ) {
    accessKind = 'unsupported';
    resolveAll();
    return Promise.resolve();
  }
  connectInFlight = true;
  const pending = (request ?? defaultRequest)();
  const timer = setTimeout(() => {
    connectInFlight = false;
    if (accessKind === 'idle') {
      accessKind = 'no-prompt';
      resolveAll();
    }
  }, MIDI_PROMPT_TIMEOUT_MS);
  return pending
    .then((a) => {
      // A grant after the no-prompt heuristic fired still binds — the user
      // answered the prompt eventually (midi-access onLateResolve shape).
      clearTimeout(timer);
      connectInFlight = false;
      access = a;
      accessKind = 'granted';
      a.onstatechange = () => resolveAll();
      resolveAll();
    })
    .catch(() => {
      clearTimeout(timer);
      connectInFlight = false;
      accessKind = 'denied';
      resolveAll();
    });
}

export function __resetPtzMidiForTest(): void {
  for (const impl of bindings.values()) impl.teardown();
  bindings.clear();
  inputBindings.clear();
  inputClaim.detach();
  if (access) access.onstatechange = null;
  access = null;
  accessKind = 'idle';
  connectInFlight = false;
}
