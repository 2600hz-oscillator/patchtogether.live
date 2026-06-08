# Standards-refactor program — phased roadmap

A phased program to act on the [repo retrospective](./repo-retrospective-2026-06-08.md)
and the [adversarial-review adoption plan](./adversarial-review-adoption.md). **One
PR at a time** — small, independently green, conflict-sweep-friendly. Each phase
lands before the next starts.

The phases combine the two analyses: foundational workstreams **FW1-FW3** and waves
0-4 come from the adversarial-review adoption plan; the docs-truth + codified-rules
work comes from the retrospective.

---

## Phase 1 — Docs-truth PR (THIS PR)

Docs + CLAUDE.md + skills + plan files only. **No product-code/behavior change.**

- Fix the stale/dangerous skills: module-development / coding-conventions /
  architecture (kill the dead 6-file registry model → glob+palette, PR #551),
  debugging (remove shell-wedging `gh run view --log-failed`/`--log`),
  pr-workflow (required check = `vrt-strict (visual regression — strict subset)`;
  strict-up-to-date is OFF; never `gh pr update-branch`), deploy-pipeline (prod also
  auto-deploys on push+version-bump).
- Fix CLAUDE.md's Post-merge conflict-sweep file list to the post-#551
  hand-maintained surface.
- Codify the memory-only rules into CLAUDE.md: R1 final-commit green / red-main-push
  = P0; R2 poly/MIDI real source→module→audible-RMS e2e; R3 capability-probe +
  CI-green + >2 min wall-time flag (folded into the local-testing standard).
- Save the two analyses + this roadmap to `.myrobots/plans/`.

---

## Phase 2 — Wave-0 quick wins (independent S, low risk)

- **2a — FW1 relay persistence guard + /health + /metrics persist_mode.**
  `server/db.ts` `persistenceMode()` getter; `index.ts` `NODE_ENV==='production' &&
  USE_MEMORY → error + process.exit(1)` (with `ALLOW_MEMORY_STORE=1` escape hatch);
  `persist:'postgres'|'memory'` on `/health`; `persist_mode` on `MetricsSnapshot` +
  `snapshot()`.
- **2b — web db.ts throw-on-missing-DATABASE_URL.** `connectionString()`: return
  DATABASE_URL if set; else if a non-production marker return localhost; else throw a
  NAMED error (at call time, never module top-level). Stay `neon()` HTTP. Add
  `db:'configured'|'missing'` to `/api/health`. First resolve `import.meta.env.DEV`
  vs NODE_ENV reliability on the Workers runtime.
- **2c — ops hygiene.** `utf8ByteLength` (TextEncoder) byte caps at both sites +
  fix the actualKB message; `crypto.randomUUID()` saved-group IDs (keep sg_ prefix,
  no retry loop); relay tagged uncaught-exception structured-log + counters (do NOT
  crash); fix stale comments (r/[id]:101 auth-is-verified; wrangler.toml Neon-HTTP
  not pg-over-TCP).
- **2d — engine singleton exact-lookup.** Replace the node-ID-prefix `startsWith`
  heuristic with an exact count over `this.nodeTypes`; keep the lex tie-break
  eviction; add the missing engine.test.ts coverage.
- **2e — clearPatch one-line LOCAL_ORIGIN.** Add `, LOCAL_ORIGIN` to the clearPatch
  transact so one Cmd-Z restores everything; e2e: spawn 2 nodes + edge, Clear,
  Cmd-Z, assert all back.

(Also from Wave 0: the `LOAD_ORIGIN` deliberate-non-tracked tag at persistence.ts:493
+ test — ship alongside 2e or 2c.)

---

## Phase 3 — Foundational seams (the shared primitives)

- **3a — FW2 `mutate.ts`.** `mutateNode(nodeId, fn, {origin=LOCAL_ORIGIN})` +
  `setNodeParam(nodeId, paramId, value, {origin=LOCAL_ORIGIN})`. Re-read
  `patch.nodes[nodeId]` INSIDE the transaction and mutate IN PLACE (never reassign an
  integrated Y type). store.test.ts coverage with a real syncedStore.
- **3b — FW3 `validate-edge.ts` / `validateGraphFragment`.** Pure, framework-free, at
  the model layer. `validateEdge` checks endpoints exist, direction (out→in), ports
  resolve, `canConnect`, group exposed-ports via `resolveExposedPort`.
  `validateGraphFragment` → `{validEdges, droppedEdges, droppedNodes}`. Unit-test all
  branches.
- **3c — `graph/cap.ts`.** Extract the 4 duplicated count loops into
  `instanceCount(nodes,type)` + `wouldExceedCap(nodes,def)`, called by all spawn paths
  AND the cleanup pass so all layers compute identically.

---

## Phase 4 — Dependents (built on the seams)

- **4a — canConnect-at-commit + isValidConnection.** Wire `validateEdge` into
  `handleConnect` after computing types (silent trace+return, do NOT throw); add
  `isValidConnection` to the SvelteFlow element reusing `canConnect` to reject the
  drag visually pre-commit.
- **4b — sequencer LOCAL_ORIGIN undo.** Thread LOCAL_ORIGIN through the existing
  sequencer transact (or route via mutateNode); real-Y.Doc unit test: toggleGate then
  undo restores prior steps.
- **4c — singleton deterministic post-merge cleanup pass** (type-level `maxInstances`
  ONLY). In a Canvas snapshot $effect (NOT the reconciler); elected peer (lowest
  awareness clientID, owner-preferred) issues the delete; re-check inside transact;
  winners = lex-smallest `cap` ids; cascade-delete edges touching the loser. EXCLUDE
  picturebox/samsloop/camera per-user logic. real-Y.Doc two-doc tests +
  DATABASE_URL-gated @collab e2e. Registry-driven test: any module with
  `maxInstances:1 && undeletable:true` is covered.
- **4d — import/saved-group drop-invalid-edges + reconciler try/catch-per-addEdge.**
  Run `validateEdge` on each migrated edge in `loadEnvelopeIntoStore` (push a
  LoadDiagnostic + continue); same filter in `resurrectSavedGroup` (+ drop
  unregistered-type children); tighten saved-groups POST `validatePayload` to
  STRUCTURAL only. Wrap each `engine.addEdge` in reconciler in try/catch that
  logs+continues; reconciler unit test (one broken edge → all valid items still
  apply).

---

## Phase 5 — Migrations

- **5a — 141-file param→setNodeParam** (batched in module groups; rebase promptly —
  touches 141 files). Cards writing `node.data` go through `mutateNode`. Per-module-
  per-port + behavioral sweeps catch regressions; add a param-undo e2e on a
  representative card.
- **5b — source-scan guard test (AFTER 5a).** `mutate.guard.test.ts` source-globs
  module files, failing on raw `.params[..]=` or bare `ydoc.transact(` without
  LOCAL_ORIGIN outside sanctioned helpers (file:line message; optional
  `// guard:allow-raw-write` opt-out). MUST land AFTER 5a or it red-walls CI.

---

## Phase 6 — CI / test hardening

- **6a — toybox/video shard isolation + capture-count timeouts.** Pull
  WebGL/toybox-graph-interaction specs into the serialized e2e-video lane; scale
  per-spec timeout by input/capture count not a flat value; cap e2e-video wall-time so
  a hang fails fast; keep informational until 3× green on CI.
- **6b — @collab stabilize → required-or-document (#42).** Root-cause the
  relay-contention/in-card-title timeout; verify it ran with DATABASE_URL; then add it
  as a 3rd required context OR record in CLAUDE.md why it can't be.
- **6c — VRT glyph-flake settle loop + auto-classify.** Finish the height-stability/
  font settle loop (#598 was incomplete); auto-classify "N≈all cards failed = flake →
  re-run/regen via vrt-update" vs "1-2 own cards = expected, regen in-PR".
- **6d — migration ledger + task db:migrate + fix CI to apply all SQL + 002 DROP
  cleanup.** schema_migrations ledger + scripts/db-migrate.sh + `task db:migrate`
  (Node, not Workers; idempotent + ordered in a txn); fix CI workflows to apply ALL
  schema files; runbook in db/README.md; delete the 002 DROP line once tiers
  converged. Do NOT wire into deploy.yml hot path.

---

## Phase 7 — Deferred / gated

- **Canvas.svelte staged extraction** (DEPRIORITIZED). Incremental, test-anchored,
  lowest-risk-first, each its own green PR: pure-helpers → persistence → examples →
  grouping → engine/connection. Native port re-implements the UI ground-up, so this
  is hygiene not strategy — schedule behind the stability/observability waves.
- **Identity-keyed capacity refcount** — GATE on a real multi-tab-lockout report;
  decide the canonical participant key shared with DOOM host-election / Carl-Mike
  leader-election first. If built, anon MUST stay socket-keyed.

---

## PUSH-BACKS — already decided, do NOT build

- Do **NOT** make import/load undoable (use a deliberate `LOAD_ORIGIN` tag instead).
- Do **NOT** crash the relay on `uncaughtException` (alarm on a tagged log + counters
  instead; one process serves every rack).
- Do **NOT** identity-key capacity as the primary gate (collapses anon guests;
  socket-keyed is the safe side).
- Do **NOT** add ESLint (use the source-scanning vitest guard idiom).
- Do **NOT** owner-gate imports / saved-group inserts (breaks the anon-collaborator
  model; rely on the per-rackspace 4-cap + connection auth).
- Do **NOT** add a new write-time singleton enforcement layer (already exists +
  powerless against the cross-peer race; the cleanup pass handles it).
