# Rack persistence hardening — plan (2026-07-19)

> **TRIAGE 2026-08-04 — FIX A and P4 SHIPPED; P1–P3 still open.**
> - **FIX A (the urgent anon-refresh-loss bug) — DONE**, as **#1131**
>   ("persist scratch canvas across refresh (IndexedDB local replica)"). The
>   implementation is `packages/web/src/lib/storage/local-scratch.ts`, which mints
>   the stable per-device id §0 called for and keys it BY MODE (dawless |
>   workflow) — a refinement the plan did not anticipate. Note it deliberately
>   lives under `lib/storage`, **not** `lib/multiplayer`, because that directory
>   is a whole-dir collab-attest basis root.
> - **P4 (import-JSON confirm before a destructive wipe) — DONE**:
>   `packages/web/src/lib/ui/canvas/import-confirm.ts` (+ its test), wired at
>   `Canvas.svelte:168-172` with the comment "P4: destructive-import confirm
>   (persistence hardening)".
> - **P1 (Restoring…/Offline status), P2 (saving indicator + unsaved-changes
>   guard), P3 (prod memory-mode alert + `ALLOW_MEMORY_STORE` audit) — NOT
>   BUILT.** No restoring/offline/saving surface exists; `ALLOW_MEMORY_STORE` is
>   only exercised in `packages/server/src/db.test.ts`, i.e. the escape hatch
>   from the earlier adversarial work, not P3's ops audit.
> - The **OWNER DECISION** in "Migration into a real rack" is preserved and is
>   part of why this file stays.

Owner-approved work off the refresh-persistence investigation. One urgent user
bug (FIX A) plus four hardening items (P1-P4). This doc is build-ready:
file-by-file, with the approach, the proving test, and effort for each.

Read-only investigation that produced this: the anon-refresh-loss repro is
root-caused in §0; the durability architecture (Yjs sync = merge-not-replace,
relay snapshot+journal, IndexedDB replica) is mapped in the parent findings.

---

## 0. Root cause of the anon-refresh-loss bug (the urgent repro)

**Repro:** not logged in → patch on the default canvas (NOT inside a shared
`/r/[id]` rackspace) → refresh → whole rack lost.

**Where a logged-out user's patch lives:** the default scratch canvas is the
`/rack` route (`packages/web/src/routes/rack/+page.svelte`), NOT `/`. (`/` is the
static prerendered landing page — `routes/+page.svelte` / `+page.ts:14`
`prerender=true`; its "new dawless rack" tile links to `/rack`.) `/rack` mounts
`<Canvas {headerAuth} {mode} />` (`rack/+page.svelte:30`) with **no
`rackspaceId` prop and no `provider` prop**.

**Why it's lost:** Canvas reads the module-singleton `patch`/`ydoc` from
`graph/store.ts`. At module-eval time that singleton is a plain in-memory
`createPatch()` doc (`store.ts:85` `let _bundle = createPatch()`). On the `/rack`
path **nothing ever binds it to a persistent id and nothing attaches a durable
sink**:

- `attachLocalReplica()` (the IndexedDB replica) is called from exactly ONE
  place — `routes/r/[id]/+page.svelte:144` — and only for a real rack id. The
  scratch canvas never calls it. (Grep-confirmed: no other call sites.)
- `bindRackspace()` in production runs only from `routes/r/[id]/+page.svelte:76`
  and the docs sandbox (`VirtualModule.svelte`). The `+layout.svelte:101` bind is
  inside a `testHooksEnabled()` block (`__attachProvider`, dev/e2e only).
- No relay provider is attached (no `/r/[id]`, no id → no room).
- The only thing keyed by a `'scratch'` fallback is the **dock layout** store
  (`Canvas.svelte:1063` `dockStore.bind(rackspaceId ?? 'scratch')`, localStorage)
  — that persists UI dock state, NOT the patch graph.

So the scratch graph lives ONLY in a volatile in-memory Y.Doc. A browser refresh
is a full document reload → new JS context → fresh empty `createPatch()` → the
entire patch is gone. There is no IndexedDB replica, no relay snapshot, no
localStorage copy of the graph to restore from.

**Precise root cause:** the `/rack` scratch canvas has **zero graph persistence**
— it never attaches the existing `local-replica.ts` IndexedDB machinery (or any
other durable sink) to its Y.Doc.

**Important scope note:** this is a *route-level* gap, not an *auth-level* one. A
logged-IN user on `/rack` loses their scratch patch on refresh too. The repro
surfaces it for logged-out users because `/rack` is the ONLY canvas they have
(anon users cannot create a `/r/[id]` rackspace — `createRackspace` requires
`ownerUserId`; the landing "my rackspaces" tile routes to `/dashboard` which is
auth-gated). FIX A fixes it for everyone on the scratch canvas.

---

## FIX A (PRIORITY) — persist the logged-out / scratch canvas across refresh

Give the scratch canvas a stable local IndexedDB replica keyed by a
`localStorage`-persisted per-device id, reusing `local-replica.ts` unchanged. A
refresh then rehydrates the doc from IndexedDB in milliseconds — identical to the
warm-refresh behavior `/r/[id]` already has, minus the relay.

### Approach

1. **New helper: a stable local-scratch id (localStorage).**
   File: `packages/web/src/lib/multiplayer/local-scratch.ts` (new, ~30 lines).
   Mirror the shape of `presence.ts:getOrCreateAnonTabId` but back it with
   **localStorage** (must survive refresh; sessionStorage would not) and key it
   **by mode** so the dawless and workflow scratch canvases don't cross-load:

   ```ts
   // getOrCreateLocalScratchId(mode: RackMode): string
   //   → 'local-scratch-dawless-<uuid>' | 'local-scratch-workflow-<uuid>'
   // Persisted under localStorage key `pt:local-scratch-id:<mode>`.
   // Private-mode / throwing localStorage → falls back to a per-mount ephemeral
   //   id (same graceful-degrade posture as getOrCreateAnonTabId): no crash,
   //   just no cross-refresh persistence in that hostile environment.
   ```

   Reuse the `cryptoRandomId()` pattern. The id is deliberately NOT a bare
   `'local-scratch'` constant — a per-device UUID keeps the IndexedDB DB name
   from colliding with any real rack id space and lets a future "reset scratch"
   affordance just mint a new id.

2. **Wire it into `/rack`.**
   File: `packages/web/src/routes/rack/+page.svelte` (edit).
   Mirror the `/r/[id]` mount discipline (`r/[id]/+page.svelte:76,136-203`):

   - Top-level, before Canvas mounts:
     `const scratchId = getOrCreateLocalScratchId(mode);` then
     `bindRackspace(scratchId);` — binds the singleton to a fresh doc for this
     device+mode. (bindRackspace is idempotent for the same id.)
   - In an `$effect` / `onMount`: `const replica = attachLocalReplica(scratchId, ydoc);`
     Return teardown: `void replica.destroy();` (keeps the stored data — the
     whole point) + `unbindRackspace()` on the page's `onDestroy`.
   - Wrap `<Canvas>` in `{#key scratchId}` so a `?mode=` switch (client-side nav
     that may not remount the page) cleanly rebinds + remounts against the
     mode-correct doc — exactly the `{#key data.rackspace.id}` pattern
     `/r/[id]` uses.
   - Pass `rackspaceId={scratchId}` to `<Canvas>` so the dock store scopes per
     scratch mode too (replaces the bare `'scratch'` fallback; low-risk, and
     makes dock state mode-consistent). Keep `currentUserId` UNSET so the canvas
     stays single-user layout — do NOT flip multi-user mode.

   `mode` is already `$derived` in `rack/+page.svelte:27`; `scratchId` derives
   from it.

3. **No change to `local-replica.ts`.** It is id-agnostic; a `local-scratch-*`
   id flows through the same validate → seed → persist path. The DB name becomes
   `pt-rack-v1-local-scratch-dawless-<uuid>`. Corrupt-replica self-heal, private-
   mode `'disabled'` degrade, and multi-tab safety all carry over for free.

### Migration into a real rack (OWNER DECISION — see §Decisions)

Ship FIX A as **Option A: scratch stays a separate persistent local sandbox.**
Signing in / creating / joining a `/r/[id]` rack does NOT move the scratch patch;
the scratch simply persists locally until the user clears it. This is minimal,
zero-risk, and fully delivers "refresh restores my patch."

A later, optional **Option B** ("import my scratch into this new rack") is a
clean follow-up: the machinery already exists — `makePortableEnvelope(ydoc, …)`
+ `loadEnvelopeIntoStore` (persistence.ts) — so an "Import scratch" affordance on
a fresh `/r/[id]` could offer a one-time copy. Flagged as a decision, not built
here.

### Tests

- **Unit — `local-scratch.test.ts` (new).** Stable id across calls for the same
  mode; distinct ids per mode; localStorage-throws → ephemeral fallback (no
  throw). Fast, deterministic.
- **Unit — extend `local-replica.test.ts`.** It already proves seed-across-
  sessions (`fresh` → `seeded`) with an arbitrary id; add one case asserting a
  `local-scratch-*` id round-trips (guards against any accidental id-shape
  assumption).
- **E2E — `tests/scratch-persist.spec.ts` (new, single spec).** Go to `/rack`,
  add a node (drive the real add path), assert it's present, `page.reload()`,
  assert the node is STILL present after seed. Second case: `/rack?mode=workflow`
  persists independently and a dawless refresh doesn't show workflow nodes (mode
  isolation). Gate on IndexedDB availability. **Flake-check 3×** per the repo
  standard (`REPEAT=3 task e2e:one -- scratch-persist`).
- Run `task typecheck` (svelte-check) — new route wiring + `{#key}`.

### Effort
S-M. One ~30-line helper, ~15 lines of page wiring, 1 new unit + 1 new e2e +
1 extended unit. No changes to the replica engine or the relay.

---

## FIX P1 — "Restoring…/Offline" status until seeded-or-synced

Removes the cold-load blank-canvas confusion (perceived data loss when the relay
is slow/down and there's no local replica yet). Applies to `/r/[id]`; the
scratch canvas after FIX A seeds from IndexedDB near-instantly so it needs no
overlay (but the same component can show a one-frame "restoring" there harmlessly
— keep it relay-gated).

### Approach
File: `packages/web/src/routes/r/[id]/+page.svelte` (edit) + a small
`packages/web/src/lib/ui/RackStatusBanner.svelte` (new, presentational).

- Track two signals already available: `replica.whenSeeded` (resolves
  `seeded|fresh|cleared-corrupt|disabled`) and the provider's `synced` event /
  `provider.isSynced` (Canvas already listens — `Canvas.svelte:725-771`; lift a
  minimal `synced` boolean to the page or read `provider.on('synced')` in the
  page effect).
- State machine: `restoring` (initial) → clears to `ready` when
  `seeded || fresh || synced`. If neither the replica seeded NOR the provider
  synced within a timeout (e.g. 4 s), show `offline` = "Offline — working from
  your local copy" (non-blocking; editing stays enabled the whole time).
- CRITICAL: never block editing. The banner is an overlay/toast, not a modal
  gate — an offline-with-replica user must be able to keep working. Gate the
  "restoring" state on `!seeded && !synced` so a warm refresh (replica seeds in
  ms) never flashes it.

### Tests
- **E2E — `tests/rack-restoring-status.spec.ts` (new).** Boot a seeded `/r/[id]`
  with the WS blocked (route-abort the relay URL), assert the "Offline — working
  from your local copy" banner appears and the canvas is still interactive;
  unblock, assert the banner clears on `synced`. Capability-gate + 3× flake.
- **Unit** for the state-machine helper (pure function: inputs seeded/synced/
  elapsed → `restoring|ready|offline`), so the timing logic is proven without a
  browser.

### Effort
M. Mostly the state machine + one component + one e2e.

---

## FIX P2 — Saving indicator + strict unsaved-changes guard

Narrows the last-few-ms-before-abrupt-reload loss window and gives the user
save feedback. Applies to BOTH `/r/[id]` (relay) and, after FIX A, `/rack`
(local replica) — both expose durability progress differently, so scope P2 to
the **relay** provider path first (clear signal via `hasUnsyncedChanges`); the
scratch/local path is covered by the near-instant IndexedDB write and does not
get a beforeunload prompt.

### Approach
File: `packages/web/src/routes/r/[id]/+page.svelte` (edit); reuse
`RackStatusBanner` from P1 for the "Saving… / All changes saved" text.

- Drive a `saving` indicator from `provider.hasUnsyncedChanges` +
  `provider.synced` (both are real gauges — proven in
  `packages/server/src/reconnect-replay.test.ts`: `hasUnsyncedChanges` drains to
  false only after every update is ACKed). Poll on the provider's
  `unsyncedChanges`/`synced` events or a short rAF/interval while unsynced.
- `beforeunload` handler that calls `event.preventDefault()` **only when
  `provider.hasUnsyncedChanges === true`** — a strict gate so we never nag a
  fully-synced user (over-firing beforeunload is user-hostile). Register on the
  page, remove on `onDestroy`.
- Do NOT attempt a synchronous flush (both WS-send and IDB-write are async and
  cannot be forced in `beforeunload`); the prompt's only job is to give those
  in-flight async writes a beat and to warn on a genuinely-unsynced close.

### Tests
- **Unit** for the "should we prompt?" predicate (`hasUnsyncedChanges` true →
  prompt; false → no prompt).
- **E2E — `tests/unsaved-guard.spec.ts` (new).** With the relay reachable, make
  an edit and assert the indicator flips `saving` → `all changes saved` once
  `synced`. (Testing the actual native beforeunload dialog is brittle in
  Playwright — assert the handler is registered and the predicate via an exposed
  test hook rather than the browser chrome.) 3× flake-check.

### Effort
S-M.

---

## FIX P3 — prod memory-mode alert + `ALLOW_MEMORY_STORE` audit (ops, no app code)

Closes the residual on the "prod relay silently non-persistent" footgun. The
`shouldFailFast` guard (`packages/server/src/db.ts:70-75`, wired at
`index.ts:323-334`) already refuses to boot a `NODE_ENV=production` relay without
`DATABASE_URL` unless `ALLOW_MEMORY_STORE=1`.

### Audit result (already checked in this investigation)
- `fly.prod.toml`, `fly.dev.toml`, `fly.autotest.toml` each set
  `NODE_ENV="production"` (prod:23, dev:33, autotest:25) and **none** set
  `ALLOW_MEMORY_STORE` → the guard is active on all three. Good.
- `DATABASE_URL` / `R2_*` are Fly **secrets** (correctly NOT in the `[env]`
  blocks). Action: confirm the `DATABASE_URL` secret is actually attached on all
  three apps (`flyctl secrets list -a <app>`), since the guard is the only thing
  standing between "unset secret" and a crash-loop (which is the intended safe
  failure, but worth verifying it's crash-loop and not accidentally hatched).

### Changes (no app code)
- **Better Stack monitor**: alert if any prod relay's `/metrics` reports
  `persist_mode=memory` (the value is already exposed —
  `http-introspection.ts` via `snapshots.mode()`), OR keyword-alert on the
  `event=relay_no_database_url level=fatal` boot line. Add to the existing
  keyword-monitor set (infra-docs repo: `~/Documents/workspace/patchtogether-infra-docs`).
- **Runbook note**: `ALLOW_MEMORY_STORE` must never be set on prod/dev/autotest;
  it exists only for a deliberate ephemeral run.

### Tests
- No app-code test. Optionally a one-line assertion test in the server package
  that `shouldFailFast({NODE_ENV:'production'}, true)` is `true` and
  `{…, ALLOW_MEMORY_STORE:'1'}` is `false` (may already exist in
  `snapshot-config.test.ts`/`db.test.ts` — verify, add if missing).

### Effort
XS (config/observability + a verification pass).

---

## FIX P4 — Import-JSON confirm before a destructive rack wipe

`loadEnvelopeIntoStore` (`persistence.ts:342-449`) does a clear-then-re-add: in
a shared rack the clear propagates tombstones to every peer + the relay snapshot
+ the journal — a durable, multi-user content wipe. `importPatchJson`
(`Canvas.svelte:2057-2086`) currently has only a cross-mode guard, no
confirmation.

### Approach
File: `packages/web/src/lib/ui/Canvas.svelte` (edit `importPatchJson`, ~line
2057). Before `loadEnvelopeIntoStore`, when the current rack is non-empty
(`Object.keys(patch.nodes).length > 0`) — and especially when a provider is
attached (multiplayer) — show a `window.confirm` mirroring the existing
`resetSession` confirm pattern (`r/[id]/+page.svelte:401-408`):
"Replace the current rack with the imported patch? This clears the existing
modules for everyone in this rack." Abort on cancel, leaving the graph untouched
(the parse is already non-destructive and happens first — `Canvas.svelte:2068`).

### Tests
- **Unit** for the guard decision (non-empty + confirm=false → no
  `loadEnvelopeIntoStore` call; empty → no prompt, proceeds). Mock `confirm`.
- Optionally extend an existing import e2e if one exists; otherwise the unit is
  sufficient (the destructive path itself is already covered by persistence
  tests).

### Effort
XS-S.

---

## PR grouping (recommended)

- **PR 1 — FIX A only (URGENT).** The user-facing data-loss bug. Ships alone so
  it can merge fast without waiting on the UX work. Files: new
  `lib/multiplayer/local-scratch.ts`, edit `routes/rack/+page.svelte`, new
  `local-scratch.test.ts`, new `tests/scratch-persist.spec.ts`, extend
  `local-replica.test.ts`. Self-contained; no shared-registry files touched, so
  no conflict-sweep risk.
- **PR 2 — P1 + P2 together.** They share the `RackStatusBanner` component and
  both touch `r/[id]/+page.svelte` — one PR avoids a self-conflict. Files: new
  `lib/ui/RackStatusBanner.svelte`, edit `routes/r/[id]/+page.svelte`, 2 new
  e2e specs + 2 unit helpers.
- **PR 3 — P4.** Small, isolated Canvas change + unit. Can piggyback on PR 2 or
  ship standalone.
- **P3 is not a PR** — observability/config in the infra-docs repo + a secret-
  list verification. Do it alongside PR 1 (it's the safety net for the same
  durability story).

Rationale: FIX A is the approved top priority and is fully independent; gating it
behind the P1/P2 UX polish would delay the actual bug fix. P1/P2 share surface so
they co-locate. All are low-risk and additive.

---

## Owner decisions to confirm

1. **Scratch → rack migration (FIX A).** Ship Option A (scratch is a separate
   persistent local sandbox; no auto-migration). Confirm, or greenlight the
   Option B follow-up ("Import my scratch into this new rack" one-time copy via
   the existing portable-envelope machinery).
2. **Scratch id granularity.** Plan keys the scratch replica by MODE
   (dawless/workflow) so the two entry points don't cross-load. Confirm that's
   desired vs. a single shared scratch doc.
3. **beforeunload prompt (P2).** OK to show a native "unsaved changes" prompt
   when — and only when — `hasUnsyncedChanges` is true? (Alternative: silent
   "saving…" indicator only, no prompt.)
4. **Import-replaces-rack in multiplayer (P4).** Keep it allowed-with-confirm, or
   restrict destructive Import to owner/solo racks entirely?
5. **Scratch privacy on shared machines.** A persistent local scratch means the
   next person on the same browser profile sees the previous patch on `/rack`.
   Acceptable, or add a visible "clear scratch" affordance? (Recommend: ship as-
   is, add clear-scratch as a tiny follow-up.)
