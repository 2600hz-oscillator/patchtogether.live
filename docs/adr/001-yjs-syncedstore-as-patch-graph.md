# ADR-001: Yjs + SyncedStore as the patch graph

- Status: Accepted
- Date: 2026-05-30
- Deciders: project owner
- Tags: persistence, multiplayer, undo

## Context

The patch graph (nodes + edges + per-node params + per-node `data` blobs)
is the central shared state of the app. It needs to:

- be edited concurrently by up to 4 users in the same rackspace
- survive every collaborator disconnecting (server-side persistence)
- support local-only / offline edits with deterministic merge on
  reconnect
- power a multi-step Undo / Redo that doesn't tangle with other users'
  edits

Local-author-then-broadcast (last-write-wins on a key/value store) is the
simplest option but loses concurrent edits and forces a custom undo
stack. A custom OT layer is more work than buying it. CRDTs are the
right shape; the open question was which library.

Yjs is the most mature browser-native CRDT, with first-party providers
for WebSocket relays (Hocuspocus), WebRTC peer mesh, and IndexedDB local
persistence. Its `UndoManager` is built around a per-edit `origin` token,
which gives us the "my undo only undoes my edits" behavior for free.
SyncedStore wraps the raw Y.Doc as a Svelte-friendly reactive proxy.

## Decision

We use **Yjs** as the CRDT, **SyncedStore** as the reactive proxy, and
**Hocuspocus** as the relay.

The shape is:

```ts
type PatchStore = {
  nodes: Record<string, ModuleNode>;
  edges: Record<string, Edge>;
};
```

Every local mutation runs inside
`ydoc.transact(fn, LOCAL_ORIGIN)` so the `UndoManager` can distinguish
own edits from remote edits (see `packages/web/src/lib/graph/store.ts:39`).

For v1 the relay is a single Hocuspocus Fly machine pinned to 1
instance, with Postgres for snapshot persistence. P2P (y-webrtc primary
+ relay fallback) is the future direction but deferred until the relay
setup is stable.

## Consequences

**Good:**

- Concurrent edits merge automatically — no app-level conflict code.
- `Y.UndoManager` with `trackedOrigins: [LOCAL_ORIGIN]` gives correct
  multiplayer undo semantics out of the box.
- IndexedDB providers are first-party; offline-mode comes nearly free.
- The Hocuspocus snapshot blob is a single `Uint8Array` we can store
  in Postgres without inventing a schema (see ADR-005).

**Bad / load-bearing:**

- Every mutation **must** use `ydoc.transact(fn, LOCAL_ORIGIN)`. A
  direct proxy write without a transact-with-origin gets folded into
  whatever transaction Yjs synthesizes for it and is mis-attributed
  to remote — Undo will skip it. Treat raw proxy writes as a bug.
- The Hocuspocus relay is a **SPOF for v1**. If it dies, real-time
  sync stops (local editing continues; reconnect re-merges). Mitigated
  by pinning to one Fly machine + monitoring; ADR-supersession is
  planned once P2P is wired (see Memory `project_p2p_sync_future`).
- SyncedStore proxies are *not* plain objects — `Object.entries()`
  works, but spread-clones and structuredClone trip on them. The
  snapshot bus (ADR-002 + `graph/snapshot.ts`) is the safe boundary;
  consumers should not poke `patch.nodes` directly for read-modify
  flows.
- Module-specific binary blobs (sample bytes, image bytes) live in
  `node.data` so they ride the same CRDT envelope to all rack-mates
  and to disk. See ADR-005.

## References

- `packages/web/src/lib/graph/store.ts` — `createPatch`, `LOCAL_ORIGIN`,
  `createUndoManager`, `bindRackspace`.
- `packages/web/src/lib/graph/snapshot.ts` — single subscription point
  for the patch (ADR-002).
- `packages/web/src/lib/graph/persistence.ts` — `PatchEnvelope` shape
  (ADR-005).
- ADR-002 — per-rackspace Y.Doc binding pattern.
- ADR-005 — persistence formats.
- Memory `project_p2p_sync_future` — future direction (P2P).
- Memory `relay-single-process-and-drift` — current Hocuspocus SPOF
  constraints.
