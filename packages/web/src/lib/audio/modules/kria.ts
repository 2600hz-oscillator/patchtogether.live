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
    { id: 'gate1', type: 'gate', edge: 'gate' },
    { id: 'pitch2', type: 'pitch' },
    { id: 'gate2', type: 'gate', edge: 'gate' },
    { id: 'pitch3', type: 'pitch' },
    { id: 'gate3', type: 'gate', edge: 'gate' },
    { id: 'pitch4', type: 'pitch' },
    { id: 'gate4', type: 'gate', edge: 'gate' },
  ],
  params: [
    // Internal fallback tempo: used only when there's no TIMELORDE node AND no
    // external clock patched. With TIMELORDE present its bpm wins.
    { id: 'bpm', label: 'BPM', defaultValue: 120, min: 30, max: 300, curve: 'linear' },
    // Local transport. When a TIMELORDE node exists its `running` param drives
    // playback; otherwise this param (or an external clock) gates the run.
    { id: 'running', label: 'Run', defaultValue: 0, min: 0, max: 1, curve: 'discrete' },
  ],

  docs: {
    explanation:
      "A four-track grid sequencer modelled on the monome Kria, where each track is not one pattern but several layered ones: separate per-step lanes for trigger, note, octave, duration, probability, glide and ratchet, plus its own loop window (start + length), clock division and play direction (forward / reverse / ping-pong / drunk / random). All four tracks share a base 16th-note clock (from a TIMELORDE node, an external CLOCK IN, or the local BPM) but each can run at its own division and loop length, so the tracks drift in and out of phase to build long evolving lines. A shared scale and root quantize the note + octave lanes into pitch CV, and you can stash 16 whole patterns and cue between them quantized to the loop boundary. Each track emits a pitch CV (with optional glide) and a gate (shaped by its duration and subdivided by its ratchet). The card edits one track/page at a time; an optional monome grid drives the same edits.",
    inputs: {
      clock:
        "External base clock: each rising edge advances the shared 16th-note grid one tick, from which every track derives its own stepping via its clock division. When patched it overrides the internal BPM for step timing (the rack tempo still sets gate/glide durations), and the pulses themselves run the sequencer.",
      reset:
        "A rising edge (a trigger) re-anchors all four tracks to the start of their loop windows at once and clears any pending pattern cue, so everything restarts cleanly together.",
    },
    outputs: {
      pitch1:
        "Track 1's pitch CV (V/oct): the current step's note + octave lanes mapped through the shared scale and root, with the glide lane slewing the ramp between steps for portamento.",
      gate1:
        "Track 1's gate: goes high on steps whose trigger lane is set and whose probability roll passes; the duration lane sets how wide it stays high and the ratchet lane subdivides it into 1–4 evenly-spaced re-hits within the step.",
      pitch2: "Track 2's pitch CV (V/oct), quantized through the shared scale/root with its own glide slew.",
      gate2: "Track 2's gate: goes high on its own trigger-lane steps, with track 2's duration lane setting how wide it stays high and its probability and ratchet lanes shaping the rest.",
      pitch3: "Track 3's pitch CV (V/oct), quantized through the shared scale/root with its own glide slew.",
      gate3: "Track 3's gate: goes high on its own trigger-lane steps, with track 3's duration lane setting how wide it stays high and its probability and ratchet lanes shaping the rest.",
      pitch4: "Track 4's pitch CV (V/oct), quantized through the shared scale/root with its own glide slew.",
      gate4: "Track 4's gate: goes high on its own trigger-lane steps, with track 4's duration lane setting how wide it stays high and its probability and ratchet lanes shaping the rest.",
    },
    controls: {
      bpm:
        "Internal fallback tempo in beats per minute, used only when there is no TIMELORDE node in the rack AND nothing is patched into CLOCK IN; when a TIMELORDE is present its tempo wins, and an external clock overrides both.",
      running:
        "Local play/stop transport (1 = running, 0 = stopped), exposed as the card's RUN button. When a TIMELORDE node exists its run state drives playback instead, and an external clock's pulses can run the tracks regardless.",
      "kria-cell-{n}":
        "A cell of the per-step editor grid for the selected track — this is where you enter each step's value, INCLUDING its note. The same grid is reused by the lane selector (TRG / NTE / OCT / DUR / PRB / GLD / RAT): on the NOTE (NTE) lane it IS the per-step note entry — the lit row picks that step's scale DEGREE (bottom row = degree 0, up to degree 6), which the shared SCALE + ROOT then quantize into the track's pitch CV; on the other lanes the same cell instead sets the step's trigger, octave, gate duration, probability, glide time or ratchet count. Click a cell to set/clear it for the active lane; the column tracking the playhead is highlighted as it runs. A lane with fewer values than the grid has rows (OCTAVE has six, PROBABILITY and RATCHET have four) leaves the surplus rows visibly INERT rather than accepting clicks it cannot display. The same surface flips to the sixteen pattern slots, where a tap CUES a pattern and the engine swaps on the next loop boundary. (An attached monome grid drives these same edits through the same write path.)",
      'kria-loop-start-{n}':
        "The first step of the SELECTED track's loop window (1–16). Together with LEN this is what lets each track run a different length from its neighbours, so the four tracks drift in and out of phase instead of repeating in lockstep.",
      'kria-loop-length-{n}':
        "How many steps the SELECTED track plays before wrapping (1–16). The window wraps past step 16 if it starts late, so FROM 15 / LEN 4 plays steps 15, 16, 1, 2. Set to 16 the track never wraps early.",
      'kria-time-division-{n}':
        "The SELECTED track's clock division: how many base 16th-note ticks pass per step advance. 1 advances every tick, 4 advances once a beat, 16 once a bar. The divisions are a fixed roster (1, 2, 3, 4, 6, 8, 12, 16) rather than a free range, because a value between two of them is not a musical division.",
      'kria-direction-{n}':
        "Which way the SELECTED track walks its loop window: forward, reverse, ping-pong (bouncing off both ends without repeating them), drunk (a ±1 random walk) or random. Drunk and random re-roll every advance, so they never repeat exactly.",
      'kria-mute-{n}':
        "Silences the SELECTED track's gate output while leaving its pattern and its playhead intact — the track keeps walking, it just stops firing. Mute is not a per-step lane; it is a property of the whole track.",
      'kria-scale-{n}':
        "The scale the ACTIVE pattern quantizes every track's note lane into (major, minor, pentatonic or chromatic). The note lane stores a DEGREE, so changing the scale re-voices every step of all four tracks at once without editing a single note.",
      'kria-root-{n}':
        "The MIDI root note the ACTIVE pattern's scale is built on (C3 by default). Degree 0 of every track sounds this note; the per-step OCTAVE lane then adds whole octaves on top of it.",
    },
  },

  controlFamilies: [
    { id: 'kria-cell', label: 'Per-step editor cell (note on the NTE page)', kind: 'cell', testidPrefix: 'kria-cell' },
    // ⚠ ONE-MEMBER FAMILIES, the dx7/videocube convention: a card control with
    // no backing param has no other way to be RANKED on a face or keyed by the
    // docs gate (`face.order` resolves a key as a param, a family template, or
    // a numbered-legend entry — and a legend is an annotated-VRT artifact only
    // three modules have). Each `testidPrefix` is a LITERAL the card emits, so
    // `module-docs-lint`'s card grep can see it.
    //
    // Every one of these is a control the engine already implemented and the
    // docs already described while the ONLY editor for it was an attached
    // monome grid over WebSerial.
    { id: 'kria-loop-start',     label: 'Loop start step (selected track)',   kind: 'other', testidPrefix: 'kria-loop-start' },
    { id: 'kria-loop-length',    label: 'Loop length (selected track)',       kind: 'other', testidPrefix: 'kria-loop-length' },
    { id: 'kria-time-division',  label: 'Clock division (selected track)',    kind: 'other', testidPrefix: 'kria-time-division' },
    { id: 'kria-direction',      label: 'Play direction (selected track)',    kind: 'other', testidPrefix: 'kria-direction' },
    { id: 'kria-mute',           label: 'Track mute (selected track)',        kind: 'other', testidPrefix: 'kria-mute' },
    { id: 'kria-scale',          label: 'Pattern scale',                      kind: 'other', testidPrefix: 'kria-scale' },
    { id: 'kria-root',           label: 'Pattern root note',                  kind: 'other', testidPrefix: 'kria-root' },
  ],

  face: {
    // ⚠ THE GRID RANKS FIRST, AND UNTIL PF-22 IT COULD NOT.
    //
    // `kria-cell-{n}` resolves to a PF-14 PANEL, and `module-face-lint` refuses
    // a panel SELECTED at a lane tier — a panel declares its own `minWidth` and
    // a lane knob column is 46 px. The 'full' lane cap is six, so a panel's
    // first legal rank used to be SEVEN, a floor this module can never reach:
    // two params plus one control family is three rankable keys, total. That
    // arithmetic is why `curated-face.ts` listed kria as one of two modules that
    // "cannot have a faceplate AT ALL".
    //
    // PF-22 removed the cause rather than the symptom: `laneOrder` drops
    // `face.hero.cell` from the LANE roster only, so a hero picture costs no
    // lane rank and may rank first. The 46 px protection is untouched — the
    // panel still cannot be selected into a knob column — and the ranking now
    // says what it means. kria is that fix's first real adopter.
    //
    // ⚠ AND THE RANK IS HONEST RATHER THAN CONVENIENT. Both params are
    // FALLBACKS: `bpm` applies only with no TIMELORDE and no external clock, and
    // `running` yields to TIMELORDE's transport when one exists — and the rack
    // AUTO-SPAWNS a TIMELORDE. So in the default product configuration neither
    // of this module's two params does anything, and the two controls the param
    // system knows about are the two least important controls on the
    // instrument. Everything a player plays is the grid.
    order: [
      'kria-cell-{n}',
      'running',
      'bpm',
      'kria-loop-start-{n}',
      'kria-loop-length-{n}',
      'kria-time-division-{n}',
      'kria-direction-{n}',
      'kria-mute-{n}',
      'kria-scale-{n}',
      'kria-root-{n}',
    ],

    // No audio output at all — four `pitch` and four `gate` ports — so
    // `primaryAudioOutPortId` is null and every live-glyph literal would fall to
    // a dead static picture. A layout-source glyph would be worse than useless
    // here rather than merely uninformative: `ShellExtensionGlyphProps` carries
    // no nodeId, so every kria in the rack would draw the SAME sixteen steps,
    // and on this module the sequence IS the instrument. (Worth recording for
    // whoever picks that platform PR up: a `nodeId` prop alone would still not
    // be enough here — the picture a player wants is the playhead over the
    // SELECTED track's SELECTED lane, which is two more pieces of node.data.)
    glyph: 'none',

    // The grid, promoted to the dock's hero slot. It suppresses the hero glyph,
    // which costs exactly nothing on a module that has no glyph to suppress.
    hero: { cell: 'kria-cell-{n}' },

    // ⚠ THREE BANDS, NO TAB RAIL, and the temptation is worth naming. Kria's
    // HARDWARE is organised as pages, so mirroring TRIG / NOTE / OCTAVE /
    // DURATION / PROBABILITY / GLIDE / RATCHET / LOOP / TIME / DIRECTION /
    // SCALE / PATTERN would clear the seven-band rail threshold easily. That
    // would be padding. The per-step lanes are not bands at all — they are
    // WHICH LANE THE GRID IS EDITING, one selection, and giving each a header
    // would spend twelve section titles expressing one choice. LOOP and TIME
    // are the same idea twice (how this track walks the grid), so they are
    // CLUSTERS, not pages. The honest grouping lands at three.
    pages: [
      {
        id: 'transport',
        label: 'transport',
        hint:
          'both of these are FALLBACKS: the rack auto-spawns a TIMELORDE, and while one exists ' +
          'its tempo and its run state drive this module — so in a default rack neither control ' +
          'here does anything. Patch CLOCK IN and the external pulses win over both.',
        controls: ['kria-cell-{n}', 'running', 'bpm'],
      },
      {
        id: 'track',
        label: 'track',
        hint:
          'per-track, and they are what make the four tracks drift apart: each walks the shared ' +
          '16th-note clock at its OWN division over its OWN loop window, so a 12-step track and a ' +
          '16-step track only agree every 48 steps. That drift is the instrument.',
        controls: [
          'kria-loop-start-{n}',
          'kria-loop-length-{n}',
          'kria-time-division-{n}',
          'kria-direction-{n}',
          'kria-mute-{n}',
        ],
        clusters: [
          { label: 'loop', controls: ['kria-loop-start-{n}', 'kria-loop-length-{n}'] },
          { label: 'time', controls: ['kria-time-division-{n}', 'kria-direction-{n}'] },
        ],
      },
      {
        id: 'scale',
        label: 'scale',
        hint:
          'shared by all four tracks of the ACTIVE pattern. The note lane picks a DEGREE, not a ' +
          'chromatic pitch, so these two decide what every degree on every track sounds like.',
        controls: ['kria-scale-{n}', 'kria-root-{n}'],
      },
    ],
  },

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
