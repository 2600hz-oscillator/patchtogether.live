// packages/web/src/lib/audio/modules/kria.ts
//
// KRIA — a clean-room reimplementation of monome's Kria grid step-sequencer
// (inspired by monome Kria; behavior reimagined from monome's public docs, NO
// monome source or doc prose reproduced). 4 independent tracks, each with its
// own per-step TRIG / NOTE / OCTAVE / DURATION sequence, per-track LOOP / TIME
// (clock division) / DIRECTION, per-step PROBABILITY + GLIDE, a shared SCALE,
// and 16 pattern slots with QUANTIZED (cued) pattern switching. The module is
// driven by a monome grid 128 over WebSerial (lib/control/monome) AND fully usable from
// its on-card UI with a mouse.
//
// Clock = the rack's TIMELORDE singleton (read live from the graph store): runs
// only while TIMELORDE.running ≥ 0.5, tempo = TIMELORDE.bpm. Each track advances
// at its own TIME clock-division off the shared scheduler-clock two-clocks
// lookahead (same discipline as sequencer.ts). An external CLOCK IN input
// overrides the internal tempo (windowed edge counter — never a whole-buffer
// rescan, the double-count bug). A RESET IN rising edge re-anchors every track
// to its loop start.
//
// Inputs:
//   clock (gate)  — external clock; rising edges advance the base step grid.
//   reset (gate)  — rising edge resets every track to its loop start.
// Outputs (Ansible Kria shape — 4 CV + 4 gate):
//   pitch1..4 (pitch) — per-track V/oct (with per-step glide slew).
//   gate1..4  (gate)  — per-track gate (DURATION shapes width; ratchet subdivides).
// Params:
//   bpm      — fallback tempo when no TIMELORDE node + no external clock.
//   running  — transport (mirrors TIMELORDE.running when present; else local).

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import { patch as livePatch } from '$lib/graph/store';
import { getSchedulerClock } from '$lib/audio/scheduler-clock';
import { createEdgeCounter } from '$lib/audio/edge-detect';
import { isInputPortConnected } from './transport-helpers';
import {
  activePattern,
  patternAt,
  stepVOct,
  advanceStep,
  willWrap,
  initialCursor,
  tickCue,
  KRIA_TRACKS,
  type KriaData,
  type KriaPattern,
  type KriaCursor,
  type CueState,
} from './kria-types';

export const kriaDef: AudioModuleDef = {
  type: 'kria',
  palette: { top: 'Audio modules', sub: 'sequencers' },
  domain: 'audio',
  label: 'kria',
  category: 'modulation',
  schemaVersion: 1,
  // Big card: 4 track rows × 16 steps + page/track selectors. 3u tile.
  size: '3u',
  hp: 4,

  inputs: [
    // Both are rising-edge TRIGGERS (advance / re-anchor), edge-detected on the
    // main thread via the canonical windowed createEdgeCounter (no whole-buffer
    // rescan double-count).
    { id: 'clock', type: 'gate', edge: 'trigger' },
    { id: 'reset', type: 'gate', edge: 'trigger' },
  ],
  outputs: [
    { id: 'pitch1', type: 'pitch' },
    { id: 'gate1', type: 'gate' },
    { id: 'pitch2', type: 'pitch' },
    { id: 'gate2', type: 'gate' },
    { id: 'pitch3', type: 'pitch' },
    { id: 'gate3', type: 'gate' },
    { id: 'pitch4', type: 'pitch' },
    { id: 'gate4', type: 'gate' },
  ],
  params: [
    // Internal fallback tempo: used only when there's no TIMELORDE node AND no
    // external clock patched. With TIMELORDE present its bpm wins.
    { id: 'bpm', label: 'BPM', defaultValue: 120, min: 30, max: 300, curve: 'linear' },
    // Local transport. When a TIMELORDE node exists its `running` param drives
    // playback; otherwise this param (or an external clock) gates the run.
    { id: 'running', label: 'Run', defaultValue: 0, min: 0, max: 1, curve: 'discrete' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    const nodeId = node.id;

    // Per-track pitch + gate ConstantSources.
    const pitchSrc: ConstantSourceNode[] = [];
    const gateSrc: ConstantSourceNode[] = [];
    for (let t = 0; t < KRIA_TRACKS; t++) {
      const p = ctx.createConstantSource();
      const g = ctx.createConstantSource();
      p.offset.value = 0;
      g.offset.value = 0;
      p.start();
      g.start();
      pitchSrc.push(p);
      gateSrc.push(g);
    }

    // --- clock input (windowed edge counter — never a whole-buffer rescan) ---
    const clockInGain = ctx.createGain();
    const clockInAnalyser = ctx.createAnalyser();
    clockInAnalyser.fftSize = 2048;
    clockInGain.connect(clockInAnalyser);
    const clockInSilence = ctx.createConstantSource();
    clockInSilence.offset.value = 0;
    clockInSilence.start();
    clockInSilence.connect(clockInGain);
    const clockCounter = createEdgeCounter({ ctx, analyser: clockInAnalyser });

    // --- reset input ---
    const resetGain = ctx.createGain();
    const resetAnalyser = ctx.createAnalyser();
    resetAnalyser.fftSize = 2048;
    resetGain.connect(resetAnalyser);
    const resetSilence = ctx.createConstantSource();
    resetSilence.offset.value = 0;
    resetSilence.start();
    resetSilence.connect(resetGain);
    const resetCounter = createEdgeCounter({ ctx, analyser: resetAnalyser });

    let alive = true;
    let unsubscribeTick: (() => void) | null = null;
    const LOOKAHEAD_S = 0.2;

    // Per-track playback state.
    const cursor: KriaCursor[] = [];
    // Per-track countdown of base-grid ticks until the next advance (TIME div).
    const divCountdown: number[] = new Array(KRIA_TRACKS).fill(0);
    // Internal-mode next base-step time + base step counter.
    let nextStepTime = ctx.currentTime + 0.05;
    // Cue/pattern state (track-0 quantized switching).
    let cue: CueState = { active: 0, cued: null, countdown: 0 };
    let prevRunning = false;

    // Test/UI mirrors.
    const lastEmittedVOct: number[] = new Array(KRIA_TRACKS).fill(0);
    const lastEmittedGate: number[] = new Array(KRIA_TRACKS).fill(0);
    const currentStepIdx: number[] = new Array(KRIA_TRACKS).fill(0);
    let totalAdvances = 0;

    function liveData(): KriaData | undefined {
      return livePatch.nodes[nodeId]?.data as KriaData | undefined;
    }
    function readParam(id: string, fallback: number): number {
      const v = livePatch.nodes[nodeId]?.params?.[id];
      return typeof v === 'number' ? v : fallback;
    }
    function writeActive(idx: number): void {
      const live = livePatch.nodes[nodeId];
      if (!live) return;
      if (!live.data) live.data = {};
      const d = live.data as KriaData;
      d.active = idx; // guard:allow-raw-write — engine quantize-switch during the tick, not a user edit
      d.cued = null;
    }
    function isClockConnected(): boolean {
      return isInputPortConnected(Object.values(livePatch.edges), nodeId, 'clock');
    }

    /** Find the TIMELORDE node's bpm + running, if one exists. */
    function readTimelorde(): { bpm: number; running: boolean } | null {
      for (const n of Object.values(livePatch.nodes)) {
        if (n?.type === 'timelorde') {
          const bpm = typeof n.params?.bpm === 'number' && n.params.bpm > 0 ? n.params.bpm : 120;
          const running = (typeof n.params?.running === 'number' ? n.params.running : 1) >= 0.5;
          return { bpm, running };
        }
      }
      return null;
    }

    function resolveTransport(): { bpm: number; running: boolean } {
      const tl = readTimelorde();
      const externalClock = isClockConnected();
      if (externalClock) {
        // Clock-only mode: the clock pulses ARE the run signal. Tempo (for gate
        // length) still comes from TIMELORDE/param.
        return { bpm: tl?.bpm ?? readParam('bpm', 120), running: true };
      }
      if (tl) return tl;
      return { bpm: readParam('bpm', 120), running: readParam('running', 0) >= 0.5 };
    }

    function resetAll(): void {
      const pat = activePattern(liveData());
      for (let t = 0; t < KRIA_TRACKS; t++) {
        cursor[t] = pat ? initialCursor(pat.tracks[t]!) : { pos: 0, dir: 1 };
        divCountdown[t] = 0;
      }
    }
    resetAll();

    function silenceAll(at: number): void {
      for (let t = 0; t < KRIA_TRACKS; t++) {
        gateSrc[t]!.offset.cancelScheduledValues(at);
        gateSrc[t]!.offset.setValueAtTime(0, at);
        lastEmittedGate[t] = 0;
      }
    }

    /** Emit one track's step (pitch + gate, with glide + ratchet) at audio
     *  time `at`, given the step duration. */
    function emitTrackStep(
      pat: KriaPattern,
      t: number,
      step: number,
      at: number,
      stepDur: number,
    ): void {
      const track = pat.tracks[t]!;
      currentStepIdx[t] = step;
      const voct = stepVOct(pat, track, step);
      const glide = track.glide[step] ?? 0;
      // Glide: ramp the pitch toward the new value over the glide time; else
      // jump. setTargetAtTime would be exponential; a linear ramp matches a
      // simple portamento and is deterministic for tests.
      const pParam = pitchSrc[t]!.offset;
      if (glide > 0) {
        pParam.setValueAtTime(pParam.value, at);
        pParam.linearRampToValueAtTime(voct, at + Math.min(glide, stepDur));
      } else {
        pParam.setValueAtTime(voct, at);
      }
      lastEmittedVOct[t] = voct;

      // Trigger gating: muted, trig off, or failed probability roll → no gate.
      const prob = track.probability[step] ?? 1;
      const fire = !track.muted && track.trig[step] && (prob >= 1 || Math.random() < prob);
      const g = gateSrc[t]!.offset;
      if (!fire) {
        g.setValueAtTime(0, at);
        lastEmittedGate[t] = 0;
        return;
      }
      const durFrac = Math.max(0.02, Math.min(1, track.duration[step] ?? 0.5));
      const gateOff = stepDur * durFrac;
      const ratchet = Math.max(1, Math.min(4, Math.round(track.ratchet[step] ?? 1)));
      if (ratchet <= 1) {
        g.setValueAtTime(1, at);
        g.setValueAtTime(0, at + gateOff);
      } else {
        // Ratchet: subdivide the step into `ratchet` evenly-spaced sub-hits.
        const sub = stepDur / ratchet;
        const subOff = Math.max(0.005, sub * durFrac);
        for (let r = 0; r < ratchet; r++) {
          const subAt = at + r * sub;
          g.setValueAtTime(1, subAt);
          g.setValueAtTime(0, subAt + subOff);
        }
      }
      lastEmittedGate[t] = 1;
    }

    /** Advance all tracks ONE base-grid tick at audio time `at`. Each track
     *  only advances when its TIME-division countdown hits zero. Track 0's
     *  loop boundary drives the pattern-cue quantize. */
    function advanceBaseTick(at: number, stepDur: number): void {
      const pat = activePattern(liveData());
      if (!pat) return;
      let track0Boundary = false;
      let track0Advanced = false;
      for (let t = 0; t < KRIA_TRACKS; t++) {
        if (divCountdown[t]! > 0) {
          divCountdown[t]!--;
          continue;
        }
        const track = pat.tracks[t]!;
        // Reset the division countdown for the NEXT advance.
        divCountdown[t] = Math.max(1, Math.round(track.timeDivision)) - 1;
        if (!cursor[t]) cursor[t] = initialCursor(track);
        const boundary = willWrap(track, cursor[t]!);
        const { step, cursor: next } = advanceStep(track, cursor[t]!);
        cursor[t] = next;
        emitTrackStep(pat, t, step, at, stepDur * Math.max(1, Math.round(track.timeDivision)));
        if (t === 0) {
          track0Advanced = true;
          if (boundary) track0Boundary = true;
        }
        totalAdvances++;
      }
      // Pattern-cue quantize — only ticks when track 0 actually ADVANCED this
      // base tick (so a track-0 TIME division > 1 doesn't over-count the cue
      // clock on the ticks where track 0 was skipped).
      if (track0Advanced) {
        const data = liveData();
        const cued = data?.cued ?? null;
        const cueSteps = typeof data?.cueSteps === 'number' ? Math.max(0, data.cueSteps) : 0;
        if (cued !== null && cued !== cue.cued) {
          // Newly cued — seed the countdown.
          cue = { active: cue.active, cued, countdown: cueSteps > 0 ? cueSteps : 0 };
        }
        // Only tick the cue on a track-0 advance (the base musical pulse).
        const r = tickCue(cue, cueSteps, track0Boundary);
        cue = r.state;
        if (r.switched && patternAt(liveData(), cue.active)) {
          writeActive(cue.active);
          resetAll();
        }
      }
    }

    function tick(): void {
      if (!alive) return;
      try {
        // Adopt a peer/card-driven active-pattern change (synced). If active
        // diverges from our cue.active and nothing is cued, follow it.
        const d0 = liveData();
        const syncedActive =
          typeof d0?.active === 'number' ? d0.active : 0;
        if (syncedActive !== cue.active && (d0?.cued ?? null) === null) {
          cue = { active: syncedActive, cued: null, countdown: 0 };
          resetAll();
        }

        // reset gate — re-anchor everything.
        if (resetCounter.poll(ctx.currentTime) > 0) {
          resetAll();
          nextStepTime = ctx.currentTime + 0.01;
        }

        const { bpm, running } = resolveTransport();

        if (running && !prevRunning) {
          resetAll();
          nextStepTime = ctx.currentTime + 0.05;
          silenceAll(ctx.currentTime);
        } else if (!running && prevRunning) {
          silenceAll(ctx.currentTime);
        }
        prevRunning = running;
        if (!running) {
          nextStepTime = ctx.currentTime + 0.05;
          return;
        }

        const stepDur = 60 / Math.max(1, bpm) / 4; // 16th-note base grid

        if (isClockConnected()) {
          const edges = clockCounter.poll(ctx.currentTime);
          for (let e = 0; e < edges; e++) {
            advanceBaseTick(ctx.currentTime + 0.005, stepDur);
          }
        } else {
          while (nextStepTime < ctx.currentTime + LOOKAHEAD_S) {
            advanceBaseTick(nextStepTime, stepDur);
            nextStepTime += stepDur;
          }
        }
      } catch (err) {
        console.error('[kria] tick error', err);
      }
    }

    unsubscribeTick = getSchedulerClock().subscribe(tick);

    const outputs = new Map<string, { node: AudioNode; output: number }>();
    for (let t = 0; t < KRIA_TRACKS; t++) {
      outputs.set(`pitch${t + 1}`, { node: pitchSrc[t]!, output: 0 });
      outputs.set(`gate${t + 1}`, { node: gateSrc[t]!, output: 0 });
    }

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number }>([
        ['clock', { node: clockInGain, input: 0 }],
        ['reset', { node: resetGain, input: 0 }],
      ]),
      outputs,
      setParam() {
        /* tick reads node.params live each iteration */
      },
      readParam(paramId) {
        const v = livePatch.nodes[nodeId]?.params?.[paramId];
        return typeof v === 'number' ? v : undefined;
      },
      read(key) {
        if (typeof key !== 'string') return undefined;
        if (key === 'totalAdvances') return totalAdvances;
        if (key === 'activePattern') return cue.active;
        if (key === 'cued') return cue.cued === null ? -1 : cue.cued;
        const m = key.match(/^(pitchVOct|gateValue|currentStep):(\d)$/);
        if (m) {
          const t = Number(m[2]);
          if (t < 0 || t >= KRIA_TRACKS) return undefined;
          if (m[1] === 'pitchVOct') return lastEmittedVOct[t];
          if (m[1] === 'gateValue') return lastEmittedGate[t];
          if (m[1] === 'currentStep') return currentStepIdx[t];
        }
        return undefined;
      },
      dispose() {
        alive = false;
        if (unsubscribeTick) {
          unsubscribeTick();
          unsubscribeTick = null;
        }
        for (let t = 0; t < KRIA_TRACKS; t++) {
          try { pitchSrc[t]!.stop(); } catch { /* */ }
          try { gateSrc[t]!.stop(); } catch { /* */ }
          pitchSrc[t]!.disconnect();
          gateSrc[t]!.disconnect();
        }
        try { clockInSilence.stop(); } catch { /* */ }
        try { resetSilence.stop(); } catch { /* */ }
        clockInSilence.disconnect();
        clockInGain.disconnect();
        clockInAnalyser.disconnect();
        resetSilence.disconnect();
        resetGain.disconnect();
        resetAnalyser.disconnect();
      },
    };
  },
};
