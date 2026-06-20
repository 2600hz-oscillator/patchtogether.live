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
//
//   modsignal  — a permissive MODULATION input that accepts EITHER a cv, gate,
//                OR audio source. Used by TOYBOX's Structure-style 6-input
//                modulation section: each input has an attenuverter + offset and
//                auto-detects whether a cv-rate or audio-rate signal is patched
//                (audio is envelope-followed by the cross-domain bridge). It is
//                a TARGET-only type — no source ever emits `modsignal`, so the
//                cable stripe keys off the SOURCE type (cv/audio/gate) and no new
//                cable colour variant is needed (Canvas.svelte). Declaring this
//                as its own type (rather than globally widening audio→cv) keeps
//                the audio→cv connection rejected everywhere EXCEPT modsignal
//                inputs.
type StandardCableType =
  | 'audio'
  | 'pitch'
  | 'gate'
  | 'cv'
  | 'modsignal'
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

  // modsignal MODULATION input (TOYBOX's 6-input section) accepts a cv, gate,
  // OR audio source. This is the ONLY place audio→(non-audio) is permitted: it
  // is scoped to the `modsignal` TARGET type, so audio→cv / audio→pitch etc.
  // stay rejected everywhere else. The cross-domain bridge envelope-follows an
  // audio source to a 0..1 modulation value (engine.ts → tickCvBridges); cv/gate
  // sample-and-hold as usual. (modsignal→modsignal is covered by the equal-type
  // check above; no source ever emits `modsignal`.)
  if (dstType === 'modsignal') {
    return srcType === 'cv' || srcType === 'gate' || srcType === 'audio';
  }

  return false;
}

/**
 * Can a cable of `srcType` legally terminate on this INPUT port? Passes if the
 * global rule allows it (canConnect) OR the port opts in via its `accepts` list
 * (the per-port widening — e.g. a SCOPE probe accepting the CV family on an
 * `audio`-typed input). The single source of truth shared by the drag-connect
 * validator and the right-click patch cascade so both agree.
 */
export function canConnectToPort(
  srcType: CableType,
  dst: { type: CableType; accepts?: readonly CableType[] },
): boolean {
  if (canConnect(srcType, dst.type)) return true;
  return dst.accepts?.includes(srcType) ?? false;
}

// ---------------- Module types (D5) ----------------
//
// Per D18 the module type system is registry-based, NOT a closed union.
// `ModuleType` is therefore an OPEN branded string: every registered module
// def supplies its own `type` id at `registerModule` time and the registries
// (audio / video / meta) are the single source of truth for the live set.
//
// Adding a module requires NO edit to this file. The short `CoreModuleType`
// seed below exists ONLY to preserve editor autocomplete on a handful of
// frequently-referenced built-ins (anchor modules + the routing / help code
// that name-checks them); it is intentionally NON-EXHAUSTIVE. Do not grow it
// per-module — that append-edit is exactly the cross-PR conflict the
// glob-driven registries were built to remove. `(string & {})` keeps any
// other registered type id assignable while leaving the seed autocomplete
// intact.
//
// If you need the EXHAUSTIVE live set at runtime, read it from the registry
// (`listModuleDefs()` / `listVideoModuleDefs()` / `listMetaModuleDefs()`),
// not from this type.
type CoreModuleType =
  // Audio anchors + the core signal-flow primitives.
  | 'audioOut'
  | 'analogVco'
  | 'wavetableVco'
  | 'adsr'
  | 'filter'
  | 'vca'
  | 'mixer'
  | 'sequencer'
  | 'lfo'
  | 'scope'
  | 'timelorde'
  // Video anchors.
  | 'videoOut'
  | 'lines'
  // Meta-domain organizational cards.
  | 'sticky'
  | 'group';
export type ModuleType = CoreModuleType | (string & {});

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
   * Optional: extra SOURCE cable types this INPUT accepts beyond what
   * canConnect(srcType, this.type) already allows. Use sparingly — it's an
   * explicit, per-port widening for inputs where the global rule is too strict.
   * The canonical case is a SCOPE probe: its signal inputs are typed `audio`
   * but should accept the CV family (cv/pitch/gate) for visualizing LFOs,
   * envelopes, pitch CV and gates — a visualizer is not a master bus, so the
   * "CV on an audio bus → DC/click" guard canConnect enforces globally doesn't
   * apply. See canConnectToPort(). Honoured by the drag-connect validator
   * (validate-edge) AND the right-click patch cascade (port-patch-helpers).
   */
  accepts?: CableType[];
  /**
   * Optional: scaling hint for `cv`-typed input ports that target a
   * paramTarget. See CvScaleHint for the mapping. When omitted, behavior
   * is `passthrough` — Web Audio sums the source directly into the
   * AudioParam (the legacy behavior). Set explicitly to opt into the
   * "LFO sweeps full range" semantics.
   */
  cvScale?: CvScaleHint;
  /**
   * Optional DECLARED gate/trigger semantic for this port (the consumer
   * contract — see $lib/audio/gate-trigger). It does NOT restrict connections:
   * the unified `gate` cable stays cross-patchable with cv/pitch (it's just CV),
   * exactly as before. `edge` only documents how a `gate`-typed port behaves so
   * the model is explicit + lintable instead of re-derived per module, and so
   * the card can show a ▷ (trigger) / ▭ (gate) glyph on the port:
   *   - 'trigger' → fires ONCE per rising edge (clock / reset / strike / sync /
   *                 start-stop / sample); ignores how long the level stays high.
   *                 MUST be edge-detected (shared createEdgeCounter or a
   *                 per-sample worklet edge-detect) — never level-sampled.
   *   - 'gate'    → acts WHILE the level is high + reacts to both edges (an
   *                 ADSR sustain, a VCA hold, a poly note-on/off). Do NOT
   *                 convert a gate consumer to edge-only.
   * Only meaningful on `gate`-typed ports (inputs primarily; an output may
   * carry it to drive the cosmetic glyph + emitted waveform shape).
   * (Literal union mirrors EdgeSemantic in $lib/audio/gate-trigger — inlined
   * here to keep the foundational graph layer free of an audio-layer import.)
   */
  edge?: 'trigger' | 'gate';
  /**
   * OUTPUT-port only: declare this output as a TYPE-TRANSPARENT pass-through
   * whose EMITTED cable type adopts the type of whatever's patched into the
   * named INPUT port (its `id`). Use on attenuator/scaler/buffer utilities
   * that pass a signal through unchanged — the cable on the OTHER side of the
   * module should be the SAME class (a CV source → a CV output), not a fixed
   * declared type.
   *
   * WHY THIS MATTERS — the audio→video bridge picks its read path off the
   * SOURCE cable type: an `audio`-typed source is RMS envelope-followed
   * (clamped 0..1), while a `cv`/`gate`/`pitch` source is read as the raw
   * tail sample. SCALER scales a CV signal, but with a hard-wired `audio`
   * output its scaled CV hit the RMS follower and SATURATED — the AMOUNT knob
   * had ZERO effect at a video destination. Adopting the upstream type keeps a
   * CV signal CV through the bridge so AMOUNT actually scales the ±CV value.
   *
   * Resolution is LIVE (re-derived in buildPatchSnapshot every graph update),
   * so re-patching the upstream re-types the output. Falls back to this port's
   * declared `type` when nothing is patched upstream, or when the adopted type
   * could not legally reach the actual downstream target (canConnect guard) —
   * so an audio source still emits `audio` and drives an audio bus normally.
   */
  adoptsUpstreamFrom?: string;
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
  /**
   * Per-node persistent state (Yjs-synced). Open `Record<string, unknown>`
   * because each module owns its own data shape. A few cross-cutting keys the
   * platform reads on ANY node:
   *   - `name?: string`         — the editable display name (ModuleNameLabel).
   *   - `controlColor?: string` — this module's "control colour" tag, a 6-digit
   *     uppercase hex (e.g. `'F45C51'`). Read LIVE as PASSTHROUGH by the Control
   *     Surface / ElectraControl stripes + the Electra preset (they NEVER copy
   *     it onto their own data). Set via `setControlColor` (mutate.ts); resolved
   *     — with an auto per-instance default when unset — by `resolveControlColor`
   *     (control-color.ts).
   */
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

/**
 * Rack HEIGHT tier in whole grid units — `${N}u` = N square grid tiles tall.
 * Most modules are '1u' (small utilities) or '3u' (standard); genuinely-large
 * modules (WebGL synths, big filter banks, control grids) take an EXACT taller
 * tier ('4u', '5u', …) rather than being crammed — every tier is a whole
 * multiple of one tile so the rack stays on its 1u×1u grid.
 */
export type RackSize = `${number}u`;

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
  /**
   * Rack sizing (Phase-1 rack standardization). HEIGHT tier — every module is
   * either '1u' (one square grid tile tall) or '3u' (three tiles tall). WIDTH
   * is `hp` square tiles wide (default 1). The canvas snaps to a 1u×1u grid;
   * the shared card CSS forces height/width from these via the `rack-{size}` +
   * `rack-hp{n}` classes the flowNodes derivation applies. Unset = unmigrated
   * (the card keeps its content-driven size until it's classified).
   */
  size?: RackSize;
  /** Width in 1u square tiles (default 1). See `size`. */
  hp?: number;
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
