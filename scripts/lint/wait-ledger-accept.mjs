#!/usr/bin/env node
/**
 * scripts/lint/wait-ledger-accept.mjs — `task lint:waits:accept` (issue #1523).
 *
 * Regenerates `e2e/waitfortimeout-ledger.generated.txt` from the tree, and
 * REFUSES TO GROW IT.
 *
 * The ledger is not a permission list; it is the outstanding population of the
 * #1523 burn-down, recorded so the ratchet can block NEW waits before the old
 * ones are drained. If regeneration could absorb new sites, the ratchet would
 * be an honour system — so this script computes the population, diffs it
 * against what is already committed, and exits non-zero on anything the ledger
 * does not already contain. The only edit it will ever write is a REMOVAL.
 *
 * It produces the ledger by RUNNING THE RULE (the rule fills `COLLECTED` as it
 * walks). There is no second scanner here: the artifact the gate reads back is
 * written by the same walk, the same `hasJustification`, and the same key
 * function the gate uses to read it.
 *
 * Everything printed is derived from the run that just happened; per CLAUDE.md
 * there is no hand-typed population count in this file or in the artifact.
 */
import { ESLint } from 'eslint';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, LEDGER_PATH, MARKER, COLLECTED, readLedger } from './wait-ledger.mjs';

const HEADER = `# ${LEDGER_PATH} — GENERATED, DO NOT HAND-EDIT.
#
# The waits under e2e/ that predate the #1523 ratchet
# (scripts/lint/rules/wait-for-timeout-needs-why.mjs). Each line is one call
# site: file :: enclosing test or function :: the call :: which repeat.
#
# This file exists so the rule can block a NEW un-annotated wait while the old
# population is still being burned down. It is written by
# \`flox activate -- task lint:waits:accept\`, which refuses to add a line, so it
# can only shrink. A line naming a wait that no longer exists is RED in
# \`task lint\`.
#
# To take a line off this list, do one of:
#   · RENDER/PAINT readiness  → waitFrames(page, n)  (e2e/_helpers/frames.ts)
#   · STATE/DOM readiness     → await expect(locator)… / expect.poll(…)
#   · a real product-side interval → keep the wait, and write above it:
#         // ${MARKER} <which interval this mirrors, and where the product defines it>
# then re-run the accept task and commit the shrunk artifact.
`;

const eslint = new ESLint({ cwd: ROOT });
// Walking e2e/ is what fills COLLECTED. Lint findings are expected here (every
// un-ledgered site reports); this script cares about the SET, not the exit.
await eslint.lintFiles(['e2e']);

const committed = readLedger(ROOT);
const derived = [...COLLECTED].sort();

/**
 * FIRST GENERATION. With no artifact on disk there is nothing to grow, so the
 * initial write is allowed; from then on the file exists and every subsequent
 * run is shrink-only. Deleting it to get a fresh bootstrap is not a quiet
 * escape hatch: the whole population reappears in the diff of the commit that
 * does it.
 */
const bootstrap = !existsSync(path.join(ROOT, LEDGER_PATH));

const added = bootstrap ? [] : derived.filter((key) => !committed.has(key));
if (added.length > 0) {
  console.error('');
  console.error(`✗ ${added.length} NEW un-annotated wait(s) — the ledger will not grow.`);
  for (const key of added) console.error(`    ${key}`);
  console.error('');
  console.error(
    'Fix the call site instead: count frames for a paint wait, assert a predicate for a state\n' +
      `wait, or annotate a genuine product-side interval with "// ${MARKER} …" on the site itself.\n` +
      'The ledger records what predates the rule; it is not a way to opt out of it.',
  );
  process.exit(1);
}

const removed = [...committed].filter((key) => !COLLECTED.has(key)).sort();
writeFileSync(path.join(ROOT, LEDGER_PATH), `${HEADER}\n${derived.join('\n')}\n`, 'utf8');

console.log('');
console.log('── #1523 wait ledger ────────────────────────────────────────');
console.log(`  outstanding waits   ${derived.length}`);
console.log(`  removed this run    ${removed.length}`);
for (const key of removed) console.log(`    − ${key}`);
console.log(`  written             ${LEDGER_PATH}`);
console.log('─────────────────────────────────────────────────────────────');
console.log('Review the diff: every removed line should correspond to a wait you converted or annotated.');
