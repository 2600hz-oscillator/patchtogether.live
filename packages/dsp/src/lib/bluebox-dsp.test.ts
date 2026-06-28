// packages/dsp/src/lib/bluebox-dsp.test.ts
//
// Pure unit tests for the BLUEBOX tone-table core (Bell System DTMF grid +
// the 2600 Hz blue-box / 1700+2200 Hz red-box phreak tones). Extracted but
// untested — and a single transposed frequency would route "the wrong digit"
// with no audible-at-a-glance tell, so the table is pinned EXACTLY against the
// ITU-T Q.23 / Bell spec, plus a structural row/col-membership check.

import { describe, it, expect } from 'vitest';
import {
  DTMF_TABLE,
  BLUEBOX_TONES,
  REDBOX_TONES,
  BLUEBOX_BUTTON_NAMES,
  buttonParamId,
  buttonGateId,
  tonesForButton,
  dtmfFreqs,
  type BlueboxButtonName,
} from './bluebox-dsp';

const ROWS = [697, 770, 852, 941];
const COLS = [1209, 1336, 1477];

describe('DTMF_TABLE (Bell System grid)', () => {
  it('pins every digit to its exact [row, col] pair', () => {
    expect(DTMF_TABLE[1]).toEqual([697, 1209]);
    expect(DTMF_TABLE[2]).toEqual([697, 1336]);
    expect(DTMF_TABLE[3]).toEqual([697, 1477]);
    expect(DTMF_TABLE[4]).toEqual([770, 1209]);
    expect(DTMF_TABLE[5]).toEqual([770, 1336]);
    expect(DTMF_TABLE[6]).toEqual([770, 1477]);
    expect(DTMF_TABLE[7]).toEqual([852, 1209]);
    expect(DTMF_TABLE[8]).toEqual([852, 1336]);
    expect(DTMF_TABLE[9]).toEqual([852, 1477]);
    expect(DTMF_TABLE[0]).toEqual([941, 1336]); // bottom-row, centre column
  });
  it('every digit uses a valid row freq + a valid col freq (no transposition)', () => {
    for (let d = 0; d <= 9; d++) {
      const [row, col] = DTMF_TABLE[d]!;
      expect(ROWS).toContain(row);
      expect(COLS).toContain(col);
    }
  });
  it('is frozen (worklet relies on identity/immutability)', () => {
    expect(Object.isFrozen(DTMF_TABLE)).toBe(true);
  });
});

describe('phreak tones', () => {
  it('BLUEBOX is the single 2600 Hz supervisory tone', () => {
    expect(BLUEBOX_TONES).toEqual([2600]);
    expect(Object.isFrozen(BLUEBOX_TONES)).toBe(true);
  });
  it('REDBOX is the 1700+2200 Hz coin-ack pair', () => {
    expect(REDBOX_TONES).toEqual([1700, 2200]);
    expect(Object.isFrozen(REDBOX_TONES)).toBe(true);
  });
});

describe('button names + id helpers', () => {
  it('lists all 12 buttons in card order', () => {
    expect(BLUEBOX_BUTTON_NAMES).toEqual([
      '1', '2', '3', '4', '5', '6', '7', '8', '9', '0', 'bluebox', 'redbox',
    ]);
  });
  it('derives param/gate ids by prefix', () => {
    expect(buttonParamId('5')).toBe('btn_5');
    expect(buttonParamId('bluebox')).toBe('btn_bluebox');
    expect(buttonGateId('0')).toBe('gate_0');
    expect(buttonGateId('redbox')).toBe('gate_redbox');
  });
});

describe('tonesForButton dispatch', () => {
  it('routes digits to their DTMF pair', () => {
    expect(tonesForButton('0')).toEqual([941, 1336]);
    expect(tonesForButton('7')).toEqual([852, 1209]);
  });
  it('routes the phreaker buttons to their tone lists', () => {
    expect(tonesForButton('bluebox')).toEqual([2600]);
    expect(tonesForButton('redbox')).toEqual([1700, 2200]);
  });
  it('agrees with dtmfFreqs for every digit', () => {
    for (let d = 0; d <= 9; d++) {
      expect(tonesForButton(String(d) as BlueboxButtonName)).toEqual(dtmfFreqs(d));
    }
  });
});

describe('dtmfFreqs', () => {
  it('returns the [row, col] tuple', () => {
    expect(dtmfFreqs(5)).toEqual([770, 1336]);
    expect(dtmfFreqs(0)).toEqual([941, 1336]);
  });
  it('throws on an out-of-range digit', () => {
    expect(() => dtmfFreqs(11)).toThrow();
    expect(() => dtmfFreqs(-1)).toThrow();
  });
});
