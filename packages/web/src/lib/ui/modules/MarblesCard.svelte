<script lang="ts">
  // MarblesCard — random sampler / clock generator (Mutable Instruments
  // Marbles port). T-section gate models + X-section quantized-CV faders.
  //
  // ⚠ EVERY RANGE, MAPPING AND LABEL COMES FROM THE DEF (`paramSpec`), never
  // re-typed here. It
  // used to carry NINE literal `min=`/`max=` pairs — the backdraft class in its
  // latent form (a card that disagrees with its own def is invisible to
  // `contract-lock`, `module-docs-lint` and every range assertion, because all
  // three read the DEF). Enrolled in RANGE_BOUND_CARDS + MAPPING_BOUND_CARDS so
  // the binding is what a gate now certifies.
  //
  // ⚠ AND IT WAS MISSING TWO CONTROLS. `pw_mean` and `x_deja_vu` are declared
  // params with CV inputs and no card affordance at all, so under
  // `?shell=legacy` two of the module's thirteen controls were unreachable —
  // including X DÉJÀ VU, which is half of the module's headline feature. Both
  // are added here. (marbles is in EXEMPT_FROM_VRT, so no baseline moves.)
  import type { NodeProps } from '@xyflow/svelte';
  import NeonFader from '$lib/ui/controls/NeonFader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import OssAttribution from '$lib/ui/modules/OssAttribution.svelte';
  import { patch } from '$lib/graph/store';
  import { marblesDef, MARBLES_T_MODEL_NAMES, MARBLES_SCALE_NAMES } from '$lib/audio/modules/marbles';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { cardParams, paramSpec, portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const { set, live } = cardParams(marblesDef, () => id, () => node);

  const defaultFor = (k: string): number =>
    marblesDef.params.find((p) => p.id === k)!.defaultValue;
  const paramVal = (k: string): number => node?.params?.[k] ?? defaultFor(k);

  const pRate = paramSpec(marblesDef, 'rate');
  const pTBias = paramSpec(marblesDef, 't_bias');
  const pTJitter = paramSpec(marblesDef, 't_jitter');
  const pDejaVu = paramSpec(marblesDef, 'deja_vu');
  const pLength = paramSpec(marblesDef, 'length');
  const pPwMean = paramSpec(marblesDef, 'pw_mean');
  const pSpread = paramSpec(marblesDef, 'spread');
  const pXBias = paramSpec(marblesDef, 'x_bias');
  const pSteps = paramSpec(marblesDef, 'steps');
  const pXDejaVu = paramSpec(marblesDef, 'x_deja_vu');
  const pXLength = paramSpec(marblesDef, 'x_length');

  let tModel = $derived(paramVal('t_model'));
  let scale = $derived(paramVal('scale'));

  const MAX_T = MARBLES_T_MODEL_NAMES.length - 1;
  const MAX_SCALE = MARBLES_SCALE_NAMES.length - 1;
  const clampI = (v: number, max: number) => Math.max(0, Math.min(max, Math.round(v)));
  let tModelLabel = $derived(MARBLES_T_MODEL_NAMES[clampI(tModel, MAX_T)]);
  let scaleLabel = $derived(MARBLES_SCALE_NAMES[clampI(scale, MAX_SCALE)]);

  function cycleTModel(): void {
    const t = patch.nodes[id]; if (t) t.params.t_model = (clampI(tModel, MAX_T) + 1) % (MAX_T + 1);
  }
  function cycleScale(): void {
    const t = patch.nodes[id]; if (t) t.params.scale = (clampI(scale, MAX_SCALE) + 1) % (MAX_SCALE + 1);
  }

  const inputs = portsFromDef(marblesDef.inputs);
  const outputs = portsFromDef(marblesDef.outputs);
</script>

<div class="mod-card marbles-card">
  <div class="stripe" style="background: var(--cable-cv);"></div>
  <ModuleTitle {id} {data} defaultLabel="MARBLES" />
  <div class="btn-row">
    <button type="button" class="sel-btn" data-testid="marbles-tmodel-btn" onclick={cycleTModel}>
      <span class="sel-label">T</span>
      <span class="sel-value" data-testid="marbles-tmodel-name">{tModelLabel}</span>
    </button>
    <button type="button" class="sel-btn" data-testid="marbles-scale-btn" onclick={cycleScale}>
      <span class="sel-label">Scale</span>
      <span class="sel-value" data-testid="marbles-scale-name">{scaleLabel}</span>
    </button>
  </div>

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="fader-row">
      <NeonFader value={paramVal('rate')}      min={pRate.min}     max={pRate.max}     defaultValue={pRate.defaultValue}     label={pRate.label}     units={pRate.units ?? ''} curve={pRate.curve}     onchange={set('rate')}      moduleId={id} paramId="rate"      readLive={live('rate')} />
      <NeonFader value={paramVal('t_bias')}    min={pTBias.min}    max={pTBias.max}    defaultValue={pTBias.defaultValue}    label={pTBias.label}   curve={pTBias.curve}    onchange={set('t_bias')}    moduleId={id} paramId="t_bias"    readLive={live('t_bias')} />
      <NeonFader value={paramVal('t_jitter')}  min={pTJitter.min}  max={pTJitter.max}  defaultValue={pTJitter.defaultValue}  label={pTJitter.label}   curve={pTJitter.curve}  onchange={set('t_jitter')}  moduleId={id} paramId="t_jitter"  readLive={live('t_jitter')} />
      <!-- PWidth: the t1/t2 gate width, 5 % + 90 % × PW of the step. It was a
           declared param with a CV input and no card control at all. -->
      <NeonFader value={paramVal('pw_mean')}   min={pPwMean.min}   max={pPwMean.max}   defaultValue={pPwMean.defaultValue}   label={pPwMean.label}   curve={pPwMean.curve}   onchange={set('pw_mean')}   moduleId={id} paramId="pw_mean"   readLive={live('pw_mean')} />
      <NeonFader value={paramVal('deja_vu')}   min={pDejaVu.min}   max={pDejaVu.max}   defaultValue={pDejaVu.defaultValue}   label={pDejaVu.label}  curve={pDejaVu.curve}   onchange={set('deja_vu')}   moduleId={id} paramId="deja_vu"   readLive={live('deja_vu')} />
      <!-- The mapping is BOUND, not re-typed: the def declares both loop
           lengths discrete, and this card used to hand-type the linear form,
           which let the fader commit 8.37 into a param the engine then floors —
           the dial's position and the value it stored disagreed by up to half a
           step. `card-range-source` greps the SOURCE for that literal, so the
           previous wording of this very comment failed the gate. -->
      <NeonFader value={paramVal('length')}    min={pLength.min}   max={pLength.max}   defaultValue={pLength.defaultValue}   label={pLength.label}   curve={pLength.curve}   onchange={set('length')}    moduleId={id} paramId="length"    readLive={live('length')} />
      <NeonFader value={paramVal('spread')}    min={pSpread.min}   max={pSpread.max}   defaultValue={pSpread.defaultValue}   label={pSpread.label}   curve={pSpread.curve}   onchange={set('spread')}    moduleId={id} paramId="spread"    readLive={live('spread')} />
      <NeonFader value={paramVal('x_bias')}    min={pXBias.min}    max={pXBias.max}    defaultValue={pXBias.defaultValue}    label={pXBias.label}   curve={pXBias.curve}    onchange={set('x_bias')}    moduleId={id} paramId="x_bias"    readLive={live('x_bias')} />
      <NeonFader value={paramVal('steps')}     min={pSteps.min}    max={pSteps.max}    defaultValue={pSteps.defaultValue}    label={pSteps.label}    curve={pSteps.curve}    onchange={set('steps')}     moduleId={id} paramId="steps"     readLive={live('steps')} />
      <!-- X Déjà Vu: the X half of the module's headline control, and the
           second param that had no card affordance. -->
      <NeonFader value={paramVal('x_deja_vu')} min={pXDejaVu.min}  max={pXDejaVu.max}  defaultValue={pXDejaVu.defaultValue}  label={pXDejaVu.label}   curve={pXDejaVu.curve}  onchange={set('x_deja_vu')} moduleId={id} paramId="x_deja_vu" readLive={live('x_deja_vu')} />
      <NeonFader value={paramVal('x_length')}  min={pXLength.min}  max={pXLength.max}  defaultValue={pXLength.defaultValue}  label={pXLength.label}    curve={pXLength.curve}  onchange={set('x_length')}  moduleId={id} paramId="x_length"  readLive={live('x_length')} />
    </div>
  </PatchPanel>
  <OssAttribution author={marblesDef.ossAttribution?.author} />
</div>

<style>
  .marbles-card { width: 420px; }  /* Rack-compaction (#759): tighter btn-row margin to fit 1u. */
  .marbles-card .btn-row { display: flex; gap: 8px; margin: 1px 12px 2px; }
  .marbles-card .sel-btn {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    flex: 1;
    border: 1px solid var(--border, #555);
    background: var(--bg-elevated, #1a1a1a);
    color: var(--text, #eee);
    padding: 3px 10px;
    font-family: var(--font-display, monospace);
    font-size: 0.7rem;
    letter-spacing: 0.06em;
    cursor: pointer;
  }
  .marbles-card .sel-btn:hover { background: var(--bg-hover, #2a2a2a); }
  .marbles-card .sel-label { color: var(--text-muted, #999); }
  .marbles-card .sel-value { color: var(--text, #eee); font-weight: 600; }
  .marbles-card .fader-row {
    /* Rack-compaction (#759): tighter top margin to fit 1u. */
    margin-top: 3px;
    display: flex;
    justify-content: center;
    gap: 6px;
    padding: 0 12px;
    flex-wrap: wrap;
  }
</style>
