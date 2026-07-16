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
import {
  listElectraControls,
  readElectraData,
  electraPosOfSlot,
  ELECTRA_SLOT_COUNT,
} from '$lib/graph/electra-control';
import { resolveSurfaceParam } from '$lib/graph/control-surface-params';
import { resolveControlColor } from '$lib/graph/control-color';
import { createCcCommit, type CcCommit } from '$lib/ui/controls/cc-commit';
import { getCcBatcher } from '$lib/ui/controls/cc-batch-store';
import type { AutoconfigHost } from './autoconfig';
import type { PresetGenInput, GenParamDef, SurfaceBinding } from './preset';
import { notifyAutomationTouch, notifyAutomationRelease } from '$lib/audio/automation-touch';

/** Resolve the SOURCE module's current control colour (PASSTHROUGH) for a
 *  binding — read live from patch.nodes, never stored on the surface/electra
 *  node. Returns a 6-digit hex (the auto default when unassigned). */
function colorForBinding(moduleId: string, paramId: string): string {
  return resolveControlColor(patch.nodes[moduleId], paramId);
}

/** The first ElectraControl's bindings in slotIndex order (0..35), skipping
 *  empties, each carrying its EXPLICIT generator page-local slot through so the
 *  positional emit places it at the exact (controlSetId, potId). Returns null
 *  when there is no ElectraControl node (so the caller falls back to the CONTROL
 *  SURFACE path). The generator page-local slot is `(controlSetId-1)*12 +
 *  (potId-1)` derived via electraPosOfSlot — NOT the raw row-major storage slot,
 *  because storage order ≠ the firmware's control-set-then-pot walk. */
function electraControlBindings(): SurfaceBinding[] | null {
  const electras = listElectraControls(patch.nodes);
  if (electras.length === 0) return null;
  const data = readElectraData(patch.nodes[electras[0]!.id]);
  const out: SurfaceBinding[] = [];
  for (let storageSlot = 0; storageSlot < ELECTRA_SLOT_COUNT; storageSlot++) {
    const b = data.slots?.[String(storageSlot)];
    if (!b) continue; // empty slot emits nothing
    const { controlSetId, potId } = electraPosOfSlot(storageSlot);
    const genSlot = (controlSetId - 1) * 12 + (potId - 1);
    out.push({
      moduleId: b.moduleId,
      paramId: b.paramId,
      name: b.name,
      slot: genSlot,
      color: colorForBinding(b.moduleId, b.paramId), // SOURCE colour passthrough
    });
  }
  return out;
}

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
      out.push({
        moduleId: b.moduleId,
        paramId: b.paramId,
        name: b.name,
        color: colorForBinding(b.moduleId, b.paramId), // SOURCE colour passthrough
      });
  return out;
}

/** The page-1 binding list. PREFERS an ElectraControl (the explicit, fixed-
 *  layout surface) over a CONTROL SURFACE — if both are present in the patch the
 *  ElectraControl's positional grid drives page 1. Falls back to the first
 *  CONTROL SURFACE's first-seen bindings, then to an empty list. */
function page1Bindings(): SurfaceBinding[] {
  return electraControlBindings() ?? firstSurfaceBindings();
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
    surfaceBindings: page1Bindings(),
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

  // ── Streaming-CC coalescing (the MIDI-CC render-starvation fix) ──
  //
  // The physical Electra One does NOT go through midi-learn: autoconfig's
  // handleCc calls host.writeParam per inbound CC. The old body was one bare
  // proxy write PER MESSAGE — one Y.Doc transaction each, detonating the
  // full snapshot/flowNodes/reconciler/card-pump cascade at 100–300 msg/s
  // and starving the video rAF loop (owner report: "twisting Electra knobs
  // murders video rendering"; gamepad CV was fine because it never writes
  // the store).
  //
  // One pump per (moduleId, paramId): per message the value is pushed
  // TRANSIENTLY into the engine (handle-local write — the FeedbackPump's
  // readParamValue reads engine.readParam, so echo suppression + value
  // feedback see the live value immediately), and the durable store write
  // is coalesced (leading edge + ≥150 ms gaps + 200 ms settle flush, so
  // collab peers / persistence always converge on the final knob position).
  //
  // The COMMIT leg PRESERVES the original deliberately NON-UNDOABLE bare
  // proxy write — never LOCAL_ORIGIN (a tracked write would flood the undo
  // stack over a session of hardware twiddling; see the writeParam comment).
  const ccPumps = new Map<string, CcCommit>();
  function ccPumpFor(moduleId: string, paramId: string): CcCommit {
    const key = `${moduleId}:${paramId}`;
    let pump = ccPumps.get(key);
    if (!pump) {
      pump = createCcCommit({
        // Shared two-lane batcher, BARE lane: the raw proxy writes of every
        // hot Electra pump land in ONE CC_STREAM_ORIGIN transaction per
        // 150ms window — still deliberately NON-undoable (CC_STREAM_ORIGIN
        // is not a tracked origin; wrapping absorbs SyncedStore's internal
        // no-origin transact without promoting it to LOCAL_ORIGIN).
        lane: 'bare',
        batcher: getCcBatcher(),
        commit: (value) => {
          const live = patch.nodes[moduleId];
          if (!live) return;
          live.params[paramId] = value; // guard:allow-raw-write — streaming hardware CC
        },
        transient: (value) => {
          // Touch-suspend cross-wire (task #183): an Electra hardware twist is a
          // live grab — suspend this param's clip-automation via the SAME seam a
          // screen drag / MIDI CC hits, so the twist wins over playback. The
          // 'electra' holder gives it per-surface ownership (a concurrent screen
          // or MIDI grab keeps its own grip).
          notifyAutomationTouch({ nodeId: moduleId, paramId }, 'electra');
          const e = getEngine();
          const node = patch.nodes[moduleId] as ModuleNode | undefined;
          if (!e || !node) return;
          try {
            e.setParam(node, paramId, value);
          } catch {
            /* no engine mapping — the settled commit still converges */
          }
        },
        onActiveChange: (active) => {
          // Automation touch-RELEASE: the twist stream went cold (settleMs after
          // the last CC = the hand off the encoder), so end the 'electra'
          // holder's grip — the mirror of the per-message grab above.
          if (!active) notifyAutomationRelease({ nodeId: moduleId, paramId }, 'electra');
        },
      });
      ccPumps.set(key, pump);
    }
    return pump;
  }

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
      // Driven by streaming Electra One hardware CC (MIDI-rate); a tracked
      // LOCAL_ORIGIN write per CC would flood the undo stack. Synced via the
      // bare proxy transact, deliberately non-undoable — now COALESCED
      // through the per-(module,param) CC pump (transient engine push per
      // message; the bare store write at ≤~7/s + a trailing settle flush).
      ccPumpFor(moduleId, paramId).push(value);
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
