// art/setup/clip-driver.ts
//
// A PURE, deterministic clip → per-sample note-frame driver for the offline
// GRAND-INTEGRATION combined-master ART
// (.myrobots/plans/grand-integration-e2e-art-2026-07-19.md §7.2).
//
// The ART harness CANNOT run the real clip-player scheduler (it is a browser-only
// web module driven by the real-time Web-Worker tick + the live Svelte store —
// none of which run inside an offline render). BUT the clip STEP MATH is already
// pure: `lanesForStep` / `notesStartingAt` (clip-types.ts) resolve a note clip's
// poly lanes + gate width at a step, and `laneStepDur` / `clipDivIndex`
// (clip-clock.ts) give a lane's step duration. This driver reuses those SAME pure
// functions to replay the shared clip fixture at the clip player's own cadence
// (`60/bpm/STEP_DIV_SPB[stepDiv]`, then `laneStepDur`), emitting exactly the
// per-sample trigger / mono-pitch-gate / poly-pitch-gate / automation frames the
// four instruments' pure DSP cores consume. So the offline schedule is genuinely
// clipplayer-faithful, not re-derived. (A future follow-up could lift the entire
// per-lane tick into a shared pure module so browser + ART share ONE scheduler;
// not needed for v1 — see the plan's risk note.)
//
// Gate emission mirrors clipplayer.ts `emitLaneStep`: a single-step note holds
// its gate for `span * gateLength` (staccato duty), a tied note (gateSteps > 1)
// for `span - 0.002` (legato); pitch is Sample-&-Held between gated steps (S&H
// default ON). Percussion lanes (kick/snare) emit a canonical TRIGGER_PULSE_S
// pulse per note step (a rising edge = one strike — the same shape the kick/snare
// ART profiles drive through `triggerTrain`).

import {
  lanesForStep,
  automationLinearAt,
  type NoteClipRecord,
  type AutoClipRecord,
} from '$lib/audio/modules/clip-types';
import { laneStepDur, clipDivIndex } from '$lib/audio/modules/clip-clock';
import { TRIGGER_PULSE_S } from '$lib/audio/gate-trigger';

/** clipplayer STEP_DIV_SPB = steps-per-beat for each `stepDiv` index. */
const STEP_DIV_SPB = [1, 2, 4, 8] as const;

/** Which fixture clip index each of the four instrument lanes plays (slot 0). */
export interface LaneClipMap {
  kick: number;
  snare: number;
  tidy: number;
  sixstrum: number;
}

export interface ClipDriverOptions {
  /** The shared fixture's clips, keyed by flat clip index string. */
  clips: Record<string, NoteClipRecord>;
  /** The shared fixture's automation map (keyed by clip index string). */
  auto?: Record<string, AutoClipRecord>;
  /** Which clip each lane plays. */
  laneClips: LaneClipMap;
  bpm: number;
  /** TIMELORDE `stepDiv` param index (into STEP_DIV_SPB). */
  stepDivIndex: number;
  sampleRate: number;
  durationS: number;
  /** clipplayer `gateLength` default (staccato duty for single-step notes). */
  gateLength?: number;
  /** clipplayer `octave` default (added to every pitch). */
  octave?: number;
  /** How many sixstrum poly voice slots to fill (SS_STRINGS = 6). */
  polyVoices: number;
  /** The tidy-lane cutoff automation: clip index + `nodeId::paramId` track key.
   *  When present the driver emits a looped, linear-interpolated normalized 0..1
   *  cutoff envelope; else `tidyCutoffNorm` is filled with `defaultCutoffNorm`. */
  tidyCutoffClipIdx?: number;
  tidyCutoffKey?: string;
  /** Fallback normalized cutoff when no automation track is present. */
  defaultCutoffNorm?: number;
}

export interface ClipScheduleFrames {
  totalSamples: number;
  /** lane 0 → kickdrum `trigger_in` (canonical trigger pulses). */
  kickTrig: Float32Array;
  /** lane 1 → snaredrum `trigger_in`. */
  snareTrig: Float32Array;
  /** lane 2 (MONO) → tidyVco `pitch` (V/oct, S&H-held) + `gate` (0/1). */
  tidyPitch: Float32Array;
  tidyGate: Float32Array;
  /** lane 2 tidyVco `cutoff` automation, normalized 0..1 (looped envelope). */
  tidyCutoffNorm: Float32Array;
  /** lane 3 → sixstrum `poly`: per-voice pitch (V/oct, S&H) + gate (0/1). */
  sixPitch: Float32Array[];
  sixGate: Float32Array[];
}

/** A minimal `{rate?}` shape for `clipDivIndex`/`laneStepDur` — our fixture runs
 *  every lane at rate '1', so this is empty (the coerce falls back to '1'). */
const NO_RATE_DATA = {} as { rate?: unknown };

/** Fill a held trigger PULSE (value 1) of `TRIGGER_PULSE_S` starting at sample
 *  `start` — one clean rising edge = one strike (the kick/snare ART shape). */
function emitTriggerPulse(buf: Float32Array, start: number, sr: number): void {
  const end = Math.min(buf.length, start + Math.max(1, Math.round(TRIGGER_PULSE_S * sr)));
  for (let i = start; i < end; i++) buf[i] = 1;
}

/**
 * Replay the fixture clips into per-sample instrument-driver frames. Pure +
 * deterministic: no Math.random, no wall clock, epoch pinned to sample 0.
 */
export function renderClipSchedule(opts: ClipDriverOptions): ClipScheduleFrames {
  const sr = opts.sampleRate;
  const N = Math.round(sr * opts.durationS);
  const gateLength = opts.gateLength ?? 0.9;
  const octave = opts.octave ?? 0;
  const baseStepDur = 60 / opts.bpm / (STEP_DIV_SPB[opts.stepDivIndex] ?? 4);

  const kickTrig = new Float32Array(N);
  const snareTrig = new Float32Array(N);
  const tidyPitch = new Float32Array(N);
  const tidyGate = new Float32Array(N);
  const tidyCutoffNorm = new Float32Array(N);
  tidyCutoffNorm.fill(opts.defaultCutoffNorm ?? 0.5);
  const sixPitch = Array.from({ length: opts.polyVoices }, () => new Float32Array(N));
  const sixGate = Array.from({ length: opts.polyVoices }, () => new Float32Array(N));

  const clipOf = (idx: number): NoteClipRecord | null => {
    const c = opts.clips[String(idx)];
    return c && c.kind === 'note' ? c : null;
  };

  // Gate-high duration (s) for a step's note(s): tied (multi-step) legato holds
  // nearly the whole span; a single-step note uses the gate duty cycle. Mirrors
  // clipplayer.ts emitLaneStep's `gateOff`.
  const gateHighS = (gateSteps: number, stepDur: number): number => {
    const span = gateSteps * stepDur;
    return gateSteps > 1 ? Math.max(0.001, span - 0.002) : Math.max(0.001, span * gateLength);
  };

  // --- Percussion lanes (kick / snare): a trigger pulse per note step ---
  const driveTrigLane = (clipIdx: number, out: Float32Array) => {
    const clip = clipOf(clipIdx);
    if (!clip) return;
    const stepDur = laneStepDur(baseStepDur, clipDivIndex(clip, NO_RATE_DATA, 0));
    for (let g = 0; ; g++) {
      const startSample = Math.round(g * stepDur * sr);
      if (startSample >= N) break;
      const local = g % clip.lengthSteps;
      if (lanesForStep(clip, local).any) emitTriggerPulse(out, startSample, sr);
    }
  };
  driveTrigLane(opts.laneClips.kick, kickTrig);
  driveTrigLane(opts.laneClips.snare, snareTrig);

  // --- Mono lane (tidy): one voice, S&H pitch + duty-cycled gate ---
  {
    const clip = clipOf(opts.laneClips.tidy);
    if (clip) {
      const stepDur = laneStepDur(baseStepDur, clipDivIndex(clip, NO_RATE_DATA, 0));
      for (let g = 0; ; g++) {
        const startSample = Math.round(g * stepDur * sr);
        if (startSample >= N) break;
        const local = g % clip.lengthSteps;
        const r = lanesForStep(clip, local);
        if (!r.any || r.lanes.length === 0) continue;
        const pitch = r.lanes[0]!.pitch + octave;
        // S&H: hold pitch from this gated step to the end (a later gated step
        // overwrites its own tail) — the clipplayer S&H-ON default.
        tidyPitch.fill(pitch, startSample);
        const highN = Math.round(gateHighS(r.gateSteps, stepDur) * sr);
        const gateEnd = Math.min(N, startSample + Math.max(1, highN));
        for (let i = startSample; i < gateEnd; i++) tidyGate[i] = 1;
      }
    }
  }

  // --- Poly lane (sixstrum): fill per-voice pitch/gate from lanesForStep ---
  {
    const clip = clipOf(opts.laneClips.sixstrum);
    if (clip) {
      const stepDur = laneStepDur(baseStepDur, clipDivIndex(clip, NO_RATE_DATA, 0));
      for (let g = 0; ; g++) {
        const startSample = Math.round(g * stepDur * sr);
        if (startSample >= N) break;
        const local = g % clip.lengthSteps;
        const r = lanesForStep(clip, local);
        if (!r.any) continue;
        const highN = Math.round(gateHighS(r.gateSteps, stepDur) * sr);
        const gateEnd = Math.min(N, startSample + Math.max(1, highN));
        const voices = Math.min(r.lanes.length, opts.polyVoices);
        for (let n = 0; n < voices; n++) {
          const pitch = r.lanes[n]!.pitch + octave;
          sixPitch[n]!.fill(pitch, startSample);
          const gArr = sixGate[n]!;
          for (let i = startSample; i < gateEnd; i++) gArr[i] = 1;
        }
      }
    }
  }

  // --- Tidy cutoff automation: looped, linear-interpolated normalized envelope ---
  if (opts.tidyCutoffKey != null && opts.tidyCutoffClipIdx != null && opts.auto) {
    const rec = opts.auto[String(opts.tidyCutoffClipIdx)];
    const track = rec?.tracks?.[opts.tidyCutoffKey];
    const tidyClip = clipOf(opts.laneClips.tidy);
    if (track && track.events.length > 0 && tidyClip) {
      const stepDur = laneStepDur(baseStepDur, clipDivIndex(tidyClip, NO_RATE_DATA, 0));
      const len = tidyClip.lengthSteps;
      const events = track.events;
      const fallback = opts.defaultCutoffNorm ?? 0.5;
      for (let i = 0; i < N; i++) {
        const stepFloat = i / sr / stepDur;
        const loopStep = stepFloat % len; // position within the looping clip
        const v = automationLinearAt(events, loopStep);
        tidyCutoffNorm[i] = v == null ? fallback : v;
      }
    }
  }

  return { totalSamples: N, kickTrig, snareTrig, tidyPitch, tidyGate, tidyCutoffNorm, sixPitch, sixGate };
}
