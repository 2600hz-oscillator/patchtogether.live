// packages/web/src/lib/graph/performance-bundle.ts
//
// "Performance Bundle" — the portable manifest half of the Save/Load Local
// Performance feature (.myrobots/plans/save-load-local-performance.md §4a).
//
// A PerformanceBundle is a SUPERSET of the existing PatchEnvelope. The
// envelope already round-trips the entire patch graph: nodes, edges, params,
// module positions, INLINE PICTUREBOX images (base64) and INLINE SAMSLOOP
// samples (PCM) — see graph/persistence.ts. So saving the envelope gets all
// of that "for free".
//
// The bundle adds the bits the envelope can't carry:
//   * `assets` — descriptors for file-backed assets (VIDEOBOX). The actual
//     FileSystemFileHandle lives in IndexedDB (origin-bound, can't be put in
//     JSON); the bundle only records the handleId + filename hint so the
//     loader can re-acquire / re-link. PICTUREBOX + SAMSLOOP are inline in the
//     envelope, so they don't strictly need an asset ref for the same-profile
//     fast path; we still record video refs (the only un-inlined asset today).
//   * `midiBindings` — the global MIDI Learn CC maps (localStorage
//     `pt.midi-bindings.v1`). These are keyed by `moduleId:paramId` and are
//     device-AGNOSTIC, so bundling + restoring them re-binds the CC maps for
//     this performance's modules without caring which controller is plugged in.
//   * `midiDevices` — MIDI-CV-BUDDY device selections keyed by device NAME
//     (NOT the unstable MIDIInput.id), so the loader can re-bind to a matching
//     connected input on the same profile.
//   * `gamepadBindings` — GAMEPAD slot mappings keyed by `gamepad.id`.
//
// This module is PURE (no IDB / DOM I/O) so it unit-tests cleanly. The IDB
// slot persistence + handle re-grant lives in performance-store.ts; the
// toolbar wiring + permission gestures live in Canvas.svelte.

import type { PatchEnvelope } from './persistence';

/** Bumped when the bundle wire format itself changes. */
export const BUNDLE_VERSION = 1 as const;

/** Descriptor for a file-backed asset whose bytes are NOT inlined in the
 *  patch envelope (VIDEOBOX). The handle itself lives in IndexedDB keyed by
 *  `handleId` (the same id stamped into the node's fileMeta) — this is just
 *  the JSON-portable hint the loader uses to re-acquire or re-link. */
export interface PerformanceAssetRef {
  /** Stable id; matches the IDB key for the FileSystemFileHandle. For
   *  VIDEOBOX this is `fileMeta.handleId`. */
  handleId: string;
  role: 'video' | 'image' | 'sample';
  /** Node that consumes the asset. */
  nodeId: string;
  /** Filename hint for the guided re-link prompt. */
  filename: string;
  /** Bytes, for the re-link prompt ("12.4 MB") + re-link verification. */
  size?: number;
  /** Duration in seconds (video) — re-link prompt label. */
  duration?: number;
}

/** A MIDI Learn CC binding, as exported from the global localStorage store.
 *  Device-agnostic (matched by channel+cc across all connected inputs). */
export interface MidiBindingExport {
  /** "moduleId:paramId". */
  key: string;
  channel: number;
  cc: number;
  learnedAt: number;
}

/** A MIDI-CV-BUDDY device selection, keyed by device NAME (stable) rather
 *  than MIDIInput.id (regenerated each session). */
export interface MidiDeviceBinding {
  nodeId: string;
  deviceName: string;
  manufacturer?: string;
}

/** A GAMEPAD mapping keyed by gamepad.id (stable per device model). */
export interface GamepadBinding {
  nodeId: string;
  gamepadId: string;
  padIndex: number;
}

export interface PerformanceBundle {
  bundleVersion: typeof BUNDLE_VERSION;
  savedAt: string; // ISO 8601
  /** EXISTING envelope — graph + positions + inline images/samples. */
  patch: PatchEnvelope;
  /** File-backed asset descriptors (VIDEOBOX). */
  assets: PerformanceAssetRef[];
  /** Global MIDI Learn CC maps. */
  midiBindings: MidiBindingExport[];
  /** MIDI-CV-BUDDY device selections, name-keyed. */
  midiDevices: MidiDeviceBinding[];
  /** GAMEPAD mappings, gamepad.id-keyed. */
  gamepadBindings: GamepadBinding[];
}

// ---------------- Minimal node shapes ----------------
// We read node.data / node.params structurally rather than importing the full
// ModuleNode union, so this module stays decoupled from the registry types and
// unit-tests with plain objects.

interface BundleNode {
  id: string;
  type: string;
  data?: Record<string, unknown> | null;
  params?: Record<string, unknown> | null;
}

type NodeMap = Record<string, BundleNode | undefined>;

// ---------------- Asset / device extraction (pure) ----------------

/**
 * Collect VIDEOBOX asset refs from the live node map. Only nodes with a
 * `fileMeta.handleId` produce a ref (i.e. a file was actually picked and a
 * handle persisted). PICTUREBOX/SAMSLOOP are inline in the envelope, so they
 * don't get a ref here — extend `roles` later if we ever stop inlining them.
 */
export function collectAssetRefs(nodes: NodeMap): PerformanceAssetRef[] {
  const refs: PerformanceAssetRef[] = [];
  for (const node of Object.values(nodes)) {
    if (!node || node.type !== 'videobox') continue;
    const fileMeta = (node.data as { fileMeta?: unknown } | undefined)?.fileMeta as
      | { handleId?: unknown; name?: unknown; size?: unknown; duration?: unknown }
      | null
      | undefined;
    if (!fileMeta || typeof fileMeta.handleId !== 'string') continue;
    refs.push({
      handleId: fileMeta.handleId,
      role: 'video',
      nodeId: node.id,
      filename: typeof fileMeta.name === 'string' ? fileMeta.name : '',
      size: typeof fileMeta.size === 'number' ? fileMeta.size : undefined,
      duration: typeof fileMeta.duration === 'number' ? fileMeta.duration : undefined,
    });
  }
  return refs;
}

/**
 * Collect MIDI-CV-BUDDY device selections keyed by device NAME. The node's
 * `data.lastDeviceId` is the unstable MIDIInput.id; the caller resolves it to
 * a name via the supplied `idToName` lookup (the live MIDIAccess input map).
 * Nodes whose id doesn't resolve to a name are skipped (device not connected
 * at save time — nothing stable to key by).
 */
export function collectMidiDevices(
  nodes: NodeMap,
  resolve: (deviceId: string) => { name: string; manufacturer?: string } | null,
): MidiDeviceBinding[] {
  const out: MidiDeviceBinding[] = [];
  for (const node of Object.values(nodes)) {
    if (!node || node.type !== 'midi-cv-buddy') continue;
    const lastId = (node.data as { lastDeviceId?: unknown } | undefined)?.lastDeviceId;
    if (typeof lastId !== 'string' || lastId.length === 0) continue;
    const dev = resolve(lastId);
    if (!dev || !dev.name) continue;
    out.push({ nodeId: node.id, deviceName: dev.name, manufacturer: dev.manufacturer });
  }
  return out;
}

/**
 * Collect GAMEPAD mappings keyed by gamepad.id. The node carries only
 * `params.padIndex` (slot 0..3); the caller maps that slot to a connected
 * gamepad.id via `resolve` (navigator.getGamepads()[slot]?.id). Slots with no
 * connected pad are still recorded with an empty gamepadId so the slot itself
 * round-trips (the padIndex is already in the envelope params anyway).
 */
export function collectGamepadBindings(
  nodes: NodeMap,
  resolve: (padIndex: number) => string | null,
): GamepadBinding[] {
  const out: GamepadBinding[] = [];
  for (const node of Object.values(nodes)) {
    if (!node || node.type !== 'gamepad') continue;
    const raw = (node.params as { padIndex?: unknown } | undefined)?.padIndex;
    const padIndex = Math.max(0, Math.min(3, Math.round(typeof raw === 'number' ? raw : 0)));
    out.push({ nodeId: node.id, gamepadId: resolve(padIndex) ?? '', padIndex });
  }
  return out;
}

// ---------------- Bundle assembly (pure) ----------------

export interface MakeBundleInput {
  envelope: PatchEnvelope;
  nodes: NodeMap;
  midiBindings: MidiBindingExport[];
  /** MIDIInput.id → name resolver (from the live MIDIAccess). */
  resolveMidiDevice: (deviceId: string) => { name: string; manufacturer?: string } | null;
  /** padIndex (slot) → connected gamepad.id resolver. */
  resolveGamepad: (padIndex: number) => string | null;
}

/**
 * Assemble a PerformanceBundle from an already-made envelope + the live node
 * map + the global MIDI bindings + device resolvers. Pure — the caller does
 * the I/O (makeEnvelope, reading localStorage, querying MIDIAccess/gamepads).
 */
export function makePerformanceBundle(input: MakeBundleInput): PerformanceBundle {
  return {
    bundleVersion: BUNDLE_VERSION,
    savedAt: new Date().toISOString(),
    patch: input.envelope,
    assets: collectAssetRefs(input.nodes),
    midiBindings: input.midiBindings,
    midiDevices: collectMidiDevices(input.nodes, input.resolveMidiDevice),
    gamepadBindings: collectGamepadBindings(input.nodes, input.resolveGamepad),
  };
}

// ---------------- Validation ----------------

export class BundleParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BundleParseError';
  }
}

/**
 * Validate the structural shape of a parsed bundle. Throws BundleParseError on
 * a version mismatch or a missing required field. Tolerant of older/forward
 * shapes only via the version gate — otherwise strict so a corrupt slot fails
 * loudly rather than half-restoring.
 */
export function validateBundle(raw: unknown): PerformanceBundle {
  if (!raw || typeof raw !== 'object') {
    throw new BundleParseError('bundle is not an object');
  }
  const b = raw as Record<string, unknown>;
  if (b.bundleVersion !== BUNDLE_VERSION) {
    throw new BundleParseError(
      `unsupported bundleVersion ${String(b.bundleVersion)} (expected ${BUNDLE_VERSION})`,
    );
  }
  if (typeof b.savedAt !== 'string') throw new BundleParseError('missing savedAt');
  if (!b.patch || typeof b.patch !== 'object') {
    throw new BundleParseError('missing patch envelope');
  }
  // Arrays are normalized to [] when absent so older bundles still load.
  return {
    bundleVersion: BUNDLE_VERSION,
    savedAt: b.savedAt,
    patch: b.patch as PatchEnvelope,
    assets: Array.isArray(b.assets) ? (b.assets as PerformanceAssetRef[]) : [],
    midiBindings: Array.isArray(b.midiBindings) ? (b.midiBindings as MidiBindingExport[]) : [],
    midiDevices: Array.isArray(b.midiDevices) ? (b.midiDevices as MidiDeviceBinding[]) : [],
    gamepadBindings: Array.isArray(b.gamepadBindings)
      ? (b.gamepadBindings as GamepadBinding[])
      : [],
  };
}

// ---------------- MIDI binding merge (load side, pure) ----------------

/**
 * Merge a bundle's MIDI Learn bindings into the existing localStorage set.
 * Risk #6 in the design: blindly overwriting would clobber the user's
 * other-patch bindings. We merge by `key` (moduleId:paramId) — bundle wins for
 * keys it defines (this performance's modules), everything else is preserved.
 * Pure: returns the merged array; the caller writes it back to localStorage.
 */
export function mergeMidiBindings(
  existing: MidiBindingExport[],
  incoming: MidiBindingExport[],
): MidiBindingExport[] {
  const byKey = new Map<string, MidiBindingExport>();
  for (const b of existing) if (b && typeof b.key === 'string') byKey.set(b.key, b);
  for (const b of incoming) if (b && typeof b.key === 'string') byKey.set(b.key, b);
  return [...byKey.values()];
}
