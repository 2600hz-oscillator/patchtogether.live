<script lang="ts">
  // AttenumixCard — the simple mixer. 4 channel strips, each with an
  // attenuator fader; a single MASTER fader at the right. Audio + CV
  // inputs and per-channel direct outs live on the PatchPanel; the MIX
  // output is the last port at the bottom of the outputs column.
  //
  // PatchPanel pattern (a quad-channel fader layout stripped of the
  // response toggle — ATTENUMIX is the no-extra-controls mixer).
  import type { NodeProps } from '@xyflow/svelte';
  import NeonFader from '$lib/ui/controls/NeonFader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { attenumixDef } from '$lib/audio/modules/attenumix';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { cardParams, paramSpec, portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const { paramVal, set, live } = cardParams(attenumixDef, () => id, () => node);

  // ── RANGES COME FROM THE DEF, NEVER RE-TYPED ────────────────────────────
  // The backdraft class (CLAUDE.md): every gate we own reads the DEF, so a card
  // restating its def's numbers can disagree with it and NOTHING can see that.
  // It matters more here than usual now that this module is FACED — the dock
  // full view renders straight off the ParamDef while the legacy card renders
  // off whatever it typed, so a divergence would be two different travels for
  // the same knob depending on which surface you reached it through.
  // Enrolled in RANGE_BOUND_CARDS + MAPPING_BOUND_CARDS
  // (card-range-source.test.ts) — an unlisted card is one the guard is blind
  // to, so the enrolment is half the fix.
  const pMaster = paramSpec(attenumixDef, 'master');


  // Ports — generated channel-by-channel so source order reads L→R per
  // channel (in1, cv1, out1, …). PatchPanel groups by cable type for
  // display, so this explicit ordering is just for readability here.
  const inputs = portsFromDef(attenumixDef.inputs, {
    in1: 'IN 1', in2: 'IN 2', in3: 'IN 3', in4: 'IN 4', cv1: 'CV 1', cv2: 'CV 2',
    cv3: 'CV 3', cv4: 'CV 4',
  });
  const outputs = portsFromDef(attenumixDef.outputs, {
    out1: 'OUT 1', out2: 'OUT 2', out3: 'OUT 3', out4: 'OUT 4',
  });

  // The channel strips, DERIVED from the def's own attenuator params rather
  // than written down — so "how many channels" is never a literal anybody has
  // to keep in step with the def (CLAUDE.md: never hand-type a population
  // count), and each strip carries its own ParamDef.
  const channels = attenumixDef.params.filter((p) => /^att\d+$/.test(p.id));
</script>

<div class="mod-card attenumix-card">
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <ModuleTitle {id} {data} defaultLabel="ATTENUMIX" />

  <PatchPanel nodeId={id} {inputs} {outputs} panelWidth={300}>
    <div class="body">
      <div class="strips">
        {#each channels as p (p.id)}
          <div class="strip">
            <NeonFader
              value={paramVal(p.id, p.defaultValue)}
              min={p.min} max={p.max} defaultValue={p.defaultValue}
              label={p.label ?? p.id}
              curve={p.curve}
              onchange={set(p.id)} moduleId={id} paramId={p.id}
              readLive={live(p.id)}
            />
          </div>
        {/each}
        <div class="strip master">
          <NeonFader
            value={paramVal(pMaster.id, pMaster.defaultValue)}
            min={pMaster.min} max={pMaster.max} defaultValue={pMaster.defaultValue}
            label={pMaster.label ?? pMaster.id}
            curve={pMaster.curve}
            onchange={set(pMaster.id)} moduleId={id} paramId={pMaster.id}
            readLive={live(pMaster.id)}
          />
        </div>
      </div>
    </div>
  </PatchPanel>
</div>

<style>
  .attenumix-card { width: 300px; }
  .attenumix-card .body { padding: 12px 14px 0; }
  .attenumix-card .strips {
    display: flex;
    gap: 8px;
    justify-content: space-between;
    align-items: flex-start;
  }
  .attenumix-card .strip {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
  }
  /* Visually offset the master strip — a subtle divider so users see at
     a glance which fader is per-channel vs. global. */
  .attenumix-card .strip.master {
    padding-left: 8px;
    margin-left: 4px;
    border-left: 1px solid var(--border-dim, #333);
  }
</style>
