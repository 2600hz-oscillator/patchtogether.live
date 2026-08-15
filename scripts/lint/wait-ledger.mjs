/**
 * scripts/lint/wait-ledger.mjs — the shared half of the `waitForTimeout` ratchet
 * (issue #1523).
 *
 * ── what is being denied ────────────────────────────────────────────────────
 *
 * `page.waitForTimeout(n)` is a wall-clock GUESS standing in for the condition
 * the author actually meant. On a renderer-dependent path it is not one
 * assertion, it is a DIFFERENT assertion on every machine: measured in this repo
 * at 7.9 fps under `E2E_SWIFTSHADER=1` against ~60 fps on a real GPU, so the
 * same literal buys ~8× fewer frames on CI than it does locally. CLAUDE.md
 * ("NEVER express a renderer-dependent wait in MILLISECONDS — count FRAMES")
 * names this as the single highest-yield e2e rule, and the flaky-tail work on
 * #1569 root-caused a large share of its failures to exactly this construct.
 *
 * So: DENY BY DEFAULT. A `waitForTimeout` under `e2e/` is a lint ERROR unless
 * the call site itself carries a justification naming the PRODUCT-SIDE interval
 * it mirrors — a debounce window the app defines, a decay tail, a MIDI pacing
 * gap. Those are legitimate; "wait a bit for it to settle" is not, and has a
 * frame count or an auto-retrying assertion as its correct form.
 *
 * ── why the justification lives AT THE CALL SITE ────────────────────────────
 *
 * The repo standard is "deny by default with a NAMED exemption per instance"
 * (CLAUDE.md). The strongest instance name available here is the call site
 * itself: a comment co-located with the call cannot drift from it, cannot be
 * merged into the wrong entry by two branches, and is deleted by the same diff
 * that deletes the call. That is the `docs:`-on-the-def shape, applied to a
 * wait. There is no central permission list to maintain and no re-count tax.
 *
 * ── the LEDGER is not a permission list ────────────────────────────────────
 *
 * #1523 is a multi-batch campaign over a population this cohort cannot drain.
 * The sites that predate the rule are recorded in a GENERATED artifact
 * (`e2e/waitfortimeout-ledger.generated.txt`, CLAUDE.md's option 4 — "a
 * GENERATED artifact on the accept loop … reviewed as a diff, never
 * hand-merged"). It is never hand-edited and never hand-counted, and
 * `task lint:waits:accept` REFUSES TO GROW IT: accept recomputes the population
 * and fails if it contains a key the ledger does not already have. So the
 * artifact can only shrink, and a NEW un-annotated wait is red on the first run
 * — which is the whole point of landing the ratchet before the burn-down is
 * finished.
 *
 * ── anchored, both directions ──────────────────────────────────────────────
 *
 * `MATCHED` is populated by the rule as it walks the tree; eslint-gate.mjs
 * compares it against the ledger after the run and fails on any entry nothing
 * matched. A ledger line naming a wait that no longer exists (converted,
 * annotated, moved, or deleted) is RED and asks to be dropped. The list can
 * therefore never quietly outlive the artifact it describes.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** The generated ledger of sites that predate this rule. Never hand-edited. */
export const LEDGER_PATH = 'e2e/waitfortimeout-ledger.generated.txt';

/**
 * The marker a justified wait must carry, and the floor its prose must clear.
 *
 * `MIN_WHY` is a PROSE-QUALITY floor, not a population count — the same
 * `why.length` bar `scripts/lint/eslint-gate.mjs` already applies to every
 * NOT_LINTED and STAGED_RULES entry. A one-word "pacing: needed" is exactly the
 * annotation this gate exists to refuse.
 */
export const MARKER = 'pacing:';
export const MIN_WHY = 40;

/** The rule id, in one place: the config registers it, the gate controls assert
 *  on it, and the accept script filters on it. */
export const RULE_ID = 'local/wait-for-timeout-needs-why';

/**
 * Keys the rule matched against the ledger during a run. Shared by construction
 * (one module instance per process), which is how eslint-gate.mjs can ask an
 * otherwise per-file rule a whole-run question: "did every ledger entry
 * actually correspond to something?"
 */
export const MATCHED = new Set();

/**
 * EVERY un-annotated site the rule saw this run, ledgered or not.
 *
 * `task lint:waits:accept` writes this set out as the new ledger, so the
 * artifact is produced by the RULE — the same walk, the same
 * `hasJustification`, the same key function that the gate reads back. There is
 * no second scanner to agree with the first one today and disagree with it
 * after someone edits one of them.
 */
export const COLLECTED = new Set();

/**
 * The identity of one call site, and the only thing the ledger stores.
 *
 *   e2e/tests/foo.spec.ts :: seeds two clips :: waitForTimeout(300) #2
 *
 * Deliberately NOT the line number: every edit above a wait would rewrite half
 * the ledger and the diff would stop being readable, which is the whole value
 * of a reviewed generated artifact. `scope` is the enclosing test title (or
 * function name), `arg` the literal source text of the argument, and `ordinal`
 * discriminates repeats of the same wait inside the same scope — so a SECOND
 * `waitForTimeout(300)` added to an already-listed test is a new key and reds.
 */
export function keyFor({ file, scope, arg, ordinal }) {
  return `${file} :: ${scope} :: waitForTimeout(${arg}) #${ordinal}`;
}

/** Parse the ledger into a Set of keys. Missing file = empty ledger (which
 *  makes every pre-existing site red — loud, not silent). */
export function readLedger(root = ROOT) {
  let text;
  try {
    text = readFileSync(path.join(root, LEDGER_PATH), 'utf8');
  } catch {
    return new Set();
  }
  return new Set(
    text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#')),
  );
}

/**
 * Does this block of comment text justify a wall-clock wait?
 *
 * THE SAME PREDICATE the gate's negative controls call, so a control that
 * passes is evidence about the code that actually runs on the tree — not about
 * a second implementation that agrees with it today.
 */
export function hasJustification(commentText) {
  const at = commentText.indexOf(MARKER);
  if (at === -1) return false;
  const why = commentText
    .slice(at + MARKER.length)
    .replace(/\s+/g, ' ')
    .trim();
  return why.length >= MIN_WHY;
}

/**
 * What this ratchet structurally CANNOT see. Printed by the gate on every run,
 * green ones included, per CLAUDE.md: "state the gate's scope inside the gate,
 * asserting what it still cannot see."
 */
export const WAIT_BLIND_SPOTS = [
  `THE PROSE IS NOT READ. "${MARKER}" plus ${MIN_WHY} characters passes. This gate cannot tell a real product-side interval from ${MIN_WHY} characters of plausible text; only review can. What it CAN do is make the claim exist, be co-located with the wait, and appear in the diff that adds it.`,
  'ONLY `waitForTimeout` IS DENIED. `page.waitForFunction` with a wall-clock deadline, a `setTimeout` inside a `page.evaluate`, and an `expect(...).toPass({ timeout })` whose body is time-based are all wall-clock guesses this rule does not see. It matches one member expression by name.',
  'THE LEDGER IS BLIND TO A REPLACED BODY. A key is (file, enclosing scope, argument text, ordinal). Rewriting a listed test around its wait, or moving that wait to a different statement in the same scope, keeps the same key and stays exempt. Deleting the enclosing test, renaming it, or changing the duration all correctly red.',
  'SCOPE IS `e2e/**/*.ts` ONLY. A wait written in a Svelte component, a unit test, or a script is not this rule’s subject; `packages/**` has its own timing gates.',
];
