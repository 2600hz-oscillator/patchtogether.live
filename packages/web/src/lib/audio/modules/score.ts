// packages/web/src/lib/audio/modules/score.ts
//
// SCORE — sheet-music sequencer module. Renders 1..MAX_PAGES (4) pages of
// 4 rows × 4 bars each (4/4 fixed) as SVG and emits pitch / gate / env /
// clock CV. Internal ADSR (Faust adsr.wasm worklet) shapes the env output,
// scaled by the dynamic marker active at each tick (forward-fill: mf
// default, levels pp..ff).
//
// Scheduler model is the same two-clocks lookahead the Sequencer + Cartesian
// modules use: a Worker-driven scheduler-clock subscription reads node.params
// /data live, advances a 16th-rate tickIndex, and schedules pitch / gate /
// env events on the audio thread up to LOOKAHEAD_S ahead. External `clock`
// input overrides the internal BPM (rising-edge advance). The Worker tick
// keeps firing under main-thread blocking; the 200 ms lookahead absorbs any
// resulting backlog without audible jitter.
//
// Tie semantics: when a note is the start (or middle) of a tie chain we
// emit a SINGLE held gate covering the full chain duration. Only the LAST
// note in the chain triggers the gate-off. Mid-chain notes update pitch but
// keep the gate high — a single ADSR envelope shapes the entire span.
//
// Stop-bar + loop: when the playhead reaches the optional stop-music marker
// (or the end of the last allocated page when no marker is set) the engine
// either (a) stops if `loop` is false, or (b) wraps back to bar 0 if `loop`
// is true.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import { patch as livePatch } from '$lib/graph/store';
import { instantiateFaustModule } from '$lib/audio/faust-runtime';
import { midiToVOct } from '$lib/audio/note-entry';
import wasmUrl from '@patchtogether.live/dsp/dist/adsr.wasm?url';
import metaUrl from '@patchtogether.live/dsp/dist/adsr.json?url';
import workletUrl from '@patchtogether.live/dsp/dist/adsr.worklet.js?url';
import {
  BARS_PER_PAGE,
  DEFAULT_PAGES,
  DYNAMIC_SCALE,
  MAX_PAGES,
  TICKS_PER_BAR,
  dynamicAt,
  emptyScoreData,
  migrateScoreV1ToV2,
  tickWidth,
  tieChainFrom,
  tieRoleFor,
  type ScoreData,
  type ScoreNote,
  type DynamicMarker,
  type Tie,
} from './score-data';
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
import { breathePass, coerceBreatheDirection } from '$lib/audio/breathe-mutation';

const ADSR_PREFIX = '/ADSR';

function readScoreData(nodeId: string): ScoreData {
  const live = livePatch.nodes[nodeId];
  const raw = live?.data as Record<string, unknown> | undefined;
  if (!raw) return emptyScoreData();
  const notes = Array.isArray(raw.notes) ? (raw.notes as ScoreNote[]) : [];
  const dynamics = Array.isArray(raw.dynamics) ? (raw.dynamics as DynamicMarker[]) : [];
  const ties = Array.isArray(raw.ties) ? (raw.ties as Tie[]) : [];
  const ks = typeof raw.keySignature === 'number' ? (raw.keySignature as number) : 0;
  const pages =
    typeof raw.pages === 'number'
      ? Math.max(1, Math.min(MAX_PAGES, raw.pages as number))
      : DEFAULT_PAGES;
  const loop = typeof raw.loop === 'boolean' ? (raw.loop as boolean) : false;
  const sb = raw.stopBar as { bar?: number; tick?: number } | undefined;
  const stopBar =
    sb && typeof sb === 'object' && typeof sb.bar === 'number' && typeof sb.tick === 'number'
      ? { bar: sb.bar, tick: sb.tick }
      : undefined;
  return { notes, dynamics, ties, keySignature: ks, pages, loop, stopBar };
}

export const scoreDef: AudioModuleDef = {
  type: 'score',
  domain: 'audio',
  label: 'Score',
  category: 'modulation',
  // v3: BREATHE — note-presence Euclidean mutation per loop wrap. New params
  //      default to disabled; persisted shape unchanged. The mutator tracks
  //      `data.breatheOffIds: string[]` (note IDs currently exhaled).
  schemaVersion: 3,
  migrate(data, fromVersion) {
    if (fromVersion < 2) return migrateScoreV1ToV2(data);
    return data;
  },
  inputs: [
    { id: 'clock', type: 'gate' },
    // CV scaling per .myrobots/plans/cv-range-standard.md (mirrors ADSR's
    // own param scaling — SCORE forwards these directly to its embedded
    // ADSR worklet).
    { id: 'attack', type: 'cv', paramTarget: 'attack', cvScale: { mode: 'log' } },
    { id: 'decay', type: 'cv', paramTarget: 'decay', cvScale: { mode: 'log' } },
    { id: 'sustain', type: 'cv', paramTarget: 'sustain', cvScale: { mode: 'linear' } },
    { id: 'release', type: 'cv', paramTarget: 'release', cvScale: { mode: 'log' } },
    // Shared transport CV inputs (PR feat/sequencer-transport-quicksave):
    //   play_cv      → toggles isPlaying on rising edge
    //   reset_cv     → resets tickIndex to 0 on rising edge
    //   queue1..4_cv → queues slot N on rising edge
    ...TRANSPORT_CV_PORT_DEFS,
  ],
  outputs: [
    { id: 'pitch', type: 'pitch' },
    { id: 'gate', type: 'gate' },
    { id: 'env', type: 'cv' },
    { id: 'clock', type: 'gate' },
  ],
  params: [
    { id: 'bpm', label: 'BPM', defaultValue: 120, min: 30, max: 300, curve: 'linear' },
    { id: 'attack', label: 'A', defaultValue: 0.005, min: 0.001, max: 10, curve: 'log', units: 's' },
    { id: 'decay', label: 'D', defaultValue: 0.1, min: 0.001, max: 10, curve: 'log', units: 's' },
    { id: 'sustain', label: 'S', defaultValue: 0.7, min: 0, max: 1, curve: 'linear' },
    { id: 'release', label: 'R', defaultValue: 0.3, min: 0.001, max: 10, curve: 'log', units: 's' },
    { id: 'isPlaying', label: 'Play', defaultValue: 0, min: 0, max: 1, curve: 'discrete' },
    // BREATHE: alternating Euclidean mutation that hides/restores notes
    // (treating each note as a "gate" — note placed = gate on). Hidden notes
    // live in data.breatheOffIds[] so the next inhale can restore them.
    { id: 'breatheEnabled', label: 'Brth',  defaultValue: 0,    min: 0, max: 1, curve: 'discrete' },
    { id: 'breathPercent',  label: 'Brth%', defaultValue: 0.25, min: 0, max: 1, curve: 'linear' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    const nodeId = node.id;

    // Internal ADSR worklet. Its gate input is driven by gateSrc; its output
    // is multiplied by dynGain to produce the final env CV.
    const adsr = await instantiateFaustModule(ctx, { name: 'adsr', wasmUrl, metaUrl, workletUrl });
    const adsrParams = adsr.parameters as unknown as Map<string, AudioParam>;
    function setAdsrParam(id: string, v: number) {
      adsrParams.get(`${ADSR_PREFIX}/${id}`)?.setValueAtTime(v, ctx.currentTime);
    }
    // Apply initial param values from the node.
    for (const def of scoreDef.params) {
      if (def.id === 'bpm' || def.id === 'isPlaying') continue;
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      setAdsrParam(def.id, v);
    }

    const pitchSrc = ctx.createConstantSource();
    const gateSrc = ctx.createConstantSource();
    const clockOutSrc = ctx.createConstantSource();
    pitchSrc.offset.value = 0;
    gateSrc.offset.value = 0;
    clockOutSrc.offset.value = 0;
    pitchSrc.start();
    gateSrc.start();
    clockOutSrc.start();

    // Wire gateSrc into the ADSR's gate input (input 0).
    gateSrc.connect(adsr);

    // ADSR -> dynGain -> env output port.
    const dynGain = ctx.createGain();
    dynGain.gain.value = DYNAMIC_SCALE.mf;
    adsr.connect(dynGain);

    // External clock input: AnalyserNode taps to detect rising edges.
    const clockInGain = ctx.createGain();
    const clockInAnalyser = ctx.createAnalyser();
    clockInAnalyser.fftSize = 2048;
    clockInGain.connect(clockInAnalyser);
    const clockInBuffer = new Float32Array(clockInAnalyser.fftSize);
    const clockInSilence = ctx.createConstantSource();
    clockInSilence.offset.value = 0;
    clockInSilence.start();
    clockInSilence.connect(clockInGain);
    let lastClockSample = 0;
    let lastClockSampleTime = ctx.currentTime;
    const CLOCK_THRESHOLD = 0.5;

    // Shared transport CV inputs (play_cv, reset_cv, queue{1..4}_cv).
    const transportCv = createTransportCv(ctx);
    let lastTransportPollTime = ctx.currentTime;
    let totalSequenceEnds = 0;

    function isClockInConnected(): boolean {
      return isInputPortConnected(Object.values(livePatch.edges), nodeId, 'clock');
    }
    function isPlayCvConnected(): boolean {
      return isInputPortConnected(Object.values(livePatch.edges), nodeId, 'play_cv');
    }

    function readParam(id: string, fallback: number): number {
      const live = livePatch.nodes[nodeId];
      const v = live?.params?.[id];
      return typeof v === 'number' ? v : fallback;
    }

    function emitClockPulse(atTime: number) {
      clockOutSrc.offset.setValueAtTime(1, atTime);
      clockOutSrc.offset.setValueAtTime(0, atTime + 0.01);
    }

    // ---- Tick loop ----
    // The score timeline is `pages * BARS_PER_PAGE * TICKS_PER_BAR` grid
    // ticks. We advance by 16th-note increments — each advance moves
    // `tickIndex` by 3 (one 16th = 3 grid ticks). `tickIndex` is in 16th
    // units, so `tickIndex * 3` is the absolute grid position.
    let tickIndex = 0;
    let nextStepTime = ctx.currentTime + 0.05;
    let prevPlaying = false;
    let alive = true;
    let unsubscribeTick: (() => void) | null = null;
    const TICK_MS = SCHEDULER_TICK_MS;
    // 200 ms lookahead (was 100 ms): widens the cushion the audio thread
    // can survive before the next main-thread tick runs. See sequencer.ts
    // for the full rationale.
    const LOOKAHEAD_S = 0.2;

    let currentNoteId: string | null = null;
    let lastEmittedVOct = 0;
    let lastEmittedGate = 0;
    let lastDynamicScale = DYNAMIC_SCALE.mf;
    let totalAdvances = 0;
    /** When >0, gate is being held high through a tied span. The value is
     *  the absolute grid tick at which the chain ends + the chain's last
     *  note's full duration — i.e. the gate-off boundary. While set we
     *  suppress per-step gate drops. */
    let tiedGateHoldUntilTick = -1;

    /** Read the set of note IDs currently exhaled (BREATHE off). Live from
     *  node.data.breatheOffIds — refreshed every emit so the engine picks up
     *  mutations made on the previous wrap. */
    function readBreatheOffIds(): Set<string> {
      const live = livePatch.nodes[nodeId];
      const raw = (live?.data as Record<string, unknown> | undefined)?.breatheOffIds;
      if (!Array.isArray(raw)) return new Set();
      const out = new Set<string>();
      for (const v of raw) {
        if (typeof v === 'string') out.add(v);
      }
      return out;
    }

    /** Look up a note that starts exactly at this absolute grid position,
     *  excluding any notes currently in the BREATHE-off set. */
    function noteStartingAt(absTick: number, notes: ScoreNote[]): ScoreNote | null {
      const bar = Math.floor(absTick / TICKS_PER_BAR);
      const tick = absTick - bar * TICKS_PER_BAR;
      const offIds = readBreatheOffIds();
      for (const n of notes) {
        if (n.bar === bar && n.tick === tick && !offIds.has(n.id)) return n;
      }
      return null;
    }

    /** BREATHE: alternate exhale/inhale Euclidean mutation of the note-presence
     *  set. We treat each note as a "gate" — placed = ON, exhaled = OFF. The
     *  exhaled set lives in data.breatheOffIds (array of note IDs); the engine
     *  filters those out in noteStartingAt(). Note: we DON'T delete notes
     *  from the score itself, so toggling BREATHE off restores the full score.
     */
    function maybeBreathe(): void {
      const live = livePatch.nodes[nodeId];
      if (!live) return;
      const enabled = (readParam('breatheEnabled', 0) >= 0.5);
      if (!enabled) return;
      const data = readScoreData(nodeId);
      if (!data.notes.length) return;
      const liveData = (live.data ?? {}) as Record<string, unknown>;
      const offIds = readBreatheOffIds();
      // Gate array indexed by note: true = currently ON (not in offIds).
      const gates = data.notes.map((n) => !offIds.has(n.id));
      const direction = coerceBreatheDirection(liveData.breatheDirection);
      const pct = readParam('breathPercent', 0.25);
      const { gates: nextGates, nextDirection } = breathePass(gates, direction, pct);
      // Compute the new off-set from the flipped gates.
      const nextOff: string[] = [];
      for (let i = 0; i < data.notes.length; i++) {
        if (!nextGates[i]) nextOff.push(data.notes[i].id);
      }
      if (!live.data) live.data = {};
      (live.data as Record<string, unknown>).breatheOffIds = nextOff;
      (live.data as Record<string, unknown>).breatheDirection = nextDirection;
    }

    /** Compute the absolute grid tick at which a given note's gate-off is
     *  due, factoring in tie chains. For a stand-alone or tie-end note this
     *  is `note.bar*TICKS_PER_BAR + note.tick + tickWidth(note.duration)`.
     *  For a tie-start note we walk the chain forward and return the LAST
     *  note's gate-off boundary. Returns the absolute grid tick. */
    function gateOffAbsTickFor(note: ScoreNote, data: ScoreData): number {
      const role = tieRoleFor(note.id, data.ties);
      if (role === 'tied-start') {
        const chain = tieChainFrom(note.id, data.ties, data.notes);
        const last = chain[chain.length - 1] ?? note;
        return last.bar * TICKS_PER_BAR + last.tick + tickWidth(last.duration);
      }
      return note.bar * TICKS_PER_BAR + note.tick + tickWidth(note.duration);
    }

    /** Schedule the start (and gate-off) of one 16th-note slot's note (if
     *  any). `slotDur` is how long one 16th would last in seconds. */
    function emitTick(absTick: number, atTime: number, slotDur: number) {
      emitClockPulse(atTime);
      const data = readScoreData(nodeId);
      const note = noteStartingAt(absTick, data.notes);
      if (!note) return;

      const role = tieRoleFor(note.id, data.ties);

      // Forward-fill dynamic.
      const lvl = dynamicAt(note.bar, note.tick, data.dynamics);
      const dynScale = DYNAMIC_SCALE[lvl];
      lastDynamicScale = dynScale;
      try {
        dynGain.gain.setValueAtTime(dynScale, atTime);
      } catch { /* time may be in the past on audio thread; ignore */ }

      // Pitch as V/oct. ALWAYS update pitch — even mid-chain notes change
      // pitch (a tie usually implies same pitch but we don't enforce that
      // and let the engine track whatever the user wired up).
      const vOct = midiToVOct(note.midi);
      lastEmittedVOct = vOct;
      pitchSrc.offset.setValueAtTime(vOct, atTime);

      // Gate emission depends on tie role:
      //   - 'none': open gate now, close at note end (current behavior).
      //   - 'tied-start': open gate now, close at LAST chain note's end.
      //     Suppress per-step gate-off until then.
      //   - 'tied-mid': do NOT re-open the gate. Pitch was updated above.
      //   - 'tied-end': do NOT re-open the gate; the chain's gate-off was
      //     already scheduled by the start. Pitch updated above.
      //
      // We recalculate the gate-off each time the chain's start fires
      // (instead of mid-chain) so that subsequent edits to a chain remain
      // correct on the next loop pass.
      if (role === 'none') {
        const noteSec = (tickWidth(note.duration) / 3) * slotDur;
        gateSrc.offset.setValueAtTime(1, atTime);
        gateSrc.offset.setValueAtTime(0, atTime + noteSec * 0.95);
        lastEmittedGate = 1;
        tiedGateHoldUntilTick = -1;
      } else if (role === 'tied-start') {
        const chain = tieChainFrom(note.id, data.ties, data.notes);
        const last = chain[chain.length - 1] ?? note;
        // Total grid-ticks from this note's start to last note's end.
        const startAbs = note.bar * TICKS_PER_BAR + note.tick;
        const endAbs = last.bar * TICKS_PER_BAR + last.tick + tickWidth(last.duration);
        const spanGridTicks = Math.max(1, endAbs - startAbs);
        const spanSec = (spanGridTicks / 3) * slotDur;
        gateSrc.offset.setValueAtTime(1, atTime);
        gateSrc.offset.setValueAtTime(0, atTime + spanSec * 0.98);
        lastEmittedGate = 1;
        tiedGateHoldUntilTick = endAbs;
      }
      // tied-mid / tied-end: pitch already updated, gate left alone.
      currentNoteId = note.id;
    }

    /** Total bars currently allocated by the score (live read). */
    function liveTotalGridTicks(): number {
      const data = readScoreData(nodeId);
      const pages = Math.max(1, Math.min(MAX_PAGES, data.pages || DEFAULT_PAGES));
      return pages * BARS_PER_PAGE * TICKS_PER_BAR;
    }

    /** Absolute grid-tick at which the sequence ends. If a stop-music marker
     *  is set, returns its absolute position; otherwise end-of-final-page. */
    function liveStopGridTick(): number {
      const data = readScoreData(nodeId);
      const pages = Math.max(1, Math.min(MAX_PAGES, data.pages || DEFAULT_PAGES));
      const endOfPages = pages * BARS_PER_PAGE * TICKS_PER_BAR;
      if (data.stopBar) {
        const abs = data.stopBar.bar * TICKS_PER_BAR + data.stopBar.tick;
        // Clamp into the allocated range.
        return Math.max(1, Math.min(endOfPages, abs));
      }
      return endOfPages;
    }

    function silenceGate(atTime: number) {
      gateSrc.offset.cancelScheduledValues(atTime);
      gateSrc.offset.setValueAtTime(0, atTime);
      lastEmittedGate = 0;
      tiedGateHoldUntilTick = -1;
    }

    /** Drain transport CV and dispatch effects. Returns the CURRENT
     *  isPlaying value (after any play_cv toggle). */
    function pollTransportCv(): boolean {
      const nowAt = ctx.currentTime;
      const elapsed = nowAt - lastTransportPollTime;
      lastTransportPollTime = nowAt;
      const ev = transportCv.drain(elapsed);
      const live = livePatch.nodes[nodeId];
      let isPlaying = readParam('isPlaying', 0) >= 0.5;
      if (ev.play % 2 === 1) {
        isPlaying = !isPlaying;
        if (live?.params) live.params.isPlaying = isPlaying ? 1 : 0;
      }
      if (ev.reset > 0) {
        tickIndex = 0;
        nextStepTime = ctx.currentTime + 0.05;
      }
      const queued = pickQueuedSlotFromEvents(ev);
      if (queued !== null && live) {
        if (!live.data) live.data = {};
        (live.data as Record<string, unknown>).queuedSlot = queued;
      }
      return isPlaying;
    }

    /** Apply queued slot's snapshot to node.data + node.params. SCORE
     *  snapshot shape: { notes, dynamics, ties, keySignature, pages,
     *  loop, stopBar?, bpm, attack, decay, sustain, release }. */
    function maybeApplyQueuedSlot(): boolean {
      const live = livePatch.nodes[nodeId];
      if (!live) return false;
      const data = live.data as Record<string, unknown> | undefined;
      const queued = coerceSlotKey(data?.queuedSlot);
      if (!queued) return false;
      const slots = coerceSlots(data?.slots);
      const snap = slots[queued];
      if (!snap) {
        if (data) data.queuedSlot = null;
        return false;
      }
      if (!live.data) live.data = {};
      const d = live.data as Record<string, unknown>;
      // Deep-clone object/array fields to avoid reassigning Y-tree-resident
      // objects out of slots[N]. Yjs throws "reassigning object that already
      // occurs in the tree" otherwise.
      if (Array.isArray(snap.notes)) {
        d.notes = (snap.notes as Array<Record<string, unknown>>).map((n) => ({ ...n }));
      }
      if (Array.isArray(snap.dynamics)) {
        d.dynamics = (snap.dynamics as Array<Record<string, unknown>>).map((m) => ({ ...m }));
      }
      if (Array.isArray(snap.ties)) {
        d.ties = (snap.ties as Array<Record<string, unknown>>).map((tt) => ({ ...tt }));
      }
      if (typeof snap.keySignature === 'number') d.keySignature = snap.keySignature;
      if (typeof snap.pages === 'number') d.pages = snap.pages;
      if (typeof snap.loop === 'boolean') d.loop = snap.loop;
      if (snap.stopBar && typeof snap.stopBar === 'object') {
        const sb = snap.stopBar as { bar: number; tick: number };
        d.stopBar = { bar: sb.bar, tick: sb.tick };
      } else if ('stopBar' in snap) {
        d.stopBar = undefined;
      }
      if (live.params) {
        for (const k of ['bpm', 'attack', 'decay', 'sustain', 'release'] as const) {
          const v = snap[k];
          if (typeof v === 'number') live.params[k] = v;
        }
      }
      d.lastLoadedSlot = queued;
      d.queuedSlot = null;
      tickIndex = 0;
      nextStepTime = ctx.currentTime + 0.005;
      tiedGateHoldUntilTick = -1;
      return true;
    }

    function tick() {
      if (!alive) return;
      try {
        const isPlaying = pollTransportCv();
        const externalClock = isClockInConnected();
        // Orthogonality fix: clock-only mode (clock patched, play_cv not)
        // treats incoming pulses as the play signal even when isPlaying=false.
        // Note: SCORE's "stop at end-of-stop-bar when not looping" path writes
        // isPlaying=0 to halt — in clock-only mode that single-shot stop is
        // not honored (the next clock pulse re-runs from step 0, since
        // shouldRun stays true). Stopping in clock-only mode is the clock
        // source's responsibility.
        const playCvPatched = isPlayCvConnected();
        const shouldRun = shouldSequencerRun(isPlaying, externalClock, playCvPatched);

        if (shouldRun && !prevPlaying) {
          tickIndex = 0;
          nextStepTime = ctx.currentTime + 0.05;
          gateSrc.offset.cancelScheduledValues(ctx.currentTime);
          gateSrc.offset.setValueAtTime(0, ctx.currentTime);
          tiedGateHoldUntilTick = -1;
          lastClockSample = 0;
          lastClockSampleTime = ctx.currentTime;
          transportCv.resetEdges();
          lastTransportPollTime = ctx.currentTime;
        } else if (!shouldRun && prevPlaying) {
          gateSrc.offset.cancelScheduledValues(ctx.currentTime);
          gateSrc.offset.setValueAtTime(0, ctx.currentTime);
          tiedGateHoldUntilTick = -1;
        }
        prevPlaying = shouldRun;

        if (!shouldRun) {
          // Worker-driven scheduler-clock owns re-tick scheduling — see the
          // getSchedulerClock().subscribe(tick) below — so no timeoutId
          // self-loop is needed when we early-return.
          return;
        }

        const totalGrid = liveTotalGridTicks();
        const stopGrid = liveStopGridTick();
        const total16ths = Math.max(1, Math.floor(totalGrid / 3));
        const stop16ths = Math.max(1, Math.floor(stopGrid / 3));

        if (externalClock) {
          clockInAnalyser.getFloatTimeDomainData(clockInBuffer);
          const nowAt = ctx.currentTime;
          const elapsed = nowAt - lastClockSampleTime;
          const newSamples = Math.min(
            clockInBuffer.length,
            Math.max(1, Math.ceil(elapsed * ctx.sampleRate)),
          );
          const start = clockInBuffer.length - newSamples;
          const bpm = readParam('bpm', 120);
          const slotDur = 60 / Math.max(1, bpm) / 4;
          for (let i = start; i < clockInBuffer.length; i++) {
            const cur = clockInBuffer[i] ?? 0;
            if (lastClockSample < CLOCK_THRESHOLD && cur >= CLOCK_THRESHOLD) {
              if (tickIndex >= stop16ths) {
                totalSequenceEnds++;
                if (maybeApplyQueuedSlot()) {
                  // Pattern swapped + tickIndex reset to 0; emit the
                  // new pattern's first slot on this very pulse.
                } else if (readScoreData(nodeId).loop) {
                  tickIndex = 0;
                  maybeBreathe();
                } else {
                  // Stop the sequencer.
                  silenceGate(nowAt + 0.005);
                  // Clear isPlaying so the next tick takes the !isPlaying path.
                  const live = livePatch.nodes[nodeId];
                  if (live?.params) live.params.isPlaying = 0;
                  break;
                }
              }
              emitTick(tickIndex * 3, nowAt + 0.005, slotDur);
              tickIndex = (tickIndex + 1) % total16ths;
              totalAdvances++;
            }
            lastClockSample = cur;
          }
          lastClockSampleTime = nowAt;
        } else {
          while (nextStepTime < ctx.currentTime + LOOKAHEAD_S) {
            const bpm = readParam('bpm', 120);
            const slotDur = 60 / bpm / 4;
            if (tickIndex >= stop16ths) {
              totalSequenceEnds++;
              if (maybeApplyQueuedSlot()) {
                // tickIndex reset to 0 + nextStepTime nudged forward by the
                // helper. Re-anchor nextStepTime to the natural slot
                // boundary so we don't introduce drift.
                // (helper sets nextStepTime to ctx.currentTime + 0.005;
                //  the next emitTick call uses that as step-0's at-time.)
              } else if (readScoreData(nodeId).loop) {
                tickIndex = 0;
                maybeBreathe();
              } else {
                // Stop and exit the schedule loop.
                silenceGate(nextStepTime);
                const live = livePatch.nodes[nodeId];
                if (live?.params) live.params.isPlaying = 0;
                break;
              }
            }
            emitTick(tickIndex * 3, nextStepTime, slotDur);
            nextStepTime += slotDur;
            tickIndex = (tickIndex + 1) % total16ths;
            totalAdvances++;
          }
        }
      } catch (err) {
        console.error('[score] tick error', err);
      }
    }
    // Subscribe to the shared scheduler-clock (worker-driven, jank-immune).
    unsubscribeTick = getSchedulerClock().subscribe(tick);

    const inputsMap = new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
      ['clock', { node: clockInGain, input: 0 }],
      ['attack', { node: adsr, input: 0, param: adsrParams.get(`${ADSR_PREFIX}/attack`)! }],
      ['decay', { node: adsr, input: 0, param: adsrParams.get(`${ADSR_PREFIX}/decay`)! }],
      ['sustain', { node: adsr, input: 0, param: adsrParams.get(`${ADSR_PREFIX}/sustain`)! }],
      ['release', { node: adsr, input: 0, param: adsrParams.get(`${ADSR_PREFIX}/release`)! }],
    ]);
    for (const [id, entry] of transportCv.inputs) {
      inputsMap.set(id, entry);
    }

    return {
      domain: 'audio',
      inputs: inputsMap,
      outputs: new Map([
        ['pitch', { node: pitchSrc, output: 0 }],
        ['gate', { node: gateSrc, output: 0 }],
        ['env', { node: dynGain, output: 0 }],
        ['clock', { node: clockOutSrc, output: 0 }],
      ]),
      setParam(paramId, value) {
        if (paramId === 'bpm' || paramId === 'isPlaying') return;
        setAdsrParam(paramId, value);
      },
      readParam(paramId) {
        if (paramId === 'bpm' || paramId === 'isPlaying') {
          return readParam(paramId, 0);
        }
        return adsrParams.get(`${ADSR_PREFIX}/${paramId}`)?.value;
      },
      read(key) {
        if (key === 'currentNoteId') return currentNoteId;
        if (key === 'totalAdvances') return totalAdvances;
        if (key === 'totalSequenceEnds') return totalSequenceEnds;
        if (key === 'pitchVOct') return lastEmittedVOct;
        if (key === 'gateValue') return lastEmittedGate;
        if (key === 'dynamicScale') return lastDynamicScale;
        if (key === 'tickIndex') return tickIndex;
        if (key === 'tiedGateHoldUntilTick') return tiedGateHoldUntilTick;
        return undefined;
      },
      dispose() {
        alive = false;
        if (unsubscribeTick) { unsubscribeTick(); unsubscribeTick = null; }
        try { pitchSrc.stop(); } catch { /* already stopped */ }
        try { gateSrc.stop(); } catch { /* already stopped */ }
        try { clockOutSrc.stop(); } catch { /* already stopped */ }
        try { clockInSilence.stop(); } catch { /* already stopped */ }
        pitchSrc.disconnect();
        gateSrc.disconnect();
        clockOutSrc.disconnect();
        clockInGain.disconnect();
        clockInAnalyser.disconnect();
        clockInSilence.disconnect();
        dynGain.disconnect();
        adsr.disconnect();
        transportCv.dispose();
      },
    };
  },
};

// Export this for the gateOffAbsTickFor helper used in tests.
export function _testGateOffAbsTickFor(note: ScoreNote, data: ScoreData): number {
  const role = tieRoleFor(note.id, data.ties);
  if (role === 'tied-start') {
    const chain = tieChainFrom(note.id, data.ties, data.notes);
    const last = chain[chain.length - 1] ?? note;
    return last.bar * TICKS_PER_BAR + last.tick + tickWidth(last.duration);
  }
  return note.bar * TICKS_PER_BAR + note.tick + tickWidth(note.duration);
}
