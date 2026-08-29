<script lang="ts">
  // TempolockCard — the LEGACY card for TEMPOLOCK (the beat-tracking clock).
  //
  // The module is born faced (STRICT_FACES), so the shipping shell renders
  // the curated face and this card exists for the `?shell=legacy` path that
  // must keep working while the migration is live. It is the SampleHoldCard
  // shape: one discrete knob with its option NAME painted above it — the name
  // comes from the def's own `options` roster, never re-typed, so the card
  // and every other surface name the bands identically.
  //
  // Layout:
  //        "90-180"          ← the active BAND, from the def's options roster
  //        ◐ BAND            ← the fold-band knob (discrete 0..2)
  //
  //   Patch panel: input IN (the onset train); outputs CLOCK / BPM / LOCKED.
  //
  // No range literal is typed here — min/max/default all read off the def
  // (the backdraft class; see CLAUDE.md "A CARD can silently disagree with
  // its DEF").

  import type { NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import ModuleTitle from './ModuleTitle.svelte';
  import { tempolockDef } from '$lib/audio/modules/tempolock';
  import type { ModuleNode } from '$lib/graph/types';
  import { cardParams, portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const { set, live } = cardParams(tempolockDef, () => id, () => node);

  const rangeDef = tempolockDef.params.find((p) => p.id === 'range')!;

  function paramVal(): number {
    const v = node?.params?.range;
    return typeof v === 'number' ? v : (rangeDef.defaultValue as number);
  }

  // The band NAME, from the def's roster — the single source of truth.
  let bandName = $derived(
    rangeDef.options?.find((o) => o.value === Math.round(paramVal()))?.label ??
      rangeDef.options?.[rangeDef.defaultValue as number]?.label ??
      '',
  );

  const inputs = portsFromDef(tempolockDef.inputs, { in: 'IN' });
  const outputs = portsFromDef(tempolockDef.outputs, {
    clock: 'CLOCK',
    bpm: 'BPM',
    locked: 'LOCKED',
  });
</script>

<div class="mod-card tempolock-card">
  <div class="stripe" style="background: var(--cable-gate);"></div>
  <ModuleTitle {id} {data} defaultLabel="TEMPOLOCK" />

  <PatchPanel nodeId={id} {inputs} {outputs} panelWidth={220}>
    <div class="tl-body">
      <div class="band-group" data-testid="tempolock-band-group">
        <div class="band-name" data-testid="tempolock-band-name">{bandName}</div>
        <Knob
          value={paramVal()}
          min={rangeDef.min}
          max={rangeDef.max}
          defaultValue={rangeDef.defaultValue}
          label="Band"
          curve="discrete"
          onchange={set('range')}
          moduleId={id}
          paramId="range"
          readLive={live('range')}
        />
      </div>
    </div>
  </PatchPanel>
</div>

<style>
  .tempolock-card {
    width: 220px;
    background: var(--module-bg);
    border: 1px solid var(--border);
    border-radius: 2px;
    color: var(--text);
    padding-top: 18px;
    padding-bottom: 14px;
    position: relative;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  :global(.svelte-flow__node:hover) .tempolock-card { border-color: var(--accent-dim); }
  :global(.svelte-flow__node.selected) .tempolock-card {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent-glow), 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  .stripe { position: absolute; top: 0; left: 0; right: 0; height: 2px; border-radius: 2px 2px 0 0; }
  .tl-body { padding: 6px 10px 4px; display: flex; justify-content: center; }
  .band-group {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    min-width: 92px;
  }
  .band-name {
    font-family: var(--font-mono, monospace);
    font-size: 0.72rem;
    font-weight: 600;
    letter-spacing: 0.03em;
    color: var(--accent, #ffce6e);
    text-align: center;
    white-space: nowrap;
  }
</style>
