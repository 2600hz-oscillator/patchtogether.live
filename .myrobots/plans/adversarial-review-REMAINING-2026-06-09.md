# Adversarial-review adoption — REMAINING work (SHELVED 2026-06-09)

> **TRIAGE 2026-08-04 — re-verified against the tree.** Phases 1–5 are still
> correct as DONE. **Phase 6 is still entirely un-started** and this doc remains
> live backlog: `@collab` is still informational (`ci.yml` — "the per-PR
> multi-context lane stays informational here"), there is still no
> `task db:migrate` and no `schema_migrations` ledger anywhere in `db/` or
> `scripts/`, and `retries: process.env.CI ? 1 : 0` is unchanged
> (`e2e/playwright.config.ts:130` — re-verified 2026-08-12, only the line number
> moved). **Half of 6d HAS since landed — see the ✅ on that item.**
> **One item below is now FALSE and would mislead an executor — see the ⚠ on 6a.**
> The two "in-flight at shelve time" PRs both landed: **#722** (Fix E Phase 1)
> and **#723** (Phase 5 finish + guard).
> Overlaps `standards-refactor-roadmap.md` Phases 6–7 — the two say the same
> thing; treat that file as the canonical roadmap and this as the one-page pickup.

Shelved for the week at a stable point (low on tokens). This is the single-page
pickup. Full detail: `standards-refactor-roadmap.md` + `adversarial-review-adoption.md`.

## ✅ DONE (on main)
- **P0 — DB fail-open guard**: `packages/server/src/db.ts` `shouldFailFast()`/`persistenceMode()` (+ `db.test.ts`); prod exits on USE_MEMORY unless `ALLOW_MEMORY_STORE`. Cornerstone — done.
- **Phase 1** — docs-truth + codified rules (R1 final-commit-green etc.) (#703).
- **Phase 2** — Wave-0 quick wins 2a–2e.
- **Phase 3** — foundational seams: `graph/mutate.ts` (setNodeParam/mutateNode/LOCAL_ORIGIN), `graph/validate-edge.ts`, `graph/cap.ts` + FW1 persistence health signal.
- **Phase 4** — P1 canConnect-at-commit + isValidConnection, P2 import/fragment validation, P2 singleton cleanup, P1 undo origin-tagging.
- **Phase 5** — **5a** 158-file param-write → setNodeParam/mutateNode migration (#721, merged). **5b** source-scan guard `packages/web/src/lib/graph/mutate.guard.test.ts` + last 3 sites (#723 — **merging on green**; guard verified green locally, 0 raw writes).

## ⬜ REMAINING (the shelf)
### Phase 6 — CI / test hardening (NOT started; the real remaining build)
- **6b — @collab → required** *(the priority one; hardest)*. Root-cause relay-contention/in-card-title timeout, verify it runs with DATABASE_URL (not vacuous), then make it a 3rd REQUIRED context (or document why not). Ties to task #42 + memories `feedback_collab_tests_vacuous_without_db`, `feedback_never_merge_on_red_collab_is_doom_gate`.
- **6a — video/toybox CI shard isolation + capture-count timeouts**. ⚠ **The premise of this item is now FALSE.** It says "heavy WebGL specs → serialized e2e-video lane (already partly via WEBGL_HEAVY_GLOBS)". **That lane was DELETED on 2026-06-20 (#839)**, so `WEBGL_HEAVY_GLOBS` no longer *relocates* a spec — it **deletes its PR coverage outright** (`e2e/webgl-heavy-globs.ts` now carries that warning in a banner). Anyone executing 6a as written would silently remove coverage. Re-scope it to what is actually left: scale per-spec timeout by input/capture count (done for the per-port sweep in **#1327**, which found the "flat constant wearing a scaled costume"), and decide whether a serialized heavy lane should be *resurrected* rather than assumed to exist.
- **6c — VRT glyph-flake settle loop + auto-classify**. Finish the height-stability/font settle loop (#598 incomplete); auto-classify "N≈all cards failed = flake → regen via vrt-update" vs "1–2 own cards = expected, regen in-PR". Known fix in memory `vrt-flake-1px-layout-rounding`.
- **6d — migration ledger + `task db:migrate`**. ✅ **"CI applies ALL sql" is DONE** — `scripts/apply-db-schema.sh` reads the DIRECTORY (not a hand-copied list at 14 sites) with `ON_ERROR_STOP=1`, and `scripts/ci-db-schema.test.ts` asserts every caller targets a localhost `*_test` DB. Its header records what the old lists cost: `002`/`003`/`004` were in NO list, so the whole journal/replay durability feature was exercised by **zero** CI runs while every `@collab` test passed, because `journal.ts` degrades silently on 42P01. ⬜ **Still unbuilt:** the `schema_migrations` ledger, `scripts/db-migrate.sh` + `task db:migrate` (Node, idempotent, txn-ordered), the runbook in `db/README.md`, and dropping the 002 DROP line once tiers converge. **Do NOT wire into deploy.yml hot path.**

### Phase 7 — deferred / gated (do NOT build speculatively)
- **Canvas.svelte staged extraction** — DEPRIORITIZED (native macOS port re-implements the UI ground-up; this is hygiene not strategy).
- **Identity-keyed capacity refcount** — GATED on a real multi-tab-lockout *report*. Anon token is `anon:<HMAC(rackId)>` (byte-identical per rack) → identity-keying would collapse all anon guests; **anon MUST stay socket-keyed**.

### Loose ends (small)
- **reconciler addEdge try/catch** (DEFER item) — wrap each `engine.addEdge` in `reconciler.ts` (~149/158) in try/catch that logs+continues so one bad edge can't abort the whole pass. Verify whether already wrapped before building.
- **capacity UI honesty** (ADOPT-NOW small) — show distinct-user dots AND "X/4 connections" when they differ (server slot count). Not yet built.
- **5a.2** — broader `node.data`-settings migration (~40 cards: sticky text, layout geometry, sequencer grids) — many are drag-stream/already-transacted; deferred from 5a.
- **5b.2** — `ydoc.transact(`-origin guard (the ~20 legit bare transacts in persistence/bot/session/electra/livecode need per-site classification first; the 5b guard currently covers only `.params[..]=`).

### PUSH-BACKS (decided — do NOT build)
undoable import (use LOAD_ORIGIN) · crash relay on uncaughtException (alarm+counters instead) · identity-keyed capacity as primary gate · ESLint (use source-scan vitest guards) · owner-gated imports/saved-groups · new write-time singleton enforcement layer.

## In-flight at shelve time (NOT adversarial — separate tracks) — BOTH LANDED
- ~~**#722 — Fix E Phase 1**~~ **MERGED.** `renderLocus:'worker'` is live on `acidwarp.ts:135`; toybox + vfpga-runner sit on `'worker-experimental'`. The successor plan (what is still un-built: the per-frame input-`ImageBitmap` transfer that backdraft needs) is `fixe-video-offload-shoes1-2026-07-01.md` — the `fixe-offscreen-canvas-plan-2026-06-09.md` named here no longer exists.
- ~~**#723 — Phase 5 finish + guard**~~ **MERGED.** The guard has since been widened — its `RAW_PARAM_WRITE` regex was bracket-only and blind to 96 dotted writes (see CLAUDE.md "A GUARD FOR THAT CLASS THAT IS OPT-IN").
