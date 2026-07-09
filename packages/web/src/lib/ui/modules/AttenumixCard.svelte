<script lang="ts">
  // AttenumixCard — the simple mixer. 4 channel strips, each with an
  // attenuator fader; a single MASTER fader at the right. Audio + CV
  // inputs and per-channel direct outs live on the PatchPanel; the MIX
  // output is the last port at the bottom of the outputs column.
  //
  // PatchPanel pattern (a quad-channel fader layout stripped of the
  // response toggle — ATTENUMIX is the no-extra-controls mixer).
  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { attenumixDef } from '$lib/audio/modules/attenumix';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { cardParams, portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const { defaultFor, paramVal, set, live } = cardParams(attenumixDef, () => id, () => node);


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

  const channels = [1, 2, 3, 4] as const;
</script>

<div class="mod-card attenumix-card">
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <ModuleTitle {id} {data} defaultLabel="ATTENUMIX" />

  <PatchPanel nodeId={id} {inputs} {outputs} panelWidth={300}>
    <div class="body">
      <div class="strips">
        {#each channels as ch (ch)}
          <div class="strip">
            <Fader
              value={paramVal(`att${ch}`, 0)}
              min={0} max={1} defaultValue={defaultFor(`att${ch}`)}
              label={`Att ${ch}`}
              curve="linear"
              onchange={set(`att${ch}`)} moduleId={id} paramId={`att${ch}`}
              readLive={live(`att${ch}`)}
            />
          </div>
        {/each}
        <div class="strip master">
          <Fader
            value={paramVal('master', 1.0)}
            min={0} max={2} defaultValue={defaultFor('master')}
            label="Master"
            curve="linear"
            onchange={set('master')} moduleId={id} paramId="master"
            readLive={live('master')}
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
