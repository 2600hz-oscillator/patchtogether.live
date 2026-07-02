<script lang="ts">
  // PATCH tab — the mobile FROM→TO pair matrix (spec §3 PATCH).
  //
  // DECISION: two-module FROM→TO pair grid (the desktop matrix's mental
  // model 1:1, pure core reused) + an ALL-CABLES list for the whole-scene
  // overview. Columns = FROM outputs (sticky top), rows = TO inputs (sticky
  // left), 48×48 cells. Cell semantics from classifyCell's five kinds:
  //   legalEmpty   → patch immediately (+vibrate; the sound IS the confirm)
  //   direct       → unpatch immediately + undo pill (undo is free)
  //   inputTaken   → bottom sheet (confirmMessageFor) → Replace / Cancel
  //   outputFanout → patch immediately + informational toast (no confirm)
  //   illegal      → blank, inert
  import {
    classifyCell,
    confirmMessageFor,
    matrixEdgeId,
    type CellClassification,
    type Jack,
  } from '$lib/ui/matrixmix-grid';
  import { createMatrixEdge, removeMatrixEdge } from '$lib/graph/matrixmix';
  import { resolveAnyDef, lookupDefWithDomain } from '$lib/mobile/mobile-host';
  import {
    buildInputRows,
    mixmstrsSectionRows,
    outputJacks,
    planPairPatch,
    splitRowsByCompatibility,
    MIX_SECTIONS,
    type DefLike,
    type InputRow,
    type MixSection,
  } from '$lib/mobile/matrix-mobile';
  import { resolveDisplayName } from '$lib/multiplayer/module-naming';
  import type { Edge, ModuleNode } from '$lib/graph/types';

  interface Props {
    nodes: ModuleNode[];
    edges: Edge[];
    toast: (msg: string) => void;
    undoPill: (msg: string) => void;
    onOpenModule: (id: string) => void;
  }
  let { nodes, edges, toast, undoPill, onOpenModule }: Props = $props();

  let nodesById = $derived(new Map(nodes.map((n) => [n.id, n])));
  function nameOf(nodeId: string): string {
    const n = nodesById.get(nodeId);
    if (!n) return nodeId;
    const record: Record<string, ModuleNode> = {};
    for (const m of nodes) record[m.id] = m;
    return resolveDisplayName(n, record).toLowerCase();
  }

  function defOf(n: ModuleNode | undefined): DefLike | undefined {
    return n ? (resolveAnyDef(n.type) as DefLike | undefined) : undefined;
  }

  // ── Pair rails ──
  let fromId = $state<string | null>(null);
  let toId = $state<string | null>(null);

  // Sensible defaults once the scene exists: FROM = first module WITH
  // outputs (prefer a sound source), TO = the mixer, else the audio out.
  $effect(() => {
    if (fromId && nodesById.has(fromId) && toId && nodesById.has(toId)) return;
    const withOutputs = nodes.filter((n) => (defOf(n)?.outputs?.length ?? 0) > 0);
    const withInputs = nodes.filter((n) => (defOf(n)?.inputs?.length ?? 0) > 0);
    if (!fromId || !nodesById.has(fromId)) {
      fromId =
        withOutputs.find((n) => n.type === 'analogVco')?.id ??
        withOutputs.find((n) => n.type !== 'timelorde')?.id ??
        withOutputs[0]?.id ??
        null;
    }
    if (!toId || !nodesById.has(toId)) {
      toId =
        withInputs.find((n) => n.type === 'mixmstrs')?.id ??
        withInputs.find((n) => n.type === 'audioOut')?.id ??
        withInputs[0]?.id ??
        null;
    }
  });

  let fromNode = $derived(fromId ? nodesById.get(fromId) : undefined);
  let toNode = $derived(toId ? nodesById.get(toId) : undefined);
  let fromDef = $derived(defOf(fromNode));
  let toDef = $derived(defOf(toNode));
  let fromOutputs = $derived(outputJacks(fromDef));

  // ── Row building (with mixmstrs sectioning + cv expander) ──
  let mixSection = $state<MixSection>('ch1');
  let cvExpanded = $state(false);
  let showIncompatible = $state(false);
  let expandedPairs = $state<Set<string>>(new Set());

  let rowInfo = $derived.by(() => {
    if (!toDef) return { rows: [] as InputRow[], hidden: 0, cvCollapsed: 0 };
    let rows = buildInputRows(toDef);
    let cvCollapsed = 0;
    if (toNode?.type === 'mixmstrs') {
      const { audio, cv } = mixmstrsSectionRows(rows, mixSection);
      rows = cvExpanded ? [...audio, ...cv] : audio;
      cvCollapsed = cvExpanded ? 0 : cv.length;
    }
    // Expand pairs the user opened into per-side single rows.
    const out: InputRow[] = [];
    for (const row of rows) {
      if (row.kind === 'pair' && expandedPairs.has(row.label)) {
        out.push({ kind: 'single', jack: row.left }, { kind: 'single', jack: row.right });
      } else {
        out.push(row);
      }
    }
    if (showIncompatible) return { rows: out, hidden: 0, cvCollapsed };
    const { compatible, hidden } = splitRowsByCompatibility(out, fromOutputs);
    return { rows: compatible, hidden, cvCollapsed };
  });

  // ── Cell classification ──
  function classifySingle(rowJack: Jack, colJack: Jack): CellClassification {
    return classifyCell(rowJack, colJack, edges, fromId ?? '', toId ?? '', nameOf);
  }

  type PairCellKind = 'direct' | 'partial' | 'legalEmpty' | 'inputTaken' | 'outputFanout' | 'illegal';
  interface PairCell {
    kind: PairCellKind;
    legs: { sourcePortId: string; targetPortId: string }[];
    existing: Edge[];
    taken?: CellClassification; // the side that reported inputTaken (for copy)
  }
  function classifyPair(row: Extract<InputRow, { kind: 'pair' }>, colJack: Jack): PairCell {
    const left = classifySingle(row.left, colJack);
    const right = classifySingle(row.right, colJack);
    if (left.kind === 'illegal' && right.kind === 'illegal') {
      return { kind: 'illegal', legs: [], existing: [] };
    }
    const legs = planPairPatch(fromOutputs, colJack.portId, row);
    // Existing edges spanning the planned legs (in either L/R shape).
    const existing: Edge[] = [];
    for (const leg of legs) {
      const id = matrixEdgeId(
        { nodeId: fromId ?? '', portId: leg.sourcePortId },
        { nodeId: toId ?? '', portId: leg.targetPortId },
      );
      const e = edges.find((x) => x.id === id);
      if (e) existing.push(e);
    }
    if (existing.length === legs.length) return { kind: 'direct', legs, existing };
    if (existing.length > 0) return { kind: 'partial', legs, existing };
    if (left.kind === 'inputTaken' || right.kind === 'inputTaken') {
      return { kind: 'inputTaken', legs, existing, taken: left.kind === 'inputTaken' ? left : right };
    }
    if (left.kind === 'outputFanout' || right.kind === 'outputFanout') {
      return { kind: 'outputFanout', legs, existing };
    }
    return { kind: 'legalEmpty', legs, existing };
  }

  function vibrate() {
    try {
      navigator.vibrate?.(10);
    } catch {
      /* unsupported */
    }
  }

  function jackType(def: DefLike | undefined, portId: string, dir: 'input' | 'output') {
    const list = dir === 'input' ? def?.inputs : def?.outputs;
    return list?.find((p) => p.id === portId)?.type ?? 'audio';
  }

  function patchLeg(sourcePortId: string, targetPortId: string): void {
    if (!fromId || !toId) return;
    createMatrixEdge(
      { nodeId: fromId, portId: sourcePortId },
      { nodeId: toId, portId: targetPortId },
      jackType(fromDef, sourcePortId, 'output'),
      jackType(toDef, targetPortId, 'input'),
      resolveAnyDef,
    );
  }

  // ── Sheets ──
  let replaceSheet = $state<{ message: string; apply: () => void } | null>(null);
  let inspectSheet = $state<{
    title: string;
    cableType: string;
    unpatch: () => void;
  } | null>(null);

  function onSingleCellTap(rowJack: Jack, colJack: Jack) {
    const cls = classifySingle(rowJack, colJack);
    if (cls.kind === 'illegal') return;
    if (cls.kind === 'direct' && cls.edgeId) {
      removeMatrixEdge(cls.edgeId);
      undoPill('unpatched');
      return;
    }
    if (cls.kind === 'legalEmpty' && cls.patch) {
      patchLeg(cls.patch.source.portId, cls.patch.target.portId);
      vibrate();
      return;
    }
    if (cls.kind === 'inputTaken' && cls.patch) {
      const p = cls.patch;
      replaceSheet = {
        message: confirmMessageFor(cls) ?? 'Replace the cable feeding this input?',
        apply: () => {
          patchLeg(p.source.portId, p.target.portId);
          vibrate();
        },
      };
      return;
    }
    if (cls.kind === 'outputFanout' && cls.patch) {
      patchLeg(cls.patch.source.portId, cls.patch.target.portId);
      vibrate();
      toast('added another cable — nothing was unpatched');
    }
  }

  function onPairCellTap(row: Extract<InputRow, { kind: 'pair' }>, colJack: Jack) {
    const cell = classifyPair(row, colJack);
    if (cell.kind === 'illegal') return;
    if (cell.kind === 'direct') {
      for (const e of cell.existing) removeMatrixEdge(e.id);
      undoPill('unpatched both sides');
      return;
    }
    if (cell.kind === 'inputTaken' && cell.taken) {
      replaceSheet = {
        message: confirmMessageFor(cell.taken) ?? 'Replace the cable feeding this input?',
        apply: () => {
          for (const leg of cell.legs) patchLeg(leg.sourcePortId, leg.targetPortId);
          vibrate();
        },
      };
      return;
    }
    for (const leg of cell.legs) patchLeg(leg.sourcePortId, leg.targetPortId);
    vibrate();
    if (cell.kind === 'outputFanout') toast('added another cable — nothing was unpatched');
  }

  // Long-press a DIRECT cell = inspect sheet (endpoints, type, UNPATCH).
  let pressTimer: ReturnType<typeof setTimeout> | null = null;
  let pressFired = false;
  function cellPressStart(fn: () => void) {
    pressFired = false;
    pressTimer = setTimeout(() => {
      pressFired = true;
      fn();
    }, 550);
  }
  function cellPressEnd(tap: () => void) {
    if (pressTimer) clearTimeout(pressTimer);
    pressTimer = null;
    if (!pressFired) tap();
  }
  function inspectDirect(cls: CellClassification, rowJack: Jack, colJack: Jack) {
    if (cls.kind !== 'direct' || !cls.edgeId) return;
    const eid = cls.edgeId;
    inspectSheet = {
      title: `${nameOf(fromId ?? '')} · ${colJack.portId} → ${nameOf(toId ?? '')} · ${rowJack.portId}`,
      cableType: cls.cableType ?? 'audio',
      unpatch: () => {
        removeMatrixEdge(eid);
        undoPill('unpatched');
      },
    };
  }

  // ── Module picker + rail steppers ──
  let picker = $state<'from' | 'to' | null>(null);
  let pickables = $derived.by(() => {
    const want = picker;
    if (!want) return [] as ModuleNode[];
    return nodes.filter((n) => {
      const def = defOf(n);
      if (n.type === 'matrixMix') return false;
      return want === 'from' ? (def?.outputs?.length ?? 0) > 0 : (def?.inputs?.length ?? 0) > 0;
    });
  });
  function pick(n: ModuleNode) {
    if (picker === 'from') fromId = n.id;
    else if (picker === 'to') toId = n.id;
    picker = null;
  }
  function stepRail(which: 'from' | 'to', delta: number) {
    const list = nodes.filter((n) => {
      const def = defOf(n);
      if (n.type === 'matrixMix') return false;
      return which === 'from' ? (def?.outputs?.length ?? 0) > 0 : (def?.inputs?.length ?? 0) > 0;
    });
    if (list.length === 0) return;
    const cur = which === 'from' ? fromId : toId;
    const i = Math.max(0, list.findIndex((n) => n.id === cur));
    const next = list[(i + delta + list.length) % list.length]!;
    if (which === 'from') fromId = next.id;
    else toId = next.id;
  }
  function swap() {
    const f = fromId;
    fromId = toId;
    toId = f;
  }

  // ── ALL CABLES ──
  let allCables = $state(false);
  function focusEdge(e: Edge) {
    fromId = e.source.nodeId;
    toId = e.target.nodeId;
    allCables = false;
  }

  function cableColorVar(t: string): string {
    return `var(--cable-${t}, var(--accent, #4f8cff))`;
  }

  function togglePairExpand(label: string) {
    const next = new Set(expandedPairs);
    if (next.has(label)) next.delete(label);
    else next.add(label);
    expandedPairs = next;
  }
</script>

<div class="matrix-tab" data-testid="m-patch-tab">
  <header class="mt-head">
    <span class="mt-title">PATCH</span>
    <div class="mt-toggles">
      <button
        class="tog"
        class:on={showIncompatible}
        onclick={() => (showIncompatible = !showIncompatible)}
      >
        show incompatible
      </button>
      <button
        class="tog"
        class:on={allCables}
        onclick={() => (allCables = !allCables)}
        data-testid="m-all-cables-toggle"
      >
        ALL CABLES
      </button>
    </div>
  </header>

  {#if allCables}
    <div class="cable-list" data-testid="m-cable-list">
      {#each edges as e (e.id)}
        <div class="cable-row" style="--edge-color:{cableColorVar(e.sourceType)}">
          <button class="cable-label" onclick={() => focusEdge(e)}>
            <span class="dot"></span>
            {nameOf(e.source.nodeId)} · {e.source.portId} → {nameOf(e.target.nodeId)} · {e.target.portId}
          </button>
          <button
            class="cable-x"
            onclick={() => {
              removeMatrixEdge(e.id);
              undoPill('unpatched');
            }}
            aria-label="unpatch"
          >
            ✕
          </button>
        </div>
      {:else}
        <p class="hint">no cables yet — pick FROM and TO below and tap a cell.</p>
      {/each}
    </div>
  {:else if fromNode && toNode}
    {#if toNode.type === 'mixmstrs'}
      <div class="sections">
        {#each MIX_SECTIONS as s (s.id)}
          <button
            class="sec"
            class:on={mixSection === s.id}
            onclick={() => (mixSection = s.id)}
            data-testid={`m-mix-section-${s.id}`}
          >
            {s.label}
          </button>
        {/each}
      </div>
    {/if}

    <div class="grid-scroll" data-testid="m-matrix-grid">
      <table class="grid">
        <thead>
          <tr>
            <th class="corner"></th>
            {#each fromOutputs as col (col.portId)}
              <th class="col-head" title={col.type}>{col.portId}</th>
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each rowInfo.rows as row (row.kind === 'single' ? row.jack.portId : row.label)}
            <tr>
              {#if row.kind === 'single'}
                <th class="row-head">{row.jack.portId}</th>
                {#each fromOutputs as col (col.portId)}
                  {@const cls = classifySingle(row.jack, col)}
                  <td>
                    {#if cls.kind !== 'illegal'}
                      <button
                        class="cell {cls.kind}"
                        style={cls.kind === 'direct'
                          ? `--edge-color:${cableColorVar(cls.cableType ?? 'audio')}`
                          : ''}
                        onpointerdown={() => cellPressStart(() => inspectDirect(cls, row.jack, col))}
                        onpointerup={() => cellPressEnd(() => onSingleCellTap(row.jack, col))}
                        onpointercancel={() => cellPressEnd(() => undefined)}
                        data-testid={`m-cell-${col.portId}-${row.jack.portId}`}
                        data-kind={cls.kind}
                        aria-label={`${col.portId} to ${row.jack.portId}: ${cls.kind}`}
                      >
                        {#if cls.kind === 'direct'}
                          <span class="dot solid"></span>
                        {:else if cls.kind === 'inputTaken'}
                          <span class="dot dim"></span><span class="badge">↷</span>
                        {:else if cls.kind === 'outputFanout'}
                          <span class="dot ring"></span><span class="badge">⑃</span>
                        {:else}
                          <span class="dot ring"></span>
                        {/if}
                      </button>
                    {/if}
                  </td>
                {/each}
              {:else}
                <th class="row-head pair">
                  <button class="pair-expand" onclick={() => togglePairExpand(row.label)}>
                    {row.label} ▸
                  </button>
                </th>
                {#each fromOutputs as col (col.portId)}
                  {@const cell = classifyPair(row, col)}
                  <td>
                    {#if cell.kind !== 'illegal'}
                      <button
                        class="cell {cell.kind === 'partial' ? 'direct' : cell.kind}"
                        onclick={() => onPairCellTap(row, col)}
                        data-testid={`m-cell-${col.portId}-${row.label.replace(/\s+/g, '')}`}
                        data-kind={cell.kind}
                        aria-label={`${col.portId} to ${row.label}: ${cell.kind}`}
                      >
                        {#if cell.kind === 'direct'}
                          <span class="dot solid"></span>
                        {:else if cell.kind === 'partial'}
                          <span class="dot half"></span>
                        {:else if cell.kind === 'inputTaken'}
                          <span class="dot dim"></span><span class="badge">↷</span>
                        {:else if cell.kind === 'outputFanout'}
                          <span class="dot ring"></span><span class="badge">⑃</span>
                        {:else}
                          <span class="dot ring"></span>
                        {/if}
                      </button>
                    {/if}
                  </td>
                {/each}
              {/if}
            </tr>
          {/each}
        </tbody>
      </table>
      {#if rowInfo.cvCollapsed > 0}
        <button class="cv-expander" onclick={() => (cvExpanded = true)} data-testid="m-cv-expander">
          + cv ({rowInfo.cvCollapsed} inputs)
        </button>
      {:else if cvExpanded && toNode.type === 'mixmstrs'}
        <button class="cv-expander" onclick={() => (cvExpanded = false)}>− hide cv</button>
      {/if}
      {#if rowInfo.hidden > 0}
        <p class="hint">{rowInfo.hidden} incompatible input{rowInfo.hidden === 1 ? '' : 's'} hidden</p>
      {/if}
    </div>
  {:else}
    <p class="hint">add some modules first.</p>
  {/if}

  <!-- Pair selector — THUMB zone, directly above the tab bar. -->
  <div class="rails" data-testid="m-rails">
    <div class="rail">
      <button class="rail-step" onclick={() => stepRail('from', -1)} aria-label="previous source">◀</button>
      <button class="rail-chip" onclick={() => (picker = 'from')} data-testid="m-rail-from">
        <span class="rail-tag">FROM</span>
        {fromNode ? nameOf(fromNode.id) : '—'} ▾
      </button>
      <button class="rail-step" onclick={() => stepRail('from', 1)} aria-label="next source">▶</button>
    </div>
    <button class="swap" onclick={swap} aria-label="swap from and to" data-testid="m-rail-swap">⇄</button>
    <div class="rail">
      <button class="rail-step" onclick={() => stepRail('to', -1)} aria-label="previous target">◀</button>
      <button class="rail-chip" onclick={() => (picker = 'to')} data-testid="m-rail-to">
        <span class="rail-tag">TO</span>
        {toNode ? nameOf(toNode.id) : '—'} ▾
      </button>
      <button class="rail-step" onclick={() => stepRail('to', 1)} aria-label="next target">▶</button>
    </div>
  </div>

  {#if picker}
    <div class="picker" data-testid="m-module-picker">
      <header class="mt-head">
        <span class="mt-title">{picker === 'from' ? 'FROM (outputs)' : 'TO (inputs)'}</span>
        <button class="tog" onclick={() => (picker = null)}>close</button>
      </header>
      <div class="picker-list">
        {#each pickables as n (n.id)}
          {@const def = defOf(n)}
          <div class="picker-row">
            <button class="picker-main" onclick={() => pick(n)} data-testid={`m-pick-${n.type}`}>
              <span class="picker-name">{nameOf(n.id)}</span>
              <span class="picker-meta">
                {def?.outputs?.length ?? 0} out · {def?.inputs?.length ?? 0} in
              </span>
            </button>
            <button class="picker-open" onclick={() => onOpenModule(n.id)}>open</button>
          </div>
        {/each}
      </div>
    </div>
  {/if}

  {#if replaceSheet}
    <div class="bottom-sheet" data-testid="m-replace-sheet">
      <div class="sheet-card">
        <p>{replaceSheet.message}</p>
        <button
          class="sheet-btn primary"
          onclick={() => {
            replaceSheet?.apply();
            replaceSheet = null;
          }}
          data-testid="m-replace-confirm"
        >
          Replace
        </button>
        <button class="sheet-btn" onclick={() => (replaceSheet = null)}>Cancel</button>
      </div>
    </div>
  {/if}

  {#if inspectSheet}
    <div class="bottom-sheet" data-testid="m-inspect-sheet">
      <div class="sheet-card">
        <p>{inspectSheet.title}</p>
        <p class="hint">cable: {inspectSheet.cableType}</p>
        <button
          class="sheet-btn danger"
          onclick={() => {
            inspectSheet?.unpatch();
            inspectSheet = null;
          }}
        >
          Unpatch
        </button>
        <button class="sheet-btn" onclick={() => (inspectSheet = null)}>Close</button>
      </div>
    </div>
  {/if}
</div>

<style>
  .matrix-tab {
    display: flex;
    flex-direction: column;
    min-height: 100%;
    color: #dbe2ee;
  }
  .mt-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    flex: none;
  }
  .mt-title {
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0.08em;
  }
  .mt-toggles {
    display: flex;
    gap: 6px;
  }
  .tog {
    min-height: 36px;
    padding: 0 12px;
    border-radius: 18px;
    border: 1px solid #2a2f3a;
    background: none;
    color: #8b93a3;
    font-size: 12px;
    font-weight: 600;
  }
  .tog.on {
    background: rgba(79, 140, 255, 0.22);
    border-color: rgba(79, 140, 255, 0.6);
    color: #dbe2ee;
  }
  .sections {
    display: flex;
    gap: 4px;
    overflow-x: auto;
    padding: 0 12px 8px;
    flex: none;
  }
  .sec {
    flex: none;
    min-height: 36px;
    padding: 0 12px;
    border-radius: 8px;
    border: 1px solid #2a2f3a;
    background: none;
    color: #8b93a3;
    font-size: 12px;
    font-weight: 700;
  }
  .sec.on {
    background: rgba(79, 140, 255, 0.22);
    color: #dbe2ee;
  }
  .grid-scroll {
    flex: 1;
    overflow: auto;
    padding: 0 12px 12px;
    -webkit-overflow-scrolling: touch;
  }
  .grid {
    border-collapse: collapse;
  }
  .col-head {
    position: sticky;
    top: 0;
    z-index: 2;
    background: #0e1116;
    font-size: 10px;
    color: #8b93a3;
    font-weight: 600;
    padding: 6px 2px;
    max-width: 48px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .corner {
    position: sticky;
    left: 0;
    top: 0;
    z-index: 3;
    background: #0e1116;
  }
  .row-head {
    position: sticky;
    left: 0;
    z-index: 1;
    background: #0e1116;
    font-size: 11px;
    color: #8b93a3;
    font-weight: 600;
    text-align: right;
    padding: 0 8px 0 0;
    max-width: 108px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pair-expand {
    background: none;
    border: none;
    color: #b9c1d0;
    font-size: 11px;
    font-weight: 700;
    padding: 0;
  }
  td {
    padding: 1px;
  }
  .cell {
    width: 48px;
    height: 48px;
    display: flex;
    align-items: center;
    justify-content: center;
    position: relative;
    border-radius: 8px;
    border: 1px solid rgba(255, 255, 255, 0.06);
    background: rgba(255, 255, 255, 0.02);
    touch-action: manipulation;
  }
  .dot {
    width: 16px;
    height: 16px;
    border-radius: 50%;
  }
  .dot.ring {
    border: 2px solid rgba(255, 255, 255, 0.35);
  }
  .dot.solid {
    background: var(--edge-color, var(--accent, #4f8cff));
  }
  .dot.half {
    background: linear-gradient(90deg, var(--accent, #4f8cff) 50%, transparent 50%);
    border: 2px solid rgba(255, 255, 255, 0.35);
  }
  .dot.dim {
    background: rgba(255, 255, 255, 0.22);
  }
  .badge {
    position: absolute;
    top: 2px;
    right: 4px;
    font-size: 10px;
    color: #ffb86b;
  }
  .cv-expander {
    margin: 8px 0;
    min-height: 44px;
    width: 100%;
    border-radius: 10px;
    border: 1px dashed #2a2f3a;
    background: none;
    color: #8b93a3;
    font-size: 13px;
  }
  .hint {
    color: #667085;
    font-size: 12px;
    padding: 6px 2px;
  }
  .rails {
    flex: none;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 10px;
    border-top: 1px solid #1c212b;
    background: #10141b;
  }
  .rail {
    flex: 1;
    display: flex;
    gap: 4px;
  }
  .rail-chip {
    flex: 1;
    min-height: 56px;
    border-radius: 12px;
    border: 1px solid #2a2f3a;
    background: rgba(255, 255, 255, 0.04);
    color: #dbe2ee;
    font-size: 14px;
    font-weight: 700;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2px;
    overflow: hidden;
  }
  .rail-tag {
    font-size: 9px;
    color: #667085;
    letter-spacing: 0.1em;
  }
  .rail-step {
    min-width: 34px;
    min-height: 56px;
    border-radius: 10px;
    border: 1px solid #2a2f3a;
    background: none;
    color: #8b93a3;
  }
  .swap {
    min-width: 44px;
    min-height: 56px;
    border-radius: 12px;
    border: 1px solid #2a2f3a;
    background: none;
    color: #dbe2ee;
    font-size: 18px;
  }
  .picker {
    position: fixed;
    inset: 0;
    z-index: 70;
    background: #0e1116;
    display: flex;
    flex-direction: column;
    padding-top: env(safe-area-inset-top);
  }
  .picker-list {
    flex: 1;
    overflow-y: auto;
    padding: 0 12px calc(16px + env(safe-area-inset-bottom));
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .picker-row {
    min-height: 64px;
    display: flex;
    align-items: stretch;
    gap: 6px;
  }
  .picker-main {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 14px;
    border-radius: 12px;
    border: 1px solid #2a2f3a;
    background: rgba(255, 255, 255, 0.03);
    color: #dbe2ee;
    text-align: left;
  }
  .picker-name {
    flex: 1;
    font-size: 16px;
    font-weight: 700;
  }
  .picker-meta {
    font-size: 12px;
    color: #667085;
  }
  .picker-open {
    min-height: 40px;
    padding: 0 12px;
    border-radius: 10px;
    border: 1px solid #2a2f3a;
    background: none;
    color: #8b93a3;
    font-size: 12px;
  }
  .cable-list {
    flex: 1;
    overflow-y: auto;
    padding: 0 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .cable-row {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 56px;
  }
  .cable-label {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 56px;
    padding: 0 12px;
    border-radius: 12px;
    border: 1px solid #2a2f3a;
    background: rgba(255, 255, 255, 0.03);
    color: #dbe2ee;
    font-size: 13px;
    text-align: left;
  }
  .cable-label .dot {
    width: 10px;
    height: 10px;
    flex: none;
    background: var(--edge-color, #4f8cff);
  }
  .cable-x {
    min-width: 48px;
    min-height: 56px;
    border-radius: 12px;
    border: 1px solid #2a2f3a;
    background: none;
    color: #ff8b9b;
    font-size: 16px;
  }
  .bottom-sheet {
    position: fixed;
    inset: 0;
    z-index: 80;
    background: rgba(5, 7, 10, 0.6);
    display: flex;
    align-items: flex-end;
  }
  .sheet-card {
    width: 100%;
    background: #141821;
    border-top: 1px solid #2a2f3a;
    border-radius: 16px 16px 0 0;
    padding: 16px 16px calc(16px + env(safe-area-inset-bottom));
    display: flex;
    flex-direction: column;
    gap: 8px;
    font-size: 14px;
  }
  .sheet-btn {
    min-height: 56px;
    border-radius: 12px;
    border: 1px solid #2a2f3a;
    background: rgba(255, 255, 255, 0.05);
    color: #dbe2ee;
    font-size: 16px;
    font-weight: 600;
  }
  .sheet-btn.primary {
    background: rgba(79, 140, 255, 0.28);
    border-color: rgba(79, 140, 255, 0.6);
  }
  .sheet-btn.danger {
    background: rgba(226, 68, 92, 0.2);
    border-color: rgba(226, 68, 92, 0.6);
    color: #ff8b9b;
  }
</style>
