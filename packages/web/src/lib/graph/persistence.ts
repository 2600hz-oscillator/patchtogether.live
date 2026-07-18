// packages/web/src/lib/graph/persistence.ts
//
// Patch save/load via the PatchEnvelope format spec'd in phase-1-mvp.md.
//
// Wire format = a JSON envelope wrapping a base64-encoded Yjs update. The Yjs
// update is the source of truth: applying it to a fresh Y.Doc reconstructs the
// patch graph exactly. The envelope adds a `savedAt` timestamp and an
// `envelopeVersion` gate.
//
// Format policy is NIMBLE WRITE, TOLERANT READ: a new save stamps the current
// ENVELOPE_VERSION and a lean payload; `parseEnvelope` accepts that version AND
// any older one (rejecting only a FUTURE envelope). The per-module
// `schemaVersion` / `moduleSchemas` migration substrate was collapsed in the
// schema cleanup (envelope v2) — a patch now stores TOPOLOGY + authored /
// sequenced values only, and is never reshaped on load.

import * as Y from 'yjs';
import { syncedStore, getYjsDoc } from '@syncedstore/core';
import { getNodePosition, type XY } from '$lib/multiplayer/layouts';
import { getModuleDef as getAudioModuleDef } from '$lib/audio/module-registry';
import { getVideoModuleDef } from '$lib/video/module-registry';
import { getMetaModuleDef } from '$lib/meta/module-registry';
import type { ModuleNode, Edge } from './types';
import { validateEdge, type ResolveDef } from './validate-edge';

/** Is `type` registered in ANY per-domain registry? The persistence loader only
 *  needs to know whether a saved node's type still resolves to a def — an
 *  unknown type is dropped (flagged as a load diagnostic). It no longer reads
 *  any per-module version/migrate metadata: the `schemaVersion` / `moduleSchemas`
 *  migration substrate was collapsed in the schema cleanup. */
function isKnownModuleType(type: string): boolean {
  return Boolean(
    getAudioModuleDef(type) ?? getVideoModuleDef(type) ?? getMetaModuleDef(type),
  );
}

/** SyncedStore-shaped patch — keys map to their value or undefined (post-delete).
 * Mirrors MappedTypeDescription<PatchStore> so this module accepts the live
 * `patch` proxy from store.ts without a cast. */
export type LivePatch = {
  nodes: Record<string, ModuleNode | undefined>;
  edges: Record<string, Edge | undefined>;
};

/** Bumped when the envelope format itself changes (not when modules change).
 *  v2 = the deliberate lean-format marker: the `moduleSchemas` map + per-module
 *  migration substrate were dropped. `parseEnvelope` still ACCEPTS v1 (tolerant
 *  read); new saves stamp v2. */
export const ENVELOPE_VERSION = 2 as const;

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
  // CLIPPLAYER record-ARM state is per-session, never topology: a saved patch
  // that reloaded ARMED would REPLACE-clear its own printed SONG on first Play
  // (a legacy `songRec.armed` with no `recorderId` records for ANY client), and
  // a reloaded arranger/KEYS arm would re-record. These mirror the ARM subset of
  // CLIP_PLAYER_TRANSIENT_DATA_FIELDS (the duplicate-scrub); `song` itself is
  // CONTENT and persists.
  clipplayer: ['songRec', 'recording', 'noteRec'],
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
  return {
    envelopeVersion: ENVELOPE_VERSION,
    savedAt: new Date().toISOString(),
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
  // Tolerant read (forward-compat): accept THIS version and any OLDER one —
  // reject only a FUTURE envelope we can't understand. An old v1 envelope still
  // loads: it carried a `moduleSchemas` map that drove per-module migration, but
  // that substrate was collapsed, so a legacy `moduleSchemas` field (if present)
  // is simply ignored. Its topology + authored/sequenced values load intact.
  if (typeof env.envelopeVersion !== 'number' || env.envelopeVersion > ENVELOPE_VERSION) {
    throw new EnvelopeParseError(
      `unsupported envelopeVersion ${String(env.envelopeVersion)} (expected <= ${ENVELOPE_VERSION})`,
    );
  }
  if (typeof env.savedAt !== 'string') {
    throw new EnvelopeParseError('missing or invalid savedAt');
  }
  if (typeof env.update !== 'string') {
    throw new EnvelopeParseError('missing or invalid update (expected base64 string)');
  }
  return env as unknown as PatchEnvelope;
}

// ---------------- Load ----------------

/** A node whose module type is no longer registered, or an edge that failed
 * structural validation. Rendered as a placeholder / logged + skipped. */
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
  /** Per-node unknown-type + per-edge validation diagnostics. */
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
 * Apply an envelope to the live patch + ydoc, replacing whatever's currently
 * loaded. Atomic: wrapped in a single transact so subscribers see one update.
 *
 * Strategy: decode the envelope's update into a temp Y.Doc, read its state out
 * as plain objects, strip any transient session fields, then atomically clear
 * the live store and re-add the entries. We don't `Y.applyUpdate` directly onto
 * the live doc because Yjs's CRDT merge semantics conflict with "load =
 * replace": tombstones from the cleared state would block re-insertion of
 * identical struct IDs.
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

  // 2. Resolve each node's type + strip transient session fields.
  const diagnostics: LoadDiagnostic[] = [];
  const keptNodes: Record<string, ModuleNode> = {};
  for (const [id, node] of Object.entries(loadedNodes)) {
    // Look up across both per-domain registries — video modules
    // (PICTUREBOX, CAMERA, LINES, ...) live in the video registry and
    // would otherwise be silently dropped on load. See
    // .myrobots/plans/rackspace-persistence.md (Phase A audit).
    if (!isKnownModuleType(node.type)) {
      diagnostics.push({
        nodeId: id,
        type: String(node.type),
        reason: 'module type not registered in this build',
      });
      continue; // Phase 1: skip. Future: insert placeholder error node.
    }
    // Strip transient / session-state fields that persisted into the envelope
    // (e.g. DOOM's mpMode lobby gate — see TRANSIENT_DATA_FIELDS_BY_TYPE). The
    // toJSON() above severed Yjs proxies, so `node.data` is a plain object we
    // own and can safely mutate.
    stripTransientDataFields(node.type, node.data);
    keptNodes[id] = node;
  }

  // Def lookup the edge validator needs (declared input/output ports). This is
  // the SAME registry chain the rest of persistence uses, but typed to the
  // validator's narrow ValidatorDef view (it only reads `inputs`/`outputs`,
  // which every real AudioModuleDef / VideoModuleDef / MetaModuleDef carries).
  // GROUP! nodes have no module def — validateEdge resolves their exposed ports
  // via resolveExposedPort, so a missing def for `group` is expected, not a bug.
  const resolveDefForValidation: ResolveDef = (type) =>
    getAudioModuleDef(type) ?? getVideoModuleDef(type) ?? getMetaModuleDef(type);
  // validateEdge takes a node ARRAY; snapshot the surviving nodes once.
  const survivingNodes = Object.values(keptNodes);

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
    for (const node of Object.values(keptNodes)) {
      livePatch.nodes[node.id] = node;
    }
    for (const edge of Object.values(loadedEdges)) {
      // Drop edges referencing dropped nodes (e.g. unknown module types).
      if (!keptNodes[edge.source.nodeId] || !keptNodes[edge.target.nodeId]) {
        diagnostics.push({
          nodeId: edge.id,
          type: 'edge',
          reason: 'edge references a dropped node',
        });
        continue;
      }
      // STRUCTURAL VALIDATION (Phase 4d): the missing-node check above only
      // catches a dangling endpoint. An aged or hand-edited import can still
      // carry a structurally-malformed edge whose nodes BOTH exist — a stale
      // portId, an output-as-target, an incompatible cable type. The reconciler
      // materializes edges via engine.addEdge, which THROWS on a missing/
      // mismatched port; that throw is swallowed at the reconcile-pass level, so
      // a single bad edge silently aborts the WHOLE pass (every node/edge/param
      // ordered after it) AND, in multiuser, syncs the poison to every peer.
      // Drop the one bad edge HERE — exactly like the missing-node branch above
      // — so a malformed import can never reach (and wedge) the reconciler.
      const validation = validateEdge(edge, survivingNodes, resolveDefForValidation);
      if (!validation.ok) {
        diagnostics.push({
          nodeId: edge.id,
          type: 'edge',
          reason: `invalid edge dropped: ${validation.reason ?? 'failed structural validation'}`,
        });
        continue;
      }

      livePatch.edges[edge.id] = edge;
    }
  });

  return {
    nodesLoaded: Object.keys(keptNodes).length,
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
