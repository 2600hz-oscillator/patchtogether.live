<script lang="ts">
  import { Handle, Position, type NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import { patch } from '$lib/graph/store';
  import { lfoDef } from '$lib/audio/modules/lfo';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  let rate  = $derived(node?.params.rate  ?? lfoDef.params[0]!.defaultValue);
  let shape = $derived(node?.params.shape ?? lfoDef.params[1]!.defaultValue);

  const set = (id_: string) => (v: number) => { const t = patch.nodes[id]; if (t) t.params[id_] = v; };
  const live = (id_: string) => () => { const e = engineCtx.get(); if (!e || !node) return undefined; return e.readParam(node, id_); };

  // shape param is 0..2: 0=sine, 1=saw, 2=square. Glyphs anchor at the
  // morph-source fractions so the user can see what each end of the slider
  // crossfades into.
  const SHAPE_GLYPHS: Array<{ frac: number; kind: 'sine' | 'tri' | 'saw' | 'square' }> = [
    { frac: 0,   kind: 'sine'   },
    { frac: 0.5, kind: 'saw'    },
    { frac: 1,   kind: 'square' },
  ];
</script>

<div class="mod-card lfo-card">
  <div class="stripe" style="background: var(--cable-cv);"></div>
  <header class="title">LFO</header>

  <Handle type="target" position={Position.Left} id="clock" style="top: 56px;  --handle-color: var(--cable-gate);" />
  <Handle type="target" position={Position.Left} id="rate"  style="top: 92px;  --handle-color: var(--cable-cv);" />
  <Handle type="target" position={Position.Left} id="shape" style="top: 128px; --handle-color: var(--cable-cv);" />
  <span class="port-label left" style="top: 50px;">clk</span>
  <span class="port-label left" style="top: 86px;">rate</span>
  <span class="port-label left" style="top: 122px;">shape</span>

  <Handle type="source" position={Position.Right} id="phase0"   style="top: 56px;  --handle-color: var(--cable-cv);" />
  <Handle type="source" position={Position.Right} id="phase90"  style="top: 92px;  --handle-color: var(--cable-cv);" />
  <Handle type="source" position={Position.Right} id="phase180" style="top: 128px; --handle-color: var(--cable-cv);" />
  <Handle type="source" position={Position.Right} id="phase270" style="top: 164px; --handle-color: var(--cable-cv);" />
  <span class="port-label right" style="top: 50px;">0°</span>
  <span class="port-label right" style="top: 86px;">90°</span>
  <span class="port-label right" style="top: 122px;">180°</span>
  <span class="port-label right" style="top: 158px;">270°</span>

  <div class="fader-row">
    <Fader value={rate}  min={0.01} max={100} defaultValue={1} label="Rate"  units="Hz" curve="log"    onchange={set('rate')}  readLive={live('rate')} />
    <Fader value={shape} min={0}    max={2}   defaultValue={0} label="Shape"            curve="linear" onchange={set('shape')} readLive={live('shape')} glyphs={SHAPE_GLYPHS} />
  </div>
</div>

<style>
  .lfo-card { width: 200px; min-height: 240px; }
  .lfo-card .fader-row { padding: 0 30px; margin-top: 60px; gap: 12px; }
</style>
