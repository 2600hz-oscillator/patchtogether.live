// packages/web/src/lib/ui/workflow/rack-status-model.ts
//
// RACK-GLOBAL STATUS (#2024 item 3, owner ruling 2026-08-21: *"close the
// gap"*) — the face home for state that is a property of THE RACK rather than
// of this node's params.
//
// ── THE GAP ────────────────────────────────────────────────────────────────
//
// `cvBuddy` / `cvBuddyMini` share one card body, and nearly everything that
// body shows is rack-global: which of the ES-9's eight physical jacks THIS
// instance was allocated (a function of every CV Buddy on the rack, of either
// kind), whether an ES-9 exists at all, and a CLOCK SECTION that renders on the
// id-smallest instance ONLY — because RUN and CLOCK are single-source, so every
// other instance's PPQN would be a dial wired to nothing.
//
// None of it is reachable by a param-reading resolver: there is no `ParamDef`
// whose value is "am I the clock owner", and there cannot be, because the
// answer changes when a DIFFERENT node is added or deleted. `contract-lock`
// cannot see it, `module-face-lint`'s completeness sweep cannot see it, and a
// face built without a home for it silently deletes the affordance — the #1865
// shape, one tier up from `hideControls`.
//
// ── WHAT THIS MODEL DECIDES, AND WHAT IT DELIBERATELY DOES NOT ─────────────
//
// It decides ONE thing: which control bands the shell must not render on a
// NON-PRIMARY node. That is STRUCTURE — which bands exist this frame — and
// structure is free under the resting-text rulings, exactly as `bandFocus` is
// (it paints nothing; it decides what is drawn).
//
// The other half of rack-global state — the SLOT NAME and the indicator lamps
// — is NOT here and cannot be: what an ES-9 slot is called is module knowledge.
// That lives on the module's own `fullViewBody`, painted through the
// `StatusLed` primitive, which is the shape that keeps a measurement out of a
// text node. This model is the SHELL's half.
//
// ── ⚠ THE PRECONDITION IS THE SAFETY ARGUMENT, COPIED FROM MONITOR MODE ────
//
// `faceMonitorPlan` refuses to hide bands unless the module's own body is
// painting, because a faceplate with no bands and no picture is a BLANK PLATE
// — a worse outcome than the one being fixed. The identical hazard is sharper
// here: `cvBuddy` has TWO params and both of them are clock params, so hiding
// the clock band hides the ENTIRE control surface. `hiddenBands` is therefore
// empty unless `extBody` is true, and `extBody` is dock-only
// (`dockFullViewHeadPlan`), so a lane tile never suppresses anything.
//
// ⚠ THE LANE TILE IS THE STATED BLIND SPOT of that policy, named rather than
// hidden: on a 192x180 tile a NON-PRIMARY instance still paints its clock
// controls, because the status body that would explain their absence does not
// fit there and a tile with neither is blank. The legacy card hides them at
// every tier. This is the one place the face is less exact than the card, and
// it is the same trade `monitor` already makes.
//
// ── ⚠ ONE TRUTH FOR "WHO IS PRIMARY" ───────────────────────────────────────
//
// `primaryNodeId` below is the LEXICOGRAPHICALLY SMALLEST peer id — the same
// converged, collab-safe tie-break `allocateCvBuddySlots` uses for RUN/CLOCK
// and that `singleton-cleanup` uses for its own. It is re-derived here rather
// than imported because the allocator's rule is subtly RICHER (it hands the
// clock to the first instance that actually got note jacks, which matters only
// if the id-smallest one could ever be inert — it cannot, since the pool always
// fits the first instance). Two rules that agree today can drift, so the
// agreement is ASSERTED EXHAUSTIVELY rather than assumed:
// `cv-buddy-face-model.test.ts` runs every kind-combination up to four
// instances through the real allocator and requires `ownsClock` to be true for
// exactly the node this function names. If the allocator's rule ever changes,
// that test goes red and names the case — instead of the face quietly hiding
// the clock band on the instance that owns the clock.

import { isFaceplateView, type ShellView } from './module-shell-model';

/**
 * `face.rackStatus`, as the shell reads it. The same serialisable-data shape
 * every other `face` field uses — never a closure, so the declaration stays
 * inspectable by the gates.
 */
export interface RackStatusDecl {
  /** Reviewer-facing argument. NEVER PAINTED — asserted unreachable from the
   *  shell by `face-resting-text-source.test.ts`. */
  why: string;
  /** The module types that share the rack-global resource. */
  peers: readonly string[];
  /** Band ids that render ONLY on the primary instance. */
  primaryOnlyBands: readonly string[];
}

/** What rack-global status does to this faceplate, this frame. */
export interface RackStatusPlan {
  /** This node is the rack PRIMARY among its declared peers — the instance
   *  that owns the single-source resource. TRUE for an undeclared face and for
   *  a lone instance, which is why a fresh spawn shows everything. */
  primary: boolean;
  /** Band ids the shell must not render. Empty whenever the face does not
   *  declare `rackStatus`, whenever this node IS the primary, and whenever the
   *  module's own status body is not painting. */
  hiddenBands: ReadonlySet<string>;
  /** The status surface is REACHABLE here — the face declares rack status and
   *  the body carrying its indicators is painting. False on the lane. */
  available: boolean;
}

const NONE: ReadonlySet<string> = new Set<string>();

/**
 * The PRIMARY node among a peer set: the lexicographically smallest id.
 *
 * `null` for an empty set — which is not the same as "this node is primary",
 * and the caller must not collapse the two. A peer set that does not contain
 * the node being rendered means the patch has not caught up with the node
 * (mid-spawn, mid-delete), and the honest answer there is to render everything
 * rather than to guess.
 */
export function primaryNodeId(peerIds: Iterable<string>): string | null {
  let best: string | null = null;
  for (const id of peerIds) {
    if (best === null || id < best) best = id;
  }
  return best;
}

/**
 * Every node in the patch whose type is one of `peers`, as ids.
 *
 * Takes the node map rather than a pre-filtered list on purpose: "which nodes
 * count as peers" is part of the rule, so it is inside the model where the
 * unit test can reach it, not a filter expression in Svelte markup.
 */
export function peerNodeIds(
  nodes: Readonly<Record<string, { type?: string } | undefined>>,
  peers: readonly string[],
): string[] {
  const want = new Set(peers);
  const out: string[] = [];
  for (const [id, n] of Object.entries(nodes)) {
    if (n && typeof n.type === 'string' && want.has(n.type)) out.push(id);
  }
  return out;
}

/**
 * Resolve rack-global status for one node, this frame. Pure — no def, no
 * engine, no DOM, no store.
 *
 * ⚠ THE THREE WAYS THIS RETURNS "HIDE NOTHING" ARE ALL DELIBERATE and are
 * asserted separately by `rack-status-model.test.ts`, because collapsing them
 * would make a real bug look like a policy:
 *
 *   1. UNDECLARED — the overwhelming majority of faces. Inert, always.
 *   2. NOT A FACEPLATE VIEW, or no status body painting — the blank-plate
 *      precondition above.
 *   3. THIS NODE IS PRIMARY — there is nothing to suppress; it owns the thing.
 */
export function rackStatusPlan(args: {
  view: ShellView;
  /** `face.rackStatus`, or undefined for the faces that declare none. */
  declared: RackStatusDecl | undefined;
  /** `dockFullViewHeadPlan().extBody` — the module's own body IS painting. */
  extBody: boolean;
  /** The node being rendered. */
  nodeId: string;
  /** The live patch's node map. */
  nodes: Readonly<Record<string, { type?: string } | undefined>>;
}): RackStatusPlan {
  const decl = args.declared;
  if (!decl) return { primary: true, hiddenBands: NONE, available: false };

  const ids = peerNodeIds(args.nodes, decl.peers);
  const winner = primaryNodeId(ids);
  // ⚠ `winner === null` (the node is not in the map yet) resolves to PRIMARY,
  // i.e. hide nothing. Failing open is right for a suppression: the cost of
  // being wrong is a dead dial for one frame, and the cost of failing closed is
  // a faceplate that renders no controls at all while the patch settles.
  const primary = winner === null || winner === args.nodeId;

  const available = isFaceplateView(args.view) && args.extBody;
  const hiddenBands =
    available && !primary && decl.primaryOnlyBands.length > 0
      ? new Set(decl.primaryOnlyBands)
      : NONE;

  return { primary, hiddenBands, available };
}
