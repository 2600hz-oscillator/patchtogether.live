// The pure half of the #1509 typed-entry cell. Three properties, and the middle
// one is the whole reason the contract is shaped this way.

import { describe, it, expect } from 'vitest';
import {
  entryAccept,
  entryCommitDecision,
  entryDisplayText,
  entryReject,
  entryTextIsValid,
  type EntryParse,
} from './text-entry-model';

/** A validator with a NULLABLE accepted value — the cartesian shape: an empty
 *  box is a REST (accepted, stored as null), anything not in c0..c2 is refused. */
function parsePitch(text: string): EntryParse<number | null> {
  const t = text.trim();
  if (t === '') return entryAccept<number | null>(null);
  const m = /^([a-g])(\d)$/.exec(t.toLowerCase());
  if (!m) return entryReject<number | null>();
  const oct = Number(m[2]);
  if (oct > 2) return entryReject<number | null>();
  return entryAccept<number | null>(oct * 12 + 'cdefgab'.indexOf(m[1]!));
}

describe('text-entry model — what the field SHOWS', () => {
  it('shows the stored text at rest and the live buffer while editing', () => {
    expect(entryDisplayText('c#3', { editing: false, buffer: 'zz' })).toBe('c#3');
    expect(entryDisplayText('c#3', { editing: true, buffer: 'zz' })).toBe('zz');
  });

  it('validity is a property of the VISIBLE text, and commits nothing', () => {
    expect(entryTextIsValid('c1', parsePitch)).toBe(true);
    expect(entryTextIsValid('c9', parsePitch)).toBe(false);
    expect(entryTextIsValid('', parsePitch), 'an empty box is a REST, which is VALID').toBe(true);
  });
});

describe('text-entry model — a REJECTION can never produce a write', () => {
  // ⚠ THE LOAD-BEARING PROPERTY. The backdraft class is a control that writes
  // values the contract forbids while the model quietly clamps them, with every
  // def-reading gate blind. It is unrepresentable here only if the rejecting
  // code path contains no write at all — so that is asserted directly, rather
  // than asserted about one caller.
  it('an accepted string yields a WRITE carrying the parsed value', () => {
    expect(entryCommitDecision('c1', parsePitch)).toEqual({ kind: 'write', value: 12 });
  });

  it('a refused string yields a REVERT — never a clamped, rounded or nearest value', () => {
    expect(entryCommitDecision('c9', parsePitch)).toEqual({ kind: 'revert' });
    expect(entryCommitDecision('nonsense', parsePitch)).toEqual({ kind: 'revert' });
  });

  it('EXHAUSTIVE: no input to a refusing validator can produce a write', () => {
    // Drive the decision over a validator that refuses EVERYTHING. If any input
    // could still yield a write, the "no silent clamp" claim is false — and this
    // is stronger than listing bad strings, because it quantifies over them.
    const refuseAll = (): EntryParse<number> => entryReject<number>();
    const inputs = ['', ' ', '0', 'c1', 'c9', '-1', 'NaN', 'Infinity', '\u0000', 'x'.repeat(500)];
    const kinds = new Set(inputs.map((t) => entryCommitDecision(t, refuseAll).kind));
    expect([...kinds], 'a validator that refuses everything must produce only reverts').toEqual([
      'revert',
    ]);
  });
});

describe('text-entry model — the reject sentinel is a TAGGED UNION, and it must stay one', () => {
  // ⚠ THIS IS THE FINDING THE SPIKE PRODUCED, PINNED SO IT CANNOT REGRESS.
  //
  // The obvious signature for a validator is `(text) => T | null`, with `null`
  // meaning "reject". Under it, "this pad has no note" and "that text is not a
  // note" are THE SAME RETURN VALUE. The safe reading (`null` ⇒ reject) would
  // make a REST unreachable from the faceplate while the legacy card still
  // offered it — a silent functional-parity loss inside the very cell built to
  // prevent silent parity losses.
  it('a NULL accepted value is a WRITE, not a rejection', () => {
    const d = entryCommitDecision('', parsePitch);
    expect(d, 'clearing the box commits a REST').toEqual({ kind: 'write', value: null });
  });

  it('and a rejection is distinguishable from it', () => {
    expect(entryCommitDecision('c9', parsePitch).kind).toBe('revert');
    expect(entryCommitDecision('', parsePitch).kind).toBe('write');
  });

  it('NEGATIVE CONTROL: the null-sentinel signature really would conflate them', () => {
    // The counterfactual, executed rather than described — so the argument above
    // is checkable instead of merely asserted.
    const sentinel = (text: string): number | null => {
      const r = parsePitch(text);
      return r.ok ? r.value : null;
    };
    expect(sentinel(''), 'a REST under the sentinel signature').toBe(null);
    expect(sentinel('c9'), 'a REFUSAL under the sentinel signature').toBe(null);
    // Same value, opposite meanings — which is exactly what the tagged union
    // separates and what a `null` sentinel cannot.
    expect(sentinel('')).toBe(sentinel('c9'));
  });
});
