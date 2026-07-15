// packages/web/src/lib/audio/modules/clipplayer.ts
//
// CLIP PLAYER (v2) — an Ableton-Session-style clip launcher with 8 INSTRUMENT
// LANES. Rows = instruments (8), columns = clip slots (8) → 64 note clips. Each
// lane independently plays its launched clip out its OWN pitch/gate/velocity
// outputs, so up to 8 clips sound at once (one per instrument). A monome grid
// drives it (lib/control/monome) and the card is the always-available editor + launcher.
//
// Clock: LOCKED TO TIMELORDE (the rack transport). The module runs only while
// TIMELORDE.running, at TIMELORDE.bpm, and freezes when it stops — no internal
// BPM, no clock-input cable. A STEP-division param sets steps-per-beat. (See
// the plan doc §10 + clip-types.ts.)
//
// Inputs:  stop_all (trigger) — rising edge stops every lane.
//          reset    (trigger) — rising edge snaps every ACTIVE lane to step 1.
// Outputs: pitch1..8 (polyPitchGate) / gate1..8 / vel1..8 — one set per lane.
// Params:  stepDiv (1/4..1/32), octave, gateLength, quantize (launch snap).
// Per-lane clock RATE (1/8..4x, card dropdown → data.rate) scales each lane's
// step duration off the global STEP grid — see clip-clock.ts for the model +
// phase rule (common origin at transport start / RESET).

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import type { ModuleNode } from '$lib/graph/types';
import { patch as livePatch, ydoc } from '$lib/graph/store';
import { getActiveEngine } from '$lib/audio/engine-ref';
import { resolveSurfaceParam } from '$lib/graph/control-surface-params';
import { valueToFrac, fracToValue } from '$lib/electra/curve';
import { AutomationController } from './clip-automation-controller';
import { plainAutomationClip } from './clip-automation';
import {
  registerAutomationController,
  unregisterAutomationController,
} from '$lib/audio/automation-touch';
import type { RampPoint } from './clip-automation-engine';
import { createPolySender, POLY_CHANNEL_PAIRS } from '$lib/audio/poly';
import { createVoiceAllocator, type VoiceAllocator } from '$lib/audio/poly-alloc';
import { getSchedulerClock } from '$lib/audio/scheduler-clock';
import { createEdgeCounter } from '$lib/audio/edge-detect';
import { midiToVOct } from '$lib/audio/note-entry';
import { isInputPortConnected } from './transport-helpers';
import { setLanePlayhead, clearPlayheads } from './clip-playhead';
import { drainAudition, clearAudition } from './clip-audition';
import {
  readClip,
  lanesForStep,
  clipIndex,
  CLIP_LANES,
  CLIP_COUNT,
  laneMuted,
  laneSwing,
  swingStepOffset,
  isAutomationRecorder,
  type ClipPlayerData,
  type AutomationTarget,
  type AutomationTrack,
} from './clip-types';
import { clipDivIndex, laneStepDur, RATE_DEFAULT_INDEX } from './clip-clock';
import {
  coerceArrangeData,
  recordEvent,
  clearArrange,
  eventsInRange,
  arrangeLengthBeats,
  type ArrangeEvent,
  type ArrangeSlot,
  type ClipPlayMode,
} from './clip-arrange';

/** steps-per-beat for each stepDiv index (0=1/4 … 3=1/32). */
const STEP_DIV_SPB = [1, 2, 4, 8] as const;

/** Fall→rise gap (s) when an audition voice-lane changes owner (LRU-steal, or a
 *  freed lane re-taken in the same drain). Two clean setValueAtTime edges — a
 *  brief gate dip so the downstream envelope RE-ATTACKS at the new pitch, never a
 *  silent pitch swap under a held gate (gate/held-note plan §3.2 invariant). */
const AUDITION_STEAL_GAP_S = 0.003;

export const clipplayerDef: AudioModuleDef = {
  type: 'clipplayer',
  palette: { top: 'Audio modules', sub: 'sequencers' },
  domain: 'audio',
  label: 'clip player',
  category: 'modulation',
  // 8×8 clip grid (capped) + piano-roll note editor + transport — fits a 3u tile.
  size: '3u',
  hp: 2,

  inputs: [
    // Both are TRIGGERS (declared, per CLAUDE.md): fire ONCE per rising edge,
    // detected through the shared windowed edge counter ($lib/audio/edge-detect).
    { id: 'stop_all', type: 'gate', edge: 'trigger' },
    { id: 'reset', type: 'gate', edge: 'trigger' },
  ],
  outputs: Array.from({ length: CLIP_LANES }, (_, i) => [
    { id: `pitch${i + 1}`, type: 'polyPitchGate' as const },
    { id: `gate${i + 1}`, type: 'gate' as const },
    { id: `vel${i + 1}`, type: 'cv' as const },
  ]).flat(),
  params: [
    // stepDiv: 0=1/4, 1=1/8, 2=1/16 (default), 3=1/32 — steps per TIMELORDE beat.
    { id: 'stepDiv', label: 'Step', defaultValue: 2, min: 0, max: 3, curve: 'discrete' },
    { id: 'octave', label: 'Oct', defaultValue: 0, min: -2, max: 2, curve: 'discrete' },
    { id: 'gateLength', label: 'Gate', defaultValue: 0.9, min: 0.1, max: 1, curve: 'linear' },
    // 0 = launch immediately, 1 = quantize to the lane's clip-loop boundary.
    { id: 'quantize', label: 'Qnt', defaultValue: 1, min: 0, max: 1, curve: 'discrete' },
    // Gate-sampled Sample & Hold on every lane's pitch CV (ONE global toggle
    // for all 8 lanes — this replaces the 8 external S&H modules). ON
    // (default): on an EMPTY step (a rest) the per-voice gate still closes but
    // pitch HOLDS its last value, so each lane's pitch CV latches to the gate
    // edge instead of resetting to 0/C4 on every rest. OFF: rests rewrite
    // pitch=0 (the legacy continuous behavior). Default-ON changes existing
    // patches by design.
    { id: 'snh', label: 's&h', defaultValue: 1, min: 0, max: 1, curve: 'discrete' },
  ],

  exposesSequence: true,

  docs: {
    explanation:
      "A clip launcher in the style of Ableton's Session view, with 8 instrument lanes. The grid's rows are the 8 lanes (instruments) and the columns are 8 clip slots, for 64 note clips in all; each lane independently plays whichever clip you launch out its OWN pitch/gate/velocity outputs, so up to 8 clips can sound at once (one per lane). Click a pad to launch its clip, double-click to open the piano-roll editor and draw notes into it. There's no internal clock or BPM — CLIP PLAYER is locked to TIMELORDE (the rack transport): it runs at TIMELORDE's tempo, only while TIMELORDE is running, and the STEP control sets how many steps fall per beat. Each lane also has its own clock-rate dropdown (1/8 · 1/4 · 1/2 · 1 · 2x · 4x, card-only for now) that divides or multiplies that lane's step rate off the global STEP grid — polyrhythms without leaving the card — and because the tempo comes from TIMELORDE, 2x/4x are exact from the first step. All lanes share a common phase origin (transport start or the RST button), so a 1/2 lane lands on even base steps and stays locked to the others; RST (also a MIDI-assignable button, and the reset input) snaps every active lane back to step 1 and re-anchors that shared origin. Launches can fire immediately or be quantized to snap cleanly at the playing clip's loop boundary. It also has a SONG / arrangement mode that records your launches onto a timeline for non-real-time playback, and pairs with a monome grid for hardware launching. Drive its lanes into eight voices for a full multitrack clip-based performance instrument.",
    inputs: {
      stop_all: "Stop-all trigger: a rising edge immediately stops every lane (a panic/stop button), in both session and arrangement modes.",
      reset: "Reset trigger: a rising edge snaps every ACTIVE lane back to step 1 and re-anchors all lanes to a shared phase origin (divided/multiplied lanes restart their counting together). Queued-but-not-started launches are untouched — they still drop in at their lane's next loop boundary. Stopped lanes stay stopped; the arrangement's song position is not rewound (this is a clip-step reset, not a transport rewind).",
    },
    outputs: {
      pitch1: "Lane 1's pitch output — the launched clip's notes as a poly chord cable (a mono pitch input receives just the root; a poly voice plays the whole chord), shifted by the OCT control.",
      pitch2: "Lane 2's pitch output (poly chord cable), from lane 2's launched clip.",
      pitch3: "Lane 3's pitch output (poly chord cable), from lane 3's launched clip.",
      pitch4: "Lane 4's pitch output (poly chord cable), from lane 4's launched clip.",
      pitch5: "Lane 5's pitch output (poly chord cable), from lane 5's launched clip.",
      pitch6: "Lane 6's pitch output (poly chord cable), from lane 6's launched clip.",
      pitch7: "Lane 7's pitch output (poly chord cable), from lane 7's launched clip.",
      pitch8: "Lane 8's pitch output (poly chord cable), from lane 8's launched clip.",
      gate1: "Lane 1's gate — goes high while a note in lane 1's clip plays (its width set by GATE; tied/held notes stay high across their span); low on rests. Patch into an envelope/VCA.",
      gate2: "Lane 2's gate — high while lane 2's notes play, low on rests.",
      gate3: "Lane 3's gate — high while lane 3's notes play, low on rests.",
      gate4: "Lane 4's gate — high while lane 4's notes play, low on rests.",
      gate5: "Lane 5's gate — high while lane 5's notes play, low on rests.",
      gate6: "Lane 6's gate — high while lane 6's notes play, low on rests.",
      gate7: "Lane 7's gate — high while lane 7's notes play, low on rests.",
      gate8: "Lane 8's gate — high while lane 8's notes play, low on rests.",
      vel1: "Lane 1's velocity CV — each note's velocity as a control voltage, for velocity-sensitive patching (e.g. into a VCA or filter depth).",
      vel2: "Lane 2's velocity CV.",
      vel3: "Lane 3's velocity CV.",
      vel4: "Lane 4's velocity CV.",
      vel5: "Lane 5's velocity CV.",
      vel6: "Lane 6's velocity CV.",
      vel7: "Lane 7's velocity CV.",
      vel8: "Lane 8's velocity CV.",
    },
    controls: {
      stepDiv: "STEP — how many steps fall per TIMELORDE beat (1/4, 1/8, 1/16, 1/32), i.e. the playback resolution of the clips.",
      octave: "OCT — transposes every lane's pitch output up or down by whole octaves (-2..+2).",
      gateLength: "GATE — how much of each step the per-note gate stays high, from short staccato stabs to near-legato (held/tied notes ignore this and stay high across their full span).",
      quantize: "QNT — launch quantization: on, a clip you launch waits and drops in cleanly at the playing lane's next loop boundary; off, it launches immediately. (A first launch into an empty lane is always immediate.)",
      snh: "S&H — one global sample-and-hold toggle for all 8 lanes' pitch outputs: on (default), on a rest the gate closes but each lane's pitch HOLDS its last note (latched to the gate edge); off, rests reset pitch to 0 (the legacy continuous behavior).",
      "clipplayer-mono-{n}":
        "Lane {n}'s mono/poly toggle — switches that lane between MONO (one note per column) and POLY (up to five notes per column, played as a chord out the lane's poly pitch output).",
      "clipplayer-rate-{n}":
        "Lane {n}'s clock-rate dropdown (right of the lane's launch row) — divides or multiplies the lane's step rate off the global STEP grid: 1/8, 1/4 and 1/2 advance the lane every 8th/4th/2nd base step; 2x and 4x advance it 2×/4× per base step (exact, since the tempo comes from TIMELORDE); 1 (the default) runs on the STEP grid. All lanes count from a shared phase origin (transport start or RST), so divided lanes stay locked to the others. Card-only for now — no monome-grid/Launchpad surface.",
      "clipplayer-pad-{n}":
        "A clip slot in the launch grid (one cell of the 8 lanes × 8 slots). Click to launch that lane's clip (immediately or quantized per QNT), click the playing pad to stop the lane, and double-click to open the clip in the piano-roll editor. An empty pad shows differently from a filled or playing one.",
      "clipplayer-cell-{n}":
        "A note cell in the piano-roll editor (rows are scale degrees/pitches, columns are steps). Click to toggle a note on or off at that pitch and step; right-click cycles the note's velocity. The cells make up the clip you're editing for the selected lane+slot.",
    },
  },

  controlFamilies: [
    { id: 'clipplayer-mono', label: 'Per-lane mono/poly toggle', kind: 'other', testidPrefix: 'clipplayer-mono' },
    { id: 'clipplayer-rate', label: 'Per-lane clock rate (mult/div)', kind: 'other', testidPrefix: 'clipplayer-rate' },
    { id: 'clipplayer-pad', label: 'Clip launch grid', kind: 'cell', testidPrefix: 'clipplayer-pad' },
    { id: 'clipplayer-cell', label: 'Piano-roll note cells', kind: 'cell', testidPrefix: 'clipplayer-cell' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    const nodeId = node.id;
    const LANES = CLIP_LANES;
    const LOOKAHEAD_S = 0.2;

    interface Lane {
      poly: ReturnType<typeof createPolySender>;
      gateSrc: ConstantSourceNode;
      velSrc: ConstantSourceNode;
      stepIndex: number;
      nextStepTime: number;
      // LATCHED effective clock-rate index (into RATE_MULTS) for the step
      // duration — re-read from the active clip's `div` (or the lane rate) ONLY
      // at a loop boundary (stepIndex 0), so a mid-loop Clip-Div edit takes
      // effect at the NEXT clip start, never mid-loop.
      divIndex: number;
      active: number | null; // active slot (column) in this lane, or null
      lastVOct: number;
      lastGate: number;
      lastVel: number;
      // Ring of recently-scheduled (audio time → step) for an audio-accurate
      // visual playhead (steps are scheduled LOOKAHEAD_S ahead of currentTime).
      sched: { t: number; idx: number }[];
      // LIVE AUDITION (KEYS keyboard). A STABLE per-voice allocator maps each
      // held MIDI note → a poly voice-lane and KEEPS it until that note is
      // released (Phase 2a, gate/held-note plan §3.2). Replaces the old
      // positional repack: releasing a low note no longer shifts the others down
      // a lane (which rewrote pitch on a still-sounding voice → glitch).
      alloc: VoiceAllocator;
      // The MIDI note (or null) currently WRITTEN to each poly voice-lane, so a
      // drain reconciles ownership → the MINIMUM set of clean gate/pitch edges
      // (a held voice whose owner is unchanged is never re-written).
      laneKey: (number | null)[];
      /** velocity 0..1 of the most-recent live-audition note-on. */
      audVel: number;
    }
    const lanes: Lane[] = Array.from({ length: LANES }, () => {
      const poly = createPolySender(ctx);
      const gateSrc = ctx.createConstantSource();
      const velSrc = ctx.createConstantSource();
      gateSrc.offset.value = 0;
      velSrc.offset.value = 0;
      gateSrc.start();
      velSrc.start();
      return {
        poly,
        gateSrc,
        velSrc,
        stepIndex: 0,
        nextStepTime: ctx.currentTime + 0.05,
        divIndex: RATE_DEFAULT_INDEX,
        active: null,
        lastVOct: 0,
        lastGate: 0,
        lastVel: 0,
        sched: [],
        alloc: createVoiceAllocator(POLY_CHANNEL_PAIRS),
        laneKey: new Array<number | null>(POLY_CHANNEL_PAIRS).fill(null),
        audVel: 0,
      };
    });

    /** The step lane L is currently SOUNDING (the latest scheduled step whose
     *  time has passed), or -1 when the lane is stopped. Audio-accurate (not the
     *  lookahead position) so the card + grid playhead tracks what you hear. */
    function laneDisplayStep(L: number): number {
      const ln = lanes[L];
      if (ln.active === null) return -1;
      let best = -1;
      let bestT = -Infinity;
      for (const e of ln.sched) {
        if (e.t <= ctx.currentTime && e.t > bestT) {
          bestT = e.t;
          best = e.idx;
        }
      }
      return best;
    }

    // --- stop_all input (windowed edge counter — no whole-buffer rescan) ---
    const stopGain = ctx.createGain();
    const stopAnalyser = ctx.createAnalyser();
    stopAnalyser.fftSize = 2048;
    stopGain.connect(stopAnalyser);
    const stopSilence = ctx.createConstantSource();
    stopSilence.offset.value = 0;
    stopSilence.start();
    stopSilence.connect(stopGain);
    const stopCounter = createEdgeCounter({ ctx, analyser: stopAnalyser });

    // --- reset input (same windowed edge-counter seam as stop_all) ---
    const resetGain = ctx.createGain();
    const resetAnalyser = ctx.createAnalyser();
    resetAnalyser.fftSize = 2048;
    resetGain.connect(resetAnalyser);
    const resetSilence = ctx.createConstantSource();
    resetSilence.offset.value = 0;
    resetSilence.start();
    resetSilence.connect(resetGain);
    const resetCounter = createEdgeCounter({ ctx, analyser: resetAnalyser });
    // Card RST button intent (synced counter on node.data — see ClipPlayerData.
    // resetNonce). null = "not yet seen": the first tick ADOPTS the current
    // value without firing, so loading a saved patch never replays a reset.
    let lastResetNonce: number | null = null;

    let alive = true;
    let unsubscribeTick: (() => void) | null = null;
    let prevRunning = false;
    let totalLoops = 0;
    // Per-lane MUTE edge-tracking — silence the moment a lane is muted (drive its
    // buses to 0 at currentTime) rather than waiting for its next scheduled step.
    const prevMuted: boolean[] = new Array(CLIP_LANES).fill(false);

    // --- SONG MODE (arranger) ---
    // songBeat = beats since the current song origin (record-arm or arrangement
    // play from the top). Tracks ctx.currentTime so a recorded launch's beat is
    // the beat you HEARD it apply. arrangeCursor = the last songBeat the playback
    // cursor fired up to (half-open, so each event fires once).
    let songBeat = 0;
    let lastBeatAt = ctx.currentTime;
    let arrangeCursor = 0;
    let prevRecording = false;
    let prevClipMode: ClipPlayMode = 'session';

    function liveData(): ClipPlayerData | undefined {
      return livePatch.nodes[nodeId]?.data as ClipPlayerData | undefined;
    }
    function readParam(id: string, fallback: number): number {
      const v = livePatch.nodes[nodeId]?.params?.[id];
      return typeof v === 'number' ? v : fallback;
    }
    function writeData(mut: (d: ClipPlayerData) => void): void {
      const live = livePatch.nodes[nodeId];
      if (!live) return;
      if (!live.data) live.data = {};
      mut(live.data as ClipPlayerData);
    }

    // ─────────────────────────── AUTOMATION LANE ────────────────────────────
    // One AutomationController per clip-player node (task #183). It composes the
    // pure record/playback cores with the INJECTED side effects below:
    //   - readNorm  : the STORE tap (mount-independent, modulation-free) — the
    //                 resolved surface param's live value, normalized curve-aware.
    //   - curve/unitNorm: the target ParamDef's curve + one-unit size (discrete).
    //   - drive     : PLAYBACK — schedule transient ramps via engine.scheduleParam
    //                 (denormalized curve-aware); touches NO Y.Doc.
    //   - commit    : RECORD punch-out — one whole-clip PLAIN reassign into
    //                 d.clips[String(clipIndex(slot,lane))] (never a live splice).
    // `autoArmed` mirrors the synced arm flag onto the controller (recorder
    // client only); `automationRecordTarget` names the (slot,lane) the current
    // recordTick pass commits into (set right before each recordTick call).
    let autoArmed = false;
    let automationRecordTarget: { slot: number; lane: number } | null = null;

    /** The LIVE target node for an automation track's (nodeId,paramId). */
    function targetNode(target: AutomationTarget): ModuleNode | undefined {
      return livePatch.nodes[target.nodeId] as ModuleNode | undefined;
    }
    /** The resolved surface param (def + live get/set) for a target, or null. */
    function resolveTarget(target: AutomationTarget) {
      return resolveSurfaceParam(targetNode(target), target.paramId);
    }

    const controller = new AutomationController({
      // STORE tap → normalized 0..1 (curve-aware). NOT engine.readParam — that
      // double-applies live CV; recording must capture the store/knob value.
      readNorm(target: AutomationTarget): number | null {
        const r = resolveTarget(target);
        if (!r) return null;
        return valueToFrac(r.get(), r.def.min, r.def.max, r.def.curve);
      },
      curve(target: AutomationTarget): string | undefined {
        return resolveTarget(target)?.def.curve;
      },
      unitNorm(target: AutomationTarget): number | undefined {
        const def = resolveTarget(target)?.def;
        if (!def) return undefined;
        return def.curve === 'discrete' ? 1 / Math.max(1, def.max - def.min) : undefined;
      },
      // PLAYBACK — transient, ZERO Yjs. Denormalize each ramp point (curve-aware)
      // and schedule it on the target param at its audio time via the engine's
      // future-time seam. No engine / no def ⇒ silently skip (nothing to drive).
      drive(target: AutomationTarget, points: RampPoint[]): void {
        const engine = getActiveEngine();
        const node = targetNode(target);
        const def = resolveTarget(target)?.def;
        if (!engine || !node || !def) return;
        for (const p of points) {
          const v = fracToValue(p.value, def.min, def.max, def.curve);
          engine.scheduleParam(node, target.paramId, v, p.at, p.ramp);
        }
      },
      // RECORD commit — ONE whole-clip PLAIN reassign (never a live Y.Array
      // splice). Mirrors the card/monome clip-commit pattern (deep-cloned plain
      // tracks/events). Targets the (slot,lane) captured for this pass.
      commit(tracks: AutomationTrack[]): void {
        const t = automationRecordTarget;
        if (!t) return;
        const rec = readClip(liveData(), clipIndex(t.slot, t.lane));
        if (!rec || rec.kind !== 'automation') return;
        // One whole-clip PLAIN reassign (never a live Y.Array splice) — same
        // deep-plain shape the card/menu use (plainAutomationClip), carrying the
        // merged tracks + the existing clip's metadata.
        const plain = plainAutomationClip({ ...rec, tracks });
        writeData((d) => {
          if (!d.clips) d.clips = {};
          d.clips[String(clipIndex(t.slot, t.lane))] = plain;
        });
      },
    });
    // Register this player's controller so a live grab of any AUTOMATED control
    // (screen drag / MIDI CC / Electra) suspends its playback via the shared
    // notifyAutomationTouch seam. Dropped in dispose().
    registerAutomationController(nodeId, controller);

    // --- SONG MODE helpers ---
    function clipMode(): ClipPlayMode {
      return liveData()?.clipMode === 'arrangement' ? 'arrangement' : 'session';
    }
    function isRecording(): boolean {
      return liveData()?.recording === true;
    }
    /** Record mode, defaulting to legacy 'replace'. In 'overdub' the arm-edge
     *  KEEPS the existing log + song time (new launches merge in by song-beat);
     *  'replace' clears + restarts at bar 1. */
    function recordMode(): 'replace' | 'overdub' {
      return liveData()?.recordMode === 'overdub' ? 'overdub' : 'replace';
    }
    /** Append an applied launch to the arrangement log at the current song-beat. */
    function appendArrangeEvent(ev: ArrangeEvent): void {
      writeData((d) => {
        d.arrangement = recordEvent(coerceArrangeData(d.arrangement), ev);
      });
    }
    /** Apply one arrangement event during playback (the timeline IS the schedule,
     *  so launch directly via setLaneActive — no quantize). */
    function applyArrangeEvent(ev: ArrangeEvent): void {
      setLaneActive(ev.lane, ev.slot === 'stop' ? null : ev.slot);
    }
    /** Restart song time at the top (record-arm / arrangement (re)start). */
    function resetSongOrigin(): void {
      songBeat = 0;
      arrangeCursor = 0;
      lastBeatAt = ctx.currentTime;
    }

    // --- TIMELORDE transport (the rack clock we lock to) ---
    function timelorde() {
      for (const n of Object.values(livePatch.nodes)) {
        if (n && (n as { type?: string }).type === 'timelorde') return n;
      }
      return undefined;
    }
    function transportRunning(): boolean {
      const t = timelorde();
      if (!t) return true; // no TIMELORDE in rack → free-run
      const v = (t.params as Record<string, number> | undefined)?.running;
      return typeof v === 'number' ? v >= 0.5 : true;
    }
    function transportBpm(): number {
      const t = timelorde();
      const v = (t?.params as Record<string, number> | undefined)?.bpm;
      return typeof v === 'number' && v > 0 ? v : 120;
    }
    /** True when TIMELORDE is slaved to an external clock (its clock/start/stop
     *  inputs are patched) — the card hides transport in that case. */
    function transportExternallyClocked(): boolean {
      const t = timelorde();
      if (!t) return false;
      const edges = Object.values(livePatch.edges);
      return (
        isInputPortConnected(edges, t.id, 'clock') ||
        isInputPortConnected(edges, t.id, 'start_in') ||
        isInputPortConnected(edges, t.id, 'stop_in')
      );
    }

    function ensureArray<T>(v: unknown, fill: T): T[] {
      const out = new Array<T>(LANES).fill(fill);
      if (Array.isArray(v)) for (let i = 0; i < LANES; i++) if (i < v.length) out[i] = v[i] as T;
      return out;
    }

    function silenceLane(L: number, at: number): void {
      const ln = lanes[L];
      ln.gateSrc.offset.cancelScheduledValues(at);
      ln.gateSrc.offset.setValueAtTime(0, at);
      ln.velSrc.offset.cancelScheduledValues(at);
      ln.velSrc.offset.setValueAtTime(0, at);
      ln.poly.silence(at);
      // A panic/stop zeroes the poly voices in hardware but KEEPS the audition
      // allocator's ownership (the KEYS keys are still physically held). Clear the
      // written-state mirror so the next audition drain RE-OPENS every still-held
      // voice (matches the pre-Phase-2a rebuild-everything recovery).
      ln.laneKey.fill(null);
      ln.lastGate = 0;
      ln.lastVel = 0;
    }

    function setLaneActive(L: number, slot: number | null): void {
      const ln = lanes[L];
      ln.active = slot;
      ln.stepIndex = 0;
      ln.nextStepTime = ctx.currentTime + 0.01;
      writeData((d) => {
        const playing = ensureArray<number | null>(d.playing, null);
        playing[L] = slot;
        d.playing = playing;
      });
      if (slot === null) silenceLane(L, ctx.currentTime);
    }

    /**
     * RESET — snap every ACTIVE lane back to step 1 (index 0) at a COMMON
     * re-anchor instant. Everything already scheduled ahead in the lookahead is
     * cancelled (clean falling edges — the re-emitted step 0 re-attacks ~10 ms
     * later, a deliberate re-strike, same invariant as an audition steal).
     * Because every lane gets the SAME nextStepTime, the per-lane clock rates
     * (clip-clock.ts) restart their counting from one shared phase origin: a
     * 1/2 lane advances on even base steps from here, a 2x lane re-lands on the
     * base grid every second advance. NOT touched: `queued` (a queued launch
     * still applies at its lane's next loop boundary), stopped lanes, and the
     * arrangement's song position (this is a clip-step reset, not a rewind).
     */
    function resetActiveLanes(): void {
      const at = ctx.currentTime;
      for (let L = 0; L < LANES; L++) {
        const ln = lanes[L];
        if (ln.active === null) continue;
        // silenceLane cancels gate/vel + zeroes the poly gates; ALSO cancel the
        // pending poly pitch writes so a cancelled step's pitch can't land
        // under the freshly re-attacked step-0 gate.
        silenceLane(L, at);
        for (const v of ln.poly.voices) v.pitchSrc.offset.cancelScheduledValues(at);
        ln.stepIndex = 0;
        ln.nextStepTime = at + 0.01; // SAME instant for every lane → common origin
        // Drop the now-cancelled future entries so the playhead can't show them.
        ln.sched = ln.sched.filter((e) => e.t <= at);
      }
    }

    /** Apply lane L's queued launch/stop (consuming it). Returns true if the
     *  active clip changed. */
    function applyLaneQueued(L: number): boolean {
      const d = liveData();
      const q = d?.queued?.[L];
      if (q === undefined || q === null) return false;
      // Was this an immediate (NOW / mid-clip) apply? — the per-lane NOW flag, or
      // QNT off, or the lane wasn't playing (first launch is always immediate).
      const wasImmediate =
        d?.queuedImmediate?.[L] === true ||
        readParam('quantize', 1) < 0.5 ||
        lanes[L].active === null;
      writeData((dd) => {
        const queued = ensureArray<number | 'stop' | null>(dd.queued, null);
        queued[L] = null;
        dd.queued = queued;
        if (Array.isArray(dd.queuedImmediate)) {
          const qi = ensureArray<boolean>(dd.queuedImmediate, false);
          qi[L] = false;
          dd.queuedImmediate = qi;
        }
      });
      let changed = false;
      if (q === 'stop') {
        if (lanes[L].active !== null) {
          setLaneActive(L, null);
          changed = true;
        }
      } else {
        const slot = Number(q);
        if (slot !== lanes[L].active) {
          setLaneActive(L, slot);
          changed = true;
        }
      }
      // RECORD: capture the applied launch at the current song-beat (session
      // mode only — arrangement playback drives the lanes itself).
      if (changed && isRecording() && clipMode() === 'session') {
        const slot: ArrangeSlot = q === 'stop' ? 'stop' : Number(q);
        appendArrangeEvent({ beat: songBeat, lane: L, slot, immediate: wasImmediate });
      }
      return changed;
    }

    function emitLaneStep(L: number, idx: number, atTime: number, stepDur: number): void {
      const ln = lanes[L];
      if (ln.active === null) return;
      // MUTE — the lane KEEPS advancing (push the step so laneDisplayStep + the
      // launchpad record-capture still track it, staying locked to the transport)
      // but emits NO audio. The falling edge was already scheduled when mute
      // engaged (the tick-loop edge-scan), so nothing needs to sound here.
      if (laneMuted(liveData(), L)) {
        ln.sched.push({ t: atTime, idx });
        if (ln.sched.length > 32) ln.sched.shift();
        return;
      }
      // LIVE AUDITION owns the lane while KEYS keys are held: advance the visual
      // playhead (push to sched so the launchpad record capture still sees the
      // step move) but DON'T write the poly/gate/vel — otherwise the scheduled
      // clip playback would stomp the held keyboard note's gate open→shut. When
      // no keys are held, playback resumes normally.
      if (ln.alloc.activeCount() > 0) {
        ln.sched.push({ t: atTime, idx });
        if (ln.sched.length > 32) ln.sched.shift();
        return;
      }
      const clip = readClip(liveData(), clipIndex(ln.active, L));
      if (!clip || clip.kind !== 'note') return;
      const r = lanesForStep(clip, idx);
      const octave = readParam('octave', 0);
      const gateFrac = readParam('gateLength', 0.9);
      // A held/tied note (lengthSteps > 1) keeps its gate HIGH the whole span
      // (legato) — the "hold a pad + tap another" gesture. A single-step note
      // uses the GATE duty cycle so it can be shortened/staccato.
      const span = r.gateSteps * stepDur;
      const gateOff =
        r.gateSteps > 1 ? Math.max(0.001, span - 0.002) : Math.max(0.001, span * gateFrac);
      const voiced = r.lanes.map((v) => ({ pitch: v.pitch + octave, gate: v.gate }));
      // Gate-sampled Sample & Hold (ONE global toggle for all 8 lanes, default
      // ON). On a GATED step (r.any) we always write pitch (the gate edge — the
      // pitch re-latches). On an EMPTY step (a rest) with S&H ON we schedule
      // ONLY the per-voice gate-close and leave pitchSrc untouched, so the
      // lane's pitch CV HOLDS its last value (no external S&H needed). With S&H
      // OFF an empty step rewrites pitch=0 (legacy continuous behavior). Note:
      // on a clip (re)launch the first note step is r.any, so pitch re-latches
      // correctly and leading rests of a NEW clip can't hold the prior clip's
      // pitch through a gated step.
      const snh = readParam('snh', 1) >= 0.5;
      const writePitch = r.any || !snh ? true : false;
      // writeGate: r.any — only NOTE steps touch the poly gate; rest steps leave
      // it untouched so a held/tied note (gateSteps>1) keeps its poly gate HIGH
      // across the span, exactly like the mono gate below (which the else branch
      // never re-zeroes). Before this, poly.scheduleStep re-wrote gate=0 on every
      // rest step → a tied note released a step early on the poly bus while the
      // mono bus sustained (gate/held-note plan Phase 1). A note self-closes via
      // gateOff on its own note step, so a skipped rest never sticks a gate high.
      ln.poly.scheduleStep(atTime, voiced, gateOff, { writePitch, writeGate: r.any });
      ln.sched.push({ t: atTime, idx });
      if (ln.sched.length > 32) ln.sched.shift();
      if (r.any) {
        ln.gateSrc.offset.setValueAtTime(1, atTime);
        ln.gateSrc.offset.setValueAtTime(0, atTime + gateOff);
        ln.velSrc.offset.setValueAtTime(r.velocity, atTime);
        ln.lastVOct = voiced[0]?.pitch ?? 0;
        ln.lastGate = 1;
        ln.lastVel = r.velocity;
      } else {
        // Empty step: gate goes low. With S&H ON, ln.lastVOct is left at the
        // HELD value (we didn't rewrite pitch); with S&H OFF pitch was rewritten
        // to 0, so mirror that.
        if (!snh) ln.lastVOct = voiced[0]?.pitch ?? 0;
        ln.lastGate = 0;
      }
    }

    /**
     * LIVE AUDITION drain (KEYS keyboard). Applies every queued note on/off to
     * each lane's STABLE voice allocator, then reconciles the resulting ownership
     * map into the MINIMUM set of clean gate/pitch edges at `now` so a keypress
     * SOUNDS immediately. A held note keeps its OWN voice-lane for its whole life
     * (Phase 2a, gate/held-note plan §3.2): releasing a low note frees ONLY its
     * lane; the other voices are NOT re-written (the old positional repack shifted
     * them down a lane, rewriting pitch on a still-sounding voice → glitch). The
     * mono gate is high while ANY note is held. Called BEFORE the transport
     * `running` gate, so keys play with the transport stopped. A no-op when
     * nothing was queued (held gates stay high — we never re-write on an empty
     * drain).
     */
    function serviceAudition(): void {
      const events = drainAudition(nodeId);
      if (events.length === 0) return;
      const now = ctx.currentTime;
      const octave = readParam('octave', 0);
      const touched = new Set<number>();
      // Whether a lane was IDLE (no held audition voice) before this drain — the
      // first press on an idle lane must cancel any clip-playback still scheduled
      // in the lookahead so the held keys take over immediately.
      const wasEmpty = new Map<number, boolean>();
      for (const ev of events) {
        const L = ev.lane;
        if (L < 0 || L >= LANES) continue;
        const ln = lanes[L];
        if (!wasEmpty.has(L)) wasEmpty.set(L, ln.alloc.activeCount() === 0);
        if (ev.on) {
          ln.alloc.noteOn(ev.midi);
          ln.audVel = Math.max(0, Math.min(1, ev.velocity / 127));
        } else {
          // noteOff frees ONLY this note's lane (or is a no-op when its lane was
          // already stolen / it's unknown — release-after-steal, §3.2). Ownership
          // is reconciled below from the allocator, so the return value is unused.
          ln.alloc.noteOff(ev.midi);
        }
        touched.add(L);
      }
      for (const L of touched) {
        const ln = lanes[L];
        // First press on an idle lane: cancel clip-playback events still scheduled
        // ahead (~LOOKAHEAD_S) so they don't fire and cut off the held note. While
        // ANY key is held emitLaneStep goes SILENT, so nothing re-accumulates.
        if (wasEmpty.get(L) && ln.alloc.activeCount() > 0) {
          for (const v of ln.poly.voices) {
            v.pitchSrc.offset.cancelScheduledValues(now);
            v.gateSrc.offset.cancelScheduledValues(now);
          }
          ln.gateSrc.offset.cancelScheduledValues(now);
          ln.velSrc.offset.cancelScheduledValues(now);
        }
        // Reconcile per-voice ownership → minimal clean 0/1 edges. A voice whose
        // owner is UNCHANGED is skipped entirely (held voices are never touched).
        for (let i = 0; i < POLY_CHANNEL_PAIRS; i++) {
          const desired = ln.alloc.ownerOf(i); // MIDI note owning this voice, or null
          const current = ln.laneKey[i]; // what audition last WROTE to this voice
          if (desired === current) continue; // held / still-free — leave it alone
          const v = ln.poly.voices[i]!;
          if (desired === null) {
            // Freed voice — clean falling edge; pitch holds (gate=0 silences it).
            v.gateSrc.offset.setValueAtTime(0, now);
          } else if (current === null) {
            // New note on a previously-free voice — single clean rising edge.
            v.pitchSrc.offset.setValueAtTime(midiToVOct(desired) + octave, now);
            v.gateSrc.offset.setValueAtTime(1, now);
          } else {
            // Owner CHANGED (LRU-steal, or a freed lane re-taken this drain) →
            // fall→rise so the downstream envelope re-attacks at the new pitch;
            // never a silent pitch swap under a held gate (§3.2 invariant).
            v.gateSrc.offset.setValueAtTime(0, now);
            v.pitchSrc.offset.setValueAtTime(midiToVOct(desired) + octave, now + AUDITION_STEAL_GAP_S);
            v.gateSrc.offset.setValueAtTime(1, now + AUDITION_STEAL_GAP_S);
          }
          ln.laneKey[i] = desired;
        }
        // Mono gate + velocity (single CV outs; poly→mono is an OR-sum so the mono
        // gate is high while ANY voice is held). Re-affirming gate=1 while already
        // high adds no falling edge, so a downstream envelope does not re-attack.
        const anyOn = ln.alloc.activeCount() > 0;
        ln.gateSrc.offset.setValueAtTime(anyOn ? 1 : 0, now);
        ln.velSrc.offset.setValueAtTime(anyOn ? ln.audVel : 0, now);
        ln.lastGate = anyOn ? 1 : 0;
        if (anyOn) {
          ln.lastVel = ln.audVel;
          // Mono pitch display/pull mirrors the LOWEST occupied voice-lane.
          for (let i = 0; i < POLY_CHANNEL_PAIRS; i++) {
            const owner = ln.alloc.ownerOf(i);
            if (owner !== null) {
              ln.lastVOct = midiToVOct(owner) + octave;
              break;
            }
          }
        }
      }
    }

    function laneLength(L: number): number {
      const ln = lanes[L];
      if (ln.active === null) return 1;
      const clip = readClip(liveData(), clipIndex(ln.active, L));
      // Both NOTE and AUTOMATION clips loop over their own lengthSteps; audio /
      // snapshot shells still fall back to a single step.
      return clip && (clip.kind === 'note' || clip.kind === 'automation')
        ? Math.max(1, clip.lengthSteps)
        : 1;
    }

    /** The AUDIBLE fractional-step playhead of lane L (integer display step +
     *  the fraction elapsed into it, from the audio-time schedule). Feeds the
     *  automation recorder its quantized punch playhead. Returns -1 when stopped
     *  or nothing has sounded yet. `laneDur` is the lane's current step length. */
    function laneFracStep(L: number, laneDur: number): number {
      const ln = lanes[L];
      if (ln.active === null) return -1;
      let best = -1;
      let bestT = -Infinity;
      for (const e of ln.sched) {
        if (e.t <= ctx.currentTime && e.t > bestT) {
          bestT = e.t;
          best = e.idx;
        }
      }
      if (best < 0) return -1;
      const frac = laneDur > 0 ? Math.max(0, Math.min(1, (ctx.currentTime - bestT) / laneDur)) : 0;
      return best + frac;
    }

    function tick(): void {
      if (!alive) return;
      try {
        const running = transportRunning();
        const d0 = liveData();
        const mode = d0?.clipMode === 'arrangement' ? 'arrangement' : 'session';
        const recording = d0?.recording === true;

        // SONG-MODE origin resets (before advancing songBeat this tick):
        //  - record ARM (replace): clear the log + restart song time at 0.
        //  - record ARM (overdub): KEEP the log + song time so new launches
        //    merge into the existing timeline at their true current beat
        //    (recordEvent inserts them in beat-sorted order — §3.1).
        //  - entering arrangement mode OR pressing play in it: replay from top.
        if (recording && !prevRecording) {
          if (recordMode() === 'replace') {
            writeData((d) => {
              d.arrangement = clearArrange(coerceArrangeData(d.arrangement));
            });
            resetSongOrigin();
          }
          // overdub: keep the existing log; song time keeps running so merged
          // launches record at their true current beat.
        }
        if (mode === 'arrangement' && (prevClipMode !== 'arrangement' || (running && !prevRunning))) {
          resetSongOrigin();
        }
        prevRecording = recording;
        prevClipMode = mode;

        if (running && !prevRunning) {
          // Transport started → align all lanes to step 0 on the downbeat.
          for (let L = 0; L < LANES; L++) {
            lanes[L].stepIndex = 0;
            lanes[L].nextStepTime = ctx.currentTime + 0.01;
          }
        } else if (!running && prevRunning) {
          for (let L = 0; L < LANES; L++) silenceLane(L, ctx.currentTime);
        }
        prevRunning = running;

        // Song-position clock: advance by real elapsed beats while running.
        const nowAt = ctx.currentTime;
        if (running) songBeat += Math.max(0, nowAt - lastBeatAt) / (60 / transportBpm());
        lastBeatAt = nowAt;

        // stop_all — stop every lane immediately (panic; both modes).
        if (stopCounter.poll(ctx.currentTime) > 0) {
          for (let L = 0; L < LANES; L++) if (lanes[L].active !== null) setLaneActive(L, null);
        }

        // reset — CV rising edge (local) or the synced card-button nonce: snap
        // every ACTIVE lane to step 1 + re-anchor the shared rate phase origin.
        // Both modes; the counter/nonce are drained even when nothing is active.
        const resetEdges = resetCounter.poll(ctx.currentTime);
        const nonce = typeof d0?.resetNonce === 'number' ? d0.resetNonce : 0;
        const nonceFired = lastResetNonce !== null && nonce !== lastResetNonce;
        lastResetNonce = nonce;
        if (resetEdges > 0 || nonceFired) resetActiveLanes();

        // MUTE edge-scan — the instant a lane becomes muted, silence its buses at
        // currentTime (don't wait for its next scheduled step). emitLaneStep then
        // keeps the muted lane's playhead advancing but writes no further audio;
        // unmuting simply resumes emitting on the next step.
        for (let L = 0; L < LANES; L++) {
          const m = laneMuted(d0, L);
          if (m && !prevMuted[L] && lanes[L].active !== null) silenceLane(L, ctx.currentTime);
          prevMuted[L] = m;
        }

        const quantize = readParam('quantize', 1) >= 0.5;

        if (mode === 'session') {
          // Adopt peer-driven playing changes (synced playing-set).
          for (let L = 0; L < LANES; L++) {
            const synced = d0?.playing?.[L] ?? null;
            const sv = typeof synced === 'number' ? synced : null;
            const hasQueued = (d0?.queued?.[L] ?? null) !== null;
            if (sv !== lanes[L].active && !hasQueued) {
              lanes[L].active = sv;
              lanes[L].stepIndex = 0;
              lanes[L].nextStepTime = ctx.currentTime + 0.01;
              if (sv === null) silenceLane(L, ctx.currentTime);
            }
          }
          // Immediate-launch path: QNT off, a lane that isn't playing, or a
          // per-lane NOW override (mid-clip immediate switch).
          for (let L = 0; L < LANES; L++) {
            if (!quantize || lanes[L].active === null || d0?.queuedImmediate?.[L] === true) {
              applyLaneQueued(L);
            }
          }
        } else if (running) {
          // ARRANGEMENT playback: fire the recorded log as song-time advances.
          // The timestamps already encode the timing, so launch directly.
          const arr = coerceArrangeData(d0?.arrangement);
          const len = arrangeLengthBeats(arr, 4);
          let from = arrangeCursor;
          if (arr.loop && len > 0 && songBeat >= len) {
            for (const ev of eventsInRange(arr, from, len)) applyArrangeEvent(ev);
            songBeat -= len; // wrap song time to the top
            from = 0;
          }
          for (const ev of eventsInRange(arr, from, songBeat)) applyArrangeEvent(ev);
          arrangeCursor = songBeat;
        }

        // Publish each lane's audio-time playhead (render state — NOT synced;
        // the card editor + grid LEDs read it to draw the moving playhead).
        for (let L = 0; L < LANES; L++) setLanePlayhead(nodeId, L, laneDisplayStep(L));

        // LIVE AUDITION (KEYS keyboard) — drained BEFORE the transport gate so
        // the keys sound even with the transport STOPPED.
        serviceAudition();

        // AUTOMATION ARM reconcile (single-writer): mirror the synced arm flag
        // onto the controller — but ONLY on the designated recorder client
        // (isAutomationRecorder). Non-recorder peers never arm, so they never
        // record; they still PLAY the automation (playbackStep above). Runs every
        // tick, even stopped, so an arm/disarm toggle is honored immediately.
        const wantRecord = isAutomationRecorder(d0, ydoc.clientID);
        if (wantRecord && !autoArmed) {
          controller.arm();
          autoArmed = true;
        } else if (!wantRecord && autoArmed) {
          controller.disarm();
          autoArmed = false;
        }

        if (!running) return;

        // Base grid from TIMELORDE bpm + the global STEP param; each lane then
        // scales it by its own clock rate (clip-clock.ts — 1/8..4x, default 1).
        const stepDur = 60 / transportBpm() / (STEP_DIV_SPB[readParam('stepDiv', 2)] ?? 4);

        for (let L = 0; L < LANES; L++) {
          const ln = lanes[L];
          if (ln.active === null) {
            ln.nextStepTime = ctx.currentTime + 0.05;
            continue;
          }
          const swing = laneSwing(d0, L);
          while (ln.nextStepTime < ctx.currentTime + LOOKAHEAD_S) {
            // DIV LATCH: at each loop start (step 0) re-read the active clip's
            // effective divider (clip.div OVERRIDES the lane rate[]; else fall
            // back to it). Held for the whole loop, so a mid-loop edit only
            // takes effect at the NEXT clip start.
            if (ln.stepIndex === 0 && ln.active !== null) {
              // Only a NOTE clip carries `div` (and only note clips step-play
              // here); audio/snapshot shells fall back to the lane rate via null.
              const ac = readClip(d0, clipIndex(ln.active, L));
              ln.divIndex = clipDivIndex(ac?.kind === 'note' ? ac : null, d0, L);
            }
            const laneDur = laneStepDur(stepDur, ln.divIndex);
            const len = laneLength(L);
            // SWING: even steps sit on the un-swung grid, odd steps push late by
            // swing*laneDur. Swing 0 ⇒ offset 0 ⇒ the emitted times are the base
            // grid (byte-identical to the un-swung schedule). The grid recurrence
            // (nextStepTime += laneDur) is unchanged so pairs stay beat-locked.
            const emitAt = ln.nextStepTime + swingStepOffset(ln.stepIndex, swing, laneDur);
            // AUTOMATION clip: drive each track's param transiently (zero Yjs)
            // through the SAME per-lane step schedule the notes use, so it stays
            // sample-accurate + time-aligned. The note path (emitLaneStep) is
            // untouched and still owns 'note' clips — automation is additive.
            const activeClip = readClip(d0, clipIndex(ln.active, L));
            if (activeClip?.kind === 'automation') {
              // Advance the visual playhead ring (as emitLaneStep does) so the
              // card/grid + the record fractional playhead track this lane.
              ln.sched.push({ t: emitAt, idx: ln.stepIndex });
              if (ln.sched.length > 32) ln.sched.shift();
              for (const track of activeClip.tracks) {
                controller.playbackStep(track, ln.stepIndex, laneDur, emitAt);
              }
            } else {
              emitLaneStep(L, ln.stepIndex, emitAt, laneDur);
            }
            const nextIdx = (ln.stepIndex + 1) % len;
            const nextStart = ln.nextStepTime + laneDur;
            if (nextIdx === 0) {
              totalLoops++;
              // Boundary-apply queued launches — SESSION mode only (arrangement
              // is driven by the cursor above, not the manual queue).
              if (mode === 'session' && quantize && applyLaneQueued(L)) {
                ln.nextStepTime = nextStart;
                continue;
              }
              if (ln.active === null) break;
            }
            ln.nextStepTime = nextStart;
            ln.stepIndex = nextIdx;
          }
        }

        // AUTOMATION RECORD sample (single-writer). Once per tick, on the
        // recorder client only, feed the controller the audible fractional
        // playhead of the FIRST lane playing an automation clip. The controller
        // owns arm→punch-in→capture→punch-out→commit; non-recorder peers never
        // reach here (autoArmed stays false), so a pass commits exactly once.
        if (autoArmed) {
          for (let L = 0; L < LANES; L++) {
            const ln = lanes[L];
            if (ln.active === null) continue;
            const clip = readClip(d0, clipIndex(ln.active, L));
            if (clip?.kind !== 'automation') continue;
            const laneDur = laneStepDur(stepDur, ln.divIndex);
            const frac = laneFracStep(L, laneDur);
            if (frac < 0) break; // nothing has sounded on this lane yet
            const len = Math.max(1, clip.lengthSteps);
            automationRecordTarget = { slot: ln.active, lane: L };
            controller.recordTick(clip, Math.min(frac, len), len);
            break; // MVP: one automation recorder lane per node
          }
        }
      } catch (err) {
        console.error('[clipplayer] tick error', err);
      }
    }

    unsubscribeTick = getSchedulerClock().subscribe(tick);

    const outputs = new Map<string, { node: AudioNode; output: number }>();
    for (let L = 0; L < LANES; L++) {
      outputs.set(`pitch${L + 1}`, { node: lanes[L].poly.output, output: 0 });
      outputs.set(`gate${L + 1}`, { node: lanes[L].gateSrc, output: 0 });
      outputs.set(`vel${L + 1}`, { node: lanes[L].velSrc, output: 0 });
    }

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number }>([
        ['stop_all', { node: stopGain, input: 0 }],
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
        if (key === 'totalLoops') return totalLoops;
        if (key === 'transportRunning') return transportRunning() ? 1 : 0;
        if (key === 'externallyClocked') return transportExternallyClocked() ? 1 : 0;
        // SONG MODE: the card reads these to drive the RECORD/mode UI + readout.
        if (key === 'songBeat') return songBeat;
        if (key === 'clipMode') return clipMode() === 'arrangement' ? 1 : 0;
        if (key === 'recording') return isRecording() ? 1 : 0;
        if (key === 'recordMode') return recordMode() === 'overdub' ? 1 : 0;
        if (key === 'arrangeEvents') return coerceArrangeData(liveData()?.arrangement).events.length;
        if (typeof key === 'string') {
          // per-lane reads: 'activeLane:L' 'pitchVOct:L' 'gateValue:L' 'velValue:L' 'currentStep:L'
          const m = /^(activeLane|pitchVOct|gateValue|velValue|currentStep):(\d+)$/.exec(key);
          if (m) {
            const L = Number(m[2]);
            if (L < 0 || L >= LANES) return undefined;
            const ln = lanes[L];
            switch (m[1]) {
              case 'activeLane': return ln.active === null ? -1 : ln.active;
              case 'pitchVOct': return ln.lastVOct;
              case 'gateValue': return ln.lastGate;
              case 'velValue': return ln.lastVel;
              case 'currentStep': return laneDisplayStep(L);
            }
          }
        }
        return undefined;
      },
      dispose() {
        alive = false;
        controller.disarm(); // drop any in-flight automation record pass
        unregisterAutomationController(nodeId); // drop the touch-suspend hook
        clearPlayheads(nodeId);
        clearAudition(nodeId);
        if (unsubscribeTick) {
          unsubscribeTick();
          unsubscribeTick = null;
        }
        for (const ln of lanes) {
          try { ln.gateSrc.stop(); } catch { /* */ }
          try { ln.velSrc.stop(); } catch { /* */ }
          ln.poly.dispose();
          try { ln.gateSrc.disconnect(); } catch { /* */ }
          try { ln.velSrc.disconnect(); } catch { /* */ }
        }
        try { stopSilence.stop(); } catch { /* */ }
        stopSilence.disconnect();
        stopGain.disconnect();
        stopAnalyser.disconnect();
        try { resetSilence.stop(); } catch { /* */ }
        resetSilence.disconnect();
        resetGain.disconnect();
        resetAnalyser.disconnect();
      },
    };
  },
};

export { CLIP_COUNT, POLY_CHANNEL_PAIRS };
