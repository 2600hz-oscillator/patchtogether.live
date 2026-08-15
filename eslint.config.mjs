/**
 * eslint.config.mjs — the repository's single ESLint flat config (issue #1504).
 *
 * RUN IT THROUGH THE GATE, NOT DIRECTLY: `flox activate -- task lint`.
 * This config is the full, unmodulated rule set: every recommended rule at its
 * natural severity over the whole tree, so `npx eslint .` reports ALL of it and
 * exits non-zero. That is deliberate — it is the honest reading of the tree.
 * Which of those findings currently BLOCK is a separate decision, made in
 * scripts/lint/eslint-gate.mjs against the named staging list in
 * scripts/lint/lint-policy.mjs. Config = what the rules are. Gate = what gates.
 *
 * SHAPE
 *   deny by default  — js + typescript-eslint + svelte `recommended`, all at
 *                      error, over every TS/JS/Svelte file in the tree.
 *   named exemptions — scripts/lint/lint-policy.mjs, each with a `why`, each
 *                      anchored so a stale one goes red.
 *   no type-aware rules — `projectService` is deliberately off; see BLIND_SPOTS
 *                      in the policy module for what that costs.
 *
 * INSTRUMENT CORRECTIONS
 * The blocks below marked "instrument correction" are NOT exemptions. They are
 * fixes to rules that, in this repo's file layout, were measuring something
 * other than what they claim to measure — the CLAUDE.md "validate the
 * instrument" case, where a wrong metric reads exactly like a finding. Each one
 * states what it was reporting and why that reading was false. On the first run
 * of this config these corrections were the difference between 3334 reported
 * problems and 679 real ones; every one of them was noise, not debt.
 */
import js from '@eslint/js';
import ts from 'typescript-eslint';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';
import { NOT_LINTED } from './scripts/lint/lint-policy.mjs';

/**
 * INSTRUMENT CORRECTION — `no-unused-vars` reported two large classes of
 * binding that are unused ON PURPOSE and are not dead code:
 *
 *  1. `_`-prefixed placeholders. The repo-wide convention for "this parameter
 *     exists to hold a position in a signature". Reporting them asks the author
 *     to delete a binding the signature requires.
 *  2. Playwright fixture destructuring — `async ({ page, rack, errorWatch })`.
 *     Naming a fixture IS how you activate it; the fixture's setup runs because
 *     you asked for it. `rack` being "unused" in the body is the normal case,
 *     not a defect. Hence `args: 'none'` for e2e below.
 *
 * Together these were the large majority of this rule's original output.
 */
const UNUSED_VARS_OPTIONS = {
  args: 'after-used',
  argsIgnorePattern: '^_',
  varsIgnorePattern: '^_',
  caughtErrorsIgnorePattern: '^_',
  destructuredArrayIgnorePattern: '^_',
  ignoreRestSiblings: true,
};

/**
 * ⚠ STAGING IS NOT EXPRESSED HERE. This config sets every rule to its natural
 * severity from the recommended sets; scripts/lint/eslint-gate.mjs decides
 * which findings block, by rule id, from STAGED_RULES.
 *
 * The first draft did the obvious thing instead — a trailing block setting each
 * staged rule to `warn`. A trailing block has no `files:` key, so it applies
 * everywhere, and it silently ENABLED rules that the earlier blocks had scoped
 * to specific file types. `prefer-const` went from 28 findings to 2846, all of
 * them newly reported in `.svelte` files, because the staging block overrode
 * the scoping that had kept the core rule off Svelte components. That is the
 * CLAUDE.md instrument failure exactly: the number moved by two orders of
 * magnitude and the output looked like a finding about the codebase.
 *
 * Keeping severity out of this file makes that class impossible: the config
 * cannot change WHICH rules apply to WHAT, because it no longer names a rule
 * for any reason other than to correct an instrument.
 */
export default ts.config(
  { ignores: NOT_LINTED.map(({ pattern }) => pattern) },

  js.configs.recommended,
  ts.configs.recommended,
  svelte.configs.recommended,

  {
    linterOptions: {
      // Surfaces `eslint-disable` comments that suppress nothing. Before this
      // config existed, every such comment in the tree was an unverifiable
      // claim about a linter that had never run (noted on #1504). They are now
      // reported on every run — staged, so visible without blocking; see the
      // UNUSED_DISABLE_DIRECTIVE entry in scripts/lint/lint-policy.mjs.
      reportUnusedDisableDirectives: 'error',
    },
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      // INSTRUMENT CORRECTION — `no-undef` in a TypeScript codebase reports
      // TYPES as undefined runtime values (`BlobPart`, `CanvasImageSource`) and
      // cannot see build-time defines (`__APP_VERSION__`). typescript-eslint
      // turns it off for .ts for exactly this reason; its override does not
      // list .svelte, which is why every one of these landed in a component.
      // Undefined identifiers are svelte-check's and tsc's job — `task
      // typecheck` — and they do it with real type information.
      'no-undef': 'off',

      '@typescript-eslint/no-unused-vars': ['error', UNUSED_VARS_OPTIONS],
    },
  },

  {
    files: ['**/*.svelte', '**/*.svelte.ts'],
    languageOptions: {
      parserOptions: { parser: ts.parser },
    },
  },

  {
    // INSTRUMENT CORRECTION — `require()` in a `.cjs` file is not a finding,
    // it is the file format. The rule is about ESM files that reach for
    // `require`; a CommonJS entry point has no other option.
    files: ['**/*.cjs'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },

  {
    // INSTRUMENT CORRECTION — `/// <reference types="..." />` inside a `.d.ts`
    // is the only way to pull ambient worklet globals into scope; there is no
    // `import` form that does it. The rule targets .ts source, where an import
    // is available.
    files: ['**/*.d.ts'],
    rules: { '@typescript-eslint/triple-slash-reference': 'off' },
  },

  {
    // e2e fixture destructuring — see UNUSED_VARS_OPTIONS above.
    files: ['e2e/**'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { ...UNUSED_VARS_OPTIONS, args: 'none' }],
    },
  },
);
