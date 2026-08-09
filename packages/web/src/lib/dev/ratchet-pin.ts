// packages/web/src/lib/dev/ratchet-pin.ts
//
// A RATCHET WHOSE PINNED VALUE IS A BARE INTEGER MERGES WRONG, SILENTLY.
//
// ── The failure, measured on one night's parallel face wave (2026-08-08/09) ──
// Three agents, three different files, the same shape, three times:
//
//   * `RANGE_BOUND_FLOOR` — main went 7 → 8 adding meowbox; the filter branch
//     went 7 → 8 adding filter. Git saw the SAME literal written from both
//     sides, so there was no conflict at all. The merged truth was 9.
//   * `UNDECLARED_EDGE_CEILING` — base 289; one branch −12 (bluebox), another
//     −1 (meowbox). Neither side's number described the merge (276).
//   * A third branch hit BOTH, and git only conflicted on one of them because
//     the two authors happened to write different COMMENTS above the number.
//
// This is not carelessness, it is arithmetic. Git's 3-way merge compares TEXT.
// Two branches that each add one entry to a list touch DIFFERENT lines (the
// list is keyed and sorted), so the lists union cleanly — while the count line
// receives the IDENTICAL edit from both sides, which git resolves in silence.
// The result is a ratchet with one card of slack in it, and the next real
// regression is absorbed rather than reported. Nothing goes red; that is the
// whole problem.
//
// ── The fix: pin the SET, not just its SIZE ─────────────────────────────────
// A ratchet pin is `<count>@<digest>` — one token, on one line, carrying both
// the number a human reads and a digest of the exact set it counts:
//
//     export const UNDECLARED_EDGE_PIN = '276@1f0c9a3b';
//
// Two branches draining DIFFERENT entries now write DIFFERENT text at the SAME
// line from a common base, which is the textbook 3-way conflict. Git stops.
// That is the entire mechanism: it converts an invisible arithmetic error into
// a merge conflict, which is a thing humans already know how to resolve.
//
// ── What it does NOT do: it does not delete the ratchet ─────────────────────
// A fully-computed value that always equals reality asserts nothing. So the
// pin is still a COMMITTED constant that a human must edit deliberately, and
// `checkRatchetPin` still reports BOTH directions:
//
//     actual <= pinned   — the debt GREW (the ratchet's original job)
//     pinned - actual === 0 — a drain that forgot to lower the number
//
// The count half of the pin is exactly the old literal and is asserted exactly
// as before. The digest half is the part git can see.
//
// ⚠ WHAT THIS CANNOT SEE, stated in the gate (per the blind-gates rule):
//  · A ratchet whose subject is DERIVED FROM SOURCE rather than from a list in
//    the same file (e.g. "controls with no paramId", counted over ~190 cards)
//    still merges silently when the two branches touch different CARDS and
//    neither touches the pin. The pin makes that case RED after the merge
//    instead of slack — which is the correct outcome, but it is not a
//    conflict, so nobody is warned before the fact.
//  · A digest collision would hide a conflict. FNV-1a/32 over the sorted set
//    makes that ~1 in 4.3e9 per merge pair; the failure mode is "no worse than
//    a bare count", never "wrong number accepted".
//  · It says nothing about whether an ENTRY is legitimate. Anchoring the list
//    to the artifact (a stale entry is red) is a separate clause and every
//    caller here already has one.

/** FNV-1a, 32-bit, returned as 8 lowercase hex chars.
 *
 *  Deliberately NOT `node:crypto`: these pins are read by browser-env unit
 *  tests as well as node ones, and a digest whose only job is "different sets
 *  produce different text" does not need a cryptographic primitive. It DOES
 *  need to be reproducible byte-for-byte on every platform, which this is
 *  (pure integer arithmetic, no locale, no Intl, no encoding step beyond
 *  UTF-16 code units — the inputs are ASCII module/param/file ids). */
export function fnv1a32(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    // h *= 16777619, in 32-bit, without losing precision to float64.
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** The canonical text a pin digests: the set, deduplicated, sorted, one per
 *  line. Sorted so a pure reordering is not a churn; deduplicated so a list
 *  that accidentally names something twice cannot inflate its own count past
 *  the set it claims to describe. */
export function canonicalizeRatchetItems(items: Iterable<string>): string[] {
  return [...new Set(items)].sort();
}

/** Compute the pin for a set: `<count>@<digest>`. */
export function ratchetPin(items: Iterable<string>): string {
  const canon = canonicalizeRatchetItems(items);
  return `${canon.length}@${fnv1a32(canon.join('\n'))}`;
}

/** The count a pin claims, or NaN when the token is malformed. */
export function ratchetPinCount(pin: string): number {
  const m = /^(\d+)@[0-9a-f]{8}$/.exec(pin);
  return m ? Number(m[1]) : Number.NaN;
}

export interface RatchetPinVerdict {
  ok: boolean;
  /** The pin the current set actually produces — paste this to accept. */
  expected: string;
  /** The pin as committed. */
  pinned: string;
  /** Empty when ok; otherwise the full, actionable failure text. */
  message: string;
}

/**
 * Check a committed pin against the live set, reporting BOTH ratchet
 * directions plus set identity.
 *
 * `direction`:
 *   'shrink' — a debt/exemption ledger: the count may only go DOWN.
 *   'grow'   — a conversion set (cards brought up to a bar): only UP.
 *
 * The direction clause is what the old bare literal asserted and is kept
 * verbatim; the digest clause is the new part. A caller should assert
 * `verdict.ok` with `verdict.message` as the assertion message — the message
 * names the exact token to paste, so the accept loop is one copy.
 */
export function checkRatchetPin(args: {
  /** The constant's name, for the failure text. */
  name: string;
  /** The committed pin token. */
  pinned: string;
  /** The live set the pin describes. */
  items: Iterable<string>;
  direction: 'shrink' | 'grow';
  /** Extra context printed on failure (a per-mechanism breakdown, a count of
   *  what was scanned) — a bare number is what let the last one hide. */
  detail?: string;
}): RatchetPinVerdict {
  const { name, pinned, direction } = args;
  const canon = canonicalizeRatchetItems(args.items);
  const expected = ratchetPin(canon);
  const actual = canon.length;
  const claimed = ratchetPinCount(pinned);
  const detail = args.detail ? `\n  ${args.detail}` : '';

  if (Number.isNaN(claimed)) {
    return {
      ok: false,
      expected,
      pinned,
      message:
        `${name} is not a ratchet pin. Expected \`<count>@<8 hex>\`, got "${pinned}".\n` +
        `  The live set produces: '${expected}'${detail}`,
    };
  }

  // ── Direction: the clause the bare literal used to carry, unchanged. ──
  if (direction === 'shrink' && actual > claimed) {
    return {
      ok: false,
      expected,
      pinned,
      message:
        `${name}: the debt GREW — ${actual} entries against a pinned ${claimed}. ` +
        `This ratchet only shrinks; a new entry needs a REASON, not a bigger number.\n` +
        `  If the growth is genuinely intended, pin: '${expected}'${detail}`,
    };
  }
  if (direction === 'grow' && actual < claimed) {
    return {
      ok: false,
      expected,
      pinned,
      message:
        `${name}: the converted set SHRANK — ${actual} entries against a pinned ${claimed}. ` +
        `This ratchet only grows; a card that fell out of the set is a regression.\n` +
        `  Live set now pins as: '${expected}'${detail}`,
    };
  }

  // ── The other direction: slack is a silent hole, so it is also red. ──
  if (actual !== claimed) {
    return {
      ok: false,
      expected,
      pinned,
      message:
        `${name} is ${claimed} but the live set has ${actual} — move it in the SAME commit. ` +
        `A ceiling with slack in it absorbs the next regression in total silence.\n` +
        `  Pin: '${expected}'${detail}`,
    };
  }

  // ── Set identity: the half a bare integer cannot express. ──
  if (expected !== pinned) {
    return {
      ok: false,
      expected,
      pinned,
      message:
        `${name} counts ${actual} and so does the live set, but they are DIFFERENT SETS ` +
        `(pinned digest ${pinned.split('@')[1]}, live ${expected.split('@')[1]}).\n` +
        `  This is the shape a same-count merge produces: two branches swapped one entry ` +
        `for another, or each drained one and added one. Re-read the list before accepting.\n` +
        `  Pin: '${expected}'${detail}`,
    };
  }

  return { ok: true, expected, pinned, message: '' };
}
