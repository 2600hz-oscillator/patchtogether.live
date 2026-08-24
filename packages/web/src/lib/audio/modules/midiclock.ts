// packages/web/src/lib/audio/modules/midiclock.ts
//
// MIDICLOCK — bridges a hardware MIDI device's TRANSPORT into the patch.
// Sibling to MIDI-CV-BUDDY (which handles note/velocity per channel);
// MIDICLOCK is transport-only:
//
//   clock     — gate. Rising edge every N MIDI clock ticks. MIDI is fixed
//               at 24 PPQN, so N=24 → one edge per quarter note (TIMELORDE
//               compatible — patch MIDICLOCK.clock → TIMELORDE.clock to
//               slave TimeLorde to the external transport). Other values:
//               12=eighth, 6=sixteenth, 3=32nd, 1=raw 24 PPQN.
//   run       — cv. 0 while transport stopped, 1 while running.
//   midistart — gate. One-shot rising edge on MIDI Start (0xFA).
//   midistop  — gate. One-shot rising edge on MIDI Stop (0xFC).
//
// MIDI Continue (0xFB) raises `run` to 1 but does NOT fire midistart;
// Continue exists precisely to resume without re-zeroing downstream
// loops, so a midistart pulse would lie about intent.
//
// Implementation parallels midi-cv-buddy: one ConstantSourceNode per
// output, main-thread event handler, setValueAtTime with the shared
// SCHED_LOOKAHEAD_S so edges land at the start of the next audio block.
//
// Inputs: none. MIDI source is the host device, picked from the faceplate's
// device body (the dock full view) or the legacy card's dropdown.
//
// Outputs:
//   clock (gate): rising edge every N MIDI clock ticks (N set by user; 24 = quarter, 12 = eighth, etc).
//   run (cv): 0 while transport stopped, 1 while running (latched on MIDI Continue too).
//   midistart (gate): one-shot pulse on MIDI Start (0xFA).
//   midistop (gate): one-shot pulse on MIDI Stop (0xFC).
//
// Params: `divisor` — the clock division, ONE param. See the declaration below
// for why it stopped being a `node.data` key.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import { snapToOptions } from '$lib/ui/controls/knob-vocabulary-model';
import {
  webMidiAvailable,
  type MidiAccessLike,
  type MidiEventLike,
} from './midi-cv-buddy';
// Timestamp-projection scheduling lives in ONE shared place so all three MIDI
// bridges (MIDICLOCK, MIDI-CV-BUDDY, MIDI LANE) use the same proven math and it
// can't silently drift into "fixed in 1 of 3" again (the original root cause of
// note-jitter under load). See packages/web/src/lib/audio/midi-timing.ts.
import { createMidiScheduler } from '$lib/audio/midi-timing';
import { createMidiInputClaim } from '$lib/midi/input-attach';
import { requestMidiAccess, midiOutcomeMessage } from '$lib/audio/midi-access';
import type { ModuleFace, ParamDef } from '$lib/graph/types';
// Re-exported for callers/tests that historically imported these from midiclock.
export {
  MIDI_PPQN,
  TIMESTAMP_LOOKAHEAD_S,
  MAX_TIMESTAMP_LAG_MS,
  measureCtxOffset,
  eventTimeStampToAudioTime,
} from '$lib/audio/midi-timing';

// ---------------- MIDI System Real-Time status bytes ----------------
const STATUS_CLOCK = 0xf8;
const STATUS_START = 0xfa;
const STATUS_CONT  = 0xfb;
const STATUS_STOP  = 0xfc;

/** One-shot gate-pulse width. Wide enough that downstream gate-input
 *  modules audio-block-align onto a clean rising edge; narrow enough
 *  that raw-mode (N=1) ticks at 240 BPM (≈ 10 ms between) still produce
 *  a falling edge between adjacent pulses. */
export const GATE_PULSE_S = 0.005;

// ---------------- Pure helpers (testable) ----------------

/** True if a MIDI status byte is a System Real-Time message (0xF8..0xFF).
 *  Channel filtering does NOT apply to these — they're broadcast. */
export function isSystemRealTime(status: number): boolean {
  return status >= 0xf8 && status <= 0xff;
}

/** Allowed clock-divisor values (input MIDI ticks per output edge).
 *  24=quarter (TIMELORDE-compatible), 12=eighth, 6=sixteenth, 3=32nd,
 *  1=raw 24 PPQN. */
export const CLOCK_DIVISORS = [24, 12, 6, 3, 1] as const;
export type ClockDivisor = (typeof CLOCK_DIVISORS)[number];

export function isValidDivisor(n: unknown): n is ClockDivisor {
  return typeof n === 'number' && (CLOCK_DIVISORS as readonly number[]).includes(n);
}

/** Display label for a divisor — used by the card's select AND by the param's
 *  own `options` roster, so the two cannot name the same division differently. */
export function divisorLabel(d: ClockDivisor): string {
  if (d === 24) return '1/4';
  if (d === 12) return '1/8';
  if (d === 6)  return '1/16';
  if (d === 3)  return '1/32';
  return 'raw';
}

/**
 * THE CLOCK DIVISION, AS A REAL PARAM.
 *
 * ⚠ IT USED TO LIVE IN `node.data`, AND THE DEF ARGUED FOR THAT — this
 * declaration overturns a REASONED decision, not an oversight. The old
 * `docs.explanation` said there were "no audio-side knobs because every setting
 * (device + division) is a discrete choice that lives in the saved patch, not a
 * continuous AudioParam". That is correct about an AudioParam and wrong about a
 * `ParamDef`: a discrete option roster is first-class (`ParamDef.options`), and
 * the two settings are NOT the same kind of thing. The DEVICE's roster lives on
 * the engine handle behind `requestMIDIAccess()` and differs per machine — it
 * genuinely cannot be a roster known at authoring time. The DIVISION's roster
 * is `CLOCK_DIVISORS`, right here, exported, with a label function and a
 * validator, and has been since the module shipped.
 *
 * What one declaration buys, none of it needing further work: clip automation,
 * MIDI learn, group exposure (`group-controls.ts`), a Push 2 card where there
 * was none, and — the one that is a bug fix — UNDO, because `setNodeParam` is
 * the origin-tagged seam and the card's `writeData` never was.
 *
 * ⚠ `optionsExhaustive` IS REQUIRED HERE, NOT POLISH. `1..24 discrete` has 24
 * reachable steps and this roster names five, so without the clause
 * `param-vocabulary` reddens on "a state the dial can reach and the picker
 * cannot name". The clause's own contract is that the param must SNAP — see
 * `snapDivisor` below, which is the one implementation and is applied at the
 * point of use rather than at a point of arrival.
 */
export const MIDICLOCK_DIVISOR_PARAM: ParamDef = {
  id: 'divisor',
  label: 'Div',
  defaultValue: 24,
  min: 1,
  max: 24,
  curve: 'discrete',
  options: CLOCK_DIVISORS.map((d) => ({
    value: d as number,
    label: divisorLabel(d),
    title:
      d === 1
        ? 'raw — one pulse per incoming MIDI tick (the full 24 PPQN stream)'
        : `${divisorLabel(d)} note — one pulse every ${24 / d} MIDI tick${24 / d === 1 ? '' : 's'}`,
  })),
  optionsExhaustive: {
    why:
      'MIDI is fixed at 24 pulses per quarter note, so a division is only musically meaningful '
      + 'when it divides 24 EVENLY — these five are the whole-note-value divisions (quarter, '
      + 'eighth, sixteenth, thirty-second) plus the undivided stream. The nineteen integers in '
      + 'between are not unnamed states, they are values this module has no meaning for: '
      + 'dividing by 7 emits an edge every 7/24 of a beat, which lands on no note value and '
      + 'drifts against every other clock in the rack. The card could never produce one '
      + '(`isValidDivisor` has gated its `<select>` since the module shipped), and a rack '
      + 'holding one would slave TIMELORDE to a pulse train the external transport does not '
      + 'agree with.',
  },
};

/**
 * Land any number on a legal division.
 *
 * ⚠ THE POINT OF USE, NOT A POINT OF ARRIVAL, and deliberately NOT written back
 * — the `cvBuddy.ppqn` precedent (`snapPpqn`), for the same three reasons. A
 * rack saved before this declaration can hold `data.divisor` and arrives by
 * routes that pass through no loader at all (an IndexedDB replica restore, a
 * peer's Y update, an undo); snapping here covers every one of them. And the
 * value is NOT repaired in the graph: correcting the live node from the engine
 * would be an untagged Y.Doc write, and `types.ts` states the rule directly —
 * "a silent engine-side repair of a data-integrity bug is indistinguishable
 * from no bug". A legacy rack CLOCKS at its nearest legal division and SHOWS
 * that same division, and the first ordinary tagged write normalizes it.
 */
export function snapDivisor(v: number): ClockDivisor {
  return snapToOptions(v, MIDICLOCK_DIVISOR_PARAM.options ?? []) as ClockDivisor;
}

/** The resting division, read off the param so the def and every fallback path
 *  cannot disagree about what "default" means. */
export const DEFAULT_DIVISOR = MIDICLOCK_DIVISOR_PARAM.defaultValue as ClockDivisor;

// ---------------- Tempo-stability helpers ----------------
//
// The timestamp-projection scheduling (measureCtxOffset /
// eventTimeStampToAudioTime / createMidiScheduler) now lives in the shared
// $lib/audio/midi-timing module so MIDICLOCK, MIDI-CV-BUDDY and MIDI LANE all
// use one proven implementation. The pure helpers are re-exported from this
// module (see the export block above) for back-compat with existing importers.
//
// NOTE: the projection constants/helpers that used to live here were hoisted
// verbatim into $lib/audio/midi-timing.ts and are re-exported above.

// ---------------- Card-visible state + saved data ----------------

export interface MidiclockCardState {
  connected: boolean;
  permissionDenied: boolean;
  /** Human-readable reason the last connect failed ('' when fine). */
  accessMessage: string;
  devices: Array<{ id: string; name: string; state: string }>;
  selectedDeviceId: string | null;
  running: boolean;
  divisor: ClockDivisor;
  /** Total clock ticks observed since the last successful Connect.
   *
   *  ⚠ READ ON DEMAND, NEVER PUSHED. This comment used to promise a "live
   *  activity indicator" the card was painting; it was not — see the CLOCK
   *  branch of `handleMidiMessage` for the whole story. `notify()` fires only
   *  on transport messages, so a SUBSCRIBER sees this move at START / CONTINUE
   *  / STOP and nowhere else. Anything wanting a live count polls `getState()`. */
  ticksReceived: number;
}

export interface MidiclockData {
  /** ⚠ LEGACY. The division is a `ParamDef` now (`MIDICLOCK_DIVISOR_PARAM`) and
   *  lives in `node.params`. This key survives ONLY so racks saved before that
   *  keep clocking at the division their author chose — it is READ once in the
   *  factory, after `params`, and never written again. Nothing should write it. */
  divisor?: ClockDivisor;
  /** Restored on reconnect so the user doesn't have to re-pick. */
  lastDeviceId: string | null;
}

export const DEFAULT_DATA: MidiclockData = {
  lastDeviceId: null,
};

export interface MidiclockApi {
  connect(): Promise<boolean>;
  selectDevice(deviceId: string | null): void;
  setDivisor(d: ClockDivisor): void;
  getState(): MidiclockCardState;
  subscribe(cb: (s: MidiclockCardState) => void): () => void;
}

// ---------------- The FACE ----------------

/**
 * THE FACEPLATE. Two ranked cells, one band, one device body.
 *
 * WHAT THE MODULE IS FOR, in one sentence, because every rank descends from it:
 * letting something OUTSIDE the browser be the boss. Everything else in the
 * rack can generate its own time; this is the one module whose entire job is to
 * surrender that and follow a hardware sequencer, a drum machine or a DAW. So
 * the face is one CHOICE (how fast) and one BINDING (which device) — and the
 * binding is a permission gesture, not a value.
 *
 * THE TIER LADDER, as a sentence: at every tier the player sees the division
 * and the connect gesture, because with two ranked keys there is no tier that
 * has to drop one. That is the whole ladder, and it is the correct outcome of
 * "compact is the default" rather than a thin face.
 *
 * ⚠ `glyph: 'none'` IS MECHANICALLY FORCED, not a preference. `glyphBinding`
 * short-circuits on `primaryAudioOutPortId`, which is
 * `outputs.find(o => o.type === 'audio')?.id` — `type === 'audio'` exactly.
 * These four outputs are gate/cv/gate/gate, so that resolves null, no
 * `live-audio` binding is reachable, and every other literal falls through to
 * `{ kind: 'static' }`, which `module-face-lint`'s dead-glyph clause reddens
 * unconditionally with no exemption list.
 *
 * ⚠ AND THE PICTURE THIS MODULE WOULD WANT DOES NOT EXIST, which is recorded as
 * an argument rather than built. The useful glance here is "is a clock
 * ARRIVING?" — a blinking tick indicator. That is not a picture of a signal, it
 * is a picture of an EVENT RATE, and all five `VALID_GLYPHS` members
 * (scope/meter/envelope/waveform/algorithm) describe a continuous audio
 * quantity. Inventing a sixth on a module PR is the wrong shape; the binder
 * cohort makes the same argument for four more modules, which is the evidence a
 * platform change should wait for.
 *
 * ⚠ A PUSH 2 CARD APPEARS WHERE THERE WAS NONE, and it is deliberately NOT
 * pinned with a `PUSH_CARD_CONTROLS` override. The card is resolved from the
 * LIVE def, so adding a param normally risks the tiers re-ranking themselves —
 * but re-ranking needs COMPETITION for slots and there is none here: one
 * turnable param against eight encoder strips, with the CONNECT family skipped
 * because an encoder can only turn a value. An override would be byte-identical
 * to what the FACE tier already derives, and it REPLACES rather than merges, so
 * pinning would silently keep a future second param off the hardware forever.
 * That is chromaconsole's argument read the other way round: correct by
 * construction, not correct because somebody remembered to pin it.
 *
 * ⚠ BOTH CELLS REACH THE LANE, and D4's fix depends entirely on it. Only the
 * `panel` kind is dock-only (`panelCellKeys` filters on `kind === 'panel'`); an
 * `action` cell is not restricted, and `laneOrder` drops exactly a declared
 * `hero.cell` and each `xyPads` entry's `x` key — this face declares neither.
 * So the CONNECT gesture stops being reachable only from the dock full view,
 * which on a module that does NOTHING until it is granted access is the single
 * biggest thing promotion changes for a player.
 */
export const MIDICLOCK_FACE: ModuleFace = {
  glyph: 'none',
  order: ['divisor', 'midiclock-connect-{n}'],
  extension: 'midiclock',
  pages: [
    {
      id: 'transport',
      label: 'transport',
      hint:
        'MIDI carries a fixed 24 pulses per quarter note; DIV is how many of them go by between '
        + 'edges on the CLOCK jack, so 1/4 is one edge per beat (what TIMELORDE and most gear '
        + 'expect), 1/16 is four, and `raw` passes the whole 24 PPQN stream through. Changing it '
        + 're-zeros the divider, so a mid-song change lands on a clean edge instead of partway '
        + 'through a count. CONNECT MIDI is the one-time-per-origin permission gesture — until it '
        + 'is granted this module has no device to listen to and every jack sits at rest.',
      controls: ['divisor', 'midiclock-connect-{n}'],
    },
  ],
};

// ---------------- Module def ----------------

export const midiclockDef: AudioModuleDef = {
  type: 'midiclock',
  palette: { top: 'MIDI', sub: 'MIDI' },
  domain: 'audio',
  label: 'midiclock',
  category: 'sources',

  inputs: [],
  outputs: [
    { id: 'clock',     type: 'gate', edge: 'trigger' },
    { id: 'run',       type: 'cv'   },
    { id: 'midistart', type: 'gate', edge: 'trigger' },
    { id: 'midistop',  type: 'gate', edge: 'trigger' },
  ],
  params: [MIDICLOCK_DIVISOR_PARAM],

  face: MIDICLOCK_FACE,

  controlFamilies: [
    { id: 'midiclock-connect', label: 'Connect MIDI', kind: 'other', testidPrefix: 'midiclock-connect' },
  ],

  docs: {
    explanation:
      "Brings an external MIDI device's TRANSPORT into the patch as clock and run signals — the transport-only sibling of MIDI-CV-BUDDY (which carries the notes). MIDI sends 24 clock ticks per quarter note, plus Start / Stop / Continue messages; MIDICLOCK divides that tick stream down to a usable pulse and tracks the play state. Mental model: it's the bridge that lets a hardware sequencer, drum machine, or DAW be the master clock for the whole rack — connect a class-compliant USB-MIDI device, pick it from the faceplate's device body, and patch its CLOCK output into anything that wants a beat (a SEQUENCER's CLOCK IN, TIMELORDE, an envelope trigger). Two settings, and they are deliberately different kinds of thing: the DIVISION is a param, so it can be automated, MIDI-learned, exposed on a group and undone like any other value; the DEVICE is not, because its roster lives behind the browser's own MIDI permission and differs on every machine — it is picked from the dock's device body and remembered per patch. Nothing at all happens until MIDI access is granted, which is one click, once per origin.",
    inputs: {},
    outputs: {
      clock:
        "A short ~5 ms pulse whose rising edge fires once every N incoming MIDI ticks, where N is the card's clock-division setting (MIDI runs at a fixed 24 ticks per quarter note, so N=24 gives one pulse per quarter note, 12 an eighth, 6 a sixteenth, 3 a 32nd, and 1 the raw 24-PPQN tick stream). Patch it into a SEQUENCER's CLOCK IN or TIMELORDE to slave the rack's timing to the external transport. On a MIDI Start the divider re-zeros so the first pulse lands cleanly on the downbeat.",
      run:
        "A level that sits at 0 while the external transport is stopped and rises to 1 while it is running; it latches to 1 on both MIDI Start and MIDI Continue and drops to 0 on MIDI Stop. Use it as a gate to enable downstream modules only while the master transport is playing.",
      midistart:
        "A one-shot pulse whose rising edge fires the instant a MIDI Start message (0xFA) arrives — the 'play from the top' signal. It does NOT fire on MIDI Continue, because Continue exists precisely to resume mid-song without re-zeroing downstream loops; patch this into a reset/restart input to snap things back to the beginning when the transport starts fresh.",
      midistop:
        "A one-shot pulse whose rising edge fires when a MIDI Stop message (0xFC) arrives. Patch it where you want something to fire exactly when the external transport halts (mute an envelope, reset a counter, drop a gate).",
    },
    controls: {
      divisor:
        "How many incoming MIDI ticks go by between edges on the CLOCK jack. MIDI is fixed at 24 pulses per quarter note, so 1/4 (24) emits one edge per beat — the setting TIMELORDE and most hardware expect — while 1/8, 1/16 and 1/32 subdivide it and `raw` (1) passes the whole 24 PPQN stream through unchanged. Only these five are offered because only they divide 24 evenly: a division that does not lands on no note value and drifts against every other clock in the room. Changing it re-zeros the divider, so a mid-song change starts counting from the next tick rather than partway through, and the first edge afterwards is clean.",
      'midiclock-connect-{n}':
        "The one-time-per-origin permission gesture. Web MIDI needs the browser's consent before any device is even visible, and until it is granted this module has no stream to listen to and all four jacks sit at rest — so this is the first thing to press, not an optional extra. It reaches the same request every MIDI module in the rack shares, which always yields a nameable outcome: granted, refused, unsupported, or the quiet case where the browser suppressed its own prompt without telling anyone. Once access is granted the dock's device body lists the inputs it found and remembers the one you pick, so a reloaded patch re-attaches without another click.",
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    // Four ConstantSource outputs, all starting at 0.
    const clockSrc = ctx.createConstantSource(); clockSrc.offset.value = 0; clockSrc.start();
    const runSrc   = ctx.createConstantSource(); runSrc.offset.value   = 0; runSrc.start();
    const startSrc = ctx.createConstantSource(); startSrc.offset.value = 0; startSrc.start();
    const stopSrc  = ctx.createConstantSource(); stopSrc.offset.value  = 0; stopSrc.start();

    const savedData = (node.data ?? {}) as Partial<MidiclockData>;
    // ── THE DIVISION'S MIGRATION — params FIRST, then the legacy data key ────
    //
    // ⚠ THE ONE WAY A SAVED PATCH COULD REGRESS, so the order is the whole
    // point. Racks saved before `divisor` was a param hold `node.data.divisor`;
    // racks saved after hold `node.params.divisor`. Reading params first means
    // a NEW value always wins over a stale legacy one, and falling through to
    // `data` means an OLD rack keeps clocking at the division its author chose
    // rather than silently snapping back to 1/4.
    //
    // ⚠ THE LEGACY KEY IS READ AND THEN LEFT ALONE — not rewritten, not
    // deleted. See `snapDivisor` above for the argument (an engine-side repair
    // of stored data is an untagged Y.Doc write, and a silent repair is
    // indistinguishable from no bug). The first ordinary tagged write of the
    // param is what makes the new shape durable, and `midiclock.test.ts` pins
    // both halves over a v-old fixture.
    const savedParams = (node.params ?? {}) as Record<string, number | undefined>;
    const fromParams = savedParams.divisor;
    let divisor: ClockDivisor =
      typeof fromParams === 'number'
        ? snapDivisor(fromParams)
        : isValidDivisor(savedData.divisor)
          ? savedData.divisor
          : DEFAULT_DIVISOR;
    let selectedDeviceId: string | null = savedData.lastDeviceId ?? DEFAULT_DATA.lastDeviceId;

    let access: MidiAccessLike | null = null;
    /** Identity-scoped handler-slot claim — see $lib/midi/input-attach. */
    const claim = createMidiInputClaim('midiclock');
    let permissionDenied = false;
    /** Why the last connect attempt failed, in the user's words. Empty when
     *  never attempted or successful. See $lib/audio/midi-access — a SUPPRESSED
     *  prompt used to be indistinguishable from a broken button. */
    let accessMessage = '';
    let subscriber: ((s: MidiclockCardState) => void) | null = null;

    let tickCounter = 0;
    let ticksReceived = 0;
    let running = false;

    function snapshotState(): MidiclockCardState {
      const devices: MidiclockCardState['devices'] = [];
      if (access) {
        for (const [id, inp] of access.inputs) {
          devices.push({ id, name: inp.name ?? id, state: inp.state });
        }
      }
      return {
        connected: access !== null,
        permissionDenied,
        accessMessage,
        devices,
        selectedDeviceId,
        running,
        divisor,
        ticksReceived,
      };
    }

    function notify(): void {
      subscriber?.(snapshotState());
    }

    // Project event.timeStamp onto the audio clock (preserves inter-message
    // spacing under main-thread dispatch jitter) via the shared scheduler.
    // The scheduler owns the calibrated perf↔ctx offset + its periodic
    // refresh, so all three MIDI bridges share one implementation.
    const scheduler = createMidiScheduler(ctx);
    function schedAt(eventTimeStamp: number): number {
      return scheduler.schedAt(eventTimeStamp);
    }

    function pulse(src: ConstantSourceNode, t: number): void {
      src.offset.cancelScheduledValues(t);
      src.offset.setValueAtTime(1, t);
      src.offset.setValueAtTime(0, t + GATE_PULSE_S);
    }

    function setRun(value: 0 | 1, t: number): void {
      running = value === 1;
      runSrc.offset.cancelScheduledValues(t);
      runSrc.offset.setValueAtTime(value, t);
    }

    function handleMidiMessage(ev: MidiEventLike): void {
      const data = ev.data;
      if (data.length < 1) return;
      const status = data[0]!;
      // Only System Real-Time messages drive this module. Channel-voice
      // events (note on/off, pitch-bend, CC) are MIDI-CV-BUDDY's concern.
      if (!isSystemRealTime(status)) return;
      const t = schedAt(ev.timeStamp);

      if (status === STATUS_CLOCK) {
        ticksReceived++;
        tickCounter++;
        if (tickCounter >= divisor) {
          tickCounter = 0;
          pulse(clockSrc, t);
        }
        // ⚠ NO NOTIFY PER TICK, AND THE OLD REASON GIVEN HERE WAS FICTION.
        // This line used to read "Card has its own rAF for the activity LED"
        // — MidiclockCard.svelte has never contained a `requestAnimationFrame`
        // anywhere, so the `TICKS` readout it painted showed the count as of
        // the last START, sat frozen for the whole performance, and jumped at
        // STOP. A live indicator that cannot update while there IS activity is
        // the one state it must never be in.
        //
        // The suppression itself is CORRECT and stays: at 24 PPQN × 120 BPM a
        // notify per tick is 48 Hz of subscriber pressure for a number nothing
        // now paints. `ticksReceived` remains on the snapshot because it is
        // read on demand (`getState`) by tests and by the device body's
        // aria-label, where a value read at read-time cannot be stale.
        return;
      }
      if (status === STATUS_START) {
        // Re-zero the divider so the first emitted edge lands on the
        // downbeat, not partway through a partial count.
        tickCounter = 0;
        setRun(1, t);
        pulse(startSrc, t);
        notify();
        return;
      }
      if (status === STATUS_CONT) {
        setRun(1, t);
        notify();
        return;
      }
      if (status === STATUS_STOP) {
        setRun(0, t);
        pulse(stopSrc, t);
        notify();
        return;
      }
      // 0xFE Active Sensing and 0xFF Reset are intentionally ignored.
    }

    /** Listen on EXACTLY the chosen device; re-targeting releases only the
     *  port THIS module held (see $lib/midi/input-attach). */
    function attachToDevice(deviceId: string | null): void {
      if (!access) return;
      const inp = deviceId === null ? undefined : access.inputs.get(deviceId);
      claim.attachOnly(inp ? [inp] : [], handleMidiMessage);
    }

    function pickDefaultDevice(): string | null {
      if (!access) return null;
      if (selectedDeviceId && access.inputs.has(selectedDeviceId)) return selectedDeviceId;
      const first = access.inputs.values().next();
      if (first.done) return null;
      return first.value.id;
    }

    async function connect(): Promise<boolean> {
      if (access) return true;
      // Shared seam: ALWAYS yields a nameable outcome, including the case
      // where the browser silently declined to show a prompt at all.
      const outcome = await requestMidiAccess({
        // A late answer to a real prompt must still land — otherwise a slow
        // grant is thrown away and the user has to click twice.
        onLateResolve: (a) => { adoptAccess(a as unknown as MidiAccessLike); },
      });
      if (outcome.kind !== 'granted') {
        permissionDenied = outcome.kind === 'denied' || outcome.kind === 'unsupported';
        accessMessage = midiOutcomeMessage(outcome);
        notify();
        return false;
      }
      accessMessage = '';
      adoptAccess(outcome.access as unknown as MidiAccessLike);
      return true;
    }

    /** Wire a freshly-granted MIDIAccess. Split out of connect() so a LATE
     *  grant (answered after the no-prompt timeout) takes the identical path
     *  rather than a second, subtly-different one. */
    function adoptAccess(a: MidiAccessLike): void {
      try {
        access = a;
        access.onstatechange = () => {
          if (selectedDeviceId && !access?.inputs.has(selectedDeviceId)) {
            // Device disappeared. Keep selection so it reattaches on hot-plug.
          } else if (!selectedDeviceId) {
            selectedDeviceId = pickDefaultDevice();
            attachToDevice(selectedDeviceId);
          }
          notify();
        };
        selectedDeviceId = pickDefaultDevice();
        attachToDevice(selectedDeviceId);
        ticksReceived = 0;
        permissionDenied = false;
        accessMessage = '';
        notify();
      } catch (err) {
        permissionDenied = true;
        accessMessage = `MIDI device setup failed: ${(err as Error).message}`;
        notify();
      }
    }

    function selectDevice(d: string | null): void {
      selectedDeviceId = d;
      attachToDevice(d);
      // Reset the divider counter so the new device starts on a fresh
      // edge. Avoids a half-counted carryover when switching mid-song.
      tickCounter = 0;
      notify();
    }

    function setDivisor(d: ClockDivisor): void {
      divisor = d;
      tickCounter = 0;
      notify();
    }

    const cardApi: MidiclockApi = {
      connect,
      selectDevice,
      setDivisor,
      getState: snapshotState,
      subscribe(cb) {
        subscriber = cb;
        cb(snapshotState());
        return () => {
          if (subscriber === cb) subscriber = null;
        };
      },
    };

    return {
      domain: 'audio',
      inputs: new Map(),
      outputs: new Map([
        ['clock',     { node: clockSrc, output: 0 }],
        ['run',       { node: runSrc,   output: 0 }],
        ['midistart', { node: startSrc, output: 0 }],
        ['midistop',  { node: stopSrc,  output: 0 }],
      ]),
      // ⚠ SNAPPED, NOT VALIDATED-AND-DROPPED. `divisor` declares an EXHAUSTIVE
      // roster, and that clause's contract is that an off-roster write LANDS ON
      // A NAMED MEMBER — `param-vocabulary` asserts it in both directions. The
      // difference is not theoretical: `paramCellKind` returns `'knob'` for an
      // options param at every LANE tier, so a drag on the lane tile really can
      // arrive here with 17. Rejecting it would leave a dial that moves on
      // screen and changes nothing — a dead control that looks alive, which is
      // the exact defect `moog962` shipped and faces-parity failed it for.
      setParam(id, v) { if (id === 'divisor') setDivisor(snapDivisor(v)); },
      readParam(id) { return id === 'divisor' ? divisor : undefined; },
      read(key) {
        if (key === 'card-api') return cardApi;
        if (key === 'state') return snapshotState();
        return undefined;
      },
      dispose() {
        // Release ONLY the port this clock installed a handler on.
        claim.detach();
        if (access) {
          access.onstatechange = null;
          access = null;
        }
        subscriber = null;
        try { clockSrc.stop(); } catch { /* */ }
        try { runSrc.stop();   } catch { /* */ }
        try { startSrc.stop(); } catch { /* */ }
        try { stopSrc.stop();  } catch { /* */ }
        clockSrc.disconnect();
        runSrc.disconnect();
        startSrc.disconnect();
        stopSrc.disconnect();
      },
    };
  },
};
