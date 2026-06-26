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
import { createEdgeCounter } from '$lib/audio/edge-detect';
import { midiToVOct, coerceToNoteStep, NOTE_STEP_MAX_VOICES, type NoteStep } from '$lib/audio/note-entry';
import { createPolySender, voicingToVOct, type PolySender } from '$lib/audio/poly';

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
  NumpadAdd: 12,       // OCTAVE_UP_ACTION  (octave +)
  NumpadSubtract: 13,  // OCTAVE_DOWN_ACTION (octave −)
};
// Octave up/down are remappable KEYS too (not held modifiers) — they nudge the
// module's octave param ±1. They live in the same keymap as the notes, keyed by
// sentinel "semitone" values OUTSIDE the 0..11 note range so midiForKey ignores
// them. Default-mapped to numpad + / − (the keys that were the old held
// transpose). Right-click → remap, just like a note key; persisted in the patch.
export const OCTAVE_UP_ACTION = 12;
export const OCTAVE_DOWN_ACTION = 13;
export const OCTAVE_UP_KEY = 'NumpadAdd';     // numpad +
export const OCTAVE_DOWN_KEY = 'NumpadSubtract'; // numpad -

/** Note names by semitone-in-octave (0=C … 11=B). */
export const SEMITONE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'] as const;

/**
 * Human-readable label for a KeyboardEvent.code — the symbol shown on a remapped
 * key. Handles numpad, digit-row, letters, and the common punctuation codes;
 * falls back to the code with its noise prefix stripped. Pure for testability.
 */
export function keyCodeLabel(code: string): string {
  if (code.startsWith('Numpad')) {
    const rest = code.slice('Numpad'.length);
    const map: Record<string, string> = {
      Divide: '/', Multiply: '*', Subtract: '−', Add: '+', Decimal: '.', Enter: '⏎', Equal: '=',
    };
    return map[rest] ?? rest; // Numpad0..9 → "0".."9"
  }
  if (/^Digit[0-9]$/.test(code)) return code.slice('Digit'.length);
  if (/^Key[A-Z]$/.test(code)) return code.slice('Key'.length);
  if (/^F[0-9]{1,2}$/.test(code)) return code; // F1..F12
  const punct: Record<string, string> = {
    Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
    Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`',
    Space: '␣', Enter: '⏎', Tab: '⇥', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  };
  return punct[code] ?? code;
}

/** Find the physical key code currently mapped to a semitone, or null. */
export function codeForSemitone(
  keymap: Readonly<Record<string, number>>,
  semitone: number,
): string | null {
  for (const [code, st] of Object.entries(keymap)) {
    if (st === semitone) return code;
  }
  return null;
}

/**
 * Remap a physical key to a semitone, returning a NEW keymap (pure):
 *  - drops any existing key that mapped to this semitone (one key per note), and
 *  - drops this key's previous mapping (one note per key),
 * then binds code → semitone. Keeps the keymap a clean bijection.
 */
export function remapKeymap(
  keymap: Readonly<Record<string, number>>,
  code: string,
  semitone: number,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, st] of Object.entries(keymap)) {
    if (st === semitone) continue; // free the note's old key
    if (k === code) continue;      // free the key's old note
    out[k] = st;
  }
  out[code] = semitone;
  return out;
}

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
  // undefined = unmapped; ≥12 = an OCTAVE action sentinel, not a note.
  if (semitone === undefined || semitone < 0 || semitone > 11) return null;
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

/** Snapshot the currently-HELD keypad notes for a poly step: de-duplicated,
 *  sorted ascending, capped to `cap` (the lowest `cap` if more are held). This
 *  is what poly-mode recording writes to a step — the keys held at capture
 *  time, NOT an accumulated chord. Pure for testability. */
export function heldNotesForStep(
  held: readonly number[],
  cap: number = NOTE_STEP_MAX_VOICES,
): number[] {
  return Array.from(new Set(held)).sort((a, b) => a - b).slice(0, Math.max(0, cap));
}

/** Lowest MIDI of a voice set (what the per-layer MONO pitch out emits in poly
 *  mode), or null when empty. */
export function lowestNote(midis: readonly number[]): number | null {
  let lo: number | null = null;
  for (const m of midis) if (lo === null || m < lo) lo = m;
  return lo;
}

/** The voices a step contributes to outputs: the recorded poly set if present,
 *  else the single `midi` (mono), else empty when off. */
export function stepVoices(step: NoteStep): number[] {
  if (!step.on) return [];
  if (step.midis && step.midis.length > 0) return step.midis;
  return step.midi !== null ? [step.midi] : [];
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
  label: 'numpad+',
  category: 'sources',
  schemaVersion: 2,

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
    // Poly output: the ACTIVE layer's up-to-5 voices (held keys live, else the
    // current step's recorded notes) as a single polyPitchGate bus.
    { id: 'poly',     type: 'polyPitchGate' },
  ],
  params: [
    { id: 'bpm',         label: 'BPM',  defaultValue: 120, min: 30, max: 300, curve: 'linear' },
    { id: 'isPlaying',   label: 'Play', defaultValue: 0,   min: 0,  max: 1,   curve: 'discrete' },
    { id: 'activeLayer', label: 'Lyr',  defaultValue: 0,   min: 0,  max: 3,   curve: 'discrete' },
    { id: 'recArm',      label: 'Rec',  defaultValue: 0,   min: 0,  max: 1,   curve: 'discrete' },
    { id: 'overdub',     label: 'Ovd',  defaultValue: 0,   min: 0,  max: 1,   curve: 'discrete' },
    { id: 'octave',      label: 'Oct',  defaultValue: 4,   min: 0,  max: 8,   curve: 'discrete' },
    // Poly mode: when on, recording captures up to NOTE_STEP_MAX_VOICES of the
    // keys HELD on the keypad into the step (mono outs send the lowest).
    { id: 'poly',        label: 'Poly', defaultValue: 0,   min: 0,  max: 1,   curve: 'discrete' },
  ],

  docs: {
    explanation:
      "A live-recording step sequencer you play from your computer's numeric keypad: the keys map to a chromatic octave (12 notes), and pressing them performs notes in real time AND, when armed, records them into a 16-step pattern. It has four independent LAYERS sharing one playhead and tempo, so you can build up four parallel lines; the active layer is the one you're playing and recording into. Each layer has its own pitch + gate output pair, and there's also a single POLY output that carries the active layer's notes — in poly mode you can hold several keys to record a chord, and the POLY cable feeds a poly-aware voice so every note sounds. The playhead runs on internal BPM or an external CLOCK IN; recording quantizes your keystrokes to the nearest step while playing, or writes immediately when stopped. While the card is focused it captures the Numpad keys exclusively so they don't leak to other modules.",
    inputs: {
      clock: "External clock: each rising edge advances the shared playhead one step. While patched it sets the pace and runs the sequencer; unpatch to fall back to the internal BPM.",
      layer:
        "CV that selects the active layer (0..1 mapped to layers 1–4); when patched it takes priority over the Layer control, so you can switch which line you're recording/playing from a CV source.",
    },
    outputs: {
      l1_pitch: "Layer 1's pitch CV (V/oct): the current step's note, or the live-held key's pitch when you're playing on layer 1.",
      l1_gate: "Layer 1's gate: high on a lit step (or while a key is held on layer 1), low otherwise.",
      l2_pitch: "Layer 2's pitch CV (V/oct): its current step's note, or a live-held key when layer 2 is active.",
      l2_gate: "Layer 2's gate: high on a lit step or held key, low otherwise.",
      l3_pitch: "Layer 3's pitch CV (V/oct): its current step's note, or a live-held key when layer 3 is active.",
      l3_gate: "Layer 3's gate: high on a lit step or held key, low otherwise.",
      l4_pitch: "Layer 4's pitch CV (V/oct): its current step's note, or a live-held key when layer 4 is active.",
      l4_gate: "Layer 4's gate: high on a lit step or held key, low otherwise.",
      poly:
        "The ACTIVE layer's notes as a POLY cable (up to 5 voices, each with its own pitch CV + gate): in poly mode this carries the held/recorded chord, otherwise the single current note. Patch into a poly-aware voice (POLYHELM / any module with a poly input) so every voice sounds; a mono pitch input automatically receives just the lowest (root) note.",
    },
    controls: {
      bpm: "Internal tempo in beats per minute (each step is a 16th note), used only when nothing is patched into CLOCK IN.",
      isPlaying: "Run/stop transport (1 = playing, 0 = stopped). When stopped the playhead holds at step 1 but live keys still sound; the card's PLAY button toggles it.",
      activeLayer:
        "Which of the four layers is active for playing and recording (0..3 = layers 1–4), exposed as the card's L1–L4 buttons. The layer CV input overrides this when patched.",
      recArm:
        "Record arm (the card's ARM button): when armed and play starts from step 1, recording latches and the active layer is cleared, then your keystrokes are written in; it auto-disarms after one 16-step pass.",
      overdub: "Overdub mode (the card's OVD button): when on, every keypress writes its note into the step (quantized to the nearest step while playing, immediately when stopped) without clearing the layer first — layer new notes over what's there.",
      octave: "The keypad's base octave (0..8, default 4); shifts which actual pitches the 12 note-keys produce. The remappable octave-up/down keys nudge it by one.",
      poly: "Poly recording (the card's POLY button): when on, holding several keys at once records them as a chord into the step (up to 5 voices); when off, only the single key pressed is stored. The mono per-layer outputs always send the lowest note either way.",
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    const nodeId = node.id;

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

    // Poly output (polyPitchGate merger) — carries the ACTIVE layer's voices.
    // Always live (the `poly` PARAM gates RECORDING, not the output), so a
    // mono step still emits 1 voice and a poly step emits up to 5.
    const poly: PolySender = createPolySender(ctx);

    // ─── External clock input (rising-edge detection) ────────────────
    const clockInGain = ctx.createGain();
    const clockInAnalyser = ctx.createAnalyser();
    clockInAnalyser.fftSize = 2048;
    clockInGain.connect(clockInAnalyser);
    const clockInSilence = ctx.createConstantSource();
    clockInSilence.offset.value = 0;
    clockInSilence.start();
    clockInSilence.connect(clockInGain);
    // Windowed rising-edge counter (shared seam): scans ONLY the samples that
    // arrived since the last tick, so a single external clock pulse advances
    // exactly one step — no 2048-sample overlap double-count (the reported
    // NUMPAD+ bug). See $lib/audio/edge-detect.
    const clockCounter = createEdgeCounter({ ctx, analyser: clockInAnalyser });

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

    function readParam(id: string, fallback: number): number {
      const live = livePatch.nodes[nodeId];
      const v = live?.params?.[id];
      return typeof v === 'number' ? v : fallback;
    }
    /** Nudge the octave param ±1 (clamped 0..8) when an OCTAVE key fires.
     *  Written directly on the live SyncedStore proxy (same path as the layer
     *  data writes) so the card + collaborators + persistence all follow. */
    function nudgeOctaveParam(delta: number): void {
      const live = livePatch.nodes[nodeId];
      if (!live?.params) return;
      const cur = typeof live.params.octave === 'number' ? live.params.octave : 4;
      live.params.octave = Math.max(0, Math.min(8, cur + delta));
    }
    function readLayers(): NumpadLayer[] {
      const live = livePatch.nodes[nodeId];
      const raw = (live?.data as Record<string, unknown> | undefined)?.layers;
      return coerceLayers(raw);
    }
    function writeStepIntoLayer(
      layerIdx: number,
      stepIdx: number,
      midi: number,
      heldMidis?: readonly number[],
    ): void {
      const live = livePatch.nodes[nodeId];
      if (!live) return;
      if (!live.data) live.data = {};
      const data = live.data as Record<string, unknown>;
      const layers = coerceLayers(data.layers);
      const layer = layers[layerIdx];
      if (!layer) return;
      // Poly mode passes the keys HELD at capture time → store up to 5 of them
      // (mono outs read `midi`, so set it to the LOWEST). Mono mode: plain note.
      if (heldMidis && heldMidis.length > 1) {
        const voices = heldNotesForStep(heldMidis);
        layer[stepIdx] = { on: true, midi: lowestNote(voices) ?? midi, midis: voices };
      } else {
        layer[stepIdx] = { on: true, midi };
      }
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
      applyPolyOutput(layers);
    }

    /** Feed the poly output with the ACTIVE layer's voices: the live-held keys
     *  win (so you hear/record what you're holding), else the active layer's
     *  current step (its recorded poly notes, or the single `midi`). Always
     *  live — the `poly` PARAM gates RECORDING, not this output. */
    function applyPolyOutput(layers: NumpadLayer[]): void {
      const ai = activeLayerIndex();
      let voices: number[];
      if (manualState[ai]?.gateHigh && pressedNotes.size > 0) {
        voices = heldNotesForStep(Array.from(pressedNotes.values()));
      } else {
        const step = layers[ai]?.[stepIndex] ?? { on: false, midi: null };
        voices = heldNotesForStep(stepVoices(step));
      }
      const lanes = voicingToVOct(voices.map((m) => ({ midi: m, gate: 1 as const })));
      poly.scheduleStep(ctx.currentTime, lanes, 0); // empty lanes ⇒ all gates 0
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
          // Fresh edge state on play-from-start so a stale buffer edge can't
          // leak an extra advance on resume.
          clockCounter.reset();
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
          const edges = clockCounter.poll(ctx.currentTime);
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
        // Keys are now remappable to ANY physical key (not just Numpad*), so
        // never steal keystrokes while the user is typing in a text field or
        // editing a card title — only act when nothing text-like is focused.
        const ae = document.activeElement as HTMLElement | null;
        if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;
        // When a DOOM card has focus, it owns the keyboard.
        if (ae?.closest('[data-card-type="doom"]')) return;
        const live = livePatch.nodes[nodeId];
        const keymap = (live?.data as { keymap?: Record<string, number> } | undefined)?.keymap
          ?? DEFAULT_KEYMAP;
        // OCTAVE keys (remappable; default numpad +/−) nudge the octave param.
        const mapped = keymap[ev.code];
        if (mapped === OCTAVE_UP_ACTION || mapped === OCTAVE_DOWN_ACTION) {
          ev.preventDefault();
          if (!ev.repeat) nudgeOctaveParam(mapped === OCTAVE_UP_ACTION ? 1 : -1);
          return;
        }
        const midi = midiForKey(ev.code, readParam('octave', 4), 0, keymap);
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
          // Poly mode: capture up to 5 of the keys HELD right now (incl. this
          // one — already in pressedNotes) into the step. Mono mode: just `midi`.
          const polyOn = readParam('poly', 0) >= 0.5;
          writeStepIntoLayer(
            layerIdx, recStep, midi,
            polyOn ? Array.from(pressedNotes.values()) : undefined,
          );
        }
      };
      const onUp = (ev: KeyboardEvent) => {
        // Mirror the keydown guard: while a DOOM card has focus,
        // NUMPAD+'s listener stays out of the way.
        if (document.activeElement?.closest('[data-card-type="doom"]')) return;
        // Keys are remappable to ANY physical key, so release any tracked note
        // by its code (the old Numpad-only guard left remapped notes stuck on).
        if (!pressedNotes.has(ev.code)) return;
        ev.preventDefault();
        ev.stopPropagation();
        pressedNotes.delete(ev.code);
        // If no other keys are still held, drop the manual gate.
        if (pressedNotes.size === 0) {
          for (const m of manualState) m.gateHigh = false;
        }
        // Re-apply on EVERY release (not just full release) so the poly output
        // drops the just-released voice while other keys are still held — live
        // poly play streams the current held set through `poly` in real time.
        applyOutputs(readLayers());
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
    outputsMap.set('poly', { node: poly.output, output: 0 });

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
        try { poly.dispose(); } catch { /* */ }
      },
    };
  },
};
