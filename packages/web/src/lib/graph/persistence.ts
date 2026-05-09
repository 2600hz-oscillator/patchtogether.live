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
import {
  getModuleDef as getAudioModuleDef,
  listModuleDefs as listAudioModuleDefs,
} from '$lib/audio/module-registry';
import {
  getVideoModuleDef,
  listVideoModuleDefs,
} from '$lib/video/module-registry';
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
}

function getAnyDomainDef(type: string): AnyDomainDef | undefined {
  // Audio-first because most types are audio; the lookup is a simple Map
  // get either way so order is purely cosmetic.
  return getAudioModuleDef(type) ?? getVideoModuleDef(type);
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
  return {
    envelopeVersion: ENVELOPE_VERSION,
    savedAt: new Date().toISOString(),
    moduleSchemas,
    update: bytesToBase64(Y.encodeStateAsUpdate(ydoc)),
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

  // 2. Run per-node migrations.
  const diagnostics: LoadDiagnostic[] = [];
  const migratedNodes: Record<string, ModuleNode> = {};
  for (const [id, node] of Object.entries(loadedNodes)) {
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
    migratedNodes[id] = { ...node, data: migratedData };
  }

  // 3. Atomically swap the live store.
  liveYdoc.transact(() => {
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
      livePatch.edges[edge.id] = edge;
    }
  });

  return {
    nodesLoaded: Object.keys(migratedNodes).length,
    edgesLoaded: Object.keys(loadedEdges).length - diagnostics.filter((d) => d.type === 'edge').length,
    diagnostics,
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
