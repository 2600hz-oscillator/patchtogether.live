// packages/web/src/lib/ui/modules/clipplayer-keyboard.test.ts
//
// Pure unit coverage for the computer-keyboard → control-strip mapping (Part B).
// The DOM-stateful hold/capture/stuck-shift behaviour is exercised in e2e
// (clipplayer-card-parity.spec.ts); here we pin the pure decisions: the digit↔
// action map (identical order to the launchpad CC 91..98 top row) and the
// text-input / modifier coexistence guard.

import { describe, it, expect } from 'vitest';
import {
  STRIP_ACTIONS,
  keyToStripIndex,
  keyToStripAction,
  isHoldAction,
  isEditableTarget,
  shouldIgnoreDigit,
  type StripAction,
} from './clipplayer-keyboard';

describe('clipplayer-keyboard: digit → strip mapping', () => {
  it('maps 1..8 to the eight strip actions in CC 91..98 order', () => {
    const expected: StripAction[] = [
      'transport', 'grid', 'clip', 'arranger', 'control', 'undo', 'redo', 'shift',
    ];
    for (let d = 1; d <= 8; d++) {
      expect(keyToStripAction(String(d))).toBe(expected[d - 1]);
      expect(keyToStripIndex(String(d))).toBe(d);
    }
    // STRIP_ACTIONS is the same ordered list.
    expect([...STRIP_ACTIONS]).toEqual(expected);
  });

  it('returns null for 0, 9, letters, multi-char, and empty', () => {
    for (const k of ['0', '9', 'a', 'A', ' ', '', '10', 'Enter', 'Shift', '!']) {
      expect(keyToStripIndex(k)).toBeNull();
      expect(keyToStripAction(k)).toBeNull();
    }
  });

  it('only the shift button (8) is a HOLD action', () => {
    expect(isHoldAction('shift')).toBe(true);
    for (const a of STRIP_ACTIONS) {
      if (a !== 'shift') expect(isHoldAction(a)).toBe(false);
    }
    // digit 8 is the hold; 1..7 are one-shot.
    expect(isHoldAction(keyToStripAction('8')!)).toBe(true);
    expect(isHoldAction(keyToStripAction('1')!)).toBe(false);
  });
});

describe('clipplayer-keyboard: coexistence guard', () => {
  const bare = { metaKey: false, ctrlKey: false, altKey: false, isComposing: false, target: null };

  it('ignores the digit when an OS/app modifier is down (cmd/ctrl/alt), but NOT for shift', () => {
    expect(shouldIgnoreDigit({ ...bare, metaKey: true }, null)).toBe(true);
    expect(shouldIgnoreDigit({ ...bare, ctrlKey: true }, null)).toBe(true);
    expect(shouldIgnoreDigit({ ...bare, altKey: true }, null)).toBe(true);
    // Shift is not part of DigitGuardEvent — a shifted digit is still handled.
    expect(shouldIgnoreDigit(bare, null)).toBe(false);
  });

  it('ignores the digit mid-IME-composition (isComposing)', () => {
    expect(shouldIgnoreDigit({ ...bare, isComposing: true }, null)).toBe(true);
  });

  // Duck-typed element stubs matching the SHARED blood-keys isEditableTarget
  // (tagName / ARIA role / contentEditable — NOT a .closest selector).
  const inputEl = { tagName: 'INPUT' };
  const searchboxEl = { tagName: 'DIV', getAttribute: (n: string) => (n === 'role' ? 'searchbox' : null) };
  const plainEl = { tagName: 'DIV', getAttribute: () => null };

  it('ignores the digit when the event TARGET is editable', () => {
    expect(shouldIgnoreDigit({ ...bare, target: inputEl as unknown as EventTarget }, null)).toBe(true);
  });

  it('ignores the digit when document.activeElement is editable (target elsewhere)', () => {
    expect(shouldIgnoreDigit({ ...bare, target: plainEl as unknown as EventTarget }, inputEl as unknown as EventTarget)).toBe(true);
  });

  it('ignores the digit for an ARIA searchbox (the +Add module search — missed by the old narrower guard)', () => {
    expect(shouldIgnoreDigit({ ...bare, target: searchboxEl as unknown as EventTarget }, null)).toBe(true);
  });

  it('does NOT ignore when neither target nor activeElement is editable', () => {
    expect(shouldIgnoreDigit({ ...bare, target: plainEl as unknown as EventTarget }, plainEl as unknown as EventTarget)).toBe(false);
  });

  it('isEditableTarget: null-safe + recognises inputs and ARIA roles', () => {
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget({} as unknown as EventTarget)).toBe(false); // no tagName/role
    expect(isEditableTarget(inputEl as unknown as EventTarget)).toBe(true);
    expect(isEditableTarget(searchboxEl as unknown as EventTarget)).toBe(true);
    expect(isEditableTarget(plainEl as unknown as EventTarget)).toBe(false);
  });
});
