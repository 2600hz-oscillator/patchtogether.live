# ADR-005: Persistence formats — server Y-state vs. envelope JSON

- Status: Accepted
- Date: 2026-05-30
- Deciders: project owner
- Tags: persistence, export, modules

## Context

The patch graph needs to persist in three distinct contexts:

1. **Server-side, per rackspace** — Hocuspocus needs to snapshot the
   current Y-state to Postgres so a rackspace survives all
   collaborators disconnecting.
2. **Local export / import** — a user clicks "Save Local Performance"
   and downloads a portable JSON file they can re-load later or share
   off-platform.
3. **Performance bundles** — a superset of (2) that adds asset metadata
   for VRT pads / camera profiles / OPFS-backed media so a performance
   can round-trip across machines.

The temptation is to define one format and use it everywhere. We tried
the inverse — let each context use the shape that's natural for it —
and it's worked out. This ADR codifies why and what the shared invariant
actually is.

## Decision

There are **two storage shapes**, both backed by the same Yjs source of
truth:

### Shape 1 — raw Y-state bytes (server-side)

`packages/server/src/db.ts` stores the result of
`Y.encodeStateAsUpdate(ydoc)` as a `bytea` column in `rack_snapshots`
keyed by `rack_id`. This is the natural Hocuspocus persistence
format. It is opaque (you can't `jq` it) but round-trips perfectly,
including per-node `data` blobs and the full op history. One row per
rackspace; upsert on save.

### Shape 2 — `PatchEnvelope` JSON (export / import)

`packages/web/src/lib/graph/persistence.ts` defines:

```ts
interface PatchEnvelope {
  envelopeVersion: typeof ENVELOPE_VERSION;
  savedAt: string;                              // ISO 8601
  moduleSchemas: Record<string, number>;        // type → schemaVersion at save time
  update: string;                               // base64-encoded Y.encodeStateAsUpdate
}
```

`makeEnvelope(ydoc)` produces it; `parseEnvelope(json)` validates +
returns it; `loadEnvelope(env, ydoc)` applies the embedded update +
runs per-module migrations against `moduleSchemas`. The `update` field
**is the same Y.encodeStateAsUpdate bytes** as shape 1, base64-wrapped.

`PerformanceBundle` (`packages/web/src/lib/graph/performance-bundle.ts`)
is a strict superset — the bundle has a `patch: PatchEnvelope` field
and adds asset-metadata fields around it.

### The shared invariant

**Every module that needs to persist binary blob state writes it to
`node.data` as a serializable value (base64 string, plain object,
etc.).** Because `node.data` is part of the patch graph, it round-trips
through both shapes for free — the server snapshot includes it, the
envelope JSON includes it, the performance bundle includes it. No
side-channel storage, no asset references to chase.

Concrete examples:

- `PICTUREBOX` stores `data.imageBytes` (base64 PNG/JPEG), `imageMime`,
  `imageName` — see `packages/web/src/lib/video/modules/picturebox.ts:85`.
  Shipped in PR #441.
- `SAMSLOOP` stores `data.sample` (downsampled PCM) plus
  `data.sampleRate` / `data.channels` / `data.bitDepth` — see
  `packages/web/src/lib/audio/modules/samsloop.ts:43+`. Shipped in
  PR #451.

Transient runtime-only fields (in-memory decoded buffers, etc.) are
stripped on envelope serialization via `TRANSIENT_DATA_FIELDS_BY_TYPE`
in `persistence.ts:79+`, so they never bloat the export.

## Consequences

**Good:**

- One source of truth (the Y.Doc) feeds two consumers without a
  separate serializer per shape.
- Modules opt in to persistence by writing to `node.data`. No
  per-module save/load handlers; no asset registry to update.
- Server-side persistence is the Hocuspocus-native shape — zero
  conversion cost on save, no schema drift between in-process and
  on-disk state.
- Envelope JSON is self-contained — a downloaded `.imp.json` file
  carries every byte needed to reconstruct the patch, including
  user-uploaded images and samples.

**Bad / load-bearing:**

- **Modules must NOT store binary state in a `Y.Map` of bytes** —
  Yjs doesn't have a `bytes` type and large arrays of numbers are
  the bookkeeping nightmare. Use base64 strings on `node.data`
  instead.
- **`node.data` writes still need `transact(fn, LOCAL_ORIGIN)`** to
  participate in Undo correctly (ADR-001). A naked proxy write to
  `node.data.imageBytes = '…'` skips the Undo capture.
- **Schema migrations are per-module, version-gated.** Modules carry
  `schemaVersion: N`; `moduleSchemas` in the envelope tells the
  loader which migration step to start from. Adding a field to
  `data` requires bumping `schemaVersion` and writing a migrator —
  see PICTUREBOX's v1 → v2 migration as a template.
- **Server snapshots and envelope exports are NOT interchangeable
  files.** A `bytea` blob from Postgres is the raw Y-update; a `.imp.json`
  is the base64-wrapped + JSON-framed superset. Tooling that wants
  one from the other goes through `Y.applyUpdate` + `makeEnvelope`.
- **Envelope size scales with `node.data` size.** A 5MB sample
  embedded in `data` makes every envelope 5MB. PerformanceBundle's
  asset-reference fields (`packages/web/src/lib/graph/performance-bundle.ts`)
  exist for the case where assets are too big to inline; this is the
  exit hatch when the trade-off bites.

## References

- `packages/server/src/db.ts:114-150` — `loadSnapshot` / `storeSnapshot`
  (shape 1, raw Y-state).
- `packages/web/src/lib/graph/persistence.ts:93+` — `PatchEnvelope`
  interface; `:154` `makeEnvelope`; `:197` `parseEnvelope`.
- `packages/web/src/lib/graph/performance-bundle.ts` — bundle
  superset.
- `packages/web/src/lib/video/modules/picturebox.ts:81-140` —
  schemaVersion 2 with `imageBytes` (PR #441).
- `packages/web/src/lib/audio/modules/samsloop.ts:43+` — PCM-on-data
  (PR #451).
- ADR-001 — Yjs as the underlying CRDT.
- ADR-002 — per-rackspace doc lifecycle (the in-memory Y.Doc that
  produces the snapshot).
