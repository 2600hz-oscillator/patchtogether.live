<script lang="ts">
  // CvBuddyCard — UI for the CV BUDDY module (the note-sink half of the ES-9
  // note-lane bridge, Part A). The card shows:
  //   * the three note INPUTS (gate / pitch / velocity) and five note/transport
  //     OUTPUTS (pitchCv / gate / velCv / run / clock) as PatchPanel handles,
  //   * which ES-9 jacks THIS instance owns (id-sorted: 1-3, or 4-6, or none),
  //   * a CLOCK section (PPQN + offset + "run → jack 7 · clock → jack 8") shown
  //     ONLY on the clock-owner (id-smallest) instance,
  //   * an ES-9 presence mirror that prompts the user to add an ES-9 + run the
  //     es9-bridge helper when none is in the rack.
  //
  // All cross-node state (instance ordering, ES-9 presence) is derived reactively
  // from the live patch via nodesStructuralVersion(); this instance's params via
  // nodeVersion(id).

  import type { NodeProps } from '@xyflow/svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import type { ModuleNode } from '$lib/graph/types';
  import { patch } from '$lib/graph/store';
  import { setNodeParam } from '$lib/graph/mutate';
  import { nodeVersion, nodesStructuralVersion } from '$lib/graph/node-versions.svelte';
  import {
    allocateCvBuddySlots,
    type CvBuddyAlloc,
  } from '$lib/audio/cv-buddy/slot-alloc';
  import { CV_BUDDY_PPQN_CHOICES, CV_BUDDY_DEFAULT_PPQN } from '$lib/audio/modules/cv-buddy';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);

  // Reactive graph reads.
  let structuralV = $derived(nodesStructuralVersion());
  let cardV = $derived(nodeVersion(id));

  let cvBuddyIds = $derived.by<string[]>(() => {
    void structuralV;
    const ids: string[] = [];
    for (const n of Object.values(patch.nodes)) {
      if (n && (n as { type?: string }).type === 'cvBuddy') ids.push((n as { id: string }).id);
    }
    return ids;
  });
  let es9Present = $derived.by<boolean>(() => {
    void structuralV;
    for (const n of Object.values(patch.nodes)) {
      if (n && (n as { type?: string }).type === 'es9') return true;
    }
    return false;
  });

  let alloc = $derived<CvBuddyAlloc | undefined>(allocateCvBuddySlots(cvBuddyIds).get(id));
  let ownsClock = $derived(alloc?.ownsClock === true);

  let slotLabel = $derived.by(() => {
    if (!alloc) return 'No free ES-9 slots (3rd+ CV Buddy)';
    return `Jacks ${alloc.pitchSlot}–${alloc.velSlot} (pitch/gate/vel)`;
  });

  // This instance's params (reactive).
  let ppqn = $derived<number>((void cardV, node?.params?.ppqn ?? CV_BUDDY_DEFAULT_PPQN));
  let offsetMs = $derived<number>((void cardV, node?.params?.clockOffsetMs ?? 0));

  function onChangePpqn(ev: Event): void {
    const v = Number.parseInt((ev.currentTarget as HTMLSelectElement).value, 10);
    if (Number.isFinite(v)) setNodeParam(id, 'ppqn', v);
  }
  function onChangeOffset(ev: Event): void {
    const v = Number.parseFloat((ev.currentTarget as HTMLInputElement).value);
    if (Number.isFinite(v)) setNodeParam(id, 'clockOffsetMs', v);
  }

  const inputs: PortDescriptor[] = [
    { id: 'gate', label: 'GATE', cable: 'gate' },
    { id: 'pitch', label: 'PITCH', cable: 'cv' },
    { id: 'velocity', label: 'VEL', cable: 'cv' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'pitchCv', label: 'PITCH CV', cable: 'cv' },
    { id: 'gate', label: 'GATE', cable: 'gate' },
    { id: 'velCv', label: 'VEL CV', cable: 'cv' },
    { id: 'run', label: 'RUN', cable: 'gate' },
    { id: 'clock', label: 'CLOCK', cable: 'gate' },
  ];
</script>

<div class="mod-card cv-buddy-card">
  <div class="stripe" style="background: var(--cable-cv);"></div>
  <ModuleTitle {id} {data} defaultLabel="CV BUDDY" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="body">
      <div class="readout" data-testid="cv-buddy-slots-{id}">
        <span class="lbl">SLOTS</span>
        <span class="val">{slotLabel}</span>
      </div>

      {#if ownsClock}
        <div class="clock-section" data-testid="cv-buddy-clock-{id}">
          <label class="row">
            <span class="lbl">PPQN</span>
            <select onchange={onChangePpqn} value={String(ppqn)}>
              {#each CV_BUDDY_PPQN_CHOICES as p (p)}
                <option value={String(p)}>{p}</option>
              {/each}
            </select>
          </label>
          <label class="row">
            <span class="lbl">OFFSET</span>
            <input
              type="range"
              min="-20"
              max="20"
              step="0.5"
              value={offsetMs}
              oninput={onChangeOffset}
            />
            <span class="val mono">{offsetMs.toFixed(1)} ms</span>
          </label>
          <div class="hint">run → jack 7 · clock → jack 8</div>
        </div>
      {:else}
        <div class="hint muted">
          {#if alloc}
            PPQN / clock is driven by the first CV Buddy (this instance follows).
          {:else}
            Inert — the first two CV Buddies own the ES-9 jacks.
          {/if}
        </div>
      {/if}

      <div class="es9-mirror" class:ok={es9Present} data-testid="cv-buddy-es9-{id}">
        {#if es9Present}
          <span class="dot lit"></span>
          <span class="mirror-text">ES-9 in rack — outputs route to its jacks. Run the es9-bridge helper to hear them.</span>
        {:else}
          <span class="dot"></span>
          <span class="mirror-text">No ES-9 in rack — add an ES-9 module and run the es9-bridge helper.</span>
        {/if}
      </div>
    </div>
  </PatchPanel>
</div>

<style>
  .cv-buddy-card { width: 230px; }
  .cv-buddy-card .body {
    padding: 10px 14px 8px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .cv-buddy-card .lbl {
    min-width: 46px;
    color: var(--muted, #aaa);
    font-weight: 600;
    letter-spacing: 0.5px;
    font-size: 10px;
  }
  .cv-buddy-card .val { font-size: 10px; color: var(--fg, #eee); }
  .cv-buddy-card .mono { font-family: var(--mono, ui-monospace, monospace); }
  .cv-buddy-card .readout {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 6px;
    border: 1px solid var(--border, #333);
    border-radius: 3px;
  }
  .cv-buddy-card .clock-section {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 6px;
    border: 1px solid var(--border, #333);
    border-radius: 3px;
  }
  .cv-buddy-card .row {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 10px;
  }
  .cv-buddy-card .row select {
    flex: 1;
    font-size: 10px;
    padding: 2px 4px;
    background: var(--panel, #222);
    color: var(--fg, #eee);
    border: 1px solid var(--border, #444);
    border-radius: 2px;
  }
  .cv-buddy-card .row input[type='range'] { flex: 1; }
  .cv-buddy-card .hint {
    font-size: 10px;
    color: var(--cable-cv, #6cf);
    line-height: 1.3;
  }
  .cv-buddy-card .hint.muted { color: var(--muted, #888); }
  .cv-buddy-card .es9-mirror {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    font-size: 10px;
    color: var(--muted, #888);
    line-height: 1.3;
  }
  .cv-buddy-card .es9-mirror.ok { color: var(--fg, #ccc); }
  .cv-buddy-card .mirror-text { flex: 1; }
  .cv-buddy-card .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--border, #444);
    flex: 0 0 auto;
    margin-top: 2px;
  }
  .cv-buddy-card .dot.lit {
    background: var(--cable-cv, #6cf);
    box-shadow: 0 0 6px var(--cable-cv, #6cf);
  }
</style>
