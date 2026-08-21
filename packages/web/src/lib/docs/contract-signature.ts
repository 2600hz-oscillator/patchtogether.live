// packages/web/src/lib/docs/contract-signature.ts
//
// The DETERMINISTIC contract projection for the living-docs drift gate
//. This is the "what is
// pinned" layer — the analog of ART's `moduleSourceSha` and VRT's baseline
// image, applied to a module's I/O CONTRACT instead of audio/pixels.
//
// It projects each registered module def to a CANONICAL, whitelisted, fully
// sorted text form (the API-Extractor `.api.md` golden pattern). The committed
// golden lives at `contract-lock.txt`; the `contract-lock.test.ts` gate
// regenerates this text from the LIVE registry and string-compares — any port
// added/removed/renamed/retyped, any param range/curve/default change, any
// stereo/expose/control-family change produces a readable line diff and fails
// CI until a human re-pins (`task docs:accept`) or recognizes a bug.
//
// WHY a whitelisted projection (never the whole def): adding a `factory`,
// `migrate`, `card`, `palette`, or a cosmetic `label`/`category` field must NOT
// churn the contract — only the I/O + persistence-shaping surface is the
// contract. WHY readable text (not a sha): `git diff contract-lock.txt` IS the
// review surface (unlike pixels, you can read it), and one-line-per-element
// keeps merges line-granular (the Roslyn PublicAPI.txt lesson).
//
// PURE + browser-safe: no node:crypto, no fs — just string building, so it is
// importable from anywhere. The gate test owns the fs read/write + the
// side-effect registry imports.

import { listModuleDefs } from '$lib/audio/module-registry';
import { listVideoModuleDefs } from '$lib/video/module-registry';
import { listMetaModuleDefs } from '$lib/meta/module-registry';
import type {
  ControlFamily,
  ModuleDocs,
  ModuleFace,
} from '$lib/graph/types';

/** The minimal structural shape the projection reads off any registered def
 *  (audio / video / meta). Everything optional so each domain's def shape
 *  satisfies it; unknown extra fields are ignored (whitelist by construction). */
interface ContractDefLike {
  type: string;
  domain: string;
  inputs?: readonly ContractPortLike[];
  outputs?: readonly ContractPortLike[];
  params?: readonly ContractParamLike[];
  stereoPairs?: readonly (readonly [string, string])[];
  maxInstances?: number;
  exposesSequence?: boolean;
  undeletable?: boolean;
  ownerOnly?: boolean;
  /** Off-main-thread render routing (video defs). engine.ts consults this to
   *  pick the WorkerProxyHandle path — behavioral contract, not cosmetics. */
  renderLocus?: string;
  /** Module-grouping viz-passthrough flag — behavioral (GroupCard portals the
   *  on-card canvas), same class as exposesSequence/undeletable. */
  vizPassthrough?: boolean;
  exposableControls?: readonly { id: string; paramId?: string; kind?: string }[];
  controlFamilies?: readonly ControlFamily[];
  /** ⚠ NO face field is projected into the golden — `FACE_FIELDS_NOT_IN_LOCK`
   *  below names every field with the gate that covers it instead. */
  face?: ModuleFace;
}
interface ContractPortLike {
  id: string;
  type: string;
  paramTarget?: string;
  cvScale?: { mode: string; depth?: number };
  accepts?: readonly string[];
  edge?: 'trigger' | 'gate';
  adoptsUpstreamFrom?: string;
}
interface ContractParamLike {
  id: string;
  defaultValue: number;
  min: number;
  max: number;
  curve: string;
  units?: string;
}

const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
const num = (n: number): string => String(n);

/**
 * EVERY `ModuleFace` FIELD, EACH NAMED WITH WHAT DOES COVER IT.
 *
 * ⚠ NOTHING IN `face` IS PROJECTED ANY MORE, and that is a RESULT rather than a
 * reversal. `sidebar` was the one projected field — it earned the line because
 * #1468 deleted a sidebar block from twelve modules with every other gate
 * green. The field itself is now DELETED platform-wide (owner, 2026-08-19; see
 * `ModuleFaceHero` in graph/types.ts), so there is no block left to pin and
 * `FACE_FIELDS_IN_LOCK` is legitimately empty. The ledger below is what still
 * makes that a DECISION rather than an omission.
 *
 * ⚠ THIS IS THE POINT OF THE LEDGER, NOT AN APOLOGY FOR IT. The defect it came
 * from was not "sidebar was missing" — it was that NOTHING ENUMERATED THE FIELDS, so
 * a field could be absent from the golden without anyone ever deciding it
 * should be. `contract-lock.test.ts` walks the keys actually present on every
 * registered def's `face` and requires each to be either PROJECTED or named
 * here; a key that is neither turns the gate RED, and an entry naming a key no
 * def uses turns it red too (anchored to the artifact, so a licence cannot
 * outlive its subject). Adding a field to `ModuleFace` is therefore a decision
 * someone has to write down.
 *
 * `why` and `coveredBy` are REQUIRED by the type — `tsc` refuses the
 * undeclared form before a test runs.
 */
export const FACE_FIELDS_NOT_IN_LOCK: Readonly<
  Record<string, { why: string; coveredBy: string }>
> = {
  order: {
    why: 'The curated control ORDER is a layout decision, and every key in it is already pinned as a param/family line. Reordering changes no contract and no behaviour.',
    coveredBy: 'module-face-lint (every key resolves to a param/family) + faces-parity (the exact rendered multiset).',
  },
  pages: {
    why: 'Band grouping and captions. Structural, but pinned somewhere a text golden cannot be: the dock RENDER, per band, where a dropped page is visible as a missing section.',
    coveredBy: 'VRT face-<type>-dock (band layout) + the openDock toHaveCount(pages) structural assert + dock-row-plan units.',
  },
  glyph: {
    why: 'Which live trace the shell taps for the tile. A change is a pixel change by construction.',
    coveredBy: 'VRT face-<type>-compact + vrt-face-audio-probe.',
  },
  glyphDepthGain: {
    why: 'A scalar on the glyph trace. Same argument as glyph — visible only as pixels.',
    coveredBy: 'VRT face-<type>-compact.',
  },
  extension: {
    why: 'Which bespoke-surface extension module the shell lazily resolves (#1512). Pure UI wiring — which component fills a shell slot — and a rebinding is a pixel change on surfaces the VRT scenes pin, never an I/O change any consumer reads.',
    coveredBy: 'shell-extensions.test.ts (declared id ↔ discovered module, both directions; algorithm glyphs must resolve) + module-shell-import-guard + VRT face-<type>-*.',
  },
  paramCells: {
    why: 'Which PRIMITIVE renders a param (grid/color/fader). Not the range or the mapping, which are pinned on the param line; the widget choice.',
    coveredBy: 'shell-cells (every key resolves to a registered cell spec) + param-cell-coverage + faces-parity driveCell.',
  },
  xyPads: {
    why: 'Which PAIRS of params are one 2-D gesture rather than two dials. Like paramCells it is a widget choice, not a mapping: each axis keeps its own ParamDef line, and the pad reads its min/max straight off that line per axis — so the RANGES stay pinned in the lock exactly as before and only the affordance moves. Declared rather than inferred because nothing in a pair of ParamDefs says "these two are one gesture".',
    coveredBy: 'module-face-lint xyPadProblems (both axes declared, ranked, non-momentary, CONTINUOUS, claimed once, x !== y — with a negative control per clause) + param-cell-coverage (the `xy` kind is exercised by a real adopter) + faces-parity driveCell + VRT face-<type>-dock.',
  },
  momentary: {
    why: 'Marks a param as press-and-release. It changes how a cell is DRIVEN, and the audition ledger is the observable — a text line would restate what the probe measures.',
    coveredBy: 'faces-parity ShellActionCell.probe + audition-ledger (both directions, unit lane, every run).',
  },
  channelAccent: {
    why: 'WHICH COLOUR a cell paints in — the rack lane colour of the channel it belongs to (#1825). No id in it is new (every one is already a pinned param line) and no I/O changes; what it selects is a CSS custom property. A text golden would restate the def\'s own param list and still say nothing about whether the colour arrives, which is a live DOM question.',
    coveredBy:
      'mixmstrs-face-model.test.ts (the declaration and `mixmstrsChannelIndex` partition the def by channel, both directions, plus the bus-scoped refusal) + module-face-lint (every declared id resolves, no duplicates, the declaring roster) + the mixmstrs-face-grid e2e, which reads the RESOLVED `--_ka` off each control and matches it against `laneColorEff` + VRT face-mixmstrs-dock.',
  },
  bareCells: {
    why: "Which cells paint no CAPTION at the dock. It removes TEXT and nothing else — `aria-label`, the annotate menu's title and MIDI-learn's address all still carry the param's `label`, so no consumer of the contract can observe it. Declared per param rather than per face because it encodes REDUNDANCY against a section heading, which only the module knows (owner, 2026-08-17: mixmstrs' `1LO…8LO` go, tidyVco's `A`/`D`/`S`/`R` stay).",
    coveredBy: 'module-face-lint (every id is a declared param, ranked in `order`, no duplicates) + face-readout-source.test.ts + VRT face-<type>-dock, where a missing caption is exactly a pixel change.',
  },
  rear: {
    why: 'Rear-card port grouping/clusters/audio-rate ticks. Every PORT it arranges is already a pinned `in`/`out` line; this is the arrangement.',
    coveredBy: 'rear-card-model units + VRT rear-<type>.',
  },
  title: {
    why: 'Display text on the faceplate. Faces carry near-zero authored prose by owner ruling, and a title change is a pixel change.',
    coveredBy: 'VRT face-<type>-dock.',
  },
  hint: {
    why: 'Display text under the title, same argument as title: a faceplate states values, the explanation lives in `docs`, and a change here is a change to pixels rather than to any contract a consumer reads.',
    coveredBy: 'VRT face-<type>-dock + the faceplate-platform annotation sweep.',
  },
  hero: {
    why: 'Which keys are PROMOTED into the hero slot. A promotion removes the key from its band rather than duplicating it, so the move is already gated by an exact multiset comparison that a text line could not improve on.',
    coveredBy: "faces-parity's exact param multiset (a duplicate/unknown is an unbacked extra) + dock-faceplate-model heroFacePlan pins + VRT face-<type>-dock.",
  },
  tabbed: {
    why: 'Forces the dock TAB RAIL on below the band threshold. It changes no I/O and no control — the same params render either way, one band at a time instead of a column — so it is a LAYOUT decision whose failure mode is pixels, not contract. It is also the field with the tightest non-golden gate in the repo, which is why a golden line would add nothing: it is OWNER-INSTRUCTION-ONLY and every adopter is named with the instruction verbatim.',
    coveredBy:
      'dock-tabs-model.test.ts FACE_TAB_OPT_IN (deny-by-default per module, anchored both directions, instruction quoted) + the live-registry tabbed roster + VRT face-<type>-dock.',
  },
  monitor: {
    why: 'MONITOR MODE (#2009) — the face may hide its control bands and be watched as a picture, driven by the persisted `node.data.hideControls` key. It changes no I/O and no control: the same params render, and the mode is a per-NODE runtime state that is absent (⇒ off) on every freshly opened faceplate, so a text golden of the DECLARATION would say nothing about the thing that can actually break. What CAN break is the pairing — a declaration with no toggle to reach it, or a promotion that drops the toggle a legacy card was carrying — and that is a two-sided source relationship a one-sided golden line cannot express. ⚠ It is deliberately NOT the same field as the SCREEN switch and must never be folded into one: SCREEN hides the PICTURE and keeps the controls, MONITOR hides the CONTROLS and keeps the picture (#1865 proposed the opposite).',
    coveredBy:
      'face-monitor-source.test.ts (deny-by-default BOTH ways: a declaring face must own a fullViewBody that reads+writes `hideControls` and exposes a button, AND a faced module whose legacy card still mounts `hideControls` must declare it — anchored exemptions, with the SCREEN/MONITOR key pair pinned as distinguishable) + module-shell-model.test.ts faceMonitorPlan (the exhaustive "never a blank plate" invariant) + video-hide-controls.spec.ts faced leg (the render: bands gone, picture and toggle still there).',
  },
  bandFocus: {
    why: 'BAND FOCUS (owner ruling, 2026-08-20) — a PARAM VALUE decides which control bands render, so the picture and the controls steering it share the plate. It changes no I/O and no control: every param still resolves the same cell, and the same set is reachable — the declaration only says WHEN each band is drawn. ⚠ A text golden would be actively misleading here, because the thing that breaks is not the declaration but its TOTALITY: `visibleBandIds` deliberately fails OPEN (a value nobody claimed shows every band, so the feature can never LOSE a control), which means a gap is invisible on screen and equally invisible in a golden line listing the same field. What has to be checked is a relationship between the roster of a param and the set of declared pages, and that is not expressible as a signature. ⚠ Distinct from `monitor` next door and must not be folded into it: MONITOR hides ALL bands on a per-node runtime toggle; BAND FOCUS hides all-but-one from a PERSISTED param, and its default state is FOCUSED rather than off — which is why it needed a parity-sweep change where monitor mode did not.',
    coveredBy:
      'band-focus-model.test.ts (the predicate + `bandFocusIsTotal`, with negative controls for unclaimed / duplicated / unknown-band / out-of-range / inert) + module-face-lint.test.ts BAND FOCUS (the same totality checker run over every live adopter, plus a non-vacuity floor requiring one) + face-resting-text-source.test.ts (the shell may read the predicate and never the `why`) + faces-parity.spec.ts (`showAllBands` walks at a declared show-all value so no cell is unreachable, and the focused-absence leg proves the other bands are GONE rather than merely declared).',
  },
  rackStatus: {
    why: 'RACK-GLOBAL STATUS (#2024, owner ruling 2026-08-21 "close the gap") — which OTHER nodes exist decides whether a band renders. It changes no I/O and no control: every param still resolves the same cell and the same set is reachable on the instance that owns the resource; the declaration only says WHICH INSTANCE draws the band. ⚠ A text golden is the wrong instrument here for a sharper reason than `bandFocus` next door: what has to hold is a relationship between this declaration and a RUNTIME FACT ABOUT THE PATCH — that `primaryOnlyBands` names the bands whose controls are inert on a non-primary node, and that the platform\'s "who is primary" rule still agrees with the module\'s own allocator. A signature line reading `rackStatus peers=cvBuddy,cvBuddyMini` would be byte-identical on the day those two rules diverged and the face began hiding the clock band on the instance that owns the clock. ⚠ Distinct from BOTH neighbours and must not be folded into either: `monitor` is a per-node RUNTIME TOGGLE and `bandFocus` a per-node PARAM VALUE, while this is a property of the graph that no ParamDef can represent — it changes when a DIFFERENT node is added or deleted, and neither of the others can observe that.',
    coveredBy:
      'rack-status-model.test.ts (the predicate + the never-a-blank-plate precondition, exhaustively, with all three "hide nothing" routes asserted separately and negative controls in both directions) + face-rack-status-source.test.ts (deny-by-default BOTH ways: a declaring face must own a `fullViewBody` that reads the patch and paints through `StatusLed`, its `primaryOnlyBands` must name real declared bands and its `peers` real registered types; plus the extension-body TEXT ROLE roster that converts face-resting-text-source\'s canvas blind spot to deny-by-default) + cv-buddy-face-model.test.ts (the platform\'s primary rule vs the module\'s own allocator, exhaustively over every kind-combination up to four instances, so a divergence is named rather than silently mis-hiding) + cv-buddy-face.spec.ts (the render: a real SECOND instance loses the band, the first keeps it, and the status body still paints).',
  },
};

/** One INPUT/OUTPUT port → a canonical line body (sans the `<type> in/out`
 *  prefix). Fields appear in a fixed order; absent fields are omitted. */
function portLine(p: ContractPortLike): string {
  const parts = [p.id, p.type];
  if (p.paramTarget) parts.push(`param=${p.paramTarget}`);
  if (p.cvScale) {
    parts.push(`cvScale=${p.cvScale.mode}${p.cvScale.depth !== undefined ? `:${num(p.cvScale.depth)}` : ''}`);
  }
  if (p.accepts && p.accepts.length) parts.push(`accepts=${[...p.accepts].sort().join(',')}`);
  if (p.edge) parts.push(`edge=${p.edge}`);
  if (p.adoptsUpstreamFrom) parts.push(`adopts=${p.adoptsUpstreamFrom}`);
  return parts.join(' ');
}

/** All canonical lines for ONE module, deterministically ordered. Each line is
 *  prefixed with the module `type` so the golden greps + merges line-granular. */
export function serializeModuleContract(def: ContractDefLike): string[] {
  const t = def.type;
  const lines: string[] = [];

  // meta line: domain + persistence-shaping flags (sorted flag order).
  const meta = [`domain=${def.domain}`];
  if (def.maxInstances !== undefined) meta.push(`maxInstances=${num(def.maxInstances)}`);
  if (def.exposesSequence) meta.push('exposesSequence');
  if (def.undeletable) meta.push('undeletable');
  if (def.ownerOnly) meta.push('ownerOnly');
  if (def.renderLocus) meta.push(`renderLocus=${def.renderLocus}`);
  if (def.vizPassthrough) meta.push('vizPassthrough');
  lines.push(`${t} meta ${meta.join(' ')}`);

  for (const p of [...(def.inputs ?? [])].sort(byId)) lines.push(`${t} in ${portLine(p)}`);
  for (const p of [...(def.outputs ?? [])].sort(byId)) lines.push(`${t} out ${portLine(p)}`);
  for (const p of [...(def.params ?? [])].sort(byId)) {
    const unit = p.units ? ` unit=${p.units}` : '';
    lines.push(`${t} param ${p.id} ${num(p.min)}..${num(p.max)} ${p.curve} default=${num(p.defaultValue)}${unit}`);
  }
  // stereo pairs: order WITHIN a pair is meaningful (L,R); sort the LIST.
  const pairs = [...(def.stereoPairs ?? [])].map(([l, r]) => `${l}+${r}`).sort();
  for (const s of pairs) lines.push(`${t} stereo ${s}`);
  // exposable controls: pin the id AND its param binding + primitive kind —
  // the id keys GroupData.exposedControls persistence, the paramId decides
  // WHAT a group-bar control writes (an id↔param rebinding is a contract
  // change even when the id survives).
  for (const c of [...(def.exposableControls ?? [])].sort(byId)) {
    const paramPart = c.paramId ? ` param=${c.paramId}` : '';
    const kindPart = c.kind ? ` kind=${c.kind}` : '';
    lines.push(`${t} expose ${c.id}${paramPart}${kindPart}`);
  }
  for (const f of [...(def.controlFamilies ?? [])].sort(byId)) {
    lines.push(
      `${t} family ${f.id} kind=${f.kind} prefix=${f.testidPrefix}${f.countParam ? ` count=${f.countParam}` : ''}`,
    );
  }
  return lines;
}

/** The `ModuleFace` keys `serializeModuleContract` actually projects. Read by
 *  the coverage gate so "projected" is derived from this list rather than
 *  re-typed there.
 *
 *  ⚠ EMPTY IS THE CORRECT VALUE TODAY, and the coverage gate is what makes that
 *  safe: it walks the keys live defs actually declare and requires each to be
 *  in this list or in `FACE_FIELDS_NOT_IN_LOCK`. An empty list therefore means
 *  "every face key is covered by a named non-golden gate", asserted, not
 *  "nobody checked". */
export const FACE_FIELDS_IN_LOCK: readonly string[] = [];

/** Every registered def (audio + video + meta), sorted by type. Requires the
 *  module barrels to have been side-effect-imported (the gate test does this). */
export function getContractDefs(): ContractDefLike[] {
  const all = [
    ...(listModuleDefs() as unknown as ContractDefLike[]),
    ...(listVideoModuleDefs() as unknown as ContractDefLike[]),
    ...(listMetaModuleDefs() as unknown as ContractDefLike[]),
  ];
  return all.slice().sort((a, b) => a.type.localeCompare(b.type));
}

const HEADER = [
  '# contract-lock.txt — DETERMINISTIC module I/O contract golden (living-docs gate).',
  '# Generated; DO NOT hand-edit. Regenerate after an INTENTIONAL contract change:',
  '#   flox activate -- task docs:accept            (all modules)',
  '#   flox activate -- task docs:accept -- <type>  (one module)',
  '# A diff here means a module contract changed: re-author the doc + re-pin, OR',
  '# recognize it as a bug/side-effect. The docs-drift gate fails on any mismatch.',
].join('\n');

/** The full committed golden text for the whole registry. Deterministic +
 *  trailing-newline-terminated so the file is POSIX-clean. */
export function serializeContractLock(defs: ContractDefLike[] = getContractDefs()): string {
  const body = defs.flatMap((d) => serializeModuleContract(d)).join('\n');
  return `${HEADER}\n${body}\n`;
}

// ---- AUTHORED docs → generated render module (prerender-safe) ----
// The doc page prerenders and CANNOT import the live registry (worklet ?url /
// .wasm in the factories break SSR), so it cannot read `def.docs` directly.
// We emit the authored docs into a plain data module the page CAN import.
// The emitted file is a gitignored BUILD ARTIFACT (LoC campaign row 4), NOT a
// committed source: regenerated by the docs:ensure seam (vitest.global-setup /
// `task docs:ensure` / the vite plugin), gated by module-docs-ensure.test.ts.

/** Canonicalize one module's docs: keep only present sections, sort sub-keys
 *  so the emitted module is deterministic regardless of authoring order. */
function canonDocs(docs: ModuleDocs): ModuleDocs {
  const out: ModuleDocs = {};
  if (docs.explanation) out.explanation = docs.explanation;
  for (const section of ['inputs', 'outputs', 'controls'] as const) {
    const m = docs[section];
    if (m && Object.keys(m).length) {
      const sorted: Record<string, string> = {};
      for (const k of Object.keys(m).sort()) sorted[k] = m[k];
      out[section] = sorted;
    }
  }
  return out;
}

/** Sorted map of every authored module's docs (defs without `docs` omitted). */
export function getDocsByType(): Record<string, ModuleDocs> {
  const all = [
    ...(listModuleDefs() as unknown as { type: string; docs?: ModuleDocs }[]),
    ...(listVideoModuleDefs() as unknown as { type: string; docs?: ModuleDocs }[]),
    ...(listMetaModuleDefs() as unknown as { type: string; docs?: ModuleDocs }[]),
  ].slice().sort((a, b) => a.type.localeCompare(b.type));
  const out: Record<string, ModuleDocs> = {};
  for (const def of all) if (def.docs) out[def.type] = canonDocs(def.docs);
  return out;
}

/** The `module-docs.generated.ts` content (a plain data module the prerendered
 *  doc page imports). Emitted at build/test time — never committed. */
export function serializeModuleDocsModule(map: Record<string, ModuleDocs> = getDocsByType()): string {
  return (
    '// GENERATED BUILD ARTIFACT (`task docs:ensure`) — DO NOT EDIT, DO NOT COMMIT (gitignored).\n' +
    "// Source of truth: each module def's co-located `docs` field. The prerendered\n" +
    '// doc page imports this because it cannot import the live registry. Regenerated\n' +
    '// by the docs:ensure seam (unit sweep / dev boot / build); gated by module-docs-ensure.test.ts.\n' +
    "import type { ModuleDocs } from '$lib/graph/types';\n\n" +
    `export const MODULE_DOCS: Record<string, ModuleDocs> = ${JSON.stringify(map, null, 2)};\n`
  );
}
