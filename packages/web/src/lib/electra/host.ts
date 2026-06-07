// packages/web/src/lib/electra/host.ts
//
// LIVE HOST WIRING — builds the AutoconfigHost from the running app (patch store,
// engine, registries, control-surface bindings). Kept out of the orchestrator so
// autoconfig.ts / preset.ts / feedback.ts stay pure + unit-testable; this is the
// thin glue the UI component (ElectraConnectButton) uses.
//
// REUSES AS-IS: control-surface listing + groupBindingsByModule, resolveSurfaceParam
// (the SAME adapter the surface card + MIDI use), engine.readParam / read, the
// patch store singleton, the registries.

import { patch } from '$lib/graph/store';
import type { ModuleNode } from '$lib/graph/types';
import { getModuleDef } from '$lib/audio/module-registry';
import type { PatchEngine } from '$lib/audio/engine';
import {
  listControlSurfaces,
  readSurfaceData,
  groupBindingsByModule,
  type ControlBinding,
} from '$lib/graph/control-surface';
import { resolveSurfaceParam } from '$lib/graph/control-surface-params';
import type { AutoconfigHost } from './autoconfig';
import type { PresetGenInput, GenParamDef, SurfaceBinding } from './preset';

/** Find the first control surface's flattened bindings (first-seen module
 *  order). Falls back to an empty list (the page is still generated). */
function firstSurfaceBindings(): SurfaceBinding[] {
  const surfaces = listControlSurfaces(patch.nodes);
  if (surfaces.length === 0) return [];
  const node = patch.nodes[surfaces[0]!.id];
  const data = readSurfaceData(node);
  const grouped = groupBindingsByModule((data.bindings ?? []) as ControlBinding[]);
  const out: SurfaceBinding[] = [];
  for (const g of grouped)
    for (const b of g.bindings)
      out.push({ moduleId: b.moduleId, paramId: b.paramId, name: b.name });
  return out;
}

function findSingleton(type: string): string | null {
  for (const [id, n] of Object.entries(patch.nodes)) {
    if (n?.type === type) return id;
  }
  return null;
}

function moduleLabel(moduleId: string): string {
  const n = patch.nodes[moduleId];
  if (!n) return moduleId;
  return getModuleDef(n.type)?.label ?? n.type;
}

/** Build the generator input from the live patch. */
export function buildLiveGenInput(): PresetGenInput {
  return {
    surfaceBindings: firstSurfaceBindings(),
    moduleLabel,
    resolveParamDef: (moduleId, paramId): GenParamDef | null => {
      const node = patch.nodes[moduleId] as ModuleNode | undefined;
      const def = resolveSurfaceParam(node, paramId)?.def;
      if (!def) return null;
      return {
        id: def.id,
        label: def.label,
        min: def.min,
        max: def.max,
        defaultValue: def.defaultValue,
        curve: def.curve,
        units: def.units,
      };
    },
    mixmstrsId: findSingleton('mixmstrs'),
    timelordeId: findSingleton('timelorde'),
    name: 'patchtogether',
  };
}

/** Build the full live host for the orchestrator. `getEngine` is the
 *  engine-context getter from the component. `luaSource` is the bundled Lua
 *  layer (imported as a raw string in the component). */
export function buildLiveHost(args: {
  getEngine: () => PatchEngine | null;
  luaSource: string;
}): AutoconfigHost {
  const { getEngine, luaSource } = args;
  const tlId = () => findSingleton('timelorde');

  return {
    buildGenInput: buildLiveGenInput,

    readParamValue(key) {
      const i = key.indexOf(':');
      if (i < 0) return undefined;
      const moduleId = key.slice(0, i);
      const paramId = key.slice(i + 1);
      const node = patch.nodes[moduleId] as ModuleNode | undefined;
      const e = getEngine();
      if (!node || !e) return undefined;
      // SYSTEM page reads measuredBpm / source via engine.read; everything else
      // is a plain readParam (live, CV-inclusive).
      return e.readParam(node, paramId);
    },

    readMeterAmp(key) {
      // key forms: "<mx>:meter:<n>" or "<mx>:meter:master".
      const parts = key.split(':');
      if (parts.length < 3 || parts[1] !== 'meter') return undefined;
      const mxId = parts[0]!;
      const which = parts[2]!;
      const e = getEngine();
      if (!e) return undefined;
      if (which === 'master') {
        const ao = findSingleton('audioOut');
        const aoNode = ao ? (patch.nodes[ao] as ModuleNode | undefined) : undefined;
        if (!aoNode) return undefined;
        const snap = e.read(aoNode, 'outputSnapshot') as
          | { samples: Float32Array }
          | undefined;
        if (!snap) return undefined;
        let s = 0;
        for (let i = 0; i < snap.samples.length; i++) s += snap.samples[i]! * snap.samples[i]!;
        return Math.sqrt(s / snap.samples.length);
      }
      const ch = Number(which);
      if (!Number.isFinite(ch) || ch < 1 || ch > 4) return undefined;
      const mxNode = patch.nodes[mxId] as ModuleNode | undefined;
      if (!mxNode) return undefined;
      const levels = e.read(mxNode, 'levels') as number[] | undefined;
      return levels?.[ch - 1];
    },

    writeParam(moduleId, paramId, value) {
      const live = patch.nodes[moduleId];
      if (!live) return;
      live.params[paramId] = value; // proxy setter transacts (Yjs-synced)
    },

    hasExternalClock() {
      const id = tlId();
      if (!id) return false;
      // Scan edges for a target on the timelorde's `clock` input (mirror
      // TimelordeCard.svelte's derived check).
      for (const edge of Object.values(patch.edges)) {
        if (!edge) continue;
        if (edge.target.nodeId === id && edge.target.portId === 'clock') return true;
      }
      return false;
    },

    luaSource: () => luaSource,

    bannerText() {
      const id = tlId();
      const e = getEngine();
      if (!id || !e) return 'INT';
      const node = patch.nodes[id] as ModuleNode | undefined;
      if (!node) return 'INT';
      const ext = (() => {
        for (const edge of Object.values(patch.edges)) {
          if (edge?.target.nodeId === id && edge.target.portId === 'clock') return true;
        }
        return false;
      })();
      const measured = e.read(node, 'measuredBpm');
      const internal = e.readParam(node, 'bpm') ?? 120;
      const shown =
        ext && typeof measured === 'number' && measured > 0 ? measured : internal;
      return `${ext ? 'EXT' : 'INT'} ${Math.round(shown)}`;
    },
  };
}
