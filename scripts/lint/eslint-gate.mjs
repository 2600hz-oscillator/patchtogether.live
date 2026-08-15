#!/usr/bin/env node
/**
 * scripts/lint/eslint-gate.mjs — the ESLint half of `task lint` (issue #1504).
 *
 * This file, not `npx eslint .`, is the gate. eslint.config.mjs holds every
 * recommended rule at its natural severity, so `npx eslint .` reports the whole
 * truth and exits non-zero; this file decides which of those findings BLOCK, by
 * rule id, from the named staging list. Config = what the rules are. Gate =
 * what gates. Keeping them apart is deliberate: expressing staging as severity
 * overrides in the config silently changed which rules applied to which file
 * types (see the note in eslint.config.mjs).
 *
 * IT FAILS ON FOUR INDEPENDENT CONDITIONS. Each one is a different way for the
 * gate to stop being true, and CLAUDE.md's blind-gates standard asks for all of
 * them explicitly:
 *
 *   1. A FINDING ON A NON-STAGED RULE, anywhere ESLint reads. This is the gate
 *      proper: deny by default, with exemptions named one rule at a time.
 *
 *   2. A STALE STAGED ENTRY. If a staged rule produces no findings, the debt is
 *      paid and the entry is now a claim about something that does not exist —
 *      "anchor to the ARTIFACT, not the list". It goes red and asks to be
 *      deleted, so the staging list can only ever shrink.
 *
 *   3. A STALE IGNORE ENTRY. Same rule, applied to NOT_LINTED: the target must
 *      still be tracked (vendored) or still be gitignored (build output), AND
 *      ESLint must still actually ignore it. Both directions, so a pattern that
 *      silently stops matching cannot widen the blind spot quietly.
 *
 *   4. A DEAD INSTRUMENT. The controls below. This is the answer to "would its
 *      green run look any different if the answer were 'everything'?" — if
 *      ESLint stopped seeing TypeScript or stopped seeing Svelte, conditions
 *      1-3 would all pass (no errors found! nothing to report!) and the log
 *      would look perfect. The controls make that specific failure loud, and
 *      they run on EVERY invocation rather than being a one-off check someone
 *      did once by hand.
 */
import { ESLint } from 'eslint';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  NOT_LINTED,
  STAGED_RULES,
  BLIND_SPOTS,
  UNUSED_DISABLE_DIRECTIVE,
} from './lint-policy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * PERMANENT CONTROLS — both directions, on every run.
 *
 * A negative control alone only proves the probe CAN move. Each case here also
 * pins WHICH rule must fire, so a linter that reports the wrong thing is as red
 * as a linter that reports nothing (per the repo's positive-control standard).
 *
 * `mustReport` cases carry a deliberate defect. `mustBeSilent` cases are clean
 * and prove the gate is not simply reporting on everything it is handed — a
 * check that always fires is exactly as uninformative as one that never does.
 *
 * The two languages are separate cases on purpose: the Svelte path uses a
 * different parser from the TS path, and a config error can silence one while
 * leaving the other working.
 */
const CONTROLS = [
  {
    name: 'typescript / must report',
    filePath: 'scripts/lint/__control__.ts',
    code: 'export function control(): void {\n  debugger;\n}\n',
    mustReport: 'no-debugger',
  },
  {
    name: 'typescript / must be silent',
    filePath: 'scripts/lint/__control__.ts',
    code: 'export function control(): void {\n  return;\n}\n',
    mustBeSilent: true,
  },
  {
    name: 'svelte / must report',
    filePath: 'packages/web/src/lib/__control__.svelte',
    code: '<script lang="ts">\n  const value = 1;\n</script>\n\n{@debug value}\n',
    mustReport: 'svelte/no-at-debug-tags',
  },
  {
    name: 'svelte / must be silent',
    filePath: 'packages/web/src/lib/__control__.svelte',
    code: '<script lang="ts">\n  const value = 1;\n</script>\n\n<p>{value}</p>\n',
    mustBeSilent: true,
  },
];

const failures = [];
const fail = (headline, detail) => failures.push({ headline, detail });

/** Key a message the same way the policy list names it. */
const keyOf = (message) => message.ruleId ?? UNUSED_DISABLE_DIRECTIVE;

async function main() {
  const eslint = new ESLint({ cwd: ROOT });

  // ---------------------------------------------------------------------
  // 4. CONTROLS FIRST. If the instrument is dead there is no point reporting
  //    a clean tree, and running them first means the failure that gets
  //    printed is "the linter stopped working", not "no problems found".
  // ---------------------------------------------------------------------
  for (const control of CONTROLS) {
    let results;
    try {
      results = await eslint.lintText(control.code, {
        filePath: path.join(ROOT, control.filePath),
        warnIgnored: false,
      });
    } catch (error) {
      fail(
        `CONTROL "${control.name}" could not be linted at all`,
        `${error.message}\nThe linter threw on a ${path.extname(control.filePath)} file. Nothing this gate reports about the tree can be trusted until that is fixed.`,
      );
      continue;
    }
    const reported = results.flatMap((r) => r.messages.map((m) => keyOf(m)));

    if (control.mustReport && !reported.includes(control.mustReport)) {
      fail(
        `CONTROL "${control.name}" did NOT report its deliberate defect`,
        `expected rule: ${control.mustReport}\nactually reported: ${reported.length ? reported.join(', ') : '(nothing at all)'}\n` +
          `A defect this gate is supposed to catch went unreported. Until this passes, a green tree means "the linter did not look", not "the tree is clean".`,
      );
    }
    if (control.mustBeSilent && reported.length > 0) {
      fail(
        `CONTROL "${control.name}" reported on clean code`,
        `reported: ${reported.join(', ')}\nThe gate fires on code that has nothing wrong with it, so its findings carry no information.`,
      );
    }
  }

  // ---------------------------------------------------------------------
  // 3. IGNORE ANCHORS. Every NOT_LINTED entry must still describe reality.
  // ---------------------------------------------------------------------
  for (const entry of NOT_LINTED) {
    const { pattern, anchor, why } = entry;
    if (!why || why.length < 40) {
      fail(
        `NOT_LINTED entry "${pattern}" has no usable reason`,
        'Every exemption carries a `why` explaining what is in there and why nobody can lint it. A path this gate is blind to is not allowed to be unexplained.',
      );
    }

    const target = anchor.tracked ?? anchor.gitignored;
    if (anchor.tracked) {
      const tracked = git(['ls-files', '--error-unmatch', anchor.tracked]);
      if (tracked === null) {
        fail(
          `NOT_LINTED entry "${pattern}" is anchored to a file that is no longer tracked`,
          `anchor: ${anchor.tracked}\nThe vendored content this entry excuses is gone, or moved. Delete the entry or re-point it — do not leave a blind spot justified by a file that does not exist.`,
        );
      }
    } else {
      const ignored = git(['check-ignore', '-q', anchor.gitignored]);
      if (ignored === null) {
        fail(
          `NOT_LINTED entry "${pattern}" is anchored to a path .gitignore no longer covers`,
          `anchor: ${anchor.gitignored}\nThis entry exists because the path is generated build output. If git now tracks it, it is source, and it should be linted.`,
        );
      }
    }

    if (!(await eslint.isPathIgnored(path.join(ROOT, target)))) {
      fail(
        `NOT_LINTED pattern "${pattern}" does not actually ignore its own anchor`,
        `anchor: ${target}\nThe pattern and the thing it claims to exclude have drifted apart. Either the exemption is dead (delete it) or the glob is wrong (fix it).`,
      );
    }
  }

  // ---------------------------------------------------------------------
  // 1 + 2. THE TREE.
  // ---------------------------------------------------------------------
  const results = await eslint.lintFiles(['.']);

  const staged = new Set(STAGED_RULES.map(({ rule }) => rule));
  const seen = new Map();
  let blockingCount = 0;
  let stagedCount = 0;
  let filesLinted = 0;

  // Findings are split by RULE ID, not by severity. Severity comes from the
  // recommended sets and is left exactly as their authors wrote it; the staging
  // decision is this repo's, and keeping the two apart is what stops a staging
  // edit from quietly changing which rules apply to which files.
  const blockingResults = [];
  for (const result of results) {
    filesLinted += 1;
    const blocking = [];
    for (const message of result.messages) {
      const key = keyOf(message);
      seen.set(key, (seen.get(key) ?? 0) + 1);
      if (staged.has(key)) stagedCount += 1;
      else {
        blocking.push(message);
        blockingCount += 1;
      }
    }
    if (blocking.length > 0) {
      blockingResults.push({
        ...result,
        messages: blocking,
        errorCount: blocking.length,
        warningCount: 0,
        fixableErrorCount: 0,
        fixableWarningCount: 0,
      });
    }
  }

  // A tree-wide run that read nothing would satisfy every other check here.
  if (filesLinted === 0) {
    fail(
      'ESLint linted ZERO files',
      'Every other check in this gate passes trivially when nothing is read. Check the `ignores` list and the working directory.',
    );
  }

  if (blockingCount > 0) {
    const formatter = await eslint.loadFormatter('stylish');
    fail(
      `${blockingCount} lint finding(s) on rules that are NOT staged`,
      `${await formatter.format(blockingResults)}\n` +
        `Every rule above is enforced. Fix the code — or, if the rule is genuinely wrong for this repo, add a NAMED entry with a \`why\` to STAGED_RULES in scripts/lint/lint-policy.mjs and say so in review. Do not add a blanket file exclusion.`,
    );
  }

  for (const { rule, why } of STAGED_RULES) {
    if (!why || why.length < 40) {
      fail(
        `staged rule "${rule}" has no usable reason`,
        'A staged rule is a promise to come back to it. Without a `why` there is nothing for the next reader to act on, and the entry becomes permanent by default.',
      );
    }
    if (!seen.has(rule)) {
      fail(
        `staged rule "${rule}" no longer has any findings — the entry is STALE`,
        `Nothing in the tree violates this rule any more, so the exemption describes something that does not exist.\n` +
          `THE FIX IS TO DELETE IT: remove the "${rule}" entry from STAGED_RULES in scripts/lint/lint-policy.mjs, which promotes the rule to a hard error. This is the gate ratcheting itself; it is the intended way for the staging list to end.`,
      );
    }
  }

  report({ filesLinted, blockingCount, stagedCount, seen, eslint });
}

/** Run git; return stdout on success, null on non-zero exit. */
function git(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

async function report({ filesLinted, blockingCount, stagedCount, seen, eslint }) {
  // Everything printed here is DERIVED. Per CLAUDE.md there is no hand-typed
  // population count anywhere in this gate: the numbers below are computed from
  // the run that just happened, so they cannot go stale or be merged wrongly.
  const config = await eslint.calculateConfigForFile(
    path.join(ROOT, 'scripts/lint/eslint-gate.mjs'),
  );
  const enabled = Object.entries(config.rules ?? {}).filter(([, v]) => {
    const severity = Array.isArray(v) ? v[0] : v;
    return severity !== 0 && severity !== 'off';
  });

  const staged = STAGED_RULES.map(({ rule }) => rule);
  console.log('');
  console.log('── eslint gate ──────────────────────────────────────────────');
  console.log(`  files linted        ${filesLinted}`);
  console.log(`  rules enabled       ${enabled.length} (as resolved for a .mjs file; .svelte and .ts resolve more)`);
  console.log(`  rules staged        ${staged.length} (named, each with a why, in scripts/lint/lint-policy.mjs)`);
  console.log(`  blocking findings   ${blockingCount}`);
  console.log(`  staged findings     ${stagedCount}`);
  if (staged.length > 0) {
    console.log('');
    console.log('  outstanding staged debt (delete the entry when it hits zero):');
    for (const rule of staged.slice().sort()) {
      console.log(`    ${String(seen.get(rule) ?? 0).padStart(5)}  ${rule}`);
    }
  }
  console.log('');
  console.log('  THIS GATE CANNOT SEE:');
  for (const spot of BLIND_SPOTS) {
    console.log(`    · ${wrap(spot, 4)}`);
  }
  console.log('─────────────────────────────────────────────────────────────');

  if (failures.length === 0) {
    console.log('eslint gate: PASS');
    return;
  }

  console.error('');
  for (const { headline, detail } of failures) {
    console.error(`✗ ${headline}`);
    console.error(`${detail.replace(/^/gm, '    ')}`);
    console.error('');
  }
  console.error(`eslint gate: FAIL (${failures.length} condition(s))`);
  process.exitCode = 1;
}

function wrap(text, indent) {
  const width = 74;
  const pad = ' '.repeat(indent + 2);
  const out = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line.length + word.length + 1 > width) {
      out.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) out.push(line);
  return out.join(`\n${pad}`);
}

await main();
