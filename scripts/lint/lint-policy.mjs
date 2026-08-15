/**
 * scripts/lint/lint-policy.mjs — the NAMED policy behind `task lint`.
 *
 * Issue #1504. Before this landed, the repo's lint gate was a total no-op:
 * root `package.json` ran `npm run lint --workspaces --if-present`, no
 * workspace defined a `lint` script, and no ESLint config existed anywhere —
 * so the command printed nothing and exited 0. There was also no `lint` job in
 * ci.yml at all. Every "lint is green" statement in this repo's history was
 * therefore a statement about a command that ran zero linters.
 *
 * This module holds the two lists the gate needs, in the shape the repository
 * standard demands (CLAUDE.md, "blind gates" + "never hand-type a population
 * count"):
 *
 *   - DENY BY DEFAULT. Every rule in the js/typescript-eslint/svelte
 *     `recommended` sets is an ERROR. Nothing is exempt implicitly.
 *   - NAMED EXEMPTIONS ONLY. An exemption is a `(rule, why)` pair — never a
 *     "max N errors" ceiling, never a per-file blanket, never a count.
 *   - ANCHORED TO THE ARTIFACT. Every entry here is checked against reality on
 *     every run by scripts/lint/eslint-gate.mjs. A staged rule that no longer
 *     has a violation is RED ("the debt is paid — delete the entry"), and an
 *     ignore entry whose target no longer exists is RED. A ledger entry naming
 *     something that no longer exists must not be able to sit here quietly.
 *
 * There is deliberately NO number in this file describing how many of anything
 * there are. Every such figure the gate reports is derived at run time.
 */

/**
 * Paths ESLint does not read.
 *
 * `anchor` is how each entry proves it still refers to something real:
 *   - `{ tracked: p }`     — `p` must be a git-TRACKED file (it is committed
 *                            third-party/vendored content) AND ESLint must
 *                            actually ignore it.
 *   - `{ gitignored: p }`  — `p` must be matched by .gitignore (it is a build
 *                            artifact or scratch dir that legitimately does not
 *                            exist on a fresh checkout, so "does the file
 *                            exist" would be the wrong question) AND ESLint
 *                            must actually ignore it.
 * Both directions are asserted, so a pattern that silently stops matching is
 * RED rather than a quietly widening blind spot.
 */
export const NOT_LINTED = [
  {
    pattern: '**/node_modules/**',
    anchor: { gitignored: 'node_modules/x.ts' },
    why: 'Third-party dependency source. We do not own it and cannot fix findings in it; npm may rewrite it on any install.',
  },
  {
    pattern: '**/dist/**',
    anchor: { gitignored: 'packages/dsp/dist/x.ts' },
    why: 'Compiled build output (dsp worklets, server tsc output). Linting generated JS reports on the generator, not on any source a human can edit.',
  },
  {
    pattern: '**/build/**',
    anchor: { gitignored: 'packages/web/build/x.ts' },
    why: 'Vite/SvelteKit production bundle output. Same reason as dist: generated, never hand-edited, rewritten by every build.',
  },
  {
    pattern: '**/.svelte-kit/**',
    anchor: { gitignored: 'packages/web/.svelte-kit/x.ts' },
    why: 'SvelteKit generated type + route scaffolding, produced by `svelte-kit sync`. Regenerated on every install; not a source tree.',
  },
  {
    pattern: '.claude/**',
    anchor: { gitignored: '.claude/worktrees/w/packages/web/src/x.ts' },
    why: 'Agent worktrees live here. Each is a FULL checkout of the repo, so linting this would lint every other in-flight branch as if it were this one — the findings would belong to another branch entirely.',
  },
  {
    pattern: 'packages/web/static/**',
    anchor: { tracked: 'packages/web/static/blood/blood.js' },
    why: 'Vendored third-party engine bundles (BLOOD/DOOM/skifree wasm glue). Committed as opaque upstream artifacts — fix belongs upstream, and the emscripten glue is machine-generated.',
  },
  {
    pattern: '**/*.generated.*',
    anchor: { gitignored: 'packages/web/src/lib/docs/module-docs.generated.ts' },
    why: 'Generated artifacts on the accept loop (module docs, timings). Reviewed as a diff via their accept task; a finding here is a bug in the generator, and editing the artifact would be overwritten.',
  },
];

/**
 * ESLint reports an unused `eslint-disable` directive with `ruleId: null`,
 * because it is a linter option rather than a rule. The gate needs a stable
 * key to stage and anchor it like any other entry, so it gets a synthetic one.
 * The spaces mean it can never collide with a real rule id.
 */
export const UNUSED_DISABLE_DIRECTIVE = '(unused eslint-disable directive)';

/**
 * Rules that are REAL but not yet enforced as errors.
 *
 * Each entry runs at severity `warn` instead of `error`, so it is still
 * evaluated, still printed on every run, and — critically — still ANCHORED:
 * eslint-gate.mjs fails if a staged rule stops producing findings, because
 * that means the debt is paid and the entry is now a lie.
 *
 * This is the staging mechanism the issue asks for, in the shape CLAUDE.md
 * requires: a NAMED per-rule list with a `why`, NOT a numeric ceiling. There is
 * no "max N warnings" anywhere in this gate — a ceiling would silently absorb
 * new violations of a staged rule up to its limit, and would go stale the
 * moment two branches paid down different amounts of the same debt.
 *
 * TO PAY ONE DOWN: fix the findings, then DELETE the entry. The gate will tell
 * you when you are done, because it goes red on the stale entry.
 */
export const STAGED_RULES = [
  {
    rule: 'svelte/no-unused-svelte-ignore',
    why: "INSTRUMENT DEFECT, not debt. The rule cannot see the Svelte 5 compiler's warning list, so it reports every `svelte-ignore` comment in the tree, once per warning code it failed to match — the same source line is reported many times over. Measured on this tree, reports outnumbered the actual `svelte-ignore` comments by an order of magnitude. Re-check after an eslint-plugin-svelte upgrade; if it reports each comment once, the findings become triageable and this entry can go.",
  },
  {
    rule: '@typescript-eslint/no-unused-vars',
    why: 'Real dead bindings, concentrated in test scaffolding (assertions that were narrowed, helpers that outlived their spec). The instrument is already corrected for the two false-positive classes — `_`-prefixed intentional placeholders and Playwright fixture destructuring, where naming the fixture IS how you activate it — so what remains is genuine. Burn down per-directory; it is a wide, low-risk sweep that would collide with every in-flight branch if done in this PR.',
  },
  {
    rule: 'no-useless-assignment',
    why: 'Values assigned then overwritten before any read. Individually trivial, but each one is a question about intent in code this gate has never run against — several sit in audio/graph paths where the "dead" store may be documenting an ordering constraint. Triage per file, do not bulk-autofix.',
  },
  {
    rule: 'svelte/no-navigation-without-resolve',
    why: "SvelteKit `resolve()`-aware navigation, a convention this codebase predates. Mechanical to fix but touches routing on every card that links out; wants its own PR so a regression is bisectable to one change rather than buried in the PR that turned linting on.",
  },
  {
    rule: '@typescript-eslint/no-explicit-any',
    why: 'Explicit `any` at boundaries this repo genuinely does not type (Web MIDI/USB vendor payloads, emscripten module handles, test doubles). Some are legitimate and want a narrow interface instead; deciding which is per-site work, not a sweep.',
  },
  {
    rule: 'svelte/prefer-svelte-reactivity',
    why: 'Plain `Map`/`Set`/`Date` held in `$state` where svelte/reactivity versions would track mutation. Per CLAUDE.md the effects audit found 229/233 reactivity flags to be valid bridges, so a blind conversion here risks changing update timing in the audio graph. Needs the same per-site review that audit used.',
  },
  {
    rule: 'prefer-const',
    why: '`let` bindings never reassigned. Autofixable and semantically safe, but the fix spans enough files across web/dsp to conflict with every open PR — exactly the mass-reformat commit issue #1504 explicitly rules out. Fold into whatever PR already touches each file (boy-scout), not a sweep.',
  },
  {
    rule: 'svelte/require-each-key',
    why: 'Keyless `{#each}` blocks. A key changes list-diffing identity, so adding one to a card that holds canvas/WebGL state per row can change teardown behaviour — the exact class CLAUDE.md flags as node-lifetime state loss. Each needs a look at what the row owns before a key is chosen.',
  },
  {
    rule: 'preserve-caught-error',
    why: 'Rethrows that drop the original error instead of passing `{ cause }`. Worth fixing for debuggability, but it changes what surfaces in Better Stack, so it should land as one deliberate observability change rather than as a side effect of enabling lint.',
  },
  {
    rule: 'no-useless-escape',
    why: 'Redundant backslashes inside regex/string literals in codegen and attest scripts. Editing a regex to satisfy a linter is precisely the "green gate certifying a live bug" hazard from CLAUDE.md when the pattern is load-bearing; each wants its own check that the match set is unchanged.',
  },
  {
    rule: '@typescript-eslint/no-this-alias',
    why: '`const self = this` in the livecode runtime and video worker proxy, where the alias is captured deliberately for a nested non-arrow callback or a Proxy trap. Likely correct as written; the fix is to prove that per site and then either restructure or carry a narrow per-site disable.',
  },
  {
    rule: '@typescript-eslint/no-unused-expressions',
    why: 'Bare expressions used as assertions in the vfpga registry test. Almost certainly a test that means to call something; it needs the spec author to say which, because "fixing" it either way changes what the test proves.',
  },
  {
    rule: 'svelte/no-useless-mustaches',
    why: 'Mustaches wrapping a literal, e.g. `{"text"}` where `text` would do. Trivial and mostly autofixable, but it edits component markup, which is what VRT baselines are pixels of — it belongs in a PR that can afford a baseline run, and this one deliberately does not trigger one.',
  },
  {
    rule: 'prefer-spread',
    why: '`Function.prototype.apply` in the livecode runtime, where the call is forwarding a dynamic argument list into user-authored code. Spread is usually equivalent but not when the callee inspects `arguments`; wants a runtime check, not a rewrite.',
  },
  {
    rule: 'svelte/no-dom-manipulating',
    why: 'Direct DOM writes in the text-marquee card, which drives its own scroll animation outside Svelte state on purpose (a per-frame text transform is not a state update). Fixing it means moving the animation into the framework, which is a rewrite of the module, not a lint fix.',
  },
  {
    rule: 'svelte/no-at-html-tags',
    why: '`{@html}` in the Fader control. This one is security-relevant (XSS surface) and therefore explicitly NOT a mechanical fix: it needs someone to establish where the string comes from and whether it is ever user- or peer-authored, which in a multiplayer rackspace is a real question.',
  },
  {
    rule: 'svelte/prefer-writable-derived',
    why: 'A `$state` + `$effect` pair in the port context menu that a writable `$derived` would express directly. Small, but it is a reactivity-timing change in menu code that VRT baselines capture — wants a VRT run, which this PR deliberately does not trigger.',
  },
  {
    rule: 'no-useless-catch',
    why: 'A catch block in the livecode runtime that only rethrows. Removing it looks free but the runtime wraps user code, and an explicit catch is sometimes kept to pin a stack frame; confirm against how livecode surfaces user errors before deleting.',
  },
  {
    rule: 'no-fallthrough',
    why: 'A switch fallthrough in the module scaffolder. Either intentional and wants the documented comment marker, or a real bug in code generation — telling those apart means running the scaffolder, which is out of scope here.',
  },
  {
    rule: 'no-control-regex',
    why: 'A control character in the webgl-attest output sanitiser, which is stripping ANSI/control bytes from captured logs on purpose. The rule is right that it is unusual and wrong that it is a mistake; the fix is an explicit escape plus a test, not a pattern change.',
  },
  {
    rule: UNUSED_DISABLE_DIRECTIVE,
    why: 'Suppression comments for rules that are not enabled — the inert `eslint-disable` claims flagged on this issue, written over years against a linter that never ran. Removing them is the right end state, but it edits comment lines across a wide slice of the tree, which is both the mass-reformat commit #1504 rules out and a `git blame` hazard. They are now VISIBLE on every lint run, which they were not before.',
  },
];

/**
 * What this gate structurally CANNOT see.
 *
 * Required by CLAUDE.md: "state the gate's scope inside the gate, asserting
 * what it still cannot see." Printed on every run — including green ones — so
 * a reader of a passing log is told the limits of what just passed, rather than
 * inferring that green means "everything is checked".
 */
export const BLIND_SPOTS = [
  'TYPE-AWARE RULES ARE OFF. This runs typescript-eslint WITHOUT `projectService`, so every rule needing type information — no-floating-promises, no-misused-promises, await-thenable, restrict-template-expressions — is NOT running. A dropped `await` will pass this gate. `task typecheck` (svelte-check + tsc) is the gate that reads types; lint is deliberately the fast syntactic lane.',
  'SVELTE COMPILER WARNINGS ARE NOT LINT. a11y, unused CSS and reactivity warnings come from the Svelte compiler via svelte-check in `task typecheck`, not from here. A clean lint says nothing about them.',
  'TASKFILE SHELL IS NOT SHELLCHECKED. `Taskfile.yml` `cmds:` blocks are shell, but they are go-template first: `{{.VAR}}` is not shell syntax and shellcheck parses it as a literal brace group. Extracting them would produce findings about the template, not the script. Workflow `run:` blocks ARE covered (actionlint substitutes GitHub expressions before handing the body to shellcheck); standalone `scripts/**/*.sh` are covered directly.',
  'UNTRACKED SHELL IS NOT SHELLCHECKED. The shell lane enumerates `git ls-files "*.sh"`, so a script that exists on disk but was never committed is invisible to it. That is deliberate — the gate reports on what the repo ships — but it means "green locally" can hide a file you have not added yet.',
  'FORMATTING IS NOT CHECKED. Issue #1504 puts Prettier explicitly out of scope. Nothing here enforces quotes, spacing or import order.',
  'PATHS IN NOT_LINTED ARE INVISIBLE BY CONSTRUCTION. Each carries its own `why` and is anchored, but a defect inside one of them cannot be reported by this gate at all.',
];
