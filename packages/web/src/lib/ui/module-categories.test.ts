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
  groupDefs,
} from './module-categories';

function allRegisteredTypes(): string[] {
  return [
    ...listModuleDefs().map((d) => d.type),
    ...listVideoModuleDefs().map((d) => d.type),
    ...listMetaModuleDefs().map((d) => d.type),
  ];
}

describe('MODULE_CATEGORIES', () => {
  it('classifies every registered module (no Uncategorized fallback hits)', () => {
    const missing = allRegisteredTypes().filter((t) => !(t in MODULE_CATEGORIES));
    expect(missing, `unclassified modules: ${missing.join(', ')}`).toEqual([]);
  });

  it('only references real registered module ids (no ghost entries)', () => {
    const known = new Set(allRegisteredTypes());
    const ghosts = Object.keys(MODULE_CATEGORIES).filter((t) => !known.has(t));
    expect(ghosts, `unknown module ids in classifier: ${ghosts.join(', ')}`).toEqual([]);
  });

  it('every classification entry targets a known top + sub bucket', () => {
    for (const [type, entry] of Object.entries(MODULE_CATEGORIES)) {
      expect(TOP_ORDER, `bad top for ${type}`).toContain(entry.top);
      expect(SUB_ORDER[entry.top], `bad sub for ${type}`).toContain(entry.sub);
    }
  });
});

describe('categorize()', () => {
  it('falls back to Uncategorized for unknown ids', () => {
    expect(categorize('definitelyNotARealModule')).toEqual({
      top: 'Uncategorized',
      sub: 'Uncategorized',
    });
  });

  it('returns the configured bucket for a known id', () => {
    expect(categorize('scope')).toEqual({ top: 'Hybrid', sub: 'Hybrid' });
    expect(categorize('analogVco')).toEqual({ top: 'Audio modules', sub: 'VCOs' });
  });
});

describe('groupDefs()', () => {
  it('returns top buckets in canonical order and drops empty ones', () => {
    const defs = [
      { type: 'analogVco', label: 'Analog VCO' },
      { type: 'scope', label: 'Scope' },
      { type: 'lines', label: 'LINES' },
    ];
    const out = groupDefs(defs);
    expect(out.map((g) => g.top)).toEqual(['Audio modules', 'Video modules', 'Hybrid']);
  });

  it('groups same-top defs by sub-category in canonical order', () => {
    const defs = [
      { type: 'reverb', label: 'Reverb' }, // Effects
      { type: 'analogVco', label: 'Analog VCO' }, // VCOs
      { type: 'mixer', label: 'Mixer' }, // Mixing
      { type: 'vca', label: 'VCA' }, // Utility
    ];
    const audio = groupDefs(defs).find((g) => g.top === 'Audio modules');
    expect(audio).toBeDefined();
    expect(audio!.subs.map((s) => s.name)).toEqual(['VCOs', 'Utility', 'Effects', 'Mixing']);
  });

  it('places MIDI bridge modules under the MIDI top bucket', () => {
    const defs = [
      { type: 'midiCvBuddy', label: 'MIDI-CV-BUDDY' },
      { type: 'midiclock', label: 'MIDICLOCK' },
      { type: 'analogVco', label: 'Analog VCO' },
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

  it('places QBRT under Effects', () => {
    expect(categorize('qbrt')).toEqual({ top: 'Audio modules', sub: 'Effects' });
  });

  it('surfaces unknown ids under Uncategorized rather than dropping them', () => {
    const defs = [{ type: 'totallyNew', label: 'TOTALLYNEW' }];
    const out = groupDefs(defs);
    expect(out).toHaveLength(1);
    expect(out[0]?.top).toBe('Uncategorized');
    expect(out[0]?.subs[0]?.defs.map((d) => d.type)).toEqual(['totallyNew']);
  });
});
