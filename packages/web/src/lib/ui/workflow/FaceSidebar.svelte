<script lang="ts">
  // PF-20 — THE DOCK SIDEBAR: the faceplate's context column.
  //
  // The single largest structural gap between the shell and the mocks. The
  // mocked panels are instruments: a preset list you can SELECT from, labelled
  // readouts, and room for the one bespoke picture the module needs. The shell
  // had none of it, so every face built on the shell drifted the same way —
  // which is why this is platform work and not another per-card fix.
  //
  // THREE TYPED BLOCK KINDS, and they stay generic by construction: two are
  // pure data this file paints (`presets`, `readouts`), and the third
  // (`custom`) resolves an id through the sidebar-panels registry. No branch
  // anywhere below names a module.
  //
  // ⚠ A FOURTH KIND, `signal-flow`, was removed with its twelve adopters — a
  // hand-authored DSP chain nothing verified against the DSP. See the note on
  // `FaceSidebarBlock` in graph/types.ts before drawing another one.
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

      {#if block.kind === 'presets'}
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
