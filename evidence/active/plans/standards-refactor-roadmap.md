# Standards-refactor program — what is LEFT

A phased program acting on the June 2026 repo retrospective + adversarial-review
adoption plan. **One PR at a time** — small, independently green,
conflict-sweep-friendly.

> **TRIAGE 2026-08-12 — Phases 1–5 are DONE and their sections are deleted.**
> Phase 1 shipped as **#703**; Phases 2–5 are all on main (`graph/mutate.ts`,
> `graph/validate-edge.ts`, `graph/cap.ts`, the 158-file param-write migration
> **#721**, and its source-scan guard `mutate.guard.test.ts` **#723**).
> ⚠ Both source analyses (`repo-retrospective-2026-06-08.md`,
> `adversarial-review-adoption.md`) were removed in the 117→40 corpus triage
> (**#1175**). The surviving one-page pickup is
> `adversarial-review-REMAINING-2026-06-09.md`, which duplicates Phases 6–7;
> **this file is the canonical roadmap of the two.**

---

## Phase 6 — CI / test hardening (the real remaining build)

- **6b — `@collab` stabilize → required-or-document (#42)** *(the priority one;
  hardest)*. Root-cause the relay-contention / in-card-title timeout, verify it
  ran with `DATABASE_URL` (not vacuous), then add `collab` to the `ci` umbrella's
  `needs:` + failing `if` — or record in CLAUDE.md why it can't be. Re-verified
  2026-08-12: the dedicated `collab` job exists but is **not** in
  `ci.yml:2268`'s `needs:` list.
- **6d — migration ledger + `task db:migrate` + CI applies ALL sql.**
  `schema_migrations` ledger + `scripts/db-migrate.sh` + `task db:migrate` (Node,
  not Workers; idempotent + ordered in a txn); fix CI workflows to apply ALL
  schema files (prevents prod/autotest drift); runbook in `db/README.md`; delete
  the 002 DROP line once tiers converged. **Do NOT wire into the deploy.yml hot
  path.** Re-verified 2026-08-12: no `schema_migrations`, no `db:migrate`, no
  `db-migrate.sh` anywhere.

### Phase-6 items that are now DONE or whose premise MOVED
- **6a — video/toybox shard isolation.** ⚠ **The premise is FALSE.** It says
  "pull heavy WebGL specs into the serialized `e2e-video` lane" — **that lane was
  DELETED 2026-06-20 (#839)**, so `WEBGL_HEAVY_GLOBS` no longer *relocates* a
  spec, it **deletes its PR coverage outright** (banner in
  `e2e/webgl-heavy-globs.ts`). Executing 6a as written would silently remove
  coverage. What is actually left of it: capture-count-scaled per-spec timeouts
  (done for the per-port sweep in **#1327**, which found "a flat constant wearing
  a scaled costume"), and a decision on whether a serialized heavy lane should be
  *resurrected* rather than assumed to exist.
- **6c — VRT settle loop + auto-classify.** The height-stability settle loop is
  built (`e2e/vrt/vrt.spec.ts:153` — requires the rounded height stable for 3
  consecutive frames, replacing the single-rAF settle that could snap inside the
  unsettled post-mount frame). Auto-classification was superseded: the
  `{platform}` collapse (#1458) removed the "N≈all cards failed" flake shape, and
  intentional render changes are now reviewed as a PR diff through the
  `vrt-changeset-gallery` (OLD / NEW / DIFF with a slider).

---

## Phase 7 — Deferred / gated (do NOT build speculatively)

- **Canvas.svelte staged extraction** (DEPRIORITIZED). If ever done: incremental,
  test-anchored, lowest-risk-first, each its own green PR — pure-helpers →
  persistence → examples → grouping → engine/connection. A native port
  re-implements the UI ground-up, so this is hygiene, not strategy; schedule it
  behind the stability/observability waves.
- **Identity-keyed capacity refcount** — GATE on a real multi-tab-lockout
  *report*. Decide the canonical participant key shared with DOOM host-election /
  Carl-Mike leader-election first. The anon token is `anon:<HMAC(rackId)>`
  (byte-identical per rack), so identity-keying would collapse all anon guests:
  **if built, anon MUST stay socket-keyed.**

---

## Loose ends (small)

- **reconciler `addEdge` try/catch** — wrap each `engine.addEdge` in
  `reconciler.ts` in a try/catch that logs+continues so one bad edge can't abort
  the whole pass. **Verify whether already wrapped before building.**
- **Capacity UI honesty** — show distinct-user dots AND "X/4 connections" when
  they differ (the server slot count). Not yet built.

---

## PUSH-BACKS — already decided, do NOT build

- Do **NOT** make import/load undoable (use a deliberate `LOAD_ORIGIN` tag).
- Do **NOT** crash the relay on `uncaughtException` (alarm on a tagged log +
  counters instead; one process serves every rack).
- Do **NOT** identity-key capacity as the primary gate (collapses anon guests;
  socket-keyed is the safe side).
- Do **NOT** add ESLint (use the source-scanning vitest guard idiom).
- Do **NOT** owner-gate imports / saved-group inserts (breaks the
  anon-collaborator model; rely on the per-rackspace 4-cap + connection auth).
- Do **NOT** add a new write-time singleton enforcement layer (one already exists
  and is powerless against the cross-peer race; the cleanup pass handles it).
