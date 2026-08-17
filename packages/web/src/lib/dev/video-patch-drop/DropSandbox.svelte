<script lang="ts">
  // ⛔ DEV SANDBOX — a WORKING drop-to-patch gesture. Nothing in the engine
  // imports this, and it is deliberately NOT wired into the rack: the owner
  // reviews the gesture here first.
  //
  // Everything about the drag is xyflow's own, unmodified: the same
  // `<SvelteFlow>` and the same `onnodedragstop` seam Canvas.svelte uses. What
  // this file adds is the four decisions the library does not make. Three live
  // in `drop-target.ts` (which one, how much, and the reasoning); the fourth —
  // what happens to the card, and what one undo covers — lives here, because it
  // is about the graph rather than the geometry.
  //
  // ── DECISION 3: THE CARD SNAPS BACK.  This is the one with teeth. ────────
  // A drop that opens the modal restores the dragged node's PRE-DRAG position
  // before anything else happens. Three reasons, in increasing order of force:
  //
  //  1. The gesture's purpose is "patch these two", not "move this card". Where
  //     you released is an artefact of aiming, not a layout intention.
  //  2. Staying put leaves the card sitting ON TOP of the module you just
  //     patched into — occluding the thing you were working on.
  //  3. ⚠ THE DECIDING ONE. In the shipped handler, POSITION DECIDES LANE
  //     MEMBERSHIP. `handleNodeDragStop` hit-tests the dropped card's centre
  //     against the lane bands and re-assigns `data.channel` / `data.sendSlot`
  //     from the result (Canvas.svelte:4407-4484, "POSITION DECIDES
  //     MEMBERSHIP: a drop outside the painted band in EITHER axis is null →
  //     unassigned"). So a modal-opening drop that LEFT the card where it
  //     landed would silently reparent it into whatever lane it happened to be
  //     over — a second, invisible effect the user never asked for.
  //
  //     Restoring the position first makes that impossible BY CONSTRUCTION
  //     rather than by a guard someone has to remember. The membership pass
  //     downstream computes from the pre-drag coordinates, so it reaches
  //     exactly the conclusion it would have reached had the drag never
  //     happened. The property is not "we are careful not to reparent"; it is
  //     "there is no new position for a reparent to be derived from".
  //
  //  ⚠ AND WHEN NO TARGET IS CLAIMED, THIS FILE DOES NOTHING AT ALL. The
  //  handler returns before touching a position, so an ordinary move is
  //  bit-for-bit the drag xyflow already performed. That is the whole
  //  "doesn't alter non-modal drops" argument, and it is why the decision
  //  function is pure and returns `targetId: null` rather than throwing or
  //  mutating.
  //
  // ── DECISION 4: ONE MODAL SESSION IS ONE UNDO ───────────────────────────
  // Rows STAGE; Enter commits the staged set in one go; `undo()` removes that
  // whole set. The unit of undo is the session, not the click, because a
  // half-applied patch set is the failure mode — the same atomic-apply
  // requirement the randomizer has. Staging is what buys that without needing
  // an undo-transaction grouping trick: by the time anything is written, the
  // full set is already known.
  //
  // ⚠ The undo stack here is LOCAL to the sandbox — it is not the Y.Doc
  // UndoManager. See the adoption note on the route: wiring this for real means
  // one `ydoc.transact(fn, LOCAL_ORIGIN)` around the committed set, which is
  // the same grouping the sandbox models.
  import { untrack } from 'svelte';
  import { SvelteFlow, Background, Controls, type Node, type Edge } from '@xyflow/svelte';
  import SandboxFace from './SandboxFace.svelte';
  import DropPatchModal from './DropPatchModal.svelte';
  import { pickDropTarget, type DropRect, type DropTargetDecision } from './drop-target';
  import { dropEdgeKey, type DropDefLike, type DropEdge } from './drop-plan';

  interface Props {
    /** Which modules to put on the canvas, in order. */
    seed: { id: string; label: string; def: DropDefLike; x: number; y: number }[];
    repairCandidates?: readonly DropDefLike[];
  }
  let { seed, repairCandidates = [] }: Props = $props();

  /** Fixed footprint, set on the node so flow-space geometry is known without
   *  a DOM measure. The real thing would read `measured` / `nodeFootprintPx`. */
  const NODE_W = 190;
  const NODE_H = 118;

  /** The seed rendered as flow nodes. ONE definition, so `reset()` cannot
   *  drift from the initial layout. `untrack` because the capture is
   *  deliberate: `nodes` is the LIVE, dragged state from here on, and a scene
   *  re-render must not yank a card out from under the pointer. */
  function initialNodes(): Node[] {
    return untrack(() => seed).map((s) => ({
      id: s.id,
      type: 'face',
      position: { x: s.x, y: s.y },
      width: NODE_W,
      height: NODE_H,
      data: { def: s.def, label: s.label, patchedIn: 0, patchedOut: 0 },
    }));
  }

  let nodes = $state<Node[]>(initialNodes());
  let edges = $state<Edge[]>([]);

  const defOf = (id: string) => seed.find((s) => s.id === id)!;

  // ── GEOMETRY ─────────────────────────────────────────────────────────────
  /** Rect for a node, from the LIVE node list. */
  function rectOf(n: { id: string; position: { x: number; y: number } }): DropRect {
    return { id: n.id, x: n.position.x, y: n.position.y, width: NODE_W, height: NODE_H };
  }

  /**
   * ⚠ Rects come from the DRAG PAYLOAD, never from an id lookup.
   * `getIntersectingNodes(node)` resolves through `store.nodeLookup`, i.e. the
   * committed position — while the shipped lane hit-test reads `n.position`
   * off the payload, and the two e2e drivers for that seam deliberately pass
   * synthetic positions that differ from the store. Anything resolving by id
   * would silently disagree with lane membership under exactly the tests that
   * exist to pin lane membership.
   */
  function decide(dragged: { id: string; position: { x: number; y: number } }): DropTargetDecision {
    return pickDropTarget(
      rectOf(dragged),
      nodes.filter((n) => n.id !== dragged.id).map((n) => rectOf(n as never)),
    );
  }

  // ── DRAG ─────────────────────────────────────────────────────────────────
  /** Pre-drag position, captured at dragstart — the value snap-back restores. */
  let dragOrigin = $state<{ id: string; x: number; y: number } | null>(null);
  /** Live decision, for the HUD. The threshold is visible while you drag so it
   *  is falsifiable rather than asserted. */
  let hover = $state<DropTargetDecision | null>(null);

  type DragPayload = { targetNode: Node | null; nodes: Node[] };
  const movedOf = (p: DragPayload): Node[] =>
    p.nodes.length > 0 ? p.nodes : p.targetNode ? [p.targetNode] : [];

  function onDragStart(p: DragPayload) {
    const n = movedOf(p)[0];
    if (!n) return;
    dragOrigin = { id: n.id, x: n.position.x, y: n.position.y };
  }

  function onDrag(p: DragPayload) {
    const n = movedOf(p)[0];
    hover = n ? decide(n) : null;
  }

  function onDragStop(p: DragPayload) {
    const moved = movedOf(p);
    hover = null;
    // Multi-select drags are not a drop-to-patch gesture: "which of these did
    // you mean" has no answer. Fall through as an ordinary move.
    if (moved.length !== 1) {
      dragOrigin = null;
      return;
    }
    const n = moved[0]!;
    const decision = decide(n);
    if (!decision.targetId) {
      // ⚠ NOT A DROP-TO-PATCH. Return before touching anything — the position
      // xyflow already wrote stands, untouched.
      dragOrigin = null;
      return;
    }

    // SNAP BACK, before the modal exists. Doing it here rather than on modal
    // close means no dismissal path — Esc, click-away, a crash — can leave the
    // card somewhere the user did not put it.
    const origin = dragOrigin;
    if (origin && origin.id === n.id) {
      nodes = nodes.map((x) => (x.id === n.id ? { ...x, position: { x: origin.x, y: origin.y } } : x));
    }
    dragOrigin = null;
    session = { droppedId: n.id, ontoId: decision.targetId, decision };
  }

  // ── THE MODAL SESSION ────────────────────────────────────────────────────
  let session = $state<{
    droppedId: string;
    ontoId: string;
    decision: DropTargetDecision;
  } | null>(null);

  /** Committed edge keys, so a re-opened modal shows what is already patched. */
  let committed = $derived(edges.map((e) => String(e.id)));

  /** One entry per COMMITTED SESSION. The undo unit. */
  let undoStack = $state<string[][]>([]);

  function commit(batch: DropEdge[]) {
    const fresh = batch.filter((e) => !edges.some((x) => x.id === dropEdgeKey(e)));
    if (fresh.length === 0) return;
    edges = [
      ...edges,
      ...fresh.map((e) => ({
        id: dropEdgeKey(e),
        source: e.fromNode,
        target: e.intoNode,
        label: `${e.fromPort} ▸ ${e.intoPort}`,
        animated: true,
        style: 'stroke:#c77dff;stroke-width:1.5',
      })),
    ];
    undoStack = [...undoStack, fresh.map(dropEdgeKey)];
    recountBadges();
    session = null;
  }

  function undo() {
    const last = undoStack.at(-1);
    if (!last) return;
    const drop = new Set(last);
    edges = edges.filter((e) => !drop.has(String(e.id)));
    undoStack = undoStack.slice(0, -1);
    recountBadges();
  }

  function recountBadges() {
    nodes = nodes.map((n) => ({
      ...n,
      data: {
        ...(n.data as object),
        patchedOut: edges.filter((e) => e.source === n.id).length,
        patchedIn: edges.filter((e) => e.target === n.id).length,
      },
    }));
  }

  function onWindowKey(e: KeyboardEvent) {
    // Cmd-Z / Ctrl-Z. ⚠ Shift-Cmd-Z (redo) is deliberately NOT implemented —
    // see the "what still isn't real" list rather than guessing at it here.
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
      e.preventDefault();
      undo();
    }
  }

  function reset() {
    edges = [];
    undoStack = [];
    session = null;
    nodes = initialNodes();
  }

  const nodeTypes = { face: SandboxFace as never };
</script>

<svelte:window on:keydown={onWindowKey} />

<div class="sbx" data-testid="drop-sandbox">
  <div class="sbx-bar">
    <span class="sbx-kick">live sandbox</span>
    <span class="sbx-tip">drag a card so its <b>centre</b> lands on another, and let go</span>
    <span class="sbx-spacer"></span>
    <span class="sbx-stat" data-testid="sbx-edges">{edges.length} patched</span>
    <span class="sbx-stat" data-testid="sbx-undo-depth">{undoStack.length} undo</span>
    <button type="button" class="sbx-btn" data-testid="sbx-undo" disabled={undoStack.length === 0} onclick={undo}>
      ⌘Z undo session
    </button>
    <button type="button" class="sbx-btn" data-testid="sbx-reset" onclick={reset}>reset</button>
  </div>

  <!-- ⚠ THE INSTRUMENT, IN VIEW. The live decision is printed while you drag,
       so the threshold can be disagreed with from the screen rather than from
       the source. `overlap > 0 but no target` is the case the library's own
       default would have claimed. -->
  <div class="sbx-hud" data-testid="sbx-hud" data-armed={hover?.targetId ? 'true' : 'false'}>
    {#if !hover || hover.ranked.length === 0}
      <span class="hud-dim">no overlap</span>
    {:else}
      {#each hover.ranked.slice(0, 3) as r (r.id)}
        <span class="hud-row" class:is-win={hover.targetId === r.id} data-testid="sbx-hud-row" data-id={r.id}>
          <b>{r.id}</b>
          coverage {(r.coverage * 100).toFixed(0)}% · {Math.round(r.overlapPx)} px²
          <span class="hud-gate" data-inside={r.centreInside}
            >{r.centreInside ? 'centre INSIDE' : 'centre outside'}</span
          >
        </span>
      {/each}
      {#if !hover.targetId}
        <span class="hud-dim">— no target: {hover.refusal}</span>
      {/if}
    {/if}
  </div>

  <div class="sbx-flow">
    <SvelteFlow
      bind:nodes
      bind:edges
      {nodeTypes}
      colorMode="dark"
      fitView
      nodesConnectable={false}
      zoomOnDoubleClick={false}
      onnodedragstart={onDragStart}
      onnodedrag={onDrag}
      onnodedragstop={onDragStop}
    >
      <Background bgColor="#0e1116" patternColor="#1f242c" gap={18} size={1} />
      <Controls showLock={false} />
    </SvelteFlow>
  </div>

  {#if session}
    <div class="sbx-modal" data-testid="sbx-modal">
      <DropPatchModal
        dropped={{
          nodeId: session.droppedId,
          def: defOf(session.droppedId).def,
          label: defOf(session.droppedId).label,
        }}
        onto={{
          nodeId: session.ontoId,
          def: defOf(session.ontoId).def,
          label: defOf(session.ontoId).label,
        }}
        direction="downstream"
        live
        {committed}
        {repairCandidates}
        onCommit={commit}
        onCancel={() => (session = null)}
      />
    </div>
  {/if}
</div>

<style>
  .sbx {
    position: relative;
    border: 1px solid #262a33;
    border-radius: 6px;
    background: #0e1116;
    overflow: hidden;
  }
  .sbx-bar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 10px;
    border-bottom: 1px solid #262a33;
    background: #171a21;
    font-size: 11px;
    color: #8b93a3;
  }
  .sbx-kick {
    font-size: 9px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: #6fd08c;
  }
  .sbx-tip b {
    color: #dfe3ea;
    font-weight: 500;
  }
  .sbx-spacer {
    flex: 1;
  }
  .sbx-stat {
    font-size: 10px;
    color: #656d7c;
  }
  .sbx-btn {
    padding: 2px 8px;
    border: 1px solid #2b3039;
    border-radius: 3px;
    background: #232833;
    color: #8b93a3;
    font: inherit;
    font-size: 10px;
    cursor: pointer;
  }
  .sbx-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .sbx-hud {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    min-height: 22px;
    padding: 4px 10px;
    border-bottom: 1px solid #262a33;
    background: #12151b;
    font: 10px/1.6 ui-monospace, Menlo, monospace;
    color: #79818f;
  }
  .sbx-hud[data-armed='true'] {
    background: #141d18;
  }
  .hud-row b {
    color: #b9c1d0;
  }
  .hud-row.is-win {
    color: #6fd08c;
  }
  .hud-row.is-win b {
    color: #6fd08c;
  }
  .hud-gate {
    color: #656d7c;
  }
  .hud-gate[data-inside='true'] {
    color: #6fd08c;
  }
  .hud-dim {
    color: #4e5563;
  }
  .sbx-flow {
    height: 460px;
  }
  .sbx-modal {
    position: absolute;
    inset: 44px 12px 12px;
    z-index: 20;
    overflow: auto;
    border-radius: 6px;
    box-shadow: 0 12px 40px rgb(0 0 0 / 65%);
  }
</style>
