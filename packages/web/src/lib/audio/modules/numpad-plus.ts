// packages/web/src/lib/audio/modules/numpad-plus.ts
//
// NUMPAD+ — numpad-driven 4-layer step sequencer that doubles as a
// live performance keyboard. Each numpad note key plays the current
// layer's outputs in real time; with REC ARM or OVERDUB on, keys
// also write to the nearest step on the current layer's 16-step
// sequence.
//
// Layers + outputs
//   4 layers (L1..L4), each a 16-step sequence carrying {on, midi}
//   per step. All 4 layers share a single playhead — the active
//   layer determines which gets recorded TO + which gets driven by
//   live keypresses. Each layer has its own pitch + gate output
//   (8 outputs total) so a patch can route each layer to a
//   different downstream synth — basically a 4-track sequencer.
//
// CV inputs
//   clock — external clock-in. Rising edges advance the playhead;
//           internal BPM ignored while patched (matches the other
//           sequencer modules).
//   layer — CV value 0..1 selects active layer (round(cv*4) clamped
//           to 0..3). When unpatched, the activeLayer param wins.
//
// CV outputs (per layer i ∈ 1..4)
//   l{i}_pitch (V/oct, 0V = C4)
//   l{i}_gate  (0 or 1)
//
// Live performance + recording
//   Keypress: convert via keymap → semitone-in-octave → MIDI =
//   octave*12 + semitone (+12 with Numpad+ held, -12 with Numpad-).
//   Fire on the active layer's pitch+gate IMMEDIATELY. Held key =
//   sustained gate; release = gate goes low.
//   Recording (REC ARM or OVERDUB): also write the note to the
//   step the playhead is on now — quantized to nearest step if the
//   keystroke lands closer to the next boundary.
//
// REC ARM vs OVERDUB
//   REC ARM is a "wait then record one pass" affordance: when armed,
//   next sequence-start (transport-on AND stepIndex=0) clears the
//   active layer + starts recording; auto-disarms after 16 steps.
//   OVERDUB is "always recording" — every keypress writes the current
//   nearest step, no clear, no auto-disarm.
//
// Exclusive numpad ownership
//   When a NUMPAD+ exists in the rack, its main-thread keydown/keyup
//   listener captures Numpad* event.codes + preventDefault — other
//   modules that listen for keys never see the events. Listener is
//   per-instance so multiple NUMPAD+ on the same rack all act on
//   the same keypress (chord-stack style).
//
// Inputs:
//   clock (gate): external clock; rising edges advance the playhead. Unpatched = internal BPM.
//   layer (cv): bipolar CV selecting the active layer (mapped to L1..L4 buckets).
//
// Outputs:
//   l1_pitch / l1_gate .. l4_pitch / l4_gate: per-layer pitch + gate (4 layers × 2 = 8 outputs).
//
// Params:
//   bpm (linear 30..300, default 120): internal tempo.
//   isPlaying (discrete 0..1, default 0): transport state.
//   activeLayer (discrete 0..3, default 0): currently-recorded / played layer.
//   recArm (discrete 0..1, default 0): RECORD-ARM toggle (numpad presses overwrite the nearest step).
//   overdub (discrete 0..1, default 0): OVERDUB toggle (numpad presses sum into the nearest step).
//   octave (discrete 0..8, default 4): numpad-keypad octave (live-play transposition).

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import { patch as livePatch } from '$lib/graph/store';
import { getSchedulerClock } from '$lib/audio/scheduler-clock';
import { isInputPortConnected } from './transport-helpers';
import { midiToVOct, coerceToNoteStep, type NoteStep } from '$lib/audio/note-entry';

export const NUMPAD_PLUS_LAYERS = 4;
export const NUMPAD_PLUS_STEPS = 16;

/** Default keymap: 12 numpad keys → semitone offset (0..11) within
 *  the module's active octave. Layout follows the user's spec
 *  ("1,2,3,4,5,6,7,8,9, 0, /, * are a 12-note piano starting at 1"):
 *  1=C, 2=C#, 3=D, …, 0=A, /=A#, *=B. The "0" key was the closest
 *  fit for the user's "num" placeholder between 9 and / in the
 *  keymap they sketched. Users can override the entire map by
 *  writing { Numpad…: <semitone> } records to node.data.keymap. */
export const DEFAULT_KEYMAP: Readonly<Record<string, number>> = {
  Numpad1: 0,   // C
  Numpad2: 1,   // C#
  Numpad3: 2,   // D
  Numpad4: 3,   // D#
  Numpad5: 4,   // E
  Numpad6: 5,   // F
  Numpad7: 6,   // F#
  Numpad8: 7,   // G
  Numpad9: 8,   // G#
  Numpad0: 9,   // A
  NumpadDivide: 10,    // A#
  NumpadMultiply: 11,  // B
};
export const OCTAVE_UP_KEY = 'NumpadAdd';     // numpad +
export const OCTAVE_DOWN_KEY = 'NumpadSubtract'; // numpad -

/** Compute the MIDI note from a numpad key event, the module's
 *  current octave, and held octave-modifier state. Returns null when
 *  the key is not in the keymap. Pure for testability. */
export function midiForKey(
  code: string,
  octave: number,
  modifierOctave: -1 | 0 | 1,
  keymap: Readonly<Record<string, number>> = DEFAULT_KEYMAP,
): number | null {
  const semitone = keymap[code];
  if (semitone === undefined) return null;
  const baseOctave = Math.max(0, Math.min(8, Math.round(octave)));
  const effectiveOctave = Math.max(-1, Math.min(9, baseOctave + modifierOctave));
  // MIDI convention: octave 0 starts at C0 = MIDI 12. So octave N's
  // C-pitch is at (N + 1) * 12.
  return (effectiveOctave + 1) * 12 + semitone;
}

/** Pure helper: given a key-press timestamp + the clock's step grid,
 *  return the step index the press should record to under "snap to
 *  nearest" quantization. Used by the factory + unit-tested in
 *  isolation. */
export function quantizeToNearestStep(
  pressTimeSec: number,
  currentStepIndex: number,
  currentStepStartSec: number,
  stepDurationSec: number,
): number {
  if (stepDurationSec <= 0) return currentStepIndex;
  const midpoint = currentStepStartSec + stepDurationSec / 2;
  if (pressTimeSec < midpoint) return currentStepIndex;
  return (currentStepIndex + 1) % NUMPAD_PLUS_STEPS;
}

/** Layer data shape on node.data. */
export type NumpadLayer = NoteStep[]; // length NUMPAD_PLUS_STEPS

export function defaultLayer(): NumpadLayer {
  return Array.from({ length: NUMPAD_PLUS_STEPS }, () => ({ on: false, midi: null }));
}

export function defaultLayers(): NumpadLayer[] {
  return Array.from({ length: NUMPAD_PLUS_LAYERS }, () => defaultLayer());
}

export function coerceLayers(raw: unknown): NumpadLayer[] {
  if (!Array.isArray(raw)) return defaultLayers();
  const out: NumpadLayer[] = [];
  for (let l = 0; l < NUMPAD_PLUS_LAYERS; l++) {
    const layer = raw[l];
    if (Array.isArray(layer)) {
      const steps: NumpadLayer = [];
      for (let s = 0; s < NUMPAD_PLUS_STEPS; s++) {
        steps.push(coerceToNoteStep(layer[s]));
      }
      out.push(steps);
    } else {
      out.push(defaultLayer());
    }
  }
  return out;
}

/** Resolve active layer (0..3) from the patch graph. CV input wins
 *  when patched; otherwise the param. Exposed for the card to mirror
 *  the same priority logic. */
export function resolveActiveLayer(
  paramLayer: number,
  layerCvSample: number | null,
): number {
  const fromCv = layerCvSample !== null
    ? Math.round(layerCvSample * NUMPAD_PLUS_LAYERS)
    : null;
  const idx = fromCv !== null ? fromCv : Math.round(paramLayer);
  return Math.max(0, Math.min(NUMPAD_PLUS_LAYERS - 1, idx));
}

export const numpadPlusDef: AudioModuleDef = {
  type: 'numpadPlus',
  palette: { top: 'Audio modules', sub: 'Utility' },
  domain: 'audio',
  label: 'NUMPAD+',
  category: 'sources',
  schemaVersion: 1,

  inputs: [
    { id: 'clock', type: 'gate' },
    { id: 'layer', type: 'cv' },
  ],
  outputs: [
    { id: 'l1_pitch', type: 'pitch' },
    { id: 'l1_gate',  type: 'gate'  },
    { id: 'l2_pitch', type: 'pitch' },
    { id: 'l2_gate',  type: 'gate'  },
    { id: 'l3_pitch', type: 'pitch' },
    { id: 'l3_gate',  type: 'gate'  },
    { id: 'l4_pitch', type: 'pitch' },
    { id: 'l4_gate',  type: 'gate'  },
  ],
  params: [
    { id: 'bpm',         label: 'BPM',  defaultValue: 120, min: 30, max: 300, curve: 'linear' },
    { id: 'isPlaying',   label: 'Play', defaultValue: 0,   min: 0,  max: 1,   curve: 'discrete' },
    { id: 'activeLayer', label: 'Lyr',  defaultValue: 0,   min: 0,  max: 3,   curve: 'discrete' },
    { id: 'recArm',      label: 'Rec',  defaultValue: 0,   min: 0,  max: 1,   curve: 'discrete' },
    { id: 'overdub',     label: 'Ovd',  defaultValue: 0,   min: 0,  max: 1,   curve: 'discrete' },
    { id: 'octave',      label: 'Oct',  defaultValue: 4,   min: 0,  max: 8,   curve: 'discrete' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    const nodeId = node.id;
    const CLOCK_THRESHOLD = 0.5;

    // ─── Output ConstantSources ──────────────────────────────────────
    function makeCv(initial = 0): ConstantSourceNode {
      const c = ctx.createConstantSource();
      c.offset.setValueAtTime(initial, ctx.currentTime);
      c.start();
      return c;
    }
    const layerOutputs: { pitch: ConstantSourceNode; gate: ConstantSourceNode }[] = [];
    for (let i = 0; i < NUMPAD_PLUS_LAYERS; i++) {
      layerOutputs.push({ pitch: makeCv(0), gate: makeCv(0) });
    }

    // ─── External clock input (rising-edge detection) ────────────────
    const clockInGain = ctx.createGain();
    const clockInAnalyser = ctx.createAnalyser();
    clockInAnalyser.fftSize = 2048;
    clockInGain.connect(clockInAnalyser);
    const clockInBuf = new Float32Array(clockInAnalyser.fftSize);
    const clockInSilence = ctx.createConstantSource();
    clockInSilence.offset.value = 0;
    clockInSilence.start();
    clockInSilence.connect(clockInGain);
    let lastClockSample = 0;

    // ─── Layer-selector CV input ─────────────────────────────────────
    const layerCvGain = ctx.createGain();
    const layerCvAnalyser = ctx.createAnalyser();
    layerCvAnalyser.fftSize = 32;
    layerCvGain.connect(layerCvAnalyser);
    const layerCvBuf = new Float32Array(layerCvAnalyser.fftSize);
    const layerCvSilence = ctx.createConstantSource();
    layerCvSilence.offset.value = 0;
    layerCvSilence.start();
    layerCvSilence.connect(layerCvGain);

    function isClockConnected(): boolean {
      return isInputPortConnected(Object.values(livePatch.edges), nodeId, 'clock');
    }
    function isLayerConnected(): boolean {
      return isInputPortConnected(Object.values(livePatch.edges), nodeId, 'layer');
    }

    // ─── State ────────────────────────────────────────────────────────
    let stepIndex = 0;
    let stepStartCtxTime = ctx.currentTime;
    let nextStepCtxTime = ctx.currentTime + 0.05;
    let prevIsPlaying = false;
    /** Set true on play-from-start when REC ARM is on. Auto-clears
     *  after 16 step advances. */
    let armedRecording = false;
    let armedRecordingStepsRemaining = 0;
    /** Per-layer manual-key state. Pitch + gate written on key down;
     *  cleared on key up. Used to mask sequenced output while held. */
    const manualState: { pitch: number; gateHigh: boolean }[] = layerOutputs.map(() => ({ pitch: 0, gateHigh: false }));
    /** Pressed key tracking — supports chord-style holds. Map of
     *  Numpad code → MIDI note that's currently sounding. */
    const pressedNotes = new Map<string, number>();
    let octaveModifier: -1 | 0 | 1 = 0;

    function readParam(id: string, fallback: number): number {
      const live = livePatch.nodes[nodeId];
      const v = live?.params?.[id];
      return typeof v === 'number' ? v : fallback;
    }
    function readLayers(): NumpadLayer[] {
      const live = livePatch.nodes[nodeId];
      const raw = (live?.data as Record<string, unknown> | undefined)?.layers;
      return coerceLayers(raw);
    }
    function writeStepIntoLayer(layerIdx: number, stepIdx: number, midi: number): void {
      const live = livePatch.nodes[nodeId];
      if (!live) return;
      if (!live.data) live.data = {};
      const data = live.data as Record<string, unknown>;
      const layers = coerceLayers(data.layers);
      const layer = layers[layerIdx];
      if (!layer) return;
      layer[stepIdx] = { on: true, midi };
      // Write back via SyncedStore so collaborators see it.
      data.layers = layers.map((l) => l.map((s) => ({ ...s })));
    }
    function clearLayer(layerIdx: number): void {
      const live = livePatch.nodes[nodeId];
      if (!live) return;
      if (!live.data) live.data = {};
      const data = live.data as Record<string, unknown>;
      const layers = coerceLayers(data.layers);
      if (!layers[layerIdx]) return;
      layers[layerIdx] = defaultLayer();
      data.layers = layers.map((l) => l.map((s) => ({ ...s })));
    }

    function pollLayerCvSample(): number | null {
      if (!isLayerConnected()) return null;
      layerCvAnalyser.getFloatTimeDomainData(layerCvBuf);
      // Latest sample.
      return layerCvBuf[layerCvBuf.length - 1] ?? 0;
    }
    function activeLayerIndex(): number {
      return resolveActiveLayer(readParam('activeLayer', 0), pollLayerCvSample());
    }

    function pollClockEdges(): number {
      clockInAnalyser.getFloatTimeDomainData(clockInBuf);
      let edges = 0;
      for (let s = 0; s < clockInBuf.length; s++) {
        const v = clockInBuf[s]!;
        const high = v >= CLOCK_THRESHOLD ? 1 : 0;
        if (high && !lastClockSample) edges++;
        lastClockSample = high;
      }
      return edges;
    }

    /** Apply the current SEQUENCED + MANUAL state to all layer
     *  outputs. Manual (key held) always wins; otherwise the
     *  sequenced state from the most-recently-advanced step is held. */
    function applyOutputs(layers: NumpadLayer[]): void {
      for (let i = 0; i < NUMPAD_PLUS_LAYERS; i++) {
        const layer = layers[i]!;
        const step = layer[stepIndex] ?? { on: false, midi: null };
        const manual = manualState[i]!;
        if (manual.gateHigh) {
          layerOutputs[i]!.pitch.offset.setTargetAtTime(midiToVOct(manual.pitch), ctx.currentTime, 0.001);
          layerOutputs[i]!.gate.offset.setTargetAtTime(1, ctx.currentTime, 0.001);
        } else if (step.on && step.midi !== null) {
          layerOutputs[i]!.pitch.offset.setTargetAtTime(midiToVOct(step.midi), ctx.currentTime, 0.001);
          layerOutputs[i]!.gate.offset.setTargetAtTime(1, ctx.currentTime, 0.001);
        } else {
          layerOutputs[i]!.gate.offset.setTargetAtTime(0, ctx.currentTime, 0.001);
        }
      }
    }

    function advanceStep(): void {
      stepIndex = (stepIndex + 1) % NUMPAD_PLUS_STEPS;
      const now = ctx.currentTime;
      stepStartCtxTime = now;
      const bpm = Math.max(30, readParam('bpm', 120));
      const stepSec = (60 / bpm) / 4; // 16th notes
      nextStepCtxTime = now + stepSec;
      if (armedRecording) {
        armedRecordingStepsRemaining -= 1;
        if (armedRecordingStepsRemaining <= 0) {
          armedRecording = false;
          // Auto-disarm REC ARM param.
          const live = livePatch.nodes[nodeId];
          if (live?.params) live.params.recArm = 0;
        }
      }
      applyOutputs(readLayers());
    }

    let alive = true;
    let unsubscribeTick: (() => void) | null = null;
    const LOOKAHEAD_S = 0.2;

    function tick(): void {
      if (!alive) return;
      try {
        const isPlaying = readParam('isPlaying', 0) >= 0.5;
        const externalClock = isClockConnected();

        if (isPlaying && !prevIsPlaying) {
          stepIndex = 0;
          stepStartCtxTime = ctx.currentTime;
          nextStepCtxTime = ctx.currentTime + 0.05;
          // Latch armed recording on play-from-start.
          if (readParam('recArm', 0) >= 0.5) {
            armedRecording = true;
            armedRecordingStepsRemaining = NUMPAD_PLUS_STEPS;
            // Clear the active layer so the recording starts clean.
            clearLayer(activeLayerIndex());
          }
        }
        prevIsPlaying = isPlaying;

        if (!isPlaying) {
          // Apply manual state even when stopped so live performance works.
          applyOutputs(readLayers());
          return;
        }

        if (externalClock) {
          const edges = pollClockEdges();
          for (let e = 0; e < edges; e++) advanceStep();
          return;
        }

        const bpm = Math.max(30, readParam('bpm', 120));
        const stepSec = (60 / bpm) / 4;
        const horizon = ctx.currentTime + LOOKAHEAD_S;
        while (nextStepCtxTime < horizon) {
          advanceStep();
          // Bump nextStepCtxTime to the next future boundary so the
          // while-loop terminates on a single tick.
          nextStepCtxTime = stepStartCtxTime + stepSec;
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[numpadPlus] tick error', err);
      }
    }

    const clock = getSchedulerClock();
    unsubscribeTick = clock.subscribe(tick);

    // ─── Keyboard listener (browser-only) ────────────────────────────
    //
    // Captures Numpad* event.codes + preventDefault so other rack
    // modules can't see them. Skipped cleanly in environments without
    // `document` (vitest jsdom does have `document`, so the listener
    // runs in unit tests too — but no events fire so it's a no-op).
    let teardownKeys: (() => void) | null = null;
    if (typeof document !== 'undefined') {
      const onDown = (ev: KeyboardEvent) => {
        if (!ev.code.startsWith('Numpad')) return;
        // Defensive: when a DOOM card has focus, give it first dibs on
        // Numpad codes. NUMPAD+'s collision surface is the +/- octave
        // keys (most numpad keys are notes Doom defaults don't use),
        // but skipping the whole NUMPAD+ handler while a DOOM card is
        // focused keeps the interaction model simple ("focus the card
        // = card owns the keyboard"). See docs/design/game-modules.md.
        if (document.activeElement?.closest('[data-card-type="doom"]')) return;
        if (ev.code === OCTAVE_UP_KEY)   { octaveModifier =  1; ev.preventDefault(); return; }
        if (ev.code === OCTAVE_DOWN_KEY) { octaveModifier = -1; ev.preventDefault(); return; }
        const live = livePatch.nodes[nodeId];
        const keymap = (live?.data as { keymap?: Record<string, number> } | undefined)?.keymap
          ?? DEFAULT_KEYMAP;
        const midi = midiForKey(ev.code, readParam('octave', 4), octaveModifier, keymap);
        if (midi === null) return;
        ev.preventDefault();
        ev.stopPropagation();
        if (ev.repeat) return; // ignore OS auto-repeat
        pressedNotes.set(ev.code, midi);
        const layerIdx = activeLayerIndex();
        manualState[layerIdx]!.pitch = midi;
        manualState[layerIdx]!.gateHigh = true;
        applyOutputs(readLayers());
        // Recording write
        const recording = armedRecording || readParam('overdub', 0) >= 0.5;
        if (recording) {
          // While the sequence is stopped, the playhead "is" at
          // stepIndex (0 at start) forever — there's no next-step
          // boundary to quantize against, so write to stepIndex
          // verbatim. While playing, snap to nearest step.
          const isPlaying = readParam('isPlaying', 0) >= 0.5;
          const recStep = isPlaying
            ? quantizeToNearestStep(
                ctx.currentTime,
                stepIndex,
                stepStartCtxTime,
                (60 / Math.max(30, readParam('bpm', 120))) / 4,
              )
            : stepIndex;
          writeStepIntoLayer(layerIdx, recStep, midi);
        }
      };
      const onUp = (ev: KeyboardEvent) => {
        if (!ev.code.startsWith('Numpad')) return;
        // Mirror the keydown guard: while a DOOM card has focus,
        // NUMPAD+'s listener stays out of the way.
        if (document.activeElement?.closest('[data-card-type="doom"]')) return;
        if (ev.code === OCTAVE_UP_KEY || ev.code === OCTAVE_DOWN_KEY) {
          octaveModifier = 0; ev.preventDefault(); return;
        }
        if (!pressedNotes.has(ev.code)) return;
        ev.preventDefault();
        ev.stopPropagation();
        pressedNotes.delete(ev.code);
        // If no other keys are still held on the active layer, drop
        // the manual gate.
        if (pressedNotes.size === 0) {
          for (const m of manualState) m.gateHigh = false;
          applyOutputs(readLayers());
        }
      };
      document.addEventListener('keydown', onDown, { capture: true });
      document.addEventListener('keyup', onUp, { capture: true });
      teardownKeys = () => {
        document.removeEventListener('keydown', onDown, { capture: true });
        document.removeEventListener('keyup', onUp, { capture: true });
      };
    }

    // ─── Engine handle ───────────────────────────────────────────────
    const inputs = new Map<string, { node: AudioNode; input: number }>([
      ['clock', { node: clockInGain, input: 0 }],
      ['layer', { node: layerCvGain, input: 0 }],
    ]);
    const outputsMap = new Map<string, { node: AudioNode; output: number }>();
    for (let i = 0; i < NUMPAD_PLUS_LAYERS; i++) {
      outputsMap.set(`l${i + 1}_pitch`, { node: layerOutputs[i]!.pitch, output: 0 });
      outputsMap.set(`l${i + 1}_gate`,  { node: layerOutputs[i]!.gate,  output: 0 });
    }

    return {
      domain: 'audio',
      inputs,
      outputs: outputsMap,
      setParam() { /* tick re-reads from node.params each iteration */ },
      readParam(paramId) {
        const live = livePatch.nodes[nodeId];
        const v = live?.params?.[paramId];
        return typeof v === 'number' ? v : undefined;
      },
      read(key: string): unknown {
        if (key === 'stepIndex') return stepIndex;
        if (key === 'activeLayer') return activeLayerIndex();
        if (key === 'armedRecording') return armedRecording;
        if (key === 'pressedNoteCount') return pressedNotes.size;
        return undefined;
      },
      dispose() {
        alive = false;
        unsubscribeTick?.();
        teardownKeys?.();
        try { clockInGain.disconnect(); } catch { /* */ }
        try { layerCvGain.disconnect(); } catch { /* */ }
        try { clockInSilence.stop(); } catch { /* */ }
        try { layerCvSilence.stop(); } catch { /* */ }
        for (const { pitch, gate } of layerOutputs) {
          try { pitch.stop(); pitch.disconnect(); } catch { /* */ }
          try { gate.stop();  gate.disconnect();  } catch { /* */ }
        }
      },
    };
  },
};
