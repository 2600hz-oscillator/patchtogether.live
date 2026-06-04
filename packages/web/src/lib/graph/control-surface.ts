// packages/web/src/lib/graph/control-surface.ts
//
// CONTROL SURFACE — data model + helpers.
//
// A Control Surface is a meta-domain node that aggregates POINTERS to other
// modules' controls (and, later, screens). Each "binding" is just a
// (moduleId, paramId) pair — NOT a copy of state. A proxied control on the
// surface reads + writes the SOURCE module's live param directly
// (patch.nodes[moduleId].params[paramId]) and is keyed for MIDI by the same
// moduleId:paramId, so:
//   - a MIDI assignment on the proxy === the assignment on the source,
//   - the same control can live on multiple surfaces (all pointers),
//   - there is no per-proxy state that can drift out of sync.
//
// Because the source node stays present + live in patch.nodes even when it is
// collapsed inside a Group, proxied controls keep working when the underlying
// module is folded away — which is the whole point.
//
// All persistent state lives on the surface node's `data` (Yjs-synced):
//   data.name      — display name (shown in the "Send to ..." menu + box)
//   data.bindings  — Array<{moduleId, paramId}> (control pointers)
//   data.screens   — Array<{moduleId}> (scope screens portaled onto the surface)
//   data.layout    — Record<moduleId, {x, y}> (per-module-group box position)
//   data.locked    — boolean (true = boxes frozen; false = draggable)

import { patch, ydoc, LOCAL_ORIGIN } from '$lib/graph/store';
import type { ModuleNode } from '$lib/graph/types';

export const CONTROL_SURFACE_TYPE = 'controlSurface';

export interface ControlBinding {
  moduleId: string;
  paramId: string;
}

export interface ScreenBinding {
  moduleId: string;
}

export interface GroupBox {
  x: number;
  y: number;
}

export interface ControlSurfaceData {
  name?: string;
  bindings?: ControlBinding[];
  screens?: ScreenBinding[];
  layout?: Record<string, GroupBox>;
  locked?: boolean;
}

/** A module's controls grouped under its source module, in first-seen order. */
export interface BindingGroup {
  moduleId: string;
  bindings: ControlBinding[];
}

// ──────────────────────────── pure readers ────────────────────────────

/** Coerce a node's `data` into a typed ControlSurfaceData (never throws). */
export function readSurfaceData(node: { data?: unknown } | undefined): ControlSurfaceData {
  const d = node?.data;
  if (!d || typeof d !== 'object') return {};
  return d as ControlSurfaceData;
}

/** Display name for a surface (falls back to a stable default). */
export function surfaceName(node: { data?: unknown } | undefined): string {
  const name = readSurfaceData(node).name;
  return typeof name === 'string' && name.trim().length > 0 ? name : 'Control Surface';
}

/** Every control-surface node in the patch, in stable id order, with its name. */
export function listControlSurfaces(
  nodes: Record<string, ModuleNode | undefined>,
): Array<{ id: string; name: string }> {
  const out: Array<{ id: string; name: string }> = [];
  for (const [id, node] of Object.entries(nodes)) {
    if (!node || node.type !== CONTROL_SURFACE_TYPE) continue;
    out.push({ id, name: surfaceName(node) });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

export function bindingKey(moduleId: string, paramId: string): string {
  return `${moduleId}:${paramId}`;
}

export function hasBinding(data: ControlSurfaceData, moduleId: string, paramId: string): boolean {
  return (data.bindings ?? []).some((b) => b.moduleId === moduleId && b.paramId === paramId);
}

export function hasScreen(data: ControlSurfaceData, moduleId: string): boolean {
  return (data.screens ?? []).some((s) => s.moduleId === moduleId);
}

/** Append a binding, deduped by moduleId:paramId. Returns a NEW bindings array. */
export function withBindingAdded(
  data: ControlSurfaceData,
  moduleId: string,
  paramId: string,
): ControlBinding[] {
  const existing = data.bindings ?? [];
  if (hasBinding(data, moduleId, paramId)) return existing.slice();
  return [...existing, { moduleId, paramId }];
}

export function withBindingRemoved(
  data: ControlSurfaceData,
  moduleId: string,
  paramId: string,
): ControlBinding[] {
  return (data.bindings ?? []).filter((b) => !(b.moduleId === moduleId && b.paramId === paramId));
}

export function withScreenAdded(data: ControlSurfaceData, moduleId: string): ScreenBinding[] {
  const existing = data.screens ?? [];
  if (hasScreen(data, moduleId)) return existing.slice();
  return [...existing, { moduleId }];
}

export function withScreenRemoved(data: ControlSurfaceData, moduleId: string): ScreenBinding[] {
  return (data.screens ?? []).filter((s) => s.moduleId !== moduleId);
}

/** Group bindings by their source module, preserving first-seen module order. */
export function groupBindingsByModule(bindings: ControlBinding[]): BindingGroup[] {
  const order: string[] = [];
  const byModule = new Map<string, ControlBinding[]>();
  for (const b of bindings) {
    let g = byModule.get(b.moduleId);
    if (!g) {
      g = [];
      byModule.set(b.moduleId, g);
      order.push(b.moduleId);
    }
    g.push(b);
  }
  return order.map((moduleId) => ({ moduleId, bindings: byModule.get(moduleId)! }));
}

// ─────────────────────── ydoc mutators (side-effecting) ───────────────────────
//
// Each writes the WHOLE replacement array/value back onto the surface node's
// data inside a single Yjs transaction tagged LOCAL_ORIGIN (so the local
// reconciler treats it as a user edit). Reads go through the live patch proxy.

function mutateSurface(surfaceId: string, fn: (data: ControlSurfaceData) => void): void {
  ydoc.transact(() => {
    const target = patch.nodes[surfaceId];
    if (!target) return;
    if (!target.data) target.data = {};
    fn(target.data as ControlSurfaceData);
  }, LOCAL_ORIGIN);
}

export function addBindingToSurface(surfaceId: string, moduleId: string, paramId: string): void {
  mutateSurface(surfaceId, (data) => {
    data.bindings = withBindingAdded(data, moduleId, paramId);
  });
}

export function removeBindingFromSurface(surfaceId: string, moduleId: string, paramId: string): void {
  mutateSurface(surfaceId, (data) => {
    data.bindings = withBindingRemoved(data, moduleId, paramId);
  });
}

export function addScreenToSurface(surfaceId: string, moduleId: string): void {
  mutateSurface(surfaceId, (data) => {
    data.screens = withScreenAdded(data, moduleId);
  });
}

export function removeScreenFromSurface(surfaceId: string, moduleId: string): void {
  mutateSurface(surfaceId, (data) => {
    data.screens = withScreenRemoved(data, moduleId);
  });
}

export function setSurfaceLocked(surfaceId: string, locked: boolean): void {
  mutateSurface(surfaceId, (data) => {
    data.locked = locked;
  });
}

export function setSurfaceGroupPosition(surfaceId: string, moduleId: string, x: number, y: number): void {
  mutateSurface(surfaceId, (data) => {
    const layout = { ...(data.layout ?? {}) };
    layout[moduleId] = { x, y };
    data.layout = layout;
  });
}

/** Drop any bindings/screens whose source module no longer exists in the patch.
 *  Pure — returns the cleaned arrays so the caller can decide whether to write. */
export function pruneDangling(
  data: ControlSurfaceData,
  nodes: Record<string, ModuleNode | undefined>,
): { bindings: ControlBinding[]; screens: ScreenBinding[] } {
  return {
    bindings: (data.bindings ?? []).filter((b) => !!nodes[b.moduleId]),
    screens: (data.screens ?? []).filter((s) => !!nodes[s.moduleId]),
  };
}
