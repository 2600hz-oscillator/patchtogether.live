# VRT golden-image CI flow — proposal (2026-06-29)

> **TRIAGE 2026-08-04 — PIECES A AND B SHIPPED; PIECE C IS THE REMAINDER, AND
> THE TWO OWNER QUESTIONS AT THE BOTTOM ARE STILL UNANSWERED.**
> - **Piece A (gallery from the FAILING run) — DONE.**
>   `scripts/vrt-changeset-gallery.mjs:75-80` implements `--from-results <dir>`,
>   with the doc's exact rationale in its comment ("a code change that SHIFTS a
>   render commits no PNGs, so the git-diff mode finds nothing").
> - **Piece B (slider + onion-skin) — DONE** in the same script.
> - **Piece C — PARTIAL.** The accept loop exists as **`task vrt:commit`**
>   (**#970**, "task vrt:commit accept-button + stale-exemption ratchet"), but the
>   `/vrt-accept` PR-comment trigger was never built — there is no
>   `issue_comment` workflow; `.github/workflows/` has only `vrt-update.yml` and
>   `vrt-changeset-gallery.yml`.
> - The full `vrt` lane is still informational and `vrt-strict` is still the
>   REQUIRED gate, i.e. the "optional later" flip was correctly not taken.
> ⚠ Two things the proposal could not know, both now hard-won rules in CLAUDE.md:
> `--update-snapshots` **cannot** regenerate a passing-but-stale baseline, and a
> single-platform dispatch used to silently skip its own re-validation step
> (fixed 2026-08-03). Read the "vrt:commit" ergonomics here alongside those.

Goal (owner): adopt a golden-images CI flow — **VRT changes FAIL a job → a
results artifact makes it easy to see what changed (A vs B side-by-side + a
slider/onion-skin diff) → a `vrt:commit` job can be run → that commits the new
baselines.** Research prior art, minimum adverse wall-time, propose.

## 2026-08-12 — everything except Piece C was DELETED

Pieces A and B shipped (`scripts/vrt-changeset-gallery.mjs`), so the sections
describing them, the prior-art survey, the wall-time table and the build order
were all describing finished work. Piece C's remainder and the two unanswered
owner questions are what is left.

### Piece C — Make the failure loud + the accept loop one-click
- Keep `vrt-strict` REQUIRED (unchanged — the deterministic gate).
- The PR comment (Piece A) leads with: `⚠️ N VRT baselines changed — review the
  gallery, then accept:` + the gallery link + the accept command.
- Turn `vrt-update.yml` into the discoverable "vrt:commit button": add a small
  `issue_comment`-triggered workflow so a maintainer commenting **`/vrt-accept`**
  on the PR dispatches `vrt-update.yml` for that PR's branch (regen → commit →
  close/reopen to re-fire checks). Opt-in compute only. **This is the one piece
  never built** — there is no `issue_comment` workflow; the CLI equivalent
  `task vrt:commit` shipped in #970. ⚠ "regen both platforms" is void: #1458
  collapsed the platform dimension to ONE baseline set.
- Optional later: flip the full `vrt` lane from informational to a real gate
  ONLY after the composite/animated flake is driven to 0 (separate effort; not
  in this proposal — would reintroduce flake-gating today). **Owner approval
  required for any required-check/ruleset change.**

## Open questions for owner
- OK to keep the full `vrt` lane informational (flake reality) and rely on the
  loud PR comment + gallery, rather than making it a required failing gate now?
- `/vrt-accept` comment-trigger gated to maintainers (write access) — acceptable?
