// packages/web/src/lib/ui/workflow/rear-card-model.ts
//
// PURE derivation for the REAR CARD — the RACKLINE flip-side patch field the
// dock full-view shows on TAB.
//
// The def's `inputs[]`/`outputs[]` ALREADY IS the one-function-per-hole list:
// the rear card renders EVERY declared port, one hole each, no synthesis and
// no elision. This module decides GROUPING + LABELING, nothing DOM.
//
// ── #1800: ONE GRAMMAR, SECTIONS AS COLUMNS ─────────────────────────────────
//
// Owner, 2026-08-17: *"[the OUTPUTS list] is cool but [the INPUTS bands] is
// wasteful. everything should be done in the output style list"* / *"we want to
// do intelligent authored grouping of inputs and outputs, with different
// sections as coumns i think."*
//
// So the plan no longer has two shapes. It has ONE — `RearSection` — and BOTH
// rails are lists of it. What used to be a full-width input BAND and a fixed
// right OUTPUTS RAIL are now the same object with a different `direction`, and
// the card flows them into COLUMNS. A section holding three jacks no longer
// claims a whole row of the card and leaves the rest grey.
//
// GROUPING, in precedence order, for EITHER direction:
//
//   1. AUTHORED — `face.rear.groups` entries, `direction` selecting the rail.
//      Co-located on the def exactly like `docs:`, so a port change and its
//      grouping edit land in the same diff.
//   2. DERIVED, inputs — unchanged and already page-authored:
//        voice/signal = inputs that are not per-param CVs (no paramTarget AND
//                       no `<param>_cv` id match), declared order
//        pages        = for each `face.pages` page, the CV holes targeting that
//                       page's params, in page-control order
//        orphans      = per-param CVs whose target is in NO page → trailing
//                       `cv` section
//   3. DERIVED, outputs — ONE `out` section, which is what a rail of two to
//      four taps should look like. It splits into one section per CABLE DOMAIN
//      only once the un-split rail would out-run a column (see
//      `derivedOutputSections`). There is deliberately no cleverer default: a
//      page projection has no meaning for outputs, and a header over a
//      one-row group is chrome, not grouping.
//
// `face.rear.clusters` adds sub-headers inside a section (either rail);
// `face.rear.audioRate` drives the `~` tick (no PortDef.rate field exists, so
// the tick ships from a curated list).
//
// Labels are by FUNCTION: a per-param CV hole takes its target param's label
// (CUTOFF, not CUTOFF_CV — the section heading and the row's own geometry
// already say "input"); a `<x>_cv` port with no matching param labels from the
// stem; everything else falls back to the shared resolveVerboseLabel.
//
// Framework-free + registry-free (reads only the passed def), so it is
// unit-testable and zero-flake, exactly like module-shell-model.ts.

import { resolveVerboseLabel } from '$lib/ui/patch-panel-labels';
import { domainClassForCable, type SignalDomain } from './module-shell-model';
import { derivedStereoPairs, type StereoPairDefLike } from '$lib/graph/stereo-pairs';
import { collapsedPairLabel } from '$lib/ui/stereo-jack-collapse';
import type { ModuleFace } from '$lib/graph/types';

/** The minimal port shape the rear-card model reads (any-domain PortDef). */
export interface RearPortLike {
  id: string;
  type: string;
  label?: string;
  paramTarget?: string;
  edge?: 'trigger' | 'gate';
  accepts?: readonly string[];
}

/** The minimal def shape the rear-card model reads. */
export interface RearDefLike {
  /** Module type id — read ONLY to resolve COLLAPSE_EXEMPT entries in the
   *  shared stereo-pair derivation (a def with no type matches none of them). */
  type?: string;
  inputs?: readonly RearPortLike[];
  outputs?: readonly RearPortLike[];
  /** Declared stereo tuples — consumed via $lib/graph/stereo-pairs, never
   *  re-interpreted here. */
  stereoPairs?: readonly (readonly [string, string])[];
  params?: readonly { id: string; label?: string }[];
  face?: ModuleFace;
  docs?: {
    inputs?: Record<string, string>;
    outputs?: Record<string, string>;
  };
}

/** One jack hole — one declared port, one function. */
export interface RearHole {
  portId: string;
  direction: 'input' | 'output';
  /** FUNCTION label, uppercase (target param label / cv stem / verbose id). */
  label: string;
  /** The port's live cable type (PortDef.type) — the committed cable's hue. */
  cable: string;
  /** RACKLINE domain class for the hole ring (.audio/.cv/.gate/.video/.poly). */
  domain: SignalDomain;
  /** Trigger/gate consumer glyph (▲ pulse / ▬ level) — declared on the port. */
  edge?: 'trigger' | 'gate';
  /** `pitch`-cable hole: cv-green ring + a '1v/oct' tag (spec §1.4, Q2). */
  pitch: boolean;
  /** Audio-rate consumer → the `~` tick (face.rear.audioRate curation). */
  audioRate: boolean;
  /** Authored doc sentence for title/aria enrichment (docs.inputs/outputs). */
  doc?: string;
  /** ONE STEREO HOLE (owner Q5). Set to the OTHER leg's port id when this hole
   *  is a collapsed L/R pair; `portId` is then the LEFT leg, which is what a
   *  click patches (every commit runs through `planAudioCommit`, which reads
   *  the pair off the def and writes both legs).
   *
   *  This REPLACES the old `pairWithPrev` tie mark. The tie drew a "stereo
   *  pair" caption between two adjacent output holes and therefore depended on
   *  rail ADJACENCY to be truthful — a derived pair whose holes were not
   *  consecutive would have tied the wrong two jacks. One hole has no such
   *  precondition, and it matches what every other jack field now shows. */
  stereoSiblingPortId?: string;
}

/** A cluster sub-header inside a section (envelopes → filter eg / amp eg). */
export interface RearCluster {
  label: string;
  holes: RearHole[];
}

/**
 * ONE GROUP OF HOLES — the single grammar both rails now use (#1800).
 *
 * Before this, an input group was a `RearBand` (full-width, stacked) and the
 * outputs were a bare `RearHole[]` pinned to a fixed-width rail. Those were two
 * shapes for one idea, and the type difference is exactly what made it
 * impossible to give inputs the compact row treatment the outputs already had.
 */
export interface RearSection {
  id: string;
  label: string;
  /** Which rail. Drives the row's geometry, not its colour — see
   *  `rear-direction.ts` for the full set of non-colour direction channels. */
  direction: 'input' | 'output';
  /** Un-clustered holes (render first, section order). */
  holes: RearHole[];
  /** Clustered holes (render after `holes`, declaration order). */
  clusters: RearCluster[];
  /**
   * How many COLUMNS of rows this section's list flows into.
   *
   * ⚠ THIS IS THE HALF THAT KEEPS "SECTIONS AS COLUMNS" FROM BEING A
   * REGRESSION, and it was measured rather than assumed. The old full-width
   * band was wasteful for a THREE-jack group (the owner's screenshot) but
   * space-EFFICIENT for a thirty-jack one, because its auto-fill raster spread
   * those thirty across the card. Giving every section exactly one column would
   * have fixed the first case by making the second one a 33-row tower —
   * mixmstrs' `channels` group, measured on the real def.
   *
   * So a section's WIDTH is earned by its CONTENT: one column up to
   * `REAR_ROWS_PER_COLUMN` rows, then another, capped at
   * `REAR_MAX_SECTION_COLUMNS`. A section is still ONE group with ONE heading —
   * it just does not pretend a thirty-row list is a column.
   */
  columns: number;
}

export interface RearFieldPlan {
  /** Input sections: voice/signal first, then page sections, then extra
   *  authored groups, then the orphan "cv" section. Empty sections dropped. */
  inputs: RearSection[];
  /** Output sections: authored ones in declaration order, then the derived
   *  remainder. Same type as `inputs` — that symmetry IS the redesign. */
  outputs: RearSection[];
  /** Total RENDERED holes (inputs + outputs). A collapsed stereo pair is ONE
   *  hole, so this is ≤ the declared port count — see `portCount`. */
  holeCount: number;
  /** Declared ports ADDRESSED by those holes (a stereo hole addresses two).
   *  This is the no-orphan-holes guarantee and it always equals
   *  `inputs.length + outputs.length`; `holeCount` no longer can, now that a
   *  pair renders as one hole. Keeping both means the totality invariant is
   *  still assertable instead of quietly becoming untestable. */
  portCount: number;
  /**
   * The HIGH-PORT-COUNT FALLBACK, and it is the whole of it (#1800).
   *
   * ⚠ WHAT THIS REPLACES. The old fallback was BAND-COLLAPSE: past ~60 holes
   * every band rendered as its header plus a jack-count pill, and its holes
   * WERE NOT IN THE DOM until you clicked the header open. On the one surface
   * that is a dock card's only patch field, that is not a density step — it is
   * hiding patch points behind a disclosure. Columns removed the need for it:
   * the same rows in N columns are 1/N the height, which is the axis that
   * actually overflowed (measured at 1280x720: 954 px of content in a 352 px
   * viewport vertically, and NO horizontal overflow at all).
   *
   * So the ladder is now: COLUMNS first (CSS, no threshold — the card fits as
   * many as the width allows), then `dense` — tighter row metrics and the
   * endpoint chip degrading to a plug mark — past `REAR_DENSE_ROWS`. EVERY
   * hole stays rendered, hit-testable and patchable at every step. Still never
   * a cascade, and now never a disclosure either.
   */
  dense: boolean;
}

/**
 * Row count past which the field steps to its dense row metrics.
 *
 * A LAYOUT POLICY THRESHOLD on a derived measurement (rendered rows), not a
 * population count: it does not encode how many of anything there are, and a
 * def gaining a port cannot make it stale.
 */
export const REAR_DENSE_ROWS = 40;

/**
 * Rows past which the DERIVED output grouping splits by cable domain.
 *
 * Same class of constant as `REAR_DENSE_ROWS`: it measures the rail against a
 * column, it is not a count of anything that exists. Below it a single `out`
 * section is the honest default — a heading over a one-row group is chrome,
 * not grouping — and above it a rail long enough to need scanning gets the one
 * split that is derivable from the CONTRACT rather than guessed.
 */
export const REAR_OUTPUT_SPLIT_ROWS = 12;

/**
 * Rows a single section column may hold before the section takes another.
 *
 * A LAYOUT POLICY THRESHOLD on a derived measurement, like the two above: it
 * says how tall a column is allowed to get, not how many of anything exists.
 */
export const REAR_ROWS_PER_COLUMN = 16;

/**
 * The most columns ONE section may claim.
 *
 * A physical cap, not a count: past three the section stops reading as one
 * group and the field would rather wrap it than let a single heading own half
 * the card.
 */
export const REAR_MAX_SECTION_COLUMNS = 3;

/** Columns for a section holding `rows` rows — the derivation behind
 *  `RearSection.columns`, exported so the layout rule has exactly one home. */
export function rearSectionColumns(rows: number): number {
  if (rows <= 0) return 1;
  return Math.min(REAR_MAX_SECTION_COLUMNS, Math.ceil(rows / REAR_ROWS_PER_COLUMN));
}

/**
 * How wide a ZONE may get, in section columns. Physical caps, not counts.
 *
 * ⚠ THESE ARE LOAD-BEARING, not cosmetic. The card is `width: max-content`, and
 * neither of the two layouts it uses has a usable intrinsic width: a
 * `flex-wrap` row asked for max-content never wraps (every column on one line),
 * and a CSS multicol asked for max-content collapses to a SINGLE column — that
 * second one was measured, not predicted, and turned tidyVco's field into a
 * 287x929 ribbon. The cap is the definite outer bound both modes resolve
 * against.
 *
 * The input zone earns more columns when the field is `dense`, because a field
 * with that much content has earned the width — the rule is "width must be
 * earned", not "width is forbidden". The output zone stays narrow: past two
 * columns the domain split in `derivedOutputSections` has already grouped the
 * rail.
 */
export const REAR_MAX_ZONE_COLUMNS = 4;
export const REAR_MAX_ZONE_COLUMNS_DENSE = 6;
export const REAR_MAX_OUT_ZONE_COLUMNS = 2;

/** Columns for a ZONE holding `sections` sections — capped, and never wider
 *  than it has sections to put there. One home for the rule; both the wrap and
 *  the balanced layout size themselves from it. */
export function rearZoneColumns(
  sections: number,
  direction: 'input' | 'output',
  dense: boolean,
): number {
  const cap =
    direction === 'output'
      ? REAR_MAX_OUT_ZONE_COLUMNS
      : dense
        ? REAR_MAX_ZONE_COLUMNS_DENSE
        : REAR_MAX_ZONE_COLUMNS;
  return Math.max(1, Math.min(cap, sections));
}

/** The per-param CV target param id for a port: explicit `paramTarget`
 *  (Pattern A — kickdrum/adsr/lfo/cloudseed) else the `<param>_cv` id stem
 *  (Pattern B — tidyVco). Undefined when the port declares neither shape. */
export function rearTargetParamId(port: RearPortLike): string | undefined {
  if (port.paramTarget) return port.paramTarget;
  if (port.id.endsWith('_cv')) return port.id.slice(0, -'_cv'.length);
  return undefined;
}

/** Uppercase + de-underscore a fallback label ('out_l' → 'OUT L'). */
function tidyLabel(s: string): string {
  return s.replace(/_/g, ' ').trim().toUpperCase();
}

/** The FUNCTION label for a hole (spec §2.3): target param's label first,
 *  then the `<x>_cv` stem, then the shared verbose-label derivation. */
export function rearHoleLabel(
  port: RearPortLike,
  params: readonly { id: string; label?: string }[],
): string {
  const target = rearTargetParamId(port);
  if (target) {
    const param = params.find((p) => p.id === target);
    if (param) return tidyLabel(param.label ?? param.id);
    // `<x>_cv` with no matching param (tidyVco pwm_cv → 'PWM'): label from
    // the stem via the shared abbreviation table, NOT '<X> CV'.
    if (!port.paramTarget) {
      return tidyLabel(resolveVerboseLabel({ id: target, cable: port.type }));
    }
  }
  return tidyLabel(resolveVerboseLabel({ id: port.id, label: port.label, cable: port.type }));
}

function makeHole(
  port: RearPortLike,
  direction: 'input' | 'output',
  def: RearDefLike,
  audioRate: ReadonlySet<string>,
): RearHole {
  return {
    portId: port.id,
    direction,
    label: rearHoleLabel(port, def.params ?? []),
    cable: port.type,
    domain: domainClassForCable(port.type),
    edge: port.edge,
    pitch: port.type === 'pitch',
    audioRate: direction === 'input' && audioRate.has(port.id),
    doc:
      direction === 'input'
        ? def.docs?.inputs?.[port.id]
        : def.docs?.outputs?.[port.id],
  };
}

/**
 * Collapse stereo L/R pairs into ONE hole (owner Q5).
 *
 * The pairing USED TO BE the fifth independent heuristic in the app: a stem
 * regex (`/^(.*?)_?([lr])$/`) over ADJACENT outputs, blind both to a def's
 * `stereoPairs` declaration and to the port's CABLE TYPE. It was wrong in both
 * directions and shipped that way:
 *
 *   • FALSE POSITIVE — `gamepad`'s d-pad buttons `dl` / `dr` are GATE-typed
 *     (⬅ / ⮕). The regex read them as one stereo pair and the rail drew a
 *     pair tie between two directions on a joypad.
 *   • FALSE NEGATIVE — `sidecar`'s `audio_l_out` / `audio_r_out` and
 *     `audioIn`'s `audio_l_out` / `audio_r_out` are DECLARED stereo pairs, but
 *     the ids do not END in l/r, so the regex never saw them.
 *
 * PR-2b rewired it onto the one derivation (`derivedStereoPairs`: declarations
 * ∪ the id-token fallback, AUDIO-typed ports only, minus the named
 * COLLAPSE_EXEMPT set — `rings`' odd/even timbre taps). PR-4 goes the last
 * step: the pair no longer draws a "stereo pair" TIE between two holes, it
 * IS one hole, matching every other jack field.
 *
 * That also removes the tie's ADJACENCY precondition. `pairWithPrev` meant
 * "tie me to the hole BEFORE me", so a derived pair whose holes were not
 * consecutive would have tied the wrong two jacks; a single hole cannot be
 * wrong about its own two ports, wherever they sit in declared order.
 *
 * Works on EITHER rail. The tie only ever existed on outputs, which meant a
 * stereo INPUT pair rendered as two holes on a card whose front now shows one
 * jack — two surfaces disagreeing about the same def.
 */
function collapseStereoHoles(
  holes: RearHole[],
  def: RearDefLike,
  direction: 'input' | 'output',
): RearHole[] {
  const pairs = derivedStereoPairs(def as StereoPairDefLike).filter(
    (p) => p.direction === direction,
  );
  if (pairs.length === 0) return holes;
  const present = new Set(holes.map((h) => h.portId));
  const pairOf = new Map<string, (typeof pairs)[number]>();
  for (const p of pairs) {
    // BOTH legs must be on this rail. A rail missing one leg keeps two (or one)
    // plain holes rather than claiming a jack that patches a port not shown.
    if (!present.has(p.left) || !present.has(p.right)) continue;
    pairOf.set(p.left, p);
    pairOf.set(p.right, p);
  }
  if (pairOf.size === 0) return holes;

  const done = new Set<string>();
  const out: RearHole[] = [];
  for (const hole of holes) {
    const pair = pairOf.get(hole.portId);
    if (!pair) {
      out.push(hole);
      continue;
    }
    const key = `${pair.left}+${pair.right}`;
    if (done.has(key)) continue;
    done.add(key);
    const left = holes.find((h) => h.portId === pair.left)!;
    out.push({
      ...left,
      label: collapsedPairLabel(pair),
      stereoSiblingPortId: pair.right,
    });
  }
  return out;
}

/**
 * Every hole in a section list, clusters included, in render order.
 *
 * Exists because "the holes on this rail" used to be a bare array field and is
 * now two levels of nesting on BOTH rails — one flattening, one place, so a
 * caller cannot forget the clusters (which is exactly how a hole goes missing
 * from a check without going missing from the screen).
 */
export function rearSectionHoles(sections: readonly RearSection[]): RearHole[] {
  return sections.flatMap((s) => [...s.holes, ...s.clusters.flatMap((c) => c.holes)]);
}

/**
 * The DERIVED output grouping — the default under ~190 modules that author
 * nothing (#1800).
 *
 * ONE section (`out`) is the answer for a rail of two to four taps, and that is
 * almost every module: a heading over a one-row group is chrome, not grouping,
 * and a page projection (what the input side derives from) has no meaning for
 * outputs. The ONE split that is derivable from the CONTRACT rather than
 * guessed is by CABLE DOMAIN — `PortDef.type`, the same declaration the hole's
 * colour already reads — and it only earns its headings once the un-split rail
 * out-runs a column (`REAR_OUTPUT_SPLIT_ROWS`). That is what keeps a 30-tap
 * hardware interface or a 29-event game module scannable without any of them
 * having to be hand-authored first.
 *
 * ⚠ The split REINFORCES the colour channel rather than competing with it —
 * colour still means domain and nothing else. Direction is carried entirely by
 * `rear-direction.ts`'s non-colour channels.
 */
function derivedOutputSections(outs: RearHole[]): RearSection[] {
  if (outs.length === 0) return [];
  const domains = [...new Set(outs.map((h) => h.domain))];
  if (domains.length === 1 || outs.length <= REAR_OUTPUT_SPLIT_ROWS) {
    return [{ id: 'out', label: 'out', direction: 'output', holes: outs, clusters: [], columns: 1 }];
  }
  return domains.map((d) => ({
    id: `out-${d}`,
    label: `${d} out`,
    direction: 'output' as const,
    holes: outs.filter((h) => h.domain === d),
    clusters: [],
    columns: 1,
  }));
}

/**
 * Derive the full rear-card field plan for a def. Total by construction:
 * every declared port lands in exactly one section, on its own rail.
 */
export function rearFieldPlan(def: RearDefLike): RearFieldPlan {
  const inputs = def.inputs ?? [];
  const outputs = def.outputs ?? [];
  const params = def.params ?? [];
  const pages = def.face?.pages ?? [];
  const rear = def.face?.rear;
  const audioRate = new Set(rear?.audioRate ?? []);

  const paramIds = new Set(params.map((p) => p.id));
  const hole = (p: RearPortLike, dir: 'input' | 'output') => makeHole(p, dir, def, audioRate);

  // ---- authored groups claim their ports first (first listing wins) ----
  //
  // ⚠ KEYED BY (direction, portId), NEVER by portId alone. A port id may exist
  // on BOTH rails — `delay` declares an `audio` input and an `audio` output —
  // so a port-only key let an input group silently claim the output of the same
  // name, and the OUTPUT then vanished from its own rail. That was invisible
  // while outputs had no grouping at all; it is a live hazard the moment they
  // do.
  const allGroups = rear?.groups ?? [];
  const curatedGroups = allGroups.filter((g) => (g.direction ?? 'input') === 'input');
  const outputGroups = allGroups.filter((g) => g.direction === 'output');
  const inputPortIds = new Set(inputs.map((p) => p.id));
  const outputPortIds = new Set(outputs.map((p) => p.id));
  const curatedByPort = new Map<string, string>(); // portId → group id (INPUTS)
  for (const g of curatedGroups) {
    for (const pid of g.ports) {
      if (!inputPortIds.has(pid)) continue;
      if (!curatedByPort.has(pid)) curatedByPort.set(pid, g.id);
    }
  }

  // ---- derivation over the un-curated inputs ----
  const voice: RearPortLike[] = [];
  const byPage = new Map<string, Map<string, RearPortLike[]>>(); // pageId → paramId → ports
  const orphans: RearPortLike[] = [];
  const pageOfParam = new Map<string, string>();
  for (const page of pages) {
    for (const key of page.controls) pageOfParam.set(key, page.id);
  }
  for (const port of inputs) {
    if (curatedByPort.has(port.id)) continue;
    const target = rearTargetParamId(port);
    const isPerParamCv = target !== undefined && (port.paramTarget !== undefined || paramIds.has(target));
    if (!isPerParamCv) {
      voice.push(port);
      continue;
    }
    const pageId = pageOfParam.get(target!);
    if (!pageId) {
      orphans.push(port);
      continue;
    }
    let perParam = byPage.get(pageId);
    if (!perParam) byPage.set(pageId, (perParam = new Map()));
    const list = perParam.get(target!);
    if (list) list.push(port);
    else perParam.set(target!, [port]);
  }

  // ---- assemble INPUT sections: voice slot → page slots → extra → orphans ----
  const portById = new Map(inputs.map((p) => [p.id, p]));
  const inSections: RearSection[] = [];
  const usedGroupIds = new Set<string>();

  const curatedBand = (g: { id: string; label: string; ports: readonly string[] }): RearSection => ({
    id: g.id,
    label: g.label,
    direction: 'input',
    holes: g.ports
      .map((pid) => portById.get(pid))
      .filter((p): p is RearPortLike => p !== undefined && curatedByPort.get(p.id) === g.id)
      .map((p) => hole(p, 'input')),
    clusters: [],
    columns: 1,
  });

  // voice/signal slot — a curated 'voice'/'signal' group claims it.
  const voiceGroup = curatedGroups.find((g) => g.id === 'voice' || g.id === 'signal');
  if (voiceGroup) {
    usedGroupIds.add(voiceGroup.id);
    const band = curatedBand(voiceGroup);
    // Derived voice ports still land in the leading section (curation lists the
    // exceptions, it does not have to restate the whole section).
    band.holes.push(...voice.map((p) => hole(p, 'input')));
    if (band.holes.length > 0) inSections.push(band);
  } else if (voice.length > 0) {
    // 'voice' when the section carries gate/poly/pitch drive; 'signal' for a
    // processor's plain audio/cv feed (vca/cloudseed read as patchbays).
    const isVoice = voice.some(
      (p) => p.type === 'gate' || p.type === 'polyPitchGate' || p.type === 'pitch' || p.type === 'keys',
    );
    inSections.push({
      id: isVoice ? 'voice' : 'signal',
      label: isVoice ? 'voice' : 'signal',
      direction: 'input',
      holes: voice.map((p) => hole(p, 'input')),
      clusters: [],
      columns: 1,
    });
  }

  // page slots, face order. A curated group with the page's id claims the
  // slot (its label wins); derived per-param CVs for that page merge in,
  // page-control order.
  for (const page of pages) {
    const g = curatedGroups.find((gr) => gr.id === page.id);
    const band: RearSection = g
      ? (usedGroupIds.add(g.id), curatedBand(g))
      : { id: page.id, label: page.label, direction: 'input', holes: [], clusters: [], columns: 1 };
    const perParam = byPage.get(page.id);
    if (perParam) {
      for (const key of page.controls) {
        const ports = perParam.get(key);
        if (ports) band.holes.push(...ports.map((p) => hole(p, 'input')));
      }
    }
    if (band.holes.length > 0) inSections.push(band);
  }

  // extra curated groups (no page match), declaration order.
  for (const g of curatedGroups) {
    if (usedGroupIds.has(g.id)) continue;
    const band = curatedBand(g);
    if (band.holes.length > 0) inSections.push(band);
  }

  // trailing orphan section — per-param CVs whose target is in NO page.
  if (orphans.length > 0) {
    inSections.push({
      id: 'cv',
      label: 'cv',
      direction: 'input',
      holes: orphans.map((p) => hole(p, 'input')),
      clusters: [],
      columns: 1,
    });
  }

  // ---- ONE STEREO HOLE per derived pair, on BOTH rails ----
  //
  // INPUTS collapse AFTER grouping (a pair's legs can be authored into
  // different sections, and grouping is what decides which section owns the
  // surviving hole). OUTPUTS collapse BEFORE, because output sectioning is
  // itself derived FROM the holes — the domain split has to count the rows a
  // reader will actually see, and an authored output group must be free to
  // name EITHER leg of a pair.
  for (const band of inSections) {
    band.holes = collapseStereoHoles(band.holes, def, 'input');
  }
  const outHoles = collapseStereoHoles(
    outputs.map((p) => hole(p, 'output')),
    def,
    'output',
  );

  // ---- assemble OUTPUT sections: authored first, then the derived remainder --
  const outSections: RearSection[] = [];
  const claimedOut = new Set<string>();
  for (const g of outputGroups) {
    const member = new Set(g.ports.filter((pid) => outputPortIds.has(pid)));
    const holes = outHoles.filter(
      (h) =>
        !claimedOut.has(h.portId) &&
        (member.has(h.portId) || (h.stereoSiblingPortId !== undefined && member.has(h.stereoSiblingPortId))),
    );
    if (holes.length === 0) continue;
    for (const h of holes) claimedOut.add(h.portId);
    outSections.push({ id: g.id, label: g.label, direction: 'output', holes, clusters: [], columns: 1 });
  }
  outSections.push(...derivedOutputSections(outHoles.filter((h) => !claimedOut.has(h.portId))));

  // ---- clusters: pull listed holes out of their section into sub-headers ----
  // Runs LAST so it reaches either rail through one code path, and after the
  // stereo collapse so a cluster naming a collapsed leg still finds its hole.
  const sections = [...inSections, ...outSections];
  for (const c of rear?.clusters ?? []) {
    const band = sections.find((b) => b.id === c.group);
    if (!band) continue;
    const member = new Set(c.ports);
    const claims = (h: RearHole) =>
      member.has(h.portId) || (h.stereoSiblingPortId !== undefined && member.has(h.stereoSiblingPortId));
    const pulled = band.holes.filter(claims);
    if (pulled.length === 0) continue;
    band.holes = band.holes.filter((h) => !claims(h));
    band.clusters.push({ label: c.label, holes: pulled });
  }

  // ---- WIDTH IS EARNED BY CONTENT: a section's column count is derived from
  // its final row count, after grouping, collapse and cluster extraction have
  // all settled — anything earlier would size the column from a list that is
  // still moving.
  for (const sec of sections) {
    sec.columns = rearSectionColumns(
      sec.holes.length + sec.clusters.reduce((n, c) => n + c.holes.length, 0),
    );
  }

  const rowsIn = (list: readonly RearSection[]) =>
    list.reduce((n, b) => n + b.holes.length + b.clusters.reduce((m, c) => m + c.holes.length, 0), 0);
  const holeCount = rowsIn(inSections) + rowsIn(outSections);
  // Every declared port is addressed by exactly one hole; a stereo hole
  // addresses two. Summed from the holes, NOT from the def, so it is a real
  // check on the derivation rather than a restatement of the input.
  const countPorts = (list: readonly RearHole[]) =>
    list.reduce((n, h) => n + (h.stereoSiblingPortId ? 2 : 1), 0);
  const portCount = sections.reduce(
    (n, b) => n + countPorts(b.holes) + b.clusters.reduce((m, c) => m + countPorts(c.holes), 0),
    0,
  );

  return {
    inputs: inSections,
    outputs: outSections,
    holeCount,
    portCount,
    dense: holeCount > REAR_DENSE_ROWS,
  };
}

/**
 * Compatibility-dim predicate (spec §2.2, Bitwig pre-highlight inverted):
 * while a cable is carried, can it legally terminate on this hole? Pure —
 * mirrors the direction + canConnectToPort gate validateEdge applies at
 * commit, so a lit hole is exactly a hole a click would patch.
 *
 *  - carried OUTPUT ('source') → only INPUT holes the source cable can feed;
 *  - carried INPUT ('target', the one-motion rewire) → only OUTPUT holes
 *    whose cable the carried input accepts.
 *
 * `canConnect` is injected (a (src, dst-port) predicate) so the model stays
 * free of the graph-registry import cycle; callers pass canConnectToPort.
 */
export function rearHoleAcceptsCarry(
  hole: Pick<RearHole, 'direction' | 'cable'>,
  holeAccepts: readonly string[] | undefined,
  carried: { handleType: 'source' | 'target'; cableType?: string; accepts?: readonly string[] },
  canConnect: (
    src: string,
    dst: { type: string; accepts?: readonly string[] },
  ) => boolean,
): boolean {
  const carriedCable = carried.cableType ?? 'audio';
  if (carried.handleType === 'source') {
    return hole.direction === 'input' && canConnect(carriedCable, { type: hole.cable, accepts: holeAccepts });
  }
  return (
    hole.direction === 'output' &&
    canConnect(hole.cable, { type: carriedCable, accepts: carried.accepts })
  );
}
