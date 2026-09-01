// packages/web/src/lib/midi/trails-device.ts
//
// THE BELA TRAILS DEVICE LAYER — one Web MIDI binding for the whole app, fanned
// out to every `trails` module in the rack.
//
// Trails' USB-C port is class-compliant USB-MIDI (Bela's own firmware updater
// is a Chrome WebMIDI page), so no helper app and no native bridge is involved:
// the browser talks to the module directly over the shared, sysex-FALSE access
// seam in `$lib/audio/midi-access`.
//
// ── THE FIVE CONVENTIONS EVERY DEVICE LAYER IN THIS TREE FOLLOWS ────────────
//   1. `trailsAvailable()`      — a probe that can be called anywhere, anytime.
//   2. `connectTrails()`        — LAZY and gesture-gated. Called from a card's
//      click handler, never from a module factory: loading a saved patch that
//      happens to contain a `trails` must not raise a permission prompt.
//      Returns false and never throws.
//   3. `trailsMidiVersion`      — a status signal a surface can subscribe to.
//   4. `createMidiInputClaim`   — the ONE legal way to own `onmidimessage`.
//   5. `installSimulatedTrails()` — an in-memory double that drives the REAL
//      decode path, usable from unit tests AND from e2e.
//
// ⚠ PLAIN `.ts`, NOT `.svelte.ts`. The `trails` module def imports this file,
// and the ART workspace's node vitest imports every audio def with no Svelte
// compiler in the loop — a rune here throws at collection time. Reactivity is a
// `svelte/store` writable, which is plain runtime JS. (The ptzcam PR paid this
// exact cost after the fact; this is the corrected shape from the start.)

import { writable } from 'svelte/store';
import {
  requestMidiAccess,
  midiOutcomeMessage,
  webMidiSupported,
  type MIDIAccessLike,
} from '$lib/audio/midi-access';
import { createMidiInputClaim, type MidiInputClaim } from '$lib/midi/input-attach';
import type { MidiEventLike, MidiInputLike } from '$lib/audio/modules/midi-cv-buddy';
import {
  encodeTrailsAxis,
  encodeTrailsGate,
  encodeTrailsNote,
  type TrailsChannel,
} from '$lib/midi/trails-decode';

/**
 * How a Trails names itself on the MIDI bus.
 *
 * ⚠ HARDWARE-VERIFY ITEM. Bela has not published the USB product string, so the
 * match is deliberately LOOSE — any port whose name contains "trails" in any
 * case. That covers "Trails", "Bela Trails", "Trails MIDI 1" and the
 * `MIDIIN2 (Trails)` shape Windows' WinMM driver produces for a second
 * interface, which is the shape that has bitten this repo before (the Launchpad
 * dual-port incident). If the real device turns out to advertise something with
 * no "trails" in it at all, this pattern is the one line that changes.
 */
export const TRAILS_PORT_PATTERN = /trails/i;

export type TrailsStatusKind =
  | 'idle'
  | 'unsupported'
  | 'denied'
  | 'no-prompt'
  | 'no-port'
  | 'bound';

export interface TrailsStatus {
  readonly kind: TrailsStatusKind;
  /** User-facing, ACTIONABLE. Every non-bound state names what to do next. */
  readonly message: string;
  /** Names of the matched Trails input ports currently attached. */
  readonly portNames: readonly string[];
}

/** Bumped on ANY binding or port-roster change. Subscribe and re-read
 *  `trailsStatus()`; a component mirrors it with an init-time `subscribe` +
 *  `onDestroy`, the pattern PtzcamCard documents. */
export const trailsMidiVersion = writable(0);

// Deferred to a microtask so a bump raised from inside a Svelte `$derived`
// evaluation cannot run subscribers that write rune state mid-derived
// (`state_unsafe_mutation`, which permanently poisons a card's deriveds).
let bumpQueued = false;
function bump(): void {
  if (bumpQueued) return;
  bumpQueued = true;
  queueMicrotask(() => {
    bumpQueued = false;
    trailsMidiVersion.update((n) => n + 1);
  });
}

/** The slice of a MIDI input this layer needs, plus the `id`/`state` fields the
 *  shared `MIDIAccessLike` does not declare. */
type TrailsInput = MidiInputLike;

interface TrailsAccessLike {
  readonly inputs: ReadonlyMap<string, TrailsInput>;
  onstatechange: ((e?: unknown) => void) | null;
}

type TrailsRequestFn = () => Promise<TrailsAccessLike>;

let access: TrailsAccessLike | null = null;
let accessKind: 'idle' | 'unsupported' | 'denied' | 'no-prompt' | 'granted' = 'idle';
let accessMessage = '';
let connectInFlight = false;
let attachedNames: string[] = [];

/** Every module instance that wants raw frames. A `Set` of handlers rather than
 *  one slot: four `trails` nodes in a rack all read the same physical device,
 *  and `onmidimessage` is a SINGLE slot, so per-module claims would evict each
 *  other (the PT-PTZ two-module lesson). */
const subscribers = new Set<(ev: MidiEventLike) => void>();

const inputClaim: MidiInputClaim = createMidiInputClaim('trails');

/** Is Web MIDI callable at all? Safe anywhere — cannot prompt, cannot throw. */
export function trailsAvailable(): boolean {
  return webMidiSupported();
}

function isTrailsPort(p: { name?: string | null; state?: string }): boolean {
  if (p.state === 'disconnected') return false;
  return TRAILS_PORT_PATTERN.test(p.name ?? '');
}

/** Names of the live Trails input ports the granted access can see. Empty
 *  before a grant. Duplicate names are collapsed for DISPLAY only — the claim
 *  below still attaches to every distinct port object, because a Windows WinMM
 *  device really does expose two same-named inputs carrying different data. */
export function listTrailsPortNames(): string[] {
  if (!access) return [];
  return [
    ...new Set([...access.inputs.values()].filter(isTrailsPort).map((i) => i.name ?? i.id)),
  ].sort();
}

/** Dispatch one frame to every subscribed module. Kept as a named function so
 *  the claim installs ONE stable reference and re-resolves are free. */
function onFrame(ev: MidiEventLike): void {
  for (const fn of subscribers) {
    try {
      fn(ev);
    } catch (err) {
      console.error('[trails] subscriber threw', err);
    }
  }
}

function resolvePorts(): void {
  if (!access) {
    attachedNames = [];
    inputClaim.detach();
    bump();
    return;
  }
  const matched = [...access.inputs.values()].filter(isTrailsPort);
  // `attachOnly` releases every port THIS claim holds that is not in the new
  // list and leaves anybody else's slots strictly alone.
  inputClaim.attachOnly(matched, onFrame);
  attachedNames = matched.map((i) => i.name ?? i.id);
  bump();
}

/** The current binding state — a PURE read, safe to call from a `$derived`. */
export function trailsStatus(): TrailsStatus {
  const portNames = [...new Set(attachedNames)].sort();
  if (accessKind === 'unsupported') {
    return { kind: 'unsupported', message: midiOutcomeMessage({ kind: 'unsupported' }), portNames };
  }
  if (accessKind === 'denied') {
    return {
      kind: 'denied',
      message: midiOutcomeMessage({ kind: 'denied', message: accessMessage }),
      portNames,
    };
  }
  if (accessKind === 'no-prompt') {
    return { kind: 'no-prompt', message: midiOutcomeMessage({ kind: 'no-prompt' }), portNames };
  }
  if (accessKind === 'idle') {
    return {
      kind: 'idle',
      message: 'Not connected. CONNECT asks the browser for MIDI and looks for a Trails.',
      portNames,
    };
  }
  if (portNames.length === 0) {
    return {
      kind: 'no-port',
      message:
        'MIDI is granted but no port named "Trails" is present. Connect the module\'s USB-C port '
        + 'to this computer — it appears as a class-compliant MIDI device and binds automatically.',
      portNames,
    };
  }
  return {
    kind: 'bound',
    message: `Bound to ${portNames.join(', ')} — streaming X / Y / gate.`,
    portNames,
  };
}

/**
 * Ask for Web MIDI and bind every Trails port.
 *
 * MUST be called synchronously from a user gesture — an `await` above the
 * request spends the user activation and Chromium refuses to prompt. Safe to
 * call again: a second call with access already granted just re-resolves the
 * port list.
 *
 * NEVER THROWS. Returns true only when a Trails port is actually attached, so a
 * caller can distinguish "granted but nothing plugged in" from success without
 * reading the status string.
 */
export async function connectTrails(request?: TrailsRequestFn): Promise<boolean> {
  if (access) {
    resolvePorts();
    return trailsStatus().kind === 'bound';
  }
  if (connectInFlight) return false;

  if (request) {
    connectInFlight = true;
    try {
      access = await request();
      accessKind = 'granted';
      access.onstatechange = () => resolvePorts();
      resolvePorts();
    } catch {
      accessKind = 'denied';
      accessMessage = 'Permission denied';
      bump();
    } finally {
      connectInFlight = false;
    }
    return trailsStatus().kind === 'bound';
  }

  if (!trailsAvailable()) {
    accessKind = 'unsupported';
    bump();
    return false;
  }

  connectInFlight = true;
  try {
    const outcome = await requestMidiAccess({
      // A grant that lands AFTER the no-prompt heuristic already fired is still
      // honoured — the user answered a real prompt, slowly.
      onLateResolve: (a) => {
        adoptAccess(a);
      },
    });
    if (outcome.kind === 'granted') {
      adoptAccess(outcome.access);
    } else {
      accessKind = outcome.kind;
      accessMessage = outcome.kind === 'denied' ? outcome.message : '';
      bump();
    }
  } catch {
    // requestMidiAccess already normalises rejection into an outcome; this is
    // the belt on top of the braces, because this function's contract is that
    // it never throws.
    accessKind = 'denied';
    accessMessage = 'Permission denied';
    bump();
  } finally {
    connectInFlight = false;
  }
  return trailsStatus().kind === 'bound';
}

function adoptAccess(a: MIDIAccessLike): void {
  access = a as unknown as TrailsAccessLike;
  accessKind = 'granted';
  accessMessage = '';
  access.onstatechange = () => resolvePorts();
  resolvePorts();
}

/**
 * Receive every raw MIDI frame the bound Trails ports produce.
 *
 * The module factory subscribes at construction — which costs nothing and
 * prompts nothing, because the frames only start once somebody has pressed
 * CONNECT. Returns an unsubscribe function for `dispose()`.
 */
export function subscribeTrailsMidi(fn: (ev: MidiEventLike) => void): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

// ── The simulated device ────────────────────────────────────────────────────
//
// ⚠ IT DRIVES THE REAL CODE PATH, which is the entire point. The double is a
// fake `MIDIAccess` handed to `connectTrails()`, so the port match, the claim,
// the fan-out and the module's own decoder all run exactly as they do on
// hardware — the only thing replaced is the USB cable. The alternative shape
// (a test that calls the decoder directly) is the one that has shipped modules
// that were green and silent.

/** Everything a test can do to the simulated hardware. */
export interface SimulatedTrails {
  /** The fake port's name, so a test can assert what the status line shows. */
  readonly portName: string;
  /** Push raw bytes as if the device had sent them. */
  send(bytes: readonly number[]): void;
  /**
   * Put channel `channel`'s finger at pad coordinates (`x`, `y`), both 0..1.
   *
   * Emits the REAL 14-bit CC byte pairs — `encodeTrailsAxis` is the same
   * constant table the decoder reads — so a test that calls this is exercising
   * the assembler, not bypassing it.
   */
  touch(channel: TrailsChannel, x: number, y: number): void;
  /** Note-on for a channel's gate (the manual's documented gate mechanism). */
  gateOn(channel: TrailsChannel): void;
  /** Note-off for a channel's gate. */
  gateOff(channel: TrailsChannel): void;
  /**
   * NOTE MODE: strike one channel's X and Y as quantised notes.
   *
   * ⚠ THIS IS THE MODE THE CC HELPERS ABOVE CANNOT REACH, and the one the
   * reported defect lives in. With both quantisations enabled the device stops
   * sending CC entirely and sends these instead — the SAME two axes on the SAME
   * two per-axis MIDI channels, quantised to a scale. A test that only ever
   * calls `touch()` is testing the mode the player has just left.
   *
   * Emits real `encodeTrailsNote` bytes on both of the channel's wire channels,
   * so the port match, the claim, the fan-out and the decoder's note branch all
   * run exactly as they do on hardware.
   */
  noteTouch(channel: TrailsChannel, xNote: number, yNote: number, velocity?: number): void;
  /**
   * Release a note-mode strike.
   *
   * A note-ON with VELOCITY 0, because that is what the hardware sends: the
   * owner's 2026-09-01 MON capture shows note-on rows with `last=0` and no 0x80
   * rows at all. A double that sent 0x80 would let a decoder that only handled
   * 0x80 pass.
   */
  noteRelease(channel: TrailsChannel, xNote: number, yNote: number): void;
  /**
   * Stream `steps` axis samples along a straight path, with NO GAP between
   * them — the shape a recorded gesture has while it plays back.
   *
   * ⚠ THIS IS THE DOUBLE THAT REPRODUCES THE REPORTED DEFECT. The activity
   * gate infers contact from the stream stopping, and a gesture playing back
   * never stops: call `glide` twice in a row and the gate rises exactly once
   * and stays up forever, which is what "no gate event every time the loop
   * fires" looks like from inside the decoder. Nothing about it is special-cased
   * — it is `touch()` in a loop, so it emits the same real CC byte pairs.
   */
  glide(
    channel: TrailsChannel,
    steps: number,
    from?: { x: number; y: number },
    to?: { x: number; y: number },
  ): void;
  /**
   * One full repetition of a looping gesture: the device's own loop-restart
   * message followed by a gapless run of axis samples.
   *
   * The manual: "A Start message is sent every time the playhead restarts from
   * the beginning of the track." So a repetition on the wire is exactly 0xFA
   * then the stream — which is what this sends, in that order.
   */
  playLoop(
    channel: TrailsChannel,
    steps?: number,
    from?: { x: number; y: number },
    to?: { x: number; y: number },
  ): void;
  /** The device's per-repetition loop-restart message. Byte-identical to
   *  `start()`; named for what the hardware means by it, because on this device
   *  a Start is not a once-per-session event. */
  loopRestart(): void;
  /** `n` MIDI clock ticks (0xF8). 24 of them is one quarter note. */
  clock(n?: number): void;
  /** MIDI Start (0xFA) — running, and re-zero any divider. */
  start(): void;
  /** MIDI Stop (0xFC). */
  stop(): void;
  /** Are the app's handlers attached yet? False before `connectTrails()`. */
  attached(): boolean;
  /** Remove the fake ports and release the claim. */
  uninstall(): void;
}

export interface SimulatedTrailsOptions {
  /** Defaults to a name the real matcher accepts. */
  portName?: string;
  /** Add a second, identically-named port — the Windows WinMM duplicate shape.
   *  Both get attached; a frame sent goes to whichever the test names. */
  duplicatePort?: boolean;
  /** Add a port that must NOT match, as the negative control. */
  decoyPortName?: string;
}

interface SimInput extends MidiInputLike {
  onmidimessage: ((ev: MidiEventLike) => void) | null;
}

function makeSimInput(id: string, name: string): SimInput {
  return { id, name, manufacturer: 'Bela', state: 'connected', onmidimessage: null };
}

/**
 * Install an in-memory Trails and connect to it.
 *
 * Synchronous in effect but returns a promise, because `connectTrails` is
 * async: `await installSimulatedTrails()` leaves the ports attached and the
 * status `bound`.
 */
export async function installSimulatedTrails(
  opts: SimulatedTrailsOptions = {},
): Promise<SimulatedTrails> {
  const portName = opts.portName ?? 'Bela Trails';
  const inputs = new Map<string, SimInput>();
  const primary = makeSimInput('sim-trails-0', portName);
  inputs.set(primary.id, primary);
  if (opts.duplicatePort) {
    const dup = makeSimInput('sim-trails-1', portName);
    inputs.set(dup.id, dup);
  }
  if (opts.decoyPortName) {
    const decoy = makeSimInput('sim-decoy-0', opts.decoyPortName);
    inputs.set(decoy.id, decoy);
  }

  const simAccess: TrailsAccessLike = { inputs, onstatechange: null };
  await connectTrails(async () => simAccess);

  /** The fake ports the REAL matcher would bind — never the decoy, so the
   *  double cannot deliver on a port the app would have ignored.
   *
   *  ⚠ A `.filter()` rather than a `for (… of inputs.values())` loop, and that
   *  is not style: `midi-input-ownership.test.ts` reddens any file containing a
   *  `for (const x of …inputs.values())` whose body then mentions
   *  `x.onmidimessage =`, and its regex cannot tell an assignment from the
   *  `typeof x.onmidimessage === 'function'` guard this code needs. Keeping the
   *  handler reads out of that shape keeps the gate's signal honest. */
  function boundInputs(): SimInput[] {
    return [...inputs.values()].filter(isTrailsPort);
  }

  function send(bytes: readonly number[]): void {
    const ev: MidiEventLike = {
      data: Uint8Array.from(bytes),
      timeStamp: typeof performance !== 'undefined' ? performance.now() : Date.now(),
    };
    for (const handler of boundInputs().map((i) => i.onmidimessage)) {
      if (typeof handler === 'function') handler(ev);
    }
  }

  /** Named rather than an object method so `playLoop` can call it without
   *  `this` — a destructured `const { playLoop } = sim` would otherwise throw,
   *  and a test double that breaks on destructuring is a trap. */
  function glide(
    channel: TrailsChannel,
    steps: number,
    from: { x: number; y: number } = { x: 0, y: 0 },
    to: { x: number; y: number } = { x: 1, y: 1 },
  ): void {
    const n = Math.max(1, Math.floor(steps));
    for (let i = 0; i < n; i++) {
      // n === 1 would divide by zero; a single-sample glide sits at `from`,
      // which is the honest reading of "one sample of this path".
      const t = n === 1 ? 0 : i / (n - 1);
      const x = from.x + (to.x - from.x) * t;
      const y = from.y + (to.y - from.y) * t;
      for (const frame of encodeTrailsAxis({ channel, axis: 'x' }, x)) send(frame);
      for (const frame of encodeTrailsAxis({ channel, axis: 'y' }, y)) send(frame);
    }
  }

  return {
    portName,
    send,
    touch(channel, x, y) {
      for (const frame of encodeTrailsAxis({ channel, axis: 'x' }, x)) send(frame);
      for (const frame of encodeTrailsAxis({ channel, axis: 'y' }, y)) send(frame);
    },
    gateOn(channel) {
      send(encodeTrailsGate(channel, true));
    },
    gateOff(channel) {
      send(encodeTrailsGate(channel, false));
    },
    noteTouch(channel, xNote, yNote, velocity = 100) {
      send(encodeTrailsNote({ channel, axis: 'x' }, xNote, velocity));
      send(encodeTrailsNote({ channel, axis: 'y' }, yNote, velocity));
    },
    noteRelease(channel, xNote, yNote) {
      send(encodeTrailsNote({ channel, axis: 'x' }, xNote, 0));
      send(encodeTrailsNote({ channel, axis: 'y' }, yNote, 0));
    },
    glide,
    loopRestart() {
      send([0xfa]);
    },
    playLoop(channel, steps = 8, from = { x: 0, y: 0 }, to = { x: 1, y: 1 }) {
      send([0xfa]);
      glide(channel, steps, from, to);
    },
    clock(n = 1) {
      for (let i = 0; i < n; i++) send([0xf8]);
    },
    start() {
      send([0xfa]);
    },
    stop() {
      send([0xfc]);
    },
    attached() {
      return boundInputs().some((i) => typeof i.onmidimessage === 'function');
    },
    uninstall() {
      inputClaim.detach();
      if (access === simAccess) {
        access.onstatechange = null;
        access = null;
        accessKind = 'idle';
      }
      attachedNames = [];
      bump();
    },
  };
}

/** Drop every binding + subscriber. Unit-test hygiene only. */
export function __resetTrailsForTest(): void {
  inputClaim.detach();
  subscribers.clear();
  if (access) access.onstatechange = null;
  access = null;
  accessKind = 'idle';
  accessMessage = '';
  connectInFlight = false;
  attachedNames = [];
}
