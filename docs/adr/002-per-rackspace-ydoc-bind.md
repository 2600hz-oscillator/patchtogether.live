# ADR-002: Per-rackspace Y.Doc + bindRackspace pattern

- Status: Accepted (fixed in PR #432; snapshot-bus rebind in follow-up)
- Date: 2026-05-30
- Deciders: project owner
- Tags: multiplayer, lifecycle, sync

## Context

A user can own up to four rackspaces and switch between them via the
SvelteKit route `/r/[id]`. Each rackspace is its own collaborative
document with its own Hocuspocus room.

Originally, `packages/web/src/lib/graph/store.ts` exported a singleton
`patch` / `ydoc` / `undoManager` triple created once at module import.
Navigating `/r/A` → `/r/B` reused the **same** Y.Doc for B but attached
a fresh provider pointing at room B. The doc still held A's nodes and
edges, so the provider promptly uploaded A's contents into B's room,
corrupting B for every participant. The user-visible report was "my
edits leak across all 4 rackspaces" — see PR #432 for the full
post-mortem.

A naive fix — `createPatch()` once per rackspace mount and pass it
through Svelte context — required threading the patch object through
every audio/video consumer that imports `patch` at the module level
(the audio engine, the snapshot bus, the UI components, the test
hooks). That's a lot of churn and many opportunities to miss a site.

## Decision

The store keeps `patch` / `ydoc` / `undoManager` as `let` exports (live
ESM bindings) and exposes:

- `createPatch()` — returns a fresh `{ patch, ydoc, undoManager }`
  triple.
- `bindRackspace(rackspaceId)` — destroys the previous bundle, swaps in
  a fresh one, fires `onBindRackspace` listeners, and refreshes
  dev-only `window.__patch` / `window.__ydoc` test hooks. Idempotent
  for the same id.
- `unbindRackspace()` — symmetric teardown on navigation away.
- `onBindRackspace(cb)` — pub/sub for modules that captured
  `(patch, ydoc)` by closure and need to re-point their internal
  listeners.

Every consumer that captured `patch`/`ydoc` at construction time
(the snapshot bus is the main one) must subscribe to `onBindRackspace`
and **re-point its internal Yjs listeners at the new doc**. The
snapshot bus also re-emits a fresh snapshot synchronously inside
`rebind()` so subscribers see the new doc's contents on the same tick.

The rackspace page wraps `<Canvas>` in `{#key data.rackspace.id}` so
Svelte reactivity that does not auto-rerun on a non-rune reassignment
(notably `$effect` capturing the module-scope `let`) tears down + remounts.

`bindRackspace()` **must** be called BEFORE the HocuspocusProvider
attaches for the rackspace. Otherwise the still-bound previous bundle's
contents get uploaded into the new room (the bug we just described).

## Consequences

**Good:**

- One singleton patch surface for all import sites — no Svelte context
  threading required. ESM live bindings + a `{#key}` remount are
  enough for Svelte; the explicit `onBindRackspace` event covers
  non-Svelte consumers (the audio engine reconciler, the snapshot
  bus, test harness).
- Rackspace switches are O(1) — destroy the old `Y.Doc` and build a
  new empty one; no incremental cleanup needed.

**Bad / load-bearing:**

- **Any module that holds a `Y.Doc` reference past a bind has a dead
  ref.** Modules must either re-read `ydoc` from the live import on
  every use, or subscribe to `onBindRackspace` and replace their
  cached ref. The snapshot bus is the canonical example
  (`packages/web/src/lib/graph/snapshot.ts:144`).
- **Same applies to UndoManager refs.** Anyone caching `undoManager`
  across mounts will be operating on a destroyed instance.
- **The rebind chain is load-bearing.** When PR #432 first shipped, it
  missed propagating the rebind through the snapshot bus singleton,
  which manifested as `@collab clear+load-multiwindow` failing — the
  bus stayed attached to the destroyed first-rackspace doc and the
  reconciler never saw updates. The follow-up commit added
  `SnapshotBus.rebind()` + the `onBindRackspace` subscriber wire-up.
  Any future consumer that captures `(patch, ydoc)` by closure has the
  same trap.
- Dev-only `window.__patch` / `window.__ydoc` globals must be
  refreshed in `bindRackspace` because Canvas.svelte's mount-time
  `$effect` doesn't rerun on a module-scope `let` reassignment. The
  e2e harness reads these.

## References

- `packages/web/src/lib/graph/store.ts` — `bindRackspace`,
  `unbindRackspace`, `onBindRackspace`.
- `packages/web/src/lib/graph/snapshot.ts:135` — `getDefaultSnapshotBus`
  registers with `onBindRackspace`; `:206` is the `rebind` impl.
- `packages/web/src/lib/graph/store-bind.test.ts` — unit coverage.
- PR #432 — initial fix (per-rackspace doc).
- PR #432 follow-up commit — snapshot-bus rebind.
- ADR-001 — Yjs as the underlying CRDT.
