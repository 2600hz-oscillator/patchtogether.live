# ADR-014: Keep a local replica for the unsynced scratch rack

- Status: Accepted (five follow-on decisions open — see Consequences)
- Date: 2026-09-08 (records the fix shipped 2026-07-19)
- Deciders: project owner; this ADR documents the decision
- Tags: persistence, storage, ux, multiplayer

## Context

`/r/[id]` racks have a relay and an IndexedDB replica, so a refresh rehydrates
in milliseconds. The `/rack` scratch canvas has neither a rackspace id nor a
relay — so it never attached the replica machinery at all, and a browser refresh
threw the whole patch away: new JS context, fresh empty document, nothing to
rehydrate from. An anonymous visitor could lose a full session's work to a
reload with no warning and no recovery.

Three adjacent hazards showed up in the same review. The rack could be
mid-persist with no indication of whether anything was saved. A destructive
"Import JSON" clears the graph before re-adding, and in a shared rack that clear
propagates tombstones to every peer, the relay snapshot and the journal — a
durable, multi-user content wipe reachable from a menu item. And a returning
browser could still be holding keys written by an earlier two-mode era.

## Decision

**The scratch rack gets the same local replica the real racks have, keyed by a
per-device id — and every durability affordance around it is a pure, testable
decision function rather than a Svelte-side condition.**

- `packages/web/src/lib/storage/local-scratch.ts` mints a **stable per-device
  UUID** in `localStorage` and `attachLocalReplica(id, ydoc)` mirrors the scratch
  document into IndexedDB. A UUID, not a bare constant, so the database name can
  never collide with the real rack id space and "reset scratch" is just minting a
  fresh one. It degrades gracefully: a throwing or private-mode `localStorage`
  falls back to a per-mount ephemeral id — no crash, just no cross-refresh
  persistence in that hostile environment.
- Keys from the superseded two-mode era are **pruned, never adopted**: adopting
  an old id would resurrect a patch the user last saw under a different product.
- `packages/web/src/lib/ui/rack-status.ts` holds the banner and save-status
  decisions (`computeRackStatus`, `computeSaveStatus`, `shouldPromptUnsaved`) as
  pure functions of booleans the page feeds in — replica seeded, provider
  synced, elapsed time — so the timing logic is unit-tested without a browser.
- `packages/web/src/lib/ui/canvas/import-confirm.ts` gates the destructive
  import: an empty rack proceeds silently, a non-empty one **confirms**, and the
  copy says out loud that the wipe is multi-user.
- The file lives under `lib/storage`, deliberately **not** `lib/multiplayer`:
  this is a client-only single-user helper and has nothing to do with
  collaboration.

## Consequences

**Good:**

- A refresh on the scratch canvas now behaves like a refresh on a real rack.
- Editing is never blocked on persistence and nothing is flushed synchronously;
  the affordances are an indicator plus one confirm, not a lock.
- Because the decisions are pure functions, the "are we saved?" logic is
  covered by unit tests instead of by a manual pass over a browser.

**Bad / load-bearing:**

- **Per-device means per-device.** The scratch patch does not follow the user to
  another browser or machine, and clearing site data still loses it. That is the
  intended scope — the fix for durable, portable work is to open a real rack.
- A shared machine has no clear-scratch affordance yet, so the previous person's
  scratch patch is what the next person sees.
- Five follow-on decisions are open: whether to offer "import my scratch into
  this new rack"; the single-scratch-document shape; whether to keep the strict
  unload prompt or reduce it to an indicator; whether destructive Import should
  be restricted to owner/solo racks; and the clear-scratch affordance above.

## References

- `packages/web/src/lib/storage/local-scratch.ts` — the per-device id and the
  legacy-key prune.
- `packages/web/src/lib/ui/rack-status.ts`,
  `packages/web/src/lib/ui/canvas/import-confirm.ts` — the pure decisions.
- `packages/web/src/lib/multiplayer/local-replica.ts` — the replica this reuses.
- ADR-005 — persistence formats; ADR-001 — the CRDT whose tombstones make a
  destructive import multi-user.
- `runbooks/secrets-and-accounts.md`, `runbooks/integrations/fly.md` — the
  server-side memory-store and persist-mode settings the same review hardened.
- Provenance: preserved in the `myrobots-preserved-2026-09` tag snapshot, as
  `plans/rack-persistence-hardening-2026-07-19.md` (paths relative to the
  retired agent-evidence tree in that snapshot, not to the worktree).
