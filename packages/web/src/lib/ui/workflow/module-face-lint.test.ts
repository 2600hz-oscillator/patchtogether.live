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
//  3. SET IDENTITY: STRICT_FACES IS the set of defs that declare a `face` —
//     asserted in both directions, so un-promotion is red without any count.
//     (This replaced a `|STRICT_FACES| >= 18` floor on 2026-08-12; the trace of
//     what that protected sits where it stood, at the bottom of this file.)
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
import { glyphBinding } from './shell-glyph-live';
import {
  bandHeaderPlan,
  faceAnnotations,
  facePageHeader,
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
import {
  PACKED_RGB_MAX,
  PACKED_RGB_MIN,
  isPackedRgbParam,
} from '$lib/ui/controls/color-field-model';

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

  /**
   * Every problem with the glyphs a def DECLARES: a declared glyph must resolve
   * to a LIVE binding. Pure; `bind` is injected so the negative controls can
   * drive the same predicate the sweep drives.
   */
  function deadGlyphProblems(
    defs: readonly { type: string; face?: { glyph?: string } }[],
    bind: (def: unknown) => { kind: string },
  ): string[] {
    const problems: string[] = [];
    for (const def of defs) {
      const glyph = def.face?.glyph;
      if (!glyph || glyph === 'none') continue;
      const kind = bind(def).kind;
      if (kind === 'static') {
        problems.push(
          `${def.type}: face.glyph='${glyph}' resolves to a STATIC binding — nothing feeds it. ` +
            `A 'meter' with no tap renders twelve segments at VuMeter's \`level = 0\` default and ` +
            `a 'scope' renders a fixed trace, so the tile paints a live-looking readout of ` +
            `NOTHING. Give the module a seam the resolver can bind (glyphBinding: a primary ` +
            `AUDIO output, an A/D/S/R set, an \`algorithm\` param, a 0..2 \`shape\`), or declare ` +
            `\`glyph: 'none'\`.`,
        );
      }
    }
    return problems;
  }

  it('no declared glyph resolves to a DEAD (static) binding', () => {
    // ⚠ WRITTEN BECAUSE marbles SHIPPED EXACTLY THIS THROUGH THREE PASSES
    // (2026-08-11). It declared `glyph: 'meter'` on the argument that it
    // free-runs and a meter is what a 64 px tile can honestly say — but
    // `primaryAudioOutPortId` matches `type === 'audio'`, and marbles declares
    // none (t1/t2/clk are `gate`, x1/x2/x3 are `cv`). `glyphBinding` fell
    // through to `static`, `tap` was undefined, and the tile painted a meter
    // that could never move. NOTHING in the repo could see it: the VRT baseline
    // captures a dead meter perfectly deterministically, faces-parity does not
    // read the glyph, and the declaration itself is valid.
    //
    // UNCONDITIONAL, with NO exemption list and NO count, because the whole
    // faced roster already satisfies it: every declared glyph resolves to a
    // live binding (`live-audio` for the great majority, plus adsr's
    // `env-params`, dx7's `algorithm`, lfo's `wave-morph` and tidyVco's
    // `dual`), and the only `none` is marbles. A face that wants a glyph its
    // module cannot feed should say `none` and get the extra lane cell
    // instead.
    expect(deadGlyphProblems(allDefs() as never, (d) => glyphBinding(d as never))).toEqual([]);
  });

  it('NEGATIVE CONTROL: the dead-glyph predicate fires, and only on the dead case', () => {
    // Both directions against the REAL resolver, so the clause above cannot be
    // vacuously green: a module with a gate-only output and a `meter` is the
    // exact shape marbles had, and adding one audio output is the only change.
    const gateOnly = {
      type: 'synthetic',
      outputs: [{ id: 't1', type: 'gate' }],
      params: [],
      face: { order: [], glyph: 'meter' },
    };
    const withAudio = { ...gateOnly, outputs: [{ id: 'out', type: 'audio' }] };
    const noGlyph = { ...gateOnly, face: { order: [], glyph: 'none' } };

    expect(glyphBinding(gateOnly as never).kind, 'the dead shape really is static').toBe('static');
    expect(deadGlyphProblems([gateOnly] as never, (d) => glyphBinding(d as never))).toHaveLength(1);
    expect(deadGlyphProblems([withAudio] as never, (d) => glyphBinding(d as never))).toEqual([]);
    expect(deadGlyphProblems([noGlyph] as never, (d) => glyphBinding(d as never))).toEqual([]);
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
    // CLOUDS, 2026-08-10. FREEZE is a LATCH, and this is the one-word error
    // that would break the module's headline feature — its shape
    // (`0..1 discrete default 0`) is byte-identical to a press-pad's, which is
    // exactly why `face.momentary` exists.
    //
    // ⚠ THE MECHANISM IS NOT "THE WORKLET READS A LEVEL" — it is stranger than
    // that, and the conclusion survives the correction. `CloudsProcessor` ORs
    // the a-rate `freeze` param with the FRZ gate input and TOGGLES an internal
    // flag on each RISING EDGE, so the host sends one PULSE per intended state
    // change and the state lives in the worklet. A momentary render would pulse
    // on the press AND on the release — toggle on, toggle off — so the latch
    // would be un-holdable and the buffer could never actually freeze.
    'clouds:freeze',
    // COFEFVE, 2026-08-10. The tempo REFERENCE picker (System = the rack's
    // TIMELORDE bpm, MIDI = incoming 0xF8). `0..1 discrete resting at 0` is the
    // press-pad shape by coincidence of arity, not by intent: it is a two-state
    // choice you make once and leave. It also DECLARES `options`, so the dock
    // paints it as a captioned Segmented pair rather than an anonymous switch —
    // but the render kind and this classification answer different questions
    // (see paramCellKind's closing note), so it still needs acknowledging here.
    'cofefve:clockSource',
    // RINGS, 2026-08-11. The RESONATOR MODEL selector — MODAL (0) against
    // SYMPATHETIC (1). `0..1 discrete resting at 0` is the press-pad shape by
    // coincidence of arity: this is a two-state choice you make and leave, and
    // the worklet reads its LEVEL every sample (`modelIdx` selects which of the
    // two engines produces the block) rather than edge-detecting it, so a
    // momentary render would snap the instrument back to MODAL on release.
    // ⚠ IT DOES *NOT* DECLARE `options`, unlike cofefve's sibling above, so it
    // paints as an ANONYMOUS <Toggle>. That is a known wart rather than an
    // oversight: `MODAL`/`SYMPATHETIC` is a 5-against-11-character roster and
    // `.seg` is `flex: 1` (flex-BASIS 0), so the two buttons split the group
    // equally and the longer caption is guaranteed to ellipsize — the
    // shared-primitive defect cofefve measured and left for its own PR. The
    // face's `rings-body` hero readout names the live model instead.
    'rings:model',
    // REMOVED 2026-07-27 — 'tidyVco:hold'. The acknowledgement was WRONG (it
    // claimed "sample-and-hold ENGAGE"): the card drives it pointerdown/
    // CUBE, 2026-08-10. Three states you switch and leave: WRAP is a rule
    // about what happens where the slicing plane leaves the solid (silent vs
    // mirror-fold), MATERIAL picks the field's density model (smooth vs binary
    // solid) and SCREEN is the viz power switch. None is read on an edge —
    // `sampleSlice` reads all three as levels once per render, and `screen_on`
    // gates a rAF loop — and the module has no press-pad of any kind.
    'cube:wrap',
    'cube:material',
    'cube:screen_on',
    // WARREN'S SPECTRUM, 2026-08-15. Two params share the press-pad SHAPE
    // (`0..1 discrete resting at 0`) by coincidence of arity, and both are
    // states you set and leave. Both also declare `options`, so the dock paints
    // them as captioned Segmented pairs rather than anonymous switches — but
    // the render kind and this classification answer different questions
    // (paramCellKind's closing note), so they still need acknowledging.
    //
    // MODE picks between two DSP CLASSES. `setEngineMode` compares against the
    // PENDING mode and starts a 6 ms declick ramp on a real change; a momentary
    // render would fire that ramp twice per press and snap the instrument back
    // to SPECTRAL on release.
    'warrensspectrum:engineMode',
    // FREEZE is level-sensitive by construction and by repo rule: the worklet
    // reads `parameters.engineFreeze[0] >= 0.5` and ORs it with the `gate`
    // INPUT PORT, which the def declares `edge: 'gate'` precisely because
    // CLAUDE.md forbids converting a gate consumer to edge-only. A momentary
    // render would thaw the analyser the instant the pad was released, i.e.
    // the module's headline feature could never be held — the `clouds:freeze`
    // case, reached by the simpler mechanism.
    'warrensspectrum:engineFreeze',
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
   *   (d) the param carries the RANGE ITS OWN PRIMITIVE NEEDS. This clause is
   *       PER KIND, and splitting it was the point of the audit that added
   *       `'color'`:
   *         'grid'  — DISCRETE with 2..GRID_MAX_CELLS steps. The grid derives
   *                   one cell per integer, so `'grid'` on a 20..20000 Hz
   *                   cutoff is a twenty-thousand-cell popover.
   *         'color' — DISCRETE and EXACTLY the packed-RGB space (0..0xffffff).
   *                   A colour picker on a `0..2` mode param can only ever
   *                   write near-black values, and every def-reading gate
   *                   stays green while it does.
   *
   *       ⚠ ONE SHARED CLAUSE WOULD HAVE BEEN WORSE THAN NONE. A `'color'`
   *       param has 16 777 216 steps, so the grid clause would have REJECTED
   *       every legitimate colour cell — and the obvious repair ("skip the
   *       step check for kinds that are not grid") leaves `'color'` with NO
   *       range check at all, which is the shape this whole file exists to
   *       refuse. Deny by default, per kind: an unrecognised kind falls to the
   *       `default` arm and FAILS, so adding a third primitive without
   *       teaching this predicate cannot ship silently.
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
      const shape = `${p.min}..${p.max} ${p.curve}`;
      switch (kind) {
        case 'grid': {
          const steps = Math.floor(p.max) - Math.ceil(p.min) + 1;
          if (p.curve !== 'discrete' || steps < 2 || steps > GRID_MAX_CELLS) {
            problems.push(
              `${def.type}: face.paramCells['${key}'] = 'grid' but the param is ${shape} ` +
                `(${steps} step(s)) — a grid needs a DISCRETE param with 2..${GRID_MAX_CELLS} ` +
                `steps, or it paints one cell per integer across the whole range`,
            );
          }
          break;
        }
        case 'fader': {
          // A THROW is a CONTINUOUS scale. The one shape it must not back is a
          // discrete roster: those are `segmented`/`selector`/`grid` territory,
          // and a fader over 3 named states is a slider you cannot read. The
          // range itself is deliberately unconstrained — a level is a level
          // whether it is 0..1, 0..2 or −60..+6 dB.
          if (p.curve === 'discrete') {
            problems.push(
              `${def.type}: face.paramCells['${key}'] = 'fader' but the param is ${shape} — a ` +
                `throw needs a CONTINUOUS param. A discrete roster belongs on a segmented row, ` +
                `a selector or a grid, all of which NAME their states; a fader would show them ` +
                `as unlabelled detents on a scale.`,
            );
          }
          if (p.options?.length) {
            problems.push(
              `${def.type}: face.paramCells['${key}'] = 'fader' but the param declares an ` +
                `\`options\` roster — the roster names its states and a fader cannot show names. ` +
                `Drop one of the two declarations.`,
            );
          }
          break;
        }
        case 'color': {
          if (!isPackedRgbParam(p)) {
            problems.push(
              `${def.type}: face.paramCells['${key}'] = 'color' but the param is ${shape} — a ` +
                `colour cell needs a DISCRETE param spanning EXACTLY the packed-RGB space ` +
                `(${PACKED_RGB_MIN}..${PACKED_RGB_MAX}, i.e. 0xRRGGBB). A picker over any other ` +
                `range writes values that are not colours, and no def-reading gate can see that.`,
            );
          }
          break;
        }
        default:
          // DENY BY DEFAULT. A primitive added to the union without a clause
          // here would otherwise inherit "no range requirement" — which is
          // exactly how a declaration stops being validated.
          problems.push(
            `${def.type}: face.paramCells['${key}'] = '${kind}' has NO range clause in ` +
              `module-face-lint. Every declared primitive states what shape it can back; ` +
              `add the clause with the primitive.`,
          );
      }
    }
    return problems;
  }

  /**
   * `face.xyPads` drift — the checks a 2-D pad needs and no other cell does.
   *
   * The TYPE already guarantees the thing a `Record` could not: both axis ids
   * are required, so a pad naming one axis does not compile. What it cannot
   * guarantee is that the two ids MEAN anything, and every clause here is a way
   * for a well-typed pad to be a no-op or a lie:
   *
   *   - an axis naming no param → the pad renders nothing and the OTHER axis
   *     silently falls back to a knob, which is the exact downgrade the kind
   *     exists to end, now wearing a declaration;
   *   - an axis not RANKED → face completeness would already flag the missing
   *     control, but the message would blame the wrong thing;
   *   - x === y → one param on both axes: a diagonal-only pad, which looks
   *     operable and is a bug;
   *   - a param claimed by TWO pads, or by a pad AND `paramCells` → two cells
   *     racing for one param, and `declaredParamCells` would resolve it by
   *     insertion order, i.e. arbitrarily;
   *   - a MOMENTARY axis → a press-pad is not a coordinate;
   *   - a DISCRETE axis → a pad over steps is a stepper wearing a joystick.
   *     This is the mirror of the `grid`/`color` clauses (discrete-only) and
   *     matches `fader`'s (discrete-never) for the same reason: a continuous
   *     gesture needs a continuous scale under it.
   */
  function xyPadProblems(def: CellFaceDef): string[] {
    const pads = def.face?.xyPads ?? [];
    if (!pads.length) return [];
    const problems: string[] = [];
    const byId = new Map((def.params ?? []).map((p) => [p.id, p]));
    const ranked = new Set(def.face?.order ?? []);
    const momentary = new Set(def.face?.momentary ?? []);
    const declared = new Set(Object.keys(def.face?.paramCells ?? {}));
    const claimed = new Set<string>();

    for (const pad of pads) {
      if (pad.x === pad.y) {
        problems.push(
          `${def.type}: face.xyPads pad has x === y ('${pad.x}') — one param on both axes is a ` +
            `pad that can only move diagonally, and it looks perfectly operable`,
        );
      }
      for (const [axis, key] of [['x', pad.x], ['y', pad.y]] as const) {
        const p = byId.get(key);
        if (!p) {
          problems.push(
            `${def.type}: face.xyPads ${axis} = '${key}' is not a declared param — the pad ` +
              `cannot render and its OTHER axis falls back to a knob`,
          );
          continue;
        }
        if (!ranked.has(key)) {
          problems.push(
            `${def.type}: face.xyPads ${axis} = '${key}' is not ranked in face.order. Both axes ` +
              `must be ranked: 'x' positions the cell, and 'y' is what proves the param was not ` +
              `dropped from the face.`,
          );
        }
        if (momentary.has(key)) {
          problems.push(
            `${def.type}: face.xyPads ${axis} = '${key}' is also face.momentary — a press-pad ` +
              `is not a coordinate`,
          );
        }
        if (declared.has(key)) {
          problems.push(
            `${def.type}: '${key}' is claimed by BOTH face.xyPads and face.paramCells — two ` +
              `cells for one param, resolved by map insertion order, i.e. arbitrarily`,
          );
        }
        if (claimed.has(key)) {
          problems.push(
            `${def.type}: '${key}' is an axis of MORE THAN ONE pad — it can only render once`,
          );
        }
        claimed.add(key);
        if (p.curve === 'discrete' || p.options?.length) {
          problems.push(
            `${def.type}: face.xyPads ${axis} = '${key}' is DISCRETE — a pad over steps is a ` +
              `stepper wearing a joystick. A 2-D drag needs a continuous scale under both axes.`,
          );
        }
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
            `declares its own minWidth and cannot fit a 46px knob column. PROMOTE IT TO ` +
            `face.hero.cell (PF-22: a hero picture is dock-only, so it takes no lane rank and ` +
            `may rank FIRST), or rank it below the lane caps, or drop the panel.`,
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

  it('every face.xyPads axis is a ranked, non-momentary, CONTINUOUS param claimed once', () => {
    const problems: string[] = [];
    for (const def of allDefs()) problems.push(...xyPadProblems(def as unknown as CellFaceDef));
    expect(problems.join('\n'), 'face.xyPads drift — a pad that is a no-op or a contradiction').toBe('');
  });

  it('NEGATIVE CONTROL: every xyPads clause fires on a def built to violate exactly it', () => {
    // No shipped def declares a pad yet, so the sweep above is VACUOUSLY green
    // and would stay green if `xyPadProblems` were `return []`. Same argument
    // as the paramCells controls below it, and the same shape.
    const CONT = (id: string): ParamDef => ({
      id,
      label: id,
      min: -1,
      max: 1,
      defaultValue: 0,
      curve: 'linear',
    });
    const base = (over: Partial<CellFaceDef>): CellFaceDef => ({
      type: 'synthetic',
      params: [CONT('px'), CONT('py')],
      face: { order: ['px', 'py'], xyPads: [{ x: 'px', y: 'py' }] },
      ...over,
    });

    // Well-formed → silent. Without this the rest could pass by always firing.
    expect(xyPadProblems(base({}))).toEqual([]);
    // …and inert for a def with no pads at all.
    expect(xyPadProblems({ type: 's', params: [CONT('px')], face: { order: ['px'] } })).toEqual([]);

    const fires = (over: Partial<CellFaceDef>, needle: string) => {
      const out = xyPadProblems(base(over));
      expect(out.join('\n'), `expected a problem mentioning ${needle}`).toContain(needle);
    };
    fires({ face: { order: ['px'], xyPads: [{ x: 'px', y: 'ghost' }] } }, 'not a declared param');
    fires({ face: { order: ['px'], xyPads: [{ x: 'px', y: 'py' }] } }, 'not ranked in face.order');
    fires({ face: { order: ['px', 'py'], xyPads: [{ x: 'px', y: 'px' }] } }, 'x === y');
    fires(
      { face: { order: ['px', 'py'], xyPads: [{ x: 'px', y: 'py' }], momentary: ['py'] } },
      'is not a coordinate',
    );
    fires(
      {
        params: [CONT('px'), { id: 'py', label: 'py', min: 0, max: 3, defaultValue: 0, curve: 'discrete' }],
      },
      'is DISCRETE',
    );
    fires(
      {
        params: [CONT('px'), CONT('py'), CONT('pz'), CONT('pw')],
        face: {
          order: ['px', 'py', 'pz', 'pw'],
          xyPads: [{ x: 'px', y: 'py' }, { x: 'px', y: 'pw' }],
        },
      },
      'MORE THAN ONE pad',
    );
    fires(
      {
        params: [CONT('px'), CONT('py')],
        face: {
          order: ['px', 'py'],
          xyPads: [{ x: 'px', y: 'py' }],
          paramCells: { px: 'fader' },
        },
      },
      'face.paramCells',
    );
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

  // ── clause (d), the COLOUR half ─────────────────────────────────────────
  const COLOR_PARAM: ParamDef = {
    id: 'red_color',
    label: 'R.Col',
    min: PACKED_RGB_MIN,
    max: PACKED_RGB_MAX,
    defaultValue: 0xff3333,
    curve: 'discrete',
  };
  const colorDef = (over: Partial<ParamDef> = {}): CellFaceDef => ({
    type: 'synthetic',
    params: [{ ...COLOR_PARAM, ...over }],
    face: { order: ['red_color'], paramCells: { red_color: 'color' } },
  });

  it('NEGATIVE CONTROL (d-color): a well-formed packed-RGB declaration passes', () => {
    expect(paramCellProblems(colorDef())).toEqual([]);
  });

  it('NEGATIVE CONTROL (d-color): a colour cell on any OTHER range FAILS', () => {
    // The live authoring slip: `'color'` on a 3-state mode param. Every value
    // it can write is near-black, and contract-lock / module-docs-lint /
    // every range assertion stay green because the DEF is fine — it is the
    // declaration that is wrong, which is the whole reason this clause is here.
    const mode = paramCellProblems(colorDef({ max: 2, defaultValue: 0 }));
    expect(mode).toHaveLength(1);
    expect(mode[0]).toContain('spanning EXACTLY the packed-RGB space');

    // Continuous, and the two off-by-one bounds — each on its own, so a
    // predicate that only checked `curve` or only checked `max` would show up.
    expect(paramCellProblems(colorDef({ curve: 'linear' })), 'continuous').toHaveLength(1);
    expect(paramCellProblems(colorDef({ min: 1 })), 'floor off by one').toHaveLength(1);
    expect(paramCellProblems(colorDef({ max: PACKED_RGB_MAX - 1 })), 'ceiling off by one').toHaveLength(1);
  });

  it('NEGATIVE CONTROL (d-cross): the two clauses do NOT accept each other’s shape', () => {
    // ⚠ THE CLAUSE-SPLIT REGRESSION, IN ONE ASSERTION. Before the split there
    // was ONE range clause, written for the grid; a colour param has
    // 16 777 216 steps, so a shared clause would have rejected every valid
    // colour cell — and the lazy repair (skip the check unless kind==='grid')
    // would have left `'color'` with no range check at all. Each kind must
    // reject the other's shape.
    const gridOnColorRange = paramCellProblems({
      type: 'synthetic',
      params: [{ ...COLOR_PARAM, id: 'algorithm' }],
      face: { order: ['algorithm'], paramCells: { algorithm: 'grid' } },
    });
    expect(gridOnColorRange, 'a grid over 16.7M cells').toHaveLength(1);
    expect(gridOnColorRange[0]).toContain(`2..${GRID_MAX_CELLS} steps`);

    const colorOnGridRange = paramCellProblems({
      type: 'synthetic',
      params: [{ ...GRID_PARAM, id: 'red_color' }],
      face: { order: ['red_color'], paramCells: { red_color: 'color' } },
    });
    expect(colorOnGridRange, 'a colour picker over 1..32').toHaveLength(1);
    expect(colorOnGridRange[0]).toContain('packed-RGB space');
  });

  it('NEGATIVE CONTROL (d-deny): an UNKNOWN declared primitive FAILS by default', () => {
    // The clause that makes "add a third primitive and forget the lint" loud.
    // Cast because the union does not admit it — which is the point: the only
    // way here is a future widening of the type, and that widening must bring
    // its clause.
    const problems = paramCellProblems({
      type: 'synthetic',
      params: [GRID_PARAM],
      face: {
        order: ['algorithm'],
        paramCells: { algorithm: 'wheel' as unknown as 'grid' },
      },
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('NO range clause in module-face-lint');
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

    // PF-22 — the SAME panel at rank ONE, promoted to `face.hero.cell`: also
    // clean, because `laneOrder` never offers a hero picture to a lane tier.
    // This is the escape the rank floor did not have, and it is asserted THROUGH
    // the same predicate so the fix cannot be "the protection stopped running".
    const heroFirst = synthetic({
      face: {
        order: [panelKey, 'algorithm'],
        paramCells: { algorithm: 'grid' },
        hero: { cell: panelKey },
      },
      controlFamilies: [{ id: 'synthetic-panel', label: 'panel' }],
    });
    expect(panelTierProblems(heroFirst, panelKeys)).toEqual([]);

    // …and the exclusion is EXACTLY one key. A SECOND panel at rank 1, not the
    // hero, still fails at every lane tier it reaches — otherwise `laneOrder`
    // would read as "declaring any hero disables the check".
    const twoPanels = 'synthetic-other-{n}';
    const heroPlusStray = synthetic({
      face: {
        order: [twoPanels, panelKey, 'algorithm'],
        paramCells: { algorithm: 'grid' },
        hero: { cell: panelKey },
      },
      controlFamilies: [
        { id: 'synthetic-panel', label: 'panel' },
        { id: 'synthetic-other', label: 'other' },
      ],
    });
    const stray = panelTierProblems(heroPlusStray, new Set([panelKey, twoPanels]));
    expect(stray.length).toBe(3);
    expect(stray.every((p) => p.includes(twoPanels))).toBe(true);

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

  it('STRICT_FACES: the rear derivation is TOTAL — every declared port is addressed by exactly one hole', async () => {
    // ⚠ PR-4: a hole is no longer 1:1 with a port. A derived stereo pair
    // renders as ONE hole addressing TWO ports (owner Q5 — the pair-tie
    // retired in favour of a single stereo hole), so totality is stated over
    // the ADDRESSED-PORT set. Comparing hole COUNT to port count directly, as
    // this used to, would now be an assertion about a number that is supposed
    // to differ — and it would go red on every stereo module while proving
    // nothing about whether a port went missing.
    const { rearFieldPlan } = await import('./rear-card-model');
    const missing: string[] = [];
    for (const def of allDefs()) {
      if (!STRICT_FACES.has(def.type)) continue;
      const plan = rearFieldPlan(def as unknown as import('./rear-card-model').RearDefLike);
      const holes = [
        ...plan.bands.flatMap((b) => [
          ...b.holes.map((h) => ({ dir: 'input', h })),
          ...b.clusters.flatMap((c) => c.holes.map((h) => ({ dir: 'input', h }))),
        ]),
        ...plan.outputs.map((h) => ({ dir: 'output', h })),
      ];
      const rendered = holes.flatMap(({ dir, h }) =>
        h.stereoSiblingPortId
          ? [`${dir}:${h.portId}`, `${dir}:${h.stereoSiblingPortId}`]
          : [`${dir}:${h.portId}`],
      );
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
        missing.push(
          `${def.type}: addressed port count ${rendered.length} ≠ declared ${declared.length}`,
        );
      }
      // …and the model's own bookkeeping must agree with what we just counted,
      // so a bug that drops a hole AND mis-reports the totals cannot cancel out.
      if (plan.portCount !== declared.length) {
        missing.push(`${def.type}: plan.portCount ${plan.portCount} ≠ declared ${declared.length}`);
      }
      if (plan.holeCount !== holes.length) {
        missing.push(`${def.type}: plan.holeCount ${plan.holeCount} ≠ rendered holes ${holes.length}`);
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
   * EVERY DECLARED ANNOTATION MUST BE PAINTABLE with the switch on — the
   * `face.title`, the page `face.hint`, and every band `hint`.
   *
   * ⚠ THIS REPLACED AN AUTHORING RULE THAT WAS STANDING IN FOR A SHELL BUG.
   * The old clause said "a page `hint` on a TABBED face is dead metadata,
   * so do not declare one". True at the time and for the wrong reason: the
   * shell gated the whole band header on `{#if band.label && !dockTabs}` with
   * the hint NESTED inside, so suppressing the label on a tabbed face
   * suppressed the hint as a SIDE EFFECT — and it would have painted nowhere
   * even with annotations ON. The lint then forbade the correct declaration in
   * order to keep the incorrect renderer consistent, which is the wrong half to
   * pin. `bandHeaderPlan` asks the two questions separately, so a tabbed face
   * paints its hints, and this asserts REACHABILITY instead of prohibiting the
   * declaration.
   *
   * ⚠ AND IT IS THE SHELL'S OWN ARITHMETIC IT ASKS, not a re-derivation:
   * `heroFacePlan` → `bandHeaderPlan` / `facePageHeader` are the exact calls
   * ModuleShell makes. A gate that re-implements the layout it is checking can
   * only prove the two implementations agree. `plan` is injectable for exactly
   * one reason — the negative control feeds it the OLD coupled implementation
   * and requires this to go red, so the sweep is proven able to catch the bug
   * that actually shipped rather than merely being green about it.
   */
  function unreachableAnnotationProblems(
    def: StructFaceDef,
    plan: typeof bandHeaderPlan = bandHeaderPlan,
  ): string[] {
    const faceDef = def as unknown as FaceplateDefLike;
    const declared = faceAnnotations(faceDef);
    if (!declared.length) return [];

    // The bands the SHELL renders — post-hero-split, since a band the hero
    // emptied is dropped and its hint goes with it.
    const bands = heroFacePlan(faceDef, dockFacePlan(def)).bands;
    const tabbed = !!dockTabPlan(bands);
    const painted = new Set<string>();
    const header = facePageHeader(faceDef, true);
    if (header?.title) painted.add(header.title);
    if (header?.hint) painted.add(header.hint);
    for (const b of bands) {
      const h = plan(b, { tabbed, annotations: true }).hint;
      if (h) painted.add(h);
    }

    return declared
      .filter((a) => !painted.has(a.text))
      .map(
        (a) =>
          `${def.type}: the ${a.kind} annotation “${a.text.slice(0, 56)}…” is DECLARED but the ` +
            `shell paints it NOWHERE, even with annotations ON (tabbed=${tabbed}) — authored, ` +
            `reviewed and rendered nowhere`,
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

  it('every declared ANNOTATION is reachable — title, page hint and band hints all paint', () => {
    const problems: string[] = [];
    for (const def of allDefs()) {
      if (!def.face) continue;
      problems.push(...unreachableAnnotationProblems(def as unknown as StructFaceDef));
    }
    expect(problems.join('\n'), 'unreachable annotation prose').toBe('');
  });

  /**
   * THE MARKUP HALF, guarded at the SOURCE — and the honest reason it has to be.
   *
   * The sweep above asks the MODEL whether a hint is reachable. The model is not
   * what renders it. `bandHeaderPlan` can be perfectly correct while the shell
   * re-nests the hint inside the label's `{#if}` and the prose paints nowhere
   * again — which is precisely the two-sided-contract blindness CLAUDE.md
   * describes, and precisely the bug this commit fixed.
   *
   * A runtime gate cannot see it TODAY: the failing case needs a hint declared
   * on a TABBED face, and no def declares one (the lint used to forbid it;
   * cloudseed's eight land in #1307). So until an adopter exists, the only place
   * the coupling can be caught is the source — the same argument, and the same
   * technique, as the `controlFamilies` → card-testid grep below.
   *
   * ⚠ WHAT THIS IS NOT: it is not a claim the markup renders correctly. It is a
   * claim the markup asks the MODEL and has SOMEWHERE to put a rail-less hint.
   * The moment a tabbed face declares one, the registry e2e sweep's per-surface
   * COUNT (`.page-hint` === declared `bandHints`) takes over as the real gate
   * and this becomes belt-and-braces.
   */
  /**
   * Strip what a source grep must NOT read: HTML comments, block comments and
   * line comments.
   *
   * ⚠ NOT tidiness — the gate below tripped on ITSELF the first time it ran.
   * The fix for the coupling documents the coupling, so `{#if band.label &&
   * !dockTabs}` appears verbatim in the very comment explaining why it is gone.
   * A grep that cannot tell prose from code turns "explain the bug you fixed"
   * into a lint failure, which trains the next author to delete the
   * explanation. So the predicate reads CODE, and a comment quoting the old
   * form is required to stay green (asserted in the negative control).
   */
  function codeOnly(src: string): string {
    return src
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  }

  /** The three source facts, as a pure predicate so the negative control can
   *  feed it a deliberately-recoupled shell and require the report. */
  function bandHeaderMarkupProblems(rawSrc: string): string[] {
    const src = codeOnly(rawSrc);
    const problems: string[] = [];
    if (!/bandHeaderPlan\(\s*band\s*,/.test(src)) {
      problems.push(
        'ModuleShell no longer calls bandHeaderPlan(band, …) — the band header decides ' +
          'label/hint suppression on its own again, so the model this file gates is not what renders',
      );
    }
    // The coupled predicate, whitespace-insensitive: `band.label && !dockTabs`.
    if (/band\.label\s*&&\s*!\s*dockTabs/.test(src)) {
      problems.push(
        'ModuleShell gates the band header on `band.label && !dockTabs` again. That couples the ' +
          'HINT to the tab RAIL: a tabbed face then paints no prose in ANY state, even with ' +
          'annotations on. The two suppressions are independent — see bandHeaderPlan.',
      );
    }
    if (!src.includes('page-hint-solo')) {
      problems.push(
        'ModuleShell has no `page-hint-solo` branch — with a rail up there is no <h4> to hang the ' +
          'hint inside, so a tabbed face’s prose has nowhere to land and silently paints nowhere',
      );
    }
    return problems;
  }

  const MODULE_SHELL_SRC = () =>
    readFileSync(fileURLToPath(new URL('../modules/ModuleShell.svelte', import.meta.url)), 'utf8');

  it('ModuleShell asks bandHeaderPlan — the band hint is NOT re-nested inside the label', () => {
    expect(bandHeaderMarkupProblems(MODULE_SHELL_SRC()).join('\n'), 'ModuleShell band-header markup').toBe('');
  });

  it('NEGATIVE CONTROL (markup): the OLD COUPLED shell markup FAILS all three clauses', () => {
    // Without this the grep above is three `includes` that could each be
    // inverted and stay green. The stub is the markup that actually shipped.
    const coupled = `
      {#each dockBands as band (band.id)}
        <section class="dock-page">
          {#if band.label && !dockTabs}
            <h4 class="page-label">
              {band.label}{#if band.hint && annotations}<span class="page-hint">{band.hint}</span>{/if}
            </h4>
          {/if}
        </section>
      {/each}`;
    const problems = bandHeaderMarkupProblems(coupled);
    expect(problems).toHaveLength(3);
    expect(problems.join('\n')).toContain('no longer calls bandHeaderPlan');
    expect(problems.join('\n')).toContain('couples the HINT to the tab RAIL');
    expect(problems.join('\n')).toContain('no `page-hint-solo` branch');

    // …and whitespace does not let the coupled predicate slip past.
    expect(bandHeaderMarkupProblems('band.label   &&  ! dockTabs page-hint-solo bandHeaderPlan(band ,')).toHaveLength(1);
  });

  it('NEGATIVE CONTROL (markup): a COMMENT quoting the old form is not a violation', () => {
    // The other direction, and it is the one that bit: this gate tripped on the
    // very comment that explains the coupling it forbids. A lint that punishes
    // documenting the bug teaches the next author to delete the documentation,
    // so "prose may name the old form" is an asserted property, not a habit.
    const documented = `
      <!-- the old \`{#if band.label && !dockTabs}\` nested the hint inside the label -->
      /* also band.label && !dockTabs, in a block comment */
      // and band.label && !dockTabs on a line
      {@const head = bandHeaderPlan(band, { tabbed: !!dockTabs, annotations })}
      {#if head.label}<h4 class="page-label"></h4>
      {:else if head.hint}<p class="page-hint page-hint-solo">{head.hint}</p>{/if}`;
    expect(bandHeaderMarkupProblems(documented)).toEqual([]);

    // …while the SAME file with one live occurrence still fails, so the
    // comment-stripping cannot be the thing making it green.
    expect(bandHeaderMarkupProblems(`${documented}\n{#if band.label && !dockTabs}{/if}`)).toHaveLength(1);
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

  /** A TABBED face (DOCK_TAB_MIN_BANDS pages, so `dockTabPlan` returns a rail)
   *  whose first band declares a hint — the exact shape that rendered nowhere
   *  before `bandHeaderPlan` split the two suppressions apart. */
  function tabbedFaceWithHint(hint = 'the band prose'): StructFaceDef {
    const params: ParamDef[] = Array.from({ length: DOCK_TAB_MIN_BANDS }, (_, i) => ({
      id: `p${i}`,
      label: `P${i}`,
      min: 0,
      max: 1,
      defaultValue: 0,
      curve: 'linear' as const,
    }));
    return structSynthetic({
      params,
      face: {
        order: params.map((p) => p.id),
        pages: params.map((p, i) => ({
          id: `pg${i}`,
          label: `PG${i}`,
          controls: [p.id],
          ...(i === 0 ? { hint } : {}),
        })),
      },
    });
  }

  it('NEGATIVE CONTROL (annotation reach): the OLD COUPLED header planner FAILS on a tabbed face', () => {
    // THE INSTRUMENT'S OWN NEGATIVE CONTROL, and it ships permanently. The
    // sweep above is green today; that is only meaningful if it can go red for
    // the bug it was written for. So feed it the header rule the shell actually
    // had — hint nested inside `label && !tabbed` — and require the report.
    const coupled: typeof bandHeaderPlan = (band, opts) => {
      const label = opts.tabbed ? '' : (band.label?.trim() ?? '');
      return { label, hint: label && opts.annotations ? (band.hint?.trim() ?? '') : '' };
    };

    const def = tabbedFaceWithHint();
    const problems = unreachableAnnotationProblems(def, coupled);
    expect(problems, 'the coupled planner drops the tabbed face’s hint').toHaveLength(1);
    expect(problems[0]).toContain('paints it NOWHERE');
    expect(problems[0]).toContain('tabbed=true');

    // …and the REAL planner is clean on the SAME face — the control that proves
    // the report is about the COUPLING and not about tabs or hints as such.
    expect(unreachableAnnotationProblems(def)).toEqual([]);

    // …and the coupled planner is clean on an UNTABBED face, so the negative
    // control is not simply "this stub always fails".
    const untabbed = structSynthetic({
      face: {
        order: ['tune'],
        pages: [{ id: 'only', label: 'ONLY', hint: 'seen', controls: ['tune'] }],
      },
    });
    expect(unreachableAnnotationProblems(untabbed, coupled)).toEqual([]);
  });

  it('NEGATIVE CONTROL (annotation reach): a hint on a band NOTHING renders FAILS', () => {
    // The other unreachable shape, and the one Change C makes possible: the
    // hero PROMOTES the band's only control, `heroFacePlan` drops the emptied
    // band, and the hint declared on it now has no header to live in.
    const def = structSynthetic({
      face: {
        order: ['tune'],
        hero: { control: 'tune' },
        pages: [{ id: 'solo', label: 'SOLO', hint: 'orphaned by the hero', controls: ['tune'] }],
      },
    });
    const problems = unreachableAnnotationProblems(def);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('orphaned by the hero');
    expect(problems[0]).toContain('band-hint');
  });

  it('NEGATIVE CONTROL (annotation reach): a face.title + face.hint both resolve', () => {
    const def = structSynthetic({
      face: {
        order: ['tune'],
        title: 'Voice',
        hint: 'one bus',
        pages: [{ id: 'a', label: 'A', hint: 'a band note', controls: ['tune'] }],
      },
    });
    expect(unreachableAnnotationProblems(def)).toEqual([]);
    // …and all three are in the roster, so the toggle appears for a face that
    // declares ONLY a title (which, since 2026-08-02, paints nowhere without it).
    expect(faceAnnotations(def as unknown as FaceplateDefLike).map((a) => a.kind)).toEqual([
      'title',
      'page-hint',
      'band-hint',
    ]);
  });
});

describe('module-face lint — STRICT_FACES is DERIVED FROM THE ARTIFACT, not floored', () => {
  // ⚠ `STRICT_FACES.size >= 18` IS GONE (2026-08-12, the no-ratchets sweep).
  //
  // WHAT IT PROTECTED: un-promotion. A module quietly deleted from STRICT_FACES
  // drops out of the completeness / dock-parity / rear-totality / momentary
  // bars above and is checked only for consistency — a way to make a red face
  // gate green.
  //
  // WHY A FLOOR WAS THE WRONG SHAPE, and this file said so itself. The deleted
  // comment recorded the number being LEFT AT 18 through face batch 3 because
  // seven concurrent branches would otherwise have collided on one literal —
  // i.e. the construct was already being worked around, with four cards of
  // slack, and `|STRICT_FACES|` was 32 by the time it was removed. A ratchet
  // with 14 free slots is not a ratchet.
  //
  // WHAT CARRIES IT INSTEAD — the same protection, DERIVED, with no slack: a
  // face is a property of the def, so read it off the def. Any module that
  // declares a `face` MUST be promoted. Removing a name from STRICT_FACES while
  // the def still declares its face is now RED, which is the gate-dodge the
  // floor existed for; un-promoting for real means deleting the `face`, which
  // is a large and obvious diff.
  //
  // ⚠ POLICY THIS MAKES EXPLICIT: authoring a `face` IS the promotion. The
  // header prose above still says unpromoted faces 'degrade gracefully while
  // the ratchet rolls out' — measured 2026-08-12, that population is EMPTY: 32
  // defs declare a face and all 32 are in STRICT_FACES. This pins the live
  // state rather than raising the bar.
  it('every module that declares a `face` is in STRICT_FACES (deny-by-default)', () => {
    const unpromoted = allDefs()
      .filter((def) => def.face && !STRICT_FACES.has(def.type))
      .map((def) => def.type)
      .sort();
    expect(
      unpromoted,
      'module(s) declaring a co-located `face` that are not in STRICT_FACES. Authoring a ' +
        'face IS the promotion — add them to strict-faces.ts. (If this went red on a ' +
        'DELETION from STRICT_FACES: that is the un-promotion this replaced the frozen ' +
        'floor to catch. Un-promote by removing the `face`, not the name.)',
    ).toEqual([]);
  });

  it('ANCHORED TO THE ARTIFACT: no STRICT_FACES name lacks a live `face`', () => {
    // The other direction, already covered for completeness at the top of this
    // file ('in STRICT_FACES but has no face'), restated here as a set identity
    // so the pair reads as one claim: STRICT_FACES IS the faced population.
    const faced = new Set(allDefs().filter((d) => d.face).map((d) => d.type));
    expect(
      [...STRICT_FACES].filter((t) => !faced.has(t)).sort(),
      'STRICT_FACES name(s) with no co-located `face` on a live def — delete them',
    ).toEqual([]);
  });
});
