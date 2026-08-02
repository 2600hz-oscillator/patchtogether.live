<script lang="ts">
  // PF-20 — THE DOCK SIDEBAR: the faceplate's context column.
  //
  // The single largest structural gap between the shell and the mocks. The
  // mocked panels are instruments: a signal-flow diagram down the right edge, a
  // preset list you can SELECT from, labelled readouts, and room for the one
  // bespoke picture the module needs. The shell had none of it, so every face
  // built on the shell drifted the same way — which is why this is platform
  // work and not another per-card fix.
  //
  // FOUR TYPED BLOCK KINDS, and they stay generic by construction: three are
  // pure data this file paints (`signal-flow`, `presets`, `readouts`), and the
  // fourth (`custom`) resolves an id through the sidebar-panels registry. No
  // branch anywhere below names a module.
  //
  // WHERE IT LIVES, and why that is load-bearing. It is mounted by DockFullView
  // as the `.page.has-sidebar` grid's second column — a SIBLING of `.editor`,
  // OUTSIDE the <ModuleShell> subtree. faces-parity scopes its exact param
  // multiset and its per-cell operability sweep to the module-shell element, so
  // a sidebar row can never be mistaken for a control cell, and the sidebar is
  // free to contain buttons without teaching that gate a new cell kind.
  //
  // DOCK-ONLY: ranks 1-6 are the LANE budget and a 192×180 tile has no column
  // to give. There is no lane code path here at all.

  import { patch } from '$lib/graph/store';
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
  import { mutateNode, setNodeParam } from '$lib/graph/mutate';
  import type { FaceSidebarBlock, ModuleNode, ParamDef } from '$lib/graph/types';
  import {
    FACE_PRESET_DATA_KEY,
    presetNote,
    presetRowStates,
    presetWrites,
    readoutText,
    recalledPresetId,
    isUsableReadout,
  } from './dock-faceplate-model';
  import { sidebarPanelFor } from './sidebar-panels';

  interface Props {
    nodeId: string;
    /** The already-FILTERED block list (sidebarPlan) — an empty-rendering block
     *  is dropped before it gets here, so this file never paints a labelled
     *  void. */
    blocks: readonly FaceSidebarBlock[];
    params: readonly ParamDef[];
  }
  let { nodeId, blocks, params }: Props = $props();

  /**
   * ⚠ THE VERSION IS CARRIED IN THE RESULT (ModuleShell's `liveCell` pattern).
   * `patch.nodes[id]` is a STABLE SyncedStore proxy, so a `$derived.by` that
   * reads `nodeVersion(id)` and returns it BARE is `===` to its own previous
   * value — Svelte suppresses the invalidation and every downstream `$derived`
   * keeps its stale answer. Making the TICK the identity is what re-projects
   * on every bump; without it a recall stamps every param and the row never
   * lights.
   */
  let live = $derived.by(() => ({ v: nodeVersion(nodeId), n: patch.nodes[nodeId] as ModuleNode | undefined }));

  /** The live durable value of a param — the reader every readout + the preset
   *  match go through. A missing entry resolves the DEF DEFAULT: `node.params`
   *  is a sparse overlay of what has been TOUCHED, not the module's state. */
  function readParam(pid: string): number | undefined {
    const v = (live.n?.params as Record<string, number> | undefined)?.[pid];
    if (typeof v === 'number') return v;
    return params.find((p) => p.id === pid)?.defaultValue;
  }

  /**
   * Apply a preset: the declared param values, written through the ORDINARY
   * `setNodeParam` path one at a time, and THEN the recalled id recorded.
   *
   * The param path is the whole point of wiring a roster to a real action
   * rather than painting a list — a preset inherits undo, Y.Doc sync, the
   * motorized readback and MIDI parity for free, because it is
   * indistinguishable from someone turning the knobs. Range clamping +
   * dropping keys that name no declared param happen in the pure layer
   * (`presetWrites`), so a face whose contract moved under it cannot push the
   * model out of range.
   *
   * ⚠ ORDER IS LOAD-BEARING: values FIRST, the id SECOND. An observer reacting
   * to the recorded id (this row's own highlight, the parity probe) can then
   * never see the new NAME over the old SOUND.
   */
  function applyPreset(id: string, values: Readonly<Record<string, number>>): void {
    for (const w of presetWrites(values, params)) setNodeParam(nodeId, w.paramId, w.value);
    mutateNode(nodeId, (n) => {
      if (!n.data) n.data = {};
      n.data[FACE_PRESET_DATA_KEY] = id;
    });
  }
</script>

<aside class="sidebar" data-testid="face-sidebar">
  {#each blocks as block, i (block.kind + i)}
    <section class="side-block" data-side-block={block.kind}>
      <div class="side-h">{block.label}</div>

      {#if block.kind === 'signal-flow'}
        <!-- THE CHAIN. An ordered list of stages with the ONE distinction that
             makes a chain readable: a GENERATOR makes sound, a BUS stage
             processes whatever reaches it. The legend prints only the roles
             actually used, so a bus-only chain does not advertise a generator
             swatch it never draws. -->
        <ol class="flow" data-testid="side-flow">
          {#each block.stages as st, j (st.label + j)}
            <li
              class="flow-stage"
              class:parallel={st.parallel}
              data-flow-role={st.role ?? 'bus'}
              data-flow-parallel={st.parallel ? 'true' : undefined}
            >
              <span class="dot" aria-hidden="true"></span>
              <span class="fs-label">{st.label}</span>
              {#if st.parallel}<span class="fs-branch" title="parallel branch — it taps the bus earlier and rejoins it here">∥</span>{/if}
              {#if st.note}<span class="fs-note">{st.note}</span>{/if}
            </li>
          {/each}
        </ol>
        {#if block.stages.some((s) => s.role === 'generator')}
          <div class="flow-legend">
            <span class="lg gen"><span class="dot" aria-hidden="true"></span>generator</span>
            <span class="lg bus"><span class="dot" aria-hidden="true"></span>bus stage</span>
          </div>
        {/if}

      {:else if block.kind === 'presets'}
        <!-- A REAL SELECTION, not decoration — and it carries TWO facts, not
             one (see presetRowStates for the full argument). `aria-pressed`
             says where the sound CAME FROM: the row stays lit after you turn a
             knob, because un-lighting throws away the only record of which
             voice this patch started as. The MODIFIED marker says the values
             have since moved, because a row that stayed lit and said nothing
             else would be asserting a voice the patch no longer is. -->
        {@const rows = presetRowStates(
          block.entries,
          recalledPresetId(block.entries, live.n?.data as Record<string, unknown> | undefined),
          readParam,
        )}
        <ul class="list" data-testid="side-presets">
          {#each block.entries as p, i (p.id)}
            {@const st = rows[i]}
            <li>
              <button
                type="button"
                class="preset-row"
                class:on={st?.lit}
                class:modified={st?.modified}
                aria-pressed={!!st?.lit}
                data-preset-modified={st?.modified ? 'true' : undefined}
                data-testid={`face-preset-${p.id}`}
                title={st?.modified
                  ? `${p.label} — recalled, then edited`
                  : `${p.label} — recall this voice`}
                onclick={() => applyPreset(p.id, p.values)}
              >
                <span class="pr-label">{p.label}</span>
                {#if st?.modified}
                  <span class="pr-mod" data-testid={`face-preset-${p.id}-modified`}>modified</span>
                {:else if presetNote(p)}
                  <span class="pr-note">{presetNote(p)}</span>
                {/if}
              </button>
            </li>
          {/each}
        </ul>

      {:else if block.kind === 'readouts'}
        <dl class="readouts" data-testid="side-readouts">
          {#each block.entries.filter(isUsableReadout) as r (r.label)}
            <div class="ro-row" data-side-readout={r.paramId ?? r.label}>
              <dt>{r.label}</dt>
              <dd>{readoutText(r, params, readParam)}</dd>
            </div>
          {/each}
        </dl>

      {:else if block.kind === 'custom'}
        <!-- The bespoke picture, resolved through the REGISTRY (never an import
             here). An unregistered id renders nothing and fails
             module-face-lint, so a typo is loud in the unit lane rather than a
             blank column in production. -->
        {@const Panel = sidebarPanelFor(block.panelId)}
        {#if Panel}
          <div class="side-panel" data-side-panel={block.panelId}>
            <Panel {nodeId} props={block.props} {params} />
          </div>
        {/if}
      {/if}
    </section>
  {/each}
</aside>

<style>
  /* The `.sidebar` frame itself is the shared dock kit (_dock-faceplate.css
     `.dock-faceplate .sidebar` / `.side-h`) — this file only styles the block
     bodies, so the column matches the mock's chrome by construction. */
  .side-block {
    min-width: 0;
  }

  /* ── signal-flow ── */
  .flow {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0;
  }
  .flow-stage {
    position: relative;
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 3px 0 3px 2px;
    font-size: 11px;
    color: var(--text, #eef1f5);
    min-width: 0;
  }
  /* The connector: a hairline from each stage's dot down to the next one, so
     the list reads as a CHAIN rather than as bullets. Suppressed on the last
     stage (`:last-child`) — a wire leaving the output goes nowhere. */
  .flow-stage:not(:last-child)::before {
    content: '';
    position: absolute;
    left: 5px;
    top: 14px;
    bottom: -2px;
    width: 1px;
    background: var(--line2, #333b48);
  }
  .flow-stage .dot {
    flex: none;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--mod, #7b8394);
    box-shadow: 0 0 0 2px var(--inset, #0a0c0f);
    transform: translateY(1px);
  }
  .flow-stage[data-flow-role='generator'] .dot {
    background: var(--domain, #38d3c8);
  }
  .fs-label {
    flex: 1 1 auto;
    min-width: 0;
    letter-spacing: 0.04em;
  }
  .fs-note {
    font-family: var(--f-mono, ui-monospace, monospace);
    font-size: 9px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--faint, #646c77);
    white-space: nowrap;
  }
  /* A PARALLEL stage is drawn off the spine: its dot is hollow and its
     connector dashed, because it is not a link in the chain — it taps the bus
     earlier and rejoins it here. */
  .flow-stage.parallel .dot {
    background: var(--inset, #0a0c0f);
    box-shadow: 0 0 0 1.5px var(--mod, #7b8394), 0 0 0 3px var(--inset, #0a0c0f);
  }
  .flow-stage.parallel .fs-label {
    font-style: italic;
  }
  .fs-branch {
    font-family: var(--f-mono, ui-monospace, monospace);
    font-size: 10px;
    color: var(--faint, #646c77);
  }
  .flow-legend {
    display: flex;
    gap: 12px;
    margin-top: 8px;
    font-family: var(--f-mono, ui-monospace, monospace);
    font-size: 9px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--faint, #646c77);
  }
  .flow-legend .lg {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .flow-legend .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--mod, #7b8394);
  }
  .flow-legend .gen .dot {
    background: var(--domain, #38d3c8);
  }

  /* ── presets ── */
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .preset-row {
    width: 100%;
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
    padding: 6px 9px;
    font: inherit;
    font-size: 11px;
    text-align: left;
    color: var(--text, #eef1f5);
    background: var(--raised2, #20262f);
    border: 1px solid var(--line2, #333b48);
    border-radius: 6px;
    cursor: pointer;
  }
  .preset-row:hover {
    border-color: var(--domain, #38d3c8);
  }
  .preset-row.on {
    border-color: var(--domain, #38d3c8);
    background: var(--domain-soft, rgba(56, 211, 200, 0.1));
  }
  .preset-row.on .pr-label {
    color: var(--domain, #38d3c8);
    font-weight: 700;
  }
  .pr-label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    letter-spacing: 0.03em;
  }
  .pr-note {
    flex: none;
    font-family: var(--f-mono, ui-monospace, monospace);
    font-size: 9px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--faint, #646c77);
  }
  /* MODIFIED: the row is still lit (this is where the sound came from) but the
     values have moved. Dashed, so the lit state and the caveat read as one
     statement rather than two competing ones. */
  .preset-row.modified {
    border-style: dashed;
  }
  .pr-mod {
    flex: none;
    font-family: var(--f-mono, ui-monospace, monospace);
    font-size: 9px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--gate, #f2c14e);
  }

  /* ── readouts ── */
  .readouts {
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .ro-row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
  }
  .ro-row dt {
    font-family: var(--f-mono, ui-monospace, monospace);
    font-size: 9px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--faint, #646c77);
  }
  .ro-row dd {
    margin: 0;
    font-family: var(--f-mono, ui-monospace, monospace);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.03em;
    color: var(--domain, #38d3c8);
    white-space: nowrap;
  }
</style>
