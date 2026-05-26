// packages/web/src/lib/graph/types.ts
//
// Patch graph data model. Per D8 the patch graph lives in a Yjs doc accessed
// through SyncedStore. Per D18 the type system is registry-based, not closed,
// so future visual modules can register new domains and cable types without
// touching this file's union members.

// ---------------- Domain (D18) ----------------
// Phase 1 ships 'audio'. The video-domain spike (Phase 0 of the visual
// modules MVP) adds 'video' alongside; future domains (e.g. MIDI, OSC)
// follow the same pattern. The `(string & {})` open union preserves
// autocomplete on the well-known set while leaving the door open for
// runtime-registered domains.
type StandardDomain = 'audio' | 'video';
export type Domain = StandardDomain | (string & {});

// ---------------- Cable types (D6, D7, D18) ----------------
// `polyPitchGate` is the Stage-1 polyphony cable (10 audio channels packed
// (p0,g0,p1,g1,...,p4,g4) — 5 voice pairs). See packages/web/src/lib/audio/poly.ts
// and .myrobots/plans/dx7-and-polyphony.md §5 for the architecture.
//
// Video-domain cable types (Phase 0):
//   keys       — single-channel still mono image (no time axis)
//   image      — RGB still image (no time axis)
//   mono-video — single-channel animated video stream
//   video      — RGB animated video stream
// Implicit upcasting `keys → mono-video`, `image → video`, `keys → image`
// is allowed; the upcast is free at the shader layer. See `canConnect`.
type StandardCableType =
  | 'audio'
  | 'pitch'
  | 'gate'
  | 'cv'
  | 'polyPitchGate'
  | 'keys'
  | 'image'
  | 'mono-video'
  | 'video';
export type CableType = StandardCableType | (string & {});

/** True if `type` is one of the four video-domain cable types. */
export function isVideoCableType(type: CableType): boolean {
  return type === 'keys' || type === 'image' || type === 'mono-video' || type === 'video';
}

/** The "CV family" — bipolar audio-rate voltages that all flow through the
 *  same Web Audio routing and are freely interchangeable at the type level.
 *  `cv` is the canonical bipolar control voltage; `pitch` adds the V/oct
 *  semantic; `gate` is a 0/+5V style trigger. The engine handles them
 *  uniformly (CV → AudioParam, with the cv-scale helper applied when the
 *  destination opts in), and real-world patches routinely cross-patch them
 *  — a SEQUENCER.gate firing into an ADSR.attack as a modulator, an LFO
 *  driving AnalogVCO.pitch_cv to wiggle pitch, a Sequencer.pitch into a
 *  filter cutoff for keytracking. canConnect used to reject these at the
 *  UI level (the patch-to cascade hid them as "not compatible") even though
 *  the engine permits them — see canConnect(). */
const CV_FAMILY = new Set<string>(['cv', 'pitch', 'gate']);

/**
 * Returns true if a cable of `srcType` may legally terminate on a port
 * declaring `dstType`. Equal types always pass; explicit upcasts cover:
 *
 *   * Video-domain "free" conversions: keys→mono-video, keys→image,
 *     image→video, mono-video→video.
 *   * CV family (cv ↔ pitch ↔ gate): any direction. They're all bipolar
 *     audio-rate voltages flowing through the same AudioParam plumbing,
 *     and rejecting cross-family patches at the UI level (while the engine
 *     happily routes them at runtime) hid legitimate patches from the
 *     patch-to cascade. See CV_FAMILY above.
 *   * polyPitchGate ↔ cv-family: the engine interposes a splitter
 *     (poly→mono picks channel 0) or merger (mono→poly fills channel 0,
 *     rest silent) via resolveConnection in poly.ts — we mirror that
 *     permissiveness at the type-check level here.
 *   * Audio CV → video param input (frame-rate sample-and-hold; the
 *     bridge is wired in Phase 1, but we permit the connection at the
 *     type level so the eventual bridge doesn't change call-site type
 *     checks).
 *
 * Strictly out: audio → any non-audio port; video → any audio port; gate
 * → audio (a 0/5V gate landing on an audio bus is the kind of click track
 * the limiter shouldn't have to defend against).
 */
export function canConnect(srcType: CableType, dstType: CableType): boolean {
  if (srcType === dstType) return true;

  const upcasts: Record<string, readonly string[]> = {
    keys: ['mono-video', 'image'],
    image: ['video'],
    'mono-video': ['video'],
  };
  const ok = upcasts[srcType as string];
  if (ok && ok.includes(dstType as string)) return true;

  // CV family — cv / pitch / gate all interchange at the type level.
  if (CV_FAMILY.has(srcType as string) && CV_FAMILY.has(dstType as string)) {
    return true;
  }

  // polyPitchGate ↔ cv-family. Splitter / merger interposed by the
  // engine's resolveConnection (poly.ts).
  if (srcType === 'polyPitchGate' && CV_FAMILY.has(dstType as string)) return true;
  if (CV_FAMILY.has(srcType as string) && dstType === 'polyPitchGate') return true;

  // Audio CV → video param input (frame-rate sample-and-hold; deferred
  // bridge in Phase 1). Permit at the type level so the eventual bridge
  // doesn't change call-site type checks.
  if (srcType === 'cv' && isVideoCableType(dstType)) return true;

  return false;
}

// ---------------- Module types (D5) ----------------
type StandardModuleType =
  | 'audioOut'
  | 'analogVco'
  | 'wavetableVco'
  | 'adsr'
  | 'filter'
  | 'vca'
  | 'mixer'
  | 'sequencer'
  | 'reverb'
  | 'scope'
  // RASTERIZE — explicit audio→video raster mapper (crossing-the-streams
  // slice 1). audio in → mono-video out; each frame paints a fixed run of
  // audio samples as voltage-per-pixel in raster order, scan cursor drifts
  // + wraps through the 640×360 frame. Faithful raster (NOT a scope trace)
  // — a steady tone paints drifting horizontal bands. Fully untamed.
  | 'rasterize'
  | 'lfo'
  | 'cartesian'
  | 'destroy'
  | 'qbrt'
  | 'drummergirl'
  | 'meowbox'
  | 'mixmstrs'
  | 'timelorde'
  | 'charlottesEchos'
  | 'riotgirls'
  | 'score'
  | 'drumseqz'
  | 'polyseqz'
  // GRIDS — Mutable Instruments topographic drum pattern generator
  // (BD/SD/HH triggers + accent from a 5x5 interpolated drum map; euclidean mode).
  | 'grids'
  // WAVVIZ — wavetable VCO with built-in wavefolder + waveform-video output.
  | 'wavviz'
  // SWOLEVCO — Buchla 259-style complex VCO (primary + modulator + cross-mod
  // + symmetry morph + wavefolder + scope video out).
  | 'swolevco'
  // Video-domain modules (Phase 0 spike):
  | 'lines'
  | 'videoOut'
  // SHAPES — geometry source (circle / square / triangle, optional tile,
  // CV-controllable rotate + zoom). Sibling to LINES.
  | 'shapes'
  // MONOGLITCH — luma → vertical-scanline displacement OUTPUT. Originally
  // shipped as "RUTTETRA" (PR-99) but renamed once the actual Rutt/Etra
  // raster-coord-remap model landed under that name.
  | 'monoglitch'
  // RUTTETRA — true Rutt/Etra raster-scan-coordinate processor. X/Y are
  // mono-video coordinate fields, Z is the source video. Pair with
  // SHAPEDRAMPS for shaped/folded/radial coordinate remaps.
  | 'ruttetra'
  // SHAPEDRAMPS — sync-locked ramp generator. Stable linear h_lin/v_lin
  // outputs (clean raster passthrough) plus shaped h_out/v_out outputs
  // (morphable for RUTTETRA's raster-coord remap).
  | 'shapedramps'
  // Video-domain modules (Phase 1 — .myrobots/plans/video-modules-mvp.md):
  | 'inwards'
  | 'picturebox'
  | 'destructor'
  | 'chroma'
  | 'luma'
  // CHROMAKEY — proper 2-input chroma-key compositor (fg + bg + key
  // color). Replaces the old single-input CHROMA which conflated
  // "key-mask extraction" with the user-facing concept of a keyer.
  | 'chromakey'
  // LUMAKEY — 2-input luma-key compositor (fg + bg + luma threshold).
  // Sibling to CHROMAKEY; replaces the old single-input LUMA's
  // mask-extraction shape.
  | 'lumakey'
  | 'colorizer'
  | 'feedback'
  | 'videoMixer'
  // CAMERA — webcam input (local-only). Spec: .myrobots/plans/module-camera-input.md.
  | 'cameraInput'
  // ILLOGIC — combined attenuverter / math / logic utility (audio domain).
  | 'illogic'
  // UNITYSCALEMATHEMATIK — three independent CV-shaping channels (1 unity
  // attenuvert + 2 attenuvert-with-linear/expo-curve sections), all bipolar.
  | 'unityscalemathematik'
  // ANALOGLOGICMATHS — analog-logic mixer (MIN/MAX/DIFF/SUM/PRODUCT) inspired
  // by Mystic Instruments ANA. Two continuous inputs feed bipolar
  // attenuverters, then five simultaneous algebraic outs. Continuous-signal
  // analog logic — NOT the digital boolean logic of ILLOGIC.
  | 'analogLogicMaths'
  // DX7 — pure-TypeScript 6-op FM synth with bundled factory-inspired patches.
  | 'dx7'
  // NOISE — basic noise source with white / pink / brown outputs.
  | 'noise'
  // BUGGLES — chaotic random voltage source (wogglebug-style).
  | 'buggles'
  // VDELAY — video delay + feedback echo (ring buffer of FBO textures).
  | 'vdelay'
  // BENTBOX — CRT display output simulating an NTSC composite signal bent
  // through an Archer-Video-Enhancer-style "AVEmod" feedback circuit. 12
  // CV-controllable bending knobs (timing/chroma/feedback/CRT).
  | 'bentbox'
  // ACIDWARP — 320×240 plasma video source with scene cycler. NTSC 4:3
  // output — pairs naturally with BENTBOX downstream.
  | 'acidwarp'
  // WAVECEL — stereo wavetable VCO with morph + spread + wavefolder. Loads
  // E352 Cloud Terrarium-format WAV wavetables; Card UI provides a 3D
  // wavetable visualization mode alongside the standard scope view.
  | 'wavecel'
  // WARRENSPECTRUM — stereo 8-band filterbank with vactrol-style ping
  // excitation + acidwarp video visualizer. Audio domain with a
  // cross-domain `viz_out` mono-video bridge for the EQ-curve+waveform+
  // ping-flash visualization.
  | 'warrenspectrum'
  // STEREOVCA — stereo VCA + ring modulator. Same per-channel multiply
  // behaves as VCA gain (slow strength) or ring mod (audio-rate strength);
  // INDEPENDENT normalling on the audio and strength halves.
  | 'stereovca'
  // SHIMMERSHINE — lush stereo shimmer reverb. Schroeder tank
  // (4 combs + 2 allpasses per channel) with a pitch-shifted (+12 semis)
  // feedback loop using a granular-fade dual-head pitch shifter.
  | 'shimmershine'
  // MACROOSCILLATOR — Plaits-style macro oscillator (Mutable Instruments
  // archetype). First slice ships two synthesis models behind the three
  // canonical macros (HARMONICS / TIMBRE / MORPH): virtual analog (VA) and
  // waveshape. Pure-TS clean-room implementation; not a port of Plaits' C++
  // (see PR #27 for the closed emscripten attempt + .myrobots note).
  | 'macrooscillator'
  // CLOUDS — granular texture processor (Mutable Instruments Clouds
  // archetype, Émilie Gillet, 2014, MIT-licensed). Pure-TypeScript port
  // of the GRANULAR mode: 2-second stereo ring buffer + overlap-added
  // grain cloud (up to 24 grains) + latched FREEZE + V/oct grain-pitch
  // tracking. 6 macros (Position / Size / Pitch / Density / Texture /
  // Blend). v1 ships GRANULAR mode only; STRETCH / LOOPING-DELAY /
  // SPECTRAL deferred.
  | 'clouds'
  // MACSEQ — 16-step sequencer with per-step MACROOSCILLATOR voice picker.
  | 'macseq'
  // RINGS — modal / sympathetic-string resonator (Mutable Instruments
  // Rings archetype; faithful algorithm port of Émilie Gillet eurorack/rings/
  // DSP, MIT-licensed). v1 ships two resonator models:
  // (0) MODAL — 24 parallel stiffness-stretched RBJ bandpasses;
  // (1) SYMPATHETIC — 2 parallel Karplus-Strong delay lines.
  // Polyphony 1 only; STRING + REVERB deferred to follow-up PRs.
  | 'rings'
  // PEAKS — dual-channel multi-mode utility (Mutable Instruments Peaks
  // archetype, Émilie Gillet, 2013, MIT-licensed). Each channel runs one
  // of five modes (KICK / SNARE / HIHAT / ENV / LFO) with two mode-
  // dependent knobs, a gate input, and CV-routed knob inputs. v1 ships
  // five modes; multistage envelope / tap-LFO / BPF mode deferred.
  | 'peaks'
  // WARPS — meta-modulator / signal masher (Mutable Instruments Warps
  // archetype, Émilie Gillet, 2014, MIT-licensed). Clean-room TypeScript
  // port. v1 ships 4 Xmod algorithms (XFADE / RING-MOD / XOR / COMPARE)
  // with an internal carrier oscillator (sine / triangle / saw / square)
  // so the module is usable with a single input or no inputs at all.
  // FOLD / ANALOG-RING / FREQUENCY-SHIFTER / DOPPLER / VOCODER deferred
  // to follow-up.
  | 'warps'
  // VEILS — quad VCA + soft-clip summing mix (Mutable Instruments Veils
  // archetype). 4 independent VCAs each with audio in, CV in, gain knob,
  // per-channel response toggle (linear / exponential), and a direct out;
  // plus a tanh-soft-clipped sum mix out. Gain knobs span [0, 2] so
  // knob+CV can push past unity into warm overdrive.
  | 'veils'
  // ATTENUMIX — the simple 4-channel attenuating mixer. Per-channel
  // attenuator (knob 0..1) + CV-summed input + post-attenuator direct out
  // + master knob (0..2) → tanh-soft-clipped mix output. Same topology as
  // VEILS but capped attenuators (no per-channel boost), no response
  // toggle, simpler labeling — this is the "I just want a mixer" mixer.
  | 'attenumix'
  // BLADES — dual state-variable VCF + COLOR overdrive + mix bus
  // (Mutable Instruments Blades archetype, analog hardware → from-spec
  // TS implementation). Two independent SVF cores each with LP/BP/HP
  // mode + V/oct CV + cutoff CV + resonance CV; global COLOR knob
  // tanh-soft-clips the input pre-filter for the signature grit; mix
  // bus toggles PARALLEL (sum) vs SERIAL (filter1 → filter2).
  | 'blades'
  // STAGES — 6-segment cascadable function generator (Mutable Instruments
  // Stages archetype, Émilie Gillet, 2017, MIT-licensed). Clean-room TS
  // port: 6 segments, each with a TYPE select (RAMP / HOLD / STEP), a
  // primary knob (TIME for RAMP; LEVEL for HOLD/STEP), and a SHAPE knob
  // (phase warp for RAMP; portamento for HOLD/STEP). Adjacent segments
  // can be LINKed via 5 boundary bits to form multi-stage envelopes (AHD,
  // AHDSR, longer arbitrary shapes). Each segment has its own GATE input
  // and CV output; a global TRIG input re-fires every chain's leader.
  // v1 ships TYPE + LINK + GATE + TRIG; Outliner / chord-mode / looping
  // LFO mode deferred to follow-up.
  | 'stages'
  // CLOUDSEED — exact algorithm port of Ghost Note Audio CloudSeed reverb
  // (MIT-licensed). Stereo input → cross-mix → per-channel: optional pre-EQ
  // HP/LP → modulated pre-delay → multitap early field → AllpassDiffuser
  // (up to 12 stages) → 12 parallel late-field DelayLine voices each with
  // optional in-loop AllpassDiffuser + LowShelf + HighShelf + LP. Exposes
  // 7 macro AudioParams (DRY/EARLY/LATE/INPUT_MIX/LOW_CUT/HIGH_CUT/CROSS_SEED)
  // + 38 message-port params (toggles, integer counts, seeds, modulation
  // knobs). Bundled v1 preset bank: DIVINE INSPIRATION (DarkPlate from
  // the C++ Programs.h verbatim), SHORT ROOM, BRIGHT HALL, INFINITE PAD.
  | 'cloudseed'
  // MIDI-CV-BUDDY — hardware MIDI controller → pitch + gate + velocity CV.
  // Main-thread Web MIDI handler writing into three ConstantSourceNode
  // outputs. Monophonic with user-selectable voice priority (LAST / LOW /
  // HIGH), retrigger toggle, channel filter, and a device picker.
  | 'midiCvBuddy'
  // MIDICLOCK — hardware MIDI transport bridge. CLOCK (gate) at user-
  // selected subdivision (default quarter-note → TIMELORDE-compatible),
  // RUN (cv, 0/1), MIDISTART + MIDISTOP (one-shot gates). System Real-
  // Time messages only — channel-voice handling is MIDI-CV-BUDDY's job.
  | 'midiclock'
  // HELM — polyphonic subtractive synth (algorithm port of Matt Tytel's
  // Helm GPL-3.0). 2 morphing oscillators + sub + noise → SVF filter →
  // 3 ADSR envelopes → 2 mono LFOs → 16-step step sequencer; polyphonic
  // MIDI input via gear-icon settings menu (device picker + per-channel
  // rx multi-select). Stereo output.
  | 'helm'
  // HYDROGEN — port of the Hydrogen drum machine. First pass ships the
  // bundled TR-808 emulation kit (16 instruments × 16-step pattern grid,
  // single-layer samples). Sample assets live in /drumkits/tr808/.
  | 'hydrogen'
  // STICKY — paper-style sticky note (domain 'meta'). No ports, no engine
  // binding; just an editable, resizable, Yjs-synced text card. Lives in
  // the palette's "meta" category.
  | 'sticky'
  // GROUP — collapses N modules into a single card (domain 'meta'). No
  // engine binding; ports are dynamic from data.exposedPorts, projected
  // through to the underlying child ports by group-projection.ts so the
  // engine never sees groups. Module-grouping Phase 1 feature.
  | 'group'
  // LIVECODE — JS-runtime live-coding module. CodeMirror editor with
  // port-aware autocomplete + diagnostics; runtime is a `new Function`
  // sandbox exposing spawn/patch/set/read/clock.*/clocked(). No audio
  // I/O — the card mutates the patch graph directly. See
  // /docs/modules/livecode.
  | 'livecode'
  // CLOCKED runner — a self-contained mini-LIVECODE spawned by
  // LIVECODE's clocked(division, fn) call. Owns one subscription; its
  // body re-fires on every division boundary derived from TIMELORDE
  // bpm. Deleting the runner cancels the subscription. No audio I/O.
  | 'clockedRunner'
  // PONG — interactive game module (research prototype). CV paddles in,
  // gate scores out. Single-user in this slice; multi-user wiring
  // documented in docs/design/game-modules.md.
  | 'pong'
  // MODTRIS — Tetris-clone game module (research prototype). 5 gate inputs
  // (rotate L/R, drop, move L/R), 2 gate outputs (line_cleared, overfill).
  // Single-user in this slice; multi-user via 30 Hz awareness snapshot is
  // a follow-up per docs/design/game-modules.md §2.
  | 'modtris'
  // JOYSTICK — manual XY pad. Outputs x, y, nx (= -x), ny (= -y) as CV.
  // No inputs in v1 (future: MIDI-mappable). Mirrors how an LFO emits
  // multiple inverted/quadrature outputs from a single source of motion.
  | 'joystick'
  // GAMEPAD — connected USB/Bluetooth HID controller (Xbox / PS /
  // generic) as CV (stick axes + triggers) and gate (face / bumper /
  // dpad / menu buttons). Polls navigator.getGamepads() at rAF rate.
  | 'gamepad'
  // NUMPAD+ — numpad-driven 4-layer × 16-step sequencer with live
  // play, REC ARM (one-pass record on next play-from-start) and
  // OVERDUB (always-recording). Captures Numpad* keys globally.
  | 'numpadPlus'
  // WAVESCULPT — hybrid 4-oscillator video synth. Four "wall-mounted"
  // virtual oscillators emit 3D wave ribbons inside a unit box; a user-
  // controlled camera (XY joystick + height + zoom) renders a view of
  // the scene. Audio output is the distance-attenuated sum of all four
  // voices (stereo). Final video pass: BENTBOX-style CRT.
  | 'wavesculpt'
  // ATLANTIS-PATCH support trio. Each is general-purpose; together they
  // make Schrader-style self-evolving "ecosystem" patches tractable.
  // SLEWSWITCH — quad slew limiter + 4→1 sequential CV switch.
  | 'slewSwitch'
  // ATLANTISCATALYST — 8 correlated random-walk CV outputs + scene pulse
  // / scene index, with HYDROGEN-style transport CV for explicit jumps.
  | 'atlantisCatalyst'
  // AQUATANK — 4-channel Hadamard FDN feedback matrix; the metallic /
  // aquatic resonance engine the demo patch hangs off of.
  | 'aquaTank'
  // DOOM — single-instance interactive video module. WASM-backed
  // doomgeneric (GPLv2, vendored at packages/web/native/doomgeneric)
  // runs on whichever rack-mate spawned the card; spectators receive
  // framebuffers via Yjs awareness at ~10 Hz. 7 cv-typed gate inputs
  // (w/a/s/d/space/ctrl/alt) edge-detect into the engine's key queue;
  // stereo audio outputs route via the video→audio bridge (silent
  // until the slice-8 audio path lands). maxInstances: 1.
  | 'doom'
  // CALLSINE — spectral-analysis additive resynthesizer (algorithm port of
  // Warren's Spectrum / CallSine, MIT-licensed). audio in → STFT → tracked
  // sinusoidal peaks → additive bank (up to 64 oscillators). v1 ships two
  // voice models (SINES, SAW); scaffolded for 12+ follow-up models. Gate
  // input toggles FREEZE (latches the current spectrum).
  | 'callsine';
export type ModuleType = StandardModuleType | (string & {});

// ---------------- Port + parameter schemas ----------------

/**
 * CV-input scaling hint (see .myrobots/plans/cv-range-standard.md).
 *
 * Project convention: the `cv` cable type carries a bipolar -1..+1
 * "modulation" signal where ±1 should sweep the target param through its
 * full natural range, centered on the user-set knob position. Without
 * scaling, an LFO of ±1 summed into an AudioParam whose natural range is
 * (e.g.) 0.001..10s touches only ~10% of the slider's motion — far short
 * of the user's expectation that an LFO drives a slider through its full
 * range of motion.
 *
 * Setting `cvScale` on an input PortDef tells `AudioEngine.addEdge` to
 * interpose a scaling node (GainNode for `linear`, WaveShaperNode for
 * `log`/`discrete`) between the source and the target AudioParam, so the
 * incoming -1..+1 maps to the param's full natural span.
 *
 * Modes:
 *   - `linear`: effective = clamp( knob + cv * depth * (max-min)/2, min, max )
 *     Used for params where additive modulation is the natural musical
 *     metaphor — volume, pan, mix amount, EQ band gain, etc.
 *   - `log`: effective = clamp( knob * pow(max/min, cv * depth / 2), min, max )
 *     Used for params whose perceptual range is logarithmic — frequency in
 *     Hz, time in seconds. ±1 cv = ±half the param's full octave span.
 *   - `discrete`: integer bucketing — `floor((cv+1)/2 * (max-min+1))`
 *     mapped to [min, max]. Used for mode toggles, range selectors.
 *   - `passthrough`: no scaling (Web Audio sums the source directly into
 *     the AudioParam, the legacy behavior). Use when the destination DSP
 *     already implements its own CV scaling (e.g. filter.dsp's ±5oct map).
 *
 * `depth` is reserved for a future per-param "modulation depth" knob;
 * default 1.0 = full sweep.
 */
export interface CvScaleHint {
  mode: 'linear' | 'log' | 'discrete' | 'passthrough';
  /** Per-param modulation depth. 1.0 = full natural-range sweep. */
  depth?: number;
}

export interface PortDef {
  id: string;
  type: CableType;
  // Whether the input is an audio-rate node connection or a CV → AudioParam routing.
  // Outputs are always nodes; this hint lives on inputs only.
  paramTarget?: string; // when set, CV connections route to this AudioParam
  /**
   * Optional: scaling hint for `cv`-typed input ports that target a
   * paramTarget. See CvScaleHint for the mapping. When omitted, behavior
   * is `passthrough` — Web Audio sums the source directly into the
   * AudioParam (the legacy behavior). Set explicitly to opt into the
   * "LFO sweeps full range" semantics.
   */
  cvScale?: CvScaleHint;
}

export type KnobCurve = 'linear' | 'log' | 'exp' | 'discrete';

export interface ParamDef {
  id: string;
  label: string;
  defaultValue: number;
  min: number;
  max: number;
  curve: KnobCurve;
  units?: string;
}

export type ParamSchema = Readonly<ParamDef[]>;

// ---------------- Patch graph (D8) ----------------
export interface ModuleNode {
  id: string;
  type: ModuleType;
  domain: Domain; // 'audio' for all Phase 1 modules
  position: { x: number; y: number };
  params: Record<string, number>;
  data?: Record<string, unknown>;
}

export interface Edge {
  id: string;
  source: { nodeId: string; portId: string };
  target: { nodeId: string; portId: string };
  sourceType: CableType;
  targetType: CableType;
}

export interface PatchGraph {
  nodes: Record<string, ModuleNode>;
  edges: Record<string, Edge>;
}

// ---------------- Module registry shape (D18, D19) ----------------
export interface ModuleDef {
  type: ModuleType;
  domain: Domain;
  /** Human-readable name (palette + UI). */
  label: string;
  /** Palette grouping. */
  category: 'sources' | 'modulation' | 'filters' | 'effects' | 'utilities' | 'output' | string;
  inputs: PortDef[];
  outputs: PortDef[];
  params: ParamSchema;
  /** Bumped when params or data shape changes (D19). */
  schemaVersion: number;
  /** Migrate older saved data forward to the current schemaVersion. */
  migrate?: (data: unknown, fromVersion: number) => unknown;
  /**
   * Module-grouping Phase 3A: when set, this module renders an on-card
   * visualization (typically a <canvas>) that can be portaled into the
   * parent GroupCard. See AudioModuleDef.vizPassthrough for the canonical
   * doc. Mirrored here so callers that read the loose ModuleDef shape
   * (e.g. defLookup helpers in Canvas.svelte) can read the flag without
   * downcasting to a domain-specific def.
   */
  vizPassthrough?: boolean;
}
