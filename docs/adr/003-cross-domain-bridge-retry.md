# ADR-003: Cross-domain bridge ownership + retry contract

- Status: Accepted (initial fix shipped; PR #450 hardens retry coverage)
- Date: 2026-05-30
- Deciders: project owner
- Tags: audio, video, dataflow, lifecycle

## Context

The patch engine dispatches across two domain engines: `AudioEngine`
(Web Audio) and `VideoEngine` (WebGL2). Edges can cross domains in three
shapes, and one same-domain video shape needs the same machinery:

1. **audio → video CV / gate** — sampled by an `AnalyserNode`, pushed
   into `VideoEngine.setParam` each frame.
2. **audio → video texture** — the audio source publishes an analyser
   tap; the video engine registers a synthetic source node that draws
   the waveform texture into the target's input port.
3. **video → audio** — a video module exposes an `AudioNode` (e.g.
   DOOM's mixed-down game audio); the audio engine wires it into the
   audio graph.
4. **video → video CV / gate (same domain)** — DOOM's `evt_kill`
   gate pulse drives SCOREBOARD's `score` input; both ends are
   video-domain but the wire crosses module instances.

Each of these edge ids is owned **exclusively by the bridge** — neither
domain engine's own `edges` map sees it. The bridge owns the
`AudioNode` connection (or the `AnalyserNode` tap) lifetime, and
`removeEdge` must route to the bridge teardown rather than to either
engine.

The problem this ADR codifies: bridges can be requested **before the
target end is materialized** by its domain engine. Symptoms before the
fix:

- A cross-domain CV edge added while the audio source's `AudioNode`
  hadn't been built yet was silently dropped.
- A video → audio bridge wired during VIDEOBOX/VIDEOVARISPEED bootstrap
  caught the *silent placeholder* AudioNode and never re-resolved when
  the live `MediaElementAudioSourceNode` replaced it — the user heard
  silence.

## Decision

The `PatchEngine` (`packages/web/src/lib/audio/engine.ts:646+`)
maintains a per-shape registry of bridge-owned edge ids and an Edge
re-resolution map:

- `cvBridgeEdgeIds: Set<edgeId>` (audio → video CV)
- `videoTextureBridgeEdgeIds: Set<edgeId>` (audio → video texture)
- `audioBridgeEdgeIds: Set<edgeId>` (video → audio)
- `audioBridgeTeardowns: Map<edgeId, () => void>` (per-edge teardown)
- `audioBridgeEdges: Map<edgeId, Edge>` (Edge objects retained for
  re-resolution)
- `sameDomainVideoCvBridgeEdgeIds: Set<edgeId>` (video.gate → video CV)

Contract:

1. **Defer-on-miss.** `addCrossDomainCvBridge` (and siblings) check
   that both ends are present and materialized. If the source's
   AudioNode handle isn't ready yet, the bridge marks the edge in the
   appropriate set as "owed" and returns without wiring. The next
   reconcile pass that touches the edge re-attempts.
2. **Re-resolve on port-handle change.** The video engine fires
   `onAudioSourcesChanged(nodeId)` when a module publishes a new
   AudioNode for any of its declared `audioSources` ports. The
   PatchEngine handler iterates `audioBridgeEdges` and rebuilds any
   bridge whose source matches — tearing down the old connection
   first (`packages/web/src/lib/audio/engine.ts:721`).
3. **Symmetric teardown.** `removeEdge` consults the per-shape sets
   before falling through to either domain engine, so a bridge edge
   is destroyed once and only once. `removeNode` cascades to all
   bridges touching the removed node.
4. **No-leak invariant.** Every code path that adds an edge to a
   bridge set has a paired removal path; the property-style tests
   in `engine-removeNode-leak.test.ts` (full add → remove cycles)
   pin "no AudioParam connections remain" and "no AnalyserNode taps
   remain" after teardown.

## Consequences

**Good:**

- Patch construction order no longer matters: you can add edges
  before, during, or after the source / target nodes materialize.
- Modules that swap their published AudioNode mid-life (VIDEOBOX
  replacing its placeholder with the live MediaElementSource) get
  their bridges re-resolved automatically.
- Bookkeeping is per-shape so each bridge type's teardown path is
  obvious and unit-testable.

**Bad / load-bearing:**

- **Bridge add is idempotent on edge id, not on (source, target)
  tuple.** If you delete and re-add an edge with the same id without
  going through `removeEdge`, the second add silently no-ops because
  the id is already in the set. Always go through `removeEdge`.
- **Domain engines must not route bridge-owned edges to their internal
  `edges` map.** The PatchEngine guards this at dispatch; module
  authors who write a new bridge shape must add the same guard. The
  `addEdge` call signature pattern (check `*BridgeEdgeIds.has(id)`
  first, then route) is the contract.
- **`addCrossDomainCvBridge`'s `cvBridgeEdgeIds.add(edge.id)` on the
  defer path is a sentinel only — the bridge is NOT yet active.**
  The current implementation relies on the reconciler re-calling
  `addEdge` on a subsequent pass (which happens when the edge or
  source changes). The Codex-audit fix in PR #450 makes the retry
  unconditional on source-materialization, removing the implicit
  dependency on edge-set churn.
- **Same-domain video CV bridges share this machinery** because the
  same problem (source not yet materialized + needs analyser tap)
  applies even within one engine.

## References

- `packages/web/src/lib/audio/engine.ts:646-744` — bridge id sets +
  `reapplyAudioBridgesForSource`.
- `packages/web/src/lib/audio/engine.ts:907-1095` — bridge add/remove
  implementations (audio→video CV, video→audio, etc.).
- `packages/web/src/lib/audio/engine-cv-video-bridge.test.ts` —
  audio→video CV path.
- `packages/web/src/lib/audio/engine-video-audio-bridge.test.ts` —
  video→audio path + re-resolution on port-handle change.
- `packages/web/src/lib/audio/engine-same-domain-video-cv-bridge.test.ts`
  — same-domain video CV.
- `packages/web/src/lib/audio/engine-removeNode-leak.test.ts` —
  no-leak invariant on teardown.
- PR #450 — Codex audit fix: unconditional retry on late
  materialization (in flight at time of writing).
- ADR-001, ADR-002.
