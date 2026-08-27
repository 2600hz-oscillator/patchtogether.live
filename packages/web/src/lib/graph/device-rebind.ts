// packages/web/src/lib/graph/device-rebind.ts
//
// REBINDING A SAVED PATCH TO THE PHYSICAL DEVICES THAT ARE ACTUALLY PLUGGED IN.
//
// ── THE PROBLEM, MEASURED ────────────────────────────────────────────────────
//
// Every device-owning module in this rack persists an IDENTIFIER that the
// browser is free to change between sessions, and nothing else:
//
//   * `cameraInput`  → `node.data.deviceId`      (MediaDeviceInfo.deviceId)
//   * MIDI modules   → `node.data.lastDeviceId`  (MIDIInput/MIDIOutput.id)
//   * `gamepad`      → `padIndex` — not an identifier AT ALL, but the
//                      `navigator.getGamepads()` SLOT
//
// None of those is a stable name for a piece of hardware:
//
//   * `MediaDeviceInfo.deviceId` is a per-ORIGIN hash over a browser salt plus
//     an OS device identifier. It survives an ordinary reboot most of the time
//     and does NOT survive clearing site data, a profile change, or the OS
//     enumerating the device differently (a different USB port, a hub, a driver
//     reinstall). It is also the empty string until camera permission is
//     granted, which is why every consumer must gate on labels being visible.
//   * `MIDIInput.id` is explicitly implementation-defined.
//     `performance-bundle.ts` already says so in as many words: "`lastDeviceId`
//     is the unstable MIDIInput/MIDIOutput.id".
//   * The Gamepad API has NO persistent instance id. `gamepad.id` is a MODEL
//     string ("054c-05c4-Wireless Controller (…)"), and `index` is assignment
//     order — a pad does not even appear in the array until it is TOUCHED, so
//     the slot a pad lands in is decided by which one the player pressed first.
//
// ── WHY A SHARED RESOLVER RATHER THAN THREE ─────────────────────────────────
//
// One of the three already had half of this. `resolveMidiDeviceId`
// (performance-bundle.ts) does "saved id, else saved name" — but only for MIDI,
// only on the performance-`.zip` load path, and with a plain `find(name === …)`
// that has the ambiguity hole below. This module is that idea, generalised,
// tie-broken, and reportable; `resolveMidiDeviceId` now delegates to it.
//
// ── ⚠ THE HOLE IN THE OBVIOUS VERSION, AND WHY IT IS NOT HYPOTHETICAL ───────
//
// "Fall back to a device with the same name" is ambiguous EXACTLY where devices
// are most likely to need rebinding, and this repo has already paid for it once:
// `launchpad-device.svelte.ts` documents that on Windows, WinMM exposes several
// interfaces of ONE device under the SAME name, distinguished only by a
// "MIDIIN2 (…)" / "MIDIOUT2 (…)" prefix — which is why the Launchpad binder has
// a bespoke interface-picking rule. Two identical webcams report identical
// labels for the same reason. So the fallback needs a DECIDED tie-break, not a
// `find`.
//
// The rules, in order, and each one reports HOW it matched so a caller can say
// so rather than re-pointing a patch silently:
//
//   1. EXACT ID. The saved id is still connected → bind it. Highest confidence,
//      and the common case on the same machine.
//   2. UNIQUE NAME. Exactly one connected device carries the saved name → bind
//      it. This is the case the whole module exists for.
//   3. AMBIGUOUS NAME. More than one connected device carries that name. Prefer
//      one no OTHER node has already claimed; if that leaves exactly one, it is
//      still a decision worth reporting. If it does not, take the first in
//      enumeration order — DETERMINISTIC, so the same rack rebinds the same way
//      twice — and report every candidate.
//   4. NONE. Nothing matched. The caller leaves the module unbound and says so.
//
// ⚠ AMBIGUITY BINDS RATHER THAN REFUSING, deliberately. A same-NAME collision
// means the same MODEL of device, so the worst case is the left webcam instead
// of the right one; refusing would strand a rack that has two identical cameras
// in it, which is the normal way to own two cameras. What must never happen is
// the SILENT part — hence `matchedBy` and `candidates` on every result.
//
// ⚠ AND THE SET FORM IS THE ONE TO REACH FOR. Resolving nodes one at a time
// lets a name match steal a device that a later node would have matched EXACTLY
// — the swap this module exists to prevent, reintroduced by the fix. See
// `resolveDeviceSet`.

/** One device the browser currently reports as connected. */
export interface ConnectedDevice {
  /** The volatile per-session identifier (deviceId / MIDIPort.id / slot key). */
  readonly id: string;
  /** The human-facing name: MediaDeviceInfo.label, MIDIPort.name, gamepad.id. */
  readonly name: string;
}

/** What a saved patch remembered about a device. Both halves optional: patches
 *  written before names were persisted carry only an id, and must keep behaving
 *  exactly as they do today. */
export interface SavedDevice {
  readonly id?: string | null;
  readonly name?: string | null;
}

/** HOW a binding was reached — the thing a caller surfaces to the player. */
export type DeviceMatch =
  /** The saved id is still connected. */
  | 'exact-id'
  /** The saved id is gone; exactly one connected device carries the saved name. */
  | 'name-unique'
  /** Several devices carry that name; one was chosen by the tie-break. */
  | 'name-ambiguous'
  /** Nothing matched — the caller must leave this module unbound. */
  | 'none';

export interface DeviceRebind {
  /** The id to bind, or null when nothing matched. */
  readonly id: string | null;
  readonly matchedBy: DeviceMatch;
  /**
   * On `name-ambiguous`, EVERY connected id that carried the saved name, in
   * enumeration order — including the one chosen. Empty otherwise.
   *
   * It exists so the caller can say "two devices are called this and I picked
   * the first", which is the difference between a rebind a player can reason
   * about and one that quietly moved.
   */
  readonly candidates: readonly string[];
}

const NO_MATCH: DeviceRebind = { id: null, matchedBy: 'none', candidates: [] };

/**
 * Resolve ONE saved device against the currently-connected list.
 *
 * `claimed` is the set of ids already taken by other nodes in this same rack.
 * It only ever influences rule 3 (an ambiguous name); an exact id match ignores
 * it, because two nodes deliberately pointed at one device is a legal patch.
 */
export function resolveDevice(
  saved: SavedDevice,
  connected: readonly ConnectedDevice[],
  claimed: ReadonlySet<string> = new Set(),
): DeviceRebind {
  // 1. EXACT ID.
  if (saved.id) {
    const byId = connected.find((c) => c.id === saved.id);
    if (byId) return { id: byId.id, matchedBy: 'exact-id', candidates: [] };
  }

  // 2/3. BY NAME. An empty name never matches — an unlabelled device (camera
  // permission not yet granted) would otherwise match every other unlabelled
  // one, which is the worst possible rebind.
  if (saved.name) {
    const named = connected.filter((c) => c.name === saved.name);
    if (named.length === 1) {
      return { id: named[0]!.id, matchedBy: 'name-unique', candidates: [] };
    }
    if (named.length > 1) {
      const free = named.filter((c) => !claimed.has(c.id));
      const chosen = (free.length > 0 ? free : named)[0]!;
      return {
        id: chosen.id,
        matchedBy: 'name-ambiguous',
        candidates: named.map((c) => c.id),
      };
    }
  }

  return NO_MATCH;
}

/** One saved binding in a set resolution — the caller's key plus what it saved. */
export interface SavedDeviceEntry extends SavedDevice {
  /** Caller-chosen key (a node id). Returned as the map key. */
  readonly key: string;
}

/**
 * Resolve a WHOLE RACK's saved devices at once, in TWO PASSES.
 *
 * ⚠ THE PASS ORDER IS THE POINT, and resolving node-by-node gets it wrong.
 * Given two nodes — A saved (id: gone, name: "USB Camera") and B saved
 * (id: still-connected-X, name: "USB Camera") — a single-pass walk in node
 * order lets A's NAME match consume device X. B then binds X as well, because
 * an exact-id match deliberately ignores `claimed` (two nodes pointed at one
 * device is a legal patch). So the failure is a COLLISION rather than a swap:
 * both modules end up on ONE camera while the other sits connected and unused,
 * and the module A was supposed to get is the one nobody is on. The negative
 * control in the test file drives exactly that, on this same resolver.
 *
 * So: every exact-id match is settled FIRST and its device marked claimed, and
 * only then are the name fallbacks resolved against what is left. Pure, and
 * order-independent by construction — the returned map is keyed, never
 * positional.
 */
export function resolveDeviceSet(
  saved: readonly SavedDeviceEntry[],
  connected: readonly ConnectedDevice[],
): Map<string, DeviceRebind> {
  const out = new Map<string, DeviceRebind>();
  const claimed = new Set<string>();

  // PASS 1 — exact ids only.
  const unresolved: SavedDeviceEntry[] = [];
  for (const entry of saved) {
    const hit = entry.id ? connected.find((c) => c.id === entry.id) : undefined;
    if (hit) {
      out.set(entry.key, { id: hit.id, matchedBy: 'exact-id', candidates: [] });
      claimed.add(hit.id);
    } else {
      unresolved.push(entry);
    }
  }

  // PASS 2 — names, against everything pass 1 did not take.
  for (const entry of unresolved) {
    const r = resolveDevice({ id: null, name: entry.name }, connected, claimed);
    out.set(entry.key, r);
    if (r.id) claimed.add(r.id);
  }

  return out;
}

/**
 * Should the caller write the resolved id back over the saved one?
 *
 * TRUE for a name match: the id it produced is this session's id for that
 * hardware, so persisting it makes the NEXT load an exact-id hit and the
 * fallback self-healing. FALSE for an exact hit (nothing changed) and for no
 * match (there is nothing to write, and clearing the saved id would destroy the
 * only record of what the patch wanted).
 */
export function shouldRewriteSavedId(r: DeviceRebind): boolean {
  return r.matchedBy === 'name-unique' || r.matchedBy === 'name-ambiguous';
}

// ── GAMEPADS — THE SAME IDEA WITH THE RULES THE OTHER WAY UP ────────────────
//
// ⚠ A GAMEPAD DOES NOT FIT `resolveDevice`, AND FORCING IT WOULD REPRODUCE THE
// BUG. Cameras and MIDI ports save a genuine IDENTIFIER that is merely
// regenerated sometimes, so "trust the id, fall back to the name" is right. A
// gamepad node saves `padIndex` — a SLOT, 0..3 — which is not an identifier at
// all: `navigator.getGamepads()` assigns it by connection order, and a pad does
// not even appear in the array until it is physically TOUCHED. So the slot is
// decided by which controller the player happened to press first, and trusting
// it "exactly" is the whole defect.
//
// So the order INVERTS: identity first, position only as a tie-break.
//
//   1. ID AT THE REMEMBERED SLOT — the same model is where it was. The common
//      case, and the one that must stay fast and silent.
//   2. ID ELSEWHERE — the pads came up in a different order. Take the lowest
//      slot carrying that id: deterministic, so a rack rebinds identically twice.
//   3. SLOT ONLY — nothing carries the saved id (a different controller, or a
//      patch saved before ids were persisted). Fall back to whatever is in the
//      remembered slot, which is TODAY'S BEHAVIOUR verbatim.
//   4. NONE — the slot is empty too.
//
// ⚠ `gamepad.id` IS A MODEL STRING, NOT AN INSTANCE ID —
// "054c-05c4-Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 05c4)".
// Two identical controllers are INDISTINGUISHABLE by it. That is exactly why
// rule 1 exists and comes first: with two identical pads, each node keeps the
// slot it had, so the pair is stable even though neither can be told apart.

/** One `navigator.getGamepads()` entry, flattened. `null` slots are omitted. */
export interface ConnectedPad {
  /** Its index in `navigator.getGamepads()`. */
  readonly slot: number;
  /** `gamepad.id` — a MODEL string, not an instance id. */
  readonly id: string;
}

export type GamepadMatch = 'id-at-slot' | 'id-elsewhere' | 'slot-only' | 'none';

export interface GamepadRebind {
  /** The slot to read, or null when nothing is connected to bind. */
  readonly slot: number | null;
  readonly matchedBy: GamepadMatch;
}

/**
 * Resolve which `navigator.getGamepads()` slot a saved gamepad node should read.
 *
 * `savedId` is the `gamepad.id` the node last saw (absent on patches written
 * before it was persisted — those resolve by slot, exactly as they do today).
 */
export function resolveGamepadSlot(
  saved: { readonly slot: number; readonly id?: string | null },
  pads: readonly ConnectedPad[],
): GamepadRebind {
  if (saved.id) {
    const atSlot = pads.find((p) => p.slot === saved.slot && p.id === saved.id);
    if (atSlot) return { slot: atSlot.slot, matchedBy: 'id-at-slot' };

    // Lowest slot wins, so the answer does not depend on array order.
    const elsewhere = pads
      .filter((p) => p.id === saved.id)
      .sort((a, b) => a.slot - b.slot)[0];
    if (elsewhere) return { slot: elsewhere.slot, matchedBy: 'id-elsewhere' };
  }

  const occupied = pads.find((p) => p.slot === saved.slot);
  if (occupied) return { slot: occupied.slot, matchedBy: 'slot-only' };

  return { slot: null, matchedBy: 'none' };
}
