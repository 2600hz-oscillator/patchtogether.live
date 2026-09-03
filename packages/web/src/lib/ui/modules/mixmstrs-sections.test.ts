// packages/web/src/lib/ui/modules/mixmstrs-sections.test.ts
//
// THE MIXMSTRS ROW COUNT.
//
// MIXMSTRS is the one card that names every patch-panel row by hand, and the
// picker DROPS an id the def does not declare without a word. A typo, a renamed
// port or a channel-count change silently removes a jack. This is the gate that
// makes that red — and PR-4 raises the stakes, because collapse also removes
// rows (deliberately), so "a row is missing" and "a row collapsed" now look the
// same from the outside unless something counts them.
//
// It asserts THREE separate things, because any one of them alone is blind:
//   1. NOTHING WAS DROPPED — `missing` is empty (anchored to the live def).
//   2. The RAW row count per section, so a def change is visible.
//   3. The COLLAPSED row count per section — what PatchPanel actually renders
//      — and that exactly the L/R pair collapsed, by name.

import { describe, expect, it } from 'vitest';

import { mixmstrsDef, MIXMSTRS_CHANNELS, MIXMSTRS_RETURNS } from '$lib/audio/modules/mixmstrs';
import { collapseStereoPorts } from '$lib/ui/stereo-jack-collapse';
import type { StereoPairDefLike } from '$lib/graph/stereo-pairs';
import { mixmstrsSectionPlan } from './mixmstrs-sections';

const plan = mixmstrsSectionPlan(mixmstrsDef, MIXMSTRS_CHANNELS, MIXMSTRS_RETURNS);
const stereoDef = mixmstrsDef as unknown as StereoPairDefLike;

const bySection = new Map(plan.sections.map((s) => [s.label, s]));

describe('MIXMSTRS patch-panel sections — nothing is silently dropped', () => {
  it('the def is loaded and has the shape the section builder assumes', () => {
    // Vacuity guard: an empty def would make every count below trivially true.
    expect(MIXMSTRS_CHANNELS.length).toBe(8);
    expect(MIXMSTRS_RETURNS.length).toBe(2);
    expect(mixmstrsDef.inputs.length).toBeGreaterThan(90);
  });

  it('EVERY hand-picked id resolves on the def', () => {
    // THE gate. `missing` is anchored to the live def, so a renamed or removed
    // port names itself here instead of quietly costing a jack.
    expect(plan.missing).toEqual([]);
  });

  it('every section is present and non-empty', () => {
    expect(plan.sections.map((s) => s.label)).toEqual([
      'Ch1', 'Ch2', 'Ch3', 'Ch4', 'Ch5', 'Ch6', 'Ch7', 'Ch8',
      'Ret1', 'Ret2',
      'Master',
    ]);
    for (const s of plan.sections) {
      expect((s.inputs?.length ?? 0) + (s.outputs?.length ?? 0), s.label).toBeGreaterThan(0);
    }
  });

  it('RAW row counts per section (pre-collapse)', () => {
    // 14 per channel: L/R + volume/low/mid/high + thresh/ratio/compEnable +
    // the comp macro + send1/send2, then the two CLIP-RECORD jacks
    // (`ch{N}_rec`, `ch{N}_mon`) — a gate can arm a channel and a CV can pick
    // its monitor mode, which is only TRUE if the jack is picked here.
    for (const ch of MIXMSTRS_CHANNELS) {
      expect(bySection.get(`Ch${ch}`)!.inputs, `Ch${ch}`).toHaveLength(14);
    }
    for (const r of MIXMSTRS_RETURNS) {
      expect(bySection.get(`Ret${r}`)!.inputs, `Ret${r}`).toHaveLength(6);
    }
    // 5: master_volume + the two send pre/post switches + recTap + recQuality.
    expect(bySection.get('Master')!.inputs).toHaveLength(5);
    expect(bySection.get('Master')!.outputs).toHaveLength(6);
    const total = plan.sections.reduce(
      (n, s) => n + (s.inputs?.length ?? 0) + (s.outputs?.length ?? 0),
      0,
    );
    expect(total).toBe(8 * 14 + 2 * 6 + 5 + 6);
  });
});

describe('MIXMSTRS patch-panel sections — what PatchPanel RENDERS (collapsed)', () => {
  const collapsedIn = (label: string) =>
    collapseStereoPorts(bySection.get(label)!.inputs ?? [], stereoDef, 'input');
  const collapsedOut = (label: string) =>
    collapseStereoPorts(bySection.get(label)!.outputs ?? [], stereoDef, 'output');

  it('each channel strip renders 13 rows — one fewer, and it is the L/R pair', () => {
    for (const ch of MIXMSTRS_CHANNELS) {
      const rows = collapsedIn(`Ch${ch}`);
      expect(rows, `Ch${ch}`).toHaveLength(13);
      // Named, not just counted: the row that disappeared is `ch{n}R`, and the
      // survivor addresses it. A count alone would be satisfied by ANY dropped
      // row — including a genuinely lost CV jack.
      expect(rows.map((r) => r.id)).not.toContain(`ch${ch}R`);
      const stereo = rows.find((r) => r.id === `ch${ch}L`)!;
      expect(stereo.siblingId).toBe(`ch${ch}R`);
      expect(stereo.label).toBe(`CH${ch}`);
      // …and every non-audio row survives untouched.
      expect(rows.filter((r) => r.siblingId)).toHaveLength(1);
    }
  });

  it('each return strip renders 5 rows — retNL/retNR collapse', () => {
    for (const r of MIXMSTRS_RETURNS) {
      const rows = collapsedIn(`Ret${r}`);
      expect(rows, `Ret${r}`).toHaveLength(5);
      expect(rows.find((row) => row.id === `ret${r}L`)!.siblingId).toBe(`ret${r}R`);
      expect(rows.map((row) => row.id)).not.toContain(`ret${r}R`);
    }
  });

  it('Master renders 5 input rows (no pair) and 3 output rows (three pairs)', () => {
    expect(collapsedIn('Master')).toHaveLength(5);
    const outs = collapsedOut('Master');
    expect(outs.map((o) => [o.id, o.siblingId, o.label])).toEqual([
      ['masterL', 'masterR', 'MASTER'],
      ['send1L', 'send1R', 'SEND 1'],
      ['send2L', 'send2R', 'SEND 2'],
    ]);
  });

  it('TOTAL rendered rows: 135 → 122, and every dropped id is a right leg', () => {
    const rawIds: string[] = [];
    const renderedIds: string[] = [];
    for (const s of plan.sections) {
      rawIds.push(...(s.inputs ?? []).map((p) => p.id), ...(s.outputs ?? []).map((p) => p.id));
      renderedIds.push(
        ...collapsedIn(s.label).map((p) => p.id),
        ...collapsedOut(s.label).map((p) => p.id),
      );
    }
    expect(rawIds).toHaveLength(135); // 8×14 + 2×6 + 5 + 6
    expect(renderedIds).toHaveLength(122); // 13 pairs collapse: 8 ch + 2 ret + 3 master
    const dropped = rawIds.filter((id) => !renderedIds.includes(id)).sort();
    expect(dropped).toEqual(
      [
        ...MIXMSTRS_CHANNELS.map((ch) => `ch${ch}R`),
        ...MIXMSTRS_RETURNS.map((r) => `ret${r}R`),
        'masterR',
        'send1R',
        'send2R',
      ].sort(),
    );
  });

  it('every RAW id is still ADDRESSED by some rendered row', () => {
    // The difference between "collapsed" and "lost". A row addresses its own
    // port and, when it is a stereo row, its sibling — so the union must be the
    // raw set exactly.
    for (const s of plan.sections) {
      for (const [dir, raw, rows] of [
        ['input', s.inputs ?? [], collapsedIn(s.label)],
        ['output', s.outputs ?? [], collapsedOut(s.label)],
      ] as const) {
        const addressed = rows
          .flatMap((r) => (r.siblingId ? [r.id, r.siblingId] : [r.id]))
          .sort();
        expect(addressed, `${s.label} ${dir}`).toEqual(raw.map((p) => p.id).sort());
      }
    }
  });
});
