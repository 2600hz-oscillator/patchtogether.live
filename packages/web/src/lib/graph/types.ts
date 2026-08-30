// packages/web/src/lib/graph/types.ts
//
// Patch graph data model. Per D8 the patch graph lives in a Yjs doc accessed
// through SyncedStore. Per D18 the type system is registry-based, not closed,
// so future visual modules can register new domains and cable types without
// touching this file's union members.
//
// ⚠ This file is the BOTTOM of the import graph — it must never reach up into
// `ui/`. `./signal-lattice` is a pure leaf with no imports of its own, which is
// why the video widening rule was moved into `graph/` (#1780) rather than
// imported from the drop modal that first expressed it.
import { isVideoShape, videoWidensTo } from './signal-lattice';

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
// and for the architecture.
//
// Video-domain cable types (Phase 0):
//   keys       — single-channel still mono image (no time axis)
//   image      — RGB still image (no time axis)
//   mono-video — single-channel animated video stream
//   video      — RGB animated video stream
// Implicit upcasting is allowed wherever it is FREE at the shader layer —
// broadcasting one channel to three, or holding one frame over time. The four
// names above are two independent boolean axes (channels × motion), so the rule
// is the PRODUCT ORDER over those axes rather than a list of legal pairs: see
// `videoWidensTo` in ./signal-lattice.ts, which `canConnect` calls directly.
//
//   modsignal  — a permissive MODULATION input that accepts EITHER a CV-family
//                (cv / pitch / gate) OR an audio source. Used by TOYBOX's 6-input
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

/** True if `type` is one of the video-domain cable types.
 *
 *  DERIVED from the lattice (`VIDEO_SHAPE`), not re-listed here: a video type
 *  that had a row there but not here — or the reverse — is precisely the
 *  two-lists-one-question defect #1780 removed from `canConnect`. Registering a
 *  fifth video type means giving it two ranks in ONE place. */
export function isVideoCableType(type: CableType): boolean {
  return isVideoShape(type as string);
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
 *   * Video-domain "free" conversions — DERIVED, not listed: `videoWidensTo`
 *     (./signal-lattice.ts) is the product order over the (channels, motion)
 *     axes, so every widening that is free at the shader layer passes and
 *     every reduction is refused, with no edge table to close by hand.
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

  // VIDEO ↔ VIDEO — the WIDENING clause, derived from the lattice.
  //
  // This used to be a hand-written edge table (keys→mono-video, keys→image,
  // image→video, mono-video→video) which a human had to keep transitively
  // closed, and did not: `keys → video` was refused although it is legal in two
  // hops and free at the shader layer (#1780). `videoWidensTo` is the PRODUCT
  // ORDER over the (channels, motion) axes, so it is closed by construction and
  // there is no diagonal left to forget. It returns the whole answer for a
  // video→video pair — nothing below this line can widen one — so this branch
  // is the decision, not another allow-list.
  if (isVideoShape(srcType as string) && isVideoShape(dstType as string)) {
    return videoWidensTo(srcType as string, dstType as string);
  }

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

  // modsignal MODULATION input (TOYBOX's + GIBRIBBON's modulation sections)
  // accepts the CV FAMILY or an audio source. This is the ONLY place
  // audio→(non-audio) is permitted: it is scoped to the `modsignal` TARGET
  // type, so audio→cv / audio→pitch etc. stay rejected everywhere else. The
  // cross-domain bridge envelope-follows an audio source to a 0..1 modulation
  // value (engine.ts → tickCvBridges); the CV family sample-and-holds as usual.
  // (modsignal→modsignal is covered by the equal-type check above; no source
  // ever emits `modsignal`.) `polyPitchGate` stays OUT — it is an ADAPTER (the
  // engine interposes a splitter), not a member of the family.
  if (dstType === 'modsignal') {
    // The CV FAMILY (cv / pitch / gate) — read off CV_FAMILY rather than
    // re-listed, which is what let `pitch` fall out of the set in the first
    // place (#1780 finding 5). All three are the same bipolar audio-rate
    // voltage on the same plumbing; a V/oct source into a modulation input is
    // an ordinary keytracking patch. The consumer agrees: AudioEngine.addEdge
    // routes a `pitch` source through the SAME sample-and-hold cv bridge, and
    // VideoEngine.addCvBridge envelope-follows ONLY an `audio` source, so pitch
    // takes the cv tail-sample path with no new code.
    return CV_FAMILY.has(srcType as string) || srcType === 'audio';
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
 * CV-input scaling hint (see docs/adr/004-cv-range-convention.md).
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
  /**
   * Optional DISPLAY label for this jack — the ONE place a port's human name is
   * authored, co-located with the port like `face`/`docs` are co-located with
   * the def. Both label consumers already honour it: the front/rear PatchPanel
   * via `resolveVerboseLabel` ($lib/ui/patch-panel-labels — an explicit label is
   * used verbatim, uppercased) and the rear card via `rearHoleLabel`
   * ($lib/ui/workflow/rear-card-model). Omitted = derive from the id, which is
   * what every port does today.
   *
   * COSMETIC, exactly like `ParamDef.label`: `portLine` (contract-signature.ts)
   * has no label branch, so declaring one is CONTRACT-TRANSPARENT — it moves no
   * line in contract-lock.txt. Use it when id-derivation reads wrong (a stem
   * that is not a word, a jack whose function differs from its id), NOT to
   * restate what the derivation already produces.
   *
   * ⚠ HASH-TRANSPARENCY: a VIDEO def's ports live in the WebGL attest basis,
   * and a `label` is NOT one of the hash-transparent properties
   * (`docs`/`controlFamilies`/`face` — see scripts/attest-code-basis.ts), so
   * adding one DOES move the WebGL hash. That is intended: a label is part of
   * the port contract. Batch label edits with a real contract change rather
   * than spending a GPU re-attest on prose.
   */
  label?: string;
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

/**
 * ONE NAMED DETENT of a DISCRETE param (PF-1) — the `mode 0/1/2` → `LP/HP/BP`
 * mapping the legacy cards hardcoded in their own markup and the migrated
 * shell had no way to see, so a filter's type read as a rotary printing
 * "0.00".
 *
 * UI VOCABULARY, NOT CONTRACT — exactly like `ParamDef.label` (see the
 * precedent stated verbatim on `delay.ts`'s params). `contract-signature.ts`'s
 * whitelisted projection reads only `id/min/max/curve/defaultValue/units`, so
 * naming a value cannot move `contract-lock.txt`: the value→meaning mapping is
 * DSP, and it is already pinned by `min`/`max`/`curve`. Renaming `LP` → `Lowpass`
 * is the same class of edit as renaming a label.
 *
 * DISTINCT FROM `landmarks` — see ParamLandmark. `options` says the param has
 * N states and NOTHING in between; `landmarks` says the param is continuous and
 * these are the named waypoints. Enforced, not merely documented:
 * param-vocabulary.test.ts requires `curve: 'discrete'` for a param with
 * `options` and rejects a def carrying both.
 */
export interface ParamOption {
  /** The param value this detent selects. Must lie within [min,max]. */
  value: number;
  /** Short shown text (a Segmented button caption / a Selector row). */
  label: string;
  /** Optional long-form hover title explaining what the state DOES. */
  title?: string;
}

/**
 * A NAMED WAYPOINT on a CONTINUOUS param (PF-10) — a tick mark plus a
 * nearest-landmark readout, for a param that MORPHS through its range rather
 * than switching between states (qbrt `mode`, lfo `shape`: both `curve:
 * 'linear'` over a 0..N span whose integers name recognisable shapes, with
 * genuinely useful blends in between).
 *
 * NEVER interchangeable with `options`: rendering a morph as a Segmented would
 * LIE by hiding the in-between blends, and rendering a discrete switch as a
 * landmarked knob would ask for a 200 px drag to change one of three states.
 * The `curve` field is what tells them apart, and the vocabulary gate enforces
 * it. Cosmetic in the same sense as `options` — never in the contract.
 */
export interface ParamLandmark {
  /** Where the tick sits, in param units. Must lie within [min,max]. */
  value: number;
  /** Short shown text for the readout when the value is nearest this tick. */
  label: string;
}

export interface ParamDef {
  id: string;
  label: string;
  defaultValue: number;
  min: number;
  max: number;
  curve: KnobCurve;
  units?: string;
  /** PF-1 — named detents of a DISCRETE param. Cosmetic (see ParamOption). */
  options?: readonly ParamOption[];
  /**
   * THE ROSTER **IS** THE LEGAL SET — a SPARSE `options` roster, declared.
   *
   * ⚠ NOT COSMETIC, unlike `options` itself, and that is the whole reason it is
   * a separate declaration rather than an inference from "the roster is short".
   * The ordinary rule is that a discrete param's reachable values are exactly
   * its integer steps, so `param-vocabulary` requires a roster to name EVERY
   * one of them — its stated reason being that *"a roster that skips one leaves
   * a state the dial can reach and the picker cannot name"*.
   *
   * A few params invert that premise: the skipped values are precisely the ones
   * that must NOT be reachable. `cvBuddy.ppqn` is the case this exists for — a
   * clock divides by 1, 2, 4, 8, 12, 24 or 48 pulses per quarter note, and the
   * forty-one integers in between are not "unnamed states", they are values the
   * module has no meaning for. Declaring the roster EXHAUSTIVE says so, and the
   * gate then enforces the stronger property the ordinary rule was reaching
   * for: **no reachable state is unnameable** — because the reachable set is
   * the roster.
   *
   * ⚠ DENY BY DEFAULT, AND THE `why` IS THE POINT. Making this a bare boolean
   * would let any author quietly opt out of the every-step rule the moment it
   * inconveniences them, which is the rule's whole value. A required `why`
   * means `tsc` refuses the casually-sparse roster before a test runs, and the
   * reviewer sees the ARGUMENT next to the exemption. Say why the gaps are
   * meaningless, not that they are unused.
   *
   * WHAT IT DOES NOT DO: it does not make the value safe on its own. A param
   * declaring this must SNAP — a write of an off-roster value lands on a named
   * member — and `param-vocabulary` asserts that in both directions (a legal
   * value passes through EXACT; an illegal one lands on a member). See
   * `snapToOptions`, which is the one implementation.
   *
   * ⚠ A STORED off-roster value from before the declaration is NOT rewritten
   * behind the user's back. It DISPLAYS as its nearest legal member (the same
   * `nearestByValue` every readout already uses) and is normalized in the graph
   * by the first ordinary, tagged, undoable write. A silent engine-side repair
   * of a data-integrity bug is indistinguishable from no bug — the rule
   * `momentary-params` states and this follows.
   */
  optionsExhaustive?: {
    /** Why the values BETWEEN the roster entries are meaningless for this
     *  param — not merely unused. Prose, reviewed, required by the type. */
    why: string;
  };
  /** PF-10 — named waypoints of a CONTINUOUS param. Cosmetic (see ParamLandmark). */
  landmarks?: readonly ParamLandmark[];
  /**
   * PF-3 — a bespoke value formatter for the knob's readout, when neither the
   * raw number nor `units` says what the value MEANS (a 0..1 that is really a
   * ratio, a normalized index that is really a note name). PURE and total: it
   * is called on every animation frame while a value moves, so it must not
   * allocate heavily or throw.
   *
   * Cosmetic like the rest of this vocabulary. It is a FUNCTION, so it is
   * structurally unserializable — which is the second, independent reason it
   * can never reach the contract projection (that projection emits text).
   */
  format?: (v: number) => string;
}

export type ParamSchema = Readonly<ParamDef[]>;

// ── PARAMS WITH NO USER CONTROL (#1726) ─────────────────────────────────────
//
// Some `ParamDef`s exist so the graph has somewhere to WRITE, not so a player
// has something to TURN: the synthetic gate params a `paramTarget` CV bridge
// pushes raw 0..1 swings into, and the determinism toggles a VRT capture flips.
// `backdraft` has seven. Until now this was said only in PROSE — six separate
// `// hidden — no card knob` comments on the def, which every gate is blind to
// — so the shell's face rules had no way to know, and would have demanded an
// interactive rotary over a raw gate swing for each of them (they all declare
// `curve: 'linear'`, so `looksLikeToggle` cannot even see them as switches).
//
// THIS IS A DECLARATION, NOT AN EXEMPTION LIST. The distinction is enforced by
// shape, not by discipline:
//
//   * `why` is REQUIRED BY THE TYPE, so `tsc` refuses the undeclared form
//     before any test runs, and there is no "just this once" spelling.
//   * `writer` is ANCHORED TO THE DEF'S OWN PORTS IN BOTH DIRECTIONS —
//     'cv-port' asserts a port targeting the param EXISTS, 'internal' asserts
//     one does NOT. Neither arm is unfalsifiable: rename the port and the
//     'cv-port' entry reddens; ADD a port and the 'internal' entry reddens and
//     gets re-read by whoever added it.
//   * `param` must name a live `ParamDef` of the same def, so an entry that
//     outlives its subject is RED rather than quietly inert.
//
// It lives on the DEF, not on `face`, for two reasons. It is true of the
// LEGACY card too (that is what the def's own comments were already saying),
// and `face` is unreachable for exactly the modules that need this: authoring a
// `face` IS promotion to STRICT_FACES, so a `face`-nested field could not have
// been adopted by anything without also building that module a full faceplate.
// Like `face`, it is hash-transparent (HASH_TRANSPARENT_PROPS in
// scripts/attest-code-basis.ts): it is UI curation and reaches no GPU / audio /
// relay code, so a video def in the WebGL attest basis can declare it for free.

/** One param this module deliberately gives the player no control over. */
export interface NoUserControlParam {
  /** The `ParamDef.id`. Must name a live param of THIS def — anchored. */
  param: string;
  /**
   * WHO writes it instead, checked against the def's OWN ports:
   *   'cv-port'  — an input `PortDef` declares `paramTarget: <param>`. The
   *                usual case: a gate/clock bridge writing a raw swing the
   *                module edge-detects.
   *   'internal' — NOTHING on the patch surface targets it (a determinism or
   *                harness toggle). Asserted to have no such port, so the day
   *                one is added this entry stops being true and says so.
   */
  writer: 'cv-port' | 'internal';
  /** WHY a player never sets it, naming what does instead. Required by the
   *  type; the lint additionally refuses a one-word placeholder. */
  why: string;
}

/** The def shape the no-user-control helpers read. Structural, so audio, video
 *  and meta defs all satisfy it without a common base class. */
export interface NoUserControlDefLike {
  type?: string;
  params?: readonly ParamDef[];
  inputs?: readonly PortDef[];
  noUserControl?: readonly NoUserControlParam[];
}

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
  /**
   * PF-20 — the band header's DESCRIPTION line ("depth sine · mono"). A band
   * label names the group; the hint says what the group IS, which is the
   * difference between a faceplate and a wall of knobs. DOCK-ONLY (a 192px
   * lane tile has no room), and never rendered on a TABBED face — there the
   * rail already names the band and the hint would print twice.
   */
  hint?: string;
  /** Control keys on this page, in display order — a subset of `order`. Keys
   *  use the same unified control-key space as `order` (see ModuleFace). */
  controls: readonly string[];
  /**
   * Optional SUB-HEADERS inside the band — the exact mirror of
   * `ModuleFaceRear.clusters`, on the front. Each cluster names a SUBSET of
   * this page's own `controls`; the shell PULLS those cells out of the band's
   * flat control row into a labeled sub-group, in declaration order, leaving
   * the un-clustered cells to render first.
   *
   * WHY THIS AND NOT ANOTHER PAGE: a page costs a ~81 px band (its own top
   * rule + header + row), so splitting a group of related knobs off "just to
   * label them" is a real vertical-space purchase on a dock that folds at
   * 720p. A cluster costs a ~14 px sub-header. Reach for a PAGE when the
   * controls are a different IDEA; reach for a CLUSTER when they are the same
   * idea, twice (a filter EG next to an amp EG).
   *
   * MEMBERSHIP STAYS IN `controls`: a cluster is a grouping HINT over keys the
   * page already claims, never a second place to add controls. That is what
   * keeps `face.order` completeness + the dock render-plan parity gate
   * (module-face-lint) reading exactly one membership list.
   */
  clusters?: readonly { label: string; controls: readonly string[] }[];
  /**
   * HOW THIS BAND'S CLUSTERS FLOW. `'stack'` (the default, and what every band
   * did before this field existed) puts each cluster on its own row; `'row'`
   * sets them side by side and wraps.
   *
   * ⚠ IT IS A PER-BAND DECLARATION, NOT A PLATFORM RULE, and the difference is
   * measured. `dock-row-plan` packs whole BANDS onto a row from their cell
   * count alone, and doing the same to clusters would reflow every faced module
   * that declares them (adsr, analogVco, bluebox, charlottesEchos, cofefve,
   * cube, karplus, kickdrum, pentemelodica, sixstrum, snaredrum, tidyVco …) for
   * one face's owner review. It is also not always right: stacking is what
   * makes a CONSOLE GRID work — mixmstrs' `channels` band aligns column N of
   * `level` / `low` / `mid` / `high` because the four clusters sit one under
   * the other, and side-by-side would destroy exactly the alignment owner
   * review of #1738 asked for.
   *
   * So the module says which shape its band is. `'row'` is for clusters that
   * are PEERS wide enough to sit together and narrow enough to fit — mixmstrs'
   * two RETURN strips (owner, 2026-08-17: *"return 1 and return 2 can sit next
   * to each other, too, saving on vertical space and reducing unused horizontal
   * space"*) — and it turns the CONSOLE GRID off for that band, because a
   * shared column ruler and a side-by-side flow are contradictory requests.
   *
   * UI metadata like the rest of `face`: OUT of contract-signature /
   * contract-lock, linted by module-face-lint.test.ts (a band declaring `'row'`
   * must actually HAVE clusters, or the declaration is a silent no-op).
   */
  clusterFlow?: 'stack' | 'row';
}

/**
 * PER-MODULE UI CURATION — the priority ranking that drives the workflow-mode
 * ModuleShell's semantic-zoom (STRATA) tiers and its sectioned dock faceplate.
 * Co-located on the def like `docs` so a control change and its curation edit
 * land in the SAME PR diff (see .myrobots/plans workflow-mode UI refactor §3.6).
 *
 * This is UI METADATA, not I/O, so MOST of `face` is deliberately kept out of
 * contract-signature.ts / contract-lock.txt — a re-ranking is not a contract
 * change. It has its own drift gate, module-face-lint.test.ts, mirroring the
 * living-docs ratchet (consistency for every faced module, completeness for
 * the STRICT_FACES set).
 *
 * ⚠ WHICH FIELDS PROJECT IS DECIDED FIELD BY FIELD, NOT BY THIS PARAGRAPH.
 * `sidebar` used to be the one projected field, for a reason worth keeping now
 * that the field itself is gone: #1468 deleted a whole sidebar block from
 * twelve modules and `task docs:accept` produced an EMPTY DIFF — because "is it
 * I/O?" was the wrong question. The right one is "if this vanished, is there
 * any review surface on which a human would see it?" Ask that of every new
 * field.
 *
 * So the decision is made field by field and enforced:
 * `FACE_FIELDS_NOT_IN_LOCK` (contract-signature.ts) names every unprojected
 * field with a `why` and the gate that DOES cover it, and contract-lock.test.ts
 * walks the keys live defs actually declare — a key that is neither projected
 * nor named is RED, and a name with no field behind it is red too. Adding a
 * field here means writing that decision down.
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
 * (mini=1 / compact=2 with a glyph or 3 without / full-in-lane=8 / dock=all +
 * pages). The compact number comes from `faceTierCap`, which reconciles the
 * ladder with laneBodyPlan's whole-cell fit so the SELECTED and the RENDERED
 * counts are the same number.
 *
 * HASH-TRANSPARENCY (video defs): VIDEO module defs live in the WebGL attest
 * basis, but `face` is hash-transparent BY CONSTRUCTION — the shared attest
 * normalizer (scripts/attest-code-basis.ts) strips `docs`/`controlFamilies`/
 * `face` off a module-scope def object before hashing, so authoring curation is
 * a no-op for the GPU attest with nothing to remember. (P1 authoring note; no
 * video def carries a `face` yet.)
 */
/**
 * ONE declared 2-D pad: the two params its axes drive (see
 * `ModuleFace.xyPads`). Both ids are REQUIRED — that is the type-level half of
 * the pairing, and it is why this is an interface rather than a map entry.
 */
export interface FaceXyPad {
  /** The param the HORIZONTAL axis drives. ANCHORS the cell: the pad renders at
   *  this key's rank in `face.order`. */
  x: string;
  /** The param the VERTICAL axis drives (drag UP = larger, the joystick
   *  convention `XyPad.svelte` already implements). Folded into the x cell —
   *  it never renders a cell of its own. */
  y: string;
  /** Caption under the pad. Omitted = the two params' own labels. */
  label?: string;
  /**
   * WHICH SURFACE paints this pad's ONE cell at the DOCK.
   *
   *   'band' (default) — the shell's generic `XyPad` renders in a band, at the
   *                      `x` key's rank. Every pad shipped before this field.
   *   'body'           — the module's OWN `fullViewBody` paints it, and the
   *                      dock bands render NO cell for either axis.
   *
   * ⚠ IT IS A DOCK-ONLY DISTINCTION, AND THE REASON IS NOT THE ONE THE FIRST
   * DRAFT OF THIS COMMENT GAVE. It said the lane must keep the generic pad or a
   * pad-only module would resolve to zero controls; that premise is FALSE, and
   * `quadralogical-face-model.test.ts` corrected it. `laneOrder`
   * (`curated-face.ts:131-143`) ALREADY makes every declared pad's anchor
   * dock-only, for a measured reason that predates this field: a pad is square
   * and a lane knob column is 46 px, so squeezing it there keeps the gesture
   * and loses the precision. So NO lane tier has ever painted a pad, and this
   * field cannot change that.
   *
   * What it changes is WHICH DOCK SURFACE paints it — a band cell, or the
   * module's own body. `extBody` is gated to the dock by
   * `dockFullViewHeadPlan`, so 'body' is only meaningful there, and the lane is
   * untouched because the pad was never in it.
   *
   * ⚠ THE #1974 REFUSAL IS A SEPARATE QUESTION AND THIS FIELD DOES NOT ANSWER
   * IT. `joystick` is refused because a pad is its ONLY control, so the lane
   * resolves to ZERO controls whatever any face declares. A module adopting
   * `'body'` must still have something else to show in the lane; if it does
   * not, the answer is to not promote it.
   *
   * ⚠ AND IT IS A CLAIM THE GATES CHECK IN BOTH DIRECTIONS, not a hint.
   * `module-face-lint` INVERTS its render-parity assertion for a `'body'`
   * pad's two axes — they must render EXACTLY ZERO dock cells where every
   * other param must render exactly one — the same falsifiable shape
   * `noUserControl` uses. And `face-xy-body-source.test.ts` requires the
   * declaring face to own a `fullViewBody` whose source really emits
   * `data-control-params` naming both axes, so "the body paints it" cannot be
   * satisfied by a body that does not.
   *
   * WHY A PER-PAD ENUM rather than a general "these params live in the body"
   * list: a 2-D pad is the only control the shell paints that a module could
   * plausibly need to own — it is the one primitive whose picture and whose
   * gesture can be the SAME surface as a module's own render (QUADRALOGICAL's
   * joystick sits over live previews of the four inputs it is mixing). A
   * general escape hatch would be reached for by the next module that merely
   * wants a bigger knob.
   *
   * UI metadata like the rest of `face`: OUT of contract-signature /
   * contract-lock (choosing a surface is not an I/O change).
   */
  surface?: 'band' | 'body';
}

export interface ModuleFace {
  /** The priority RANKING — earliest = highest priority. Keys are param ids,
   *  control-family templates (`<familyId>-{n}`), or static control keys (see
   *  the key-space note above). The load-bearing artifact: only `order` can
   *  rank NON-param controls (a preset selector, a toggle button). */
  order: readonly string[];
  /** Optional DOCK sections/tabs for a big instrument's full faceplate. Each
   *  page's `controls` must be a subset of `order`. Omitted = single-page dock. */
  pages?: readonly ModuleFacePage[];
  /**
   * The compact live-glyph kind the shell renders in the tile's glyph slot.
   * Omitted / 'none' = no glyph.
   *
   * `'algorithm'` (PF-15) is the DATA-DERIVED odd one out: the other kinds bind
   * to an analyser tap or a param-reactive curve, while this one draws the
   * module's own SIGNAL TOPOLOGY from a discrete param. It exists because an FM
   * synth's 64 px scope trace is a wobbly line that looks identical for every
   * patch and FLATLINES whenever nothing is gated — which is most of the time
   * you are looking at a rack — whereas the topology is always live.
   *
   * ⚠ NOT YET A GENERAL PRECEDENT. It is one literal for one module's one
   * concept. When a SECOND topology-bearing module arrives, do NOT add a third
   * literal: widen the binding to carry a LAYOUT-SOURCE id (which pure layout
   * function feeds the picture) so the shell stops enumerating modules.
   */
  glyph?: 'scope' | 'meter' | 'envelope' | 'waveform' | 'algorithm' | 'none';
  /**
   * The module's DEPTH → output-gain multiplier, for a param-derived
   * `'waveform'` glyph that draws a DEPTH-scaled cycle (the `wave-morph`
   * binding). Omitted = 1 (the depth param IS the amplitude).
   *
   * ⚠ IT LIVES HERE BECAUSE IT IS A PER-MODULE NUMBER. `glyphBinding` fires for
   * ANY def with `glyph:'waveform'` + a 0..2 `shape` + a `depth`, so a constant
   * imported into that resolver would impose one module's worklet law on every
   * future adopter — silently, since a test that asserts `depthGain: X` on both
   * rows passes whatever X is. Declared on the face, the resolver stays generic
   * and each module carries its own multiplier. UI metadata like the rest of
   * `face`: OUT of contract-signature/contract-lock.
   */
  glyphDepthGain?: number;
  /**
   * BESPOKE-SURFACE extension id (#1512) — names the module's shell-extension
   * module (`$lib/ui/modules/<id>/shell-extension.ts`, default-exporting a
   * `ShellExtension` slot map) which ModuleShell resolves LAZILY at its
   * defined slots. The def declares a STRING, never a component, so `face`
   * stays serialisable data and the shared shell never imports a module —
   * the sidebar `custom.panelId` / PF-14 discipline, applied to the shell's
   * own slots (glyph today; editor surface / full-view body are the declared
   * contract for the bespoke-surface cohort).
   *
   * Deny-by-default both directions: an id the glob did not discover, and a
   * discovered extension no def declares, are both red
   * (shell-extensions.test.ts). A def with `glyph: 'algorithm'` MUST declare
   * an extension exporting the `glyph` slot — the topology plate has no
   * generic picture to fall back to. UI metadata like the rest of `face`:
   * OUT of contract-signature/contract-lock (see FACE_FIELDS_NOT_IN_LOCK).
   */
  extension?: string;
  /**
   * DECLARED render primitive for a param cell, keyed by param id.
   *
   * The primitives that CANNOT be inferred. `'toggle'` is derived from the
   * param's 0/1 switch shape (`looksLikeToggle`) and `'segmented'`/`'selector'`
   * from a declared `ParamDef.options` roster, so neither needs declaring —
   * these two do:
   *
   *   `'grid'`  — the chip + portaled diagram-grid popover (PF-15). "This
   *               param's states are PICTURES, lay them out as a chart."
   *   `'color'` — a native colour swatch over a PACKED `0xRRGGBB` integer
   *               (`<ColorField>`). "This integer is a COLOUR, not a position
   *               on a scale."
   *
   * ⚠ THE SECOND ONE IS DECLARED WITH LESS MARGIN THAN THE FIRST, AND THAT IS
   * WHY IT IS HERE RATHER THAN SNIFFED. A packed RGB is `0..16777215 discrete`
   * — structurally identical to any other discrete param, differing only in
   * MAGNITUDE, and nothing in the repo reads magnitude. Undeclared it resolves
   * to a KNOB sweeping 16.7 million values, and `faces-parity` PASSES that
   * (it drags the knob and the param moves), so the absence of a declaration
   * is invisible to every gate. A heuristic on the span would be a rule about
   * how large an integer may be before it stops being a scale.
   *
   * ⚠ THE THIRD ONE IS DECLARED FOR A DIFFERENT REASON ENTIRELY. `'fader'` is
   * not ambiguous with another primitive — it is the module telling the shell
   * that its LEVEL is a THROW rather than a dial. Nothing in a ParamDef
   * separates "a level" from any other continuous scalar, so a face cannot
   * infer it, and silently substituting a knob for a fader is a real
   * regression even though the value semantics are identical. (Owner
   * directive 2026-08-10, prompted by `noise`, whose card draws a fader.)
   *
   * UI metadata like the rest of `face`: OUT of contract-signature /
   * contract-lock (choosing a primitive is not an I/O change), linted by
   * module-face-lint.test.ts — every key must be a declared param that is also
   * ranked in `order`, must not also be on `momentary` (a press-pad is not a
   * state), and must carry the SHAPE its primitive needs (a step count a grid
   * can chart; the exact packed-RGB space for a colour; a CONTINUOUS scale for
   * a fader — the first two are discrete-only, the third discrete-never).
   */
  paramCells?: Readonly<Record<string, 'grid' | 'color' | 'hue' | 'fader'>>;
  /**
   * DECLARED 2-D PADS — the one cell that binds a PAIR of params.
   *
   * ⚠ IT IS A SEPARATE FIELD FROM `paramCells` BECAUSE OF ITS ARITY, and that
   * is the whole design note. `paramCells` is `Record<paramId, kind>` — keyed
   * by ONE id and single-valued by construction, which is exactly the property
   * its own doc-comment cites as keeping the declaration surface honest. A pad
   * cannot be expressed in it at all: there is no key that means "these two,
   * together". Squeezing it in would have meant either a second parallel field
   * of partners (two places to disagree) or widening the value to an object
   * (churning every consumer of a string union for one kind's benefit).
   *
   * Declaring the pair as a PAIR makes the arity a TYPE property: `x` and `y`
   * are both required, so an xy cell naming one axis does not compile. That is
   * the check a `Record` could not give — a missing partner would just be a
   * missing map entry, i.e. silence.
   *
   * ⚠ AND THE PAIRING IS THE POINT, not the primitive. Two params rendered as
   * two dials CAN reach every value a pad can; what they cannot do is reach
   * them TOGETHER. A camera tilt is one gesture, and splitting it into two
   * sequential drags is a lost capability, not a lost look — which is what
   * separates this from the `fader` kind next door.
   *
   * The X param ANCHORS the cell: the pad renders at x's rank and `y` is folded
   * into it rather than rendering a second time. Both must still appear in
   * `order` (face completeness is what proves no control was dropped) and both
   * must be CONTINUOUS — a pad over a discrete param is a stepper wearing a
   * joystick. module-face-lint enforces all of it.
   *
   * DOCK-ONLY, for the same measured reason a PF-14 panel is: the pad is square
   * and a lane knob column is 46 px (`--kcol-max`). It costs no lane rank —
   * `laneOrder` excludes it — so it may rank FIRST, which for a module whose
   * pad IS its main control is the honest ranking.
   *
   * UI metadata like the rest of `face`: OUT of contract-signature /
   * contract-lock (choosing a primitive is not an I/O change).
   */
  xyPads?: readonly FaceXyPad[];
  /**
   * Param ids that are MOMENTARY PADS, not values — the "press-param" pattern
   * (tomtom/clap `strike`): the worklet ORs the param with its trigger input
   * and fires on the RISING EDGE, so the control must PRESS and RELEASE, never
   * latch. Shape alone cannot tell them apart from a LATCHING switch (both are
   * `0..1 discrete default 0` — kickdrum/snaredrum `hard`, tidyVco `hold`), so
   * the intent is DECLARED here and the shell renders a momentary <Button>
   * instead of a KnobConic. UI metadata like the rest of `face`: OUT of
   * contract-signature/contract-lock (declaring it is not an I/O change) and
   * linted by module-face-lint.test.ts, which also fails when a promoted
   * module grows a NEW switch-shaped param that nobody classified.
   */
  momentary?: readonly string[];
  /**
   * CHANNEL ACCENT (#1825) — the param ids of each CHANNEL, in column order, so
   * the shell can paint channel N's controls in the colour of clip/automation
   * LANE N instead of the module's domain accent.
   *
   * Owner, 2026-08-17: *"for mixmstrs only, ch1-8 instead of neon blue, all
   * controls should match the assigned color of its lane."* A mixer channel IS
   * a lane — the same index that colours the automation lane, the clip row, the
   * Launchpad pad and the assigned card's border — and a console whose eight
   * strips are one colour makes the player count columns to find theirs.
   *
   * ⚠ PLAIN, DERIVED DATA. Outer index = channel = LANE index (0-based); the
   * def builds each inner list by FILTERING ITS OWN `params` through its own
   * naming rule, so a new per-channel control joins with no edit and no count
   * is ever typed. An id listed twice, or a listed id the def does not declare,
   * is red (module-face-lint).
   *
   * ⚠ THE COLOUR REACHES THE CELL THROUGH THE ACCENT CHAIN, never per control:
   * ModuleShell sets `--ka` on the cell and passes the same value as
   * `KnobConic`'s `accent`, and every neon primitive resolves
   * `--_ka: var(--ka, var(--domain, var(--accent)))`. Hard-coding a colour onto
   * a control is what produced #1812.
   *
   * ⚠ THE NO-LANE FALLBACK IS THE DOMAIN ACCENT. A rack with no clip player has
   * no lane colours at all, so the face paints exactly as it does today — the
   * declaration changes nothing on its own.
   *
   * UI metadata like the rest of `face`: OUT of contract-signature /
   * contract-lock (a colour source is not an I/O change).
   */
  channelAccent?: readonly (readonly string[])[];
  /**
   * PARAM IDS WHOSE CELL PAINTS NO CAPTION — the `.label` line under the
   * control is not rendered at the DOCK.
   *
   * ⚠ THE ACCESSIBLE NAME IS UNTOUCHED. `aria-label`, the right-click annotate
   * menu's title and MIDI-learn's address all still carry the param's `label`;
   * the primitives take a `hideCaption` prop precisely so a caller cannot
   * achieve this by dropping `label`, which would leave an unnamed control.
   *
   * ⚠ AND IT IS DECLARED PER PARAM, NOT PER TIER OR PER FACE, because the rule
   * it encodes is about REDUNDANCY and only the module knows. Owner ruling
   * 2026-08-17, stated as a contrast rather than a preference:
   *
   *   *"the 1lo 1md 1hi etc labels should also go away because the low/mid/high
   *   labels above the knob rows convey that fine"*
   *   *"mixmstrs is different than tidyvco because tidyvco does need some of
   *   the gray labels -- like a/d/s/r would not be comprehensible without
   *   them"*
   *
   * So: a caption earns its place when it disambiguates otherwise-identical
   * controls (tidyVco's four EG knobs are `A`/`D`/`S`/`R` and nothing else
   * separates them), and is clutter when a section heading already conveys it
   * (mixmstrs' `1LO…8LO` under a `LOW` cluster heading). A tier-wide switch
   * cannot tell those apart, which is why there isn't one.
   *
   * ⚠ DOCK ONLY, BY THE SAME ARGUMENT. A lane tile has no section headings at
   * all, so the heading that makes the caption redundant is not on screen —
   * ModuleShell gates this on `faceplateView` and the lane keeps every label.
   *
   * UI metadata like the rest of `face`: OUT of contract-signature /
   * contract-lock, linted by module-face-lint.test.ts (every id must be a
   * declared param that is also ranked in `order`, and must not repeat).
   */
  bareCells?: readonly string[];
  /** OPTIONAL rear-card curation (the dock flip-side jack field). Derivation
   *  covers most modules — voice/signal band + one band per `pages` page (the
   *  CV holes targeting that page's params) + the OUTPUTS rail — so this is
   *  only for the exceptions (see $lib/ui/workflow/rear-card-model). Keys are
   *  PORT ids; ports not listed anywhere fall back to derivation. UI metadata
   *  exactly like the rest of `face`: OUT of contract-signature/contract-lock,
   *  linted by module-face-lint.test.ts. */
  rear?: ModuleFaceRear;

  // ── PF-20 — THE FACEPLATE PLATFORM (dock-only structure) ─────────────────
  //
  // Everything below exists because the shell was STRUCTURALLY INCAPABLE of
  // rendering a designed instrument panel: it painted bands of bare knobs and
  // a spine, where the mocks are a titled page with a hero and described
  // sections. That was reported six times as per-card drift; it was never
  // per-card. These fields are the declaration surface that closes it, and they
  // are GENERIC by construction — no field names a module.
  //
  // ALL ARE DOCK-ONLY. Ranks 1-6 are the LANE budget (faceTierCap); the dock
  // shows everything, so the title, the hint and the hero never reach a
  // 192×180 tile.
  //
  // ⚠ THE FOURTH FIELD WAS `sidebar`, AND IT IS DELETED — see ModuleFaceHero
  // for the owner rulings and the gate that replaced it. All three survivors
  // are UI metadata out of contract-lock.txt; FACE_FIELDS_NOT_IN_LOCK in
  // contract-signature.ts names the gate that covers each instead.

  /** The faceplate's PAGE TITLE — the mock's "Voice". A short category word,
   *  above the hint. Omitted = no title row. */
  title?: string;
  /** The one-line description under the title ("three decoupled generators
   *  through one serial bus"). Omitted = no hint row. */
  hint?: string;
  /** The HERO SLOT — the module PICTURE, a promoted control and its audition,
   *  above the bands. */
  hero?: ModuleFaceHero;
  /**
   * Force the DOCK TAB RAIL on, whatever the band count.
   *
   * ⚠⚠ OWNER-INSTRUCTION ONLY, PER MODULE. This is NOT a layout preference an
   * author may reach for, and it does NOT reopen "should my face be tabbed?".
   * The DEFAULT STANDS: author honest pages and let the rail engage at
   * `DOCK_TAB_MIN_BANDS` (7). A face with 3-6 honest pages renders as a column,
   * and that is correct — the owner separately ruled `ruttetra` ships UNTABBED
   * for exactly that reason.
   *
   * Declaring it requires a NAMED entry in `FACE_TAB_OPT_IN`
   * (`dock-tabs-model.test.ts`) carrying the owner instruction it came from,
   * VERBATIM. A def that declares this without an entry is RED, and an entry
   * naming a module that no longer declares it is RED too — so nobody can
   * quietly opt a face in, and no licence outlives its instruction.
   *
   * Today's only adopter is `spirographs` (owner: *"this should just be 3 tabs,
   * one per spiro"*), where the rail is not a density workaround but the
   * module's own structure: three INDEPENDENT figures, one editable at a time,
   * which is exactly what its legacy card's own tablist did.
   */
  tabbed?: true;
  /**
   * MONITOR MODE — this face's own surface may be watched WITHOUT its control
   * bands, and `node.data.hideControls` is what does it (#2009).
   *
   * ⚠ IT IS THE EXACT INVERSE OF SCREEN ON/OFF, NOT A DUPLICATE OF IT, and
   * #1865 proposed the opposite. SCREEN OFF hides the PICTURE and keeps the
   * controls; MONITOR MODE hides the CONTROLS and keeps the picture. Neither
   * can subsume the other — they are the two directions of one question ("which
   * half am I looking at right now?"), and a video face wants both.
   *
   * ⚠ WHY THIS IS A SHELL CAPABILITY AND NOT A `ShellExtension` SLOT. The gap
   * #2009 filed is that `fullViewBody` paints ABOVE the bands and CANNOT
   * suppress them — its own contract says so, deliberately (the
   * `warrensspectrum` failure, where a body that ate the faceplate would have
   * deleted every control). `editorSurface` is not the home either: it is
   * specced for "controls that are not cell-shaped at all" — a clip arranger, a
   * pad matrix — and it is a STATIC structural choice. Hiding the bands is a
   * TOGGLE over a face whose controls are perfectly cell-shaped. Different
   * axis, so wiring `editorSurface` for it would have made ruttetra a fake
   * first adopter of a slot it does not need, and left the real blocker
   * standing.
   *
   * WHAT PROMOTION WOULD OTHERWISE DELETE: five legacy cards mount
   * `hideControls` (`ruttetra`, `monoglitch`, `milkdrop`, `reshaper`,
   * `graphicEq`), and `migrated(type)` stops BOTH surfaces rendering the card.
   * On ruttetra the def's own `docs` advertise the gesture in the user's words
   * — "hiding the controls turns it into a resizable monitor" — so promoting
   * without this makes the shipped documentation describe a control that no
   * longer exists, and no def-reading gate can see that.
   *
   * ⚠ IT CANNOT ENGAGE WITHOUT A SURFACE TO BE A MONITOR OF.
   * `faceMonitorPlan` requires `dockFullViewHeadPlan().extBody` — the module's
   * own `fullViewBody` actually painting — because a faceplate with its bands
   * hidden and no picture is a BLANK PLATE, which is a worse outcome than the
   * one this fixes. That precondition is asserted directly rather than left to
   * an author's care.
   *
   * Gate: `face-monitor-source.test.ts`, deny-by-default in BOTH directions —
   * a face declaring this must own a `fullViewBody` that reads and writes
   * `hideControls` and exposes a button, and a FACED module whose legacy card
   * still mounts `hideControls` must declare this or carry a named exemption.
   */
  monitor?: FaceMonitor;
  /**
   * BAND FOCUS — a param's VALUE decides which control bands render.
   *
   * Owner ruling, 2026-08-20, on `colourofmagic`: *"we can rgb by default and
   * only show rgb controls … if i select passthrough manually that's the only
   * time i see all controls."* That module runs five colorspace blocks in
   * parallel and `preview` picks which of twenty-two outputs you are looking
   * at, so the plate carried thirty-five knobs while you steered six of them.
   * Focusing brings the picture and the controls that drive it together.
   *
   * ⚠ IT IS STRUCTURE, NOT TEXT, which is why it is free under the
   * resting-text rulings — it decides which bands RENDER and paints nothing.
   * The same shape `monitor` above uses, one step further: a PER-BAND
   * predicate rather than a whole-plate boolean.
   *
   * ⚠ AND UNLIKE `monitor`, ITS DEFAULT STATE IS FOCUSED, which is the whole
   * reason it needed a gate change. Monitor mode is a per-node runtime state no
   * parity gate observes (a freshly opened faceplate has `hideControls` absent
   * ⇒ false). Band focus is read straight off a PARAM, and `colourofmagic`
   * defaults to `preview: 1` (RGB) — so a freshly opened faceplate renders ONE
   * band, and `faces-parity`'s "every param renders exactly one cell" would go
   * RED on a correctly-working module. The sweep therefore drives the face into
   * a declared `showAllOn` value first; see `showAllBands` in faces-parity.
   *
   * Gate: `band-focus-model.test.ts` for the predicate + totality, and the
   * parity sweep's focused-absence leg for "the declaration is actually wired".
   */
  bandFocus?: FaceBandFocus;
  /**
   * RACK-GLOBAL STATUS — this face shows state that belongs to THE RACK rather
   * than to this node (#2024 item 3; owner ruling 2026-08-21, *"close the
   * gap"*).
   *
   * ⚠ IT IS A THIRD AXIS, not a spelling of the two above. `monitor` is a
   * per-node RUNTIME TOGGLE; `bandFocus` is a per-node PARAM VALUE. This one is
   * a property of the PATCH — which other nodes exist — and no param-reading
   * resolver can see it, because there is no `ParamDef` whose value is "am I
   * the instance that owns the shared hardware", and there cannot be: the
   * answer changes when a DIFFERENT node is added or deleted.
   *
   * The worked case is `cvBuddy`/`cvBuddyMini`. RUN and CLOCK are single-source
   * — the id-smallest instance of either kind drives ES-9 jacks 7 and 8 — so on
   * every other instance the PPQN and OFFSET controls are dials wired to
   * nothing, and the legacy card has always hidden them. `primaryOnlyBands`
   * carries that forward; without it, promotion turns two hidden controls into
   * two live-looking ones that change nothing, which is a worse surface than
   * the card it replaced.
   *
   * ⚠ IT IS STRUCTURE, NOT TEXT — free under the resting-text rulings for the
   * same reason `bandFocus` is: it decides which bands RENDER and paints
   * nothing at all. The rack-global state a player actually READS (which jacks
   * this instance owns, whether the clock is dropping pulses) is painted by the
   * module's own `fullViewBody` through the `StatusLed` primitive, where a
   * caption is static, a state is a lamp, and the measurement reaches
   * `aria-label`/`title` and never a text node.
   *
   * ⚠ IT CANNOT BLANK A PLATE. `rackStatusPlan` refuses to hide anything unless
   * the module's own body is painting — the `faceMonitorPlan` precondition, and
   * sharper here, since `cvBuddy`'s only two params are BOTH in the suppressed
   * band. The lane tile is the named blind spot: no status body fits there, so
   * nothing is suppressed there either.
   *
   * Gate: `face-rack-status-source.test.ts`, deny-by-default in both
   * directions — a declaring face must own a `fullViewBody` that reads the
   * patch and paints through `StatusLed`, its `primaryOnlyBands` must name real
   * bands and its `peers` real registered types; and every extension body in
   * the tree must declare what its own canvas paints, which is what converts
   * `face-resting-text-source`'s largest named blind spot into a
   * deny-by-default roster.
   */
  rackStatus?: FaceRackStatus;
}

/**
 * RACK-GLOBAL STATUS's declaration (`face.rackStatus`). Serialisable data like
 * the rest of `face` — the shell reads it, never a closure.
 *
 * ⚠ `peers` IS DECLARED, NOT DERIVED, and the reason is that the platform
 * cannot know which modules share a resource. `cvBuddy` and `cvBuddyMini` draw
 * from ONE ES-9 jack pool across both types — that is a fact about the ES-9,
 * not about either def — and a derivation over "modules with the same category"
 * or "the same palette group" would be a guess that reads as a rule.
 */
export interface FaceRackStatus {
  /**
   * Why THIS face's controls depend on which OTHER nodes exist — required by
   * the type so `tsc` refuses the bare form, and an argument rather than a
   * label. NEVER PAINTED: it is for the reviewer and the gate, and
   * `face-resting-text-source` asserts the shell cannot reach it.
   */
  why: string;
  /**
   * The module types sharing the rack-global resource, INCLUDING this one. The
   * PRIMARY is the lexicographically smallest node id among them — the same
   * converged tie-break every collab peer computes identically.
   */
  peers: readonly string[];
  /**
   * Band (page) ids that render ONLY on the primary instance. Anchored by the
   * gate to the face's own declared pages, so a renamed band cannot leave a
   * suppression pointing at nothing — which would fail SILENTLY OPEN, painting
   * the dead controls this field exists to hide.
   */
  primaryOnlyBands: readonly string[];
}

/**
 * BAND FOCUS's declaration (`face.bandFocus`). Serialisable data like the rest
 * of `face` — the shell reads it, never a closure.
 *
 * ⚠ DECLARED, NOT DERIVED, and the choice is about COUPLING rather than effort.
 * On the first adopter the map falls out of the output port ids — that is how it
 * was verified, and every one of the twenty-two `preview` values resolved to
 * exactly one block. But deriving it would tie band visibility to the REAR
 * CARD's port grouping, a separate concern a later edit is free to reorganise.
 * Declared, the coupling is visible and the totality gate can check it.
 */
export interface FaceBandFocus {
  /** The param whose value selects the focused band. */
  param: string;
  /**
   * Why hiding the other bands is right for THIS module — required by the type
   * so `tsc` refuses the casually-focused face, and an argument rather than a
   * label. NEVER PAINTED: it is for the reviewer and the gate, and
   * `face-resting-text-source` asserts the shell cannot reach it.
   */
  why: string;
  /**
   * Values that show EVERY band — the state a player selects on purpose.
   *
   * ⚠ IT MUST BE NON-EMPTY, or the face has no state in which every control is
   * reachable, and the parity sweep says so by name.
   */
  showAllOn: readonly number[];
  /** band (page) id → the param values that reveal it, and only it. */
  bands: Readonly<Record<string, readonly number[]>>;
}

/**
 * MONITOR MODE's declaration (`face.monitor`). A record with one REQUIRED
 * field, so `tsc` refuses the bare `monitor: true` form: the burden of proof is
 * on the face that claims its picture is worth watching alone.
 *
 * ⚠ `why` IS NEVER PAINTED. It is documentation for the reviewer and for
 * `face-monitor-source.test.ts`, which requires it to be an argument rather
 * than a label — the same shape every exemption roster in this repo uses. The
 * shell is asserted never to read it (`face-resting-text-source.test.ts`), so
 * it cannot become a fifth resting-text mechanism.
 */
export interface FaceMonitor {
  /** Why THIS face's surface is worth watching without its controls — the
   *  picture a player steers by, not merely a preview beside the knobs. */
  why: string;
}

/**
 * The HERO SLOT — the top of the faceplate: the module's biggest control, its
 * audition and its own picture.
 *
 * ⚠ THERE IS NO `readouts` FIELD, AND THERE IS NO `sidebar` ON `ModuleFace`.
 * Both are DELETED, not deprecated, and re-adding either — under any name — is
 * the mistake this note exists to prevent. The owner ruled four times in one
 * day that the RESTING faceplate paints no derived-state text: "I DO NOT WANT
 * THESE RIGHT HAND TEXT AREAS I DO NOT WANT EXTRA TEXT. i explicitly already
 * dictated that several times" (the spirographs sidebar), then "you don't need
 * to have the out-silent text at all … we absolutely have to stop doing [things]
 * like that. i said minimal, and good use of screen real estate" (moog984's
 * hero readout row, #1957).
 *
 * The two mechanisms were structurally different and BOTH passed every gate
 * that existed, which is why the replacement gate denies the SHAPE rather than
 * either mechanism: `face-resting-text-source.test.ts`. The permitted resting
 * text on a faceplate is exhaustively the module NAME, tab/section LABELS,
 * control CAPTIONS, and option/landmark NAMES that disambiguate a control's own
 * position. A derived value's home is `aria-valuetext` on the control it
 * describes — which every spec proving a face tracks the graph already reads,
 * so nothing had to be weakened to delete these.
 *
 * ⚠ A face that promotes a PICTURE (`cell`) suppresses the shell glyph at the
 * dock — the glyph is a live trace of the OUTPUT and the picture is a picture
 * of the PATCH, so painting both put an empty black rectangle beside the graph
 * on a silent rack. The glyph is untouched at every other tier.
 *
 * ⚠ `control` / `action` PROMOTE a key out of its band — they do NOT duplicate
 * it. A duplicated key would emit a second `data-testid="control-<paramId>"`
 * and fail faces-parity's exact param multiset (`duplicate/unknown = an
 * unbacked extra`), so `heroFacePlan` REMOVES the promoted keys from the bands
 * and the totality of that move is what dock-faceplate-model.test.ts pins.
 */
export interface ModuleFaceHero {
  /**
   * A `face.order` key promoted into the hero slot as the module's own PICTURE
   * — a PF-14 `panel` cell (an envelope graph, a scale ring, a routing map).
   *
   * ⚠ THE PICTURE IS THE ONE HALF OF A FACEPLATE THAT CANNOT BE PLATFORM. A
   * title and a hint are the same shape on every instrument, so they are DATA
   * declared here. What a kick drum's
   * envelope looks like is not — no amount of def introspection synthesises it.
   * Promoting the module's panel into the hero is how the platform makes room
   * for that without any module needing to touch the shell. A face that
   * declares no `cell` keeps the plain `glyph` band it has today.
   */
  cell?: string;
  /** A `face.order` key promoted into the hero slot as the BIG control. */
  control?: string;
  /** A second `face.order` key beside it — typically the audition button. */
  action?: string;
}

/** Rear-card curation block (see ModuleFace.rear). */
export interface ModuleFaceRear {
  /**
   * Explicit rear SECTIONS — the authored grouping the patch field lays out as
   * columns (#1800). One list covers BOTH rails; `direction` says which.
   *
   * INPUT sections (the default) keep the slot-claiming semantics they have
   * always had: a group whose id is 'voice'/'signal' claims the leading
   * voice/signal slot; an id matching a `pages` page id claims that page's slot
   * (its label wins); any other id appends after the page sections. Ports
   * listed here are exempt from derivation.
   *
   * OUTPUT sections (`direction: 'output'`) have no pages to project from, so
   * they are pure authoring: each names its own ports and heading, in
   * declaration order, and whatever is left over falls to the derived default
   * (see `rearFieldPlan` — one `out` section, split by cable domain only once
   * the rail out-runs a column).
   *
   * ⚠ `direction` DEFAULTS TO 'input' because the input side is the one with a
   * derivation to override and carries every group authored before #1800 — but
   * the default is not load-bearing, because module-face-lint refuses a group
   * whose ports do not all exist on the direction it declares. A port id may
   * legitimately exist on BOTH rails (`delay` declares an `audio` input AND an
   * `audio` output), so the field is what disambiguates and the lint is what
   * makes forgetting it RED rather than silently wrong.
   */
  groups?: readonly {
    id: string;
    label: string;
    ports: readonly string[];
    /** Which rail this section groups. Omitted = 'input'. */
    direction?: 'input' | 'output';
  }[];
  /** Cluster sub-headers INSIDE a section (e.g. envelopes → filter eg / amp
   *  eg). `group` names the section (a page id or a curated group id); listed
   *  ports must belong to that section. */
  clusters?: readonly { group: string; label: string; ports: readonly string[] }[];
  /** INPUT ports consumed at audio rate — rendered with the `~` tick. Curated
   *  (spec §6 Q5): there is no PortDef.rate field, and adding one would churn
   *  the I/O contract, so v1 ticks from this list. */
  audioRate?: readonly string[];
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
    /** Input port id the lane's velocity CV wires into, or ABSENT when the
     *  module has no velocity input at all (cvBuddyMini). Optional rather than
     *  a sentinel so a module that genuinely lacks the port cannot be wired to
     *  a non-existent one — the lane planner simply skips the velocity leg. */
    velIn?: string;
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
   *     cleanup pass.
   *   - `hiddenCard?: boolean` — workflow-mode HEADLESS instance
   *     (graph/hidden-card.ts; the P4 camera manager's mapped cameras).
   *     Presentation-only: renders no canvas card (its face is a topbar
   *     menu) but is otherwise an ordinary node — user-deletable via the
   *     standard remove path and COUNTED toward `maxInstances`. Never set
   *     on a free-canvas node.
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
