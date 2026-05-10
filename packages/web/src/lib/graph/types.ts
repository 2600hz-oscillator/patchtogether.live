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

/**
 * Returns true if a cable of `srcType` may legally terminate on a port
 * declaring `dstType`. Equal types always pass; the explicit upcast set
 * (keys→mono-video, image→video, mono-video→video, keys→image) covers the
 * "free" video-domain conversions. Audio CV is allowed to terminate on a
 * video param input — the cross-domain bridge (frame-rate S&H) is wired in
 * Phase 1; for Phase 0 we permit the connection at the type level so the
 * wiring story doesn't change later.
 *
 * Strictly out: audio/pitch/gate/polyPitchGate → any video port; any video
 * stream → any audio port.
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
  // Sister modules with built-in wavefolder + waveform-video output:
  | 'vizvco'
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
  // DX7 — pure-TypeScript 6-op FM synth with bundled factory-inspired patches.
  | 'dx7'
  // NOISE — basic noise source with white / pink / brown outputs.
  | 'noise'
  // BUGGLES — chaotic random voltage source (wogglebug-style).
  | 'buggles';
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
}
