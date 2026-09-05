// packages/web/src/lib/graph/device-slots.ts
//
// NATIVE-SHELL P1 — THE DEVICE-SLOT LAYER.
//
// Two layers with different lifetimes, and this file defines the boundary:
//
//   * the PERSISTENT-DEVICE layer — hardware sessions (camera MediaStreams,
//     display sinks) keyed on RESERVED SLOT IDS that never leave the document;
//   * the SWAPPABLE-PATCH layer — everything else in the Y.Doc, which a load
//     clears and replaces wholesale.
//
// Owner constraints this exists to satisfy, verbatim from the program:
// **device access never breaks**, and **no workflow may even temporarily
// disrupt output**. Loading, saving or swapping a patch must not disturb a
// device session.
//
// ── WHY AN ID AND NOT A TYPE ───────────────────────────────────────────────
//
// A hardware session in this repo is keyed on a NODE ID: the camera source
// registry, the audio-input registry and the present/projector bindings
// (`settings.presentBindings`, keyed `nodeId`) all index by it. A patch load
// clears `patch.nodes` unconditionally (persistence.ts) and the reconciler
// reads a type/domain change at a reused id as remove+add — so today a load
// destroys the id, which destroys the session, which is the interruption.
//
// The fix is therefore not "protect the module" but "protect the ID". A slot
// is a reserved node id with ONE canonical type forever. Everything else about
// the node — its params, its name, its cables — stays ordinary patch content
// that a load is free to replace.
//
// ⚠ THE HONEST GUARANTEE. Yjs has no conditional insert, so a hostile peer CAN
// write a foreign type at a reserved id; the repair below makes that state
// TRANSIENT AND SELF-HEALING (one teardown, then the session returns at the
// same reserved id), not impossible. Do not restate this as "identity change is
// structurally impossible" — that claim was corrected once already on the
// pinned-singleton layer this file extends (workflow-pins.ts). A stronger
// guarantee would have to live OUTSIDE the mutable collaborative graph, and
// that is an owner-level design decision, not an assumption to make here.
//
// ── PRESENCE IS BY ID, DELIBERATELY UNLIKE THE PINNED SINGLETONS ───────────
//
// `workflow-pins.ts` judges presence by TYPE ("is there a mixmstrs?") because a
// pin is an always-on MODULE. A slot is an always-on ADDRESS, so presence is by
// ID. The difference is load-bearing: presence-by-type would let an imported
// patch's own CAMERA satisfy `cam1` while leaving the reserved id free for a
// peer to occupy, which is precisely the hole the layer closes.
//
// ── RIG PROPERTY vs PATCH CONTENT ──────────────────────────────────────────
//
// A slot's DEVICE BINDING (which camera, which monitor) is a property of the
// RIG, not of the patch — the same reasoning the CUE research applied to
// `master` and `outputDeviceId`. Device ids are machine-local and meaningless
// on any other machine, so they must not ride the envelope: a saved patch
// opened elsewhere would carry a stranger's hardware, and in collab each peer
// would fight over the other's cameras. Bindings live in the local binding
// store (`device-slot-bindings.ts`); `DEVICE_SLOT_RIG_KEYS` is the list this
// module strips on the way in and on the way out.
//
// PURE + framework-free (no Svelte, no Yjs, no $lib imports beyond types) so
// every rule here is unit-testable against plain fixtures — the same
// convention workflow-pins.ts follows. The Yjs transacts live in Canvas.

import { DEFAULT_VIDEO_OUT_ID, videoZoneSlotPos } from './channel-columns';

/** What kind of hardware a slot fronts. */
export type DeviceSlotKind = 'camera' | 'output';

/** Where the slot's face lives. `header` = the workflow topbar patch area
 *  (the 📷 camera manager); `video-zone` = the purple video zone below the
 *  channel lanes, where output sinks render as ordinary cards. */
export type DeviceSlotZone = 'header' | 'video-zone';

/** The owner-facing slot names, in order. These are the names in the program
 *  brief — `cam1..cam4` and `output1..output4` — and they are the stable
 *  vocabulary the shell's pre-flight UI and the binding store both key on. */
export const CAMERA_SLOT_NAMES = ['cam1', 'cam2', 'cam3', 'cam4'] as const;
export const OUTPUT_SLOT_NAMES = ['output1', 'output2', 'output3', 'output4'] as const;

export type CameraSlotName = (typeof CAMERA_SLOT_NAMES)[number];
export type OutputSlotName = (typeof OUTPUT_SLOT_NAMES)[number];
export type DeviceSlotName = CameraSlotName | OutputSlotName;

/** One reserved device slot. */
export interface DeviceSlotSpec {
  /** Owner-facing slot name (`cam1` … `output4`). */
  slot: DeviceSlotName;
  /** The RESERVED node id. Stable forever — this is the session key. */
  id: string;
  kind: DeviceSlotKind;
  /** Canonical module type. One type forever, by construction. */
  type: string;
  /** Canonical registry domain. */
  domain: 'video';
  zone: DeviceSlotZone;
  /** 0-based ordinal within the slot's zone (drives layout + labels). */
  index: number;
  /**
   * Canonical `data.pinned` for this slot.
   *
   * ⚠ PINNED IS NOT A FREE HARDENING — IT IS ALSO THE CANVAS-HIDE BIT.
   * `isCanvasHiddenNode` is `pinned || hiddenCard` (hidden-card.ts), so
   * pinning a node removes its card. That is exactly right for a CAMERA slot,
   * whose face is the header's 📷 manager, and exactly wrong for an OUTPUT
   * slot, whose card in the purple zone is the thing the operator patches into
   * and presents from. Hence per-slot, not a constant.
   *
   * The two kinds therefore reach undeletability by different routes:
   *   camera — `data.pinned` (removePatchNode + Clear both already refuse it,
   *            and graph/cap.ts exempts it from `maxInstances`, so four
   *            reserved cameras do not consume cameraInput's four-per-rack
   *            budget);
   *   output — the reserved-id guard alone (`isDeviceSlotId`), which every
   *            delete path consults alongside `isPinnedNode`.
   *
   * And it is repaired IN BOTH DIRECTIONS (see
   * `planDeviceSlotIdentityRepairs`): a peer writing `pinned: true` onto an
   * output slot makes the rack's master video sink vanish from the purple zone
   * with no delete and no error — a one-field, fully-reachable attack on the
   * surface the owner presents from.
   */
  pinned: boolean;
  /**
   * Canonical `data.hiddenCard` for this slot.
   *
   * Camera slots carry BOTH flags, and the second one is load-bearing rather
   * than belt-and-braces. `hiddenCard` is what the workflow camera manager
   * lists on (`isWorkflowCameraNode` = type match AND `isHiddenCardNode`), and
   * that manager owns the ALWAYS-MOUNTED `CameraInputCard` host which owns the
   * `getUserMedia` gesture. A pinned-only camera would be canvas-hidden AND
   * absent from the manager's list — and it would get no headless mount either
   * (`needsHeadlessSourceMount` refuses a lane-omitted node whose type is not a
   * CARD_PRODUCER, and `cameraInput` is not one), so it would be a camera slot
   * with no path to ever acquire a stream.
   */
  hiddenCard: boolean;
  /** Nominal card width (px) for the purple-zone packing layout. Ignored for
   *  header slots, which render no card. */
  nominalWidth: number;
}

/** Reserved-id prefix for slots minted by this layer. */
export const DEVICE_SLOT_ID_PREFIX = 'slot:';

/** The four camera slots: hidden `cameraInput` instances whose face is the
 *  workflow topbar 📷 manager (CameraSurface). */
export const CAMERA_SLOTS: readonly DeviceSlotSpec[] = CAMERA_SLOT_NAMES.map((slot, index) => ({
  slot,
  id: `${DEVICE_SLOT_ID_PREFIX}${slot}`,
  kind: 'camera' as const,
  type: 'cameraInput',
  domain: 'video' as const,
  zone: 'header' as const,
  index,
  pinned: true,
  hiddenCard: true,
  nominalWidth: 0,
}));

/**
 * The four output slots: `videoOut` sinks rendered as cards in the purple
 * video zone.
 *
 * ⚠ SLOT `output1` KEEPS THE HISTORICAL ID `workflow-videoOut`, and that is a
 * decision, not an oversight. That id is the deterministic id every existing
 * rack's default video sink already carries. Renaming it to `slot:output1`
 * would be a delete of one id and an add of another — which is EXACTLY the
 * remove+add teardown this whole layer exists to prevent, inflicted on every
 * rack in the fleet at once, on the one slot most likely to be presenting.
 * Consumers never see the asymmetry: they read `spec.slot` and `spec.id`.
 */
export const OUTPUT_SLOTS: readonly DeviceSlotSpec[] = OUTPUT_SLOT_NAMES.map((slot, index) => ({
  slot,
  id: index === 0 ? DEFAULT_VIDEO_OUT_ID : `${DEVICE_SLOT_ID_PREFIX}${slot}`,
  kind: 'output' as const,
  type: 'videoOut',
  domain: 'video' as const,
  zone: 'video-zone' as const,
  index,
  pinned: false,
  hiddenCard: false,
  // Matches VIDEO_ZONE_DEFAULTS' measurement of the videoOut card.
  nominalWidth: 360,
}));

/** Every reserved device slot, cameras first. */
export const DEVICE_SLOTS: readonly DeviceSlotSpec[] = [...CAMERA_SLOTS, ...OUTPUT_SLOTS];

/** Every reserved slot node id — for guards that must not treat a reserved id
 *  as ordinary patch content (delete, Clear, duplicate, the load merge). */
export const RESERVED_DEVICE_SLOT_IDS: ReadonlySet<string> = new Set(
  DEVICE_SLOTS.map((s) => s.id),
);

const SLOT_BY_ID: ReadonlyMap<string, DeviceSlotSpec> = new Map(
  DEVICE_SLOTS.map((s) => [s.id, s]),
);
const SLOT_BY_NAME: ReadonlyMap<string, DeviceSlotSpec> = new Map(
  DEVICE_SLOTS.map((s) => [s.slot, s]),
);

/** True when `id` is a reserved device-slot node id. */
export function isDeviceSlotId(id: string | null | undefined): boolean {
  return typeof id === 'string' && RESERVED_DEVICE_SLOT_IDS.has(id);
}

/** The slot spec for a reserved node id, or null. */
export function deviceSlotForId(id: string | null | undefined): DeviceSlotSpec | null {
  return typeof id === 'string' ? SLOT_BY_ID.get(id) ?? null : null;
}

/** The slot spec for an owner-facing slot name (`cam2`), or null. */
export function deviceSlotForName(slot: string | null | undefined): DeviceSlotSpec | null {
  return typeof slot === 'string' ? SLOT_BY_NAME.get(slot) ?? null : null;
}

/** Grid-snapped spawn position for an output slot in the purple video zone.
 *  Slot 0 keeps the historical `videoOutSpawnPos()` coordinates by
 *  construction (both go through `videoZoneSlotPos`), so adopting this layer
 *  never moves a rack's existing video sink. */
export function outputSlotPosition(spec: DeviceSlotSpec): { x: number; y: number } {
  return videoZoneSlotPos(spec.index);
}

// ── PRESENCE ───────────────────────────────────────────────────────────────

/** Minimal node shape the slot planners inspect. */
export interface DeviceSlotNodeLike {
  id?: string;
  type?: string;
  domain?: string;
  data?: Record<string, unknown> | null;
}

/**
 * Which reserved slots are MISSING from `nodes`?
 *
 * Presence is by ID (see the header). Pure predicate — the caller re-checks
 * `patch.nodes[spec.id]` inside its Yjs transact, mirroring
 * `planPinnedSpawns`' belt-and-braces convention. Deterministic ids make two
 * racing clients converge on ONE Y.Map entry per slot.
 */
export function planDeviceSlotSpawns(
  nodes: ReadonlyArray<DeviceSlotNodeLike | null | undefined>,
): DeviceSlotSpec[] {
  const present = new Set<string>();
  for (const n of nodes) {
    if (n && typeof n.id === 'string') present.add(n.id);
  }
  return DEVICE_SLOTS.filter((s) => !present.has(s.id));
}

// ── IDENTITY REPAIR ────────────────────────────────────────────────────────
//
// The same defence workflow-pins.ts applies to `pinned-*`, extended to slots —
// with one field the pinned repair does not have, because slots need it and
// pins do not.
//
// `type`/`domain` are the two fields `identityChanged` reads
// (audio/reconciler.ts), so canonicalising them IS the device-session defence:
// a peer's retype is read as remove+add, the engine node is disposed, and for a
// camera slot that disposal is the MediaStream.
//
// ⚠ `pinned` IS CANONICALISED IN BOTH DIRECTIONS HERE, unlike the pinned
// repair, which only ever SETS it. A camera slot must stay pinned (that is what
// keeps its face in the header and its instance off the `maxInstances` budget);
// an OUTPUT slot must stay UN-pinned, because `isCanvasHiddenNode` is
// `pinned || hiddenCard` — so a peer writing `pinned: true` onto
// `workflow-videoOut` makes the rack's master video sink vanish from the purple
// zone with no delete and no error. That is a one-field, fully-reachable attack
// on the exact surface the owner is presenting from, and nothing in the tree
// closed it before this.
//
// As in the pinned repair, ONLY the named fields are written: `params`,
// `position`, `data.name` and every other per-node key are legitimate user
// state, and a repair that flattened them would be a hardening that breaks
// legitimate use.

/** One reserved slot id whose occupant drifted off-canon. `fields` names WHAT
 *  was wrong, so the applier writes only that and a test can assert the
 *  planner detected the specific attack. */
export interface DeviceSlotIdentityRepair {
  id: string;
  slot: DeviceSlotName;
  type: string;
  domain: 'video';
  /** Canonical value for `data.pinned` when `fields` includes `'pinned'`. */
  pinned: boolean;
  /** Canonical value for `data.hiddenCard` when `fields` includes it. */
  hiddenCard: boolean;
  fields: ReadonlyArray<'type' | 'domain' | 'pinned' | 'hiddenCard'>;
}

/**
 * Which reserved slot ids are occupied by a node whose identity has drifted?
 *
 * Pure predicate over the snapshot; the caller transacts. Returns [] in steady
 * state and for ABSENT ids (that is `planDeviceSlotSpawns`' job). Idempotent
 * field writes derived from a constant table, so racing peers converge without
 * an elected deleter — same argument as `planPinnedIdentityRepairs`.
 */
export function planDeviceSlotIdentityRepairs(
  nodes: ReadonlyArray<DeviceSlotNodeLike | null | undefined>,
): DeviceSlotIdentityRepair[] {
  const byId = new Map<string, DeviceSlotNodeLike>();
  for (const n of nodes) {
    if (n && typeof n.id === 'string') byId.set(n.id, n);
  }
  const out: DeviceSlotIdentityRepair[] = [];
  for (const spec of DEVICE_SLOTS) {
    const node = byId.get(spec.id);
    if (!node) continue;
    const fields: Array<'type' | 'domain' | 'pinned' | 'hiddenCard'> = [];
    if (node.type !== spec.type) fields.push('type');
    if (node.domain !== spec.domain) fields.push('domain');
    if ((node.data?.pinned === true) !== spec.pinned) fields.push('pinned');
    if ((node.data?.hiddenCard === true) !== spec.hiddenCard) fields.push('hiddenCard');
    if (fields.length > 0) {
      out.push({
        id: spec.id,
        slot: spec.slot,
        type: spec.type,
        domain: spec.domain,
        pinned: spec.pinned,
        hiddenCard: spec.hiddenCard,
        fields,
      });
    }
  }
  return out;
}

// ── RIG PROPERTIES ─────────────────────────────────────────────────────────

/**
 * `node.data` keys that are RIG properties, not patch content.
 *
 *  - `deviceId` — the camera the slot is bound to. `CameraInputCard` persists
 *    its dropdown pick here (workflow-cameras.ts `readCameraDeviceId`).
 *    Browser device ids are per-origin, per-machine and rotate on a permission
 *    reset, so the value is meaningless anywhere but the machine that wrote it.
 *  - `deviceLabel` — the human name the card writes beside the id, and the ONLY
 *    thing that still names the hardware once the id has rotated (a different
 *    USB port, a driver reinstall, cleared site data). It travels WITH the id
 *    or the rebind resolver has nothing to fall back to — so it is the same
 *    rig property wearing a different type, and splitting the pair would leave
 *    a slot able to resolve a camera it was never told about.
 *
 * Kept deliberately SHORT. Everything not on this list stays patch content, so
 * the failure mode of an omission is a machine-specific value riding a save —
 * visible and fixable — rather than silent loss of user state.
 *
 * NOTE the display binding is NOT here: a projector's monitor is held in
 * `settings.presentBindings` (present-bindings.ts), not in `node.data`, and
 * #2354 already settled its authority question (under the shell, the shell's
 * display map wins and the patch copy is migrated out once). This layer's
 * contribution to that contract is only that the KEY it is keyed on — the node
 * id — now survives a patch load.
 */
export const DEVICE_SLOT_RIG_KEYS: readonly string[] = ['deviceId', 'deviceLabel'];

/**
 * Strip rig-owned keys from a slot node's `data`, in place, and report which
 * were removed.
 *
 * Applied on the way OUT (nothing machine-specific rides the envelope) and on
 * the way IN (a foreign envelope's stale bindings never reach the live doc).
 * Returns the removed keys so the caller can trace/diagnose rather than
 * silently discarding.
 */
export function stripRigBindings(data: Record<string, unknown> | null | undefined): string[] {
  if (!data) return [];
  const removed: string[] = [];
  for (const key of DEVICE_SLOT_RIG_KEYS) {
    if (key in data) {
      delete data[key];
      removed.push(key);
    }
  }
  return removed;
}

// ── ENVELOPE MERGE ─────────────────────────────────────────────────────────
//
// `loadEnvelopeIntoStore` clears `patch.nodes` unconditionally and re-adds the
// envelope's nodes. For a reserved slot id that clear is the teardown, so the
// load path asks this module two questions instead:
//
//   1. which live ids must the clear pass SKIP?  (`isDeviceSlotId`)
//   2. what does an INCOMING node at a reserved id become?
//
// Question 2 matters because the contract-lock cannot see envelope DATA. A
// hand-edited or foreign envelope carrying a different type at a slot id would
// otherwise reach the insert pass, and a type change at a reused id is EXACTLY
// the remove+add teardown — the layer's own mechanism firing against its own
// invariant. So the slot's type always wins.

/** What the load pass should do with an incoming node landing on a reserved
 *  slot id. */
export type SlotMergeAction =
  /** Type matched: keep the incoming node's params/name, strip rig keys. */
  | 'merge'
  /** Type differed: the slot's canonical identity wins, foreign params are
   *  discarded. The live node is kept and only its user-facing content is
   *  reset — the id, and therefore the session, is never disturbed. */
  | 'coerce';

export interface SlotMergeDecision {
  id: string;
  slot: DeviceSlotName;
  action: SlotMergeAction;
  /** Type carried by the incoming node (for the diagnostic line). */
  incomingType: string;
  /** Rig keys stripped off the incoming node's data. */
  strippedRigKeys: readonly string[];
}

/**
 * Decide, for one incoming envelope node, what a load should do with it.
 *
 * Returns null when the node is ordinary patch content (the overwhelming
 * majority) so the caller's hot loop stays unchanged. MUTATES the incoming
 * node's `data` to strip rig keys — the load path owns that object outright
 * (`toJSON()` severed the Yjs proxies), the same footing on which
 * `stripTransientDataFields` already mutates it.
 */
export function decideSlotMerge(node: {
  id: string;
  type: string;
  data?: Record<string, unknown> | null;
}): SlotMergeDecision | null {
  const spec = deviceSlotForId(node.id);
  if (!spec) return null;
  const strippedRigKeys = stripRigBindings(node.data);
  return {
    id: spec.id,
    slot: spec.slot,
    action: node.type === spec.type ? 'merge' : 'coerce',
    incomingType: String(node.type),
    strippedRigKeys,
  };
}

/** Diagnostic line for a coerced slot node — a foreign type was dropped at a
 *  reserved id. Surfaced through the ordinary load-diagnostics notice so the
 *  user is told, rather than the loader silently rewriting their file. */
export function slotCoercionReason(decision: SlotMergeDecision): string {
  return (
    `reserved device slot ${decision.slot}: incoming "${decision.incomingType}" ` +
    `replaced by "${deviceSlotForId(decision.id)?.type}" (the slot's device session ` +
    `is keyed on this id and its type is fixed)`
  );
}

// ── LAZY ENGINES — AN UNUSED SLOT COSTS NOTHING ────────────────────────────
//
// Eight always-present nodes are eight always-present ENGINE nodes, and on a
// software renderer that is not free: the product's own responsiveness guard
// (`main thread must answer fast`, whose budget scales with the number of live
// video engines) went over budget in three specs across three CI runs once the
// slots were baked in. The answer is to remove the cost, not to raise the
// bound — a bound raised to fit a slower rack is a gate re-pinned to match the
// regression it exists to catch.
//
// So a slot node always EXISTS — that is what reserves the id, keeps the row in
// the camera manager, keeps the card in the purple zone, and keeps every guard
// in this file meaningful — but a slot nobody is using does not instantiate a
// video-domain engine. It mounts on FIRST USE: the same shape the clip recorder
// uses (a rack that never records holds no recorder) and the same shape this
// layer already applies to camera card hosts.
//
// ⚠ THE CONTINUITY GUARANTEE IS UNAFFECTED, AND THAT IS WHY THIS IS SAFE. Every
// promise in this file is keyed on the ID surviving, and an INERT slot has no
// session to protect: no stream, no socket, no claim. The moment it acquires
// one it is live by definition, because acquiring is exactly what makes it
// non-inert. Laziness can therefore only apply to slots for which the
// continuity question does not yet arise.
//
// ⚠ `output1` IS NEVER INERT. It is the historical `workflow-videoOut` — the
// rack's master video sink, the id `resolveMasterVideoOutId` returns, and the
// slot most likely to be presenting. Continuity outranks boot cost there. It
// also makes the floor EXACT rather than approximate: a rack with slots then
// holds the same video-engine population as a rack without them, which is a
// thing a test can assert honestly.

/** Minimal edge shape the inert-slot planner inspects. */
export interface SlotEdgeLike {
  source: { nodeId: string };
  target: { nodeId: string };
}

/** True when this slot must hold an engine regardless of use. */
export function isAlwaysLiveSlot(id: string): boolean {
  return id === DEFAULT_VIDEO_OUT_ID;
}

/**
 * Which reserved slot ids are INERT right now — present in the graph, but with
 * nothing to run, so the reconciler gives them no engine node.
 *
 * A slot is inert when BOTH hold:
 *   - nothing is BOUND to it (no `DEVICE_SLOT_RIG_KEYS` value — no camera
 *     chosen, so there is nothing to acquire); and
 *   - nothing is ROUTED through it (no edge touches it in either direction).
 *
 * The edge half is what makes "first use" include PATCHING, not only binding:
 * cable something into `output3` and it becomes a working sink on that gesture.
 * It also means this can never silently drop a user's cable — an edge existing
 * is itself what makes the slot live.
 *
 * Pure, and O(nodes + edges) because it runs on the reconciler's hot path.
 */
export function planInertSlots(
  nodes: ReadonlyArray<DeviceSlotNodeLike | null | undefined>,
  edges: ReadonlyArray<SlotEdgeLike | null | undefined>,
): Set<string> {
  const inert = new Set<string>();
  for (const n of nodes) {
    if (!n || typeof n.id !== 'string') continue;
    if (!RESERVED_DEVICE_SLOT_IDS.has(n.id) || isAlwaysLiveSlot(n.id)) continue;
    const data = n.data;
    const bound = !!data && DEVICE_SLOT_RIG_KEYS.some((k) => data[k] !== undefined);
    if (!bound) inert.add(n.id);
  }
  // Checked only when something is actually inert, so a fully-bound rig never
  // walks the edge list.
  if (inert.size > 0) {
    for (const e of edges) {
      if (!e) continue;
      inert.delete(e.source.nodeId);
      inert.delete(e.target.nodeId);
      if (inert.size === 0) break;
    }
  }
  return inert;
}

// ── DUPLICATE ──────────────────────────────────────────────────────────────

/**
 * `node.data` keys that carry SLOT/PIN IDENTITY and must never survive a
 * duplicate.
 *
 * ⚠ THIS IS A PRE-EXISTING HOLE THIS LAYER WOULD HAVE WIDENED. `buildDuplicate`
 * mints a fresh id but deep-clones `data` wholesale, so duplicating any node
 * carrying `pinned: true` produces a node that is UNDELETABLE
 * (`removePatchNode` and Clear both refuse `data.pinned`) at an id nothing
 * reserves, canvas-hidden (`isCanvasHiddenNode`), and exempt from its type's
 * `maxInstances` — an unremovable ghost with no card to right-click. It is not
 * reachable for today's pinned singletons only because they are canvas-hidden
 * and so have no card to duplicate FROM; an output slot is a visible card, so
 * the moment a slot is retyped or re-pinned by a peer the path opens.
 *
 * Stripping is the whole fix: a duplicate of a slot is a perfectly good
 * ORDINARY module of the same type, which is what the gesture means.
 */
export const DEVICE_SLOT_IDENTITY_DATA_KEYS: readonly string[] = [
  'pinned',
  'hiddenCard',
  // Layout latches owned by the video-zone placer: a clone must be freely
  // placeable rather than inheriting "already placed + locked".
  'videoZonePlaced',
];

/** Strip slot/pin identity keys from a duplicate's cloned `data`, in place.
 *  Returns the removed keys. Safe on any node — a no-op for ordinary content. */
export function stripSlotIdentityForDuplicate(
  data: Record<string, unknown> | null | undefined,
): string[] {
  if (!data) return [];
  const removed: string[] = [];
  for (const key of DEVICE_SLOT_IDENTITY_DATA_KEYS) {
    if (key in data) {
      delete data[key];
      removed.push(key);
    }
  }
  return removed;
}

// ── PURPLE-ZONE LAYOUT ─────────────────────────────────────────────────────

/** The layout view the video-zone packer needs for an output slot: the same
 *  three fields `VIDEO_ZONE_DEFAULTS` entries expose to `placeVideoZoneDefaults`.
 *
 *  ⚠ DELIBERATELY NOT ADDED TO `VIDEO_ZONE_DEFAULTS` ITSELF. That list is also
 *  the SEEDING list (`VIDEO_ZONE_EXTRA_DEFAULTS` derives from it), and its
 *  entries are one-shot latched seeds a user delete is respected against.
 *  A slot is the opposite: an invariant re-asserted forever. Sharing the list
 *  would have made every output slot presence-by-TYPE and one-shot — which is
 *  precisely the semantics this layer exists to replace. */
export const OUTPUT_SLOT_LAYOUT: readonly {
  id: string;
  type: string;
  nominalWidth: number;
}[] = OUTPUT_SLOTS.filter((s) => s.id !== DEFAULT_VIDEO_OUT_ID).map((s) => ({
  id: s.id,
  type: s.type,
  nominalWidth: s.nominalWidth,
}));
