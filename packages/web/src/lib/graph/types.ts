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
// 2026-06: the cable/port type legend was COLLAPSED from 9 visible types to
// FOUR semantic channels (owner spec — see feat/cable-type-collapse):
//
//   cv     — every control/voltage signal: bipolar CV, V/oct PITCH, and
//            GATE/TRIGGER pulses. (pitch + gate folded INTO cv; the
//            trigger-vs-gate consumer contract survives verbatim on the
//            SEPARATE `PortDef.edge` field, NOT the cable type.)
//   audio  — audio-rate bus signal.
//   video  — every video-domain frame/image stream: the former keys, image,
//            mono-video and video all fold into one `video` type.
//   poly   — the multi-voice cable (formerly `polyPitchGate`): 10 packed
//            audio channels (p0,g0,p1,g1,...,p4,g4) — 5 voice pairs. Kept as
//            its own 4th type so multi-voice routing stays EXPLICIT (the owner
//            does NOT want poly folded into cv/audio). See packages/web/src/
//            lib/audio/poly.ts and .myrobots/plans/dx7-and-polyphony.md §5.
//
//   modsignal — a permissive MODULATION input that accepts EITHER a cv OR
//               audio source. Used by TOYBOX's Structure-style 6-input
//               modulation section: each input has an attenuverter + offset and
//               auto-detects whether a cv-rate or audio-rate signal is patched
//               (audio is envelope-followed by the cross-domain bridge). It is
//               a TARGET-only type — no source ever emits `modsignal`, so the
//               cable stripe keys off the SOURCE type (cv/audio) and no new
//               cable colour variant is needed (Canvas.svelte). Declaring this
//               as its own type (rather than globally widening audio→cv) keeps
//               the audio→cv connection rejected everywhere EXCEPT modsignal
//               inputs. NOT one of the 4 user-facing legend types.
type StandardCableType =
  | 'audio'
  | 'cv'
  | 'video'
  | 'poly'
  | 'modsignal';
export type CableType = StandardCableType | (string & {});

/**
 * The 9→4 collapse map. Maps every LEGACY cable-type string a persisted
 * patch / old edge / stale fixture might carry onto its post-collapse name.
 * Unknown strings (custom registered types, the kept `audio`/`cv`/`video`/
 * `poly`/`modsignal`) pass through unchanged. This is the SINGLE source of
 * truth for the migration — call `migrateCableType` at every load/deserialize
 * boundary that reads a stored type string (patch reconciler, edge load).
 */
const CABLE_TYPE_MIGRATION: Record<string, CableType> = {
  // CV family — pitch + gate fold into cv (edge semantics live on PortDef.edge).
  pitch: 'cv',
  gate: 'cv',
  // Video family — all four former video-domain types fold into video.
  keys: 'video',
  image: 'video',
  'mono-video': 'video',
  // Poly cable rename.
  polyPitchGate: 'poly',
};

/** Map a (possibly legacy) cable-type string onto its post-collapse name. */
export function migrateCableType(type: CableType): CableType {
  return CABLE_TYPE_MIGRATION[type as string] ?? type;
}

/** True if `type` is the (single, post-collapse) video-domain cable type. */
export function isVideoCableType(type: CableType): boolean {
  // Tolerate legacy strings so callers passing an un-migrated stored type
  // still classify correctly during the load-migration window.
  return migrateCableType(type) === 'video';
}

/**
 * Returns true if a cable of `srcType` may legally terminate on a port
 * declaring `dstType`. Both sides are migrated to the 4-type vocabulary
 * first so legacy/stored strings still validate. Rules:
 *
 *   * Equal types always pass (cv↔cv covers the former pitch/gate/cv
 *     cross-patches — a SEQUENCER pitch into a filter cutoff, an LFO into a
 *     pitch input, a gate into an ADSR — all `cv` now, all legal).
 *   * poly ↔ cv: the engine interposes a splitter (poly→mono picks channel 0)
 *     or merger (mono→poly fills channel 0, rest silent) via resolveConnection
 *     in poly.ts — mirrored permissively here.
 *   * cv → video param input (frame-rate sample-and-hold cross-domain bridge).
 *   * modsignal TARGET accepts cv OR audio (see below).
 *
 * Strictly out: audio → any non-audio port (except modsignal); video → any
 * audio/cv port (a 0/5V-style level landing on an audio bus is the click
 * track the limiter shouldn't have to defend against).
 */
export function canConnect(srcType: CableType, dstType: CableType): boolean {
  const src = migrateCableType(srcType);
  const dst = migrateCableType(dstType);
  if (src === dst) return true;

  // poly ↔ cv. Splitter / merger interposed by the engine's resolveConnection
  // (poly.ts). poly→cv picks voice-0 pitch; cv→poly fills voice-0.
  if (src === 'poly' && dst === 'cv') return true;
  if (src === 'cv' && dst === 'poly') return true;

  // cv → video param input (frame-rate sample-and-hold cross-domain bridge).
  if (src === 'cv' && dst === 'video') return true;

  // modsignal MODULATION input (TOYBOX's 6-input section) accepts a cv OR audio
  // source. This is the ONLY place audio→(non-audio) is permitted: it is scoped
  // to the `modsignal` TARGET type, so audio→cv stays rejected everywhere else.
  // The cross-domain bridge envelope-follows an audio source to a 0..1
  // modulation value (engine.ts → tickCvBridges); cv sample-and-holds as usual.
  // (Former `gate` sources are now `cv`, still accepted.)
  if (dst === 'modsignal') {
    return src === 'cv' || src === 'audio';
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
   * but should accept `cv` (which now subsumes the former pitch/gate types) for
   * visualizing LFOs, envelopes, pitch CV and gates — a visualizer is not a
   * master bus, so the "CV on an audio bus → DC/click" guard canConnect
   * enforces globally doesn't apply. See canConnectToPort(). Honoured by the
   * drag-connect validator
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
   * the cable TYPE is `cv` (gate/trigger ports fold into the cv channel after
   * the 9→4 cable collapse), so it stays cross-patchable with any other cv —
   * it's just CV. `edge` is the SEPARATE, surviving declaration of how a port
   * INTERPRETS that cv: it is what distinguishes a trigger from a gate now that
   * both share the `cv` cable type. It also keys the gate→MIDI-learn affordance
   * (PatchPanel) and lets a card show a ▷ (trigger) / ▭ (gate) glyph:
   *   - 'trigger' → fires ONCE per rising edge (clock / reset / strike / sync /
   *                 start-stop / sample); ignores how long the level stays high.
   *                 MUST be edge-detected (shared createEdgeCounter or a
   *                 per-sample worklet edge-detect) — never level-sampled.
   *   - 'gate'    → acts WHILE the level is high + reacts to both edges (an
   *                 ADSR sustain, a VCA hold, a poly note-on/off). Do NOT
   *                 convert a gate consumer to edge-only.
   * Declared on `cv`-typed gate/trigger ports (inputs primarily; an output may
   * carry it to drive the cosmetic glyph + emitted waveform shape).
   * (Literal union mirrors EdgeSemantic in $lib/audio/gate-trigger — inlined
   * here to keep the foundational graph layer free of an audio-layer import.)
   */
  edge?: 'trigger' | 'gate';
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
