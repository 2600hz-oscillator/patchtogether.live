// packages/web/src/lib/ui/controls/text-entry-model.ts
//
// PURE edit/commit/revert logic for TextEntry.svelte — the faceplate's ONE
// typed-entry primitive.
//
// ── WHY THE REJECT SENTINEL IS A TAGGED UNION, NOT `null` ───────────────────
//
// The obvious signature for a validator is `(text: string) => T | null`, with
// `null` meaning "reject". It is WRONG HERE, and cartesian is the case that
// proves it rather than a hypothetical: clearing a pad's pitch box is a REST —
// a legitimate committed value whose stored form IS `null`. Under the sentinel
// signature "this pad has no note" and "that text is not a note" are the same
// return value, so the field could never distinguish a rest from a typo, and
// the safest reading (`null` ⇒ reject) would make the rest UNREACHABLE from the
// faceplate while the legacy card still offered it — a silent functional-parity
// loss of exactly the kind promotion is supposed to preserve.
//
// So a parse result is `{ ok: true, value }` or `{ ok: false }`, and `value`
// may be anything the module stores, `null` included.
//
// ── WHY A REJECT CAN NEVER PRODUCE A WRITE ─────────────────────────────────
//
// `entryCommitDecision` is the ONLY function that turns typed text into a
// commit, and it returns `revert` on every rejection. The cell's `onCommit`
// receives a value that was already accepted, so the module never sees raw
// text and there is nowhere for a silent clamp to live. That is this file's
// reason for existing: the backdraft class (a control writing values the
// contract forbids while the model quietly clamped them, with every def-reading
// gate blind) is unrepresentable if the rejecting code path has no write in it.

/** The result of validating typed text. See the header: `{ ok: false }` rather
 *  than `null`, so a module whose stored form is nullable (a REST) can still
 *  say "accepted, and the value is null". */
export type EntryParse<T> = { ok: true; value: T } | { ok: false };

/** Convenience constructors, so a call site reads as a sentence. */
export function entryAccept<T>(value: T): EntryParse<T> {
  return { ok: true, value };
}
export function entryReject<T>(): EntryParse<T> {
  return { ok: false };
}

/** The field's live edit state. `editing` flips on focus so prop reactivity
 *  cannot fight the user's keystrokes mid-word. */
export interface EntryEditState {
  editing: boolean;
  buffer: string;
}

/**
 * What the field SHOWS: the live buffer while editing, otherwise the stored
 * text the module round-trips back. Pure.
 */
export function entryDisplayText(stored: string, st: EntryEditState): string {
  return st.editing ? st.buffer : stored;
}

/**
 * Is the currently VISIBLE text acceptable? Drives the valid/invalid ring only
 * — it commits nothing. Pure.
 */
export function entryTextIsValid<T>(text: string, parse: (t: string) => EntryParse<T>): boolean {
  return parse(text).ok;
}

/** What a commit gesture (Enter, or blur) resolves to. */
export type EntryCommit<T> = { kind: 'write'; value: T } | { kind: 'revert' };

/**
 * The decision a commit gesture produces.
 *
 * ⚠ BLUR-WITH-INVALID REVERTS AND WRITES NOTHING, and that is a DELIBERATE
 * DIVERGENCE from the shipped `NoteEntry.svelte`, which commits on blur and
 * relies on its module's own action to no-op. That works for cartesian's
 * `commitPitch` (it stores `parseNoteName`'s null as a rest) and is the wrong
 * default for a shared primitive: a module whose stored form is NOT nullable
 * would take a blur on a typo as an instruction to write something, and the
 * only safe thing to write is a guess. Reverting is the answer that needs no
 * guess — the stored value is untouched and the typo is discarded, which is
 * what a user who clicked away from a half-typed word meant. Pure.
 */
export function entryCommitDecision<T>(
  buffer: string,
  parse: (t: string) => EntryParse<T>,
): EntryCommit<T> {
  const r = parse(buffer);
  return r.ok ? { kind: 'write', value: r.value } : { kind: 'revert' };
}
