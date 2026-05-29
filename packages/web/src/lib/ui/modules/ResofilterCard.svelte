<script lang="ts">
  // ResofilterCard — multi-mode filter UI (Resonarium MultiFilter port).
  //
  // Layout:
  //   [ CUTOFF ]  [ RESO ]   [ MODE ]    [ MIX ]
  //                          ◐ "Low-pass"
  //                          ↑ the user-requested feature: a text label
  //                          next to the MODE knob displays the long-form
  //                          name of the currently selected mode and
  //                          updates reactively as the knob (or its CV /
  //                          MIDI Learn target) changes.
  //
  // Patch panel:
  //   inputs: AUDIO, CUTOFF, RESO
  //   outputs: L, R

  import type { NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import OssAttribution from '$lib/ui/modules/OssAttribution.svelte';
  import ModuleTitle from './ModuleTitle.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import {
    resofilterDef,
    RESOFILTER_MODE_NAMES,
    RESOFILTER_MAX_MODE,
    type ResofilterMode,
  } from '$lib/audio/modules/resofilter';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  const defaultFor = (pid: string): number =>
    resofilterDef.params.find((p) => p.id === pid)!.defaultValue;

  function paramVal(k: string): number {
    const v = node?.params?.[k];
    return typeof v === 'number' ? v : defaultFor(k);
  }

  const set = (pid: string) => (v: number) => {
    const t = patch.nodes[id]; if (t) t.params[pid] = v;
  };
  const live = (pid: string) => () => {
    const e = engineCtx.get(); if (!e || !node) return undefined;
    return e.readParam(node, pid);
  };

  function clampMode(v: number): ResofilterMode {
    const r = Math.round(v);
    if (r < 0) return 0;
    if (r > RESOFILTER_MAX_MODE) return RESOFILTER_MAX_MODE as ResofilterMode;
    return r as ResofilterMode;
  }

  // The mode-name label — the headline feature of this card. Tracks the
  // live `mode` param value (whether set by the user, CV, or MIDI Learn).
  let modeIdx = $derived(clampMode(paramVal('mode')));
  let modeName = $derived(RESOFILTER_MODE_NAMES[modeIdx]);

  const inputs: PortDescriptor[] = [
    { id: 'audio',     label: 'AUDIO',  cable: 'audio' },
    { id: 'cutoff_cv', label: 'CUTOFF', cable: 'cv' },
    { id: 'reso_cv',   label: 'RESO',   cable: 'cv' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'out_l', label: 'OUT L', cable: 'audio' },
    { id: 'out_r', label: 'OUT R', cable: 'audio' },
  ];
</script>

<div class="mod-card resofilter-card">
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <ModuleTitle {id} {data} defaultLabel="RESOFILTER" />

  <PatchPanel nodeId={id} {inputs} {outputs} panelWidth={340}>
    <div class="rf-body">
      <div class="knobs">
        <Knob
          value={paramVal('cutoff')}
          min={resofilterDef.params.find((p) => p.id === 'cutoff')!.min}
          max={resofilterDef.params.find((p) => p.id === 'cutoff')!.max}
          defaultValue={defaultFor('cutoff')}
          label="Cutoff"
          units="Hz"
          curve="log"
          onchange={set('cutoff')}
          moduleId={id}
          paramId="cutoff"
          readLive={live('cutoff')}
        />
        <Knob
          value={paramVal('resonance')}
          min={0}
          max={1}
          defaultValue={defaultFor('resonance')}
          label="Reso"
          curve="linear"
          onchange={set('resonance')}
          moduleId={id}
          paramId="resonance"
          readLive={live('resonance')}
        />
        <div class="mode-group" data-testid="resofilter-mode-group">
          <Knob
            value={paramVal('mode')}
            min={0}
            max={RESOFILTER_MAX_MODE}
            defaultValue={defaultFor('mode')}
            label="Mode"
            curve="linear"
            onchange={set('mode')}
            moduleId={id}
            paramId="mode"
            readLive={live('mode')}
          />
          <div class="mode-name" data-testid="resofilter-mode-name">{modeName}</div>
        </div>
        <Knob
          value={paramVal('mix')}
          min={0}
          max={1}
          defaultValue={defaultFor('mix')}
          label="Mix"
          curve="linear"
          onchange={set('mix')}
          moduleId={id}
          paramId="mix"
          readLive={live('mix')}
        />
      </div>
    </div>
  </PatchPanel>

  <OssAttribution text="Multi-mode filter ported from gabrielsoule/resonarium (MultiFilter)" />
</div>

<style>
  .resofilter-card {
    width: 340px;
    min-height: 200px;
    background: var(--resofilter-bg, #16181f);
    color: #ece8e2;
  }
  .rf-body {
    padding: 6px 10px 4px;
  }
  .knobs {
    display: flex;
    gap: 14px;
    align-items: flex-end;
    justify-content: space-between;
  }
  .mode-group {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    /* Make sure the name label is roomy enough for "Band-pass" / "High-pass". */
    min-width: 72px;
  }
  .mode-name {
    font-family: var(--font-mono, monospace);
    font-size: 0.62rem;
    letter-spacing: 0.02em;
    color: #ffce6e;
    text-align: center;
    /* The label is the headline feature — keep it visible even when the
       card is narrow. ellipsizes only on truly extreme overflow. */
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100%;
  }
</style>
