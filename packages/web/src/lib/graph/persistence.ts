// packages/web/src/lib/graph/persistence.ts
//
// Patch save/load via the PatchEnvelope format spec'd in phase-1-mvp.md.
//
// Wire format = a JSON envelope wrapping a base64-encoded Yjs update. The Yjs
// update is the source of truth: applying it to a fresh Y.Doc reconstructs the
// patch graph exactly. The envelope adds the metadata needed for forward-
// compatible loading: schemaVersion per module type at save time (so we can
// run migrations on load), savedAt, and an envelopeVersion gate.
//
// This format survives Phase 4 (the wire format remains Yjs) and survives
// module evolution via D19's per-module migrations.

import * as Y from 'yjs';
import { syncedStore, getYjsDoc } from '@syncedstore/core';
import { getNodePosition, type XY } from '$lib/multiplayer/layouts';
import {
  getModuleDef as getAudioModuleDef,
  listModuleDefs as listAudioModuleDefs,
} from '$lib/audio/module-registry';
import {
  getVideoModuleDef,
  listVideoModuleDefs,
  canonicalizeVideoType,
} from '$lib/video/module-registry';
import { getMetaModuleDef, listMetaModuleDefs } from '$lib/meta/module-registry';
import type { ModuleNode, Edge } from './types';

/** Per-module-type schemaVersion + migrate, abstracted across the two
 *  per-domain registries so the persistence layer doesn't have to know
 *  which one a given type lives in. Returns undefined when the type is
 *  unknown to either registry (used to flag dropped nodes on load).
 *
 *  Both AudioModuleDef and VideoModuleDef carry `schemaVersion: number`
 *  and an optional `migrate(data, fromVersion) => unknown`, so the structural
 *  type below is satisfied by either. */
interface AnyDomainDef {
  schemaVersion: number;
  migrate?: (data: unknown, fromVersion: number) => unknown;
  /** Optional load-time edge-port rename keyed on the saved module version.
   *  Returns a rewritten portId, or null to leave it unchanged. See
   *  VideoModuleDef.migrateEdgePortId (DOOM's per-slot port migration, #353). */
  migrateEdgePortId?: (portId: string, fromVersion: number) => string | null;
}

function getAnyDomainDef(type: string): AnyDomainDef | undefined {
  // Audio-first because most types are audio; the lookup is a simple Map
  // get either way so order is purely cosmetic. Meta is checked last
  // (only STICKY today, but the registry is open-ended).
  return getAudioModuleDef(type) ?? getVideoModuleDef(type) ?? getMetaModuleDef(type);
}

/** SyncedStore-shaped patch — keys map to their value or undefined (post-delete).
 * Mirrors MappedTypeDescription<PatchStore> so this module accepts the live
 * `patch` proxy from store.ts without a cast. */
export type LivePatch = {
  nodes: Record<string, ModuleNode | undefined>;
  edges: Record<string, Edge | undefined>;
};

/** Bumped when the envelope format itself changes (not when modules change). */
export const ENVELOPE_VERSION = 1 as const;

/** Transient runtime / lobby fields that live on a module's `node.data` ONLY
 * so they ride the Yjs sync (every peer agrees on the host's lobby state), but
 * which DO NOT belong in a saved patch — a patch captures the rack TOPOLOGY
 * (which modules exist, where they sit, how they're wired, their persistent
 * params), not a particular session's live STATE.
 *
 * The canonical example is DOOM: `mpMode` ('single' | 'multi') is what gates
 * the host's start-game dialog. If a patch is saved mid-session and reloaded
 * later, the persisted `mpMode` would suppress the start dialog forever — the
 * host would land on "Single-user rack — you're the host." with no way to
 * launch (Bug #1, the load-from-patch repro). Same goes for `mpLive` (a
 * host-published "game is running right now" flag), `players` (the live
 * per-slot roster), and `pending` (in-flight join requests). None of those
 * have any meaning across sessions.
 *
 * Whitelisted by module type — adding a new module's transient fields here is
 * a deliberate, narrow opt-in, not a global filter. */
const TRANSIENT_DATA_FIELDS_BY_TYPE: Readonly<Record<string, readonly string[]>> = {
  doom: ['mpMode', 'mpLive', 'players', 'pending'],
};

/** Strip transient fields from `data` for the given module type (no-op when the
 * type has no entry). Mutates in place; only call on plain objects you own,
 * which the loader does after `tempYdoc.getMap('nodes').toJSON()`. */
function stripTransientDataFields(type: string, data: unknown): void {
  const fields = TRANSIENT_DATA_FIELDS_BY_TYPE[type];
  if (!fields || !data || typeof data !== 'object') return;
  const obj = data as Record<string, unknown>;
  for (const field of fields) delete obj[field];
}

export interface PatchEnvelope {
  envelopeVersion: typeof ENVELOPE_VERSION;
  savedAt: string; // ISO 8601
  /** schemaVersion per module type at save time. Drives load-side migration. */
  moduleSchemas: Record<string, number>;
  /** base64-encoded Y.encodeStateAsUpdate(ydoc). */
  update: string;
}

/** Default filename for downloads. The `.imp.json` double extension is unique
 * enough to avoid collision with generic `.json` files. */
export const DEFAULT_FILENAME = 'patch.imp.json';

// Stripped (not replaced) so user intent stays legible — `my:patch` becomes
// `mypatch`, not `my_patch`. Windows is the strict superset of cross-platform
// invalid characters; allow-listing here keeps macOS/Linux happy too.
const INVALID_FILENAME_CHARS = /[/\\:*?"<>|]/g;

/**
 * Normalize a user-supplied filename for the export download:
 *   - strips filesystem-invalid characters
 *   - falls back to `fallback` if input is empty / whitespace-only / sanitizes to empty
 *   - appends `.imp.json` if missing (case-insensitive match)
 *
 * Pure function — no I/O. Exposed for unit tests + the prompt UI.
 */
export function sanitizeFilename(
  input: string | null | undefined,
  fallback = DEFAULT_FILENAME,
): string {
  const raw = (input ?? '').trim();
  const stripped = raw.replace(INVALID_FILENAME_CHARS, '').trim();
  const base = stripped.length > 0 ? stripped : fallback;
  return /\.imp\.json$/i.test(base) ? base : `${base}.imp.json`;
}

// ---------------- base64 <-> bytes (browser + jsdom safe) ----------------

function bytesToBase64(bytes: Uint8Array): string {
  // Chunked to avoid call-stack overflow on very large updates.
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + CHUNK)),
    );
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// ---------------- Save ----------------

/**
 * Snapshot the current ydoc into a PatchEnvelope. Pure: does not mutate
 * anything. Does not trigger I/O — caller decides what to do with the result.
 */
export function makeEnvelope(ydoc: Y.Doc): PatchEnvelope {
  const moduleSchemas: Record<string, number> = {};
  // Both domain registries contribute their schemaVersions; load-time
  // migration looks up by type id (which is unique across both registries
  // because a `type` is the union over both modules' StandardModuleType).
  for (const def of listAudioModuleDefs()) {
    moduleSchemas[def.type] = def.schemaVersion;
  }
  for (const def of listVideoModuleDefs()) {
    moduleSchemas[def.type] = def.schemaVersion;
  }
  for (const def of listMetaModuleDefs()) {
    moduleSchemas[def.type] = def.schemaVersion;
  }
  return {
    envelopeVersion: ENVELOPE_VERSION,
    savedAt: new Date().toISOString(),
    moduleSchemas,
    update: bytesToBase64(Y.encodeStateAsUpdate(ydoc)),
  };
}

/**
 * Make a saved-performance envelope PORTABLE across loaders by baking the
 * saving user's *displayed* positions into each node's canonical
 * `node.position` and dropping the per-user `layouts` map.
 *
 * WHY: in multiplayer, drag-stop writes the moved card's position into
 * `ydoc.getMap('layouts')[userId][nodeId]` (multiplayer/layouts.ts —
 * setNodePosition), NOT into `node.position`, so each user sees their own
 * layout. `makeEnvelope` snapshots the whole ydoc (including that per-user
 * map), but on LOAD the loader is a *different* (or absent) user id, so
 * `getNodePosition` misses the override and falls back to the stale spawn
 * `node.position` — placements are lost. (Single-user saves are unaffected:
 * drags fall through to `node.position` directly, and `savingUserId` is
 * undefined here.)
 *
 * FIX: snapshot via `makeEnvelope`, decode the update into a THROWAWAY Y.Doc
 * (never the live shared doc — we must not mutate the graph or broadcast to
 * peers), rewrite every `node.position` to the saving user's resolved display
 * position, clear the `layouts` map, and re-encode. The result reads correctly
 * for ANY loader regardless of their user id.
 *
 * Pure: does not touch `ydoc`. When `savingUserId` is undefined the layouts
 * map is empty/irrelevant, so this still produces a valid (positions already
 * canonical) portable envelope — clearing the empty `layouts` map is a no-op.
 */
export function makePortableEnvelope(
  ydoc: Y.Doc,
  savingUserId: string | undefined,
): PatchEnvelope {
  const env = makeEnvelope(ydoc);

  // Decode into a throwaway plain Y.Doc. We DON'T use SyncedStore here: we need
  // to mutate the nested `position` Y.Map in place, and a raw Y.Doc traversal
  // matches exactly how `makeEnvelope`/`loadEnvelopeIntoStore` read/write the
  // structure (node = Y.Map, node.position = nested Y.Map with x/y).
  const tempDoc = new Y.Doc();
  Y.applyUpdate(tempDoc, base64ToBytes(env.update));

  const nodes = tempDoc.getMap<Y.Map<unknown>>('nodes');
  const layouts = tempDoc.getMap('layouts');

  tempDoc.transact(() => {
    for (const [nodeId, node] of nodes.entries()) {
      if (!(node instanceof Y.Map)) continue;
      const posMap = node.get('position');
      // Current canonical position is the fallback when the user has no layout
      // override for this node (matches Canvas's getNodePosition(...) call).
      const defaultPos: XY =
        posMap instanceof Y.Map
          ? { x: Number(posMap.get('x')) || 0, y: Number(posMap.get('y')) || 0 }
          : { x: 0, y: 0 };
      const resolved = getNodePosition(tempDoc, savingUserId, nodeId, defaultPos);
      if (posMap instanceof Y.Map) {
        posMap.set('x', resolved.x);
        posMap.set('y', resolved.y);
      } else {
        // Defensive: node had no position Y.Map (shouldn't happen for real
        // nodes). Materialize one so the loader still gets a position.
        const np = new Y.Map<number>();
        np.set('x', resolved.x);
        np.set('y', resolved.y);
        node.set('position', np);
      }
    }
    // Drop the now-baked per-user layouts so the snapshot is loader-agnostic.
    for (const k of [...layouts.keys()]) layouts.delete(k);
  });

  return {
    ...env,
    update: bytesToBase64(Y.encodeStateAsUpdate(tempDoc)),
  };
}

/** Convenience: envelope → pretty-printed JSON string. */
export function serializeEnvelope(env: PatchEnvelope): string {
  return JSON.stringify(env, null, 2);
}

// ---------------- Parse ----------------

export class EnvelopeParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvelopeParseError';
  }
}

/**
 * Parse JSON text into a PatchEnvelope, validating shape + version. Throws
 * EnvelopeParseError on any structural problem.
 */
export function parseEnvelope(json: string): PatchEnvelope {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    throw new EnvelopeParseError(`not valid JSON: ${(e as Error).message}`);
  }
  if (!raw || typeof raw !== 'object') {
    throw new EnvelopeParseError('envelope is not an object');
  }
  const env = raw as Record<string, unknown>;
  if (env.envelopeVersion !== ENVELOPE_VERSION) {
    throw new EnvelopeParseError(
      `unsupported envelopeVersion ${String(env.envelopeVersion)} (expected ${ENVELOPE_VERSION})`,
    );
  }
  if (typeof env.savedAt !== 'string') {
    throw new EnvelopeParseError('missing or invalid savedAt');
  }
  if (!env.moduleSchemas || typeof env.moduleSchemas !== 'object') {
    throw new EnvelopeParseError('missing or invalid moduleSchemas');
  }
  if (typeof env.update !== 'string') {
    throw new EnvelopeParseError('missing or invalid update (expected base64 string)');
  }
  return env as unknown as PatchEnvelope;
}

// ---------------- Load ----------------

/** A node that couldn't migrate or whose module type is no longer registered.
 * Rendered as a placeholder error card on the canvas (Phase 1: log + skip). */
export interface LoadDiagnostic {
  nodeId: string;
  type: string;
  reason: string;
}

export interface LoadResult {
  /** Number of nodes successfully loaded. */
  nodesLoaded: number;
  /** Number of edges successfully loaded. */
  edgesLoaded: number;
  /** Per-node migration / unknown-type diagnostics. */
  diagnostics: LoadDiagnostic[];
  /**
   * The persisted OUTPUT aspect ('4:3' | '16:9') from the envelope's `settings`
   * map, or undefined for a legacy patch that predates the aspect switch (caller
   * defaults to '4:3'). The caller (Canvas) applies it to the live VideoEngine +
   * the video-aspect store after the graph swaps in.
   */
  videoAspect?: '4:3' | '16:9';
}

/** The Y.Doc map key holding cross-cutting rack settings (video aspect, …). It's
 *  part of the doc so it rides save (makeEnvelope encodes the whole doc),
 *  performance export, AND multiplayer sync with no extra plumbing. */
export const SETTINGS_MAP_KEY = 'settings';
/** Settings entry: the OUTPUT aspect ('4:3' | '16:9'). */
export const SETTINGS_VIDEO_ASPECT = 'videoAspect';

/** Read the persisted OUTPUT aspect off a live Y.Doc's settings map (undefined
 *  if unset / legacy). Coerces to the '4:3'|'16:9' union; anything else →
 *  undefined. */
export function readVideoAspectFromDoc(ydoc: Y.Doc): '4:3' | '16:9' | undefined {
  const v = ydoc.getMap(SETTINGS_MAP_KEY).get(SETTINGS_VIDEO_ASPECT);
  return v === '16:9' ? '16:9' : v === '4:3' ? '4:3' : undefined;
}

/** Write the OUTPUT aspect into a live Y.Doc's settings map (synced +
 *  persisted). Uses the supplied transaction origin so it threads through the
 *  host's UndoManager origin convention. */
export function writeVideoAspectToDoc(ydoc: Y.Doc, aspect: '4:3' | '16:9', origin?: unknown): void {
  ydoc.transact(() => {
    ydoc.getMap(SETTINGS_MAP_KEY).set(SETTINGS_VIDEO_ASPECT, aspect);
  }, origin);
}

/**
 * Rewrite an edge's source/target portIds via the endpoint nodes' module-def
 * `migrateEdgePortId` hook, when the saved version is behind the current def.
 * Returns the edge unchanged when no endpoint migrates. Pure (returns a new
 * object only when something actually changed). Exported for unit tests.
 */
export function migrateEdgeEndpoints(
  edge: Edge,
  nodes: Record<string, ModuleNode>,
  moduleSchemas: Record<string, number>,
): Edge {
  const rewrite = (end: { nodeId: string; portId: string }): string => {
    const node = nodes[end.nodeId];
    if (!node) return end.portId;
    const def = getAnyDomainDef(node.type);
    if (!def?.migrateEdgePortId) return end.portId;
    const from = moduleSchemas[node.type] ?? 1;
    if (from >= def.schemaVersion) return end.portId;
    return def.migrateEdgePortId(end.portId, from) ?? end.portId;
  };
  const newSourcePort = rewrite(edge.source);
  const newTargetPort = rewrite(edge.target);
  if (newSourcePort === edge.source.portId && newTargetPort === edge.target.portId) {
    return edge;
  }
  return {
    ...edge,
    source: { ...edge.source, portId: newSourcePort },
    target: { ...edge.target, portId: newTargetPort },
  };
}

/**
 * Apply an envelope to the live patch + ydoc, replacing whatever's currently
 * loaded. Atomic: wrapped in a single transact so subscribers see one update.
 *
 * Strategy: decode the envelope's update into a temp Y.Doc, read its state out
 * as plain objects, run per-module migrations on `node.data` based on
 * `moduleSchemas`, then atomically clear the live store and re-add migrated
 * entries. We don't `Y.applyUpdate` directly onto the live doc because Yjs's
 * CRDT merge semantics conflict with "load = replace": tombstones from the
 * cleared state would block re-insertion of identical struct IDs.
 */
export function loadEnvelopeIntoStore(
  envelope: PatchEnvelope,
  liveYdoc: Y.Doc,
  livePatch: LivePatch,
): LoadResult {
  // 1. Materialize the saved state in a throwaway doc + store so we can read
  //    it as plain objects (avoiding direct Y.Map traversal).
  const tempStore = syncedStore<{ nodes: Record<string, ModuleNode>; edges: Record<string, Edge> }>({ nodes: {}, edges: {} });
  const tempYdoc = getYjsDoc(tempStore);
  Y.applyUpdate(tempYdoc, base64ToBytes(envelope.update));

  // toJSON() returns plain objects, severing Yjs proxies — safe to mutate.
  const loadedNodes = tempYdoc.getMap('nodes').toJSON() as Record<string, ModuleNode>;
  const loadedEdges = tempYdoc.getMap('edges').toJSON() as Record<string, Edge>;
  // Cross-cutting settings (OUTPUT aspect). Read off the throwaway doc — the
  // whole doc was encoded in the envelope, so it's present iff the patch was
  // saved after the aspect switch shipped.
  const loadedVideoAspect = readVideoAspectFromDoc(tempYdoc);

  // 2. Run per-node migrations.
  const diagnostics: LoadDiagnostic[] = [];
  const migratedNodes: Record<string, ModuleNode> = {};
  for (const [id, node] of Object.entries(loadedNodes)) {
    // ---- BREAKING-CHANGE TYPE REMAP: ruttetra → reshaper ----
    //
    // The type id `ruttetra` originally belonged to a fragment-shader
    // coordinate-REMAP effect (schemaVersion 1). That module was renamed
    // to RESHAPER, and a NEW, behaviourally-different module — the
    // authentic forward-scatter Rutt-Etra scope — took over the
    // `ruttetra` type id (registered at schemaVersion 2).
    //
    // Persisted patches saved BEFORE the rename recorded their `ruttetra`
    // nodes with the old schemaVersion (1) in the envelope's
    // moduleSchemas. Loading them as the new RUTTETRA would silently swap
    // the look. We detect the old saves by their recorded schemaVersion
    // (< 2) and remap the node's `type` to `reshaper` so the original
    // coord-remap behaviour is preserved. Saves recorded at >= 2 (or with
    // no recorded version, which only happens for freshly-created nodes
    // in the current build) are left as the new RUTTETRA.
    if (node.type === 'ruttetra' && (envelope.moduleSchemas['ruttetra'] ?? 1) < 2) {
      (node as { type: string }).type = 'reshaper';
    }

    // ---- LEGACY VIDEO TYPE ALIAS: circles → outlines (and any future
    //      renamed video module) ----
    //
    // OUTLINES was named CIRCLES until the SHAPE/ROTATION rework (#699). Nodes
    // saved before the rename (localStorage / a live collab Y.Doc / a hand-
    // exported .json) still carry `type: 'circles'`. canonicalizeVideoType()
    // rewrites the node's type to the current registry id IN PLACE so it (a)
    // resolves a def (else it'd drop to a placeholder), AND (b) renders the
    // right card — SvelteFlow's nodeTypes map is keyed strictly on the current
    // def.type, so a node left as `circles` would render with the default
    // placeholder card even though getVideoModuleDef('circles') resolves the
    // def via the alias. Re-saving then persists the canonical `outlines` type.
    {
      const canonical = canonicalizeVideoType(node.type);
      if (canonical !== node.type) (node as { type: string }).type = canonical;
    }

    // Look up across both per-domain registries — video modules
    // (PICTUREBOX, CAMERA, LINES, ...) live in the video registry and
    // would otherwise be silently dropped on load. See
    // .myrobots/plans/rackspace-persistence.md (Phase A audit).
    const def = getAnyDomainDef(node.type);
    if (!def) {
      diagnostics.push({
        nodeId: id,
        type: String(node.type),
        reason: 'module type not registered in this build',
      });
      continue; // Phase 1: skip. Future: insert placeholder error node.
    }
    const fromVersion = envelope.moduleSchemas[node.type] ?? 1;
    let migratedData = node.data;
    if (fromVersion < def.schemaVersion && def.migrate) {
      try {
        migratedData = def.migrate(node.data, fromVersion) as
          | Record<string, unknown>
          | undefined;
      } catch (e) {
        diagnostics.push({
          nodeId: id,
          type: String(node.type),
          reason: `migration ${fromVersion}→${def.schemaVersion} failed: ${(e as Error).message}`,
        });
        continue;
      }
    }
    // Strip transient / session-state fields that persisted into the envelope
    // (e.g. DOOM's mpMode lobby gate — see TRANSIENT_DATA_FIELDS_BY_TYPE). The
    // toJSON() above severed Yjs proxies, so `migratedData` is a plain object
    // we own and can safely mutate. Run AFTER migration so a per-module
    // migrate() that touches transient fields still sees them in the input.
    stripTransientDataFields(node.type, migratedData);
    migratedNodes[id] = { ...node, data: migratedData };
  }

  // 3. Atomically swap the live store.
  liveYdoc.transact(() => {
    // Restore the persisted OUTPUT aspect into the live settings map (so it
    // re-syncs to collaborators + persists on the next save). Legacy patches
    // leave it unset → the caller defaults to '4:3'.
    if (loadedVideoAspect) {
      liveYdoc.getMap(SETTINGS_MAP_KEY).set(SETTINGS_VIDEO_ASPECT, loadedVideoAspect);
    }
    for (const id of Object.keys(livePatch.edges)) delete livePatch.edges[id];
    for (const id of Object.keys(livePatch.nodes)) delete livePatch.nodes[id];
    for (const node of Object.values(migratedNodes)) {
      livePatch.nodes[node.id] = node;
    }
    for (const edge of Object.values(loadedEdges)) {
      // Drop edges referencing dropped nodes (e.g. unknown module types).
      if (!migratedNodes[edge.source.nodeId] || !migratedNodes[edge.target.nodeId]) {
        diagnostics.push({
          nodeId: edge.id,
          type: 'edge',
          reason: 'edge references a dropped node',
        });
        continue;
      }
      // EDGE-PORT MIGRATION: when an endpoint's node is a type whose saved
      // schemaVersion is behind the current def AND that def declares an
      // edge-port migration, rewrite the portId. This keeps CV cables wired to
      // DOOM's old bare gate ports (`up`/…) driving the p1 group (`p1_up`/…)
      // after the single shared input set became four per-slot groups (#353).
      const migrated = migrateEdgeEndpoints(edge, migratedNodes, envelope.moduleSchemas);
      livePatch.edges[migrated.id] = migrated;
    }
  });

  return {
    nodesLoaded: Object.keys(migratedNodes).length,
    edgesLoaded: Object.keys(loadedEdges).length - diagnostics.filter((d) => d.type === 'edge').length,
    diagnostics,
    videoAspect: loadedVideoAspect,
  };
}

// ---------------- Browser-side I/O helpers ----------------

/**
 * Trigger a browser file download containing the serialized envelope. Used by
 * the Save button. Returns the blob URL it created (caller can revoke if it
 * cares — most usage just lets it leak until tab close, harmless).
 */
export function downloadEnvelope(env: PatchEnvelope, filename = DEFAULT_FILENAME): string {
  const blob = new Blob([serializeEnvelope(env)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Defer revoke so the browser has time to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return url;
}

/**
 * Open the system file picker, read the chosen file as text, parse it, and
 * apply it to the live store. Resolves with the LoadResult so callers can
 * surface diagnostics. Resolves with `null` if the user cancels.
 */
export async function pickAndLoadEnvelope(
  liveYdoc: Y.Doc,
  livePatch: LivePatch,
): Promise<LoadResult | null> {
  const file = await pickFile('.imp.json,application/json');
  if (!file) return null;
  const text = await file.text();
  const env = parseEnvelope(text);
  return loadEnvelopeIntoStore(env, liveYdoc, livePatch);
}

function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    input.addEventListener('change', () => {
      const file = input.files?.[0] ?? null;
      input.remove();
      resolve(file);
    });
    // Cancel detection — modern browsers fire 'cancel'. Older ones don't, so
    // the Promise leaks until next interaction. Acceptable.
    input.addEventListener('cancel', () => {
      input.remove();
      resolve(null);
    });
    document.body.appendChild(input);
    input.click();
  });
}
