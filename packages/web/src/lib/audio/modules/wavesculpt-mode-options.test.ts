// packages/web/src/lib/audio/modules/wavesculpt-mode-options.test.ts
//
// THE NINE VISUALISATION / FX STATES, PINNED BY NAME.
//
// `fxType{1..4}`, `video_mode` and `blink_mode` are 3-state discrete params
// that shipped with no `options` roster, so the shell painted six ANONYMOUS
// KNOBS reading `0.00` / `1.00` / `2.00` — the filter LP/HP/BP defect (PF-1's
// founding case) six times on one module. Naming the states turns them into
// segmented pickers at the dock and gives the lane dial a real readout.
//
// ⚠ THE NAMES ARE NOT NEW TEXT. All nine were already written down, in the
// def's own `docs.controls` prose, and wavesculpt is in STRICT_DOCS — so they
// are gated documentation rather than comments. This file holds the roster and
// that prose together: rename a state in one place and the other reddens.
// Without it the two drift silently, and the drift is invisible (a doc page
// saying SPECTROGRAPH beside a button saying SPECTRO is not a test failure
// anywhere else in the repo).
//
// ⚠ AND THE CARD IS THE THIRD COPY. `WavesculptCard.svelte` carried its own
// `const BLINK_MODE_NAMES` plus three inline ternaries — a second source of
// truth for a vocabulary, which is exactly what `card-range-source` records
// against FilterCard's private `const MODES = ['LP','HP','BP']`. The last
// clause below greps the card to keep it reading the def's roster.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BLINK_MODE_OPTIONS,
  CHORD_QUALITY_OPTIONS,
  FX_TYPE_OPTIONS,
  VIDEO_MODE_OPTIONS,
  wavesculptDef,
} from './wavesculpt';


/** The def's authored control prose, keyed by param id. */
const controls = (wavesculptDef.docs?.controls ?? {}) as Record<string, string>;

const param = (id: string) => wavesculptDef.params.find((p) => p.id === id)!;

/**
 * The nine states, spelled out. A test that derived this list from the rosters
 * could not notice one going missing — the whole point is that it is TYPED
 * HERE and compared against the code.
 */
const NINE_STATES = {
  fxType: ['OFF', 'REVERB', 'DELAY'],
  video_mode: ['PROXIMITY', 'BIRDSEYE', 'SPECTROGRAPH'],
  blink_mode: ['RIBBONS', 'SCOPES TRIAL', 'REALITY BASED COMMUNITY'],
} as const;

describe('wavesculpt mode rosters — the nine states, by name', () => {
  it('the FX slot names OFF / REVERB / DELAY', () => {
    expect(FX_TYPE_OPTIONS.map((o) => o.label)).toEqual([...NINE_STATES.fxType]);
  });

  it('VIEW names PROXIMITY / BIRDSEYE / SPECTROGRAPH', () => {
    expect(VIDEO_MODE_OPTIONS.map((o) => o.label)).toEqual([...NINE_STATES.video_mode]);
  });

  it('BLINK names RIBBONS / SCOPES TRIAL / REALITY BASED COMMUNITY', () => {
    expect(BLINK_MODE_OPTIONS.map((o) => o.label)).toEqual([...NINE_STATES.blink_mode]);
  });

  it('nine states in total — nothing lost, nothing renamed', () => {
    const all = [
      ...FX_TYPE_OPTIONS.map((o) => o.label),
      ...VIDEO_MODE_OPTIONS.map((o) => o.label),
      ...BLINK_MODE_OPTIONS.map((o) => o.label),
    ];
    expect(all).toHaveLength(9);
    expect(new Set(all).size, 'every state name is distinct').toBe(9);
  });
});

describe('wavesculpt mode rosters — every mode param carries its roster', () => {
  const rows: [string, readonly { value: number; label: string }[]][] = [
    ['fxType1', FX_TYPE_OPTIONS],
    ['fxType2', FX_TYPE_OPTIONS],
    ['fxType3', FX_TYPE_OPTIONS],
    ['fxType4', FX_TYPE_OPTIONS],
    ['video_mode', VIDEO_MODE_OPTIONS],
    ['blink_mode', BLINK_MODE_OPTIONS],
    // ⚠ chord_quality is NOT one of the nine visualisation/FX states above —
    // it is a musical mode, and it is here because the CLAUSES are what it
    // needs, not because it belongs to that count. It arrived late (the MAJ /
    // MIN names lived only in the card's markup) and the discriminator that
    // earned it a roster is stated on CHORD_QUALITY_OPTIONS: a 2-state param
    // whose states are MODES needs names, while `unison` and `chord_mode` are
    // genuine on/off enables and correctly have none.
    ['chord_quality', CHORD_QUALITY_OPTIONS],
  ];

  it.each(rows)('%s declares its roster', (id, roster) => {
    const p = param(id);
    expect(p.options, `${id} has no options — it would render as an anonymous knob`).toBeTruthy();
    expect(p.options!.map((o) => o.label)).toEqual(roster.map((o) => o.label));
  });

  it.each(rows)('%s roster covers EXACTLY its declared range', (id) => {
    // A roster that stops short leaves a reachable state with no name, and the
    // Segmented row silently cannot select it.
    const p = param(id);
    const values = p.options!.map((o) => o.value);
    expect(values).toEqual([...values].sort((a, b) => a - b));
    expect(Math.min(...values), `${id} min`).toBe(p.min);
    expect(Math.max(...values), `${id} max`).toBe(p.max);
    expect(values.length, `${id} covers every integer step`).toBe(p.max - p.min + 1);
    expect(values, `${id} default resolves to a named state`).toContain(p.defaultValue);
  });

  it('every option carries a hover TITLE saying what the state does', () => {
    // The label is a caption in a 3-button row; the title is where a state
    // gets to explain itself. A roster of bare labels is a rename of `0.00`.
    //
    // ⚠ DERIVED FROM `rows`, not from a second hand-written list of rosters.
    // The previous form re-listed the three rosters here, so a roster added to
    // `rows` was range-checked and prose-checked but silently exempt from the
    // title check — a gate blind to exactly the new arrival it should be
    // hardest on. Reading `rows` makes enrolment mean all four clauses.
    const untitled = rows
      .flatMap(([id, roster]) => roster.map((o) => ({ id, ...o })))
      .filter((o) => !(o as { title?: string }).title?.trim())
      .map((o) => `${o.id}: ${o.label}`);
    expect(untitled).toEqual([]);
  });
});

describe('wavesculpt mode rosters — the roster and the DOC prose cannot drift', () => {
  // wavesculpt is in STRICT_DOCS, so `docs.controls` is gated text, not a
  // comment. Each state name must appear VERBATIM in the prose for its param.

  it.each(NINE_STATES.fxType)('fxType prose names %s', (label) => {
    for (const i of [1, 2, 3, 4]) {
      expect(controls[`fxType${i}`] ?? '', `fxType${i} docs`).toContain(label);
    }
  });

  it.each(NINE_STATES.video_mode)('video_mode prose names %s', (label) => {
    expect(controls.video_mode ?? '').toContain(label);
  });

  it.each(NINE_STATES.blink_mode)('blink_mode prose names %s', (label) => {
    expect(controls.blink_mode ?? '').toContain(label);
  });

  it.each(CHORD_QUALITY_OPTIONS.map((o) => o.label))('chord_quality prose names %s', (label) => {
    expect(controls.chord_quality ?? '').toContain(label);
  });

  it('NEGATIVE CONTROL: the prose check can FAIL', () => {
    // Every clause above is a `toContain` over strings that already agree, so
    // a green run proves nothing until the instrument is shown to move.
    expect(controls.blink_mode ?? '').not.toContain('SPECTROGRAPH');
    expect(controls.video_mode ?? '').not.toContain('REALITY BASED COMMUNITY');
    expect(controls.video_mode ?? '', 'the prose is not empty').not.toBe('');
  });
});

describe('wavesculpt mode rosters — NO surface keeps a private copy', () => {
  // ⚠ THIS READ THE CARD, and what it asserted was that `WavesculptCard.svelte`
  // IMPORTED the def's rosters rather than carrying its own three-entry array —
  // the exact shape that was there being
  // `const BLINK_MODE_NAMES = ['', 'SCOPES TRIAL', 'REALITY BASED COMMUNITY']`,
  // i.e. the FilterCard `const MODES` divergence.
  //
  // The card was the only IMPORTER: the surviving renderer is the shell's
  // segmented cell, which derives its captions from the ParamDef's `options`
  // generically, so no surface names the rosters at all. The positive half
  // ("the surface imports them") therefore has no subject; the NEGATIVE half is
  // the one that mattered and it is kept, widened from one file to every
  // module-owned surface.
  it('no module surface declares its own mode-name array', () => {
    const dir = fileURLToPath(new URL('../../ui/modules/', import.meta.url));
    const PRIVATE_ARRAY = /const\s+([A-Z_]*MODE[A-Z_]*NAMES)\s*=/g;
    const offenders: string[] = [];
    let scanned = 0;
    const visit = (rel: string, abs: string): void => {
      scanned++;
      for (const m of readFileSync(abs, 'utf8').matchAll(PRIVATE_ARRAY)) {
        offenders.push(`${rel}: ${m[1]}`);
      }
    };
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        for (const inner of readdirSync(join(dir, entry.name))) {
          if (inner.endsWith('.svelte')) visit(`${entry.name}/${inner}`, join(dir, entry.name, inner));
        }
        continue;
      }
      if (entry.name.endsWith('.svelte')) visit(entry.name, join(dir, entry.name));
    }
    expect(scanned, 'the surface walk resolved no .svelte files').toBeGreaterThan(0);
    expect(offenders, 'a private mode-name array is the divergence these rosters remove')
      .toEqual([]);
  });

  it('and the def really carries the rosters, so this is one home rather than none', () => {
    for (const roster of [BLINK_MODE_OPTIONS, VIDEO_MODE_OPTIONS, FX_TYPE_OPTIONS]) {
      expect(roster.length, 'a roster must not be empty').toBeGreaterThan(0);
      for (const o of roster) expect(typeof o.label, 'every option is named').toBe('string');
    }
  });
});
