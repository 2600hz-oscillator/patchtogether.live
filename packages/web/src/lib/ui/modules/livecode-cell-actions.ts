// packages/web/src/lib/ui/modules/livecode-cell-actions.ts
//
// The LIVECODE faceplate's cell seam, and the ONE evaluation path both of this
// module's surfaces call.
//
// ── ⚠ THE THING PROMOTION WOULD OTHERWISE HAVE DELETED ──────────────────────
//
// `livecodeDef.factory` returns a no-op handle — no AudioNode, no timer, no
// subscription. So unlike its own CLOCKED RUNNER child, whose tick loop lives in
// the factory closure and therefore keeps running with no UI mounted anywhere,
// EVERY evaluation this module has ever performed happened inside
// `LivecodeCard.svelte`'s `runScript()`. `migrated(type)` stops both surfaces
// rendering a promoted module's card, so a promotion that left `run` on the card
// would not have degraded the module — it would have deleted the only thing it
// does.
//
// The fix is not to copy `runScript` into a second component: two evaluators
// would be two answers to "what does Run do". It is to move the evaluation HERE,
// where a plain `.ts` module can be called by the ranked `action` cell (which
// reaches the LANE TILE, so Run is now one click from the rack rather than
// behind an expand) and by the faceplate body — two callers, one
// implementation, and the next surface is a call away rather than a copy.
//
// ── THE EDITOR REGISTRY, AND WHY THE ACTION CANNOT JUST READ `node.data` ────
//
// Both editors debounce their commit by 250 ms (#1583). `node.data.text` is
// therefore up to a quarter-second STALE while someone is typing, and "press Run
// and it ran the version before your last keystroke" is exactly the class #1583
// was filed about. The card solved it by flushing its own debounce inside
// `runScript`, which a shared action cannot do from the outside — so the mounted
// editor PUBLISHES a flush here, node-keyed, and the action calls it when one is
// present. With no editor mounted (a press on the lane tile, whose face has no
// body) there is nothing pending and the committed text IS the live text.
//
// ⚠ NODE-KEYED, NOT COMPONENT-OWNED, for the #1531 / #1574 / #1583 reason: the
// registration rides the component and is released on unmount, but nothing about
// the ACTION depends on a component existing.

import { mutateNode } from '$lib/graph/mutate';
import { patch, ydoc, LOCAL_ORIGIN } from '$lib/graph/store';
import { run } from '$lib/livecode/runtime';
import { applyMutations } from '$lib/livecode/apply';
import type { ModuleNode } from '$lib/graph/types';

/**
 * The card's default width, which is ALSO the spawn geometry: a script's new
 * modules are laid out to the RIGHT of the module that spawned them, and this is
 * how far right. Exported so `LivecodeCard.svelte` imports it rather than
 * re-typing it — the one-place rule, and the reason a promoted face's spawns
 * land exactly where the card's always did.
 */
export const LIVECODE_DEFAULT_WIDTH = 540;

/** Horizontal gap between a LIVECODE and the first module it spawns. */
export const LIVECODE_SPAWN_GAP = 60;

/**
 * How many log lines a run keeps.
 *
 * ⚠ NOT A POPULATION COUNT — it is a POLICY THRESHOLD on a derived quantity.
 * Its value is not "how many log lines there are"; it is how many a Y.Doc entry
 * is willing to carry, because unlike the card's component-local `lastResult`
 * this record SYNCS and PERSISTS, and a script with `log()` inside a loop can
 * emit thousands. The tail is kept rather than the head: the last thing a script
 * printed is the thing you pressed Run to see.
 */
export const LIVECODE_LOG_KEEP_LINES = 200;

/** The outcome record a run writes to `node.data.lastRun`.
 *
 *  Modelled on `frametableSave` (`{ seq, ok, error }`), including the part that
 *  matters: a FAILED run is RECORDED, never dropped, so "never ran" and "ran and
 *  threw" stay distinguishable — the audition ledger's own principle applied to
 *  an evaluation. */
export interface LivecodeRunRecord {
  /** Advances once per press. Present so a SECOND run of an identical script is
   *  still observably a second run. */
  seq: number;
  ok: boolean;
  /** `line:col: message` when the script threw, else null. */
  error: string | null;
  /** How many graph mutations the run emitted (applied on both exits — a script
   *  that spawned three modules and then threw keeps the three). */
  mutations: number;
  /** What the script printed, tail-capped. */
  log: string[];
}

// ── THE MOUNTED-EDITOR REGISTRY ────────────────────────────────────────────

/** nodeId → "flush any pending edit and give me the editor's CURRENT text". */
const editors = new Map<string, () => string>();

/**
 * Publish the mounted editor for `nodeId`. Returns its own release function;
 * call it from `onDestroy` so a collapsed pane leaves no stale reader behind.
 */
export function registerLivecodeEditor(nodeId: string, flush: () => string): () => void {
  editors.set(nodeId, flush);
  return () => {
    // Only release OUR registration: a remount can register before the old
    // component's teardown runs, and clearing unconditionally would drop the
    // live one.
    if (editors.get(nodeId) === flush) editors.delete(nodeId);
  };
}

/** The committed script on a node. */
export function livecodeStoredText(node: ModuleNode | undefined): string {
  const t = (node?.data as Record<string, unknown> | undefined)?.text;
  return typeof t === 'string' ? t : '';
}

/**
 * The text a run should evaluate: the mounted editor's live buffer when there is
 * one (flushed first, so the debounce cannot swallow the last keystroke), else
 * what is committed on the node.
 */
export function livecodeRunSource(nodeId: string): string {
  const flush = editors.get(nodeId);
  if (flush) return flush();
  return livecodeStoredText(patch.nodes[nodeId] as ModuleNode | undefined);
}

/** The last run's outcome, or null on a node that has never been run. */
export function livecodeRunRecord(node: ModuleNode | undefined): LivecodeRunRecord | null {
  const r = (node?.data as Record<string, unknown> | undefined)?.lastRun;
  if (!r || typeof r !== 'object') return null;
  const rec = r as Partial<LivecodeRunRecord>;
  return {
    seq: typeof rec.seq === 'number' ? rec.seq : 0,
    ok: rec.ok !== false,
    error: typeof rec.error === 'string' ? rec.error : null,
    mutations: typeof rec.mutations === 'number' ? rec.mutations : 0,
    log: Array.isArray(rec.log) ? rec.log.filter((l): l is string => typeof l === 'string') : [],
  };
}

/**
 * The RUN sentence — what the card printed as a resting status line, now spoken
 * through `StatusLed.detail` (so `aria-label` + `title`) instead of painted.
 *
 * ⚠ The card's resting copy ("Type a script and press Run") is GONE rather than
 * relocated: it is a state word about the module, and the Run cell's own caption
 * already says what to do.
 */
export function livecodeRunDetail(rec: LivecodeRunRecord | null): string {
  if (!rec) return 'the script has not been run yet';
  if (!rec.ok) return rec.error ?? 'the script threw';
  return `${rec.mutations} rack ${rec.mutations === 1 ? 'change' : 'changes'} applied`;
}

/**
 * Evaluate a LIVECODE node's script and apply what it produced.
 *
 * ⚠ ONE TRANSACTION, `LOCAL_ORIGIN`, ALWAYS. The card's `runScript` skipped the
 * transaction entirely on a zero-mutation run, which is why nothing recorded
 * that a run had happened at all — and it is that gap, not the log, that makes a
 * `data` probe possible here. Pressing Run is ONE user action, so the outcome
 * record and the mutations it explains are undone together.
 *
 * ⚠ THE PARTIAL-FAILURE MUTATIONS ARE APPLIED, exactly as the card applied them:
 * the runtime may emit mutations before throwing and the player generally wants
 * the ones that landed.
 */
export function runLivecodeNode(nodeId: string): LivecodeRunRecord | null {
  const node = patch.nodes[nodeId] as ModuleNode | undefined;
  if (!node) return null;

  const src = livecodeRunSource(nodeId);
  const prev = livecodeRunRecord(node);

  const width = (node.data as Record<string, unknown> | undefined)?.width;
  const originX = (node.position?.x ?? 0)
    + (typeof width === 'number' ? width : LIVECODE_DEFAULT_WIDTH)
    + LIVECODE_SPAWN_GAP;

  const result = run({
    src,
    liveNodes: patch.nodes,
    liveEdges: patch.edges,
    spawnOrigin: { x: originX, y: node.position?.y ?? 0 },
    ownerNodeId: nodeId,
  });

  const lines = (result.ok ? result.log : result.partialLog).map((l) => l.message);
  const record: LivecodeRunRecord = {
    seq: (prev?.seq ?? 0) + 1,
    ok: result.ok,
    error: result.ok ? null : `${result.error.line}:${result.error.col}: ${result.error.message}`,
    mutations: result.mutations.length,
    log: lines.slice(-LIVECODE_LOG_KEEP_LINES),
  };

  ydoc.transact(() => {
    // The committed text and the text that was RUN cannot disagree: if the
    // editor's flush produced something newer, this is where it lands.
    const live = patch.nodes[nodeId] as ModuleNode | undefined;
    if (live) {
      if (!live.data) live.data = {};
      const data = live.data as Record<string, unknown>;
      if (data.text !== src) data.text = src;
      data.lastRun = record;
    }
    if (result.mutations.length > 0) applyMutations(result.mutations);
  }, LOCAL_ORIGIN);

  return record;
}

/** Commit a script to a node without running it — the seam the editors' debounce
 *  flushes through, so `node.data.text` has exactly one writer per surface. */
export function commitLivecodeText(nodeId: string, value: string): void {
  const target = patch.nodes[nodeId] as ModuleNode | undefined;
  if (!target) return;
  if (livecodeStoredText(target) === value) return;
  mutateNode(nodeId, (live) => {
    if (!live.data) live.data = {};
    (live.data as Record<string, unknown>).text = value;
  });
}
