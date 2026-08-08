// packages/web/src/lib/ui/workflow/rear-card-model.ts
//
// PURE derivation for the REAR CARD — the RACKLINE flip-side patch field the
// dock full-view shows on TAB (design: scratchpad rear-card-spec.md §1/§4/§5).
//
// The def's `inputs[]`/`outputs[]` ALREADY IS the one-function-per-hole list:
// the rear card renders EVERY declared port, one hole each, no synthesis and
// no elision. This module decides GROUPING + LABELING, nothing DOM:
//
//   voice   = inputs that are not per-param CVs (no paramTarget AND no
//             `<param>_cv` id match), in declared order → the leading
//             "voice"/"signal" band
//   pages   = for each `face.pages` page, the CV holes targeting that page's
//             params (target = port.paramTarget ?? stripSuffix(id, '_cv')),
//             in page-control order → one band per page (empty → no band)
//   orphans = per-param CVs whose target param is in NO page → trailing "cv"
//             band
//   outputs = def.outputs, declared order → the fixed OUTPUTS rail
//
// Optional curation extends `face` (UI metadata — contract untouched):
// `face.rear.groups` pins listed ports to an explicit band (claiming the
// voice slot / a page slot by id), `face.rear.clusters` adds sub-headers
// inside a band, `face.rear.audioRate` drives the `~` tick (no PortDef.rate
// field exists — spec §6 Q5 ships v1 with a curated list).
//
// Labels are by FUNCTION: a per-param CV hole takes its target param's label
// (CUTOFF, not CUTOFF_CV — the band header + `←` glyph already say "input");
// a `<x>_cv` port with no matching param labels from the stem; everything
// else falls back to the shared resolveVerboseLabel.
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

/** A cluster sub-header inside a band (envelopes → filter eg / amp eg). */
export interface RearCluster {
  label: string;
  holes: RearHole[];
}

/** One input group band. */
export interface RearBand {
  id: string;
  label: string;
  /** Un-clustered holes (render first, band order). */
  holes: RearHole[];
  /** Clustered holes (render after `holes`, declaration order). */
  clusters: RearCluster[];
}

export interface RearFieldPlan {
  /** Input bands: voice/signal first, then page bands, then extra curated
   *  groups, then the orphan "cv" band. Empty bands are dropped. */
  bands: RearBand[];
  /** The OUTPUTS rail, declared order. */
  outputs: RearHole[];
  /** Total RENDERED holes (inputs + outputs). A collapsed stereo pair is ONE
   *  hole, so this is ≤ the declared port count — see `portCount`. */
  holeCount: number;
  /** Declared ports ADDRESSED by those holes (a stereo hole addresses two).
   *  This is the no-orphan-holes guarantee and it always equals
   *  `inputs.length + outputs.length`; `holeCount` no longer can, now that a
   *  pair renders as one hole. Keeping both means the totality invariant is
   *  still assertable instead of quietly becoming untestable. */
  portCount: number;
  /** Pathology fallback (>REAR_COLLAPSE_THRESHOLD holes): bands render
   *  collapsed to their headers (jack-count pill, click to expand) — a
   *  visibility fallback, NEVER a cascading menu. No prototype needs it. */
  collapse: boolean;
  /** Outputs rail goes 2-col + dense cells past this many outs (spec §1.5). */
  denseRail: boolean;
}

/** Band-collapse pathology threshold (spec §1.5: "> ~60 holes"). */
export const REAR_COLLAPSE_THRESHOLD = 60;

/** Outputs-rail 2-column threshold (spec Appendix A: "2-col past 8 outs"). */
export const REAR_DENSE_RAIL_OUTPUTS = 8;

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
 * Derive the full rear-card field plan for a def. Total by construction:
 * every declared input lands in exactly one band, every output on the rail.
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

  // ---- curated groups claim their ports first (first listing wins) ----
  const curatedByPort = new Map<string, string>(); // portId → group id
  const curatedGroups = rear?.groups ?? [];
  for (const g of curatedGroups) {
    for (const pid of g.ports) {
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

  // ---- assemble bands: voice slot → page slots → extra curated → orphans ----
  const portById = new Map(inputs.map((p) => [p.id, p]));
  const bands: RearBand[] = [];
  const usedGroupIds = new Set<string>();

  const curatedBand = (g: { id: string; label: string; ports: readonly string[] }): RearBand => ({
    id: g.id,
    label: g.label,
    holes: g.ports
      .map((pid) => portById.get(pid))
      .filter((p): p is RearPortLike => p !== undefined && curatedByPort.get(p.id) === g.id)
      .map((p) => hole(p, 'input')),
    clusters: [],
  });

  // voice/signal slot — a curated 'voice'/'signal' group claims it.
  const voiceGroup = curatedGroups.find((g) => g.id === 'voice' || g.id === 'signal');
  if (voiceGroup) {
    usedGroupIds.add(voiceGroup.id);
    const band = curatedBand(voiceGroup);
    // Derived voice ports still land in the leading band (curation lists the
    // exceptions, it does not have to restate the whole band).
    band.holes.push(...voice.map((p) => hole(p, 'input')));
    if (band.holes.length > 0) bands.push(band);
  } else if (voice.length > 0) {
    // 'voice' when the band carries gate/poly/pitch drive; 'signal' for a
    // processor's plain audio/cv feed (vca/cloudseed read as patchbays).
    const isVoice = voice.some(
      (p) => p.type === 'gate' || p.type === 'polyPitchGate' || p.type === 'pitch' || p.type === 'keys',
    );
    bands.push({
      id: isVoice ? 'voice' : 'signal',
      label: isVoice ? 'voice' : 'signal',
      holes: voice.map((p) => hole(p, 'input')),
      clusters: [],
    });
  }

  // page slots, face order. A curated group with the page's id claims the
  // slot (its label wins); derived per-param CVs for that page merge in,
  // page-control order.
  for (const page of pages) {
    const g = curatedGroups.find((gr) => gr.id === page.id);
    const band: RearBand = g
      ? (usedGroupIds.add(g.id), curatedBand(g))
      : { id: page.id, label: page.label, holes: [], clusters: [] };
    const perParam = byPage.get(page.id);
    if (perParam) {
      for (const key of page.controls) {
        const ports = perParam.get(key);
        if (ports) band.holes.push(...ports.map((p) => hole(p, 'input')));
      }
    }
    if (band.holes.length > 0) bands.push(band);
  }

  // extra curated groups (no page match), declaration order.
  for (const g of curatedGroups) {
    if (usedGroupIds.has(g.id)) continue;
    const band = curatedBand(g);
    if (band.holes.length > 0) bands.push(band);
  }

  // trailing orphan band — per-param CVs whose target is in NO page.
  if (orphans.length > 0) {
    bands.push({ id: 'cv', label: 'cv', holes: orphans.map((p) => hole(p, 'input')), clusters: [] });
  }

  // ---- clusters: pull listed holes out of their band into sub-headers ----
  for (const c of rear?.clusters ?? []) {
    const band = bands.find((b) => b.id === c.group);
    if (!band) continue;
    const member = new Set(c.ports);
    const pulled = band.holes.filter((h) => member.has(h.portId));
    if (pulled.length === 0) continue;
    band.holes = band.holes.filter((h) => !member.has(h.portId));
    band.clusters.push({ label: c.label, holes: pulled });
  }

  // ---- ONE STEREO HOLE per derived pair, on BOTH rails ----
  for (const band of bands) {
    band.holes = collapseStereoHoles(band.holes, def, 'input');
    for (const cluster of band.clusters) {
      cluster.holes = collapseStereoHoles(cluster.holes, def, 'input');
    }
  }
  const outs = collapseStereoHoles(
    outputs.map((p) => hole(p, 'output')),
    def,
    'output',
  );

  const bandHoles = bands.reduce(
    (n, b) => n + b.holes.length + b.clusters.reduce((m, c) => m + c.holes.length, 0),
    0,
  );
  const holeCount = bandHoles + outs.length;
  // Every declared port is addressed by exactly one hole; a stereo hole
  // addresses two. Summed from the holes, NOT from the def, so it is a real
  // check on the derivation rather than a restatement of the input.
  const countPorts = (list: readonly RearHole[]) =>
    list.reduce((n, h) => n + (h.stereoSiblingPortId ? 2 : 1), 0);
  const portCount =
    bands.reduce(
      (n, b) => n + countPorts(b.holes) + b.clusters.reduce((m, c) => m + countPorts(c.holes), 0),
      0,
    ) + countPorts(outs);

  return {
    bands,
    outputs: outs,
    holeCount,
    portCount,
    collapse: holeCount > REAR_COLLAPSE_THRESHOLD,
    denseRail: outs.length > REAR_DENSE_RAIL_OUTPUTS,
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
