<script lang="ts">
  // SwolevcoCard — Buchla-259-style complex VCO. PatchPanel pattern
  // (mirrors AdsrCard / VcaCard). Knobs for tune/fine, modulator
  // tune/fine, ratio, timbre, symmetry, fold; ports for the four
  // outputs (out / mod_out / sum_out / scope) and the various inputs
  // (pitch, mod_pitch, fm, plus cv-modulatable knobs).
  import type { NodeProps } from '@xyflow/svelte';
  import NeonFader from '$lib/ui/controls/NeonFader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { swolevcoDef } from '$lib/audio/modules/swolevco';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { cardParams, paramSpec, portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const { set, live } = cardParams(swolevcoDef, () => id, () => node);

  function paramVal(id_: string, fallback: number): number {
    const v = node?.params?.[id_];
    return typeof v === 'number' ? v : fallback;
  }

  // Every fader carries its own ParamDef rather than re-typed literals. This
  // card hand-typed all eight ranges, and `swolevco` was outside
  // RANGE_BOUND_CARDS, so nothing could see a divergence — and one had already
  // opened: the card labelled `timbre` "Timbr" where the def says "Tbr".
  // Harmless while the legacy card was the only surface; from promotion the
  // DOCK renders these controls straight off the ParamDef, so one fader would
  // have had two names depending on which surface you reached it through
  // (the DestroyCard precedent). Binding the whole def forecloses the numbers
  // and the names in one edit.
  const P = {
    tune: paramSpec(swolevcoDef, 'tune'),
    fine: paramSpec(swolevcoDef, 'fine'),
    mod_tune: paramSpec(swolevcoDef, 'mod_tune'),
    mod_fine: paramSpec(swolevcoDef, 'mod_fine'),
    ratio: paramSpec(swolevcoDef, 'ratio'),
    timbre: paramSpec(swolevcoDef, 'timbre'),
    symmetry: paramSpec(swolevcoDef, 'symmetry'),
    fold: paramSpec(swolevcoDef, 'fold'),
  } as const;
  const FADERS: readonly (readonly (keyof typeof P)[])[] = [
    ['tune', 'fine', 'mod_tune', 'mod_fine'],
    ['ratio', 'timbre', 'symmetry', 'fold'],
  ];

  // Inputs + outputs feed the PatchPanel. The patch-panel auto-grouper
  // sorts by cable type — pitches first, then audio, then cv. Outputs
  // group similarly (audio + mono-video).
  const inputs = portsFromDef(swolevcoDef.inputs, { mod_pitch: 'MOD PITCH' });
  const outputs = portsFromDef(swolevcoDef.outputs, { mod_out: 'MOD OUT', sum_out: 'SUM OUT' });
</script>

<div class="mod-card swolevco-card">
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <ModuleTitle {id} {data} defaultLabel="SWOLEVCO" />

  <PatchPanel nodeId={id} {inputs} {outputs} panelWidth={280}>
    <div class="grid">
      {#each FADERS as row, i (i)}
        <div class="row">
          {#each row as key (key)}
            <NeonFader
              value={paramVal(P[key].id, P[key].defaultValue)}
              min={P[key].min}
              max={P[key].max}
              defaultValue={P[key].defaultValue}
              label={P[key].label ?? P[key].id}
              units={P[key].units ?? ''}
              curve={P[key].curve}
              onchange={set(P[key].id)}
              moduleId={id}
              paramId={P[key].id}
              readLive={live(P[key].id)}
            />
          {/each}
        </div>
      {/each}
    </div>
  </PatchPanel>
</div>

<style>
  .swolevco-card {
    width: 360px;
  }
  .swolevco-card .grid {
    margin-top: 16px;
    padding: 0 18px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .swolevco-card .row {
    display: flex;
    gap: 8px;
    justify-content: space-between;
  }
</style>
