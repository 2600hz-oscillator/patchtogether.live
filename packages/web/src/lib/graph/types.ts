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
  /**
   * Where the CV sweep is CENTRED — i.e. the value cv=0 maps to.
   *   - `'param'` (default, omitted): the param's CURRENT stored value (the
   *     "knob"). This is the bias-knob metaphor — you set a base and an LFO
   *     wobbles AROUND it (camera zoom, a mix bias, etc.). Existing behavior.
   *   - `'default'`: the param's `defaultValue`, IGNORING any stored value.
   *     Use for ABSOLUTE-POSITION params where a patched cable should track the
   *     input DIRECTLY (a joystick's X/Y): a cabled value is the position, not a
   *     bias on top of one. This makes "patched ⇒ matches input" hold and stops
   *     a stale saved position (a moment-in-time pad drag captured in the patch)
   *     from applying a permanent offset to a cable-driven value. Honoured by
   *     BOTH cross-domain scaling paths — `cv-scale.ts` (audio) and
   *     `cv-bridge-map.ts` (video). See QUADRALOGICAL pos_x/pos_y.
   */
  center?: 'param' | 'default';
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

// ---------------- Living docs (contract-pinned documentation) ----------------

/**
 * A family of DYNAMIC, DOM-only controls that are NOT individual ParamDefs —
 * the per-step grids and transport clusters a card renders from a count (e.g.
 * the sequencer's step gates `seq-gate-{n}`, quicksave slots). Declared on the
 * def so the docs layer + the deterministic contract signature can SEE them
 * (they otherwise exist only in card markup). A unit guard greps the card
 * source for `testidPrefix`, so a declared family can't drift off the card and
 * a card family with no declaration fails. PRESENCE-ONLY: the grep proves the
 * prefix exists, not that the member COUNT is right (a later DOM-scan oracle
 * verifies size). See $lib/docs/contract-signature.
 */
export interface ControlFamily {
  /** Stable family key, e.g. 'seq-gate'. The card emits each member as
   *  `${testidPrefix}-${nodeId}-${i}` (or `${testidPrefix}-${i}`). */
  id: string;
  /** Human family label for docs, e.g. 'Step gates'. */
  label: string;
  /** What kind of family this is (for doc rendering + the signature). */
  kind: 'step-grid' | 'transport' | 'quicksave' | 'cell' | 'other';
  /** The `data-testid` prefix the card emits for each member of the family. */
  testidPrefix: string;
  /** Optional param id whose value drives the member COUNT (e.g. 'length'). */
  countParam?: string;
}

/**
 * Co-located AUTHORED documentation for a module — the prose tier of the
 * living-docs system. Lives ON the def so a port/param change and its doc
 * edit land in the SAME PR diff. The GENERATED I/O reference (cable types,
 * ranges, cv/edge sentences) is NOT here — it is derived from PortDef/ParamDef
 * by io-explain. Every key here is drift-checked: a `ports`/`controls` key
 * naming a non-existent port/control fails the docs gate (orphan-rot guard),
 * and any port/param/cable identifier MENTIONED in the prose must resolve
 * against the live registry (no-unknown-identifier fact-check). AI drafts this
 * tier; deterministic tooling fact-checks it.
 */
export interface ModuleDocs {
  /** The behavioral overview — what the module does + its mental model. */
  explanation?: string;
  /** Per-INPUT-port behavioral prose, keyed by input PortDef.id. (Separate
   *  from `outputs` because a module may carry the SAME id as both an input
   *  and an output — e.g. a clock thru — which a single id-keyed map can't
   *  hold.) */
  inputs?: Record<string, string>;
  /** Per-OUTPUT-port behavioral prose, keyed by output PortDef.id. */
  outputs?: Record<string, string>;
  /** Per-control behavioral prose. Keys are param ids (the `control-<id>`
   *  convention without the prefix — just the paramId), control-family
   *  templates (`<familyId>-{n}`, interpolated per member), or stable control
   *  keys for one-off card buttons. */
  controls?: Record<string, string>;
}

/**
 * One DOCK page (section/tab) of a module's full faceplate — a named group of
 * controls surfaced together when the module opens its sectioned dock view
 * (the DX7 GLOBAL + OP1-6 pattern). Every `controls` key MUST also appear in
 * `ModuleFace.order` (the dock renders the ranked roster grouped into pages).
 */
export interface ModuleFacePage {
  /** Stable page id (e.g. 'global', 'op1'). */
  id: string;
  /** Human tab label (e.g. 'GLOBAL', 'OP 1'). */
  label: string;
  /** Control keys on this page, in display order — a subset of `order`. Keys
   *  use the same unified control-key space as `order` (see ModuleFace). */
  controls: readonly string[];
}

/**
 * PER-MODULE UI CURATION — the priority ranking that drives the workflow-mode
 * ModuleShell's semantic-zoom (STRATA) tiers and its sectioned dock faceplate.
 * Co-located on the def like `docs` so a control change and its curation edit
 * land in the SAME PR diff (see .myrobots/plans workflow-mode UI refactor §3.6).
 *
 * This is UI METADATA, NOT part of the I/O contract: `face` is deliberately kept
 * OUT of contract-signature.ts / contract-lock.txt (a re-ranking is not a
 * contract change). It has its OWN drift gate — module-face-lint.test.ts —
 * mirroring the living-docs ratchet (consistency for every faced module,
 * completeness for the STRICT_FACES set).
 *
 * KEYS use the SAME unified control-key space the docs system defines
 * (control-doc-resolver.ts): each entry is one of
 *   - a `ParamDef.id`                    (a Knob/Fader-backed param), or
 *   - a control-family TEMPLATE `<familyId>-{n}`  (one entry per declared
 *     ControlFamily — the step grid / transport cluster as a whole), or
 *   - a STATIC control key (a card-only `<select>`/`<button>`, keyed by the
 *     numbered-legend staticKey — the nodeId-stripped test id).
 *
 * The pure `curatedFace(def, tier)` selector ($lib/ui/workflow/curated-face)
 * resolves each key to a control descriptor and returns the top-N for a tier
 * (mini=1 / compact=3 / full-in-lane=8 / dock=all + pages).
 *
 * HASH-TRANSPARENCY (video defs): VIDEO module defs live in the WebGL attest
 * basis, so a `face` block on a VideoModuleDef MUST be wrapped in
 * `// docs-hash-ignore:start … :end` markers (exactly like its co-located
 * `docs`) so authoring curation stays a no-op for the GPU attest hash. Audio
 * defs are NOT in the WebGL basis and need no markers. (P1 authoring note; no
 * video def carries a `face` yet.)
 */
export interface ModuleFace {
  /** The priority RANKING — earliest = highest priority. Keys are param ids,
   *  control-family templates (`<familyId>-{n}`), or static control keys (see
   *  the key-space note above). The load-bearing artifact: only `order` can
   *  rank NON-param controls (a preset selector, a toggle button). */
  order: readonly string[];
  /** Optional DOCK sections/tabs for a big instrument's full faceplate. Each
   *  page's `controls` must be a subset of `order`. Omitted = single-page dock. */
  pages?: readonly ModuleFacePage[];
  /** The compact live-glyph kind the shell renders in the tile's glyph slot.
   *  Omitted / 'none' = no glyph. */
  glyph?: 'scope' | 'meter' | 'envelope' | 'waveform' | 'none';
}

/**
 * OPTIONAL per-module CHAIN-WIRING override (workflow channel-columns feature,
 * owner "fixable in code" directive). Declared on a module def; the
 * workflow-column resolvers (resolveMainAudioIn / resolveMainAudioOut in
 * patch-convenience.ts) consult it BEFORE their default port-shape resolution,
 * so a module whose naive main-in/out is wrong for the vertical DSP chain is
 * corrected by editing its DEF — never by special-casing the wiring engine.
 * Every field optional; default (no override) = the resolved main in/out.
 *   - role:     'source' | 'dsp' | 'both' — declared chain role (default:
 *               inferred from whether it has a main out and/or a main in).
 *               PLUS 'noteSink' — a module a clip lane can DRIVE (see laneTap).
 *   - inPorts:  [L, R] stereo insert input, or [mono]. Overrides main-in.
 *   - outPorts: [L, R] or [mono]. Overrides main-out.
 *   - laneTap:  present only for `role: 'noteSink'`. Names the input ports the
 *               column reconciler taps a lane's pitch / gate / velocity CV into
 *               (Part B of CV Buddy). A noteSink has no main audio-out, so it is
 *               never an island/mixer member — the tap is purely additive note
 *               CV. Carried by cvBuddy + midiOutBuddy.
 *   - returnsAudio: present only for `role: 'noteSink'`. Marks a note-sink that
 *               ALSO has a hardware AUDIO RETURN (CV Buddy's ES-9 input pair) —
 *               so its return audio is the lane's HEAD SOURCE. Such a member is a
 *               head CANDIDATE (participates in one-source-head resolution) even
 *               though it has no audio-typed port; the reconciler wires the return
 *               pair (from the ES-9 node) at the chain root when it is the head.
 *               cvBuddy sets it; midiOutBuddy (no modelled return) does NOT — it
 *               is a pure tap, never a lane head.
 * Example: TWOTRACKS declares inPorts = its reel-A audio input, outPorts = its
 * A-side mixed output — not the naive first-L/R-token guess across its 4 audio
 * inputs.
 */
export interface ChainWiring {
  role?: 'source' | 'dsp' | 'both' | 'noteSink';
  inPorts?: readonly [string, string] | readonly [string];
  outPorts?: readonly [string, string] | readonly [string];
  /**
   * Lane note-tap port map — present iff `role: 'noteSink'`. The reconciler
   * wires the clip lane's pitch/gate/velocity CV into these input port ids.
   */
  laneTap?: {
    /** Input port id the lane's pitch CV wires into. */
    pitchIn: string;
    /** Input port id the lane's gate wires into. */
    gateIn: string;
    /** Input port id the lane's velocity CV wires into. */
    velIn: string;
  };
  /** Note-sink with a hardware audio return (CV Buddy ↔ ES-9). Makes it a lane
   *  head-source candidate; the reconciler wires its ES-9 return pair at the
   *  chain root when it resolves as the column head. */
  returnsAudio?: boolean;
}

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
   *   - `pinned?: boolean` — workflow-mode always-on singleton (the M/E/C
   *     bottom-drawer trio, graph/workflow-pins.ts). Pinned nodes render only
   *     in their dock drawer (never as canvas cards), are refused by the
   *     delete path (`removePatchNode`, mutate.ts) and skipped by Clear, and
   *     are excluded from `maxInstances` counting (cap.ts) + the singleton
   *     cleanup pass. Never set in dawless racks.
   *   - `hiddenCard?: boolean` — workflow-mode HEADLESS instance
   *     (graph/hidden-card.ts; the P4 camera manager's mapped cameras).
   *     Presentation-only: renders no canvas card (its face is a topbar
   *     menu) but is otherwise an ordinary node — user-deletable via the
   *     standard remove path and COUNTED toward `maxInstances`. Never set
   *     in dawless racks.
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
  /**
   * Module-grouping Phase 3A: when set, this module renders an on-card
   * visualization (typically a <canvas>) that can be portaled into the
   * parent GroupCard. See AudioModuleDef.vizPassthrough for the canonical
   * doc. Mirrored here so callers that read the loose ModuleDef shape
   * (e.g. defLookup helpers in Canvas.svelte) can read the flag without
   * downcasting to a domain-specific def.
   */
  vizPassthrough?: boolean;
  /** Optional workflow channel-columns chain-wiring override — see ChainWiring.
   *  Mirrored on the loose ModuleDef shape so defLookup callers read it without
   *  downcasting to a domain def. */
  chainWiring?: ChainWiring;
}
