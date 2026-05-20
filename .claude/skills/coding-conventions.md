---
name: coding-conventions
description: Code style and authoring rules for this project. Covers TypeScript, Svelte, comment policy, refactoring discipline, and the "what NOT to add" list.
---

# Coding conventions

## Stack

- **Language**: TypeScript strict mode across all workspaces (`packages/web`,
  `packages/server`, `packages/dsp`, `packages/art`, `e2e`).
- **UI**: Svelte 5 (runes — `$state`, `$derived`, `$effect`).
- **Audio**: Web Audio API + AudioWorklet. DSP code lives in `packages/dsp/`
  and is bundled into worklet modules.
- **Video**: WebGL2 + custom shaders.
- **Sync**: Y.Doc / SyncedStore for CRDT multiplayer state.
- **Graph**: xyflow (Svelte) for the patch canvas.
- **Tests**: Vitest (unit + ART), Playwright (E2E + VRT).
- **Build**: Vite (web), esbuild (DSP worklets).
- **Runtime**: SvelteKit on Cloudflare Pages + Workers; multiplayer server on Fly.

## Comment policy

**Default: write zero comments.**

Only write a comment when the WHY is non-obvious — a hidden constraint, a
subtle invariant, a workaround for a specific bug, behavior that would
surprise a future reader. If removing the comment wouldn't confuse anyone,
don't write it.

**Don't write:**
- WHAT-comments (well-named identifiers do that).
- Multi-paragraph docstrings.
- Block comments above functions describing what each parameter does.
- Comments that reference the current task, fix, or callers (`// used by X`,
  `// added for the Y flow`, `// handles the case from issue #123`). Those
  belong in PR descriptions and rot fast.
- Section headers (`// ---- helpers ----`) unless the file is genuinely huge.

**Do write** — sparingly:
- Single-line "why" for a non-obvious workaround or invariant.
- The reason a regression test exists (only if not obvious from the test
  description).

## What NOT to add

The user is allergic to scope creep. Stay narrow.

- **No premature abstractions.** Three similar lines is better than a helper.
  Don't extract a function "for reuse" unless you have ≥2 actual call sites
  and the abstraction holds.
- **No defensive code beyond system boundaries.** Trust internal callers and
  framework guarantees. Validate only at user-input / external-API edges.
- **No backwards-compat shims** unless the user explicitly asks. If you change
  a function signature, change every call site. Don't keep both shapes.
- **No "for future use" parameters.** YAGNI hard. Add the param when the
  feature lands.
- **No feature flags** unless the user asks. We deploy from main; rollout is
  via merge ordering.
- **No half-finished implementations** with TODO holes. If the work needs to
  pause, do it as a follow-up PR/issue, not a stub.

## Refactor discipline

A bug fix doesn't need cleanup around it. A one-shot operation doesn't need a
helper. Refactors get their own PR. If you find an unrelated wart while doing
work, file an issue — don't drag it into the current change.

When you do refactor, prefer **whole-file consistency** — if you rename a
concept, rename every use. Leaving "renamed-to-X" old names as exports for
"compat" is a smell; just change the call sites.

## Variable & file naming

- TypeScript files: `kebab-case.ts`. Svelte components: `PascalCase.svelte`.
- Audio modules: `packages/web/src/lib/audio/modules/<name>.ts` for the def,
  `packages/web/src/lib/ui/modules/<Name>Card.svelte` for the card.
- DSP worklet code: `packages/dsp/src/<name>.ts`. Shared DSP helpers:
  `packages/dsp/src/lib/<helper>.ts` (the `lib/` subdirectory is excluded from
  the worklet entrypoint glob).
- Test files: colocated `<name>.test.ts` for unit; `e2e/tests/<name>.spec.ts`
  for E2E; `e2e/vrt/<name>.spec.ts` for visual specs.

## Module registry pattern

When you add a new audio/video module, every shared registry file gets one
add. See `module-development` skill — these adds get auto-merge-eaten if you
let a stale PR linger, so know the list:

- `packages/web/src/lib/audio/modules/index.ts` (import + register)
- `packages/web/src/lib/ui/Canvas.svelte` (Card import + switch case)
- `packages/web/src/lib/ui/module-categories.ts` (palette category)
- `packages/web/src/lib/graph/types.ts` (cable-type compatibility)
- `packages/web/src/lib/audio/modules/vrt-meta.test.ts` (VRT coverage assertion)
- `packages/web/src/lib/audio/cv-scale-registry.test.ts` (CV intrinsic vs. AudioParam)

## Tone in PRs and commits

Match the existing repo style — conventional commits (`feat(scope): …`,
`fix(scope): …`, `chore(scope): …`, `ci(scope): …`). Keep PR titles under 70
chars; details in the description. Always include the `Co-Authored-By: Claude…`
trailer when you create a commit on the user's behalf.

## Things that are project-specific quirks worth knowing

- **Modules are eagerly registered at startup.** All ~50+ module imports run
  at module load. See open issue #213 for the lazy-loading investigation.
- **Cables in front of nodes during drag is INTENTIONAL.** Z-order CSS work
  must scope changes to idle state — don't try to put cables behind nodes
  during drag (see `feedback_cable_drag_zorder` in user memory).
- **Sync-layer can silently revert edits** to certain tracked files
  (`Canvas.svelte`, `NodeContextMenu.svelte`, `ModulePalette.svelte`, the
  dashboard files) and create `*" 2".ts`-style junk. Mitigation:
  commit-immediately-after-edit; leave the junk files alone.
