// packages/web/src/lib/media/asset-links.svelte.ts
//
// WORKFLOW MODE P3 — the assetId ↔ nodeId[] link map behind the Loaded
// Assets Picker behaviors: patched-row highlight, drag-from-existing
// (a new wire from the EXISTING module, not a second module), "add
// additional output module", and unload-deletes-linked-modules.
//
// PLACEMENT: LOCAL, per-tab (module-scope runes singleton — the
// dock-store pattern), NOT synced into the Y.Doc. Why local-first:
//
//   * Media itself is session-local (object URLs owned by
//     lib/media/library.svelte.ts) — asset ids like `media-3` only mean
//     anything in THIS tab. Syncing a map keyed by them would hand
//     collaborators dangling references to files they don't have, and
//     every link write would be CRDT churn for purely-local view state
//     (which color a picker row renders, which module a click drags
//     from). Same discipline as [[cv-modulation-live-store-write-storm]]:
//     transient/per-tab state never becomes a synced write.
//
//   * The DURABLE half lives where it belongs — on the (synced) module
//     node itself as `data.mediaDesc` (asset-modules.ts). Any client
//     that later loads a dupe-key-matching file can rebuild its own
//     local links independently (the rebind sweep in asset-spawn.ts),
//     so nothing is lost by not syncing this map.
//
// Rackspace scoping: Canvas remounts per rackspace ({#key rackspace.id})
// and calls `clear()` on mount/unmount — exactly the dockStore.closeAll()
// hygiene — so links never leak across rackspaces.
//
// ORDER MATTERS: nodesFor()[0] is the PRIMARY module — the one subsequent
// clicks/drags reuse. "Add additional output module" appends; the extra
// module is for manual patching only.

class AssetLinks {
  /** assetId → ordered nodeIds ([0] = primary). */
  #links = $state<Record<string, string[]>>({});

  /** Link `nodeId` to `assetId` (appends; no-op when already linked). */
  register(assetId: string, nodeId: string): void {
    const cur = this.#links[assetId];
    if (!cur) {
      this.#links[assetId] = [nodeId];
      return;
    }
    if (!cur.includes(nodeId)) cur.push(nodeId);
  }

  /** All nodeIds linked to `assetId`, in creation order. */
  nodesFor(assetId: string): readonly string[] {
    return this.#links[assetId] ?? [];
  }

  /** The primary (first-created) module for `assetId`, or null. */
  primaryFor(assetId: string): string | null {
    return this.#links[assetId]?.[0] ?? null;
  }

  /** True when at least one module is linked to `assetId`. */
  isLinked(assetId: string): boolean {
    return (this.#links[assetId]?.length ?? 0) > 0;
  }

  /** The assetId `nodeId` is linked to, or null. */
  assetForNode(nodeId: string): string | null {
    for (const [assetId, nodes] of Object.entries(this.#links)) {
      if (nodes.includes(nodeId)) return assetId;
    }
    return null;
  }

  /** Remove one node from whatever asset holds it (module deleted). */
  unregisterNode(nodeId: string): void {
    for (const [assetId, nodes] of Object.entries(this.#links)) {
      const idx = nodes.indexOf(nodeId);
      if (idx < 0) continue;
      if (nodes.length === 1) {
        delete this.#links[assetId];
      } else {
        nodes.splice(idx, 1);
      }
      return;
    }
  }

  /** Drop every link for `assetId` (asset unloaded). */
  unregisterAsset(assetId: string): void {
    if (this.#links[assetId]) delete this.#links[assetId];
  }

  /** Drop links whose node no longer exists (delete-by-any-path sweep).
   *  Canvas calls this when the node set changes structurally. */
  pruneMissing(liveNodeIds: ReadonlySet<string>): void {
    for (const [assetId, nodes] of Object.entries(this.#links)) {
      const alive = nodes.filter((id) => liveNodeIds.has(id));
      if (alive.length === nodes.length) continue;
      if (alive.length === 0) {
        delete this.#links[assetId];
      } else {
        this.#links[assetId] = alive;
      }
    }
  }

  /** Rackspace mount/unmount hygiene (see header). */
  clear(): void {
    this.#links = {};
  }
}

/** Test seam / multi-instance factory. */
export function createAssetLinks(): AssetLinks {
  return new AssetLinks();
}

/** The per-tab singleton (local view/bookkeeping state — never synced). */
export const assetLinks = createAssetLinks();

export type { AssetLinks };
