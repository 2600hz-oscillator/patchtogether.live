<script lang="ts">
  // CloudsCard — granular texture processor (Mutable Instruments Clouds-style).
  // Six faders for the granular macros + a FREEZE toggle button.
  import type { NodeProps } from '@xyflow/svelte';
  import NeonFader from '$lib/ui/controls/NeonFader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import OssAttribution from '$lib/ui/modules/OssAttribution.svelte';
  import { patch } from '$lib/graph/store';
  import { cloudsDef } from '$lib/audio/modules/clouds';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { cardParams, paramSpec, portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const { set, live, engineCtx } = cardParams(cloudsDef, () => id, () => node);

  // ── RANGES COME FROM THE DEF, NEVER RE-TYPED ────────────────────────────
  // The backdraft class (CLAUDE.md): every gate we own reads the DEF, so a card
  // restating its def's numbers can disagree with it and NOTHING can see that.
  // This card is enrolled in RANGE_BOUND_CARDS + MAPPING_BOUND_CARDS
  // (card-range-source.test.ts), which is an opt-in list — an unlisted card is
  // one the guard is blind to, so the enrolment is half the fix.
  const pPosition = paramSpec(cloudsDef, 'position');
  const pSize = paramSpec(cloudsDef, 'size');
  const pPitch = paramSpec(cloudsDef, 'pitch');
  const pDensity = paramSpec(cloudsDef, 'density');
  const pTexture = paramSpec(cloudsDef, 'texture');
  const pBlend = paramSpec(cloudsDef, 'blend');

  const defaultFor = (key: string): number =>
    cloudsDef.params.find((p) => p.id === key)!.defaultValue;

  let position = $derived(node?.params.position ?? pPosition.defaultValue);
  let size     = $derived(node?.params.size     ?? pSize.defaultValue);
  let pitch    = $derived(node?.params.pitch    ?? pPitch.defaultValue);
  let density  = $derived(node?.params.density  ?? pDensity.defaultValue);
  let texture  = $derived(node?.params.texture  ?? pTexture.defaultValue);
  let blend    = $derived(node?.params.blend    ?? pBlend.defaultValue);
  let freeze   = $derived(node?.params.freeze   ?? defaultFor('freeze'));


  const toggleFreeze = (): void => {
    const t = patch.nodes[id];
    if (!t) return;
    const next = (t.params.freeze ?? 0) >= 0.5 ? 0 : 1;
    t.params.freeze = next;
    const e = engineCtx.get();
    if (e && node) e.setParam(node, 'freeze', next);
  };

  const inputs = portsFromDef(cloudsDef.inputs, {
    in_l: 'IN L', in_r: 'IN R', pitch: 'V/OCT', freeze_gate: 'FRZ', position_cv: 'POS',
    size_cv: 'SIZE', pitch_cv: 'PTCH', density_cv: 'DENS', texture_cv: 'TEXT',
    blend_cv: 'BLND',
  });
  const outputs = portsFromDef(cloudsDef.outputs, { out_l: 'OUT L', out_r: 'OUT R' });

  let frozen = $derived(freeze >= 0.5);
</script>

<div class="mod-card clouds-card">
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <ModuleTitle {id} {data} defaultLabel="CLOUDS" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="fader-row">
      <NeonFader value={position} min={pPosition.min} max={pPosition.max} defaultValue={pPosition.defaultValue} label="Position" curve={pPosition.curve} units={pPosition.units} onchange={set('position')} moduleId={id} paramId="position" readLive={live('position')} />
      <NeonFader value={size}     min={pSize.min}     max={pSize.max}     defaultValue={pSize.defaultValue}     label="Size"     curve={pSize.curve}     units={pSize.units}     onchange={set('size')} moduleId={id} paramId="size"     readLive={live('size')} />
      <NeonFader value={pitch}    min={pPitch.min}    max={pPitch.max}    defaultValue={pPitch.defaultValue}    label="Pitch"    curve={pPitch.curve}    units={pPitch.units}    onchange={set('pitch')} moduleId={id} paramId="pitch"    readLive={live('pitch')} />
      <NeonFader value={density}  min={pDensity.min}  max={pDensity.max}  defaultValue={pDensity.defaultValue}  label="Density"  curve={pDensity.curve}  units={pDensity.units}  onchange={set('density')} moduleId={id} paramId="density"  readLive={live('density')} />
      <NeonFader value={texture}  min={pTexture.min}  max={pTexture.max}  defaultValue={pTexture.defaultValue}  label="Texture"  curve={pTexture.curve}  units={pTexture.units}  onchange={set('texture')} moduleId={id} paramId="texture"  readLive={live('texture')} />
      <NeonFader value={blend}    min={pBlend.min}    max={pBlend.max}    defaultValue={pBlend.defaultValue}    label="Blend"    curve={pBlend.curve}    units={pBlend.units}    onchange={set('blend')} moduleId={id} paramId="blend"    readLive={live('blend')} />
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
  .clouds-card { width: 340px; }  .clouds-card .fader-row {
    /* Rack-compaction (#759): tighter top margin to fit 1u. */
    margin-top: 4px;
    display: flex;
    justify-content: center;
    gap: 10px;
    padding: 0 14px;
  }
  .clouds-card .freeze-row {
    margin-top: 3px;
    display: flex;
    justify-content: center;
  }
  .clouds-card .freeze-btn {
    background: var(--surface-2, #222);
    color: var(--text-strong, #ddd);
    border: 1px solid var(--border, #444);
    border-radius: 3px;
    padding: 3px 14px;
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
