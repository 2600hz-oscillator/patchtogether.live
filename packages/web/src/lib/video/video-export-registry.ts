// packages/web/src/lib/video/video-export-registry.ts
//
// A tiny per-node registry of "resolve this VIDEOBOX node's loaded video bytes"
// callbacks, used by the portable Performance Bundle EXPORT path (Canvas.svelte
// → graph/performance-zip.ts).
//
// WHY a registry: a VIDEOBOX's actual video bytes live ONLY in the card-owned
// object URL (the engine factory never sees the file; node.data carries just
// fileMeta — name/size/duration/handleId). The pure bundle builder can't reach
// into a Svelte component, so each VideoboxCard registers a resolver keyed by
// its node id while it has a local file loaded, and unregisters on unload /
// destroy. The exporter calls every registered resolver to collect bytes.
//
// This mirrors TOYBOX's in-card resolveLayerVideos(fetch(objectUrl)) but lifts
// it to a module-level map so the top-level "Export performance" handler — which
// lives in Canvas, not in any one card — can gather bytes across ALL videobox
// cards on the rack. Dependency-free + DOM-free so it unit-tests cleanly.
//
// MULTI-SLOT (Fix B): VIDEOVARISPEED has a 7-slot "Load multiple…" selector,
// each slot a SEPARATE local video whose bytes live ONLY in a per-slot object
// URL (never on node.data — only per-slot fileMeta syncs). The single-result
// resolver dropped slots 1..6 from the portable .zip (only slot 0 travelled),
// so a perf with 7 videos lost 6 of them. A resolver may therefore return an
// ARRAY of per-slot results, each tagged with its `slot` index. The single
// VIDEOBOX path keeps returning ONE result (slot defaults to 0) — back-compat.

/** Resolves a node's currently-loaded video to raw bytes + a filename, or null
 *  when nothing is loaded (the resolver itself decides; e.g. object URL gone).
 *  `slot` identifies the asset slot (0 for the single-video VIDEOBOX path; 0..6
 *  for the VIDEOVARISPEED 7-slot selector). Defaults to 0 when omitted. */
export interface VideoExportResult {
  bytes: Uint8Array;
  name: string;
  /** Asset slot index (0..6). Omitted ⇒ slot 0 (single-video back-compat). */
  slot?: number;
}
/** A resolver yields either a single slot's bytes (single-video VIDEOBOX) or an
 *  array of per-slot results (the VIDEOVARISPEED 7-slot selector). */
export type VideoExportResolver = () => Promise<
  VideoExportResult | VideoExportResult[] | null
>;

const resolvers = new Map<string, VideoExportResolver>();

/** Register (or replace) a node's video-bytes resolver. Called by VideoboxCard
 *  once a local file is loaded. */
export function registerVideoExport(nodeId: string, resolver: VideoExportResolver): void {
  resolvers.set(nodeId, resolver);
}

/** Drop a node's resolver (file unloaded / card destroyed). Idempotent. */
export function unregisterVideoExport(nodeId: string): void {
  resolvers.delete(nodeId);
}

/** The node ids that currently have a resolver (a loaded video). */
export function registeredVideoExportNodeIds(): string[] {
  return [...resolvers.keys()];
}

/**
 * Resolve bytes for every registered node, FLATTENED to one entry PER POPULATED
 * SLOT. A resolver returning null / throwing / yielding empty bytes is skipped,
 * so a torn-down URL doesn't abort the whole export. Pure orchestration — the
 * resolvers do the I/O. Each entry carries its `slot` (0 for single-video).
 */
export async function resolveAllVideoExports(): Promise<
  Array<{ nodeId: string; slot: number; bytes: Uint8Array; name: string }>
> {
  const out: Array<{ nodeId: string; slot: number; bytes: Uint8Array; name: string }> = [];
  for (const [nodeId, resolve] of resolvers) {
    try {
      const r = await resolve();
      if (!r) continue;
      const results = Array.isArray(r) ? r : [r];
      for (const res of results) {
        if (!res || res.bytes.length === 0) continue;
        out.push({ nodeId, slot: res.slot ?? 0, bytes: res.bytes, name: res.name });
      }
    } catch {
      // Skip a node whose bytes can't be resolved (revoked URL, etc.).
    }
  }
  return out;
}

/** TEST-ONLY: clear all resolvers (so unit tests don't leak across cases). */
export function __clearVideoExportRegistry(): void {
  resolvers.clear();
}
