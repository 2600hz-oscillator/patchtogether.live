# Renderer failures that can look successful

## DOOM timing is game state

`video/modules/doom.ts` advances one game tic from `surface.draw`. A rendered
frame is therefore a game tic. Replacing a DOOM millisecond wait with a frame
wait changes how far the marine moves; do not touch it without owner approval.

## Smaller rendering can delete the subject

Lowering an iterated renderer from its normal framebuffer to 384×288 or 512×384
was tried twice as a speedup for geometry tests. It failed because resolvable
depth depends on pixel width: deeper bands physically fall below one pixel.
Lower resolution is valid only when the assertion is independent of spatial
detail.

## Snapshot acceptance can hide a wrong picture

- Playwright `=changed` cannot rewrite a baseline whose comparison passes,
  even when the baseline is stale. The repository uses explicit `=all`, which
  writes byte-different output without consulting the tolerance.
- The current zero tolerance plus narrow explicit scope is the safety argument.
  Do not weaken either, and do not rely on a bare flag's version-dependent
  default.
- A broken black/frozen render can be captured and then pass forever. Inspect
  semantic content before acceptance; baseline equality is not correctness.
- A nondeterministic scene must be pinned or removed from deterministic VRT, not
  repeatedly rebased.

## Scope can silently become a shell command

go-task expands some CLI arguments unquoted. An alternation such as
`GREP="a|b"` can become a shell pipe and silently change capture scope. Use the
supported single-literal scope path, or prove quoting at the Taskfile boundary
before using shell metacharacters.

## Missing snapshots recreate themselves

A plain VRT run writes an absent snapshot as an untracked PNG while still
failing the test. After any run in a deleted/missing-baseline window, inspect
`git status` so an accidental recreation cannot enter a commit.
