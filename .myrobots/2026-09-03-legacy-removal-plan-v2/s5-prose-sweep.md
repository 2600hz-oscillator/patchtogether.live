# S5 — the archaeology sweep, and three things to read BEFORE you edit

**Status:** ⚠ EVIDENCE, NOT INSTRUCTION (`.myrobots/` per AGENTS.md). IN PROGRESS.

---

## ⚠ READ THIS BEFORE YOU PREDICT WHETHER A CHANGE MOVES THE WEBGL ATTEST HASH

> **The normalizer strips `docs`, `controlFamilies`, `face` and `noUserControl`
> — and nothing else. So "it's only a doc change" is a claim about the FIELD,
> not about the FILE.**

Predict hash movement from that field list, never from intent. This programme got
it wrong TWICE, in opposite directions, and both failures had the same shape —
reasoning from what the change was *about* instead of from what the normalizer
keeps:

| prediction | reality |
|---|---|
| "S4 will move the hash — the basis includes each `rendersWebGL` module's CARD SOURCE" | It did NOT. `webgl-attest-hash.sh --list` is 220 files with ZERO `*Card.svelte`; `cube`/`wavesculpt` enter through their extracted `*VizSurface.svelte`. |
| "S5 will not move it — comments and `docs` props are hash-transparent" | It DID. The prose was transparent (`contract-lock.txt` re-pinned byte-identical), but the same commit retired the `card:` DEF FIELD, six declarations of which are in `lib/video/modules/` — 96 of the 220 basis files. `aacfac95…` → `9af32fc1…`. |

A commit that edits prose AND a field is not a prose commit. **Always re-check
with `flox activate -- task webgl:attest:check`** rather than trusting any hash
written down — including the ones in these notes.

Practical: the attest is ONE spend and must be taken at the END, after the last
basis-touching commit.

---

## ⚠ BEFORE YOU RUN YOUR OWN BULK PROSE EDIT: THE SINGLE-QUOTE TRAP

Inserting `faceplate's` into a **single-quoted** string literal terminates it.
One careless pass produced **1,722 errors across 5 files** — and the failure is
loud, so it is cheap; what is expensive is the naive fix. A line-shape heuristic
("does this line start with `'`?") misses `freezeTable: '…'` and every other
`key: '…'` form.

The correct fix walks BACK from each occurrence to the nearest UNESCAPED quote —
that character is the literal's real opening delimiter — and escapes only when it
is `'`. 119 apostrophes needed escaping; a line-shape guess found 14 of them.

---

## ⚠ SEVEN "card" STRINGS ARE KEPT ON PURPOSE — THEY NAME OTHER PEOPLE'S HARDWARE

This is the distinction a future blanket sweep will get wrong, and seven
corrupted user-facing strings is what it costs. None of these is our UI:

| module | string | what it actually names |
|---|---|---|
| `sixstrum` ×5 | "On the classic card that recall is the MODE knob", "The classic card's ⟋ STRUM button", "the classic card's MODE presets park it at 2.5 / 6 / 9 s" | the ORIGINAL HARDWARE instrument this module ports |
| `chromaconsole` | "the Push 2 card can drive" | Ableton Push 2 |
| `es9` | "If the ES-9 card also shows rising xruns" | the Expert Sleepers ES-9 audio interface |

A rule matching `the card` / `card's` / `on the card` does not hit any of them,
because every one carries a qualifier between the article and the noun
(`classic`, `Push 2`, `ES-9`). That is luck, not design — a sweep that matches a
bare `card` WILL hit all seven. Guard on the qualifier, and read every hit in a
module whose subject is a piece of real hardware.

---

## What the sweep changed

**312 rewrites across ~75 module defs + `module-manifest.ts`.** ZERO
`?shell=legacy` or "legacy card" references remain in any user-facing string.

Shape of the edit, in descending volume: `the card's` → `the faceplate's` (54),
`on-card` → `on-faceplate` / `the faceplate's` (105 across two forms),
`on the card` → `on the faceplate` (43), `no card row/knob/control` → `no
faceplate …` (52), plus ~35 read-individually rewrites where a whole clause had
to go rather than a noun (`archivist`, `peertube`, `mappy`, `tv-librarian`,
`ruttetra` ×5, `milkdrop`, `cube`, `cv-buddy`, `loopback`, `mandleblot`,
`vfpga-runner`, `backdraft`, and seven manifest entries).

Deleted rather than reworded, because rewording keeps the monument: every "the
legacy card also does X" / "under `?shell=legacy` it is Y" sentence.

## `def.card` was fully orphaned

34 declarations across module defs, 5 `card?: string` type fields, and **zero
readers** — it was the deleted card map's explicit-basename override. Removed
with the two tests that asserted it (`control-surface.test.ts`,
`electra-control.test.ts`). This is the field whose removal moved the attest hash.

## HELD DELIBERATELY — `packages/web/src/lib/video/modules/camera-input.ts`

8 prose hits, untouched. A P0 on `main` is actively rewriting `cameraInput` (the
face lost its source picker; separately the dock rail was still mounting the
verbatim card because `dockRailRendersFace` required `pinned` while Canvas passed
`pinned: false` — the half this branch's S4a closes). Editing its prose now would
conflict in a file being rewritten underneath. It is done AFTER that fold, on the
post-fix text, on the coordinator's signal.

## Remaining in S5

* `ModuleShellPlaceholder.svelte` — unreachable since S4a; CSS + model consumers.
* The 29 re-pointed VRT scenes' baselines — one scoped `task vrt:commit`.
* `camera-input.ts`'s 8 hits, after the fold.
* THEN the attest, on whatever `task webgl:attest:check` reports at that point.
