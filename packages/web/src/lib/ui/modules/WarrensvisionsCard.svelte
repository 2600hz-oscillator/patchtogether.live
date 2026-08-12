<script lang="ts">
  // WarrensvisionsCard — the 2D spectral video resynthesizer.
  //
  // The preview sits BESIDE the controls rather than above a tall column of
  // them: this module has an obvious hero visual and the whole point of every
  // knob is what it does to that picture. Two columns — screen left, controls
  // right — with COHERENCE given its own row at the top because it is the
  // control that decides what the module IS.
  //
  // Every range comes from `paramSpec(warrensvisionsDef, …)`. Nothing on this
  // card re-types a number the def already declares, so the card cannot drift
  // from the contract the way BackdraftCard's XyPads did.

  import type { NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { warrensvisionsDef } from '$lib/video/modules/warrensvisions';
  import { useEngine } from '$lib/audio/engine-context';
  import type { VideoEngine } from '$lib/video/engine';
  import { VIDEO_RES } from '$lib/video/video-res';
  import type { ModuleNode } from '$lib/graph/types';
  import { onMount, onDestroy } from 'svelte';
  import ModuleTitle from './ModuleTitle.svelte';
  import { cardParams, portsFromDef, paramSpec } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  const { defaultFor, paramVal, set } = cardParams(warrensvisionsDef, () => id, () => node);
  const spec = (p: string) => paramSpec(warrensvisionsDef, p);

  // ---- on-card preview: blit the module's own output ----
  const ENGINE_W = VIDEO_RES.width;
  const ENGINE_H = VIDEO_RES.height;
  let canvasEl: HTMLCanvasElement | null = $state(null);
  let drawRaf: number | null = null;

  function fitRect(cw: number, ch: number): { x: number; y: number; w: number; h: number } {
    const srcAspect = ENGINE_W / ENGINE_H;
    const dstAspect = cw / ch;
    if (dstAspect > srcAspect) {
      const h = ch;
      const w = Math.round(h * srcAspect);
      return { x: Math.round((cw - w) / 2), y: 0, w, h };
    }
    const w = cw;
    const h = Math.round(w / srcAspect);
    return { x: 0, y: Math.round((ch - h) / 2), w, h };
  }

  function draw(): void {
    drawRaf = null;
    const e = engineCtx.get();
    if (!e || !canvasEl) { drawRaf = requestAnimationFrame(draw); return; }
    let videoEngine: VideoEngine | undefined;
    try { videoEngine = e.getDomain<VideoEngine>('video'); } catch { drawRaf = requestAnimationFrame(draw); return; }
    if (!videoEngine) { drawRaf = requestAnimationFrame(draw); return; }
    const ctx2d = canvasEl.getContext('2d', { alpha: false });
    if (ctx2d) {
      try { videoEngine.blitOutputToDrawingBuffer(id); } catch { /* never nuke the loop */ }
      const src = videoEngine.canvas as CanvasImageSource;
      const cw = canvasEl.width;
      const ch = canvasEl.height;
      ctx2d.fillStyle = '#050608';
      ctx2d.fillRect(0, 0, cw, ch);
      const r = fitRect(cw, ch);
      ctx2d.drawImage(src, r.x, r.y, r.w, r.h);
    }
    drawRaf = requestAnimationFrame(draw);
  }

  onMount(() => {
    if (canvasEl) { canvasEl.width = 288; canvasEl.height = 216; }
    drawRaf = requestAnimationFrame(draw);
  });
  onDestroy(() => { if (drawRaf !== null) cancelAnimationFrame(drawRaf); });

  const inputs = portsFromDef(warrensvisionsDef.inputs, {
    video_in: 'IN',
    gate: 'FREEZE',
    components_cv: 'COMP',
    coherence_cv: 'COHR',
    residual_cv: 'RESID',
    shape_cv: 'SHAPE',
    center_cv: 'CENTER',
    drift_cv: 'DRIFT',
    mix_cv: 'MIX',
  });
  const outputs = portsFromDef(warrensvisionsDef.outputs);

  const frozen = $derived(paramVal('engineFreeze') >= 0.5);
  const freezeSpec = spec('engineFreeze');
</script>

<div class="mod-card warrensvisions-card" data-testid="warrensvisions-card" data-node-id={id}>
  <div class="stripe" style="background: var(--cable-video);"></div>
  <ModuleTitle {id} {data} defaultLabel="WARREN'S VISIONS" />

  <PatchPanel nodeId={id} {inputs} {outputs} panelWidth={128}>
    <div class="body">
      <div class="cols">
        <div class="left">
          <div class="screen-wrap">
            <canvas bind:this={canvasEl} class="screen" data-testid="warrensvisions-canvas"></canvas>
          </div>
          <div class="hero">
            <Knob
              value={paramVal('visionsCoherence')}
              min={spec('visionsCoherence').min}
              max={spec('visionsCoherence').max}
              defaultValue={defaultFor('visionsCoherence')}
              curve={spec('visionsCoherence').curve}
              label={spec('visionsCoherence').label}
              onchange={set('visionsCoherence')}
              moduleId={id}
              paramId="visionsCoherence"
            />
            <button
              type="button"
              class="freeze"
              class:on={frozen}
              data-testid="warrensvisions-freeze"
              aria-pressed={frozen}
              onclick={() => set('engineFreeze')(frozen ? freezeSpec.min : freezeSpec.max)}
            >{frozen ? 'FREEZE' : 'LIVE'}</button>
          </div>
        </div>

        <div class="grid">
<Knob
              value={paramVal('visionsComponents')}
              min={spec('visionsComponents').min}
              max={spec('visionsComponents').max}
              defaultValue={defaultFor('visionsComponents')}
              curve={spec('visionsComponents').curve}
              units={spec('visionsComponents').units}
              label={spec('visionsComponents').label}
              onchange={set('visionsComponents')}
              moduleId={id}
              paramId="visionsComponents"
            />
            <Knob
              value={paramVal('visionsFloor')}
              min={spec('visionsFloor').min}
              max={spec('visionsFloor').max}
              defaultValue={defaultFor('visionsFloor')}
              curve={spec('visionsFloor').curve}
              units={spec('visionsFloor').units}
              label={spec('visionsFloor').label}
              onchange={set('visionsFloor')}
              moduleId={id}
              paramId="visionsFloor"
            />
            <Knob
              value={paramVal('visionsStability')}
              min={spec('visionsStability').min}
              max={spec('visionsStability').max}
              defaultValue={defaultFor('visionsStability')}
              curve={spec('visionsStability').curve}
              units={spec('visionsStability').units}
              label={spec('visionsStability').label}
              onchange={set('visionsStability')}
              moduleId={id}
              paramId="visionsStability"
            />
            <Knob
              value={paramVal('visionsSlew')}
              min={spec('visionsSlew').min}
              max={spec('visionsSlew').max}
              defaultValue={defaultFor('visionsSlew')}
              curve={spec('visionsSlew').curve}
              units={spec('visionsSlew').units}
              label={spec('visionsSlew').label}
              onchange={set('visionsSlew')}
              moduleId={id}
              paramId="visionsSlew"
            />
            <Knob
              value={paramVal('visionsSlice')}
              min={spec('visionsSlice').min}
              max={spec('visionsSlice').max}
              defaultValue={defaultFor('visionsSlice')}
              curve={spec('visionsSlice').curve}
              units={spec('visionsSlice').units}
              label={spec('visionsSlice').label}
              onchange={set('visionsSlice')}
              moduleId={id}
              paramId="visionsSlice"
            />
            <Knob
              value={paramVal('visionsResidual')}
              min={spec('visionsResidual').min}
              max={spec('visionsResidual').max}
              defaultValue={defaultFor('visionsResidual')}
              curve={spec('visionsResidual').curve}
              units={spec('visionsResidual').units}
              label={spec('visionsResidual').label}
              onchange={set('visionsResidual')}
              moduleId={id}
              paramId="visionsResidual"
            />
            <Knob
              value={paramVal('visionsShape')}
              min={spec('visionsShape').min}
              max={spec('visionsShape').max}
              defaultValue={defaultFor('visionsShape')}
              curve={spec('visionsShape').curve}
              units={spec('visionsShape').units}
              label={spec('visionsShape').label}
              onchange={set('visionsShape')}
              moduleId={id}
              paramId="visionsShape"
            />
            <Knob
              value={paramVal('visionsCenter')}
              min={spec('visionsCenter').min}
              max={spec('visionsCenter').max}
              defaultValue={defaultFor('visionsCenter')}
              curve={spec('visionsCenter').curve}
              units={spec('visionsCenter').units}
              label={spec('visionsCenter').label}
              onchange={set('visionsCenter')}
              moduleId={id}
              paramId="visionsCenter"
            />
            <Knob
              value={paramVal('visionsDrift')}
              min={spec('visionsDrift').min}
              max={spec('visionsDrift').max}
              defaultValue={defaultFor('visionsDrift')}
              curve={spec('visionsDrift').curve}
              units={spec('visionsDrift').units}
              label={spec('visionsDrift').label}
              onchange={set('visionsDrift')}
              moduleId={id}
              paramId="visionsDrift"
            />
            <Knob
              value={paramVal('visionsMix')}
              min={spec('visionsMix').min}
              max={spec('visionsMix').max}
              defaultValue={defaultFor('visionsMix')}
              curve={spec('visionsMix').curve}
              units={spec('visionsMix').units}
              label={spec('visionsMix').label}
              onchange={set('visionsMix')}
              moduleId={id}
              paramId="visionsMix"
            />
        </div>
      </div>
    </div>
  </PatchPanel>
</div>

<style>
  .mod-card {
    /* The RACK TILE is the real size. `.svelte-flow__node.rack-sized > .mod-card`
     * in _module-card.css has specificity (0,3,0) and pins width to
     * `--rack-hp × --rack-unit`, which beats any `width:` declared here (0,1,0).
     * So this value is not a request — it must AGREE with the hp in
     * rack-sizes.ts (3 × 180px), or the card silently renders at the tile's
     * width while the layout is built for this one. That disagreement is what
     * made the knob grid hang 67.7 CSS px past the right edge. */
    width: 540px;
    min-height: 360px;
    background: var(--module-bg);
    border: 1px solid var(--border);
    border-radius: 2px;
    color: var(--text);
    padding-top: 18px;
    padding-bottom: 14px;
    position: relative;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  :global(.svelte-flow__node:hover) .mod-card { border-color: var(--accent-dim); }
  :global(.svelte-flow__node.selected) .mod-card {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent-glow), 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  .stripe { position: absolute; top: 0; left: 0; right: 0; height: 2px; border-radius: 2px 2px 0 0; }
  .body {
    /* Clear the PatchPanel's top-left/right trigger affordances. */
    margin-top: 24px;
  }
  .cols {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 14px;
    padding: 0 12px;
  }
  .left { display: flex; flex-direction: column; gap: 10px; }
  .screen-wrap {
    width: 288px;
    height: 216px;
    border: 1px solid #000;
    box-shadow: inset 0 0 8px rgba(0, 0, 0, 0.6), 0 0 4px rgba(0, 0, 0, 0.3);
    background: #050608;
    border-radius: 3px;
    overflow: hidden;
  }
  .screen { width: 288px; height: 216px; display: block; }
  .hero {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 0 4px;
  }
  .freeze {
    font: inherit;
    font-size: 10px;
    letter-spacing: 0.08em;
    padding: 5px 10px;
    border-radius: 2px;
    border: 1px solid var(--border);
    background: var(--module-bg);
    color: var(--text-dim, var(--text));
    cursor: pointer;
  }
  .freeze.on {
    border-color: var(--accent);
    color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent-glow);
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(3, auto);
    gap: 10px 8px;
    justify-items: center;
  }
</style>
