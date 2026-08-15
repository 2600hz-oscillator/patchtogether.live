// scripts/docs-only-gate.mjs
//
// The decision logic behind `.github/workflows/docs-only-gate.yml` — the tiny
// companion workflow that unblocks DOCS-ONLY pull requests without weakening
// the gate.
//
// ── The deadlock this exists to break ──────────────────────────────────────
//
// `.github/workflows/ci.yml` carries `paths-ignore: ['**/*.md', '.myrobots/**',
// 'LICENSE']` on both `push` and `pull_request` — a deliberate optimisation so a
// prose-only change doesn't burn a ~25-minute pipeline. But ruleset 16042163
// ("main: green PRs only") REQUIRES two status contexts:
//
//     typecheck + unit + ART + E2E                    (ci.yml job `ci`)
//     vrt-strict (visual regression — strict subset)  (ci.yml job `vrt-strict`)
//
// When CI is path-skipped those contexts NEVER REPORT, and GitHub treats a
// never-reported required check as PENDING FOREVER: the PR sits at
// mergeStateStatus=BLOCKED / mergeable=MERGEABLE with zero failures and can
// never auto-merge. (Live case: #1184, docs-only, 0 failed, 0 running,
// auto-merge armed and permanently stuck. #1175 — the .myrobots corpus PR —
// merged fine because it ALSO touched `.gitignore`, which is not in
// paths-ignore, so CI actually ran.)
//
// ── Why this is SAFE (the two independent guards) ──────────────────────────
//
// GitHub path filters are per-file ANY-match, so for a non-empty changeset:
//
//     ci.yml   `paths-ignore: P`  fires  ⟺  ∃ file ∉ P
//     this one `paths: P`         fires  ⟺  ∃ file ∈ P
//
// with the SAME list P (enforced byte-for-byte by docs-only-gate.test.ts):
//
//     docs-only  → ONLY this workflow fires        → it posts the contexts
//     code-only  → ONLY ci.yml fires               → the real suite gates
//     BOTH       → BOTH fire                       → see below
//
// The both-touched case is the one that must not go wrong: a bypass that fired
// there could satisfy a required context while the real CI run is still in
// flight (or red). Path filters CANNOT express "every changed file is a doc"
// (they are ANY-match, and `!` negation inside `paths:` only re-expresses
// paths-ignore), so this workflow DOES fire on a mixed PR. It is stopped by
// TWO independent guards, and BOTH must agree before a single status is posted:
//
//   G1 (predicate)  every changed file in the PR diff matches P, computed
//                   locally from `gh api pulls/N/files`.
//   G2 (oracle)     NO run of `.github/workflows/ci.yml` exists for this head
//                   SHA — i.e. GitHub's OWN filter evaluation declined to start
//                   the real suite. This is exact by construction: it asks
//                   GitHub what it did rather than re-deriving it.
//
// G2 alone already closes the both-touched case (a mixed PR always produces a
// CI run). G1 alone already closes it under our reading of GitHub's glob
// semantics. Requiring both means a disagreement between this matcher and
// GitHub's — e.g. whether `**/*.md` matches a ROOT-level `README.md`, which
// GitHub's filter engine and minimatch read differently — degrades to "no
// bypass, real CI gates", never to "bypass while code went ungated".
//
// The bypass posts COMMIT STATUSES (statuses API) rather than naming its jobs
// after the required contexts. That is deliberate: a check run is created the
// moment a job starts and cannot be withdrawn, and a JOB-level `if:` skip
// reports as SUCCESS to branch protection — so a name-matched job would satisfy
// the gate on mixed PRs exactly when it must not. A status is only created by an
// explicit, guarded API call, so on a mixed PR this workflow emits NOTHING.
//
// It also never creates a run of `ci.yml`, so daily-prod-deploy.yml's
// `find-green` scan (which looks up `actions/workflows/ci.yml/runs?head_sha=`
// and additionally asserts the umbrella job is present) cannot be fooled into
// treating a docs-only commit as a fully-green deploy candidate.
//
// Scope note: `**/*.md` / `.myrobots/**` / `LICENSE` feed nothing in the build
// or the test suites (verified by grep — every reference is a source comment)
// EXCEPT the generated goldens negated below.
//
// ⚠ THE "NEXT CODE PR CATCHES IT" ARGUMENT WAS TESTED IN THE FIELD AND LOST.
// This note used to accept the gap for `test-ledger.generated.md` on exactly
// that reasoning. On 2026-08-15 a SECOND golden joined the class
// (`face-migration.generated.md`) and the failure mode played out in full:
// two face PRs each regenerated it from the same base, wrote the same value,
// AUTO-MERGED CLEANLY, and left `main` red on `face-migration-inventory` —
// and then the docs-only fix (#1675) ALSO skipped CI, so the repair itself was
// never verified by the lane it repaired. "Ungated but self-healing" turns out
// to mean "red main for hours, and a fix nobody ran the test on".
//
// A generated golden asserted by a test is a TEST INPUT, not prose. Both are
// now negated out of the doc path-set, so touching one runs CI like any other
// code change. `.md` is still the right filter for everything else.

/**
 * The doc path-set. MUST stay byte-identical to ci.yml's `paths-ignore` on both
 * `push` and `pull_request` (docs-only-gate.test.ts fails the build otherwise) —
 * that identity is what makes the two workflows exact complements.
 */
export const DOCS_PATTERNS = [
  '**/*.md',
  // Negations MUST follow the pattern they negate — GitHub evaluates in order.
  '!docs/testing/test-ledger.generated.md',
  '!docs/design/face-migration.generated.md',
  '.myrobots/**',
  'LICENSE',
];

/**
 * The status contexts required by ruleset 16042163. Byte-identical to the
 * `name:` of ci.yml's `ci` and `vrt-strict` jobs (asserted by the test) — GitHub
 * matches required checks by context string, literally, em-dash included.
 */
export const REQUIRED_CONTEXTS = [
  'typecheck + unit + ART + E2E',
  'vrt-strict (visual regression — strict subset)',
];

/** Escape a literal character for use inside a RegExp. */
function escapeChar(c) {
  return /[.*+?^${}()|[\]\\]/.test(c) ? `\\${c}` : c;
}

/**
 * Compile a GitHub-Actions-style path filter glob to a RegExp.
 *
 * `**` matches any run of characters including `/`; `**\/` may additionally
 * match ZERO path segments (the permissive, minimatch-ish reading, so a
 * root-level `README.md` matches `**\/*.md`). `*` and `?` never cross `/`.
 *
 * Deliberately permissive: G2 (the CI-run oracle) is what makes the bypass
 * safe, so this matcher erring wide can only cost a bypass, never grant one.
 */
export function globToRegExp(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          re += '(?:.*/)?'; // `**/` — zero or more leading segments
          i += 2;
        } else {
          re += '.*'; // bare `**` — anything, including `/`
          i += 1;
        }
      } else {
        re += '[^/]*'; // `*` — anything within one segment
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += escapeChar(c);
    }
  }
  return new RegExp(`^${re}$`);
}

/** True iff a repo-relative path matches the glob. */
export function matchesGlob(file, pattern) {
  return globToRegExp(pattern).test(file);
}

/** The changed files that are NOT docs — i.e. the ones that demand real CI. */
export function nonDocFiles(files, patterns = DOCS_PATTERNS) {
  return files.filter((f) => !patterns.some((p) => matchesGlob(f, p)));
}

/** True iff the changeset is non-empty and EVERY file is a doc. */
export function isDocsOnly(files, patterns = DOCS_PATTERNS) {
  return files.length > 0 && nonDocFiles(files, patterns).length === 0;
}

/**
 * The whole decision, in one pure function so the negative controls are unit
 * tests rather than a CI experiment.
 *
 * Posts ONLY when every guard agrees. Any doubt → no status → the PR stays in
 * exactly the state it is in today (blocked), which is the safe failure mode.
 *
 * @param {object} input
 * @param {string[]} input.changedFiles  full PR diff, repo-relative POSIX paths
 * @param {boolean}  input.ciRunExists   a ci.yml run exists for this head SHA
 * @param {boolean}  input.sameRepo      head repo === base repo (fork tokens
 *                                       are read-only and cannot write statuses)
 * @returns {{ post: boolean, reason: string }}
 */
export function decideBypass({ changedFiles, ciRunExists, sameRepo }) {
  if (!sameRepo) {
    return {
      post: false,
      reason: 'fork PR — GITHUB_TOKEN is read-only, cannot write commit statuses',
    };
  }
  if (!Array.isArray(changedFiles) || changedFiles.length === 0) {
    return {
      post: false,
      reason: 'could not resolve the PR file list (or it is empty) — refusing to bypass',
    };
  }
  const offenders = nonDocFiles(changedFiles);
  if (offenders.length > 0) {
    const shown = offenders.slice(0, 10).join(', ');
    const more = offenders.length > 10 ? ` (+${offenders.length - 10} more)` : '';
    return {
      post: false,
      reason: `G1 FAILED — ${offenders.length} non-doc file(s) changed: ${shown}${more}. The real CI suite gates this PR.`,
    };
  }
  if (ciRunExists) {
    return {
      post: false,
      reason:
        'G2 FAILED — a ci.yml run exists for this head SHA, so the real suite is the authority. ' +
        'Posting here would duplicate a required context and could green-light an in-flight or red run.',
    };
  }
  return {
    post: true,
    reason: `docs-only change (${changedFiles.length} file(s), all matching ${DOCS_PATTERNS.join(' | ')}) and GitHub started no ci.yml run for this SHA`,
  };
}

// ---------------------------------------------------------------------------
// CLI — `node scripts/docs-only-gate.mjs decide`
//
// Reads CHANGED_FILES (newline-separated), CI_RUN_EXISTS and SAME_REPO from the
// environment; writes `post=` / `reason=` to $GITHUB_OUTPUT (and stdout).
// ---------------------------------------------------------------------------

/** @internal exported for the test; parses the env into decideBypass() input. */
export function inputFromEnv(env) {
  return {
    changedFiles: (env.CHANGED_FILES ?? '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean),
    ciRunExists: env.CI_RUN_EXISTS === 'true',
    sameRepo: env.SAME_REPO !== 'false',
  };
}

const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  process.argv[1].endsWith('docs-only-gate.mjs');

if (isMain && process.argv[2] === 'decide') {
  const { appendFileSync } = await import('node:fs');
  const input = inputFromEnv(process.env);
  const { post, reason } = decideBypass(input);

  console.log(`changed files (${input.changedFiles.length}):`);
  for (const f of input.changedFiles) console.log(`  · ${f}`);
  console.log(`ci run exists for head sha: ${input.ciRunExists}`);
  console.log(`same-repo PR:               ${input.sameRepo}`);
  console.log(`\ndecision: post=${post}\nreason:   ${reason}`);

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `post=${post}\n`);
    // `reason` embeds FILENAMES from the PR diff, and a git path may legally
    // contain CR/LF — which would inject an extra `key=value` line into
    // $GITHUB_OUTPUT and let a crafted branch forge `post=true`. Flatten first.
    appendFileSync(process.env.GITHUB_OUTPUT, `reason=${reason.replace(/[\r\n]+/g, ' ')}\n`);
    // The contexts travel as an output rather than being imported by the
    // posting step: dynamic `import()` inside actions/github-script's
    // `new AsyncFunction(...)` body has no reliable module referrer, so this
    // module stays the single source of truth WITHOUT an ESM-in-vm dependency.
    appendFileSync(process.env.GITHUB_OUTPUT, `contexts=${JSON.stringify(REQUIRED_CONTEXTS)}\n`);
  }
  if (post) {
    console.log(`\nwill post: ${REQUIRED_CONTEXTS.map((c) => `"${c}"`).join(', ')}`);
  }
}
