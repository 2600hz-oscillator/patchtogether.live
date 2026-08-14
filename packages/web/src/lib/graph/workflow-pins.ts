// packages/web/src/lib/graph/workflow-pins.ts
//
// WORKFLOW MODE P1 — the PINNED SINGLETON trio + the M/E/C drawer keymap.
// WORKFLOW MODE P2 — extends the same mechanism to the always-on TOPBAR
// SURFACE modules (timelorde / midiclock / audioIn / audioOut — see
// WORKFLOW_PINNED_SURFACES below), which have no drawer: their faces are
// the topbar clock / MIDI-DIN / audio-I/O menus.
//
// Every workflow rackspace always has exactly one MIXMSTRS, one
// ELECTRA CONTROL and one CLIPPLAYER, spawned automatically and flagged
// `data.pinned: true`. Pinned nodes:
//   - render ONLY in their bottom drawer (M / E / C toggles), never as
//     canvas cards (Canvas's flowNodes derivation skips them). This is a
//     REVERSIBLE default pending owner question Q3 (drawer-only vs. also
//     on canvas) — flipping it is deleting one `continue` in Canvas.
//   - are UNDELETABLE: mutate.ts's removePatchNode refuses them, Clear
//     skips them, and the singleton-cleanup pass never plans them.
//   - are EXCLUDED from `maxInstances` counting (graph/cap.ts), so the
//     pinned ELECTRA CONTROL does not consume the type's canvas cap —
//     "additional instances spawn as normal canvas cards".
//
// The pinned flag lives at `node.data.pinned` — the platform's documented
// home for cross-cutting per-node keys (`name`, `controlColor`,
// `rackLocked`) — NOT a new top-level field, so the snapshot bus /
// persistence / sync all carry it with zero plumbing.
//
// DETERMINISTIC IDS make the auto-spawn idempotent under CRDT merge: two
// clients racing the ensure both write `pinned-<type>` and the Y.Map
// converges to ONE entry per type — no duplicate-singleton race, unlike
// the random-id TIMELORDE auto-spawn (which needs the elected-deleter
// cleanup pass to mop up).
//
// PURE + framework-free (no Svelte, no Yjs, no $lib imports beyond types)
// so the plan is unit-testable against plain fixtures; the actual Yjs
// transact lives in Canvas.svelte's workflow ensure $effect.

/** Transaction origin for the pinned-trio auto-spawn. NOT in the
 *  UndoManager's trackedOrigins → the ensure is never undoable (Cmd-Z must
 *  not fight the always-on invariant by removing a pinned module). */
export const WORKFLOW_PIN_SPAWN_ORIGIN = 'workflow-pin-spawn';

/** The always-on spawn contract shared by every workflow pinned module:
 *  the module type, its registry domain, and the deterministic node id
 *  every client agrees on. `presence` picks the satisfaction rule the
 *  planner applies (see planPinnedSpawns). */
export interface PinnedSpawnSpec {
  /** Registered module type id. */
  type: string;
  /** Registry domain the type lives in ('audio' | 'meta'). */
  domain: 'audio' | 'meta';
  /** Deterministic node id (`pinned-<type>`) — the CRDT convergence key. */
  id: string;
  /**
   * When is this spec satisfied?
   *  - 'pinned' (default): a node of the type carrying `data.pinned` exists.
   *    A user-spawned canvas instance of the same type does NOT count — the
   *    always-on hidden instance is spawned regardless (mixmstrs & friends
   *    are multi-instance types).
   *  - 'type': ANY node of the type exists, pinned or not. For RACK
   *    SINGLETONS (timelorde, maxInstances=1): an imported patch
   *    loaded into a workflow rack already carries a canvas TIMELORDE, and
   *    spawning a second (hidden) one would give the rack two competing
   *    clocks — the topbar clock surface targets whichever one exists
   *    instead (resolveWorkflowTimelorde in $lib/ui/workflow).
   */
  presence?: 'pinned' | 'type';
}

/**
 * WHICH bottom-dock SURFACE a pinned singleton's hotkey opens.
 *
 *  - 'drawer'   — the P1 pinned M/E/C drawer (DockRail 'bottom'): ONE occupant,
 *    the shipped behavior for MIXMSTRS + ELECTRA CONTROL.
 *  - 'fullView' — a dock FULL-VIEW PANE, exactly like a module's EXPAND pill
 *    (owner directive 2026-07-26: "opening clip player with c is same as
 *    expanding any other module" — so the built-in clip player can sit
 *    SIDE-BY-SIDE 50/50 with a module instead of being mutually exclusive with
 *    it). The pane is backed by the REAL `pinned-clipplayer` NODE, so it rides
 *    the existing dockStore.fullViewNodeIds machinery with zero synthetic-pane
 *    plumbing: same faceplate frame, same per-pane ✕, same LRU third-expand
 *    replacement, same flip-key (Tab) rear-card flip.
 */
export type PinnedSurface = 'drawer' | 'fullView';

/** One pinned singleton spec with a HOTKEY (the M/E/C trio): a spawn spec plus
 *  its toggle key, header label, and which bottom-dock surface it opens. */
export interface PinnedModuleSpec extends PinnedSpawnSpec {
  /** Toggle key (lowercase). */
  key: 'm' | 'e' | 'c';
  /** Drawer header label. */
  label: string;
  /** Which bottom-dock surface `key` toggles (see PinnedSurface). */
  surface: PinnedSurface;
}

/** The workflow trio, in M / E / C order. */
export const WORKFLOW_PINNED_MODULES: readonly PinnedModuleSpec[] = [
  { type: 'mixmstrs', domain: 'audio', id: 'pinned-mixmstrs', key: 'm', label: 'mixmstrs', surface: 'drawer' },
  { type: 'electraControl', domain: 'meta', id: 'pinned-electraControl', key: 'e', label: 'electra control', surface: 'drawer' },
  // C = EXPAND (owner 2026-07-26): the built-in clip player is a first-class
  // dock PANE, not a mutually-exclusive drawer.
  { type: 'clipplayer', domain: 'audio', id: 'pinned-clipplayer', key: 'c', label: 'clipplayer', surface: 'fullView' },
] as const;

/**
 * WORKFLOW MODE P2 — the always-on TOPBAR SURFACE modules. Same pinned
 * mechanism as the trio (deterministic ids, ensure-effect, undeletable,
 * canvas-hidden) but NO bottom drawer: each one's face is a topbar menu
 * ($lib/ui/workflow — ClockSurface / MidiDinSurface / AudioIoSurface).
 *
 *  - timelorde: the clock-icon surface (BPM readout + tempo knob + tap
 *    tempo + patch-out). presence 'type' — a rack singleton; an existing
 *    canvas TIMELORDE (from an import) satisfies the invariant and the
 *    surface drives it instead.
 *  - midiclock: the hidden MIDI-DIN→TIMELORDE bridge. Inert (no MIDI
 *    access) until the DIN surface's assign flow connects it; assigning
 *    wires its clock/midistart/midistop outputs to TIMELORDE by cable —
 *    the SAME path a hand-patched MIDICLOCK card uses.
 *  - audioIn / audioOut: the 1/8"-plug surface's always-on system I/O.
 *    Multi-instance types, so presence 'pinned' — extra canvas instances
 *    are unrelated to the pinned pair.
 */
export const WORKFLOW_PINNED_SURFACES: readonly PinnedSpawnSpec[] = [
  { type: 'timelorde', domain: 'audio', id: 'pinned-timelorde', presence: 'type' },
  { type: 'midiclock', domain: 'audio', id: 'pinned-midiclock', presence: 'pinned' },
  { type: 'audioIn', domain: 'audio', id: 'pinned-audioIn', presence: 'pinned' },
  { type: 'audioOut', domain: 'audio', id: 'pinned-audioOut', presence: 'pinned' },
] as const;

/** Every always-on workflow module the ensure-effect maintains (trio first,
 *  then the P2 surfaces — spawn order is cosmetic; ids are deterministic). */
export const ALL_WORKFLOW_PINNED: readonly PinnedSpawnSpec[] = [
  ...WORKFLOW_PINNED_MODULES,
  ...WORKFLOW_PINNED_SURFACES,
] as const;

/** Lowercase key → pinned spec (the M/E/C drawer toggles). */
export const DRAWER_KEY_TO_PINNED: ReadonlyMap<string, PinnedModuleSpec> = new Map(
  WORKFLOW_PINNED_MODULES.map((s) => [s.key, s]),
);

/** Minimal node shape the planner inspects. */
export interface PinnedNodeLike {
  type: string;
  data?: { pinned?: unknown } | null;
}

/** True when the node carries the pinned flag. */
export function isPinnedNode(node: PinnedNodeLike | null | undefined): boolean {
  return node?.data?.pinned === true;
}

/**
 * Which always-on workflow modules (M/E/C trio + P2 topbar surfaces) are
 * MISSING from `nodes`? Presence is judged per spec:
 *  - 'pinned' (default): a node of the type carrying `data.pinned === true`
 *    exists (the deterministic id is how writers converge, but presence is
 *    judged by type+flag so a hand-migrated doc still satisfies it).
 *  - 'type': any node of the type exists at all (rack singletons — see
 *    the WORKFLOW_PINNED_SURFACES header).
 *
 * Pure predicate — callers re-check `patch.nodes[spec.id]` inside their
 * Yjs transact before writing (belt + braces; the deterministic id makes
 * a double-write converge anyway).
 */
export function planPinnedSpawns(
  nodes: ReadonlyArray<PinnedNodeLike>,
): PinnedSpawnSpec[] {
  const pinnedTypes = new Set<string>();
  const allTypes = new Set<string>();
  for (const n of nodes) {
    allTypes.add(n.type);
    if (isPinnedNode(n)) pinnedTypes.add(n.type);
  }
  return ALL_WORKFLOW_PINNED.filter((s) =>
    s.presence === 'type' ? !allTypes.has(s.type) : !pinnedTypes.has(s.type),
  );
}

// ---------------- Default wiring: MIXMSTRS master → AUDIO OUT ----------------
//
// Owner directive: "the audio out in the rack should be default wired to the
// master L/R outs from the in rack mixmstrs in workflow mode." The pinned
// MIXMSTRS is the rack's master bus and the pinned AUDIO OUT is the terminal
// sink, so a fresh workflow rack should make sound the moment anything feeds
// the mixer — no hidden hand-patch required.
//
// SEED, not invariant: unlike the node ensure (which self-heals forever),
// these edges are a ONE-SHOT default. The first time both pinned endpoints
// exist we write the wires and stamp `data.workflowDefaultWired: true` on the
// pinned AUDIO OUT (node.data is the documented home for cross-cutting
// per-node keys — `pinned`, `name`, `controlColor`). Once the latch is set the
// planner never re-plans, so a USER deleting the cable is respected — the
// ensure never fights intent. A wholesale node replacement (quickload /
// performance load) either carries the saved latch (respected) or spawns
// fresh pins without it (wires re-seed) — matching the node ensure's
// self-healing story.
//
// DETERMINISTIC edge ids use the platform's edge-id convention
// (`e-<src>-<srcPort>-<dst>-<dstPort>`, the same template handleConnect
// writes), so two clients racing the seed converge on ONE Y.Map entry per
// wire — CRDT-safe exactly like the `pinned-<type>` node ids.

/** The `node.data` latch key on the pinned AUDIO OUT: "the default wires were
 *  seeded once — never re-fight the user over them". */
export const WORKFLOW_DEFAULT_WIRE_LATCH = 'workflowDefaultWired';

/** One default wire (a full Edge-shaped record; ids deterministic). */
export interface WorkflowDefaultWire {
  id: string;
  source: { nodeId: string; portId: string };
  target: { nodeId: string; portId: string };
  sourceType: 'audio';
  targetType: 'audio';
}

/** Pinned MIXMSTRS master L/R → pinned AUDIO OUT L/R. Port ids are pinned by
 *  the defs (mixmstrs.ts outputs / audio-out.ts inputs) + the unit contract. */
export const WORKFLOW_DEFAULT_WIRES: readonly WorkflowDefaultWire[] = [
  {
    id: 'e-pinned-mixmstrs-masterL-pinned-audioOut-L',
    source: { nodeId: 'pinned-mixmstrs', portId: 'masterL' },
    target: { nodeId: 'pinned-audioOut', portId: 'L' },
    sourceType: 'audio',
    targetType: 'audio',
  },
  {
    id: 'e-pinned-mixmstrs-masterR-pinned-audioOut-R',
    source: { nodeId: 'pinned-mixmstrs', portId: 'masterR' },
    target: { nodeId: 'pinned-audioOut', portId: 'R' },
    sourceType: 'audio',
    targetType: 'audio',
  },
] as const;

/** Minimal node shape the wire planner inspects (id + the data latch). */
export interface DefaultWireNodeLike {
  id: string;
  data?: Record<string, unknown> | null;
}

/** Minimal edge shape the wire planner inspects (target occupancy). */
export interface DefaultWireEdgeLike {
  target: { nodeId: string; portId: string };
}

export interface DefaultWirePlan {
  /** Wires to write — the default pairs whose target input is currently
   *  UNOCCUPIED (an input takes one cable; a user's own patch into AUDIO OUT
   *  is never replaced). May be empty even when `latch` is true. */
  wires: WorkflowDefaultWire[];
  /** True when the one-shot latch must be WRITTEN this pass (both pinned
   *  endpoints exist and the latch isn't set yet). False = nothing to do —
   *  either an endpoint is still missing (re-plan next snapshot) or the seed
   *  already ran (never re-fight a user delete). */
  latch: boolean;
}

/**
 * Plan the workflow default wires. Pure predicate over the snapshot — the
 * caller transacts the writes (and re-checks inside the transact, mirroring
 * planPinnedSpawns' belt-and-braces convention).
 */
export function planDefaultWires(
  nodes: ReadonlyArray<DefaultWireNodeLike>,
  edges: ReadonlyArray<DefaultWireEdgeLike | null | undefined>,
): DefaultWirePlan {
  const none: DefaultWirePlan = { wires: [], latch: false };
  const src = nodes.find((n) => n.id === 'pinned-mixmstrs');
  const dst = nodes.find((n) => n.id === 'pinned-audioOut');
  if (!src || !dst) return none; // endpoints still spawning — replan later
  if (dst.data?.[WORKFLOW_DEFAULT_WIRE_LATCH] === true) return none; // seeded once already
  const occupied = new Set<string>();
  for (const e of edges) {
    if (e) occupied.add(`${e.target.nodeId}:${e.target.portId}`);
  }
  return {
    wires: WORKFLOW_DEFAULT_WIRES.filter(
      (w) => !occupied.has(`${w.target.nodeId}:${w.target.portId}`),
    ),
    latch: true,
  };
}

/** Minimal event-target shape for the typing guard (structural, so unit
 *  tests need no DOM). Matches HTMLElement's relevant surface. */
export interface TypingTargetLike {
  tagName?: string;
  isContentEditable?: boolean;
}

/**
 * True when a keydown landed in a text-entry context — an <input>,
 * <textarea>, <select> or contenteditable — where the M/E/C drawer keys
 * (and every other single-letter shortcut) must stay INERT so typing
 * "mec" into a module-name box doesn't strobe three drawers.
 */
export function isTypingTarget(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false;
  const t = target as TypingTargetLike;
  const tag = typeof t.tagName === 'string' ? t.tagName.toUpperCase() : '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return t.isContentEditable === true;
}

// ── THE RACK-FLIP SHORTCUT ────────────────────────────────────────────────
// BARE TAB, by owner ruling (#1629, 2026-08-14): "this app is not intended to
// be keyboard navigable by visually disabled users, and tab flipping is a
// critical feature." #1599 briefly moved the flip to `f` to restore native
// focus traversal (#1508); that trade was reversed — the flip gesture's
// muscle-memory outranks Tab's browser role here, so Tab is CONSUMED by the
// flip everywhere outside a typing target. Shift-Tab is left native.
//
// Do not re-litigate this toward a letter key or native traversal without an
// explicit owner decision — this constant is the single definition both flip
// owners (canvas rear view + dock full-view panes) read, and the unit test
// beside this file re-derives the collision check against
// DRAWER_KEY_TO_PINNED + the viewport-nav keys so a future binding claiming
// the flip key reddens instead of silently double-binding.

/** The rack-flip / dock-flip shortcut key (KeyboardEvent.key). Bare — no modifiers. */
export const RACK_FLIP_KEY = 'Tab';

/** Minimal keyboard-event shape for the flip predicate (structural, so unit
 *  tests need no DOM). Matches KeyboardEvent's relevant surface. */
export interface FlipKeyEventLike {
  key?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

/**
 * True when a keydown is the bare rack-flip shortcut.
 *
 * ONE definition, imported by BOTH Tab owners (the canvas-wide `rearView`
 * flip and the dock full-view pane flip) so the two can never drift onto
 * different keys — the same "a range comes from one place" rule the repo
 * applies to a def and its card.
 *
 * Every modifier combination is rejected: Shift-Tab stays native traversal
 * (the one keyboard path deliberately kept), and Cmd/Ctrl/Alt-Tab belong to
 * the OS. The caller is still responsible for the `isTypingTarget` guard, so
 * Tab inside an input/textarea/select/contenteditable behaves natively.
 */
export function isRackFlipKey(e: FlipKeyEventLike): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return false;
  return typeof e.key === 'string' && e.key.toLowerCase() === RACK_FLIP_KEY.toLowerCase();
}
