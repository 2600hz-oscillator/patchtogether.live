import * as Y from 'yjs';
import { SETTINGS_MAP_KEY } from '$lib/graph/persistence';
import { resolveScreens, type ScreenDescriptor } from './screen-identity';

export const SETTINGS_PRESENT_BINDINGS = 'presentBindings';

export interface PresentBinding {
  nodeId: string;
  screen: ScreenDescriptor;
}

export interface LiveScreen {
  id: string;
  descriptor: ScreenDescriptor;
}

function isDescriptor(v: unknown): v is ScreenDescriptor {
  if (!v || typeof v !== 'object') return false;
  const d = v as Record<string, unknown>;
  return (
    typeof d.label === 'string' &&
    typeof d.isInternal === 'boolean' &&
    typeof d.width === 'number' &&
    typeof d.height === 'number' &&
    typeof d.dpr === 'number' &&
    typeof d.left === 'number' &&
    typeof d.top === 'number'
  );
}

/** Bindings ride the shared doc, so they can arrive from a peer on a different
 *  rig or from a patch saved months ago — validate rather than trust. */
export function readPresentBindings(ydoc: Y.Doc): PresentBinding[] {
  const raw = ydoc.getMap(SETTINGS_MAP_KEY).get(SETTINGS_PRESENT_BINDINGS);
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (b): b is PresentBinding =>
      !!b && typeof b === 'object' &&
      typeof (b as PresentBinding).nodeId === 'string' &&
      isDescriptor((b as PresentBinding).screen),
  );
}

export function writePresentBindings(
  ydoc: Y.Doc,
  bindings: PresentBinding[],
  origin?: unknown,
): void {
  ydoc.transact(() => {
    ydoc.getMap(SETTINGS_MAP_KEY).set(SETTINGS_PRESENT_BINDINGS, bindings);
  }, origin);
}

/**
 * DELETE the key, rather than writing an empty array over it.
 *
 * The migration off patch-owned placement (see `decideRestore`) has to leave no
 * second opinion behind, and `[]` is not the same as absent: `readPresentBindings`
 * returns `[]` for both, but the key itself still rides every save, every
 * .ptperf zip and every peer sync — an empty promise that the document owns
 * display placement. Removing it is what actually ends the collision.
 */
export function clearPresentBindings(ydoc: Y.Doc, origin?: unknown): void {
  ydoc.transact(() => {
    ydoc.getMap(SETTINGS_MAP_KEY).delete(SETTINGS_PRESENT_BINDINGS);
  }, origin);
}

export interface RestoreTarget {
  nodeId: string;
  screenId: string;
}

/**
 * Resolve saved bindings against the displays attached right now.
 *
 * Bindings whose node is gone are dropped BEFORE matching, so a deleted
 * module cannot consume the display its replacement wants.
 */
export function planRestore(
  saved: PresentBinding[],
  live: LiveScreen[],
  liveNodeIds: Iterable<string>,
): RestoreTarget[] {
  const nodes = new Set(liveNodeIds);
  const wanted = saved.filter((b) => nodes.has(b.nodeId));
  const matched = resolveScreens(
    wanted.map((b) => b.screen),
    live.map((s) => s.descriptor),
  );
  const targets: RestoreTarget[] = [];
  for (let i = 0; i < wanted.length; i++) {
    if (matched[i] === -1) continue;
    targets.push({ nodeId: wanted[i].nodeId, screenId: live[matched[i]].id });
  }
  return targets;
}

/**
 * True when every display this patch was saved against is present now.
 *
 * Gates AUTOMATIC restore. The bindings live in the shared doc, so a rack-mate
 * opening the same patch would otherwise get projector windows thrown onto
 * their monitors; requiring the whole saved set to resolve means a partial or
 * foreign rig falls back to the explicit affordance instead.
 */
export function rigMatchesSaved(saved: PresentBinding[], live: LiveScreen[]): boolean {
  if (saved.length === 0) return false;
  const matched = resolveScreens(
    saved.map((b) => b.screen),
    live.map((s) => s.descriptor),
  );
  return matched.every((m) => m !== -1);
}

export function bindingsFromPairs(
  pairs: { nodeId: string; screenId: string }[],
  live: LiveScreen[],
): PresentBinding[] {
  const byId = new Map(live.map((s) => [s.id, s.descriptor]));
  const out: PresentBinding[] = [];
  for (const p of pairs) {
    const descriptor = byId.get(p.screenId);
    if (descriptor) out.push({ nodeId: p.nodeId, screen: descriptor });
  }
  return out;
}

export interface RestoreOutcome {
  /** A restore pass ran to completion (as opposed to: not yet, or declined). */
  attempted: boolean;
  /** Bindings that resolved to an attached display. */
  expected: number;
  /** Popups that actually opened. */
  opened: number;
}

/**
 * Whether the live present set may be written back over the saved one.
 *
 * The write effect fires the moment the registry is empty — which on load is
 * BEFORE restore has opened anything. Writing then would erase the very
 * bindings we are about to read. So persistence stays disarmed until a restore
 * pass has resolved, and stays disarmed if that pass resolved displays but
 * opened nothing: that is the popup blocker, not the user stopping a
 * projector, and the saved set must survive it.
 */
export function mayPersist(outcome: RestoreOutcome): boolean {
  if (!outcome.attempted) return false;
  return outcome.expected === 0 || outcome.opened > 0;
}

/**
 * Whether the live present set can be faithfully described right now.
 *
 * `bindingsFromPairs` resolves each screenId through the caller's screen list,
 * so an unpopulated list silently turns every live projector into no binding at
 * all — and writing THAT is indistinguishable from the user having stopped
 * presenting. Refuse instead: a save that records nothing is recoverable, a
 * save that erases the rig is not.
 */
export function canDescribeBindings(
  pairs: { nodeId: string; screenId: string }[],
  live: LiveScreen[],
): boolean {
  return pairs.length === 0 || live.length > 0;
}

/**
 * Read bindings out of a saved envelope rather than the live doc.
 *
 * `loadEnvelopeIntoStore` materialises the envelope in a THROWAWAY doc, lifts
 * `nodes`, `edges` and `videoAspect` off it, and writes only nodes and edges
 * into the live doc — the settings map never lands. `videoAspect` survives only
 * because it is hand-carried on LoadResult. So a load path has to read its
 * bindings from the envelope it is holding; reading the live doc finds the
 * PREVIOUS patch's settings, which for a fresh rack is nothing at all.
 */
export function readPresentBindingsFromUpdate(base64Update: string): PresentBinding[] {
  const binary = atob(base64Update);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, bytes);
  } catch {
    return [];
  }
  return readPresentBindings(doc);
}

// ───────────────────────────────────────────────────────────────────────────
// WHO OWNS DISPLAY PLACEMENT
// ───────────────────────────────────────────────────────────────────────────

/**
 * Which authority decides where a projector opens.
 *
 * ⚠ THERE CAN ONLY EVER BE ONE, AND UNTIL NOW THERE WAS NO RULE SAYING SO.
 * Two placement surfaces already exist in the tree and they disagree about
 * scope by construction:
 *
 *   'patch' — `settings.presentBindings`, above. It rides the SHARED Y.Doc, so
 *             it travels with the document: into a save file, a .ptperf zip, and
 *             across to a rack-mate. Canvas restores it automatically on mount,
 *             on JSON import and on perf-zip load.
 *   'shell' — the native shell's display map. Local, per-machine, owned by the
 *             operator's rig, and NOT part of any document.
 *
 * Leave both live and an old patch reopens its legacy projectors while the
 * shell creates its own sinks — same monitors, two classes of window, opposite
 * lifetimes, and one of them swept away on the next patch load. The rule is
 * therefore absolute rather than a merge: under the shell the shell wins, the
 * patch's copy is migrated out ONCE, and the document stops accumulating a
 * second opinion.
 */
export type PresentAuthority = 'patch' | 'shell';

export function presentAuthority(native: boolean): PresentAuthority {
  return native ? 'shell' : 'patch';
}

export interface RestoreDecisionArgs {
  /** Running inside the native shell (platform/native.nativeAvailable()). */
  native: boolean;
  /** Bindings read from the doc or the envelope being loaded. */
  saved: PresentBinding[];
  /** Displays attached right now. Empty means window-management is not granted. */
  live: LiveScreen[];
}

export type RestoreAction =
  /** Open the saved projectors — the browser path, rig matched. */
  | 'restore'
  /** The shell owns placement; this load must open nothing here. */
  | 'defer-to-shell'
  /** Nothing to do, or the rig does not match. Bindings are KEPT. */
  | 'decline';

export interface RestoreDecision {
  action: RestoreAction;
  /** One line for the trace panel — every path traces, including do-nothing
   *  ones, because "no line in the console" must not mean two different things. */
  reason: string;
  /** True only on the shell path, and only while the doc still carries a
   *  binding: the shared copy must be cleared exactly once so it stops being a
   *  second opinion (and stops travelling to a rack-mate who has no shell). */
  migrateOut: boolean;
  /** May the live present set be written back over the saved one after this? */
  armWrite: boolean;
}

/**
 * The precedence rule, as one pure decision.
 *
 * Pure and exported so the rule is unit-pinned rather than spread across three
 * call sites in Canvas — and so the shell branch is testable today, before any
 * shell exists to run it.
 */
export function decideRestore(args: RestoreDecisionArgs): RestoreDecision {
  const { native, saved, live } = args;

  if (native) {
    // ⚠ NO MERGE, NO FALLBACK, NO "restore them anyway if the shell has no map
    // yet". A half-honoured document binding is how you get two windows on one
    // projector. The shell places outputs; this build's job is to stop writing
    // a competing answer into the document and to hand over whatever it holds.
    return {
      action: 'defer-to-shell',
      reason:
        `present restore: native shell owns display placement — ` +
        `${saved.length} patch binding(s) ${saved.length ? 'migrated out of the shared doc' : 'found'}, ` +
        'nothing opened here',
      migrateOut: saved.length > 0,
      armWrite: false,
    };
  }

  if (saved.length === 0) {
    return {
      action: 'decline',
      reason: `present restore: nothing saved — write armed (${live.length} display(s) known)`,
      migrateOut: false,
      armWrite: true,
    };
  }
  if (live.length === 0) {
    return {
      action: 'decline',
      reason:
        'present restore: no display list — window-management not granted for this origin; bindings kept',
      migrateOut: false,
      armWrite: false,
    };
  }
  if (!rigMatchesSaved(saved, live)) {
    // ⚠ AND SPECIFICALLY: NOT ONTO THE PRIMARY DISPLAY. A performer whose
    // projector is unplugged gets nothing and a line saying so — never their
    // own laptop screen, silently, mid-set.
    return {
      action: 'decline',
      reason: `present restore: saved rig (${saved.length} display(s)) not attached — bindings kept, nothing relocated to this machine's primary display`,
      migrateOut: false,
      armWrite: false,
    };
  }
  return {
    action: 'restore',
    reason: `present restore: rig matched, opening ${saved.length} saved projector(s)`,
    migrateOut: false,
    armWrite: false, // armed by mayPersist() once the open pass has run.
  };
}

/**
 * The opaque identity a sink carries as `?slot=` on its URL.
 *
 * ⚠ WITHOUT IT THE SHELL CANNOT ROUTE ITS OWN OUTPUT WINDOWS. Every projector
 * is opened as `window.open('/present', '_blank', '<geometry>')` — identical
 * URL, identical window name, identical feature shape — so a native
 * `setWindowOpenHandler` has NO discriminator between "output slot 2's sink"
 * and "an old patch's restored projector" and cannot allow one while denying
 * the other. This is the discriminator.
 *
 * Stable for a (node, display) pair so the same projector keeps the same
 * identity across a reopen, and URL-safe by construction: screen ids are
 * fingerprints containing `|`, `@` and `#`, which are encoded at the call site
 * (`sinkUrl`), but the separator here must not be one of them.
 */
export function presentSlotKey(nodeId: string, screenId: string): string {
  return `${nodeId}::${screenId}`;
}

/** Split a slot key back into its parts, or null if it is not one. The shell's
 *  window-open handler is the consumer; exported here so both sides read one
 *  definition of the shape. */
export function parsePresentSlotKey(
  slot: string,
): { nodeId: string; screenId: string } | null {
  const at = slot.indexOf('::');
  if (at <= 0 || at + 2 >= slot.length) return null;
  return { nodeId: slot.slice(0, at), screenId: slot.slice(at + 2) };
}
