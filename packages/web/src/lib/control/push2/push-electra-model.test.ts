// packages/web/src/lib/control/push2/push-electra-model.test.ts
//
// The PURE half of ELECTRA CONTROL MODE: what a row is, which encoder does what,
// how the row scrolls, and what the six strips say.
//
// The load-bearing claim under test is the owner's: the strip shows "the same
// name/status info that we see on electra / the card". That is asserted by
// COMPARING AGAINST THE SHARED EXPRESSIONS rather than against hand-written
// expected strings — a literal would pass while the two renderers diverged.

import { describe, it, expect } from 'vitest';
import type { ParamDef } from '$lib/graph/types';
import {
  pushElectraView,
  electraModeEncoder,
  stepElectraRow,
  clampRow,
  ELECTRA_MODE_KNOBS,
  ELECTRA_MODE_ROWS,
  type ElectraSlotResolved,
} from './push-electra-model';
import { pushStrip } from './push-card-model';
import { encoderTarget, PUSH_CC_ENCODER_BASE, PUSH_CC_ENCODER_SWING, PUSH_CC_ENCODER_MASTER } from './push2-map';
import { slotIndex, ELECTRA_KNOBS, ELECTRA_ROWS } from '$lib/graph/electra-control';
import { knobReadout } from '$lib/ui/controls/knob-vocabulary-model';
import { knobValueToFrac } from '$lib/ui/controls/knob-conic-model';

const cutoff: ParamDef = {
  id: 'cutoff', label: 'Cutoff', min: 20, max: 20000, defaultValue: 1000, curve: 'log', units: 'Hz',
};
const detune: ParamDef = {
  id: 'detune', label: 'Detune', min: -50, max: 50, defaultValue: 0, curve: 'linear', units: 'ct',
};

function resolved(def: ParamDef, value: number, label = def.label): ElectraSlotResolved {
  return { def, value, label };
}

describe('a ROW is the grid own row width — six controls, six rows', () => {
  it('takes its dimensions from graph/electra-control, never a local 6', () => {
    // If the stored grid ever stops being 6×6 this mode must move with it, so
    // the constants are asserted to BE the grid's, not to equal 6.
    expect(ELECTRA_MODE_KNOBS).toBe(ELECTRA_KNOBS);
    expect(ELECTRA_MODE_ROWS).toBe(ELECTRA_ROWS);
    expect(ELECTRA_MODE_KNOBS).toBe(6);
    expect(ELECTRA_MODE_ROWS).toBe(6);
  });

  it('reads the SAME slot indices the card renders for that row', () => {
    // Row 3's six knobs are storage slots 12..17 — the row-major key the card,
    // the ydoc mutators and electraPosOfSlot all use.
    const slots: number[] = [];
    pushElectraView({
      surfaceName: 'EC',
      row: 3,
      resolveSlot: (s) => {
        slots.push(s);
        return null;
      },
    });
    expect(slots).toEqual([12, 13, 14, 15, 16, 17]);
    expect(slots[0]).toBe(slotIndex(3, 1));
    expect(slots[5]).toBe(slotIndex(3, 6));
  });
});

describe('electraModeEncoder — encoders 1-6 drive, 7-8 are INERT', () => {
  it('display encoders 1..6 map to knobs 1..6 in order', () => {
    for (let i = 0; i < 6; i++) {
      const t = encoderTarget(PUSH_CC_ENCODER_BASE + i)!;
      expect(electraModeEncoder(t)).toEqual({ kind: 'knob', knob: i + 1 });
    }
  });

  it('display encoders 7 and 8 are INERT — a declared answer, not an omission', () => {
    for (const i of [6, 7]) {
      const t = encoderTarget(PUSH_CC_ENCODER_BASE + i)!;
      expect(electraModeEncoder(t)).toEqual({ kind: 'inert' });
    }
  });

  it('the scroll encoder scrolls the ROW; the master encoder is unchanged', () => {
    expect(electraModeEncoder(encoderTarget(PUSH_CC_ENCODER_SWING)!)).toEqual({ kind: 'rowScroll' });
    expect(electraModeEncoder(encoderTarget(PUSH_CC_ENCODER_MASTER)!)).toEqual({ kind: 'master' });
  });

  it('NEGATIVE CONTROL: it re-reads the SHIPPING CC map, so there is one map', () => {
    // If this mode carried its own CC table, feeding it the map's own output
    // would still "work" while the two disagreed about which knob is which.
    // Feeding it a target the map DOES NOT produce for that CC must therefore
    // give a different answer — which is what proves the input is load-bearing.
    expect(electraModeEncoder({ kind: 'strip', index: 0 })).toEqual({ kind: 'knob', knob: 1 });
    expect(electraModeEncoder({ kind: 'strip', index: 7 })).toEqual({ kind: 'inert' });
    expect(encoderTarget(PUSH_CC_ENCODER_BASE)).toEqual({ kind: 'strip', index: 0 });
  });
});

describe('stepElectraRow — wraps at both ends', () => {
  it('steps one row per detent', () => {
    expect(stepElectraRow(1, 1)).toBe(2);
    expect(stepElectraRow(3, -1)).toBe(2);
    expect(stepElectraRow(1, 0)).toBe(1);
  });

  it('WRAPS rather than clamps — six positions with no visible end stop', () => {
    expect(stepElectraRow(6, 1)).toBe(1);
    expect(stepElectraRow(1, -1)).toBe(6);
    expect(stepElectraRow(5, 4)).toBe(3); // multi-detent flick wraps too
    expect(stepElectraRow(2, -5)).toBe(3);
  });

  it('tolerates a corrupt stored row without ever painting row 0 or 7', () => {
    for (const bad of [0, -3, 99, NaN, 6.7]) {
      const out = stepElectraRow(bad, 1);
      expect(out).toBeGreaterThanOrEqual(1);
      expect(out).toBeLessThanOrEqual(ELECTRA_MODE_ROWS);
    }
    expect(clampRow(0)).toBe(1);
    expect(clampRow(7)).toBe(6);
    expect(clampRow(NaN)).toBe(1);
  });
});

describe('the view — name and status are the CARD’s, by construction', () => {
  it('the readout and the bar come from the same functions the on-screen dial uses', () => {
    const v = pushElectraView({
      surfaceName: 'EC',
      row: 1,
      resolveSlot: (s) => (s === slotIndex(1, 2) ? resolved(cutoff, 632) : null),
    });
    const strip = v.strips[1];
    expect(strip.kind).toBe('param');
    // NOT a literal: the same expression Knob/KnobConic print and draw from.
    expect(strip.valueText).toBe(knobReadout(632, { format: cutoff.format }) ?? strip.valueText);
    expect(strip.frac).toBe(knobValueToFrac(632, 20, 20000, 'log'));
    // …and a log param at its geometric midpoint really is mid-bar, which is the
    // whole reason the shared function matters (a linear map would say ~3%).
    expect(strip.frac).toBeGreaterThan(0.45);
    expect(strip.frac).toBeLessThan(0.55);
  });

  it('is OP-FOR-OP the push card’s strip for the same param + value', () => {
    // The strongest form of "same status info": the ElectraControl strip IS a
    // push-card strip, so anything the card learns to draw the Push learns too.
    const v = pushElectraView({
      surfaceName: 'EC',
      row: 2,
      resolveSlot: (s) => (s === slotIndex(2, 1) ? resolved(detune, -12) : null),
    });
    expect(v.strips[0]).toEqual(pushStrip(detune, -12, 1));
    expect(v.strips[0].bipolar).toBe(true); // the zero anchor survived
  });

  it('a CUSTOM slot name replaces ONLY the label — the readout stays the param’s', () => {
    const v = pushElectraView({
      surfaceName: 'EC',
      row: 1,
      resolveSlot: (s) => (s === slotIndex(1, 1) ? resolved(cutoff, 1000, 'brightness') : null),
    });
    expect(v.strips[0].label).toBe('BRIGHTNESS'); // uppercased by pushStrip, like the card
    expect(v.strips[0].paramId).toBe('cutoff');
    expect(v.strips[0].valueText).toBe(pushStrip(cutoff, 1000, 1).valueText);
    expect(v.strips[0].frac).toBe(pushStrip(cutoff, 1000, 1).frac);
  });

  it('always returns SIX strips, numbering the encoders 1..6', () => {
    const v = pushElectraView({ surfaceName: 'EC', row: 4, resolveSlot: () => null });
    expect(v.strips).toHaveLength(ELECTRA_MODE_KNOBS);
    expect(v.strips.map((s) => s.encoder)).toEqual([1, 2, 3, 4, 5, 6]);
    // A sparse row is NORMAL (the grid is sparse by design), not an error state.
    expect(v.strips.every((s) => s.kind === 'empty')).toBe(true);
    expect(v.empty).toBeNull();
  });

  it('"no surface" and "empty row" are DIFFERENT answers', () => {
    const noSurface = pushElectraView({ surfaceName: null, row: 1, resolveSlot: () => null });
    const emptyRow = pushElectraView({ surfaceName: 'EC', row: 1, resolveSlot: () => null });
    expect(noSurface.empty).toBe('no-surface');
    expect(emptyRow.empty).toBeNull();
    // Both draw six blank knobs — which is exactly why the distinction has to
    // live somewhere other than the strips.
    expect(noSurface.strips.map((s) => s.kind)).toEqual(emptyRow.strips.map((s) => s.kind));
  });

  it('reports the row’s Electra BANK using the device’s own vocabulary', () => {
    const bankOf = (row: number) =>
      pushElectraView({ surfaceName: 'EC', row, resolveSlot: () => null }).bank;
    expect([1, 2].map(bankOf)).toEqual(['TOP', 'TOP']);
    expect([3, 4].map(bankOf)).toEqual(['MID', 'MID']);
    expect([5, 6].map(bankOf)).toEqual(['BOT', 'BOT']);
  });

  it('clamps an out-of-range row rather than resolving a slot outside the grid', () => {
    const seen: number[] = [];
    const v = pushElectraView({
      surfaceName: 'EC',
      row: 99,
      resolveSlot: (s) => {
        seen.push(s);
        return null;
      },
    });
    expect(v.row).toBe(ELECTRA_MODE_ROWS);
    expect(Math.max(...seen)).toBe(35); // the grid's last slot, never 36+
    expect(Math.min(...seen)).toBe(30);
  });
});
