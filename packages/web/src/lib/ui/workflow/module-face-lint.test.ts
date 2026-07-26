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
import type { ControlFamily, ModuleFace } from '$lib/graph/types';
import { staticKey, type LegendEntry } from '$lib/docs/control-doc-resolver';
import { STRICT_FACES } from './strict-faces';
import { dockFacePlan } from './curated-face';

interface FaceDef {
  type: string;
  inputs?: readonly { id: string }[];
  outputs?: readonly { id: string }[];
  params?: readonly { id: string; label?: string }[];
  controlFamilies?: readonly ControlFamily[];
  face?: ModuleFace;
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
const VALID_GLYPHS = new Set(['scope', 'meter', 'envelope', 'waveform', 'none']);

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
      const flat = plan.flatMap((band) => band.controls);

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
    expect(
      STRICT_FACES.size,
      'STRICT_FACES shrank below its frozen floor — see the RATCHET rule above',
    ).toBeGreaterThanOrEqual(6);
  });
});
