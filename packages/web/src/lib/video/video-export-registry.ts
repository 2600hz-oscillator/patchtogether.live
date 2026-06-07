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

/** Resolves a node's currently-loaded video to raw bytes + a filename, or null
 *  when nothing is loaded (the resolver itself decides; e.g. object URL gone). */
export interface VideoExportResult {
  bytes: Uint8Array;
  name: string;
}
export type VideoExportResolver = () => Promise<VideoExportResult | null>;

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
 * Resolve bytes for every registered node. Returns one entry per node that
 * successfully yielded bytes (a resolver returning null / throwing is skipped,
 * so a torn-down URL doesn't abort the whole export). Pure orchestration — the
 * resolvers do the I/O.
 */
export async function resolveAllVideoExports(): Promise<
  Array<{ nodeId: string; bytes: Uint8Array; name: string }>
> {
  const out: Array<{ nodeId: string; bytes: Uint8Array; name: string }> = [];
  for (const [nodeId, resolve] of resolvers) {
    try {
      const r = await resolve();
      if (r && r.bytes.length > 0) out.push({ nodeId, bytes: r.bytes, name: r.name });
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
