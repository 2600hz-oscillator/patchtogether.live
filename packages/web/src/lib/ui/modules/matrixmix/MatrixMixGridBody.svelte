<script lang="ts">
  // MATRIXMIX GRID BODY — the cross-point field, at the head of the dock full
  // view (`ShellExtension.fullViewBody`).
  //
  // This is `MatrixMixCard.svelte`'s `{#if !ready} … {:else} …table… {/if}`
  // block, lifted with its classification, its click handling and EVERY
  // `data-testid` intact. The two axis `<label>`s do NOT come with it — they are
  // ranked faceplate cells now (`matrixmix-x-{n}` / `matrixmix-y-{n}` in
  // shell-cells.ts), which is what puts the axis selection in the LANE TILE
  // instead of behind a dock open.
  //
  // ⚠ EVERY `data-testid` IS KEPT DELIBERATELY — `matrixmix-grid`,
  // `matrixmix-grid-scroll`, `matrixmix-dot`, `matrixmix-cell-{rowdir}-{rowport}-
  // {coldir}-{colport}`, `matrixmix-empty`. `e2e/tests/matrixmix.spec.ts` drives
  // all of them and there is no reason for a rename; the spec proves the CARD
  // (it boots `?shell=legacy`) and a face leg proves this body, and both read
  // the same ids.
  //
  // ⚠ THE `aria-label` ON EVERY CELL IS THE MODULE'S SEMANTICS AND MUST SURVIVE
  // VERBATIM. The visual is a coloured dot or a ✕; the SENTENCE is what the cell
  // means — "input already patched from FILTER.cutoff — clicking replaces it",
  // "output already feeds VCA.in — clicking adds another cable", "CUTOFF in ↔ OUT
  // out — connected (click to unpatch)". Under the resting-text ruling that
  // sentence must NOT become painted face text, and it does not need to:
  // `aria-label` / `aria-valuetext` is exactly where the ruling puts this class,
  // speakable and assertable but unpainted. Any spec proving this body works
  // reads the aria, not the pixels.
  //
  // ⚠ THE WIDTH CAP LIVES HERE, ON THE SCROLL BOX, AND THAT IS NOT A HATCH.
  // `face-width-source.test.ts` denies a `max-width` on `.faceplate-body` and
  // denies per-occupant `:has(...)` overrides outright — correctly, because a
  // clamp CLIPS a wide face where a scroll REVEALS it. This is a component's own
  // internal layout, which is what the legacy card already does and what the gate
  // does not and should not police: the plate sizes to its content, and the grid
  // scrolls inside a fixed box exactly as it always has.
  //
  // ⚠ AND IT STAYS A `<table>`. WebGL-attest basis membership is derived from
  // CONTENT and path, not from a list somebody maintains, so a body written
  // against a WebGL context would enter the basis AUTOMATICALLY and put a face
  // change on the GPU-attest critical path. Nothing here draws.

  import { patch } from '$lib/graph/store';
  import { docVersion } from '$lib/graph/node-versions.svelte';
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
  import { createMatrixEdge, removeMatrixEdge } from '$lib/graph/matrixmix';
  import {
    matrixmixXAxisValue,
    matrixmixYAxisValue,
    MATRIXMIX_NO_AXIS,
  } from '$lib/ui/modules/matrixmix-cell-actions';

  let { nodeId }: { nodeId: string } = $props();

  // Whole-doc version — the SAME pump the card uses, and legitimately so HERE:
  // this body scans ALL edges, so a cable moving anywhere really does change
  // what it paints. (The ROSTER's whole-doc invalidation was the problem, and it
  // is fixed at the source — matrixmix-cell-actions memoises on a node-set
  // signature. This body is dock-only, so its scan never runs in the lane.)
  let bodyVersion = $derived(docVersion());

  function defLookup(type: string) {
    return getModuleDef(type) ?? getVideoModuleDef(type) ?? getMetaModuleDef(type);
  }

  function nameOf(id: string): string {
    const n = patch.nodes[id] as ModuleNode | undefined;
    if (!n) return id;
    return resolveDisplayName(n, patch.nodes as Record<string, ModuleNode | undefined>);
  }

  // The selected axis ids, with a dangling selection dropped — the SAME readers
  // the two axis cells use, so the grid can never disagree with the pickers
  // about which modules are on screen.
  let xId = $derived.by(() => {
    void bodyVersion;
    const v = matrixmixXAxisValue(patch.nodes[nodeId] as ModuleNode | undefined);
    return v === MATRIXMIX_NO_AXIS ? undefined : v;
  });
  let yId = $derived.by(() => {
    void bodyVersion;
    const v = matrixmixYAxisValue(patch.nodes[nodeId] as ModuleNode | undefined);
    return v === MATRIXMIX_NO_AXIS ? undefined : v;
  });

  let colJacks = $derived.by<Jack[]>(() => {
    void bodyVersion;
    if (!xId) return [];
    const n = patch.nodes[xId] as ModuleNode | undefined;
    return jacksForDef(n ? defLookup(n.type) : undefined);
  });
  let rowJacks = $derived.by<Jack[]>(() => {
    void bodyVersion;
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

  let cells = $derived.by<RenderCell[][]>(() => {
    void bodyVersion;
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
    // direct → REMOVE that exact cable (unpatch), taking the whole LEG GROUP so
    // a stereo cable does not leave half of itself lit. One LOCAL_ORIGIN delete
    // → Cmd-Z restores it.
    if (cls.kind === 'direct') {
      if (cls.edgeId) removeMatrixEdge(cls.edgeId, defLookup);
      return;
    }
    if (cls.kind !== 'legalEmpty' && cls.kind !== 'inputTaken' && cls.kind !== 'outputFanout') return;
    if (!cls.patch) return;
    // ⚠ THE NATIVE CONFIRM STAYS, AND THAT IS A DELIBERATE NON-CHANGE. It guards
    // a genuinely destructive action (a red-✕ click REPLACES an existing source)
    // and its copy comes from a tested pure helper. Swapping it for an in-app
    // dialog is a UI change with its own e2e surface, and belongs in a PR whose
    // subject is the interaction rather than the surface.
    const thisOutput = `${nameOf(cls.patch.source.nodeId)}.${cls.patch.source.portId}`;
    const warning = confirmMessageFor(cls, thisOutput);
    if (warning && !window.confirm(`${warning}\n\nMake this patch?`)) return;
    const outJack = cell.rowJack.direction === 'output' ? cell.rowJack : cell.colJack;
    const inJack = cell.rowJack.direction === 'input' ? cell.rowJack : cell.colJack;
    createMatrixEdge(cls.patch.source, cls.patch.target, outJack.type, inJack.type, defLookup);
  }

  function isClickable(cls: CellClassification): boolean {
    if (cls.kind === 'direct') return !!cls.edgeId;
    if (cls.kind === 'legalEmpty' || cls.kind === 'inputTaken' || cls.kind === 'outputFanout') {
      return !!cls.patch;
    }
    return false; // illegal
  }

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
</script>

{#if !ready}
  <div class="mm-empty" data-testid="matrixmix-empty">
    <span>Pick an X-axis + Y-axis module to build the patch matrix.</span>
  </div>
{:else}
  <!-- Scroll box in BOTH directions. overflow:auto so a small matrix (e.g.
       ADSR x VCA) shows NO scrollbars while a big one scrolls; the horizontal
       scrollbar rides the top via flex-direction:column-reverse. -->
  <!-- svelte-ignore a11y_no_static_element_interactions -- pointer PLUMBING only: the
       handler stops the XYFlow canvas drag so this box scrolls instead of moving the node.
       No user action happens on the div, so there is no keyboard equivalent to provide. -->
  <div
    class="mm-grid-scroll nodrag"
    data-testid="matrixmix-grid-scroll"
    onpointerdown={(e) => e.stopPropagation()}
  >
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

<style>
  .mm-empty {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 72px;
    border: 1px dashed #3a4150;
    border-radius: 5px;
    color: var(--text-dim, #8a93a6);
    font-size: 0.72rem;
    text-align: center;
    padding: 8px;
  }
  /* SCROLL BOX in both directions. column-reverse puts the horizontal scrollbar
     at the TOP of the box. overflow:auto means NO scrollbars appear when the
     content fits (the trivial ADSR x VCA case). The cap is the COMPONENT's own
     layout, not a plate override — see the header note. */
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
  .mm-cell.mm-direct { cursor: pointer; }
  .mm-cell.mm-direct:hover { background: rgba(248, 113, 113, 0.18); }
  .mm-cell.mm-direct:hover .mm-dot { opacity: 0.55; }
  .mm-cell.mm-illegal {
    cursor: not-allowed;
    cursor: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='16' height='16'><text x='1' y='13' font-size='14' fill='%23f87171'>✕</text></svg>") 8 8, not-allowed;
    background: #090a0e;
  }
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
