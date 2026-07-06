<script lang="ts">
  // ELECTRA CONTROL card — a FIXED positional 6×6 grid (36 slots, never
  // dynamic) laid out EXACTLY for the Electra One. Unlike CONTROL SURFACE (a
  // dynamic, first-seen, auto-grouped panel), this card always renders all 36
  // cells, derived from the (row, knob) enumeration — NOT from the data — so
  // empty slots render empty regardless of how many are filled.
  //
  // The grid is split into three 2-row banks with separators — TOP (Row1+2),
  // MIDDLE (Row3+4), BOTTOM (Row5+6) — mirroring the Electra's three stacked
  // 12-pot control sets. Each filled slot renders a proxied Knob keyed by the
  // source control's moduleId:paramId (so MIDI / the source's own knob / this
  // proxy / the Electra pot all share one binding), plus an editable label (the
  // name flashed to the Electra). Empty slots are inert placeholders.
  //
  // Modeled on ControlSurfaceCard.svelte (the cardVersion ydoc pump, the live
  // read/write through resolveSurfaceParam, the inline ✎ rename) — but with NO
  // drag/flow geometry (it does NOT import control-surface-layout.ts).
  //
  // CONTROL COLOUR (passthrough): each filled slot shows a thin colour stripe =
  // the SOURCE module's control colour (resolveControlColor), a LIVE read of the
  // source (not a stored copy). The same colour is threaded onto the Electra One
  // hardware at flash time (electra/host.ts). See control-color.ts.

  import type { NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import ModuleTitle from './ModuleTitle.svelte';
  // "Send to Electra" — the flash/auto-configure action lives ON this card (it
  // was moved off the global topbar). Reuses the exact ElectraConnectButton
  // logic (identify → generate preset → push + Lua → import CC map). Placement
  // mirrors LaunchpadControlCard's on-card connect button.
  import ElectraConnectButton from '$lib/ui/ElectraConnectButton.svelte';
  import { patch } from '$lib/graph/store';
  import { nodeVersion, nodesStructuralVersion } from '$lib/graph/node-versions.svelte';
  import { setNodeParam } from '$lib/graph/mutate';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode, ParamDef } from '$lib/graph/types';
  import {
    readElectraData,
    slotIndex,
    bindingAtSlot,
    setSlotName,
    pruneElectraDangling,
    ELECTRA_BANKS,
  } from '$lib/graph/electra-control';
  import { resolveSurfaceParam } from '$lib/graph/control-surface-params';
  import { resolveControlColor } from '$lib/graph/control-color';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  void node; // (parity with ControlSurfaceCard; the card reads live via patch)
  const engineCtx = useEngine();

  // Re-derive on any Yjs update so live param reads + remote slot writes reflect
  // instantly (mirrors ControlSurfaceCard's cardVersion pump).
  // Bounded node-scoped re-derive — mirrors ControlSurfaceCard (see its
  // comment): own node + every slot-bound SOURCE module + node add/remove.
  let cardVersion = $derived.by(() => {
    let v = nodeVersion(id) + nodesStructuralVersion();
    const seen = new Set<string>();
    for (const b of Object.values(readElectraData(patch.nodes[id]).slots ?? {})) {
      if (!b || seen.has(b.moduleId)) continue;
      seen.add(b.moduleId);
      v += nodeVersion(b.moduleId);
    }
    return v;
  });

  // AUTO-PRUNE dangling slots: when a bound source disappears the slot stops
  // RENDERING (resolveSurfaceParam returns null) but the binding lingers in
  // node.data — so the next Electra flash would emit a dead control. Drop any
  // DEFINITELY-gone slot on every ydoc update. Conservative + a no-op when
  // nothing dangles (mirrors ControlSurfaceCard).
  $effect(() => {
    void cardVersion;
    pruneElectraDangling(id);
  });

  let electraData = $derived.by(() => {
    void cardVersion;
    return readElectraData(patch.nodes[id]);
  });

  interface SlotView {
    row: number;
    knob: number;
    slot: number;
    /** null when empty. */
    moduleId: string | null;
    paramId: string | null;
    /** Knob label: custom name if set, else the param's own label. */
    label: string;
    /** The user-set custom name (empty when none) — seeds the rename input. */
    customName: string;
    def: ParamDef | null;
    /** The SOURCE module's resolved control colour (6-digit hex), read LIVE as
     *  PASSTHROUGH (null on an empty slot). Drives the stripe above the knob. */
    color: string | null;
  }
  interface BankView {
    label: string;
    rows: SlotView[][]; // [2 rows][6 knobs]
  }

  // Build the FIXED 3-bank × 2-row × 6-knob view by ENUMERATING (row, knob) —
  // never the data — so the grid is always 36 cells. Each filled slot is
  // resolved THROUGH the param adapter (flat node.params OR nested TOYBOX
  // node.data); an unresolvable binding renders as empty (def null).
  let banks = $derived.by<BankView[]>(() => {
    void cardVersion;
    const d = electraData;
    return ELECTRA_BANKS.map((bank) => {
      const rows: SlotView[][] = bank.rows.map((row) => {
        const cells: SlotView[] = [];
        for (let knob = 1; knob <= 6; knob++) {
          const slot = slotIndex(row, knob);
          const b = bindingAtSlot(d, slot);
          let def: ParamDef | null = null;
          let label = '';
          let customName = '';
          let color: string | null = null;
          if (b) {
            const sourceNode = patch.nodes[b.moduleId] as ModuleNode | undefined;
            const resolved = sourceNode ? resolveSurfaceParam(sourceNode, b.paramId) : null;
            if (resolved) {
              def = resolved.def;
              customName = typeof b.name === 'string' ? b.name.trim() : '';
              const baseLabel = resolved.def.label ?? b.paramId;
              label = customName.length > 0 ? customName : baseLabel;
              // LIVE read of the source module's control colour (passthrough).
              color = resolveControlColor(sourceNode);
            }
          }
          cells.push({
            row,
            knob,
            slot,
            moduleId: def ? b!.moduleId : null,
            paramId: def ? b!.paramId : null,
            label,
            customName,
            def,
            color,
          });
        }
        return cells;
      });
      return { label: bank.label, rows };
    });
  });

  // ── live param read / write (the pointer mechanism) — routed through the
  // adapter so TOYBOX nested params read/write the right node.data location. ──
  function readParam(sourceId: string, paramId: string, def: ParamDef): number {
    void cardVersion;
    const live = patch.nodes[sourceId] as ModuleNode | undefined;
    const resolved = resolveSurfaceParam(live, paramId);
    if (resolved) return resolved.get();
    return (live?.params[paramId] ?? def.defaultValue ?? 0) as number;
  }
  function setParam(sourceId: string, paramId: string, value: number) {
    const live = patch.nodes[sourceId] as ModuleNode | undefined;
    const resolved = resolveSurfaceParam(live, paramId);
    if (resolved) { resolved.set(value); return; }
    setNodeParam(sourceId, paramId, value);
  }
  function liveReader(sourceId: string, paramId: string) {
    return () => {
      const live = patch.nodes[sourceId] as ModuleNode | undefined;
      if (!live) return undefined;
      const e = engineCtx.get();
      const fromEngine = e ? e.readParam(live, paramId) : undefined;
      if (typeof fromEngine === 'number') return fromEngine;
      return resolveSurfaceParam(live, paramId)?.get();
    };
  }

  // ── per-slot rename (the Electra custom label) ──
  let editing: number | null = $state(null); // slot index being edited
  let editValue = $state('');

  function startRename(e: Event, slot: number, current: string) {
    e.stopPropagation();
    editing = slot;
    editValue = current;
  }
  function commitRename() {
    if (editing === null) return;
    setSlotName(id, editing, editValue);
    editing = null;
  }
  function cancelRename() { editing = null; }
  function onRenameKey(e: KeyboardEvent) {
    if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancelRename(); }
  }
</script>

<div class="mod-card electra-control-card" data-testid="electra-control-card" data-node-id={id}>
  <div class="ec-titlebar">
    <ModuleTitle {id} {data} defaultLabel="ELECTRA CONTROL" inline={true} />
    <!-- On-card "Send to Electra": generates the 3-page preset from the whole
         rack + pushes it to a connected Electra One. Reuses the shared button. -->
    <div class="ec-actions">
      <ElectraConnectButton />
    </div>
  </div>

  <div class="ec-grid" data-testid="electra-control-grid">
    {#each banks as bank (bank.label)}
      <div class="ec-bank" data-testid={`electra-control-bank-${bank.label}`}>
        <div class="ec-bank-label">{bank.label}</div>
        {#each bank.rows as cells, ri (ri)}
          <div class="ec-row">
            {#each cells as c (c.slot)}
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <div
                class="ec-slot"
                class:filled={!!c.def}
                data-testid={`electra-control-slot-${c.row}-${c.knob}`}
                data-slot={c.slot}
                data-filled={c.def ? 'true' : 'false'}
                onpointerdown={(e) => e.stopPropagation()}
              >
                {#if c.def && c.moduleId && c.paramId}
                  <!-- PASSTHROUGH colour stripe: the SOURCE module's live control
                       colour (resolveControlColor), so a glance identifies which
                       source drives each slot. Not a stored copy. -->
                  <div
                    class="ec-slot-stripe"
                    data-testid={`electra-control-stripe-${c.row}-${c.knob}`}
                    style:background={`#${c.color}`}
                    aria-hidden="true"
                  ></div>
                  <Knob
                    value={readParam(c.moduleId, c.paramId, c.def)}
                    min={c.def.min}
                    max={c.def.max}
                    defaultValue={c.def.defaultValue}
                    label={c.label}
                    units={c.def.units}
                    curve={c.def.curve}
                    onchange={(v) => setParam(c.moduleId!, c.paramId!, v)}
                    readLive={liveReader(c.moduleId, c.paramId)}
                    moduleId={c.moduleId}
                    paramId={c.paramId}
                  />
                  {#if editing === c.slot}
                    <!-- svelte-ignore a11y_autofocus -->
                    <input
                      class="ec-rename nodrag"
                      data-testid={`electra-control-rename-input-${c.row}-${c.knob}`}
                      type="text"
                      bind:value={editValue}
                      maxlength="14"
                      aria-label={`Rename ${c.label}`}
                      autofocus
                      onpointerdown={(e) => e.stopPropagation()}
                      onkeydown={onRenameKey}
                      onblur={commitRename}
                    />
                  {:else}
                    <button
                      type="button"
                      class="ec-rename-btn nodrag"
                      data-testid={`electra-control-rename-${c.row}-${c.knob}`}
                      title={`Rename “${c.label}” for the Electra`}
                      aria-label={`Rename ${c.label}`}
                      onpointerdown={(e) => e.stopPropagation()}
                      ondblclick={(e) => startRename(e, c.slot, c.customName)}
                      onclick={(e) => startRename(e, c.slot, c.customName)}
                    >
                      ✎
                    </button>
                  {/if}
                {:else}
                  <div class="ec-empty" aria-hidden="true">
                    <div class="ec-empty-dial"></div>
                  </div>
                {/if}
              </div>
            {/each}
          </div>
        {/each}
      </div>
    {/each}
  </div>
</div>

<style>
  .electra-control-card {
    width: max-content;
    min-width: 360px;
    background: var(--module-bg, #1a1d24);
    border-radius: 6px;
    padding: 6px 8px 8px;
    box-sizing: border-box;
  }
  .ec-titlebar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 6px;
  }
  /* On-card action cluster (the "Send to Electra" button), right-aligned in the
     titlebar — mirrors LaunchpadControlCard's on-card connect affordance. */
  .ec-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 0 0 auto;
  }
  .ec-grid {
    display: flex;
    flex-direction: column;
    gap: 6px;
    border: 1px solid #2a2f3a;
    border-radius: 5px;
    background: #0e1015;
    padding: 6px;
    box-sizing: border-box;
  }
  /* Three 2-row banks with a visible separator between them. */
  .ec-bank {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 4px;
    border: 1px dashed #3a4150;
    border-radius: 5px;
    background: rgba(20, 24, 32, 0.5);
  }
  .ec-bank-label {
    font-size: 0.58rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-dim, #97a3bd);
    pointer-events: none;
  }
  .ec-row {
    display: grid;
    grid-template-columns: repeat(6, 1fr);
    gap: 6px;
  }
  .ec-slot {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: flex-start;
    min-width: 48px;
    min-height: 62px;
    touch-action: none;
  }
  /* PASSTHROUGH colour stripe — the source module's live control colour, above
     the knob. Background colour set inline from resolveControlColor(source). */
  .ec-slot-stripe {
    width: 80%;
    height: 4px;
    border-radius: 2px;
    margin-bottom: 2px;
  }
  /* Empty slot: a dim, inert dial-shaped placeholder so the fixed grid reads
     as a physical control surface (which knob drives what) even when empty. */
  .ec-empty {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    opacity: 0.4;
  }
  .ec-empty-dial {
    width: 30px;
    height: 30px;
    border-radius: 50%;
    border: 1px dashed #404652;
    background: #14171c;
  }
  /* Defensive label clamp (matches Knob.svelte / ControlSurfaceCard). */
  .ec-slot :global(.label) {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ec-rename-btn {
    margin-top: 2px;
    font-size: 0.6rem;
    line-height: 1;
    padding: 1px 4px;
    border-radius: 3px;
    border: 1px solid #404652;
    background: rgba(96, 165, 250, 0.1);
    color: var(--text-dim, #aab);
    cursor: pointer;
  }
  .ec-rename-btn:hover { background: rgba(96, 165, 250, 0.22); }
  .ec-rename {
    margin-top: 2px;
    width: 100%;
    max-width: 46px;
    box-sizing: border-box;
    font-size: 0.6rem;
    padding: 1px 3px;
    border-radius: 3px;
    border: 1px solid #6f8bd0;
    background: #0e1015;
    color: var(--text, #e8eaed);
  }
</style>
