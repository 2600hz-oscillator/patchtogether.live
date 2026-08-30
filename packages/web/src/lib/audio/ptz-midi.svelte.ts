// PT-PTZ binding singleton — one per app, like the launchpad/push2 device
// singletons. Owns its own `requestMIDIAccess({ sysex: true })`: the shared
// `$lib/audio/midi-access` seam is sysex:false BY DESIGN and three modules
// depend on that, so this follows the electra-broker convention of one access
// per controller family rather than widening the seam. Reuses the shared
// outcome COPY (`midiOutcomeMessage`) so the NO is explained in the same words
// everywhere.
//
// Never requests access at load — `midi.spec.ts` pins "page load never
// requests Web-MIDI access". `connect()` is called synchronously from the
// card's click handler (an await above it would spend the user activation and
// Chromium refuses to prompt).

import {
  MIDI_PROMPT_TIMEOUT_MS,
  midiOutcomeMessage,
  type MidiAccessOutcome,
} from '$lib/audio/midi-access';
import { buildCapsRequest, parsePtzFrame, type PtzCaps } from '$lib/audio/ptz-sysex';

export const PTZ_PORT_NAME = 'PT-PTZ';
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

interface MidiPortLike {
  readonly id: string;
  readonly name?: string | null;
}
interface MidiOutputLike extends MidiPortLike {
  send(data: number[] | Uint8Array): void;
}
interface MidiInputLike extends MidiPortLike {
  onmidimessage: ((e: { data: Uint8Array | null }) => void) | null;
}
export interface PtzMidiAccessLike {
  readonly inputs: ReadonlyMap<string, MidiInputLike>;
  readonly outputs: ReadonlyMap<string, MidiOutputLike>;
  onstatechange: ((e?: unknown) => void) | null;
}
type PtzRequestFn = () => Promise<PtzMidiAccessLike>;

let statusVersion = $state(0);
export function ptzStatusRune(): number {
  return statusVersion;
}
function bump(): void {
  statusVersion++;
}

let access: PtzMidiAccessLike | null = null;
let output: MidiOutputLike | null = null;
let input: MidiInputLike | null = null;
let caps: PtzCaps | null = null;
let kind: PtzBindKind = 'idle';
let capsTimer: ReturnType<typeof setTimeout> | null = null;
let connectInFlight = false;

function setKind(next: PtzBindKind): void {
  if (kind === next) return;
  kind = next;
  bump();
}

function clearCapsTimer(): void {
  if (capsTimer !== null) clearTimeout(capsTimer);
  capsTimer = null;
}

function onFrame(data: ArrayLike<number> | null): void {
  if (!data) return;
  const frame = parsePtzFrame(data);
  if (!frame) return;
  clearCapsTimer();
  if (frame.kind === 'caps') {
    caps = frame.caps;
    setKind('bound');
    bump();
  } else if (frame.name === 'camera-absent') {
    setKind('camera-absent');
  }
}

function isPtzPort(p: MidiPortLike): boolean {
  return (p.name ?? '').toUpperCase().includes(PTZ_PORT_NAME);
}

function resolvePorts(): void {
  if (!access) return;
  const out = [...access.outputs.values()].find(isPtzPort) ?? null;
  const inp = [...access.inputs.values()].find(isPtzPort) ?? null;
  if (input && input !== inp) input.onmidimessage = null;
  output = out;
  input = inp;
  if (!out || !inp) {
    caps = null;
    setKind('no-port');
    bump();
    return;
  }
  inp.onmidimessage = (e) => onFrame(e.data);
  requestCaps();
}

function requestCaps(): void {
  if (!output) return;
  setKind('binding');
  clearCapsTimer();
  try {
    output.send(buildCapsRequest());
  } catch {
    resolvePorts();
    return;
  }
  capsTimer = setTimeout(() => {
    if (kind === 'binding') setKind('no-reply');
  }, CAPS_REPLY_TIMEOUT_MS);
}

const defaultRequest: PtzRequestFn = () =>
  (navigator as unknown as { requestMIDIAccess: (o: { sysex: boolean }) => Promise<PtzMidiAccessLike> })
    .requestMIDIAccess({ sysex: true });

/** Call synchronously from a user gesture. Safe to call again — re-resolves. */
export function connectPtzMidi(request?: PtzRequestFn): Promise<void> {
  if (access) {
    resolvePorts();
    return Promise.resolve();
  }
  if (connectInFlight) return Promise.resolve();
  if (
    !request &&
    (typeof navigator === 'undefined' ||
      typeof (navigator as { requestMIDIAccess?: unknown }).requestMIDIAccess !== 'function')
  ) {
    setKind('unsupported');
    return Promise.resolve();
  }
  connectInFlight = true;
  const pending = (request ?? defaultRequest)();
  const timer = setTimeout(() => {
    connectInFlight = false;
    if (kind === 'idle') setKind('no-prompt');
  }, MIDI_PROMPT_TIMEOUT_MS);
  return pending
    .then((a) => {
      // A grant after the no-prompt heuristic fired still binds — the user
      // answered the prompt eventually (midi-access onLateResolve shape).
      clearTimeout(timer);
      connectInFlight = false;
      access = a;
      a.onstatechange = () => resolvePorts();
      resolvePorts();
    })
    .catch(() => {
      clearTimeout(timer);
      connectInFlight = false;
      setKind('denied');
    });
}

export function sendPtzFrame(bytes: Uint8Array): boolean {
  if (!output) return false;
  try {
    output.send(bytes);
    return true;
  } catch {
    resolvePorts();
    return false;
  }
}

export function getPtzCaps(): PtzCaps | null {
  return caps;
}

export interface PtzStatus {
  readonly kind: PtzBindKind;
  readonly message: string;
  readonly caps: PtzCaps | null;
}

const OUTCOME_FOR_COPY: Partial<Record<PtzBindKind, MidiAccessOutcome>> = {
  unsupported: { kind: 'unsupported' },
  'no-prompt': { kind: 'no-prompt' },
  denied: { kind: 'denied', message: '' },
};

export function ptzStatus(): PtzStatus {
  let message = '';
  const shared = OUTCOME_FOR_COPY[kind];
  if (shared) message = midiOutcomeMessage(shared);
  else if (kind === 'idle') message = 'Not connected. Connect grants MIDI and finds the PT-PTZ helper.';
  else if (kind === 'no-port')
    message = `No MIDI port named ${PTZ_PORT_NAME}. Start the helper (start_ptz.sh) — it binds the moment the port appears.`;
  else if (kind === 'binding') message = `${PTZ_PORT_NAME} found — requesting camera caps…`;
  else if (kind === 'no-reply')
    message =
      'Helper port found but no caps reply. If the helper log is quiet, the browser is dropping sysex — relaunch it with --disable-features=MidiMacUmp (start_edge.sh).';
  else if (kind === 'camera-absent')
    message = 'Helper is running but the camera is absent. Plug in the NexiGo P610 — it rebinds automatically.';
  else if (kind === 'bound') message = 'Bound — camera caps received.';
  return { kind, message, caps };
}

export function __resetPtzMidiForTest(): void {
  clearCapsTimer();
  if (input) input.onmidimessage = null;
  if (access) access.onstatechange = null;
  access = null;
  output = null;
  input = null;
  caps = null;
  kind = 'idle';
  connectInFlight = false;
}
