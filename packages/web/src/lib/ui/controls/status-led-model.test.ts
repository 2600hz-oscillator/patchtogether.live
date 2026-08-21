// packages/web/src/lib/ui/controls/status-led-model.test.ts
//
// The STATUS LED's pure model. Small surface, but the two properties it has to
// hold are the whole reason the primitive exists:
//
//   1. the CAPTION is invariant to the state — it is a name, not a reading;
//   2. the DETAIL always survives into the accessible name, so nothing was lost
//      by keeping it out of a text node.

import { describe, expect, it } from 'vitest';
import { statusLedLabel, statusLedTitle } from './status-led-model';

describe('statusLedLabel — the accessible name', () => {
  it('announces the caption BEFORE the state', () => {
    // A screen-reader user needs to know what the lamp is before how it is
    // doing. "on LATE" is a different sentence from "LATE on".
    expect(statusLedLabel({ caption: 'LATE', lit: true })).toBe('LATE on');
    expect(statusLedLabel({ caption: 'LATE', lit: false })).toBe('LATE off');
  });

  it('carries the DETAIL when there is one', () => {
    expect(statusLedLabel({ caption: 'LATE', lit: true, detail: '3 pulses dropped' })).toBe(
      'LATE on — 3 pulses dropped',
    );
  });

  it('⚠ THE CAPTION IS INVARIANT TO `lit` — it is a NAME, not a reading', () => {
    // This is the property that makes the primitive refuse the deleted shape.
    // A component whose caption changed with its state would be painting state
    // as TEXT under a different spelling, which is exactly what three deleted
    // mechanisms did. Asserted on the model because the model is where a
    // "helpful" `lit ? 'LATE' : 'OK'` would be written.
    const on = statusLedLabel({ caption: 'ROUTED', lit: true, detail: 'jacks 1-3' });
    const off = statusLedLabel({ caption: 'ROUTED', lit: false, detail: 'no ES-9' });
    expect(on.startsWith('ROUTED ')).toBe(true);
    expect(off.startsWith('ROUTED ')).toBe(true);
  });

  it('treats a blank detail as absent — no trailing em dash', () => {
    expect(statusLedLabel({ caption: 'X', lit: false, detail: '   ' })).toBe('X off');
    expect(statusLedLabel({ caption: 'X', lit: false, detail: '' })).toBe('X off');
  });
});

describe('statusLedTitle — the hover', () => {
  it('is the detail alone — the state is already visible as a lamp', () => {
    expect(statusLedTitle({ caption: 'LATE', lit: true, detail: '3 dropped' })).toBe('3 dropped');
  });

  it('is UNDEFINED with no detail, so no empty tooltip is emitted', () => {
    // `title=""` is a hover target that rewards the hover with nothing.
    expect(statusLedTitle({ caption: 'LATE', lit: false })).toBeUndefined();
    expect(statusLedTitle({ caption: 'LATE', lit: false, detail: '  ' })).toBeUndefined();
  });

  it('NEGATIVE CONTROL: the title never contains the state word', () => {
    // If the title started restating "on"/"off" this would be a second place
    // the state is written down, and the two could disagree.
    const t = statusLedTitle({ caption: 'ROUTED', lit: true, detail: 'jacks 1-3 carry pitch' });
    expect(t).not.toMatch(/\b(on|off)\b/);
    // POSITIVE CONTROL for the same probe: the LABEL does contain it, so the
    // regex above is capable of firing.
    expect(statusLedLabel({ caption: 'ROUTED', lit: true, detail: 'jacks 1-3 carry pitch' })).toMatch(
      /\bon\b/,
    );
  });
});
