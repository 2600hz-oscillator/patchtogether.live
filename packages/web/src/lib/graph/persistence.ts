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
// The ARM subset of the clip player's live-performance fields. Imported rather
// than restated — see TRANSIENT_DATA_FIELDS_BY_TYPE below for what restating it
// cost. Runtime VALUE import; clip-types imports nothing from graph/, so the
// dependency runs one way only.
import { CLIP_PLAYER_ARM_DATA_FIELDS } from '$lib/audio/modules/clip-types';
import type { ModuleNode, Edge } from './types';
import { makeAdoptionGraph, validateEdge, type ResolveDef } from './validate-edge';
// The two reason strings the summariser BUCKETS ON live with the summariser,
// so the producer and the consumer cannot drift into disagreement (a
// re-worded reason here would otherwise silently fall into the "migrated"
// bucket and read as good news).
import { LOAD_DIAGNOSTIC_REASONS } from './load-diagnostics';

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

/**
 * RETIRED module types → the type that replaces them. Consulted ONCE, at
 * load, BEFORE the unknown-type drop.
 *
 * NOT a general migration substrate: no value reshaping, no per-module hooks,
 * no `schemaVersion`. This is the shallow TYPE-ONLY aliasing the VIDEO
 * registry carried as `LEGACY_TYPE_ALIASES` (ruttetra→reshaper,
 * circles→outlines) until #1027 retired it, re-introduced with the same
 * finite life. The node survives at its saved id and position — the two
 * things a user cannot reconstruct — and its edges are then re-validated by
 * the ordinary `validateEdge` pass, so a port that exists on the new def
 * keeps its cable and a port that doesn't is dropped with its own diagnostic.
 * PARAMS ARE NOT MAPPED: the node loads at the new module's defaults, because
 * silently reinterpreting one instrument's control as another's is worse than
 * resetting it.
 *
 * ⚠ `warrenspectrum` (one 's') is DELIBERATELY ABSENT. It was a stereo 8-band
 * vactrol-ping resonator bank: 0 of its 43 ports and 0 of its 16 params exist
 * on the mono spectral contract, and its rack footprint was 3u/3hp against
 * the replacement's 2u/2hp. An aliased node would keep no cable and no value
 * — a card wearing the old node's identity with none of its behaviour. It
 * takes the ordinary unknown-type drop path instead (the repo's declared
 * answer, exercised by 18 previously-deleted types), which is now VISIBLE:
 * see `summarizeLoadDiagnostics` in ./load-diagnostics. A dropped node is
 * visibly absent and the user knows to rebuild; a silently-migrated one lies.
 *
 * REMOVAL CONDITION: drop this table two minor releases after ship, at which
 * point live patches have been re-saved under the canonical id and the drop
 * path handles the stragglers — exactly the argument #1027 used to retire the
 * video aliases.
 */
export const RETIRED_TYPE_ALIASES: Readonly<Record<string, string>> = {
  callsine: 'warrensspectrum',
};

/** Per-alias diagnostic wording. A migrated node is NOT the generic "controls
 *  reset" case: `callsine` declared `chainWiring: { role: 'source' }` — it was
 *  a pitch+gate VOICE — while Warren's Spectrum is an EFFECT that resynthesises
 *  whatever is patched into `audio_in`. **A migrated node with nothing patched
 *  into `audio_in` is silent.** That is the one failure this migration can
 *  still produce and the one a user is least likely to diagnose, so the
 *  diagnostic says it out loud. */
export const RETIRED_TYPE_ALIAS_NOTES: Readonly<Record<string, string>> = {
  callsine:
    "migrated from callsine to warren's spectrum (controls reset to defaults); " +
    "warren's spectrum ANALYSES audio — patch a source into audio_in or it is silent",
};

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
  // a reloaded arranger/KEYS arm would re-record. `song` itself is CONTENT and
  // persists.
  //
  // ⚠ DERIVED, NOT RE-TYPED — and that is the fix, not a tidy-up. This entry
  // used to be a hand-written `['songRec', 'recording', 'noteRec']` under a
  // comment claiming it mirrored the ARM subset of
  // CLIP_PLAYER_TRANSIENT_DATA_FIELDS. It did not: `audioRec` and `automation`
  // joined that constant and never joined this copy, so a patch saved mid-take
  // reloaded still carrying the take — a pad painted `rec-active` red forever
  // (clipPadState reads audioRecState FIRST, and #writeAudioRec only fires on a
  // machine TRANSITION, which a loaded patch has none of), masking the real clip
  // in that slot, over a foreign recorderId whose single-writer lease then
  // refused every future arm on that lane. Two lists that must agree and cannot
  // be checked against each other is the defect; one list with two projections
  // has nothing to drift. Classification lives with the fields, in clip-types.
  clipplayer: CLIP_PLAYER_ARM_DATA_FIELDS,
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

/**
 * STATE-ONLY portable envelope: the same materialized patch as
 * `makePortableEnvelope`, re-encoded from a BRAND-NEW Y.Doc so the update
 * carries zero edit history.
 *
 * WHY: `Y.encodeStateAsUpdate` on a long-lived doc ships every historical
 * struct — every insertion ever made plus a tombstone per deletion — so the
 * export grows with SESSION LENGTH, not patch size (measured: a 30-node patch
 * aged by 5,000 edit transactions encodes 102.6 KB vs 35.3 KB state-only, and
 * 300.9 KB at 20,000; load-side applyUpdate 17.2 ms vs 0.9 ms). Undo history
 * and CRDT merge ancestry are meaningless in an export that is only ever
 * loaded via "replace", so a fresh doc holding just the current state is a
 * strictly smaller equivalent.
 *
 * WHAT RIDES ALONG: exactly the top-level shares every load path consumes —
 * `nodes` + `edges` (loadEnvelopeIntoStore) and the full `settings` map
 * (readVideoAspectFromDoc + readPresentBindingsFromUpdate). Positions are
 * baked and `layouts` dropped by the makePortableEnvelope pass this builds
 * on. Session-scoped shares no loader reads (`meta` clock epoch, bot/carl
 * session locks) are deliberately absent.
 *
 * The rebuild materializes through a fresh SyncedStore, so nested values take
 * the identical Y shapes the live store produces — `toJSON()` on the loaded
 * side cannot tell the difference. Pure: never touches `ydoc`.
 */
export function makeStateOnlyEnvelope(
  ydoc: Y.Doc,
  savingUserId: string | undefined,
): PatchEnvelope {
  const portable = makePortableEnvelope(ydoc, savingUserId);
  const tempDoc = new Y.Doc();
  Y.applyUpdate(tempDoc, base64ToBytes(portable.update));
  const nodes = tempDoc.getMap('nodes').toJSON() as Record<string, ModuleNode>;
  const edges = tempDoc.getMap('edges').toJSON() as Record<string, Edge>;
  const settings = tempDoc.getMap(SETTINGS_MAP_KEY).toJSON() as Record<string, unknown>;

  const freshStore = syncedStore<{ nodes: Record<string, ModuleNode>; edges: Record<string, Edge> }>(
    { nodes: {}, edges: {} },
  );
  const freshDoc = getYjsDoc(freshStore);
  // CANONICAL WRITE ORDER: sorted keys, always. Y.Map carries no order
  // semantics, but the ENCODED BYTES depend on insertion order — object key
  // order in the source doc drifts as a session deletes and re-adds entries,
  // so an unsorted rebuild of the SAME state could differ by tens of bytes
  // run-to-run (the size-invariance test measured 52B on a 1.1KB doc and
  // flaked CI). Sorting makes the rebuild a pure function of the state:
  // identical state → identical bytes, on any peer, after any history.
  const sortedEntries = <T>(o: Record<string, T>): [string, T][] =>
    Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  freshDoc.transact(() => {
    for (const [id, node] of sortedEntries(nodes)) freshStore.nodes[id] = node;
    for (const [id, edge] of sortedEntries(edges)) freshStore.edges[id] = edge;
    const freshSettings = freshDoc.getMap(SETTINGS_MAP_KEY);
    for (const [key, value] of sortedEntries(settings)) freshSettings.set(key, value);
  });

  return {
    ...portable,
    update: bytesToBase64(Y.encodeStateAsUpdate(freshDoc)),
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
    // RETIRED-TYPE ALIAS, consulted BEFORE the unknown-type drop. Rewrites
    // `node.type` IN PLACE, so a subsequent save persists the canonical id and
    // the table can eventually be retired (the #1027 lifecycle). Params are
    // dropped rather than mapped — see RETIRED_TYPE_ALIASES.
    const aliasTarget = RETIRED_TYPE_ALIASES[node.type];
    if (aliasTarget && !isKnownModuleType(node.type) && isKnownModuleType(aliasTarget)) {
      const from = String(node.type);
      node.type = aliasTarget;
      node.params = {};
      diagnostics.push({
        nodeId: id,
        type: from,
        reason:
          RETIRED_TYPE_ALIAS_NOTES[from] ??
          `migrated from ${from} to ${aliasTarget} (controls reset to defaults)`,
      });
    }
    // Look up across both per-domain registries — video modules
    // (PICTUREBOX, CAMERA, LINES, ...) live in the video registry and
    // would otherwise be silently dropped on load. See
    // (Phase A audit).
    if (!isKnownModuleType(node.type)) {
      diagnostics.push({
        nodeId: id,
        type: String(node.type),
        reason: LOAD_DIAGNOSTIC_REASONS.unknownType,
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
    // ONE adoption graph over the WHOLE incoming edge set, so a saved patch of
    // `lfo → scaler.in` + `scaler.out → filter.cutoff` reloads intact. Without
    // it the second cable resolved as `audio → cv` and was dropped on load —
    // the file would round-trip lossily.
    const loadAdoption = makeAdoptionGraph(
      survivingNodes,
      Object.values(loadedEdges),
      resolveDefForValidation,
    );
    for (const edge of Object.values(loadedEdges)) {
      // Drop edges referencing dropped nodes (e.g. unknown module types).
      if (!keptNodes[edge.source.nodeId] || !keptNodes[edge.target.nodeId]) {
        diagnostics.push({
          nodeId: edge.id,
          type: 'edge',
          reason: LOAD_DIAGNOSTIC_REASONS.orphanEdge,
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
      const validation = validateEdge(
        edge,
        survivingNodes,
        resolveDefForValidation,
        loadAdoption,
      );
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
