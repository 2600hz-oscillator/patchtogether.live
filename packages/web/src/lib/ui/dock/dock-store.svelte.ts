// packages/web/src/lib/ui/dock/dock-store.svelte.ts
//
// DOCKING — the LOCAL, reactive dock state (see ./dock.ts for the model).
//
// One module-scope singleton, like skinStore: dock state is per-tab view
// state, NEVER synced into the Y.Doc. Each zone holds at most ONE docked
// nodeId in P1 (the workflow bottom drawer's "one open at a time"), plus
// a per-zone content scale (default 1; no UI writes it yet — the seam the
// later "zoom a docked card independently of canvas zoom" lands on).
//
// Canvas calls `closeAll()` when a workflow rack mounts so a drawer left
// open in a previous rackspace never leaks across (nodeIds wouldn't
// resolve anyway — the container only renders when the node exists — but
// a clean slate keeps the M/E/C toggles predictable).

import {
  DEFAULT_DOCK_SCALE,
  isImplementedDockZone,
  toggleDockedId,
  type DockZone,
} from './dock';

class DockStore {
  /** Per-zone docked nodeId (single occupancy per zone in P1). */
  #docked = $state<Partial<Record<DockZone, string | null>>>({});
  /** Per-zone content scale (default DEFAULT_DOCK_SCALE; no UI yet). */
  #scale = $state<Partial<Record<DockZone, number>>>({});

  /** The nodeId docked in `zone`, or null. */
  dockedNodeId(zone: DockZone): string | null {
    return this.#docked[zone] ?? null;
  }

  /** True when anything is docked in any zone. */
  get anyOpen(): boolean {
    return Object.values(this.#docked).some((v) => v != null);
  }

  /** Toggle `nodeId` in `zone` (same id closes; different id replaces —
   *  one card per zone). Unimplemented zones are a typed no-op. */
  toggle(zone: DockZone, nodeId: string): void {
    if (!isImplementedDockZone(zone)) return;
    this.#docked[zone] = toggleDockedId(this.dockedNodeId(zone), nodeId);
  }

  /** Close `zone` (no-op when already empty). */
  close(zone: DockZone): void {
    if (this.#docked[zone] != null) this.#docked[zone] = null;
  }

  /** Close every zone (rack mount/unmount hygiene). */
  closeAll(): void {
    this.#docked = {};
  }

  /** Content scale for `zone` (default 1). */
  scaleFor(zone: DockZone): number {
    return this.#scale[zone] ?? DEFAULT_DOCK_SCALE;
  }

  /** Set a zone's content scale (no caller yet — the P2+ seam). Clamped
   *  to a sane band so a bad write can't render an invisible/giant card. */
  setScale(zone: DockZone, scale: number): void {
    if (!Number.isFinite(scale)) return;
    this.#scale[zone] = Math.min(4, Math.max(0.25, scale));
  }
}

/** The app-wide dock singleton (local view state — per tab). */
export const dockStore = new DockStore();
