# Rack persistence hardening — plan (2026-07-19)

> **STATUS (re-verified 2026-08-12) — FIX A, P1, P2 and P4 are all BUILT. Only
> P3 and the owner decisions remain.** (An earlier triage header on this file
> claimed P1–P3 were "NOT BUILT"; that was wrong for P1 and P2 and is corrected
> here.)
> - **FIX A — DONE**, as **#1131** ("persist scratch canvas across refresh
>   (IndexedDB local replica)"): `packages/web/src/lib/storage/local-scratch.ts`
>   mints the stable per-device id §0 called for. It deliberately lives under
>   `lib/storage`, **not** `lib/multiplayer`, because that directory is a
>   whole-dir collab-attest basis root. (The body below still says
>   `lib/multiplayer/` in one place — the header is the correct location.)
> - **P1 — DONE**: `packages/web/src/lib/ui/RackStatusBanner.svelte`, plus the
>   pure state-machine helper this plan asked for —
>   `packages/web/src/lib/ui/rack-status.ts` + `rack-status.test.ts` — wired
>   from `routes/r/[id]/+page.svelte`.
> - **P2 — DONE, and the beforeunload predicate IS strict**:
>   `routes/r/[id]/+page.svelte` tracks `hasUnsyncedChanges` off the provider
>   and gates the handler on `shouldPromptUnsaved()`, which is literally
>   `return hasUnsyncedChanges === true` (`rack-status.ts`). A fully-synced user
>   is never nagged. The page also exposes a dev/e2e test hook rather than
>   asserting against the native dialog, exactly as the plan proposed.
> - **P4 — DONE**: `packages/web/src/lib/ui/canvas/import-confirm.ts` (+ test),
>   wired into `Canvas.svelte`'s destructive-import path.
> - **P3 — STILL OPEN**, and nothing in-tree will ever mark it done because it
>   is not app code. `ALLOW_MEMORY_STORE` appears only in
>   `packages/server/src/{db.ts,index.ts,db.test.ts}` — that is the fail-fast
>   **guard**, not the monitor P3 asks for.
>
> ⚠ **One real staleness to resolve before trusting the scratch-key design.**
> This plan keys the scratch replica by MODE (`dawless | workflow`), and that is
> how #1131 shipped. **Dawless mode was REMOVED (#1459)** — the new shell is the
> default and `?shell=legacy` selects legacy *cards inside the same shell*, not a
> second canvas. `local-scratch.ts` still mentions `dawless`, but as a
> *deliberate legacy-key cleanup* (the two mode-suffixed keys a returning
> browser may hold are PRUNED, never read, because adopting an old id would
> resurrect a patch authored under a shell that no longer exists). **The
> mode-keying rationale in §FIX A and in owner question 2 below therefore needs
> re-reading against #1459 before anyone acts on it.**

Owner-approved work off the refresh-persistence investigation. One urgent user
bug (FIX A) plus four hardening items (P1-P4).

---

## 0. Root cause of the anon-refresh-loss bug (the urgent repro)

This is the only written account of the gap, so it is kept in full.

**Repro:** not logged in → patch on the default canvas (NOT inside a shared
`/r/[id]` rackspace) → refresh → whole rack lost.

**Where a logged-out user's patch lives:** the default scratch canvas is the
`/rack` route (`packages/web/src/routes/rack/+page.svelte`), NOT `/`. (`/` is the
static prerendered landing page — `routes/+page.svelte` / `+page.ts:14`
`prerender=true`.) `/rack` mounts `<Canvas {headerAuth} {mode} />` with **no
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
  (`Canvas.svelte` `dockStore.bind(rackspaceId ?? 'scratch')`, localStorage)
  — that persists UI dock state, NOT the patch graph.

So the scratch graph lived ONLY in a volatile in-memory Y.Doc. A browser refresh
is a full document reload → new JS context → fresh empty `createPatch()` → the
entire patch is gone. There was no IndexedDB replica, no relay snapshot, no
localStorage copy of the graph to restore from.

**Precise root cause:** the `/rack` scratch canvas had **zero graph persistence**
— it never attached the existing `local-replica.ts` IndexedDB machinery (or any
other durable sink) to its Y.Doc.

**Important scope note:** this is a *route-level* gap, not an *auth-level* one. A
logged-IN user on `/rack` loses their scratch patch on refresh too. The repro
surfaces it for logged-out users because `/rack` is the ONLY canvas they have
(anon users cannot create a `/r/[id]` rackspace — `createRackspace` requires
`ownerUserId`). FIX A fixes it for everyone on the scratch canvas.

---

## FIX A — the design decisions that survive

The id is deliberately NOT a bare `'local-scratch'` constant — a per-device UUID
keeps the IndexedDB DB name from colliding with any real rack id space and lets
a future "reset scratch" affordance just mint a new id. It is backed by
**localStorage** (must survive refresh; sessionStorage would not), and a
throwing / private-mode localStorage falls back to a per-mount ephemeral id —
the same graceful-degrade posture as `getOrCreateAnonTabId`: no crash, just no
cross-refresh persistence in that hostile environment.

`local-replica.ts` needed **no change**: it is id-agnostic, so a
`local-scratch-*` id flows through the same validate → seed → persist path, and
corrupt-replica self-heal, private-mode `'disabled'` degrade and multi-tab
safety all carry over for free.

### Migration into a real rack — OWNER DECISION

Ship FIX A as **Option A: scratch stays a separate persistent local sandbox.**
Signing in / creating / joining a `/r/[id]` rack does NOT move the scratch patch;
the scratch simply persists locally until the user clears it. Minimal, zero-risk,
and fully delivers "refresh restores my patch."

**Option B is UNBUILT and still a live decision** — "Import my scratch into this
new rack", a one-time copy. The machinery already exists:
`makePortableEnvelope(ydoc, …)` + `loadEnvelopeIntoStore` (`persistence.ts`), so
an "Import scratch" affordance on a fresh `/r/[id]` could offer it. Flagged as a
decision, not built.

---

## FIX P1 — design constraint that must not be lost

**CRITICAL: never block editing.** The banner is an overlay/toast, **not a modal
gate** — an offline-with-replica user must be able to keep working. The
"restoring" state is gated on `!seeded && !synced` so a warm refresh (replica
seeds in ms) never flashes it.

---

## FIX P2 — design constraint that must not be lost

**Do NOT attempt a synchronous flush** — both WS-send and IDB-write are async and
cannot be forced in `beforeunload`. The prompt's only job is to give those
in-flight async writes a beat and to warn on a genuinely-unsynced close.

---

## FIX P3 — prod memory-mode alert + `ALLOW_MEMORY_STORE` audit — **STILL OPEN**

Ops/observability only, no app code. The `shouldFailFast` guard
(`packages/server/src/db.ts`, wired at `index.ts`) already refuses to boot a
`NODE_ENV=production` relay without `DATABASE_URL` unless `ALLOW_MEMORY_STORE=1`.

### Audit result (from the original investigation)
- `fly.prod.toml`, `fly.dev.toml`, `fly.autotest.toml` each set
  `NODE_ENV="production"` and **none** set `ALLOW_MEMORY_STORE` → the guard is
  active on all three. Good.
- `DATABASE_URL` / `R2_*` are Fly **secrets** (correctly NOT in the `[env]`
  blocks). **Action still outstanding: confirm the `DATABASE_URL` secret is
  actually attached on all three apps** (`flyctl secrets list -a <app>`), since
  the guard is the only thing standing between "unset secret" and a crash-loop —
  which is the intended safe failure, but it is *"worth verifying it's
  crash-loop and not accidentally hatched."*

### Changes (no app code)
- **Better Stack monitor**: alert if any prod relay's `/metrics` reports
  `persist_mode=memory` (the value is already exposed —
  `http-introspection.ts` via `snapshots.mode()`), OR keyword-alert on the
  `event=relay_no_database_url level=fatal` boot line. Add to the existing
  keyword-monitor set (infra-docs repo: `~/Documents/workspace/patchtogether-infra-docs`).
- **Runbook note**: `ALLOW_MEMORY_STORE` must never be set on prod/dev/autotest;
  it exists only for a deliberate ephemeral run.

---

## FIX P4 — why the confirm exists

`loadEnvelopeIntoStore` does a clear-then-re-add: in a shared rack the clear
propagates tombstones to every peer + the relay snapshot + the journal — a
durable, multi-user content wipe. That is why import needed a confirm and not
just the pre-existing cross-mode guard.

---

## Owner decisions still to confirm

1. **Option B** — greenlight the "Import my scratch into this new rack" one-time
   copy via the existing portable-envelope machinery, or leave scratch fully
   separate? (Option A is shipped; B is additive.)
2. **Scratch id granularity.** As shipped, the scratch replica is keyed by MODE
   (dawless/workflow) so the two entry points could not cross-load.
   ⚠ **Re-read against #1459 first** — dawless mode no longer exists, so the
   question is now whether a single scratch doc is the right shape and whether
   any of the mode-keying should remain.
3. **beforeunload prompt (P2).** Shipped as a native prompt fired only when
   `hasUnsyncedChanges` is true (strict — see header). Confirm that is the
   wanted behaviour, or reduce to a silent "saving…" indicator with no prompt.
4. **Import-replaces-rack in multiplayer (P4).** Keep it allowed-with-confirm, or
   restrict destructive Import to owner/solo racks entirely?
5. **Scratch privacy on shared machines.** A persistent local scratch means the
   next person on the same browser profile sees the previous patch on `/rack`.
   Acceptable, or add a visible "clear scratch" affordance?
   *Recommend: ship as-is, add clear-scratch as a tiny follow-up.*
