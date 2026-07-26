# Adversarial-review adoption — REMAINING work (SHELVED 2026-06-09)

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
- **6a — video/toybox CI shard isolation + capture-count timeouts**. Heavy WebGL specs → serialized e2e-video lane (already partly via WEBGL_HEAVY_GLOBS in `e2e/playwright.config.ts`); scale per-spec timeout by input/capture count (the `touchesVideo()` 90s floor in `per-module-per-port.spec.ts` is a start); cap e2e-video wall-time so a hang fails fast.
- **6c — VRT glyph-flake settle loop + auto-classify**. Finish the height-stability/font settle loop (#598 incomplete); auto-classify "N≈all cards failed = flake → regen via vrt-update" vs "1–2 own cards = expected, regen in-PR". Known fix in memory `vrt-flake-1px-layout-rounding`.
- **6d — migration ledger + `task db:migrate` + CI applies ALL sql**. schema_migrations ledger + `scripts/db-migrate.sh` + `task db:migrate` (Node, idempotent, txn-ordered); fix CI to apply ALL schema files (prevents prod/autotest drift); runbook in db/README.md; drop the 002 DROP line once tiers converge. **Do NOT wire into deploy.yml hot path.**

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

## In-flight at shelve time (NOT adversarial — separate tracks)
- **#722 — Fix E Phase 1** (video render worker, flag-gated OFF). **Awaiting owner review** on preview: open `<preview>?videoworker=1`, add an ACIDWARP module, confirm parity. Review-before-merge (render change). Phase 2 (heavy modules b3ntb0x/mandelbulb/toybox-shadertoy) is gated on #722 merging. Plan: `fixe-offscreen-canvas-plan-2026-06-09.md`.
- **#723 — Phase 5 finish + guard** — merging on green.
