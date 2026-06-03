// packages/web/src/lib/ui/module-categories.test.ts
//
// Guard rails for the nested-add-module palette.
//
//  1. Every registered audio/video/meta module is classified — if a new
//     module lands without a category entry, this fires loudly so the
//     contributor can pick a home. (The UI also falls back to an
//     Uncategorized bucket so nothing is silently un-addable.)
//  2. The classification map only references real module ids — a typo
//     here would put a "ghost" entry in the menu that never matches a
//     real def. Catching this at unit-test time is cheaper than waiting
//     for the E2E.
//  3. groupDefs() honors the canonical top + sub ordering.

import { describe, expect, it } from 'vitest';

// Import the registries' barrel side-effects so listX() returns the
// full known set.
import '$lib/audio/modules';
import '$lib/video/modules';
import '$lib/meta/modules';

import { listModuleDefs } from '$lib/audio/module-registry';
import { listVideoModuleDefs } from '$lib/video/module-registry';
import { listMetaModuleDefs } from '$lib/meta/module-registry';

import {
  MODULE_CATEGORIES,
  TOP_ORDER,
  SUB_ORDER,
  categorize,
  categorizeDef,
  groupDefs,
} from './module-categories';

interface RegDef {
  type: string;
  label: string;
  palette?: { top: string; sub: string };
}

function allRegisteredDefs(): RegDef[] {
  return [
    ...(listModuleDefs() as unknown as RegDef[]),
    ...(listVideoModuleDefs() as unknown as RegDef[]),
    ...(listMetaModuleDefs() as unknown as RegDef[]),
  ];
}

function allRegisteredTypes(): string[] {
  return allRegisteredDefs().map((d) => d.type);
}

describe('per-def palette classification (registry source of truth)', () => {
  it('every registered module declares a palette on its def', () => {
    // The single source of truth is now the def's own `palette` field — no
    // edit to a shared module-categories map. A new module that forgets to
    // classify itself fires here (and would render under Uncategorized).
    const missing = allRegisteredDefs()
      .filter((d) => !d.palette)
      .map((d) => d.type);
    expect(missing, `defs missing palette: ${missing.join(', ')}`).toEqual([]);
  });

  it("every def's palette targets a known top + sub bucket", () => {
    for (const def of allRegisteredDefs()) {
      if (!def.palette) continue; // covered by the test above
      const { top, sub } = categorizeDef(def);
      expect(TOP_ORDER, `bad top for ${def.type}`).toContain(top);
      expect(SUB_ORDER[top], `bad sub for ${def.type}`).toContain(sub);
    }
  });
});

describe('MODULE_CATEGORIES legacy fallback map', () => {
  // The hand-map is now empty (all classifications moved onto defs). Kept as
  // a migration safety net + so `categorize(type)` still resolves anything a
  // straggler might reference. If a future contributor re-populates it, these
  // guards keep it honest.
  it('only references real registered module ids (no ghost entries)', () => {
    const known = new Set(allRegisteredTypes());
    const ghosts = Object.keys(MODULE_CATEGORIES).filter((t) => !known.has(t));
    expect(ghosts, `unknown module ids in classifier: ${ghosts.join(', ')}`).toEqual([]);
  });

  it('every legacy entry targets a known top + sub bucket', () => {
    for (const [type, entry] of Object.entries(MODULE_CATEGORIES)) {
      expect(TOP_ORDER, `bad top for ${type}`).toContain(entry.top);
      expect(SUB_ORDER[entry.top], `bad sub for ${type}`).toContain(entry.sub);
    }
  });
});

describe('categorize() / categorizeDef()', () => {
  it('falls back to Uncategorized for unknown ids', () => {
    expect(categorize('definitelyNotARealModule')).toEqual({
      top: 'Uncategorized',
      sub: 'Uncategorized',
    });
    expect(categorizeDef({ type: 'definitelyNotARealModule', label: 'x' })).toEqual({
      top: 'Uncategorized',
      sub: 'Uncategorized',
    });
  });

  it("categorizeDef reads the def's own palette field", () => {
    expect(
      categorizeDef({ type: 'scope', label: 'Scope', palette: { top: 'Hybrid', sub: 'Hybrid' } }),
    ).toEqual({ top: 'Hybrid', sub: 'Hybrid' });
    expect(
      categorizeDef({
        type: 'analogVco',
        label: 'Analog VCO',
        palette: { top: 'Audio modules', sub: 'VCOs' },
      }),
    ).toEqual({ top: 'Audio modules', sub: 'VCOs' });
  });
});

describe('groupDefs()', () => {
  it('returns top buckets in canonical order and drops empty ones', () => {
    const defs = [
      { type: 'analogVco', label: 'Analog VCO', palette: { top: 'Audio modules', sub: 'VCOs' } },
      { type: 'scope', label: 'Scope', palette: { top: 'Hybrid', sub: 'Hybrid' } },
      { type: 'lines', label: 'LINES', palette: { top: 'Video modules', sub: 'Sources' } },
    ];
    const out = groupDefs(defs);
    expect(out.map((g) => g.top)).toEqual(['Audio modules', 'Video modules', 'Hybrid']);
  });

  it('groups same-top defs by sub-category in canonical order', () => {
    const defs = [
      { type: 'reverb', label: 'Reverb', palette: { top: 'Audio modules', sub: 'Effects' } },
      { type: 'analogVco', label: 'Analog VCO', palette: { top: 'Audio modules', sub: 'VCOs' } },
      { type: 'mixer', label: 'Mixer', palette: { top: 'Audio modules', sub: 'Mixing' } },
      { type: 'vca', label: 'VCA', palette: { top: 'Audio modules', sub: 'Utility' } },
    ];
    const audio = groupDefs(defs).find((g) => g.top === 'Audio modules');
    expect(audio).toBeDefined();
    expect(audio!.subs.map((s) => s.name)).toEqual(['VCOs', 'Utility', 'Effects', 'Mixing']);
  });

  it('places MIDI bridge modules under the MIDI top bucket', () => {
    const defs = [
      { type: 'midiCvBuddy', label: 'MIDI-CV-BUDDY', palette: { top: 'MIDI', sub: 'MIDI' } },
      { type: 'midiclock', label: 'MIDICLOCK', palette: { top: 'MIDI', sub: 'MIDI' } },
      { type: 'analogVco', label: 'Analog VCO', palette: { top: 'Audio modules', sub: 'VCOs' } },
    ];
    const out = groupDefs(defs);
    const midi = out.find((g) => g.top === 'MIDI');
    expect(midi).toBeDefined();
    expect(midi!.subs.map((s) => s.name)).toEqual(['MIDI']);
    const ids = midi!.subs[0]!.defs.map((d) => d.type).sort();
    expect(ids).toEqual(['midiCvBuddy', 'midiclock']);
    // MIDI sits between Video and Hybrid in TOP_ORDER.
    expect(out.map((g) => g.top)).toEqual(['Audio modules', 'MIDI']);
  });

  it('places QBRT under Effects (per its registered def palette)', () => {
    const qbrt = allRegisteredDefs().find((d) => d.type === 'qbrt');
    expect(qbrt, 'qbrt registered').toBeDefined();
    expect(categorizeDef(qbrt!)).toEqual({ top: 'Audio modules', sub: 'Effects' });
  });

  it('surfaces unknown ids under Uncategorized rather than dropping them', () => {
    const defs = [{ type: 'totallyNew', label: 'TOTALLYNEW' }];
    const out = groupDefs(defs);
    expect(out).toHaveLength(1);
    expect(out[0]?.top).toBe('Uncategorized');
    expect(out[0]?.subs[0]?.defs.map((d) => d.type)).toEqual(['totallyNew']);
  });
});
