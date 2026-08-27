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
