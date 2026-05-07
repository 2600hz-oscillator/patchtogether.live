<script lang="ts">
  import { Handle, Position, type NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import { patch } from '$lib/graph/store';
  import { analogVcoDef } from '$lib/audio/modules/analog-vco';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);

  const engineCtx = useEngine();

  let tune = $derived(node?.params.tune ?? analogVcoDef.params[0]!.defaultValue);
  let fine = $derived(node?.params.fine ?? analogVcoDef.params[1]!.defaultValue);
  let fmAmount = $derived(node?.params.fmAmount ?? analogVcoDef.params[2]!.defaultValue);
  let pw = $derived(node?.params.pw ?? analogVcoDef.params[3]!.defaultValue);

  function setParam(paramId: string) {
    return (v: number) => {
      const target = patch.nodes[id];
      if (target) target.params[paramId] = v;
    };
  }
  function readLive(paramId: string) {
    return () => {
      const eng = engineCtx.get();
      if (!eng || !node) return undefined;
      return eng.readParam(node, paramId);
    };
  }
</script>

<div class="card">
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <header class="title">Analog VCO</header>

  <Handle type="target" position={Position.Left} id="pitch" style="top: 56px; --handle-color: var(--cable-pitch);" />
  <Handle type="target" position={Position.Left} id="fm"    style="top: 92px; --handle-color: var(--cable-audio);" />
  <span class="port-label left" style="top: 50px;">pitch</span>
  <span class="port-label left" style="top: 86px;">fm</span>

  <Handle type="source" position={Position.Right} id="saw"      style="top: 56px;  --handle-color: var(--cable-audio);" />
  <Handle type="source" position={Position.Right} id="square"   style="top: 92px;  --handle-color: var(--cable-audio);" />
  <Handle type="source" position={Position.Right} id="triangle" style="top: 128px; --handle-color: var(--cable-audio);" />
  <Handle type="source" position={Position.Right} id="sine"     style="top: 164px; --handle-color: var(--cable-audio);" />
  <span class="port-label right" style="top: 50px;">saw</span>
  <span class="port-label right" style="top: 86px;">sqr</span>
  <span class="port-label right" style="top: 122px;">tri</span>
  <span class="port-label right" style="top: 158px;">sin</span>

  <div class="fader-row">
    <Fader value={tune}     min={-36} max={36}  defaultValue={0}   label="Tune" units="st" curve="linear" onchange={setParam('tune')}     readLive={readLive('tune')} />
    <Fader value={fine}     min={-100} max={100} defaultValue={0}  label="Fine" units="¢"  curve="linear" onchange={setParam('fine')}     readLive={readLive('fine')} />
    <Fader value={fmAmount} min={0}  max={1}    defaultValue={0}   label="FM"              curve="linear" onchange={setParam('fmAmount')} readLive={readLive('fmAmount')} />
    <Fader value={pw}       min={0.05} max={0.95} defaultValue={0.5} label="PW"            curve="linear" onchange={setParam('pw')}       readLive={readLive('pw')} />
  </div>
</div>

<style>
  .card {
    width: 240px;
    min-height: 230px;
    background: var(--module-bg);
    border: 1px solid #2a2f3a;
    border-radius: 2px;
    color: var(--text);
    padding-top: 18px;
    padding-bottom: 14px;
    position: relative;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    transition: border-color 80ms ease-out, box-shadow 80ms ease-out;
  }
  :global(.svelte-flow__node:hover) .card {
    border-color: var(--accent-dim);
  }
  :global(.svelte-flow__node.selected) .card {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent-glow), 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  .stripe {
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    border-radius: 2px 2px 0 0;
  }
  .title {
    font-size: 0.85rem;
    font-weight: 500;
    text-align: center;
    margin: 0 0 8px;
    letter-spacing: 0.02em;
  }
  .port-label {
    position: absolute;
    font-size: 0.6rem;
    color: var(--text-dim);
    pointer-events: none;
    font-family: ui-monospace, monospace;
  }
  .port-label.left  { left: 14px; }
  .port-label.right { right: 14px; }
  .fader-row {
    margin-top: 28px;
    display: flex;
    gap: 6px;
    padding: 0 30px;
    justify-content: space-between;
  }
  /* Note: app-wide Svelte Flow handle styling lives in routes/global.css. */
</style>
