// packages/web/src/lib/ui/workflow/module-face-lint.test.ts
//
// The drift GATE for the workflow-mode UI-CURATION system — the face analog of
// module-docs-lint.test.ts. Pure-unit, zero-flake: it reads the live registry
// and checks each co-located `face`:
//
//  1. CONSISTENCY (all faced modules): every `face.order` / `face.pages` key
//     resolves to a real param, a DECLARED control family (`<familyId>-{n}`),
//     or a numbered-legend STATIC key; every page control is also in `order`;
//     `glyph` is a valid kind; `order` has no duplicates. This is the
//     orphan-rot guard — rename/remove a control and its stale face key fails.
//
//  2. COMPLETENESS (STRICT_FACES set only): every param, every declared control
//     family, and every numbered-legend STATIC control appears in `face.order`,
//     and every page control is in `order` — the deny(missing-curation)
//     guarantee, so a NEW control on a promoted module fails until it's ranked.
//
//  3. RATCHET FLOOR: |STRICT_FACES| only grows (frozen at today's size).
//
// `face` is UI curation, NOT the I/O contract — it is deliberately OUT of
// contract-signature.ts / contract-lock.txt. This gate is its pin.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import '$lib/audio/modules';
import '$lib/video/modules';
import '$lib/meta/modules';

import { listModuleDefs } from '$lib/audio/module-registry';
import { listVideoModuleDefs } from '$lib/video/module-registry';
import { listMetaModuleDefs } from '$lib/meta/module-registry';
import type { ControlFamily, ModuleFace, ParamDef } from '$lib/graph/types';
import { staticKey, type LegendEntry } from '$lib/docs/control-doc-resolver';
import { STRICT_FACES } from './strict-faces';
import { curatedFace, dockFacePlan, dockPlanControls, type FaceDefLike } from './curated-face';
import { DOCK_TAB_MIN_BANDS, dockTabPlan } from './dock-tabs-model';
import {
  heroFacePlan,
  heroFacePlanIsTotal,
  isUsableReadout,
  sidebarPlan,
  type FaceplateDefLike,
} from './dock-faceplate-model';
import { sidebarPanelIds } from './sidebar-panels';
import { faceReadoutValueIds } from './face-readout-values';
import { laneBodyPlan } from './module-shell-model';
import { looksLikeSwitch } from './shell-control-kind';
import { panelCellKeys, shellCellFor } from './shell-cells';
import { GRID_MAX_CELLS } from '$lib/ui/controls/param-grid-model';

interface FaceDef {
  type: string;
  inputs?: readonly { id: string }[];
  outputs?: readonly { id: string }[];
  params?: readonly ParamDef[];
  controlFamilies?: readonly ControlFamily[];
  face?: ModuleFace;
  /** The co-located AUTHORED prose — cross-examined against the momentary /
   *  latching classification (see the ACKNOWLEDGED_LATCHING cross-check). */
  docs?: { controls?: Record<string, string> };
}

/** Committed numbered-face legends (e2e/vrt/__annotated__/<type>.legend.json) —
 *  the full on-card control roster (the static buttons have no param/family in
 *  the def, so the legend is their only enumeration). SIX `../` from this file
 *  (workflow → ui → lib → src → web → packages → repo root) — one deeper than
 *  the docs-lint sibling, which lives at lib/docs. */
function loadLegends(): Record<string, LegendEntry[]> {
  const dir = fileURLToPath(new URL('../../../../../../e2e/vrt/__annotated__/', import.meta.url));
  const out: Record<string, LegendEntry[]> = {};
  let files: string[] = [];
  try {
    files = readdirSync(dir);
  } catch {
    return out;
  }
  for (const f of files) {
    if (!f.endsWith('.legend.json')) continue;
    const j = JSON.parse(readFileSync(`${dir}${f}`, 'utf8')) as { type?: string; controls?: LegendEntry[] };
    if (j.type) out[j.type] = j.controls ?? [];
  }
  return out;
}
const LEGENDS = loadLegends();

function allDefs(): FaceDef[] {
  return [
    ...(listModuleDefs() as unknown as FaceDef[]),
    ...(listVideoModuleDefs() as unknown as FaceDef[]),
    ...(listMetaModuleDefs() as unknown as FaceDef[]),
  ].sort((a, b) => a.type.localeCompare(b.type));
}

const FAMILY_KEY = /^(.+)-\{n\}$/;
// 'algorithm' (PF-15) is the DATA-DERIVED topology glyph — see ModuleFace.glyph.
const VALID_GLYPHS = new Set(['scope', 'meter', 'envelope', 'waveform', 'algorithm', 'none']);

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Is a legend test id a MEMBER of one of the module's declared families
 *  (`<testidPrefix>-{id}-<i>`)? Such members are represented in `face.order` by
 *  the family TEMPLATE, not individually — so completeness covers them via the
 *  family requirement, not as static keys. */
function isFamilyMember(testid: string, families: readonly ControlFamily[]): boolean {
  return families.some((f) => new RegExp(`^${escapeRe(f.testidPrefix)}-\\{id\\}-\\d+$`).test(testid));
}

/** The set of face keys a module's legend legitimizes as STATIC controls — the
 *  nodeId-stripped test id of every non-`control-`, non-family-member entry. */
function legendStaticKeys(def: FaceDef): Set<string> {
  const fams = def.controlFamilies ?? [];
  const out = new Set<string>();
  for (const e of LEGENDS[def.type] ?? []) {
    if (e.testid.startsWith('control-')) continue; // a param → keyed by paramId
    if (isFamilyMember(e.testid, fams)) continue; // → keyed by `<family>-{n}`
    out.add(staticKey(e.testid));
  }
  return out;
}

/** Does a single face key resolve against this def (param | declared family |
 *  legend static)? The shared consistency predicate. */
function keyResolves(key: string, def: FaceDef): boolean {
  const fam = key.match(FAMILY_KEY);
  if (fam) return (def.controlFamilies ?? []).some((f) => f.id === fam[1]);
  if ((def.params ?? []).some((p) => p.id === key)) return true;
  return legendStaticKeys(def).has(key);
}

describe('module-face lint — consistency (all faced modules)', () => {
  it('every face.order / face.pages key resolves to a real param / family / static control', () => {
    const orphans: string[] = [];
    for (const def of allDefs()) {
      const face = def.face;
      if (!face) continue;
      const orderSet = new Set(face.order);

      for (const key of face.order) {
        if (!keyResolves(key, def)) {
          orphans.push(`${def.type}: face.order['${key}'] → no such param / family / numbered control`);
        }
      }
      for (const page of face.pages ?? []) {
        for (const key of page.controls) {
          if (!keyResolves(key, def)) {
            orphans.push(`${def.type}: face.pages['${page.id}']['${key}'] → no such param / family / numbered control`);
          }
          if (!orderSet.has(key)) {
            orphans.push(`${def.type}: face.pages['${page.id}']['${key}'] is not in face.order (a page control must be ranked)`);
          }
        }
      }
    }
    expect(orphans.join('\n'), 'orphaned face keys — a rename/remove drifted the curation; fix the keys').toBe('');
  });

  it('every face.pages cluster names controls that page actually claims, once', () => {
    // ModuleFacePage.clusters is a GROUPING HINT over keys the page already
    // lists — never a second membership list. curated-face silently ignores a
    // cluster key the page does not claim (so an authoring slip can never
    // smuggle an unranked control into the dock, and never double-render one),
    // which means the slip would be INVISIBLE without this gate: the author
    // writes a sub-header and the control quietly renders in the flat row
    // instead. Fail it loudly here.
    const problems: string[] = [];
    for (const def of allDefs()) {
      for (const page of def.face?.pages ?? []) {
        const claims = new Set(page.controls);
        const seen = new Set<string>();
        for (const cluster of page.clusters ?? []) {
          if (!cluster.label.trim()) {
            problems.push(`${def.type}: face.pages['${page.id}'] has a cluster with a blank label`);
          }
          if (cluster.controls.length === 0) {
            problems.push(
              `${def.type}: face.pages['${page.id}'] cluster '${cluster.label}' lists no controls`,
            );
          }
          for (const key of cluster.controls) {
            if (!claims.has(key)) {
              problems.push(
                `${def.type}: face.pages['${page.id}'] cluster '${cluster.label}' names '${key}', ` +
                  `which is not in that page's controls (a cluster groups, it does not add)`,
              );
            }
            if (seen.has(key)) {
              problems.push(
                `${def.type}: face.pages['${page.id}'] control '${key}' is claimed by two clusters`,
              );
            }
            seen.add(key);
          }
        }
      }
    }
    expect(problems.join('\n'), 'face.pages cluster drift — a sub-header would silently do nothing').toBe('');
  });

  it('every face has a valid glyph kind and a duplicate-free order', () => {
    const problems: string[] = [];
    for (const def of allDefs()) {
      const face = def.face;
      if (!face) continue;
      if (face.glyph !== undefined && !VALID_GLYPHS.has(face.glyph)) {
        problems.push(`${def.type}: face.glyph='${face.glyph}' is not a valid glyph kind`);
      }
      const seen = new Set<string>();
      for (const key of face.order) {
        if (seen.has(key)) problems.push(`${def.type}: face.order has duplicate key '${key}'`);
        seen.add(key);
      }
    }
    expect(problems.join('\n'), 'invalid glyph / duplicate rank — fix the face').toBe('');
  });
});

describe('module-face lint — completeness (STRICT_FACES set)', () => {
  it('every promoted module ranks EVERY param, control family, and static control', () => {
    const missing: string[] = [];
    for (const def of allDefs()) {
      if (!STRICT_FACES.has(def.type)) continue;
      const face = def.face;
      if (!face) {
        missing.push(`${def.type}: in STRICT_FACES but has no face`);
        continue;
      }
      const orderSet = new Set(face.order);

      for (const p of def.params ?? []) {
        if (!orderSet.has(p.id)) missing.push(`${def.type}: param '${p.id}' not in face.order`);
      }
      for (const f of def.controlFamilies ?? []) {
        if (!orderSet.has(`${f.id}-{n}`)) {
          missing.push(`${def.type}: control family '${f.id}' not in face.order (need '${f.id}-{n}')`);
        }
      }
      for (const key of legendStaticKeys(def)) {
        if (!orderSet.has(key)) missing.push(`${def.type}: static control '${key}' not in face.order`);
      }
      for (const page of face.pages ?? []) {
        for (const key of page.controls) {
          if (!orderSet.has(key)) missing.push(`${def.type}: page '${page.id}' control '${key}' not in face.order`);
        }
      }
    }
    expect(missing.join('\n'), 'STRICT_FACES module(s) missing required ranks — rank them or unpromote').toBe('');
  });
});

describe('module-face lint — DOCK RENDER-PLAN parity (STRICT_FACES set)', () => {
  // The RENDER-side twin of the completeness gate above (the tidyVco
  // tune/fine control-loss lesson): schema coverage alone proved a control
  // can be ranked in `face.order` yet still never REACH the user, so this
  // gate pins the actual DOCK RENDER PLAN — dockFacePlan(def), the exact
  // section-band derivation ModuleShell renders at view='dock-full' — to the
  // def's full control surface. For every promoted module the flattened plan
  // must contain:
  //   * every ParamDef id EXACTLY ONCE, resolved kind 'param' (a face key
  //     that stops resolving would render as a dead 'static' placeholder —
  //     an interactive control silently replaced by a label);
  //   * every declared control family exactly once (kind 'family');
  //   * NOTHING else beyond legend-legitimized statics (extras with no def
  //     backing fail — a phantom key renders a dead cell).
  // The authoritative DOM-level twin is the faces-parity e2e spec
  // (e2e/tests/faces-parity.spec.ts) — this is its browser-free pre-gate.
  it('dockFacePlan renders every param + family exactly once, nothing unbacked', () => {
    const problems: string[] = [];
    for (const def of allDefs()) {
      if (!STRICT_FACES.has(def.type)) continue;
      const plan = dockFacePlan(def);
      if (!plan) {
        problems.push(`${def.type}: in STRICT_FACES but dockFacePlan() is null (no face)`);
        continue;
      }
      // BOTH halves of every band — un-clustered cells AND the cells a
      // ModuleFacePage.clusters sub-header pulled aside. Flattening only
      // `band.controls` would read a clustered control as DROPPED FROM THE
      // DOCK, which is the exact false positive this gate must not produce.
      const flat = dockPlanControls(plan);

      // Param parity: exactly-once, and resolved as an INTERACTIVE param cell.
      const paramCounts = new Map<string, number>();
      for (const c of flat) {
        if (c.kind === 'param' && c.paramId) {
          paramCounts.set(c.paramId, (paramCounts.get(c.paramId) ?? 0) + 1);
        }
      }
      for (const p of def.params ?? []) {
        const n = paramCounts.get(p.id) ?? 0;
        if (n !== 1) {
          problems.push(`${def.type}: param '${p.id}' renders ${n}× in the dock plan (must be exactly 1)`);
        }
        paramCounts.delete(p.id);
      }
      for (const [pid, n] of paramCounts) {
        problems.push(`${def.type}: dock plan renders unknown param '${pid}' ${n}× (no such ParamDef)`);
      }

      // Family parity: each declared family exactly once.
      const famCounts = new Map<string, number>();
      for (const c of flat) {
        if (c.kind === 'family' && c.familyId) {
          famCounts.set(c.familyId, (famCounts.get(c.familyId) ?? 0) + 1);
        }
      }
      for (const f of def.controlFamilies ?? []) {
        const n = famCounts.get(f.id) ?? 0;
        if (n !== 1) {
          problems.push(`${def.type}: control family '${f.id}' renders ${n}× in the dock plan (must be exactly 1)`);
        }
        famCounts.delete(f.id);
      }
      for (const [fid, n] of famCounts) {
        problems.push(`${def.type}: dock plan renders undeclared family '${fid}' ${n}× `);
      }

      // Statics: only legend-legitimized keys may render as static cells.
      const legit = legendStaticKeys(def);
      for (const c of flat) {
        if (c.kind === 'static' && !legit.has(c.key)) {
          problems.push(`${def.type}: dock plan renders '${c.key}' as a DEAD static cell — no param/family/legend backs it`);
        }
      }
    }
    expect(
      problems.join('\n'),
      'dock render-plan parity broken — a control would silently drop out of (or double into) the dock full-view',
    ).toBe('');
  });
});

describe('module-face lint — MOMENTARY pads (face.momentary)', () => {
  // The functional regression this closes: tomtom's momentary STRIKE rendered
  // as a LATCHING rotary in the shell — dragging it to 1 held the pad down,
  // masked the module's own TRIG jack and persisted a stuck value into the
  // Y.Doc. A press-pad and a latching switch have the IDENTICAL ParamDef shape
  // (`0..1 discrete default 0`), so the intent must be DECLARED, and a promoted
  // module that grows a NEW switch-shaped param must classify it here.

  /** Switch-shaped params on promoted modules that are LATCHING BY INTENT (a
   *  state the user leaves on), acknowledged so the ratchet below can tell
   *  "deliberately latching" from "nobody looked at it yet". RATCHET RULE: add
   *  an id here ONLY after confirming against the module's DSP/card that the
   *  control latches; a press-pad goes on `face.momentary` instead. */
  const ACKNOWLEDGED_LATCHING = new Set<string>([
    'kickdrum:hard',   // hard-clip mode switch — a bus state you leave engaged
    'snaredrum:hard',  // same clipper switch, the KICK sibling's precedent
    // CLOUDSEED, 2026-08-01. The five stage ENABLES that rest at 0. They only
    // became visible to this gate when their `curve` was corrected
    // `linear` → `discrete` (the worklet hard-thresholds all of them at 0.5,
    // so `linear` was always a lie) — before that `looksLikeSwitch` could not
    // see them at all and the shell painted them as continuous rotaries.
    // Every one is a STAGE you switch into the wet path and leave there; none
    // fires on an edge, and the module has no press-pad of any kind.
    'cloudseed:high_cut_enabled',       // the wet-path input LPF, in or out
    'cloudseed:tap_enabled',            // the multitap early-echo stage
    'cloudseed:early_diffuse_enabled',  // the early all-pass network
    'cloudseed:eq_low_shelf_enabled',   // in-loop low shelf
    'cloudseed:eq_lowpass_enabled',     // in-loop lowpass
    // REMOVED 2026-07-27 — 'tidyVco:hold'. The acknowledgement was WRONG (it
    // claimed "sample-and-hold ENGAGE"): the card drives it pointerdown/
    // pointerup, the worklet ORs it into the mono gate like tomtom's `strike`,
    // and the def's own doc says "released = note-off (no latch)". It is now
    // declared on `face.momentary`. The cross-check below is what stops that
    // mistake from being made silently again.
  ]);

  it('no ACKNOWLEDGED_LATCHING param is DOCUMENTED as momentary (the cross-check)', () => {
    // THE GUARD ON THE GUARD. `ACKNOWLEDGED_LATCHING` is a hand-written escape
    // hatch from the classification ratchet, and a WRONG entry is invisible:
    // the gate goes green while the shell paints a press-pad as a latching
    // rotary — the stuck-value-in-the-Y.Doc bug the field exists to prevent
    // (tidyVco `hold` sat here for two batches saying "sample-and-hold ENGAGE"
    // while its own authored doc said "released = note-off (no latch)").
    //
    // So: the def's AUTHORED prose is cross-examined against the
    // acknowledgement. Momentary vocabulary in `docs.controls[<id>]` and a
    // latching acknowledgement cannot both be true — one of them is a bug, and
    // this test refuses to let the author pick silently.
    const MOMENTARY_VOCAB: readonly RegExp[] = [
      /\bmomentar/i,          // "momentary", "momentarily"
      /\bno[- ]latch/i,       // "no latch", "no-latch"
      /\bpress(?:ed|es|ing)?\b/i, // "press"/"pressed" — NOT "compress"/"expression"
    ];
    const contradictions: string[] = [];
    for (const def of allDefs()) {
      const docs = def.docs;
      for (const p of def.params ?? []) {
        if (!ACKNOWLEDGED_LATCHING.has(`${def.type}:${p.id}`)) continue;
        const prose = docs?.controls?.[p.id];
        if (!prose) continue;
        const hit = MOMENTARY_VOCAB.find((re) => re.test(prose));
        if (hit) {
          contradictions.push(
            `${def.type}: param '${p.id}' is in ACKNOWLEDGED_LATCHING, but its authored doc ` +
              `reads as MOMENTARY (matched ${hit}). A press-pad belongs on face.momentary — ` +
              `acknowledging it as latching makes the shell paint a LATCHING ROTARY that ` +
              `persists a stuck value into the Y.Doc. Fix the classification, or fix the doc.`,
          );
        }
      }
    }
    expect(
      contradictions.join('\n'),
      'a latching ACKNOWLEDGEMENT contradicts the module’s own authored documentation',
    ).toBe('');
  });

  it('every declared momentary id is a real param with the press-pad shape', () => {
    const problems: string[] = [];
    for (const def of allDefs()) {
      const declared = def.face?.momentary ?? [];
      const byId = new Map((def.params ?? []).map((p) => [p.id, p]));
      const seen = new Set<string>();
      for (const pid of declared) {
        if (seen.has(pid)) problems.push(`${def.type}: face.momentary lists '${pid}' twice`);
        seen.add(pid);
        const p = byId.get(pid);
        if (!p) {
          problems.push(`${def.type}: face.momentary '${pid}' is not a declared param`);
          continue;
        }
        if (!looksLikeSwitch(p)) {
          problems.push(
            `${def.type}: face.momentary '${pid}' is ${p.min}..${p.max} ${p.curve} ` +
              `default=${p.defaultValue} — a press-pad must be 0..1 discrete resting at 0`,
          );
        }
        if (!(def.face?.order ?? []).includes(pid)) {
          problems.push(`${def.type}: face.momentary '${pid}' is not ranked in face.order`);
        }
      }
    }
    expect(problems.join('\n'), 'face.momentary drifted from the params — fix the ids').toBe('');
  });

  it('STRICT_FACES: every switch-shaped param is classified momentary OR acknowledged latching', () => {
    const unclassified: string[] = [];
    for (const def of allDefs()) {
      if (!STRICT_FACES.has(def.type)) continue;
      const declared = new Set(def.face?.momentary ?? []);
      for (const p of def.params ?? []) {
        if (!looksLikeSwitch(p)) continue;
        if (declared.has(p.id)) continue;
        if (ACKNOWLEDGED_LATCHING.has(`${def.type}:${p.id}`)) continue;
        unclassified.push(
          `${def.type}: param '${p.id}' has the 0/1 press-pad SHAPE but nobody said which it is. ` +
            `If it fires on a rising edge (a strike/trigger pad) add it to face.momentary; ` +
            `if it latches, add '${def.type}:${p.id}' to ACKNOWLEDGED_LATCHING here.`,
        );
      }
    }
    expect(
      unclassified.join('\n'),
      'unclassified switch-shaped param(s) — a momentary pad would render as a latching rotary',
    ).toBe('');
  });
});

describe('module-face lint — DECLARED param cells (face.paramCells) + PANEL tier', () => {
  // PF-15 / PF-14. `face.paramCells` is the ONE render primitive a module has
  // to declare — `'toggle'` is derived from the 0/1 switch shape and
  // `'segmented'`/`'selector'` from a declared `options` roster, but "these
  // states are PICTURES, chart them" is knowledge only the module has. A
  // declaration nobody validates is a silent no-op, so every clause below is a
  // pure predicate driven BOTH over the live registry and over synthetic defs
  // (the negative controls at the end), because a lint rule that has never been
  // seen to fail is not a gate.

  interface CellFaceDef extends FaceDefLike {
    type: string;
    params?: readonly ParamDef[];
    face?: ModuleFace;
  }

  /**
   * Every problem with one def's `face.paramCells`. FOUR clauses:
   *   (a) the key names a DECLARED param — a typo'd/renamed key would silently
   *       paint the old primitive with nobody noticing;
   *   (b) the key is RANKED in `face.order` — an unranked param never reaches
   *       `curatedFace`, so declaring its primitive is a no-op that reads like
   *       a shipped decision (the same trap `face.momentary` already gates);
   *   (c) the param is NOT also on `face.momentary` — a press-pad is not a
   *       state, and the two declarations paint incompatible primitives (a
   *       Button that returns to rest vs. a picker that commits a value), so
   *       one of them is a bug and the author must say which;
   *   (d) the param is DISCRETE with a sane step count — the grid derives one
   *       cell per integer step, so `'grid'` on a 20..20000 Hz cutoff is a
   *       twenty-thousand-cell popover. `paramGridCells` caps the damage at
   *       GRID_MAX_CELLS; this is where the author finds out.
   * Pure.
   */
  function paramCellProblems(def: CellFaceDef): string[] {
    const problems: string[] = [];
    const decl = def.face?.paramCells;
    if (!decl) return problems;
    const byId = new Map((def.params ?? []).map((p) => [p.id, p]));
    const ranked = new Set(def.face?.order ?? []);
    const momentary = new Set(def.face?.momentary ?? []);

    for (const [key, kind] of Object.entries(decl)) {
      const p = byId.get(key);
      if (!p) {
        problems.push(
          `${def.type}: face.paramCells['${key}'] is not a declared param — a renamed/typo'd ` +
            `key silently keeps the DEFAULT primitive, which looks like a shipped decision`,
        );
        continue;
      }
      if (!ranked.has(key)) {
        problems.push(
          `${def.type}: face.paramCells['${key}'] is not ranked in face.order, so the cell is ` +
            `never selected and the declaration does NOTHING`,
        );
      }
      if (momentary.has(key)) {
        problems.push(
          `${def.type}: param '${key}' is BOTH face.momentary and face.paramCells['${kind}'] — ` +
            `a press-pad is not a state. Pick one: a momentary <Button> that returns to rest, ` +
            `or a picker that commits a value.`,
        );
      }
      const steps = Math.floor(p.max) - Math.ceil(p.min) + 1;
      if (p.curve !== 'discrete' || steps < 2 || steps > GRID_MAX_CELLS) {
        problems.push(
          `${def.type}: face.paramCells['${key}'] = 'grid' but the param is ${p.min}..${p.max} ` +
            `${p.curve} (${steps} step(s)) — a grid needs a DISCRETE param with 2..${GRID_MAX_CELLS} ` +
            `steps, or it paints one cell per integer across the whole range`,
        );
      }
    }
    return problems;
  }

  /**
   * Every LANE tier at which a PANEL cell would be SELECTED. A panel carries its
   * own design floor (a 280 px operator map); a 46 px `--kcol-max` knob column
   * cannot hold one, so a panel is DOCK-ONLY.
   *
   * ⚠ Do NOT delegate this to `PLATE_COLS * PLATE_MAX_ROWS = 6` truncating a
   * low-ranked panel out of the lane. That is a COINCIDENCE OF THE CURRENT
   * NUMBERS, not a guarantee: bump the plate cap and a 280 px SVG lands in a
   * 46 px column with no gate saying a word. Pure (`panelKeys` is injected so
   * the negative control can supply its own).
   */
  function panelTierProblems(def: CellFaceDef, panelKeys: ReadonlySet<string>): string[] {
    if (!panelKeys.size) return [];
    const problems: string[] = [];
    for (const tier of ['mini', 'compact', 'full'] as const) {
      const face = curatedFace(def, tier);
      if (!face) continue;
      for (const ctl of face.controls) {
        if (!panelKeys.has(ctl.key)) continue;
        problems.push(
          `${def.type}: panel cell '${ctl.key}' is SELECTED at lane tier '${tier}' — a panel ` +
            `declares its own minWidth and cannot fit a 46px knob column. Rank it below the ` +
            `lane caps (ranks 7+ are dock-only) or drop the panel.`,
        );
      }
    }
    return problems;
  }

  it('every face.paramCells key is a ranked, non-momentary, DISCRETE param', () => {
    const problems: string[] = [];
    for (const def of allDefs()) {
      problems.push(...paramCellProblems(def as unknown as CellFaceDef));
    }
    expect(problems.join('\n'), 'face.paramCells drift — a declared primitive that is a no-op or a contradiction').toBe('');
  });

  it('no PANEL cell is selected at a LANE tier (panels are dock-only)', () => {
    const problems: string[] = [];
    for (const def of allDefs()) {
      if (!def.face) continue;
      problems.push(
        ...panelTierProblems(def as unknown as CellFaceDef, new Set(panelCellKeys(def.type))),
      );
    }
    expect(problems.join('\n'), 'a bespoke panel would render inside a lane knob column').toBe('');
  });

  // ── NEGATIVE CONTROLS ──────────────────────────────────────────────────────
  // Each clause driven against a def built to violate exactly it. Without these
  // the four rules above are green forever — no shipped module declares a
  // paramCell or a panel yet (dx7 adopts both in PRs 4 and 6), so the live
  // sweeps are VACUOUSLY green today and would stay green if the predicates
  // were `return []`.

  const GRID_PARAM: ParamDef = {
    id: 'algorithm',
    label: 'algorithm',
    min: 1,
    max: 32,
    defaultValue: 1,
    curve: 'discrete',
  };

  function synthetic(over: Partial<CellFaceDef> = {}): CellFaceDef {
    return {
      type: 'synthetic',
      params: [GRID_PARAM],
      face: { order: ['algorithm'], paramCells: { algorithm: 'grid' } },
      ...over,
    };
  }

  it('NEGATIVE CONTROL: a well-formed declaration passes every clause', () => {
    expect(paramCellProblems(synthetic())).toEqual([]);
  });

  it('NEGATIVE CONTROL (a): a paramCells key that is not a declared param FAILS', () => {
    const problems = paramCellProblems(synthetic({ params: [] }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('is not a declared param');
  });

  it('NEGATIVE CONTROL (b): a paramCells key missing from face.order FAILS', () => {
    const problems = paramCellProblems(
      synthetic({ face: { order: [], paramCells: { algorithm: 'grid' } } }),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('is not ranked in face.order');
  });

  it('NEGATIVE CONTROL (c): a param that is BOTH momentary and a paramCell FAILS', () => {
    const problems = paramCellProblems(
      synthetic({
        face: { order: ['algorithm'], momentary: ['algorithm'], paramCells: { algorithm: 'grid' } },
      }),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('a press-pad is not a state');
  });

  it('NEGATIVE CONTROL (d): a grid on a CONTINUOUS / unbounded param FAILS', () => {
    const continuous = paramCellProblems(
      synthetic({ params: [{ ...GRID_PARAM, curve: 'linear' }] }),
    );
    expect(continuous).toHaveLength(1);
    expect(continuous[0]).toContain(`2..${GRID_MAX_CELLS} steps`);

    const huge = paramCellProblems(
      synthetic({ params: [{ ...GRID_PARAM, min: 20, max: 20000 }] }),
    );
    expect(huge).toHaveLength(1);
    expect(huge[0]).toContain(`2..${GRID_MAX_CELLS} steps`);

    // …and a one-state "grid" is a label, not a picker.
    const single = paramCellProblems(synthetic({ params: [{ ...GRID_PARAM, min: 1, max: 1 }] }));
    expect(single).toHaveLength(1);
  });

  it('NEGATIVE CONTROL: a PANEL ranked into the lane FAILS at every lane tier it reaches', () => {
    const panelKey = 'synthetic-panel-{n}';
    const panelKeys = new Set([panelKey]);
    const inLane = synthetic({
      face: { order: [panelKey, 'algorithm'], paramCells: { algorithm: 'grid' } },
      controlFamilies: [{ id: 'synthetic-panel', label: 'panel' }],
    });
    const problems = panelTierProblems(inLane, panelKeys);
    // rank 1 → selected at mini (cap 1), compact and full alike.
    expect(problems).toHaveLength(3);
    expect(problems[0]).toContain("SELECTED at lane tier 'mini'");

    // Ranked BELOW the lane caps (7+ is dock-only) → clean.
    const dockOnly = synthetic({
      face: {
        order: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', panelKey],
        paramCells: {},
      },
      controlFamilies: [{ id: 'synthetic-panel', label: 'panel' }],
    });
    expect(panelTierProblems(dockOnly, panelKeys)).toEqual([]);

    // And the rule is INERT for a module with no panels at all — proving the
    // live sweep above is not passing by accidentally flagging nothing.
    expect(panelTierProblems(inLane, new Set())).toEqual([]);
  });
});

describe('module-face lint — LANE tier caps ↔ lane fit plan (authored intent === render)', () => {
  // The mismatch this closes, in BOTH lane tiers:
  //   * FACE_TIER_CAPS.compact promised 3 while laneBodyPlan rendered 2 next to
  //     a glyph, so six faces documented a 3-control compact tile the shell
  //     could never paint;
  //   * FACE_TIER_CAPS.full promised 8 while laneBodyPlan's 3×2 plate renders
  //     at most 6, so EVERY face's ranks 7 and 8 were authored as "in the lane"
  //     and silently truncated. Ranks 7+ are DOCK-ONLY — a fact a face author
  //     must be able to read off the cap.
  // faceTierCap now follows the plan at both; this pins them together over the
  // LIVE registry, for every LANE tier (the 'dock' faceplate wraps freely and
  // never reaches laneBodyPlan).
  const LANE_TIERS = ['mini', 'compact', 'full'] as const;
  it('every faced module SELECTS exactly the cells each LANE tier RENDERS', () => {
    const drift: string[] = [];
    for (const def of allDefs()) {
      if (!def.face) continue;
      for (const tier of LANE_TIERS) {
        const face = curatedFace(def, tier);
        if (!face) continue;
        const hasGlyph = face.glyph !== 'none';
        const rendered = laneBodyPlan(face.controls.length, hasGlyph, tier).cellCount;
        if (rendered !== face.controls.length) {
          drift.push(
            `${def.type}: ${tier} selects ${face.controls.length} control(s) but the tile ` +
              `renders ${rendered} (glyph=${face.glyph}) — the cap and the fit plan disagree`,
          );
        }
      }
    }
    expect(drift.join('\n'), 'lane cap ↔ fit-plan drift — reconcile faceTierCap/laneBodyPlan').toBe('');
  });
});

describe('module-face lint — rear-card curation (face.rear) + derivation totality', () => {
  // The rear card (rear-card-model.ts) renders EVERY declared port as exactly
  // one hole. Two pure gates hold that line (rear-card-spec.md §5):
  //   1. CONSISTENCY: every `face.rear` key resolves to a DECLARED port, no
  //      port is claimed by two groups, clusters point at a real band and only
  //      at ports of that band, audioRate lists INPUT ports only.
  //   2. TOTALITY (STRICT_FACES): the derivation over every promoted module is
  //      TOTAL — every declared port lands in exactly one band/rail hole (the
  //      no-orphan-holes guarantee behind "exposes ALL patch points").
  it('every face.rear key resolves to a declared port (groups/clusters/audioRate)', () => {
    const problems: string[] = [];
    for (const def of allDefs()) {
      const rear = def.face?.rear;
      if (!rear) continue;
      const inputIds = new Set((def.inputs ?? []).map((p) => p.id));
      const outputIds = new Set((def.outputs ?? []).map((p) => p.id));
      const claimed = new Set<string>();
      const groupIds = new Set<string>();
      const pageIds = new Set((def.face?.pages ?? []).map((p) => p.id));
      for (const g of rear.groups ?? []) {
        if (groupIds.has(g.id)) problems.push(`${def.type}: face.rear duplicate group id '${g.id}'`);
        groupIds.add(g.id);
        for (const pid of g.ports) {
          if (!inputIds.has(pid) && !outputIds.has(pid)) {
            problems.push(`${def.type}: face.rear.groups['${g.id}'] port '${pid}' is not a declared port`);
          }
          if (claimed.has(pid)) {
            problems.push(`${def.type}: face.rear port '${pid}' claimed by two groups`);
          }
          claimed.add(pid);
        }
      }
      for (const c of rear.clusters ?? []) {
        if (!groupIds.has(c.group) && !pageIds.has(c.group) && c.group !== 'voice' && c.group !== 'signal' && c.group !== 'cv') {
          problems.push(`${def.type}: face.rear.clusters group '${c.group}' matches no page/group/derived band`);
        }
        for (const pid of c.ports) {
          if (!inputIds.has(pid) && !outputIds.has(pid)) {
            problems.push(`${def.type}: face.rear.clusters['${c.label}'] port '${pid}' is not a declared port`);
          }
        }
      }
      for (const pid of rear.audioRate ?? []) {
        if (!inputIds.has(pid)) {
          problems.push(`${def.type}: face.rear.audioRate '${pid}' is not a declared INPUT port`);
        }
      }
    }
    expect(problems.join('\n'), 'face.rear drifted from the declared ports — fix the keys').toBe('');
  });

  it('STRICT_FACES: the rear derivation is TOTAL — every declared port = exactly one hole', async () => {
    const { rearFieldPlan } = await import('./rear-card-model');
    const missing: string[] = [];
    for (const def of allDefs()) {
      if (!STRICT_FACES.has(def.type)) continue;
      const plan = rearFieldPlan(def as unknown as import('./rear-card-model').RearDefLike);
      const rendered = [
        ...plan.bands.flatMap((b) => [
          ...b.holes.map((h) => `input:${h.portId}`),
          ...b.clusters.flatMap((c) => c.holes.map((h) => `input:${h.portId}`)),
        ]),
        ...plan.outputs.map((h) => `output:${h.portId}`),
      ];
      const declared = [
        ...(def.inputs ?? []).map((p) => `input:${p.id}`),
        ...(def.outputs ?? []).map((p) => `output:${p.id}`),
      ];
      const renderedSet = new Set(rendered);
      if (rendered.length !== renderedSet.size) {
        missing.push(`${def.type}: rear derivation rendered a port TWICE`);
      }
      for (const d of declared) {
        if (!renderedSet.has(d)) missing.push(`${def.type}: rear derivation dropped ${d}`);
      }
      if (rendered.length !== declared.length) {
        missing.push(`${def.type}: hole count ${rendered.length} ≠ declared port count ${declared.length}`);
      }
    }
    expect(missing.join('\n'), 'rear derivation not total — a hole went missing').toBe('');
  });

  it('every curated rear GROUP claims the leading slot or names a real page (no stray band)', () => {
    // ⚠ GENERALIZED FROM A PER-MODULE SPEC, because the MECHANISM is shared and
    // the hole is platform-wide. `rearFieldPlan` gives a group whose id is
    // 'voice'/'signal' the LEADING slot, lets a group whose id matches a page
    // id CLAIM that page's slot, and APPENDS anything else after the page
    // bands. So a group id that is a near-miss for its page ('strings' vs
    // 'string') silently produces a derived band holding only the leftovers
    // plus a stray 7-hole band at the bottom.
    //
    // The totality gate above CANNOT SEE IT: every port still renders exactly
    // once, just in a wrecked order — a gate that counts holes proves nothing
    // about where they are. And the version of this check that shipped read a
    // single hardcoded def, so it was structurally blind to the next module to
    // get it wrong. Verified green across all STRICT_FACES at the time of
    // writing, so there is no cost to sweeping the registry.
    const problems: string[] = [];
    for (const def of allDefs()) {
      const groups = def.face?.rear?.groups ?? [];
      if (!groups.length) continue;
      const pageIds = new Set((def.face?.pages ?? []).map((p) => p.id));
      for (const g of groups) {
        const claimsLead = g.id === 'voice' || g.id === 'signal';
        if (!claimsLead && !pageIds.has(g.id)) {
          problems.push(
            `${def.type}: face.rear.groups['${g.id}'] claims neither the leading slot ` +
              `('voice'/'signal') nor a declared page id — it appends as a STRAY band after ` +
              `every page, and the totality gate cannot see it. Page ids: ${[...pageIds].join(', ')}`,
          );
        }
      }
    }
    expect(problems.join('\n'), 'a curated rear group would append as a stray band').toBe('');
  });

  it('no page id collides with the LEADING rear group id (the dx7 double-band scar)', () => {
    // The one collision that DOES double-render: the leading 'voice'/'signal'
    // band is pushed BEFORE the page loop and is not in `curatedGroups`, so
    // nothing claims it and the page renders a second band with the same id.
    // (A page id matching a NON-leading group id is the sanctioned re-heading
    // mechanism — kickdrum's `sub`, tidyVco's `oscillator` — not a bug.)
    const problems: string[] = [];
    for (const def of allDefs()) {
      const lead = (def.face?.rear?.groups ?? []).find((g) => g.id === 'voice' || g.id === 'signal');
      if (!lead) continue;
      if ((def.face?.pages ?? []).some((p) => p.id === lead.id)) {
        problems.push(`${def.type}: page '${lead.id}' collides with the LEADING rear group — that band renders TWICE`);
      }
    }
    expect(problems.join('\n'), 'a page id claiming the leading rear slot').toBe('');
  });

  it('STRICT_FACES: no rear band LABEL prefixes another on the same card', async () => {
    // ⚠ THE GATE FOR A REAL MISPATCH, not for tidiness. Every rear check above
    // reads IDS; `rear-card-model.test.ts` asserts `bandIds(def)` and never
    // touches a label; and `workflow-shell-faces.spec.ts` captures only
    // `-compact` and `-dock` — there is NO VRT scene for the rear card at all.
    // So the labels a player actually reads on the flip side are, collectively,
    // ungated.
    //
    // What that let through (kickdrum): a page renamed `sub` → `strike · the
    // pulse` — correct on the FRONT, where that band holds the strike button —
    // resolved on the REAR to a band of five sub-layer CV holes stacked
    // directly under the band that IS the strike. Two adjacent bands both
    // headed STRIKE, and the second one's first hole is `tune_cv`: a sequencer
    // gate patched into the wrong one silently DETUNES the drum instead of
    // hitting it.
    //
    // Prefix, not equality: `strike` and `strike · the pulse` are distinct
    // strings, so an equality check reads clean on exactly this bug.
    const { rearFieldPlan } = await import('./rear-card-model');
    const problems: string[] = [];
    for (const def of allDefs()) {
      if (!STRICT_FACES.has(def.type)) continue;
      const labels = rearFieldPlan(def as unknown as import('./rear-card-model').RearDefLike)
        .bands.map((b) => (b.label ?? '').trim().toLowerCase())
        .filter(Boolean);
      for (let i = 0; i < labels.length; i++) {
        for (let j = 0; j < labels.length; j++) {
          if (i === j) continue;
          if (labels[j]!.startsWith(labels[i]!)) {
            problems.push(
              `${def.type}: rear bands '${labels[i]}' and '${labels[j]}' — one heads the other, ` +
                `so the card shows two bands the player reads as the same jack group. ` +
                `Re-head one with a face.rear.groups entry whose id matches the page id.`,
            );
          }
        }
      }
    }
    expect([...new Set(problems)].join('\n'), 'ambiguous rear band headings').toBe('');
  });
});

describe('module-face lint — FACEPLATE STRUCTURE (PF-20: hero / sidebar / hints)', () => {
  // PF-20 added four DECLARATIONS to `face` — title/hint, page hints, the hero
  // slot and the sidebar — and every one of them is the same hazard shape the
  // paramCells block above exists for: a declaration nobody validates is a
  // silent no-op that reads like a shipped decision. A stale hero key promotes
  // nothing; a preset naming a deleted param writes nothing; a `custom` block
  // with a typo'd panel id paints a blank column.
  //
  // Every clause is a pure predicate driven BOTH over the live registry and
  // over synthetic defs, because kickdrum is the only adopter today and the
  // registry sweeps would otherwise be near-vacuous.

  interface StructFaceDef extends FaceDefLike {
    type: string;
    params?: readonly ParamDef[];
    face?: ModuleFace;
  }

  /**
   * Every problem with one def's HERO declaration:
   *   (a) `cell`/`control`/`action` name a key that is RANKED in `face.order` —
   *       an unranked key never reaches `dockFacePlan`, so the promotion
   *       silently does nothing and that hero slot renders empty;
   *   (b) no key is claimed by TWO slots — heroFacePlan promotes it once (it
   *       must, or the dock emits the cell twice), so the second declaration is
   *       a typo whose effect is invisible;
   *   (c) `cell` names a key whose shell cell is a PANEL — the hero picture
   *       slot is sized and laid out for one, and promoting a knob into it
   *       would silently produce a 380px-wide dial;
   *   (d) every readout names EXACTLY ONE source, and it resolves.
   */
  function heroProblems(def: StructFaceDef): string[] {
    const hero = def.face?.hero;
    if (!hero) return [];
    const problems: string[] = [];
    const ranked = new Set(def.face?.order ?? []);

    const slots = [
      ['cell', hero.cell],
      ['control', hero.control],
      ['action', hero.action],
    ] as const;

    for (const [field, key] of slots) {
      if (!key) continue;
      if (!ranked.has(key)) {
        problems.push(
          `${def.type}: face.hero.${field} = '${key}' is not ranked in face.order, so nothing is ` +
            `promoted and the hero rail renders EMPTY`,
        );
      }
    }
    // Every key claimed by more than one slot, named once each.
    const seen = new Map<string, string>();
    for (const [field, key] of slots) {
      if (!key) continue;
      const first = seen.get(key);
      if (first) {
        problems.push(
          `${def.type}: face.hero.${first} and .${field} are both '${key}' — it can only be ` +
            `promoted ONCE (a second cell would emit a duplicate control-<paramId> and fail ` +
            `faces-parity), so one of the two declarations does nothing`,
        );
      } else {
        seen.set(key, field);
      }
    }
    if (hero.cell) {
      const ctl = dockPlanControls(dockFacePlan(def) ?? []).find((c) => c.key === hero.cell);
      if (ctl?.kind === 'param') {
        // ⚠ CHECKED OFF THE CONTROL KIND FIRST, not off the shell registry.
        // `shellCellFor` is keyed by MODULE TYPE and returns null for a type it
        // does not know, so a registry-only check would silently pass on every
        // synthetic def — i.e. the negative control below could not fail, and
        // the clause would be decoration.
        problems.push(
          `${def.type}: face.hero.cell = '${hero.cell}' is a PARAM control, not a panel — the ` +
            `hero picture slot is a full-width picture bay and a dial promoted into it renders ` +
            `stretched across it. Use face.hero.control for a knob.`,
        );
      } else if (ctl) {
        const cell = shellCellFor(def.type, ctl);
        if (cell && cell.kind !== 'panel') {
          problems.push(
            `${def.type}: face.hero.cell = '${hero.cell}' resolves to a '${cell.kind}' shell ` +
              `cell, not a panel — the hero picture slot is a full-width picture bay`,
          );
        }
      }
    }
    problems.push(...readoutProblems(def, hero.readouts ?? [], 'face.hero.readouts'));
    return problems;
  }

  /** Shared readout clause — used by the hero AND by every `readouts` sidebar
   *  block, because "exactly one source, and it resolves" is the same rule
   *  wherever a labelled value is declared. */
  function readoutProblems(
    def: StructFaceDef,
    readouts: readonly { label: string; paramId?: string; valueId?: string; text?: string }[],
    where: string,
  ): string[] {
    const problems: string[] = [];
    const paramIds = new Set((def.params ?? []).map((p) => p.id));
    const values = new Set(faceReadoutValueIds());
    for (const r of readouts) {
      if (!isUsableReadout(r)) {
        problems.push(
          `${def.type}: ${where}['${r.label}'] must name EXACTLY ONE source — a paramId, a ` +
            `valueId or a text, never two and never none (it renders as '—')`,
        );
        continue;
      }
      if (r.paramId && !paramIds.has(r.paramId)) {
        problems.push(
          `${def.type}: ${where}['${r.label}'].paramId = '${r.paramId}' is not a declared param — ` +
            `it prints '—' forever`,
        );
      }
      if (r.valueId && !values.has(r.valueId)) {
        problems.push(
          `${def.type}: ${where}['${r.label}'].valueId = '${r.valueId}' is not registered in ` +
            `face-readout-values.ts (have: ${[...values].join(', ') || 'none'}) — it prints ` +
            `'—' forever`,
        );
      }
    }
    return problems;
  }

  /**
   * Every problem with one def's SIDEBAR:
   *   (a) a `presets` entry's every value key is a declared param, and the
   *       value is INSIDE that param's declared range. Out-of-range is the
   *       "the control lied about its own range" class: `presetWrites` clamps
   *       at render time, so an out-of-range preset would silently apply a
   *       DIFFERENT setting than the one it names;
   *   (b) a `custom` block's `panelId` is REGISTERED (sidebar-panels.ts) — an
   *       unregistered id renders nothing, i.e. a labelled blank column;
   *   (c) `readouts` entries obey the shared readout clause;
   *   (d) no block would render EMPTY (sidebarPlan drops it, so declaring it
   *       is a no-op the author should know about).
   */
  function sidebarProblems(def: StructFaceDef, registered: ReadonlySet<string>): string[] {
    const blocks = def.face?.sidebar;
    if (!blocks) return [];
    const problems: string[] = [];
    const byId = new Map((def.params ?? []).map((p) => [p.id, p]));
    const kept = new Set(sidebarPlan(def as FaceplateDefLike) ?? []);

    for (const b of blocks) {
      if (!kept.has(b)) {
        problems.push(
          `${def.type}: face.sidebar '${b.label}' (${b.kind}) renders EMPTY and is dropped — ` +
            `a labelled void is worse than no block`,
        );
      }
      if (b.kind === 'presets') {
        for (const e of b.entries) {
          for (const [pid, v] of Object.entries(e.values)) {
            const p = byId.get(pid);
            if (!p) {
              problems.push(
                `${def.type}: preset '${e.id}' writes '${pid}', which is not a declared param — ` +
                  `presetWrites DROPS it, so the preset silently applies a different sound`,
              );
              continue;
            }
            if (!Number.isFinite(v) || v < p.min || v > p.max) {
              problems.push(
                `${def.type}: preset '${e.id}' sets ${pid} = ${v}, outside its declared ` +
                  `${p.min}..${p.max} — presetWrites CLAMPS it, so the preset applies a value ` +
                  `it does not name`,
              );
            }
          }
        }
      } else if (b.kind === 'custom') {
        if (!registered.has(b.panelId)) {
          problems.push(
            `${def.type}: face.sidebar custom panelId '${b.panelId}' is not registered in ` +
              `sidebar-panels.ts (have: ${[...registered].join(', ') || 'none'}) — it paints a ` +
              `labelled blank column`,
          );
        }
      } else if (b.kind === 'readouts') {
        problems.push(...readoutProblems(def, b.entries, `face.sidebar['${b.label}']`));
      }
    }
    return problems;
  }

  /**
   * A page `hint` on a TABBED face is DEAD METADATA. ModuleShell suppresses the
   * whole band header when a rail is up (the tab already names the band ~14px
   * above), so the hint is authored, reviewed, and never rendered — exactly the
   * "declaration that does nothing" trap the paramCells rules exist for.
   */
  function deadHintProblems(def: StructFaceDef): string[] {
    const bands = dockFacePlan(def);
    if (!bands || !dockTabPlan(bands)) return [];
    return bands
      .filter((b) => b.hint)
      .map(
        (b) =>
          `${def.type}: page '${b.id}' declares a hint, but this face is TABBED ` +
            `(${bands.length} bands ≥ the rail threshold) and a tabbed face suppresses its band ` +
            `headers — the hint can never render`,
      );
  }

  it('every face.hero key is RANKED, promoted once, and every readout resolves', () => {
    const problems: string[] = [];
    for (const def of allDefs()) problems.push(...heroProblems(def as unknown as StructFaceDef));
    expect(problems.join('\n'), 'face.hero drift — a promotion or readout that does nothing').toBe('');
  });

  it('the HERO SPLIT is TOTAL on every faced module — no control dropped or duplicated', () => {
    // The unit-lane twin of faces-parity's DOM multiset assert, over the whole
    // registry in milliseconds. This is the gate that makes promoting a control
    // into the hero a safe edit rather than a gamble.
    const problems: string[] = [];
    for (const def of allDefs()) {
      if (!def.face) continue;
      const before = dockFacePlan(def as FaceDefLike);
      const after = heroFacePlan(def as unknown as FaceplateDefLike, before);
      if (!heroFacePlanIsTotal(before, after)) {
        problems.push(
          `${def.type}: the hero split changed the dock's control multiset — a promoted control ` +
            `was dropped (a LOST control) or duplicated (an unbacked EXTRA control)`,
        );
      }
    }
    expect(problems.join('\n'), 'hero split totality').toBe('');
  });

  it('every face.sidebar block paints: real params, in-range presets, registered panels', () => {
    const registered = new Set(sidebarPanelIds());
    const problems: string[] = [];
    for (const def of allDefs()) {
      problems.push(...sidebarProblems(def as unknown as StructFaceDef, registered));
    }
    expect(problems.join('\n'), 'face.sidebar drift').toBe('');
  });

  it('no page hint is declared on a TABBED face (it could never render)', () => {
    const problems: string[] = [];
    for (const def of allDefs()) {
      if (!def.face) continue;
      problems.push(...deadHintProblems(def as unknown as StructFaceDef));
    }
    expect(problems.join('\n'), 'dead page hints').toBe('');
  });

  // ── NEGATIVE CONTROLS ─────────────────────────────────────────────────────
  // kickdrum is the only adopter today, so without these the four sweeps above
  // are near-vacuous and would stay green if every predicate were `return []`.

  const HERO_PARAM: ParamDef = { id: 'tune', label: 'Tune', min: 20, max: 120, defaultValue: 50, curve: 'log' };

  function structSynthetic(over: Partial<StructFaceDef> = {}): StructFaceDef {
    return {
      type: 'synthetic',
      params: [HERO_PARAM],
      face: { order: ['tune'], hero: { control: 'tune' } },
      ...over,
    };
  }

  it('NEGATIVE CONTROL: a well-formed hero + sidebar passes every clause', () => {
    const def = structSynthetic({
      face: {
        order: ['tune'],
        hero: {
          control: 'tune',
          readouts: [
            { label: 'pitch', paramId: 'tune' },
            { label: 'derived', valueId: 'kickdrum-tail' },
            { label: 'fixed', text: 'x' },
          ],
        },
        sidebar: [
          { kind: 'signal-flow', label: 'flow', stages: [{ label: 'SUB', role: 'generator' }] },
          { kind: 'presets', label: 'p', entries: [{ id: 'a', label: 'A', values: { tune: 60 } }] },
          { kind: 'readouts', label: 'r', entries: [{ label: 'pitch', paramId: 'tune' }] },
          { kind: 'custom', label: 'c', panelId: 'stereo-crossover' },
        ],
      },
    });
    expect(heroProblems(def)).toEqual([]);
    expect(sidebarProblems(def, new Set(sidebarPanelIds()))).toEqual([]);
  });

  it('NEGATIVE CONTROL (hero a): an UNRANKED hero key FAILS', () => {
    const problems = heroProblems(structSynthetic({ face: { order: [], hero: { control: 'tune' } } }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('is not ranked in face.order');
  });

  it('NEGATIVE CONTROL (hero b): control === action FAILS', () => {
    const problems = heroProblems(
      structSynthetic({ face: { order: ['tune'], hero: { control: 'tune', action: 'tune' } } }),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('can only be promoted ONCE');
  });

  it('NEGATIVE CONTROL (hero b): cell === action FAILS too — every slot pair, not just two', () => {
    const problems = heroProblems(
      structSynthetic({ face: { order: ['tune'], hero: { cell: 'tune', action: 'tune' } } }),
    );
    // Two clauses fire, and BOTH are the point: the key is claimed twice AND
    // the promoted `cell` is not a panel. A clause set that only reported one
    // would leave the other authoring mistake invisible.
    expect(problems.some((x) => x.includes('can only be promoted ONCE'))).toBe(true);
  });

  it('NEGATIVE CONTROL (hero c): a hero.cell that is NOT a panel FAILS', () => {
    // The hero PICTURE bay is laid out for a panel. Promoting a knob into it
    // renders a dial stretched across 380 px, which looks like a styling bug
    // and is actually a declaration bug — nothing at runtime can tell you.
    const problems = heroProblems(
      structSynthetic({ face: { order: ['tune'], hero: { cell: 'tune' } } }),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('is a PARAM control, not a panel');
  });

  it('NEGATIVE CONTROL (hero d): an UNREGISTERED readout valueId FAILS', () => {
    // The derived-readout registry is the mechanism that stops `tail` being a
    // `sub_decay` readback; a typo'd id would silently print '—' and the
    // faceplate would look almost right.
    const problems = heroProblems(
      structSynthetic({
        face: {
          order: ['tune'],
          hero: { control: 'tune', readouts: [{ label: 'tail', valueId: 'no-such-derivation' }] },
        },
      }),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('is not registered in face-readout-values.ts');

    // …and the registered one passes, which is what makes the clause a check
    // rather than a blanket rejection of `valueId`.
    expect(
      heroProblems(
        structSynthetic({
          face: {
            order: ['tune'],
            hero: { control: 'tune', readouts: [{ label: 'tail', valueId: 'kickdrum-tail' }] },
          },
        }),
      ),
    ).toEqual([]);
  });

  it('NEGATIVE CONTROL (hero e): a readout with two sources, or an unknown param, FAILS', () => {
    const both = heroProblems(
      structSynthetic({
        face: { order: ['tune'], hero: { control: 'tune', readouts: [{ label: 'x', paramId: 'tune', text: 'y' }] } },
      }),
    );
    expect(both).toHaveLength(1);
    expect(both[0]).toContain('EXACTLY ONE source');

    const ghost = heroProblems(
      structSynthetic({
        face: { order: ['tune'], hero: { control: 'tune', readouts: [{ label: 'x', paramId: 'ghost' }] } },
      }),
    );
    expect(ghost).toHaveLength(1);
    expect(ghost[0]).toContain('is not a declared param');
  });

  it('NEGATIVE CONTROL (sidebar a): a preset naming an unknown param, or out of range, FAILS', () => {
    const ghost = sidebarProblems(
      structSynthetic({
        face: {
          order: ['tune'],
          sidebar: [{ kind: 'presets', label: 'p', entries: [{ id: 'a', label: 'A', values: { ghost: 1 } }] }],
        },
      }),
      new Set(sidebarPanelIds()),
    );
    expect(ghost).toHaveLength(1);
    expect(ghost[0]).toContain('is not a declared param');

    const oor = sidebarProblems(
      structSynthetic({
        face: {
          order: ['tune'],
          sidebar: [{ kind: 'presets', label: 'p', entries: [{ id: 'a', label: 'A', values: { tune: 999 } }] }],
        },
      }),
      new Set(sidebarPanelIds()),
    );
    expect(oor).toHaveLength(1);
    expect(oor[0]).toContain('outside its declared');
  });

  it('NEGATIVE CONTROL (sidebar b): an UNREGISTERED custom panelId FAILS', () => {
    const problems = sidebarProblems(
      structSynthetic({
        face: { order: ['tune'], sidebar: [{ kind: 'custom', label: 'c', panelId: 'no-such-panel' }] },
      }),
      new Set(sidebarPanelIds()),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('is not registered in sidebar-panels.ts');
  });

  it('NEGATIVE CONTROL (sidebar d): an EMPTY block FAILS', () => {
    const problems = sidebarProblems(
      structSynthetic({
        face: { order: ['tune'], sidebar: [{ kind: 'presets', label: 'p', entries: [] }] },
      }),
      new Set(sidebarPanelIds()),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('renders EMPTY');
  });

  it('NEGATIVE CONTROL (dead hint): a hint on a face over the TAB threshold FAILS', () => {
    // DOCK_TAB_MIN_BANDS pages, so `dockTabPlan` returns a rail and the band
    // headers (hint included) are suppressed.
    const params: ParamDef[] = Array.from({ length: DOCK_TAB_MIN_BANDS }, (_, i) => ({
      id: `p${i}`,
      label: `P${i}`,
      min: 0,
      max: 1,
      defaultValue: 0,
      curve: 'linear' as const,
    }));
    const def = structSynthetic({
      params,
      face: {
        order: params.map((p) => p.id),
        pages: params.map((p, i) => ({
          id: `pg${i}`,
          label: `PG${i}`,
          controls: [p.id],
          ...(i === 0 ? { hint: 'never seen' } : {}),
        })),
      },
    });
    const problems = deadHintProblems(def);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('can never render');

    // …and the SAME face under the threshold is clean (the control that proves
    // the rule is about TABS and not about hints).
    const untabbed = structSynthetic({
      params,
      face: {
        order: params.map((p) => p.id),
        pages: [{ id: 'only', label: 'ONLY', hint: 'seen', controls: params.map((p) => p.id) }],
      },
    });
    expect(deadHintProblems(untabbed)).toEqual([]);
  });
});

describe('module-face lint — STRICT_FACES RATCHET (only grows)', () => {
  // STRICT_FACES is an OPT-IN allowlist: a module is promoted once its co-located
  // `face` is authored + verified (see strict-faces.ts). This cap FREEZES the set
  // at today's size so it can only GROW — REMOVING a module (un-promotion) fails
  // this test on purpose.
  //   RATCHET RULE: strict lists only grow. RAISE the number when you promote a
  //   module (the P1 reskin waves). Only LOWER it for a real, justified
  //   un-promotion — NEVER to make a red face gate go green.
  it('STRICT_FACES never shrinks below its frozen floor', () => {
    // 6 (2026-07-25): P1 batch 1 — the first faced-module wave (adsr, cloudseed,
    // kickdrum, lfo, tidyVco, vca) raised the floor from the P0.4 empty seed.
    // 12 (2026-07-26): P1 batch 2 — dx7, qbrt, shimmershine, sixstrum,
    // snaredrum, tomtom.
    // 17 (2026-07-26): P1 batch 3 — delay, filter, karplus, mixer, reverb (the
    // plucked-string voice + the four workhorse processors/utilities). The five
    // module branches each deliberately LEFT this at their base value to avoid
    // a five-way conflict, so the batch integrator bumps it ONCE to the true
    // final |STRICT_FACES|.
    // 18 (2026-08-02): ringback — the stereo crush, promoted from having no
    // face at all.
    expect(
      STRICT_FACES.size,
      'STRICT_FACES shrank below its frozen floor — see the RATCHET rule above',
    ).toBeGreaterThanOrEqual(18);
  });
});
