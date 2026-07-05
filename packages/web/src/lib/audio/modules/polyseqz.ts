// packages/web/src/lib/audio/modules/polyseqz.ts
//
// POLYSEQZ — polyphonic chord sequencer. Same step model as the Sequencer
// (32 steps, internal BPM or external clock) but every step holds a chord
// (root + quality + inversion + voicing) and the pitch output is a
// polyPitchGate cable carrying the full 5-voice chord per step.
//
// Why a separate module instead of expanding Sequencer? Sequencer's chord
// surface is intentionally minimal (mono | maj | min) so it stays a "pitch
// box" first. POLYSEQZ is built around chord-first thinking — the per-step UI
// shows note name + quality together, not as an afterthought. Persisted data
// shape is incompatible (chord lives at top of step, plus inversion + voicing)
// so a separate module + def avoids muddying the Sequencer's migration path.
//
// Output cable: polyPitchGate (5 lanes = root + 3rd + 5th + (octave or 7th) +
// (octave or 5th doubling)). Wires directly into RIOTGIRLS, DX7 (when it
// lands), or any module that consumes polyPitchGate. Backward-compat with
// mono pitch sinks: lane 0 (the root) is auto-routed by resolveConnection().
//
// HUMANIZE: each step's per-voice gate-on time gets a small random delay.
// Magnitude + distribution shape are functions of the humanize amount —
// pure math lives in $lib/audio/humanize.ts so the unit tests can exercise
// the distribution without spinning up an AudioContext.
//
// Inputs:
//   clock (gate): external clock; rising edges advance one step. Unpatched = internal BPM.
//   humanize_cv (cv, linear, paramTarget=humanize): displaces humanize amount.
//
// Outputs:
//   poly (polyPitchGate): 5-lane chord bus (root + 3rd + 5th + 4th-voice + 5th-voice).
//     Mono pitch sinks auto-receive lane 0.
//   gate (gate): main gate (mono fallback for non-poly sinks).
//   clock (gate): chained step clock-out.
//
// Params:
//   bpm (linear 30..300, default 90): internal tempo.
//   length (discrete 1..128, default 8): step count.
//   octave (discrete -2..2, default 0): global transposition.
//   gateLength (linear 0.1..0.95, default 0.6): per-step gate duty.
//   humanize (linear 0..1, default 0): per-voice gate-on jitter amount.
//   isPlaying (discrete 0..1, default 0): transport state.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import { patch as livePatch } from '$lib/graph/store';
import {
  coerceToNoteStep,
  C3_MIDI,
  midiToVOct,
} from '$lib/audio/note-entry';
import {
  POLY_CHANNEL_PAIRS,
  createPolySender,
} from '$lib/audio/poly';
import {
  type ChordQualityName,
  type ChordInversion,
  type ChordVoicingName,
  CHORD_QUALITY_NAMES,
  CHORD_VOICING_NAMES,
  chordToVoices,
  VOICE_LANES,
} from '$lib/audio/chord-tables';
import { sampleHumanizeOffsets } from '$lib/audio/humanize';
import {
  createTransportCv,
  pickQueuedSlotFromEvents,
  TRANSPORT_CV_PORT_DEFS,
} from './transport-cv';
import {
  coerceSlots,
  coerceSlotKey,
  isInputPortConnected,
  shouldSequencerRun,
} from './transport-helpers';
import { getSchedulerClock, SCHEDULER_TICK_MS } from '$lib/audio/scheduler-clock';
import { createPlayheadTracker } from './playhead-tracker';

// ---------------- Step schema ----------------

export interface ChordStep {
  on: boolean;
  /** Root MIDI int (a4=69, c3=48). null = empty step. */
  root: number | null;
  /** Chord quality (default 'maj'). */
  quality: ChordQualityName;
  /** Inversion 0|1|2 (default 0). */
  inversion: ChordInversion;
  /** Voicing strategy (default 'closed'). */
  voicing: ChordVoicingName;
}

// Pre-pages PR this was 32 — see sequencer-pages.ts. Old patches load fine
// (shorter steps[] arrays widen via coerceToChordStep + ensureCapacity).
export const STEP_COUNT = 128;

export function defaultChordSteps(): ChordStep[] {
  return Array.from({ length: STEP_COUNT }, () => ({
    on: false,
    root: C3_MIDI,
    quality: 'maj' as ChordQualityName,
    inversion: 0 as ChordInversion,
    voicing: 'closed' as ChordVoicingName,
  }));
}

/** Coerce an arbitrary step-shape blob into a ChordStep. Used by the live
 *  reader (so half-typed Yjs writes don't crash the tick) and by the def
 *  migration. */
export function coerceToChordStep(raw: unknown): ChordStep {
  const base = coerceToNoteStep(raw); // gives us {on, midi}
  let quality: ChordQualityName = 'maj';
  let inversion: ChordInversion = 0;
  let voicing: ChordVoicingName = 'closed';
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>;
    if (typeof r.quality === 'string' && (CHORD_QUALITY_NAMES as readonly string[]).includes(r.quality)) {
      quality = r.quality as ChordQualityName;
    }
    if (typeof r.inversion === 'number' && [0, 1, 2].includes(r.inversion)) {
      inversion = r.inversion as ChordInversion;
    }
    if (typeof r.voicing === 'string' && (CHORD_VOICING_NAMES as readonly string[]).includes(r.voicing)) {
      voicing = r.voicing as ChordVoicingName;
    }
    // POLYSEQZ persists `root` rather than `midi`; accept either for
    // forward-compat with possible re-uses.
    if (typeof r.root === 'number' || r.root === null) {
      // root is already canonical; keep base.midi as fallback.
    }
  }
  let root: number | null = base.midi;
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>;
    if (typeof r.root === 'number' && Number.isFinite(r.root)) {
      root = Math.round(r.root as number);
    } else if (r.root === null) {
      root = null;
    }
  }
  return { on: base.on, root, quality, inversion, voicing };
}

// ---------------- Module def ----------------

export const polyseqzDef: AudioModuleDef = {
  type: 'polyseqz',
  palette: { top: 'Audio modules', sub: 'sequencers' },
  domain: 'audio',
  label: 'polyseqz',
  category: 'modulation',

  inputs: [
    // External clock (optional). When patched, advances on rising edges.
    { id: 'clock', type: 'gate' },
    // Shared transport CV inputs (PR feat/sequencer-transport-quicksave):
    //   play_cv      → toggles isPlaying on rising edge
    //   reset_cv     → resets stepIndex to 0 on rising edge
    //   queue1..4_cv → queues slot N on rising edge (loaded at sequence-end)
    // These replace the original POLYSEQZ play_cv (cv→param) + reset_cv (gate);
    // both behaviors fold into the shared edge-detect-and-dispatch path so the
    // transport surface matches Sequencer / DRUMSEQZ / SCORE 1:1.
    ...TRANSPORT_CV_PORT_DEFS,
    // CV → humanize amount (0..1). Linear scaling per
    // .myrobots/plans/cv-range-standard.md (LFO ±1 sweeps 0..1 around knob).
    { id: 'humanize_cv', type: 'cv', paramTarget: 'humanize', cvScale: { mode: 'linear' } },
  ],
  outputs: [
    { id: 'poly',  type: 'polyPitchGate' },
    // Convenience mono gate (high while ANY voice's gate is high). Lets
    // POLYSEQZ trigger per-step ADSR / scope-trigger / etc. without
    // unwrapping the polyPitchGate cable.
    { id: 'gate',  type: 'gate' },
    // Per-step clock pulse (10ms high) emitted on every advance.
    { id: 'clock', type: 'gate' },
  ],

  params: [
    { id: 'bpm',        label: 'BPM',  defaultValue: 90,  min: 30,  max: 300,  curve: 'linear' },
    { id: 'length',     label: 'Len',  defaultValue: 8,   min: 1,   max: 128,  curve: 'discrete' },
    { id: 'octave',     label: 'Oct',  defaultValue: 0,   min: -2,  max: 2,    curve: 'discrete' },
    { id: 'gateLength', label: 'Gate', defaultValue: 0.6, min: 0.1, max: 0.95, curve: 'linear' },
    { id: 'humanize',   label: 'Hum',  defaultValue: 0,   min: 0,   max: 1,    curve: 'linear' },
    { id: 'isPlaying',  label: 'Play', defaultValue: 0,   min: 0,   max: 1,    curve: 'discrete' },
    // Gate-sampled Sample & Hold on the per-lane pitch CV (default ON). ON →
    // each lane's pitch is written AT its gate edge (keeping a ~1-sample lead
    // so single-cycle trigger receivers see a stable V/oct at the gate rise),
    // pinned to the UN-jittered nominal step time so the pitch latches cleanly
    // while the gate keeps its humanize jitter. OFF → the legacy pre-gate-lead
    // write at fireAt-0.001 (pitch can drift ahead of the gate under
    // humanize). Per-lane: each lane latches on its own gate edge.
    { id: 'snh',        label: 's&h',  defaultValue: 1,   min: 0,   max: 1,    curve: 'discrete' },
  ],

  // Module-grouping Phase 4 — surface PLAY/STOP as a single button a
  // containing GROUP! can opt to expose on its bar.
  exposableControls: [
    { id: 'playStop', label: 'Play', kind: 'button', paramId: 'isPlaying' },
  ],
  // Instruments v1 — full step grid is atomically exposable.
  exposesSequence: true,

  docs: {
    explanation:
      "A polyphonic CHORD sequencer: instead of one note per step it stores a whole chord — a root note plus a quality (major/minor/etc.), an inversion, and a voicing strategy (closed / open / spread) — and plays the lot at once. It walks a playhead across up to 128 steps (16 per page, 8 pages) on its own BPM clock or an external clock, emitting a 5-voice POLY cable that carries the full chord per step. To hear it you feed that POLY output into a poly-aware voice (RIOTGIRLS, DX7, CUBE, or any module with a poly input) so each chord tone gets its own voice; a mono pitch input still works and just receives the chord's root. A convenience mono GATE goes high whenever any voice is sounding (handy for one shared envelope), and a Humanize control adds per-voice timing jitter so chords don't land perfectly machine-tight. Eight quicksave slots and the transport CV inputs let you build and switch chord progressions live.",
    inputs: {
      clock:
        "External clock: each rising edge advances the playhead exactly one step (one chord). While anything is patched here the internal BPM is ignored and the incoming pulses set the pace (and run the sequencer); unpatch to fall back to the BPM clock.",
      play_cv: "A rising edge toggles play/stop (each pulse flips the run state).",
      reset_cv: "A rising edge snaps the playhead back to step 1 and restarts the progression.",
      queue1_cv: "A rising edge queues pattern slot 1 — applied at the end of the current loop, then plays it from step 1 (no-op if empty).",
      queue2_cv: "A rising edge queues pattern slot 2 — applied at the end of the current loop (no-op if empty).",
      queue3_cv: "A rising edge queues pattern slot 3 — applied at the end of the current loop (no-op if empty).",
      queue4_cv: "A rising edge queues pattern slot 4 — applied at the end of the current loop (no-op if empty).",
      humanize_cv:
        "CV that modulates the Humanize amount (0..1, summed with the knob): a positive voltage adds more per-voice timing jitter so the chord's notes don't all strike on exactly the same instant. Patch an LFO or envelope here to make the looseness breathe.",
    },
    outputs: {
      poly:
        "The current step's chord as a 5-voice POLY cable (each lane carries its own pitch CV + gate). Patch into a poly-aware voice (RIOTGIRLS / DX7 / CUBE / any module with a poly input) so each chord tone gets its own voice; a mono pitch input automatically receives just lane 0, the chord's root.",
      gate:
        "A convenience mono gate that goes high while ANY voice of the current chord is sounding and low between chords — drive one shared ADSR/VCA from it without unpacking the poly cable. Its high time within the step follows the gate-length control.",
      clock: "A short ~10 ms pulse on every step advance, regardless of whether the step is on — chain it into another sequencer's clock in.",
    },
    controls: {
      bpm:
        "Internal tempo in beats per minute (each step is an 8th note here — slower than the mono sequencer's 16th-note grid, which suits chords), used only when nothing is patched into CLOCK IN.",
      length: "How many steps (chords) the playhead walks before wrapping to step 1; raising it past 16 reveals more pages.",
      octave: "Shifts every chord up or down by whole octaves at once (-2 to +2); the chord transposes as a block so its voicing stays intact.",
      gateLength: "How much of each step the voices' gates stay high, from a short 10% stab to a near-legato 95% (always closing just before the next step).",
      humanize:
        "Spreads each voice's onset slightly in time so a chord strums/loosens instead of hitting perfectly together: 0 is machine-tight, higher values add more random per-voice jitter (up to a few tens of milliseconds). Also modulatable via the humanize_cv input.",
      isPlaying:
        "The run/stop state: 1 plays, 0 stops and forces the gates low; starting playback snaps the playhead back to step 1. Same control as the card's PLAY button.",
      snh:
        "Sample & hold on the per-voice pitch CV, on by default (the card's S&H face button): when on, each voice's pitch is latched cleanly at its gate edge (pinned to the un-jittered step time) so the note is stable when the gate rises even while Humanize jitters the timing; off reverts to the legacy behavior where pitch can drift ahead of the gate under Humanize.",
      "polyseqz-root-{n}":
        "Step {n}'s ROOT note — the editable pitch box that sets the bottom note of this step's chord. Type a note name (e.g. C3, F#4, Bb2) or focus it and use the arrow keys to move across the step row; Enter commits and advances to the next step's box. The box shows the canonical note name, glows green while valid and red while not, and clearing it (empty) makes the step a rest even if its gate is lit. The chord's quality, inversion and voicing badges build the rest of the chord UP from this root, which is then transposed by the OCT control and broadcast across the poly pitch lanes.",
    },
  },

  controlFamilies: [
    { id: 'polyseqz-root', label: 'Per-step root note entry', kind: 'cell', testidPrefix: 'polyseqz-root', countParam: 'length' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    const polyPitch = createPolySender(ctx);
    const gateSrc = ctx.createConstantSource();
    const clockOutSrc = ctx.createConstantSource();
    gateSrc.offset.value = 0;
    clockOutSrc.offset.value = 0;
    gateSrc.start();
    clockOutSrc.start();

    // External-clock input.
    const clockInGain = ctx.createGain();
    const clockInAnalyser = ctx.createAnalyser();
    clockInAnalyser.fftSize = 2048;
    clockInGain.connect(clockInAnalyser);
    const clockInBuffer = new Float32Array(clockInAnalyser.fftSize);
    const clockInSilence = ctx.createConstantSource();
    clockInSilence.offset.value = 0;
    clockInSilence.start();
    clockInSilence.connect(clockInGain);

    // humanize_cv: declared as paramTarget input. The engine connects an
    // external CV signal into the AudioParam target. We back the target with
    // an internal ConstantSource — its offset receives the CV sum and the
    // tick polls the offset value via an analyser tap each iteration. (We
    // don't have a real AudioParam for `humanize` because the param store is
    // JS-side; this constant-source-as-AudioParam gives the engine something
    // to connect to and lets us read the live CV value with an AnalyserNode.)
    function makeParamCV(initial: number): {
      param: AudioParam;
      pollValue: () => number;
      dispose: () => void;
    } {
      const target = ctx.createConstantSource();
      target.offset.value = initial;
      target.start();
      const ana = ctx.createAnalyser();
      ana.fftSize = 256;
      target.connect(ana);
      const buf = new Float32Array(ana.fftSize);
      return {
        param: target.offset,
        pollValue() {
          ana.getFloatTimeDomainData(buf);
          // Average the most recent samples for a stable read — anything
          // higher-rate happens at audio thread anyway, and downstream uses
          // (humanize amount, isPlaying threshold) are coarse-grained.
          let sum = 0;
          const N = Math.min(buf.length, 64);
          for (let i = buf.length - N; i < buf.length; i++) sum += buf[i] ?? 0;
          return sum / N;
        },
        dispose() {
          try { target.stop(); } catch { /* */ }
          try { target.disconnect(); } catch { /* */ }
          try { ana.disconnect(); } catch { /* */ }
        },
      };
    }
    const humanizeCV = makeParamCV(0);

    // Shared transport CV inputs (play_cv, reset_cv, queue{1..4}_cv). Each
    // input is a GainNode → AnalyserNode tap whose recent samples we scan for
    // rising edges every tick. play_cv toggles isPlaying, reset_cv resets the
    // step counter, queue{N}_cv writes node.data.queuedSlot = N for the
    // sequence-end swap.
    const transportCv = createTransportCv(ctx);
    let lastTransportPollTime = ctx.currentTime;
    let totalSequenceEnds = 0;

    let lastClockSample = 0;
    let lastClockSampleTime = ctx.currentTime;
    const CLOCK_THRESHOLD = 0.5;

    const nodeId = node.id;

    function emitClockPulse(atTime: number) {
      clockOutSrc.offset.setValueAtTime(1, atTime);
      clockOutSrc.offset.setValueAtTime(0, atTime + 0.01);
    }

    function isClockInConnected(): boolean {
      return isInputPortConnected(Object.values(livePatch.edges), nodeId, 'clock');
    }
    function isPlayCvConnected(): boolean {
      return isInputPortConnected(Object.values(livePatch.edges), nodeId, 'play_cv');
    }

    function readSteps(): ChordStep[] {
      const live = livePatch.nodes[nodeId];
      const steps = (live?.data as Record<string, unknown> | undefined)?.steps;
      if (Array.isArray(steps)) {
        return (steps as unknown[]).map(coerceToChordStep);
      }
      return defaultChordSteps();
    }
    function readParam(id: string, fallback: number): number {
      const live = livePatch.nodes[nodeId];
      const v = live?.params?.[id];
      const base = typeof v === 'number' ? v : fallback;
      // Fold in CV-modulated params: if a connection is driving humanize_cv,
      // the constant-source offset's signal sums on top of the base value.
      // We only fold on params we actually publish as paramTargets —
      // everything else returns `base` verbatim. (play_cv used to fold here
      // too, but PR feat/polyseqz-transport-parity migrated it to the shared
      // edge-detect transport CV — toggles isPlaying instead of additively
      // modulating it.)
      if (id === 'humanize') {
        const cv = humanizeCV.pollValue();
        const sum = base + cv;
        return sum < 0 ? 0 : sum > 1 ? 1 : sum;
      }
      return base;
    }

    // Live state
    let stepIndex = 0;
    let nextStepTime = ctx.currentTime + 0.05;
    let prevPlaying = false;
    let alive = true;
    let unsubscribeTick: (() => void) | null = null;
    // 200 ms lookahead (was 100 ms): see sequencer.ts and the
    // tempo-stability fix PR for the rationale. Wider window absorbs
    // main-thread blocking from drag/render so the audio thread doesn't
    // run dry between scheduler ticks.
    const LOOKAHEAD_S = 0.2;
    const TICK_MS = SCHEDULER_TICK_MS;
    // #229: drop past-due steps after a stall > lookahead instead of letting
    // Web Audio clamp+bunch them onto "now" (audible double-hit + tempo lurch
    // when dragging). 5 ms slack keeps ordinary near-now jitter sounding.
    const LATE_DROP_EPS = 0.005;

    // Tracking for tests / introspection.
    let lastEmittedVOct = 0;
    let lastEmittedGate = 0;
    const lastEmittedLaneVOct = new Array<number>(POLY_CHANNEL_PAIRS).fill(0);
    const lastEmittedLaneGate = new Array<number>(POLY_CHANNEL_PAIRS).fill(0);
    const lastHumanizeOffsets = new Array<number>(POLY_CHANNEL_PAIRS).fill(0);
    // Scheduler lookahead vs sounding-now: stepIndex is the NEXT step the
    // lookahead loop will queue; the tracker derives the playhead from the
    // (idx, atTime) entries pushed inside emitStep so the visual highlight
    // matches what the audio thread is playing right now (not the next-to-be-
    // scheduled step). Fixes the off-by-one playhead lag.
    const playhead = createPlayheadTracker();
    let totalAdvances = 0;
    // #229 instrumentation: lateStepsDropped = past-due steps whose gate we
    // dropped after a stall; pastDueEmits = emitStep calls with a past
    // timestamp (BUG canary, kept at 0 by the drop guard). See sequencer.ts.
    let lateStepsDropped = 0;
    let pastDueEmits = 0;

    /** Schedule one step's chord at the given audio time. Per-voice gate-on
     *  is offset by an independent random sample from the humanize
     *  distribution (clamped so it never tries to schedule in the past). */
    function emitStep(idx: number, atTime: number, stepDurForGate: number) {
      // #229 canary: emitStep with a past timestamp = the drop guard failed
      // and Web Audio is about to clamp+bunch this onto "now". Kept at 0.
      if (atTime < ctx.currentTime - LATE_DROP_EPS) pastDueEmits++;
      const octave = readParam('octave', 0);
      const gateLengthFrac = readParam('gateLength', 0.5);
      const humanize = readParam('humanize', 0);
      const steps = readSteps();
      const step = steps[idx];
      // Step clock pulse (chain-out signal) always fires on advance.
      emitClockPulse(atTime);
      // Record this step's start time so the visual playhead can derive
      // "sounding now" rather than "about-to-be-scheduled".
      playhead.schedule(idx, atTime);

      const root = step && step.on && step.root !== null ? step.root : null;
      const voices = chordToVoices(
        root,
        step?.quality ?? 'maj',
        step?.inversion ?? 0,
        step?.voicing ?? 'closed',
      );

      const gateOffWindow = stepDurForGate * gateLengthFrac;

      const offsets = sampleHumanizeOffsets(humanize, POLY_CHANNEL_PAIRS);
      // Mirror for tests/UI.
      for (let i = 0; i < POLY_CHANNEL_PAIRS; i++) {
        lastHumanizeOffsets[i] = offsets[i] ?? 0;
      }

      // Gate-sampled Sample & Hold (default ON). See the `snh` param doc: ON
      // pins the per-lane PITCH write to the un-jittered nominal step time
      // (`atTime`) — keeping only the ~1-sample lead before the gate — so the
      // pitch latches cleanly to the gate edge while the GATE keeps its
      // humanize jitter. OFF reproduces the legacy pre-gate-lead write at the
      // jittered `fireAt - 0.001`.
      const snh = readParam('snh', 1) >= 0.5;

      let anyGate = false;
      for (let i = 0; i < POLY_CHANNEL_PAIRS; i++) {
        const lane = voices[i] ?? { midi: null, gate: 0 as 0 | 1 };
        const polyVoice = polyPitch.voices[i]!;
        if (lane.gate === 1 && lane.midi !== null) {
          // Apply octave param after chord math.
          const vOct = midiToVOct(lane.midi) + octave;
          // Clamp the per-voice fire time to "now or future" — Web Audio
          // accepts setValueAtTime in the near past silently but anything
          // earlier than ctx.currentTime - 0.1s can drop the event.
          const offset = offsets[i] ?? 0;
          const fireAt = Math.max(ctx.currentTime + 0.001, atTime + offset);
          // Set pitch slightly BEFORE the gate-on so the receiver sees a
          // stable V/oct at the moment the gate rises — matters for
          // single-cycle envelope triggers. With S&H ON the lead reference is
          // the UN-jittered `atTime` (so the pitch latch isn't pulled around
          // by humanize); with S&H OFF it's the jittered `fireAt` (legacy).
          const pitchLeadFrom = snh ? atTime : fireAt;
          const pitchAt = pitchLeadFrom - 0.001 < ctx.currentTime
            ? ctx.currentTime
            : pitchLeadFrom - 0.001;
          polyVoice.pitchSrc.offset.setValueAtTime(vOct, pitchAt);
          polyVoice.gateSrc.offset.setValueAtTime(1, fireAt);
          polyVoice.gateSrc.offset.setValueAtTime(0, fireAt + gateOffWindow);
          lastEmittedLaneVOct[i] = vOct;
          lastEmittedLaneGate[i] = 1;
          anyGate = true;
          if (i === 0) lastEmittedVOct = vOct;
        } else {
          // Hold the lane silent. We do NOT touch pitchSrc — the previous
          // step's pitch lingers harmlessly behind a closed gate.
          polyVoice.gateSrc.offset.setValueAtTime(0, atTime);
          lastEmittedLaneGate[i] = 0;
        }
      }

      if (anyGate) {
        gateSrc.offset.setValueAtTime(1, atTime);
        gateSrc.offset.setValueAtTime(0, atTime + gateOffWindow);
        lastEmittedGate = 1;
      } else {
        // Empty step — leave gates low.
        lastEmittedGate = 0;
      }
    }

    /** Drain the transport CV inputs + dispatch effects. Returns the
     *  isPlaying value AFTER any play_cv toggle (so the caller's
     *  subsequent prev/cur transition logic stays correct). */
    function pollTransportCv(): boolean {
      const nowAt = ctx.currentTime;
      const elapsed = nowAt - lastTransportPollTime;
      lastTransportPollTime = nowAt;
      const ev = transportCv.drain(elapsed);
      const live = livePatch.nodes[nodeId];
      let isPlaying = readParam('isPlaying', 0) >= 0.5;
      // Each play_cv rising edge toggles isPlaying. Multiple edges in one
      // tick collapse to an XOR-style overall toggle.
      if (ev.play % 2 === 1) {
        isPlaying = !isPlaying;
        if (live?.params) live.params.isPlaying = isPlaying ? 1 : 0;
      }
      if (ev.reset > 0) {
        // Reset the step counter; next clock tick starts at step 0. Reset is
        // honored even when stopped (debounce-style) — same semantics as the
        // pre-shared-transport behavior in checkResetEdge.
        stepIndex = 0;
        playhead.reset();
        nextStepTime = ctx.currentTime + 0.005;
      }
      const queued = pickQueuedSlotFromEvents(ev);
      if (queued !== null && live) {
        if (!live.data) live.data = {};
        (live.data as Record<string, unknown>).queuedSlot = queued;
      }
      return isPlaying;
    }

    /** Apply queued slot's snapshot. Snapshot shape (POLYSEQZ):
     *  { steps: ChordStep[], bpm, length, octave, gateLength, humanize }.
     *  Each ChordStep carries {on, root, quality, inversion, voicing}; we
     *  deep-clone every entry so the same Y-Map doesn't end up at two paths
     *  (slots[N] AND data.steps) — Yjs throws "reassigning object that
     *  already occurs in the tree" otherwise. */
    function maybeApplyQueuedSlot(): boolean {
      const live = livePatch.nodes[nodeId];
      if (!live) return false;
      const data = live.data as Record<string, unknown> | undefined;
      const queuedRaw = data?.queuedSlot;
      const queued = coerceSlotKey(queuedRaw);
      if (!queued) return false;
      const slots = coerceSlots(data?.slots);
      const snap = slots[queued];
      if (!snap) {
        // Slot is empty — drop the queue.
        if (data) data.queuedSlot = null;
        return false;
      }
      if (!live.data) live.data = {};
      const d = live.data as Record<string, unknown>;
      // Deep-clone steps before reassigning. Each ChordStep is a plain object
      // (no nested arrays) so a single spread suffices per step.
      if (Array.isArray(snap.steps)) {
        d.steps = (snap.steps as Array<Record<string, unknown>>).map((s) => ({ ...s }));
      }
      if (live.params) {
        for (const k of ['bpm', 'length', 'octave', 'gateLength', 'humanize'] as const) {
          const v = snap[k];
          if (typeof v === 'number') live.params[k] = v; // guard:allow-raw-write — sequencer slot-restore during the playback tick, not a user edit
        }
      }
      d.lastLoadedSlot = queued;
      d.queuedSlot = null;
      // Reset position so the next emit starts at step 0 of the new pattern.
      stepIndex = 0;
      playhead.reset();
      nextStepTime = ctx.currentTime + 0.005;
      return true;
    }

    function tick() {
      if (!alive) return;
      try {
        // Drain transport CV first; play_cv may have just toggled isPlaying
        // and reset_cv may have just bumped stepIndex.
        const isPlaying = pollTransportCv();
        const externalClock = isClockInConnected();
        // Orthogonality fix: clock-only mode (clock patched, play_cv not)
        // treats incoming pulses as the play signal even when isPlaying=false.
        const playCvPatched = isPlayCvConnected();
        const shouldRun = shouldSequencerRun(isPlaying, externalClock, playCvPatched);
        const nowAt = ctx.currentTime;

        if (shouldRun && !prevPlaying) {
          stepIndex = 0;
          playhead.reset();
          nextStepTime = ctx.currentTime + 0.05;
          gateSrc.offset.cancelScheduledValues(ctx.currentTime);
          gateSrc.offset.setValueAtTime(0, ctx.currentTime);
          polyPitch.silence(ctx.currentTime);
          lastClockSample = 0;
          lastClockSampleTime = ctx.currentTime;
          transportCv.resetEdges();
          lastTransportPollTime = ctx.currentTime;
        } else if (!shouldRun && prevPlaying) {
          gateSrc.offset.cancelScheduledValues(ctx.currentTime);
          gateSrc.offset.setValueAtTime(0, ctx.currentTime);
          polyPitch.silence(ctx.currentTime);
        }
        prevPlaying = shouldRun;

        if (!shouldRun) {
          // Worker-driven scheduler-clock owns re-tick scheduling — see the
          // getSchedulerClock().subscribe(tick) below — so no timeoutId
          // self-loop is needed when we early-return.
          return;
        }

        if (externalClock) {
          clockInAnalyser.getFloatTimeDomainData(clockInBuffer);
          const elapsed = nowAt - lastClockSampleTime;
          const newSamples = Math.min(
            clockInBuffer.length,
            Math.max(1, Math.ceil(elapsed * ctx.sampleRate)),
          );
          const start = clockInBuffer.length - newSamples;
          const bpm = readParam('bpm', 90);
          // Clamp to [1, STEP_COUNT] so stepIndex stays in bounds even
          // if a future patch persists length > STEP_COUNT.
          const length = Math.max(1, Math.min(STEP_COUNT, Math.round(readParam('length', 8))));
          const stepDurForGate = 60 / Math.max(1, bpm) / 2; // 8th-note feel
          for (let i = start; i < clockInBuffer.length; i++) {
            const cur = clockInBuffer[i] ?? 0;
            if (lastClockSample < CLOCK_THRESHOLD && cur >= CLOCK_THRESHOLD) {
              emitStep(stepIndex, nowAt + 0.005, stepDurForGate);
              const nextIdx = (stepIndex + 1) % length;
              if (nextIdx === 0) {
                // Wrap: sequence end. Try to apply any queued slot before
                // advancing — the new pattern's step 0 will fire on the next
                // clock pulse.
                totalSequenceEnds++;
                if (maybeApplyQueuedSlot()) {
                  // stepIndex/currentStep reset by the apply; skip the
                  // natural advance.
                  continue;
                }
              }
              stepIndex = nextIdx;
              totalAdvances++;
            }
            lastClockSample = cur;
          }
          lastClockSampleTime = nowAt;
        } else {
          while (nextStepTime < ctx.currentTime + LOOKAHEAD_S) {
            const bpm = readParam('bpm', 90);
            // Clamp to [1, STEP_COUNT] so stepIndex stays in bounds even
          // if a future patch persists length > STEP_COUNT.
          const length = Math.max(1, Math.min(STEP_COUNT, Math.round(readParam('length', 8))));
            // POLYSEQZ defaults to 8th-note step grid — chords feel slower
            // than the Sequencer's 16th default, which is more musically
            // appropriate for chord changes.
            const stepDur = 60 / bpm / 2;
            // #229: drop past-due backlog instead of bunching it onto "now".
            if (nextStepTime < ctx.currentTime - LATE_DROP_EPS) {
              lateStepsDropped++;
            } else {
              emitStep(stepIndex, nextStepTime, stepDur);
            }
            const nextIdx = (stepIndex + 1) % length;
            const nextStartTime = nextStepTime + stepDur;
            if (nextIdx === 0) {
              totalSequenceEnds++;
              if (maybeApplyQueuedSlot()) {
                // Snapshot was applied; the next step time we want to
                // schedule is the natural step boundary, but for the new
                // pattern's step 0. maybeApplyQueuedSlot() resets nextStepTime
                // to ctx.currentTime + tiny, so re-anchor it here.
                nextStepTime = nextStartTime;
                continue;
              }
            }
            nextStepTime = nextStartTime;
            stepIndex = nextIdx;
            totalAdvances++;
          }
          lastClockSampleTime = nowAt;
        }
      } catch (err) {
        console.error('[polyseqz] tick error', err);
      }
    }

    // Subscribe to the shared scheduler-clock (Worker-driven). Replaces
    // the legacy per-module `setTimeout(tick, TICK_MS)` self-loop, which
    // would queue up behind main-thread blocking and starve the
    // lookahead window mid-drag.
    unsubscribeTick = getSchedulerClock().subscribe(tick);

    const inputs = new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
      ['clock', { node: clockInGain, input: 0 }],
      // humanize_cv is a paramTarget input — the engine routes the CV signal
      // directly into the AudioParam. .node is unused when .param is set; we
      // point at the closest in-graph node to keep the type happy.
      ['humanize_cv', { node: clockInGain, input: 0, param: humanizeCV.param }],
    ]);
    // Shared transport CV inputs (play_cv, reset_cv, queue1..4_cv).
    for (const [id, entry] of transportCv.inputs) {
      inputs.set(id, entry);
    }

    return {
      domain: 'audio',
      inputs,
      outputs: new Map([
        ['poly',  { node: polyPitch.output, output: 0 }],
        ['gate',  { node: gateSrc, output: 0 }],
        ['clock', { node: clockOutSrc, output: 0 }],
      ]),
      setParam(_paramId, _value) {
        // No AudioParam to write — the tick reads node.params each iteration.
      },
      readParam(paramId) {
        const live = livePatch.nodes[nodeId];
        const v = live?.params?.[paramId];
        return typeof v === 'number' ? v : undefined;
      },
      read(key) {
        if (key === 'currentStep') return playhead.currentAt(ctx.currentTime);
        if (key === 'totalAdvances') return totalAdvances;
        if (key === 'lateStepsDropped') return lateStepsDropped;
        if (key === 'pastDueEmits') return pastDueEmits;
        if (key === 'totalSequenceEnds') return totalSequenceEnds;
        if (key === 'pitchVOct')  return lastEmittedVOct;
        if (key === 'gateValue')  return lastEmittedGate;
        if (typeof key === 'string' && key.startsWith('pitchVOctLane:')) {
          const i = Number.parseInt(key.slice('pitchVOctLane:'.length), 10);
          return Number.isFinite(i) && i >= 0 && i < POLY_CHANNEL_PAIRS
            ? lastEmittedLaneVOct[i]
            : undefined;
        }
        if (typeof key === 'string' && key.startsWith('gateLane:')) {
          const i = Number.parseInt(key.slice('gateLane:'.length), 10);
          return Number.isFinite(i) && i >= 0 && i < POLY_CHANNEL_PAIRS
            ? lastEmittedLaneGate[i]
            : undefined;
        }
        if (typeof key === 'string' && key.startsWith('humanizeOffset:')) {
          const i = Number.parseInt(key.slice('humanizeOffset:'.length), 10);
          return Number.isFinite(i) && i >= 0 && i < POLY_CHANNEL_PAIRS
            ? lastHumanizeOffsets[i]
            : undefined;
        }
        return undefined;
      },
      dispose() {
        alive = false;
        if (unsubscribeTick) { unsubscribeTick(); unsubscribeTick = null; }
        try { gateSrc.stop(); } catch { /* */ }
        try { clockOutSrc.stop(); } catch { /* */ }
        try { clockInSilence.stop(); } catch { /* */ }
        polyPitch.dispose();
        gateSrc.disconnect();
        clockOutSrc.disconnect();
        clockInSilence.disconnect();
        clockInGain.disconnect();
        clockInAnalyser.disconnect();
        humanizeCV.dispose();
        transportCv.dispose();
      },
    };
  },
};

// Re-export the lane count so tests / UI stay in sync without duplicating it.
export { VOICE_LANES as POLYSEQZ_VOICE_LANES };
