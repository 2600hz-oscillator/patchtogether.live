# Adversarial code-review — adoption plan

Source: 7-agent workflow that digested an external adversarial code review,
verified every load-bearing claim against HEAD `03ffc601`, decided adopt/push-back
per item, and produced an implementation plan (no work done in the workflow).

## Executive summary

Every load-bearing claim across all five clusters was verified against HEAD
`03ffc601`. The review is **unusually accurate** — almost all line refs are exact
and all core diagnoses hold. Confirmed:

- `server/db.ts` fail-open (`USE_MEMORY` at :32; `isRackspaceMember`/`rackspaceExists`
  return `true` at :92/:106)
- `web/db.ts` localhost fallback (:29)
- `002_feedback.sql` `DROP … CASCADE` (:21) vs README append-only (:8)
- 141 raw `.params[..]=` card writes (matches review exactly)
- originless transacts in SequencerCard / clearPatch / persistence-load
- `handleConnect` never calls `canConnect` (Canvas.svelte:1406)
- `engine.addEdge` throws on missing port → reconciler swallows it (reconciler.ts:53)
- capacity keyed by socketId
- anon token byte-identical per rack (auth.ts:70)
- engine `nodeTypes` Map already exists (engine.ts:138), making the heuristic at
  :228 replaceable
- `Math.random` saved-group IDs; `.length`-vs-bytes caps; `uncaughtException` stay-up;
  both stale comments

**Two refinements for the owner:**

1. The migration finding is **understated** — CI applies ONLY `001_init.sql` across
   8+ workflows; `002`/`003` are NEVER applied in CI, and `deploy.yml` applies zero
   SQL. So even the test DBs lack feedback/saved_groups tables unless a human ran
   psql.
2. `MetricsSnapshot` (http-introspection.ts:38) already has `boot_id` +
   `persist_writes_per_min` but NO persistence-mode field, so the P0 plan's
   `/metrics` addition is the right gap to fill.

**Highest-leverage insight:** three clusters (undo, edge-validation, singleton-caps)
all converge on "one deterministic graph path," but they are NOT one mega-API —
they are **TWO distinct foundational seams** built separately: (A) a write-time
origin-tagging mutator (`mutate.ts`) for undo integrity, and (B) a pure
framework-free `validate-edge.ts` / `validateGraphFragment` validator at the model
layer. Both port for free to the native macOS app (which reuses the TS core).

**Recommendation:** start with the four S-effort independent wins (relay persistence
guard+health, web db throw, ops hygiene PR, engine exact-lookup) before the two
foundational seams; Canvas XL split deprioritized given the native port
re-implements the UI.

**PUSH BACKS:** making import/load undoable, crashing the relay on
uncaughtException, identity-keyed slots as the primary capacity gate, write-time
enforcement as a fix for the cross-peer singleton race, the ESLint guard mechanism,
owner-only import gating.

## Foundational workstreams

### FW1: Persistence-mode health signal (relay + web) — effort M

Three persistence/deploy findings share ONE missing substrate: no first-class "is
persistence correctly wired" signal on either tier. Today a prod relay that lost
`DATABASE_URL` silently serves a non-persistent rack (and lets any authed user join
any rack via the un-NODE_ENV-gated `isRackspaceMember` bypass at db.ts:92); a Worker
with no `DATABASE_URL` falls back to localhost and CF-1003s opaquely. `MetricsSnapshot`
has `boot_id` + `persist_writes_per_min` but NO persistence-mode field; `/health`
returns `{ok:true,boot_id}`; web `/api/health` already reports Clerk/INVITE_SECRET
presence-only and is the natural home for a db field.

- **Unlocks:** makes the relay-drift/OOM class self-alerting; live-smoke can assert
  `/health.persistence==='postgres'` and `/api/health.db==='configured'` so a
  misconfigured/drifted deploy goes RED instead of silently degrading.
- **Plan:** Relay — export `persistenceMode():'postgres'|'memory'` from `server/db.ts`.
  In `index.ts` before `Server.listen()` (line 189):
  `if (NODE_ENV==='production' && USE_MEMORY) { error + process.exit(1) }` — gated on
  `NODE_ENV==='production'` ONLY (all three fly.tomls set it; local/test leave it
  unset so the @collab in-memory path is untouched). Honor an explicit
  `ALLOW_MEMORY_STORE=1` escape hatch. Add `persist:'postgres'|'memory'` to the
  `/health` JSON branch and a `persist_mode` field to `MetricsSnapshot` + its
  `snapshot()` builder (~:153-171), passing the mode into
  `createIntrospectionExtension`. Web — add
  `db: privateEnv.DATABASE_URL ? 'configured':'missing'` to `GET /api/health`. Tests:
  db.test.ts production+no-DATABASE_URL exits non-zero / dev does not;
  http-introspection.test.ts asserts `/health` and `/metrics` carry the field.

### FW2: Graph mutation API (mutate.ts) — origin-tagged write chokepoint — effort M

`store.ts:70 trackedOrigins=Set([LOCAL_ORIGIN])` means any write NOT passing
`LOCAL_ORIGIN` bypasses undo (verified against yjs.cjs:3667 + store.test.ts:48-54).
141 of 168 card files do raw `t.params[k]=v` (no transact/origin → Yjs auto-wraps
origin=null → non-undoable). Three partial helpers already implement the pattern
(control-surface.ts `mutateSurface`, control-surface-params.ts, electra/host.ts
`writeParam`) — **promote/consolidate, don't invent a mega-API**.

- **Unlocks:** every per-card knob/fader/wheel undo fix, the sequencer data-write
  fix, and the clearPatch fix route through it. Establishes the
  LOCAL_ORIGIN-vs-deliberate-non-tracked-origin convention the import/load row
  adopts. Ports to native (the seam is the model-layer mutation contract).
- **Plan:** add `packages/web/src/lib/graph/mutate.ts`:
  `mutateNode(nodeId, fn, {origin=LOCAL_ORIGIN})` and
  `setNodeParam(nodeId, paramId, value, {origin=LOCAL_ORIGIN})`. Generalize the
  `mutateSurface` shape:
  `ydoc.transact(() => { const live = patch.nodes[nodeId]; if (!live) return; fn(live); }, origin)`.
  MUST re-read `patch.nodes[nodeId]` INSIDE the transaction and mutate IN PLACE
  (never reassign an integrated Y type — the yjs-save-load-real-ydoc trap). Tests:
  store.test.ts param-write-through-setNodeParam asserts `undoStack.length===1` +
  undo restores old value, using a real syncedStore not mocks.

### FW3: Pure edge/graph validator (validate-edge.ts + validateGraphFragment) — effort M

Three edge-write paths (`handleConnect` drag, `loadEnvelopeIntoStore` import,
`resurrectSavedGroup`) feed the SAME reconciler whose `addEdge` THROWS on a missing
port (engine.ts), and the throw is swallowed in enqueue's `.catch` (reconciler.ts:53)
— so ONE malformed edge silently aborts the ENTIRE reconcile pass (all nodes/edges/
params ordered after it), and in multiuser it syncs to all peers. `handleConnect`
computes sourceType/targetType but never calls `canConnect` (types.ts:96) and never
checks port direction; no `isValidConnection` prop on SvelteFlow. Import + saved-group
are the untrusted-input vectors an anon invite-link collaborator can trigger into the
shared doc.

- **Unlocks:** P1 (drag commit-time guard + isValidConnection UX) and P2 (drop invalid
  edges on import + resurrect) both consume it. Framework-free at the model layer so
  it ports to native behind the PatchSnapshot seam.
- **Plan:** add `packages/web/src/lib/graph/validate-edge.ts`:
  `validateEdge(edge, nodes, resolveDef) → {ok, reason}` checking both endpoints
  exist; source port is a declared OUTPUT, target an INPUT (direction); ports resolve;
  `canConnect(srcType, dstType)`; group exposed-ports resolved via
  `resolveExposedPort` first (mirror handleConnect 1424-1425). Then
  `validateGraphFragment({nodes,edges}, resolveDef) → {validEdges, droppedEdges, droppedNodes}`.
  Pass `defLookup` (Canvas.svelte:2579 =
  `getModuleDef ?? getVideoModuleDef ?? getMetaModuleDef`) as the resolver. Do NOT add
  caps (already at insertSavedGroup) or param-range checks (handled by `migrate()`).
  Unit-test all branches.

## Per-finding verdicts

| Finding | Verdict | Effort | Plan summary |
|---------|---------|--------|--------------|
| persistence/P0: Fly relay fails open when DATABASE_URL missing (db.ts:32/92/106/134) | ADOPT-MODIFIED | M | In-memory branch is INTENTIONAL (PR #310, makes @collab e2e run). Don't remove it. Add a `NODE_ENV==='production'` startup guard (index.ts before Server.listen:189) that `process.exit(1)`s when USE_MEMORY, + persist_mode health/metrics fields (FW1). Cornerstone — do first. |
| persistence/ARCH: web db.ts localhost fallback (:29) | ADOPT-MODIFIED | S | Latent not live (all tiers set DATABASE_URL). Must stay `neon()` HTTP (cf-workers-pg-blocker). In `connectionString()`: return DATABASE_URL if set; else if a non-production marker return localhost; else throw a NAMED error. **KEY UNCERTAINTY:** CF Pages does not set NODE_ENV by default — prefer `import.meta.env.DEV` or a deliberate flag; verify which is reliably present on the Workers runtime via /api/health before merging. Throw at CALL time, never module top-level. Add `db:'configured'|'missing'` to /api/health (FW1). |
| persistence/ARCH: migration hygiene — 002 DROP CASCADE vs append-only README; deploy may apply only 001 | ADOPT-MODIFIED | M | CONFIRMED + UNDERSTATED. CI applies ONLY 001 across 8+ workflows; 002/003 NEVER applied; deploy.yml applies zero SQL. Right-size for pre-launch 3-tier beta + native re-home — NOT a Rails-grade auto-migrator. (1) Make 002 honest (delete DROP line if tiers converged, else move to db/oneshots/). (2) Add schema_migrations ledger + scripts/db-migrate.sh + `task db:migrate` (runs from Node, NOT Workers; idempotent+ordered in a txn). (3) Runbook in db/README.md. (4) Fix CI workflows to apply ALL schema files. (5) Do NOT wire into deploy.yml hot path. (6) Optional CI lint banning DROP/TRUNCATE outside oneshots. Urgency rises at launch. |
| undo: trackedOrigins only LOCAL_ORIGIN → non-tagged writes bypass undo; rec ONE mutatePatch + ban raw writes | ADOPT-MODIFIED | M (FW2) + L (141-file) | Real user-visible defect (Cmd-Z after a knob turn does nothing). Build FW2 but scope it: route per-card param + sequencer data writes through LOCAL_ORIGIN; leave structural ops alone; decide load/clear deliberately. "undoable" as a per-call flag is redundant (== origin-is-tracked). Do NOT ban ALL raw writes absolutely. |
| undo: AnalogVcoCard direct param writes bypass undo (:26) | ADOPT | L | NOT VCO-specific: 141 of 168 card files do the same. Fader.svelte calls onchange on every drag delta → null origin. Mechanical swap to `setNodeParam(id,paramId,v)` / `mutateNode` for node.data writers. Codemod feasible but review per-file. Stage in module batches; per-module-per-port + behavioral sweeps catch regressions. Add a param-undo e2e on a representative card. |
| undo: Sequencer originless txns bypass undo (SequencerCard.svelte:130) | ADOPT | S | Thread LOCAL_ORIGIN through the existing transact (one-line, or via mutateNode). Whole-array replace stays. Real-Y.Doc unit test: toggleGate then undo restores prior steps. |
| undo: clearPatch bypasses undo (Canvas.svelte:963) | ADOPT | S | Most damaging: destructive AND irreversible (Clear toolbar, no confirm). Add `, LOCAL_ORIGIN` to the clearPatch transact — single transact collapses to ONE undo entry. e2e: spawn 2 nodes + edge, Clear, assert empty, Cmd-Z, assert all back. |
| undo: import/load bypasses undo (persistence.ts:493) | PUSH-BACK (undoable) / ADOPT (deliberate origin) | S | Do NOT make load undoable (Cmd-Z restoring pre-load junk is MORE surprising than "load is permanent"; most apps don't put Open on the undo stack). Export a deliberate `LOAD_ORIGIN` symbol (NOT in trackedOrigins) and pass it at :493 to document intent. Test asserts a load adds no undo entry. |
| undo: rec an ESLint guard banning raw patch.nodes[...] writes | ADOPT-MODIFIED (intent good, mechanism wrong) | M | Repo has NO ESLint at all. Use the existing guard-test idiom (registry-manifest.test.ts source-scans). Add a source-scanning vitest guard (mutate.guard.test.ts) failing on raw `.params[..]=` or bare `ydoc.transact(` without LOCAL_ORIGIN outside sanctioned helpers, with a file:line message. MUST land LAST (after the 141-file migration) or it red-walls CI. Optional `// guard:allow-raw-write` opt-out. |
| edge/P1: cable creation doesn't enforce canConnect at commit (handleConnect Canvas.svelte:1406) | ADOPT-MODIFIED | M | Reachable by direct UI drag. Build FW3, wire validateEdge into handleConnect after computing types (silent trace+return, do NOT throw). Add isValidConnection to the SvelteFlow element reusing canConnect so the drag is rejected visually pre-commit. Tests: unit validateEdge + e2e driving __handleConnect with an incompatible pairing asserting no edge. |
| edge/P2: imported/saved fragments need deeper validation (persistence.ts:507, saved-groups +server.ts:30) | ADOPT-MODIFIED | L | loadEnvelopeIntoStore drops edges only for missing NODES, writes migrated edges verbatim. saved-groups validatePayload checks arrays + child id/type/domain strings but NOT internalEdges shape/ports/compat or that child.type is registered. insertSavedGroup ALREADY enforces per-type maxInstances caps. Extend FW3 with validateGraphFragment; run validateEdge on each migrated edge, push a LoadDiagnostic + continue (highest-value change — stops a bad import wedging the reconciler for all peers). Same filter in resurrectSavedGroup; drop unregistered-type children. Tighten saved-groups POST to STRUCTURAL internalEdges shape only. PUSH BACK on owner-only gate (breaks anon-collaborator model) and on caps/param-range in the validator. |
| edge/overlap: reconciler swallows addEdge throw → one bad edge aborts the whole pass | DEFER (record severity, ship separately) | S | Separate small follow-up: wrap each engine.addEdge in reconciler.ts:144-151 in try/catch that logs+continues, and/or addEdge no-op-with-warn on missing port. Pair with a reconciler unit test (one broken edge → all valid nodes/edges/params still apply). Belt-and-suspenders with FW3; independently shippable. |
| capacity/P1: caps socket IDs not users; multi-tab burns slots while UI dedups by user.id | ADOPT-MODIFIED (UI honesty) / PUSH-BACK (identity-keyed refcount) | S (UI); refactor deferred | Multi-tab-shows-one-person only holds for Clerk users — anon token is `anon:<HMAC(rackId)>`, BYTE-IDENTICAL per rack, and the per-tab anon id never reaches the server, so identity-keyed slots would COLLAPSE all anon guests to one slot. ADOPT NOW: make the displayed count honest (show distinct-user dots AND a "X/4 connections" when they differ, or emit the server slot count). PUSH BACK on identity-keyed refcount as the primary gate unless multi-tab lockout is actually REPORTED; anon MUST stay socket-keyed. |
| singleton: runtime guard uses node-ID-prefix heuristic (engine.ts:217/228) | ADOPT-MODIFIED | S | Hardening not a live bug (all spawn paths use `${type}-${uuid}`). engine already maintains an exact `nodeTypes` Map (:138, populated :255) — `nodeTypes.get(id)===node.type` is an exact replacement, zero new deps. Replace the startsWith loop; keep the lex tie-break eviction. Add the missing engine.test.ts coverage. Independent S win — do it early. |
| singleton: TIMELORDE auto-spawn race leaves an undeletable orphan (Canvas.svelte:465/478) | ADOPT-MODIFIED | M | Two peers both pass the transact-time recheck, Yjs merges both, engine refuses the 2nd, orphan undeletable (timelorde maxInstances:1 + undeletable:true) = unrecoverable ghost. Write-time enforcement does NOT close it (concurrent writes on different peers can't see each other's un-merged insert). Build a deterministic POST-merge cleanup pass on the converged snapshot in a Canvas snapshot $effect (NOT the reconciler — audio-only, runs on every peer → double-delete). Elect ONE peer (lowest awareness clientID, owner-preferred); re-check inside transact; winners = lex-smallest `cap` ids (matches engine eviction). Cascade-delete edges touching the loser. Tests: real-Y.Doc two-doc sync (exactly one survivor, lex-smallest on both; idempotent; non-elected peer makes ZERO writes); DATABASE_URL-gated @collab e2e. |
| singleton: rec enforce at graph-write time in addition to cleanup pass | PUSH-BACK | S | Write-time enforcement ALREADY EXISTS and is layered across all spawn paths. The gap (check outside transact) is inconsequential single-client and powerless against the cross-peer case. ONLY worthwhile change is DRY: extract the 4 duplicated count loops into one `graph/cap.ts` (`instanceCount`/`wouldExceedCap`), called by all spawn paths AND the cleanup pass. Document that cross-peer concurrency is handled by the cleanup pass, not write-time. |
| singleton: solve generically across all capped modules, not just TIMELORDE | ADOPT-MODIFIED | S | Capped: timelorde/doom/snes9x/skifree/cadillac (1), camera-input(4), picturebox(8), samsloop — but only TIMELORDE is auto-spawn AND undeletable = unrecoverable. Scope the cleanup pass to `def.maxInstances` (type-level) ONLY. EXCLUDE picturebox/samsloop/camera per-user logic. Add a registry-driven test asserting any module with maxInstances:1 AND undeletable:true is covered. |
| singleton: worth building now given the SwiftUI native port? | ADOPT | M total | native MVP direct-ports the TS core (graph/CRDT/singleton/engine all reused); undeletable-ghost reachable with 2 concurrent users in the 4-cap. Proceed: engine exact-lookup (S) + cap.ts helper (S) + deterministic cleanup pass scoped to type-level maxInstances (M). Defer any general mutatePatch guarded-write rewrite. |
| arch: Canvas.svelte monolith (4594 lines, 8+ concerns); rec extract 6 controllers | ADOPT-MODIFIED (incremental, deprioritized) | XL | Do NOT big-bang. Staged, test-anchored, lowest-risk-first, each its own green PR: (1) pure helpers → canvas-graph-helpers.ts. (2) persistence/perf service. (3) example-loaders. (4) grouping commands (~20 fns, highest value). (5) ONLY THEN engine-lifecycle + connection. Leave the e2e dev-hooks block in place. Rack page: separate follow-up. DEPRIORITIZE — native port re-implements the UI ground-up; schedule behind stability/observability. |
| ops: relay stays up after uncaughtException (server/index.ts:43) | PUSH-BACK | S | ONE process serves EVERY rack — a crash nukes all racks, loses ~5s of un-snapshotted edits across all of them, triggers a reconnect storm. Stay-up was the SPECIFIC fix for the tab-switch-500 incident; transient-failure handling already exists (db.ts pool.on('error') + persist swallow). Right answer is ALARMS, not auto-crash. Instead: (1) emit a structured/tagged log (`event=relay_uncaught_exception`); (2) add `relay_uncaught_exceptions_total`/`unhandled_rejections_total` counters to /metrics; (3) document the deliberate single-process rationale; (4) genuine OOM relies on Fly OOM-kill+restart+alarm. Unit-test the handler logs the tag and does NOT process.exit. |
| ops: saved-group IDs use Math.random; byte caps use .length not bytes (saved-groups.ts:81, route:73, feedback route:79) | ADOPT-MODIFIED | S | Byte cap: ADOPT — `utf8ByteLength(s)=new TextEncoder().encode(s).byteLength`, replace `serialized.length` at both sites + fix the actualKB message; regression test a payload UTF-16-under but UTF-8-over the cap asserts 413. ID: PUSH-BACK on the security framing (every read owner-scoped by user_id) but collision-ergonomics stands: switch generateId to `crypto.randomUUID()` (Workers-native + Node global, zero deps) keeping the sg_ prefix. NO collision-retry loop. |
| ops: stale comments — r/[id]:101 "no auth verification yet"; wrangler pg-over-TCP | ADOPT | S | Both flatly contradicted by current code. (1) Rewrite r/[id]:100-106: auth IS verified server-side + per-user layouts ARE enforced; drop stale clauses. (2) Replace wrangler.toml:21-29 (Fly-Postgres-over-TCP/Hyperdrive misconception) with the actual arch (Neon via @neondatabase/serverless HTTP only; pg-TCP + Neon WS Pool both FAIL from Workers; nodejs_compat is for faustwasm bundle resolution NOT pg sockets). The wrangler one is more dangerous (a contributor could re-introduce a pg import). Verify the change persisted + commit promptly (sync-layer may revert). |

## Push-backs (decided)

1. **Make import/load undoable.** A single-undo-entry load means Cmd-Z silently
   restores whatever junk/empty state preceded it — MORE surprising than "load is
   permanent", and it would coalesce with the user's next edit. The real defect is
   the UNTAGGED null origin, not non-undoability. Fix = a deliberate `LOAD_ORIGIN`
   constant documenting intent.

2. **Crash-and-restart the relay on uncaughtException.** Generically reasonable but
   WRONG for this architecture: ONE process serves EVERY rack. Crashing nukes all
   racks at once, loses ~5s of un-snapshotted edits across all, triggers an
   all-clients reconnect storm against a cold process. Stay-up was the specific
   tab-switch-500 fix; transient handling already exists at source. Right answer is
   alarms on the event.

3. **Identity-keyed slots with refcount as the primary capacity gate.** Would BREAK
   anon rooms — anon token byte-identical per rack, per-tab anon id never reaches
   the server, so identity-keyed slots collapse ALL anon guests to one slot.
   Multiuser-constraints favors strict-then-loosen (counting MORE = safe). Adopt
   only the cheap UI-honesty fix now; gate the refactor behind an actual
   multi-tab-lockout report; if built, anon MUST stay socket-keyed.

4. **Enforce singleton/max-instance at graph-write time (in addition to cleanup).**
   Write-time enforcement ALREADY EXISTS and is powerless against the actual failure
   mode (concurrent spawns on different peers; Yjs has no conditional insert). Only
   worthwhile change is DRY-extracting the 4 count loops into one cap.ts; the
   cross-peer race needs the post-merge cleanup pass.

5. **Add an ESLint guard banning raw patch.nodes[...] writes.** Mechanism wrong —
   repo has NO ESLint. Use the existing source-scanning vitest guard idiom; do not
   stand up ESLint + a custom rule + a new CI gate for one rule.

6. **Owner-only gating for import / saved-group insert.** Contradicts the documented
   anon-collaborator model. The right control is the existing per-rackspace 4-cap +
   connection auth, not an authoring-time owner gate. Scope the validator to
   STRUCTURAL edge/port/type-compat + module-type-registered.

7. **Validator should also check caps, owner-only, and params/data shape.** Caps are
   ALREADY enforced at insertSavedGroup + addNode; param/data-shape is handled by
   per-module migrate() + schemaVersion + stripTransientDataFields. Scope the new
   validator to structural edge/port/type-compat + module-type-registered ONLY.

## Execution order (waves)

- **WAVE 0 — Independent S wins, ship first** (low risk, clear regressions, no
  conflict surface; 1-2 PRs):
  (a) FW1 relay persistence guard + /health + /metrics persist_mode
  [server/db.ts, index.ts, http-introspection.ts] (M; guard+health half is S).
  (b) web db.ts named-throw + /api/health db field [S — first resolve
  import.meta.env.DEV vs NODE_ENV reliability on Workers].
  (c) ops hygiene PR: byte-cap utf8ByteLength + crypto.randomUUID IDs +
  uncaughtException structured-log/counter + stale comment fixes (r/[id]:101 +
  wrangler.toml) [S].
  (d) clearPatch +LOCAL_ORIGIN one-liner + e2e [S].
  (e) load LOAD_ORIGIN deliberate-non-tracked tag + test [S].
  (f) engine.ts exact nodeTypes lookup + missing engine.test coverage [S].

- **WAVE 1 — Foundational seams** (build the shared primitives):
  FW2 mutate.ts (setNodeParam/mutateNode + store.test coverage) [M].
  FW3 validate-edge.ts + validateGraphFragment (pure, framework-free, unit-tested)
  [M].
  graph/cap.ts helper (instanceCount/wouldExceedCap) extracted from the 4 duplicated
  spawn loops [S].

- **WAVE 2 — Dependent items built on the seams:**
  (a) P1: wire validateEdge into handleConnect + isValidConnection on SvelteFlow [M].
  (b) Sequencer LOCAL_ORIGIN [S, depends FW2].
  (c) Singleton deterministic post-merge cleanup pass scoped to type-level
  maxInstances, elected-peer delete + real-Y.Doc tests + DATABASE_URL-gated @collab
  e2e [M, depends engine fix + cap.ts].
  (d) capacity UI-honesty fix (connections vs distinct users) [S, standalone].

- **WAVE 3 — Larger dependent migrations:**
  (a) The 141-file card param migration to setNodeParam, staged in module batches
  [L, depends FW2; rebase promptly].
  (b) P2: drop-invalid-edges on loadEnvelopeIntoStore + resurrectSavedGroup + tighten
  saved-groups validatePayload [L, depends FW3; coordinate conflict-sweep].
  (c) reconciler addEdge try/catch tolerance + test [S, complementary].

- **WAVE 4 — Ratchets + structural debt:**
  (a) mutate.guard.test.ts source-scan guard — MUST land AFTER the 141-file
  migration or it red-walls CI [M].
  (b) migration ledger + task db:migrate + runbook + fix CI workflows to apply ALL
  schema files + 002 DROP cleanup [M; urgency rises at launch].
  (c) Canvas.svelte incremental extraction, staged pure-helpers→persistence→examples
  →grouping→engine/connection, each its own green PR [XL; DEPRIORITIZED — native
  port re-implements UI].

- **DEFERRED / GATED (do not build speculatively):** identity-keyed capacity
  refcount (gate on a real multi-tab-lockout report; decide the canonical participant
  key shared with DOOM host-election/Carl-Mike leader-election first). General
  mutatePatch guarded-write rewrite (not needed; FW2+FW3 cover the real needs).

## Inaccuracies in the review (verified)

| Review claim | Reality |
|--------------|---------|
| undo: "add an ESLint guard banning raw patch.nodes[...] writes" | Repo has NO ESLint whatsoever (no config, no dep; only lint task is svelte-check). Adding "an ESLint guard" means standing up ESLint + a custom rule + a CI gate from zero. Repo's actual idiom is a source-scanning vitest guard. |
| migration: "deploy may apply only 001_init.sql" | UNDERSTATED. CI applies ONLY 001 across 8+ workflows; 002/003 NEVER referenced in any workflow; deploy.yml applies ZERO SQL. Even CI test DBs lack feedback/saved_groups unless seeded. Also fix CI workflows to apply all schema files. |
| P0: "/health + /metrics exist but neither exposes persistence mode" (implying both need a new field) | Accurate; useful specific: MetricsSnapshot ALREADY carries boot_id + persist_writes_per_min, so adding persist_mode is a one-field extension of an existing surface, not new plumbing. /health currently returns {ok:true,boot_id}. |
| capacity P1: "one user with multiple tabs consumes multiple slots while UI shows one person" (framed as a general identity-keyed fix) | True ONLY for Clerk users. Anon token is `anon:<HMAC(rackId)>`, byte-identical per rack, per-tab anon id never sent to server — a naive identity-keyed gate would COLLAPSE all anon guests into one slot. Materially changes the recommended fix. |
| engine heuristic line ref "audio/engine.ts:217" | Minor: :217 is the `if (ad.maxInstances !== undefined)` opener; actual startsWith heuristic at :228. Exact-lookup replacement (this.nodeTypes, :138/:255) is real. |
| byte-cap line refs "saved-groups route:73, feedback route:79" | Minor off-by: actual checks at saved-groups +server.ts:74 and feedback +server.ts:83. The .length-vs-bytes bug is confirmed at both real sites. |
| edge/overlap: reconciler addEdge call described against the older signature | engine.addEdge now called as `addEdge(edge, edgeDomain(edge), edgeTargetDomain(edge))` (reconciler.ts:149). Throw-on-missing-port + swallow at enqueue .catch (:53) unchanged; finding's substance holds. |
