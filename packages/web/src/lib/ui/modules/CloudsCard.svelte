<script lang="ts">
  // CloudsCard — granular texture processor (Mutable Instruments Clouds-style).
  // Six faders for the granular macros + a FREEZE toggle button.
  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import OssAttribution from '$lib/ui/modules/OssAttribution.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import { cloudsDef } from '$lib/audio/modules/clouds';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  const defaultFor = (key: string): number =>
    cloudsDef.params.find((p) => p.id === key)!.defaultValue;

  let position = $derived(node?.params.position ?? defaultFor('position'));
  let size     = $derived(node?.params.size     ?? defaultFor('size'));
  let pitch    = $derived(node?.params.pitch    ?? defaultFor('pitch'));
  let density  = $derived(node?.params.density  ?? defaultFor('density'));
  let texture  = $derived(node?.params.texture  ?? defaultFor('texture'));
  let blend    = $derived(node?.params.blend    ?? defaultFor('blend'));
  let freeze   = $derived(node?.params.freeze   ?? defaultFor('freeze'));

  const set = (k: string) => (v: number) => { const t = patch.nodes[id]; if (t) t.params[k] = v; };
  const live = (k: string) => () => {
    const e = engineCtx.get(); if (!e || !node) return undefined;
    return e.readParam(node, k);
  };

  const toggleFreeze = (): void => {
    const t = patch.nodes[id];
    if (!t) return;
    const next = (t.params.freeze ?? 0) >= 0.5 ? 0 : 1;
    t.params.freeze = next;
    const e = engineCtx.get();
    if (e && node) e.setParam(node, 'freeze', next);
  };

  const inputs: PortDescriptor[] = [
    { id: 'in_l',        label: 'IN L', cable: 'audio' },
    { id: 'in_r',        label: 'IN R', cable: 'audio' },
    { id: 'pitch',       label: 'V/OCT', cable: 'pitch' },
    { id: 'freeze_gate', label: 'FRZ',  cable: 'gate' },
    { id: 'position_cv', label: 'POS',  cable: 'cv' },
    { id: 'size_cv',     label: 'SIZE', cable: 'cv' },
    { id: 'pitch_cv',    label: 'PTCH', cable: 'cv' },
    { id: 'density_cv',  label: 'DENS', cable: 'cv' },
    { id: 'texture_cv',  label: 'TEXT', cable: 'cv' },
    { id: 'blend_cv',    label: 'BLND', cable: 'cv' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'out_l', label: 'OUT L', cable: 'audio' },
    { id: 'out_r', label: 'OUT R', cable: 'audio' },
  ];

  let frozen = $derived(freeze >= 0.5);
</script>

<div class="mod-card clouds-card">
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <header class="title">CLOUDS</header>

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="fader-row">
      <Fader value={position} min={0}   max={1}  defaultValue={0.5} label="Position" curve="linear" onchange={set('position')} readLive={live('position')} />
      <Fader value={size}     min={0}   max={1}  defaultValue={0.5} label="Size"     curve="linear" onchange={set('size')}     readLive={live('size')} />
      <Fader value={pitch}    min={-24} max={24} defaultValue={0}   label="Pitch" units="st" curve="linear" onchange={set('pitch')}    readLive={live('pitch')} />
      <Fader value={density}  min={0}   max={1}  defaultValue={0.5} label="Density"  curve="linear" onchange={set('density')}  readLive={live('density')} />
      <Fader value={texture}  min={0}   max={1}  defaultValue={0.5} label="Texture"  curve="linear" onchange={set('texture')}  readLive={live('texture')} />
      <Fader value={blend}    min={0}   max={1}  defaultValue={0.5} label="Blend"    curve="linear" onchange={set('blend')}    readLive={live('blend')} />
    </div>
    <div class="freeze-row">
      <button
        type="button"
        class="freeze-btn"
        class:active={frozen}
        data-testid="clouds-freeze"
        onclick={toggleFreeze}
      >
        FREEZE {frozen ? '●' : '○'}
      </button>
    </div>
  </PatchPanel>
  <OssAttribution author={cloudsDef.ossAttribution?.author} />
</div>

<style>
  .clouds-card { width: 340px; min-height: 240px; }
  .clouds-card .title {
    font-family: var(--font-display, inherit);
    font-size: 0.85rem;
    letter-spacing: 0.04em;
  }
  .clouds-card .fader-row {
    margin-top: 10px;
    display: flex;
    justify-content: center;
    gap: 10px;
    padding: 0 14px;
  }
  .clouds-card .freeze-row {
    margin-top: 10px;
    display: flex;
    justify-content: center;
  }
  .clouds-card .freeze-btn {
    background: var(--surface-2, #222);
    color: var(--text-strong, #ddd);
    border: 1px solid var(--border, #444);
    border-radius: 3px;
    padding: 4px 14px;
    font-family: var(--font-display, inherit);
    font-size: 0.7rem;
    letter-spacing: 0.08em;
    cursor: pointer;
    transition: background 80ms, color 80ms, border-color 80ms;
  }
  .clouds-card .freeze-btn:hover {
    border-color: var(--accent, #88f);
  }
  .clouds-card .freeze-btn.active {
    background: var(--accent, #88f);
    color: var(--surface-0, #000);
    border-color: var(--accent, #88f);
  }
</style>
