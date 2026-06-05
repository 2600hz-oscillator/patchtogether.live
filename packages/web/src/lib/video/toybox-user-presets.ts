// packages/web/src/lib/video/toybox-user-presets.ts
//
// TOYBOX *user* presets — a small localStorage-backed registry of patches the
// user SAVES from the card (distinct from the read-only BUNDLED presets shipped
// in the manifest). A saved entry is the VERBATIM toybox node.data blob (layers
// + combine + cvRoutes + cvInputs); images, custom shader source, and custom OBJ
// source already live INLINE in node.data, so they ride along. Videos do NOT —
// localStorage can't hold large media — so a saved (local) preset omits video
// bytes; the layer keeps its videoSource/videoName but the bytes must be
// re-supplied (a fresh file pick) or, for full portability, use EXPORT (.zip).
//
// PURE / DOM-DECOUPLED: every fn takes an injectable Storage-like (default
// globalThis.localStorage) and is wrapped in try/catch so a private-mode /
// quota-full / corrupt-JSON store degrades gracefully (read → []; write → false)
// instead of throwing. That makes the registry fully unit-testable WITHOUT a DOM.

/** The localStorage key the registry lives under (versioned for migrations). */
export const USER_PRESETS_KEY = 'toybox.userPresets.v1';

/** One saved user preset. `data` is the VERBATIM toybox node.data blob. */
export interface ToyboxUserPreset {
  /** Stable unique id (also the dropdown value). */
  id: string;
  /** Human label (what the SAVE prompt captured). */
  label: string;
  /** The VERBATIM toybox node.data (layers/combine/cvRoutes/cvInputs/…). */
  data: Record<string, unknown>;
  /** Epoch-ms save stamp (newest first in the list). */
  savedAt: number;
}

/** The minimal Storage surface we use (so tests can inject a fake). */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Resolve the default store (the browser's localStorage) or null if absent
 *  (SSR / non-DOM unit env) — callers then no-op gracefully. */
function defaultStore(): StorageLike | null {
  try {
    const ls = (globalThis as { localStorage?: StorageLike }).localStorage;
    return ls ?? null;
  } catch {
    // Accessing localStorage can THROW in some sandboxed/blocked contexts.
    return null;
  }
}

/** A registry entry is valid iff it has the required id/label/data/savedAt. */
function isValidEntry(v: unknown): v is ToyboxUserPreset {
  if (!v || typeof v !== 'object') return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.id === 'string' &&
    typeof e.label === 'string' &&
    typeof e.savedAt === 'number' &&
    !!e.data &&
    typeof e.data === 'object'
  );
}

/** Deep-clone plain JSON (node.data is plain JSON once read off the proxy). */
function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * List all saved user presets (newest first). Never throws: a missing /
 * corrupt / non-array store yields `[]`, and invalid entries are filtered out.
 */
export function listUserPresets(store: StorageLike | null = defaultStore()): ToyboxUserPreset[] {
  if (!store) return [];
  let raw: string | null;
  try {
    raw = store.getItem(USER_PRESETS_KEY);
  } catch {
    return [];
  }
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return []; // corrupt JSON → treat as empty (a later save overwrites it)
  }
  if (!Array.isArray(parsed)) return [];
  const out = parsed.filter(isValidEntry) as ToyboxUserPreset[];
  out.sort((a, b) => b.savedAt - a.savedAt); // newest first
  return out;
}

/** Look up one saved preset by id (null if absent). */
export function getUserPreset(
  id: string,
  store: StorageLike | null = defaultStore(),
): ToyboxUserPreset | null {
  return listUserPresets(store).find((p) => p.id === id) ?? null;
}

/** Generate a reasonably-unique id for a new save (no external dep). */
function makeId(): string {
  const rnd = Math.random().toString(36).slice(2, 10);
  return `user-${Date.now().toString(36)}-${rnd}`;
}

/**
 * Persist a new user preset (label + a VERBATIM node.data blob). Returns the
 * stored entry on success, or `null` if the write failed (quota exceeded /
 * blocked store / serialise error). The `data` is deep-cloned before storing so
 * a later mutation of the live node can't retroactively change the saved copy.
 *
 * NOTE: localStorage can't hold large videos — a saved preset stores node.data
 * only (images/shader/obj inline). Videos are preserved ONLY via EXPORT (.zip).
 */
export function saveUserPreset(
  label: string,
  data: Record<string, unknown>,
  store: StorageLike | null = defaultStore(),
): ToyboxUserPreset | null {
  if (!store) return null;
  let entry: ToyboxUserPreset;
  try {
    entry = {
      id: makeId(),
      label: (label || 'Untitled').trim() || 'Untitled',
      data: clone(data),
      savedAt: Date.now(),
    };
  } catch {
    return null; // node.data wasn't cleanly serialisable
  }
  const list = listUserPresets(store);
  list.unshift(entry);
  try {
    store.setItem(USER_PRESETS_KEY, JSON.stringify(list));
  } catch {
    // Quota exceeded / blocked — the save did not persist.
    return null;
  }
  return entry;
}

/**
 * Delete a saved user preset by id. Returns true if an entry was removed (and
 * the new list persisted), false otherwise (absent id or a write failure).
 */
export function deleteUserPreset(
  id: string,
  store: StorageLike | null = defaultStore(),
): boolean {
  if (!store) return false;
  const list = listUserPresets(store);
  const next = list.filter((p) => p.id !== id);
  if (next.length === list.length) return false; // nothing matched
  try {
    store.setItem(USER_PRESETS_KEY, JSON.stringify(next));
  } catch {
    return false;
  }
  return true;
}
