<script lang="ts">
  // MATRIXMIX card — an EMS-Synthi / Buchla-style patch MATRIX.
  //
  // Two dropdowns (X axis + Y axis) each list every module in the patch by its
  // display name. Picking a module per axis builds a grid: one COLUMN per the
  // X-module's jacks (every input AND output), one ROW per the Y-module's
  // jacks. Each cell is classified LIVE against patch.edges (never cached):
  //   - direct cable already between the two jacks → filled circle (cable colour)
  //   - input already fed by a THIRD module        → red ✕ (re-patch replaces)
  //   - output already feeds a THIRD module         → gray ✕ (fan-out adds)
  //   - legal + empty                               → clickable
  //   - illegal (in→in / out→out / type-mismatch)   → red-✕ cursor, no-op
  //
  // Persisted state = ONLY node.data.xAxisModuleId + yAxisModuleId. Everything
  // else is derived from the live patch every render. Mirrors CONTROL SURFACE:
  // a meta-domain card that reads + edits the patch graph (no audio DSP).

  import type { NodeProps } from '@xyflow/svelte';
  import ModuleTitle from './ModuleTitle.svelte';
  import { patch, ydoc } from '$lib/graph/store';
  import { getModuleDef } from '$lib/audio/module-registry';
  import { getVideoModuleDef } from '$lib/video/module-registry';
  import { getMetaModuleDef } from '$lib/meta/module-registry';
  import type { ModuleNode } from '$lib/graph/types';
  import { resolveDisplayName } from '$lib/multiplayer/module-naming';
  import {
    jacksForDef,
    classifyCell,
    confirmMessageFor,
    type Jack,
    type CellClassification,
  } from '$lib/ui/matrixmix-grid';
  import {
    MATRIXMIX_TYPE,
    readMatrixData,
    setXAxisModule,
    setYAxisModule,
    createMatrixEdge,
    removeMatrixEdge,
  } from '$lib/graph/matrixmix';

  let { id, data }: NodeProps = $props();
  void data;

  // Re-derive on every Yjs update so the grid reflects patches made ANYWHERE
  // (drag-connect, patch-to, another collaborator, this card) in real time —
  // same cardVersion pump CONTROL SURFACE / GROUP use.
  let cardVersion = $state(0);
  $effect(() => {
    const h = () => { cardVersion = cardVersion + 1; };
    ydoc.on('update', h);
    return () => ydoc.off('update', h);
  });

  // Any-domain def lookup — the SAME chain validate-edge / persistence use.
  function defLookup(type: string) {
    return getModuleDef(type) ?? getVideoModuleDef(type) ?? getMetaModuleDef(type);
  }

  // Display name for a node (the user-facing label — node.data.name, else the
  // module-type default). This is the EXISTING naming system, not a new one.
  function nameOf(nodeId: string): string {
    const n = patch.nodes[nodeId] as ModuleNode | undefined;
    if (!n) return nodeId;
    return resolveDisplayName(n, patch.nodes as Record<string, ModuleNode | undefined>);
  }

  interface ModuleChoice {
    nodeId: string;
    name: string;
  }

  // Every patch module that HAS at least one jack (so a chosen axis yields a
  // meaningful grid), EXCLUDING this matrix node itself. Sorted by display name.
  let moduleChoices = $derived.by<ModuleChoice[]>(() => {
    void cardVersion;
    const out: ModuleChoice[] = [];
    for (const [nodeId, n] of Object.entries(patch.nodes)) {
      if (!n || nodeId === id) continue;
      const def = defLookup(n.type);
      if (!def) continue;
      if (def.inputs.length === 0 && def.outputs.length === 0) continue; // no jacks
      out.push({ nodeId, name: nameOf(nodeId) });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  });

  let matrixData = $derived.by(() => {
    void cardVersion;
    return readMatrixData(patch.nodes[id]);
  });

  // Resolve the selected axis ids, dropping any that no longer exist (a matrixed
  // module was deleted) so the grid empties cleanly rather than dangling.
  let xId = $derived.by(() => {
    void cardVersion;
    const sel = matrixData.xAxisModuleId;
    return sel && patch.nodes[sel] ? sel : undefined;
  });
  let yId = $derived.by(() => {
    void cardVersion;
    const sel = matrixData.yAxisModuleId;
    return sel && patch.nodes[sel] ? sel : undefined;
  });

  let colJacks = $derived.by<Jack[]>(() => {
    void cardVersion;
    if (!xId) return [];
    const n = patch.nodes[xId] as ModuleNode | undefined;
    return jacksForDef(n ? defLookup(n.type) : undefined);
  });
  let rowJacks = $derived.by<Jack[]>(() => {
    void cardVersion;
    if (!yId) return [];
    const n = patch.nodes[yId] as ModuleNode | undefined;
    return jacksForDef(n ? defLookup(n.type) : undefined);
  });

  let ready = $derived(!!xId && !!yId && colJacks.length > 0 && rowJacks.length > 0);

  interface RenderCell {
    rowJack: Jack;
    colJack: Jack;
    cls: CellClassification;
  }
  // Classify the whole grid live. A flat array (row-major) for the template;
  // it re-runs through cardVersion on every edge/patch change → real-time.
  let cells = $derived.by<RenderCell[][]>(() => {
    void cardVersion;
    if (!ready || !xId || !yId) return [];
    const liveEdges = Object.values(patch.edges);
    return rowJacks.map((rowJack) =>
      colJacks.map((colJack) => ({
        rowJack,
        colJack,
        cls: classifyCell(rowJack, colJack, liveEdges, xId!, yId!, nameOf),
      })),
    );
  });

  function onCellClick(cell: RenderCell) {
    const { cls } = cell;
    // direct (green/colored dot) → REMOVE that exact cable (unpatch). A single
    // LOCAL_ORIGIN delete → it lands on the undo stack (Cmd-Z restores it).
    if (cls.kind === 'direct') {
      if (cls.edgeId) removeMatrixEdge(cls.edgeId);
      return;
    }
    // legalEmpty (create), inputTaken (RED ✕ — re-patch REPLACES the foreign
    // source on the input) and outputFanout (GRAY ✕ — ADDS another cable to a
    // fanning-out output) all materialize the SAME output→input cable through
    // createMatrixEdge; the two ✕ kinds warn first. illegal → inert.
    if (cls.kind !== 'legalEmpty' && cls.kind !== 'inputTaken' && cls.kind !== 'outputFanout') return;
    if (!cls.patch) return;
    // Warn before a destructive (RED) / ambiguous (GRAY) ✕ (re)patch. The output
    // endpoint's display label ("name.port") feeds the outputFanout copy.
    const thisOutput = `${nameOf(cls.patch.source.nodeId)}.${cls.patch.source.portId}`;
    const warning = confirmMessageFor(cls, thisOutput);
    if (warning && !window.confirm(`${warning}\n\nMake this patch?`)) return;
    // Cable runs output → input. The output jack supplies sourceType; the input
    // jack supplies targetType. Exactly one of row/col is the output. The whole
    // (drop-foreign-on-input + write-new) runs in ONE LOCAL_ORIGIN transaction
    // inside createMatrixEdge, so a single Cmd-Z reverts the entire re-patch.
    const outJack = cell.rowJack.direction === 'output' ? cell.rowJack : cell.colJack;
    const inJack = cell.rowJack.direction === 'input' ? cell.rowJack : cell.colJack;
    createMatrixEdge(
      cls.patch.source,
      cls.patch.target,
      outJack.type, // output's emitted cable type → sourceType
      inJack.type,  // input's declared cable type  → targetType
      defLookup,
    );
  }

  // A cell is INTERACTIVE iff a click changes the edge graph: legalEmpty
  // (creates), direct (removes / unpatch), or a ✕ cell that resolves to a legal
  // re-patch (inputTaken / outputFanout — both carry the patch to make, gated by
  // a confirm). Only `illegal` (in→in / out→out / type-mismatch) stays inert.
  function isClickable(cls: CellClassification): boolean {
    if (cls.kind === 'direct') return !!cls.edgeId;
    if (cls.kind === 'legalEmpty' || cls.kind === 'inputTaken' || cls.kind === 'outputFanout') {
      return !!cls.patch;
    }
    return false; // illegal
  }

  // Tooltip text for a ✕ cell (the third-party endpoint it touches).
  function cellTitle(cls: CellClassification, rowJack: Jack, colJack: Jack): string {
    if (cls.kind === 'inputTaken' && cls.remote) {
      return `input already patched from ${cls.remote.name}.${cls.remote.port} — clicking replaces it`;
    }
    if (cls.kind === 'outputFanout' && cls.remote) {
      return `output already feeds ${cls.remote.name}.${cls.remote.port} — clicking adds another cable`;
    }
    if (cls.kind === 'direct') {
      return `${jackLabel(colJack)} ↔ ${jackLabel(rowJack)} — connected (click to unpatch)`;
    }
    if (cls.kind === 'illegal') {
      return `illegal: ${jackLabel(colJack)} ↔ ${jackLabel(rowJack)}`;
    }
    return `patch ${jackLabel(colJack)} ↔ ${jackLabel(rowJack)}`;
  }

  function jackLabel(j: Jack): string {
    return `${j.portId.toUpperCase()} ${j.direction === 'input' ? 'in' : 'out'}`;
  }

  function onSelectX(e: Event) {
    const v = (e.target as HTMLSelectElement).value;
    setXAxisModule(id, v || undefined);
  }
  function onSelectY(e: Event) {
    const v = (e.target as HTMLSelectElement).value;
    setYAxisModule(id, v || undefined);
  }

  void MATRIXMIX_TYPE; // keep the constant referenced for re-export hygiene
</script>

<div class="matrixmix-card" data-testid="matrixmix-card" data-node-id={id}>
  <ModuleTitle {id} {data} defaultLabel="MATRIXMIX" />

  <div class="mm-axes">
    <label class="mm-axis">
      <span class="mm-axis-label">X</span>
      <select
        class="mm-select nodrag"
        data-testid="matrixmix-x-select"
        value={xId ?? ''}
        onchange={onSelectX}
        onpointerdown={(e) => e.stopPropagation()}
      >
        <option value="">— pick a module —</option>
        {#each moduleChoices as m (m.nodeId)}
          <option value={m.nodeId}>{m.name}</option>
        {/each}
      </select>
    </label>
    <label class="mm-axis">
      <span class="mm-axis-label">Y</span>
      <select
        class="mm-select nodrag"
        data-testid="matrixmix-y-select"
        value={yId ?? ''}
        onchange={onSelectY}
        onpointerdown={(e) => e.stopPropagation()}
      >
        <option value="">— pick a module —</option>
        {#each moduleChoices as m (m.nodeId)}
          <option value={m.nodeId}>{m.name}</option>
        {/each}
      </select>
    </label>
  </div>

  {#if !ready}
    <div class="mm-empty" data-testid="matrixmix-empty">
      <span>Pick an X-axis + Y-axis module to build the patch matrix.</span>
    </div>
  {:else}
    <!-- Scroll box in BOTH directions. overflow:auto so a small matrix
         (e.g. ADSR × VCA) shows NO scrollbars (content fits the max box),
         while a big one scrolls; horizontal scrollbar rides the top via the
         flex-direction:column-reverse on the scroller. -->
    <div class="mm-grid-scroll nodrag" data-testid="matrixmix-grid-scroll" onpointerdown={(e) => e.stopPropagation()}>
      <table class="mm-grid" data-testid="matrixmix-grid">
        <thead>
          <tr>
            <th class="mm-corner" scope="col"><span class="mm-corner-y">Y↓</span><span class="mm-corner-x">X→</span></th>
            {#each colJacks as cj (cj.direction + ':' + cj.portId)}
              <th class="mm-col-head" class:mm-in={cj.direction === 'input'} class:mm-out={cj.direction === 'output'} scope="col" title={jackLabel(cj)}>
                <span class="mm-jack-id">{cj.portId}</span>
                <span class="mm-jack-dir">{cj.direction === 'input' ? 'in' : 'out'}</span>
              </th>
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each cells as row, ri (rowJacks[ri].direction + ':' + rowJacks[ri].portId)}
            <tr>
              <th class="mm-row-head" class:mm-in={rowJacks[ri].direction === 'input'} class:mm-out={rowJacks[ri].direction === 'output'} scope="row" title={jackLabel(rowJacks[ri])}>
                <span class="mm-jack-id">{rowJacks[ri].portId}</span>
                <span class="mm-jack-dir">{rowJacks[ri].direction === 'input' ? 'in' : 'out'}</span>
              </th>
              {#each row as cell (cell.colJack.direction + ':' + cell.colJack.portId)}
                <td
                  class="mm-cell mm-{cell.cls.kind}"
                  data-testid={`matrixmix-cell-${cell.rowJack.direction}-${cell.rowJack.portId}-${cell.colJack.direction}-${cell.colJack.portId}`}
                  data-kind={cell.cls.kind}
                  title={cellTitle(cell.cls, cell.rowJack, cell.colJack)}
                  role={isClickable(cell.cls) ? 'button' : undefined}
                  tabindex={isClickable(cell.cls) ? 0 : undefined}
                  aria-label={cellTitle(cell.cls, cell.rowJack, cell.colJack)}
                  onclick={() => onCellClick(cell)}
                  onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onCellClick(cell); } }}
                >
                  {#if cell.cls.kind === 'direct'}
                    <span
                      class="mm-dot"
                      data-testid="matrixmix-dot"
                      style:background={`var(--cable-${cell.cls.cableType}, var(--cable-audio))`}
                    ></span>
                  {:else if cell.cls.kind === 'inputTaken'}
                    <span class="mm-x mm-x-red" aria-hidden="true">✕</span>
                  {:else if cell.cls.kind === 'outputFanout'}
                    <span class="mm-x mm-x-gray" aria-hidden="true">✕</span>
                  {/if}
                </td>
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>

<style>
  .matrixmix-card {
    width: max-content;
    min-width: 240px;
    max-width: 640px;
    background: var(--module-bg, #1a1d24);
    border-radius: 6px;
    padding: 6px 8px 8px;
    box-sizing: border-box;
    color: var(--text, #e8eaed);
  }
  .mm-axes {
    display: flex;
    gap: 8px;
    margin: 6px 0;
  }
  .mm-axis {
    display: flex;
    align-items: center;
    gap: 4px;
    flex: 1 1 0;
    min-width: 0;
  }
  .mm-axis-label {
    font-size: 0.7rem;
    font-weight: 600;
    color: var(--text-dim, #97a3bd);
  }
  .mm-select {
    flex: 1 1 0;
    min-width: 0;
    font-size: 0.7rem;
    padding: 2px 4px;
    border-radius: 4px;
    border: 1px solid #404652;
    background: #0e1015;
    color: var(--text, #e8eaed);
  }
  .mm-empty {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 80px;
    border: 1px dashed #3a4150;
    border-radius: 5px;
    color: var(--text-dim, #8a93a6);
    font-size: 0.72rem;
    text-align: center;
    padding: 8px;
  }
  /* SCROLL BOX in both directions. column-reverse puts the horizontal
     scrollbar at the TOP of the box (per spec). overflow:auto means NO
     scrollbars appear when content fits (the trivial ADSR × VCA case). */
  .mm-grid-scroll {
    display: flex;
    flex-direction: column-reverse;
    max-width: 600px;
    max-height: 320px;
    overflow: auto;
    border: 1px solid #2a2f3a;
    border-radius: 5px;
    background: #0e1015;
  }
  .mm-grid {
    border-collapse: collapse;
    /* Allow the table to exceed the scroll box so overflow:auto engages. */
    table-layout: fixed;
  }
  .mm-grid th,
  .mm-grid td {
    border: 1px solid #232833;
    box-sizing: border-box;
  }
  .mm-corner {
    position: sticky;
    top: 0;
    left: 0;
    z-index: 3;
    background: #14171d;
    width: 56px;
    min-width: 56px;
    height: 34px;
    font-size: 0.55rem;
    color: var(--text-dim, #7a839a);
    padding: 2px;
  }
  .mm-corner-y { display: block; }
  .mm-corner-x { display: block; }
  .mm-col-head {
    position: sticky;
    top: 0;
    z-index: 2;
    background: #14171d;
    width: 30px;
    min-width: 30px;
    max-width: 30px;
    height: 34px;
    padding: 1px;
    text-align: center;
    overflow: hidden;
  }
  .mm-row-head {
    position: sticky;
    left: 0;
    z-index: 1;
    background: #14171d;
    width: 56px;
    min-width: 56px;
    max-width: 56px;
    height: 26px;
    padding: 1px 3px;
    text-align: left;
    overflow: hidden;
    white-space: nowrap;
  }
  .mm-jack-id {
    display: block;
    font-size: 0.55rem;
    line-height: 1.05;
    text-transform: uppercase;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--text, #cdd3df);
  }
  .mm-jack-dir {
    display: block;
    font-size: 0.48rem;
    line-height: 1;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  /* Direction tint on the headers: inputs cool, outputs warm. */
  .mm-col-head.mm-in .mm-jack-dir,
  .mm-row-head.mm-in .mm-jack-dir { color: #60a5fa; }
  .mm-col-head.mm-out .mm-jack-dir,
  .mm-row-head.mm-out .mm-jack-dir { color: #fbbf24; }
  .mm-cell {
    width: 30px;
    min-width: 30px;
    max-width: 30px;
    height: 26px;
    text-align: center;
    vertical-align: middle;
    padding: 0;
    background: #0b0d12;
  }
  .mm-cell.mm-legalEmpty { cursor: pointer; }
  .mm-cell.mm-legalEmpty:hover { background: rgba(96, 165, 250, 0.18); }
  /* A direct (connected) cell is clickable to UNPATCH — pointer cursor + a
     subtle red hover wash so it reads as "click to remove this cable". */
  .mm-cell.mm-direct { cursor: pointer; }
  .mm-cell.mm-direct:hover { background: rgba(248, 113, 113, 0.18); }
  .mm-cell.mm-direct:hover .mm-dot { opacity: 0.55; }
  /* Illegal cells show a red-✕ cursor so the user knows a click does nothing.
     A tiny inline data-URI cursor of a red ✕, falling back to not-allowed. */
  .mm-cell.mm-illegal {
    cursor: not-allowed;
    cursor: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='16' height='16'><text x='1' y='13' font-size='14' fill='%23f87171'>✕</text></svg>") 8 8, not-allowed;
    background: #090a0e;
  }
  /* ✕ cells are now clickable (with a confirm). RED ✕ (inputTaken) re-patch is
     destructive (replaces the input's source) → red hover wash; GRAY ✕
     (outputFanout) only adds a cable → neutral blue hover wash. */
  .mm-cell.mm-inputTaken { cursor: pointer; }
  .mm-cell.mm-inputTaken:hover { background: rgba(248, 113, 113, 0.18); }
  .mm-cell.mm-outputFanout { cursor: pointer; }
  .mm-cell.mm-outputFanout:hover { background: rgba(96, 165, 250, 0.14); }
  .mm-dot {
    display: inline-block;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    box-shadow: 0 0 3px rgba(0, 0, 0, 0.6);
  }
  .mm-x {
    font-size: 0.85rem;
    line-height: 1;
    font-weight: 700;
    user-select: none;
  }
  .mm-x-red { color: #f87171; }
  .mm-x-gray { color: #6b7280; }
</style>
