// packages/web/src/lib/midi/midi-clock-source.ts
//
// Shared MIDI-CLOCK tempo source — a small singleton (TIMELORDE-style) that
// listens for MIDI System Real-Time Clock messages (0xF8) on ALL active MIDI
// inputs, counts the fixed 24 PPQN, and derives an instantaneous BPM.
//
// Why a singleton (and separate from the MIDICLOCK *module*):
//   * The MIDICLOCK module turns 0xF8 into a patchable *gate* — you must
//     drop the node + patch a cable. COCOA DELAY's `clockSource = MIDI`
//     wants the *tempo* of the incoming transport WITHOUT requiring a node
//     in the patch, mirroring how `clockSource = System` reads TIMELORDE's
//     bpm straight off the graph.
//   * Any number of consumers (COCOA today, more later) can subscribe to one
//     canonical MIDI tempo, exactly like every sequencer rides one TIMELORDE.
//
// It attaches strictly ON DEMAND: constructing the source does NOT touch Web
// MIDI. navigator.requestMIDIAccess() (which shows the browser permission
// prompt) is only fired the FIRST TIME a consumer actually READS the tempo —
// i.e. calls getBpm()/getBeatPeriodS(). Holding the source object for period
// math while the user has NOT chosen MIDI as the clock therefore never
// prompts. Once access resolves the derived BPM is readable synchronously.
// Consumers that can't get MIDI access (no Web MIDI, denied) simply read null
// and fall back.

import {
  webMidiAvailable,
  type MidiAccessLike,
  type MidiEventLike,
} from '$lib/audio/modules/midi-cv-buddy';

/** MIDI clock is fixed at 24 pulses per quarter note. */
const MIDI_PPQN = 24;
const STATUS_CLOCK = 0xf8;
const STATUS_START = 0xfa;
const STATUS_STOP = 0xfc;

/** Ignore implausibly fast/slow derived rates (jitter / partial bursts).
 *  10–300 BPM matches TIMELORDE's own bpm param range. */
const MIN_BPM = 10;
const MAX_BPM = 300;

/** If no 0xF8 arrives for this long, consider the transport idle and stop
 *  reporting a (now stale) BPM. */
const STALE_TIMEOUT_MS = 1500;

export interface MidiClockSource {
  /** Latest derived BPM, or null when no live MIDI clock is being received
   *  (no access, transport stopped, or stale). Synchronous — safe to poll. */
  getBpm(): number | null;
  /** Beat (quarter-note) period in seconds, or null. Convenience for callers
   *  that bridge a seconds-per-beat value to a worklet. */
  getBeatPeriodS(): number | null;
  /** Test/inspection hook: feed a raw MIDI status byte at a perf-now ms. */
  ingest(status: number, atMs: number): void;
  /** Tear down the MIDI access + timers (test cleanup / HMR). */
  destroy(): void;
}

interface Deps {
  now(): number;
  requestAccess(): Promise<MidiAccessLike>;
  available(): boolean;
}

const browserDeps: Deps = {
  now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  requestAccess: () => (navigator as any).requestMIDIAccess({ sysex: false }),
  available: webMidiAvailable,
};

export function createMidiClockSource(depsOverride: Partial<Deps> = {}): MidiClockSource {
  const deps: Deps = { ...browserDeps, ...depsOverride };

  let bpm: number | null = null;
  let lastClockAtMs: number | null = null;
  // Smoothed period in ms PER PULSE (24 of these = one quarter note).
  let pulsePeriodMs: number | null = null;
  let access: MidiAccessLike | null = null;
  let running = true; // assume free-running clock if no Start/Stop framing
  // ON-DEMAND access: not requested at construction. ensureAccess() fires the
  // browser permission prompt exactly once, lazily, on the first tempo read.
  let accessRequested = false;
  let destroyed = false;

  function ingest(status: number, atMs: number): void {
    if (status === STATUS_STOP) {
      running = false;
      bpm = null;
      pulsePeriodMs = null;
      lastClockAtMs = null;
      return;
    }
    if (status === STATUS_START) {
      running = true;
      lastClockAtMs = null; // first interval after Start is meaningless
      return;
    }
    if (status !== STATUS_CLOCK) return;
    running = true;
    if (lastClockAtMs !== null) {
      const dt = atMs - lastClockAtMs;
      if (dt > 0) {
        // One-pole smoothing of the per-pulse interval to ride out jitter.
        pulsePeriodMs = pulsePeriodMs === null ? dt : pulsePeriodMs + (dt - pulsePeriodMs) * 0.25;
        const quarterMs = pulsePeriodMs * MIDI_PPQN;
        const derived = 60000 / quarterMs;
        if (derived >= MIN_BPM && derived <= MAX_BPM) bpm = derived;
      }
    }
    lastClockAtMs = atMs;
  }

  function fresh(): boolean {
    if (!running) return false;
    if (lastClockAtMs === null) return false;
    return deps.now() - lastClockAtMs <= STALE_TIMEOUT_MS;
  }

  function getBpm(): number | null {
    // Reading the tempo is the ON-DEMAND trigger: only a consumer that has
    // actually chosen MIDI as its clock reads the BPM, so requesting MIDI
    // access here (and not at construction) keeps the permission prompt
    // strictly tied to a real MIDI-clock action — never a mere spawn/boot.
    ensureAccess();
    return fresh() ? bpm : null;
  }

  function getBeatPeriodS(): number | null {
    const b = getBpm();
    return b !== null ? 60 / b : null;
  }

  // ---- on-demand auto-attach to all MIDI inputs ----
  function handle(ev: MidiEventLike): void {
    const data = ev.data;
    if (data.length < 1) return;
    ingest(data[0]!, deps.now());
  }
  function attachAll(): void {
    if (!access) return;
    for (const inp of access.inputs.values()) inp.onmidimessage = handle;
  }
  /** Fire navigator.requestMIDIAccess() once, lazily. No-op after the first
   *  call (and after destroy()), so polling getBpm() prompts at most once. */
  function ensureAccess(): void {
    if (accessRequested || destroyed) return;
    accessRequested = true;
    if (!deps.available()) return;
    deps
      .requestAccess()
      .then((a) => {
        if (destroyed) {
          // destroyed mid-flight — don't attach a now-orphaned access.
          for (const inp of a.inputs.values()) inp.onmidimessage = null;
          a.onstatechange = null;
          return;
        }
        access = a;
        attachAll();
        access.onstatechange = () => attachAll();
      })
      .catch(() => {
        /* denied / unavailable — getBpm() stays null, callers fall back */
      });
  }

  return {
    getBpm,
    getBeatPeriodS,
    ingest,
    destroy() {
      destroyed = true;
      if (access) {
        for (const inp of access.inputs.values()) inp.onmidimessage = null;
        access.onstatechange = null;
        access = null;
      }
      bpm = null;
      pulsePeriodMs = null;
      lastClockAtMs = null;
    },
  };
}

let singleton: MidiClockSource | null = null;

/** Lazily construct the process-wide MIDI clock source. Constructing it does
 *  NOT request Web MIDI access — that happens on the first getBpm()/
 *  getBeatPeriodS() read (see createMidiClockSource). A consumer can hold this
 *  object for period math without prompting until it actually reads the tempo. */
export function getMidiClockSource(): MidiClockSource {
  if (!singleton) singleton = createMidiClockSource();
  return singleton;
}

/** Test-only: drop the singleton so the next get() rebuilds it. */
export function __resetMidiClockSourceForTests(): void {
  singleton?.destroy();
  singleton = null;
}
