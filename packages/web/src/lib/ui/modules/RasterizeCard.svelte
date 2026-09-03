<script lang="ts">
    import type { NodeProps } from '@xyflow/svelte';
  import NeonFader from '$lib/ui/controls/NeonFader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { setNodeParam } from '$lib/graph/mutate';
  import { rasterizeDef } from '$lib/audio/modules/rasterize';
  import { useEngine } from '$lib/audio/engine-context';
  import { onMeterFrame } from '$lib/ui/meter-frame';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { portsFromDef } from './card-kit';

  // Inputs: audio in + 1 CV per param. Port ids match RASTERIZE's def
  // 1:1 (io-spec consistency e2e enforces this); the CV bridge routes
  // via setParam(portId).
  const inputs = portsFromDef(rasterizeDef.inputs, {
    in: 'AUDIO IN', cursor: 'SCAN (CV)', samplesPerFrame: 'SAMP/FRAME (CV)',
    gain: 'GAIN (CV)', wrap: 'WRAP (CV)',
  });
  const outputs = portsFromDef(rasterizeDef.outputs, { thru: 'AUDIO THRU', out: 'VIDEO OUT' });

  // ⚠ ONE SOURCE FOR EVERY RANGE (`RANGE_BOUND_CARDS`). This card used to be
  // half-and-half: SCAN read `rasterizeDef.params[0]!.max` while SAMP/F and
  // GAIN hand-typed `16..8000` and `0..8`. They AGREED with the def, so
  // `card-def-agreement` was green and nothing was broken — but the def is the
  // one that just moved (the `wrap` roster landed with the faceplate), and a
  // restated number is only ever one edit away from the backdraft class.
  //
  // Looked up BY ID rather than by index, which is the other half of the
  // fragility: `params[0]` silently re-points if a param is ever reordered.
  const P = Object.fromEntries(rasterizeDef.params.map((p) => [p.id, p]));
  const CURSOR = P.cursor!;
  const SAMPLES = P.samplesPerFrame!;
  const GAIN = P.gain!;

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  // Params: read from the patch (single source of truth). The engine's
  // RASTERIZE handle keeps a parallel cache that drives the video bridge
  // + the on-card render; that cache is updated by the reconciler (fader
  // → patch.nodes[].params) and by setParam (cross-domain CV bridge).
  let cursor          = $derived(node?.params.cursor          ?? rasterizeDef.params[0]!.defaultValue);
  let samplesPerFrame = $derived(node?.params.samplesPerFrame ?? rasterizeDef.params[1]!.defaultValue);
  let gain            = $derived(node?.params.gain            ?? rasterizeDef.params[2]!.defaultValue);
  let wrap            = $derived((node?.params.wrap ?? 0) >= 0.5);

  function setParam(paramId: string) {
    return (v: number) => setNodeParam(id, paramId, v);
  }
  // ⚠ WAS A BARE PROXY WRITE — `patch.nodes[id].params.wrap = …` — and that is
  // the whole of the debt `raw-write-ledger` carried against this file ("card
  // button write — user gesture, should be undoable + synced"). A bare
  // assignment transacts with origin `null`, and `store.ts` tracks only
  // `LOCAL_ORIGIN`, so the flip was neither undoable nor origin-tagged for
  // collaborators — while the three FADERS beside it, which already went
  // through `setNodeParam`, were both. One param, one module, two different
  // answers depending on which control you touched.
  //
  // ⚠ THE FACE DID NOT PAY THIS. Promotion does not delete the card — the
  // per-card VRT sweep still renders it under `?shell=legacy` — so the faced
  // `wrap` cell was correct and this button was not, at the same time. A face
  // does not pay a card's debt; editing the card does, which is this line.
  function toggleWrap() {
    setNodeParam(id, 'wrap', wrap ? 0 : 1);
  }

  let canvasEl: HTMLCanvasElement | null = $state(null);

  // ⚠ THIS CARD IS A VIEWER, NOT THE PRODUCER (legacy-removal S1.5). The
  // per-frame `cvCombined` push and the painter's advance both belong to
  // `RASTERIZE_FRAME_PRODUCER` (`$lib/ui/media/frame-producers`), owned by the
  // NODE on graph lifetime — so the raster moves and honours its cables with no
  // card mounted anywhere. This loop only shows the result: read the current
  // frame, blit it. The read does still advance (`advanceOncePerFrame` inside
  // `read('imageData')`) — the module dedupes on its own 8 ms guard, so a
  // viewer's read coalesces with the producer's instead of racing the cursor.
  //
  // Which is why the SUBSCRIPTION CARRIES THE CANVAS now: meter-frame's
  // visibility gate ("skip the callback when the element is off-screen") used
  // to be wrong for this card, because this loop was the only thing advancing
  // the raster and skipping it froze the module (#1720/#1721). With the
  // advance node-owned, a scrolled-away card skipping its blit is exactly what
  // the gate is for.
  $effect(() => {
    const el = canvasEl;
    if (!el) return;
    const handle = onMeterFrame(el, () => {
      const eng = engineCtx.get();
      if (eng && node && canvasEl) {
        const img = eng.read(node, 'imageData') as ImageData | undefined;
        if (img) blit(canvasEl, img);
      }
    });
    return () => handle.stop();
  });

  // Stage the native engine-res ImageData (VIDEO_RES), then drawImage-scale
  // into the smaller on-card canvas (nearest-neighbour so the raster pixels
  // stay crisp — anti-alias would soften the bands, and "untamed" is the look).
  let stage: HTMLCanvasElement | null = null;
  function blit(c: HTMLCanvasElement, img: ImageData) {
    const ctx2d = c.getContext('2d');
    if (!ctx2d) return;
    if (!stage) stage = document.createElement('canvas');
    if (stage.width !== img.width || stage.height !== img.height) {
      stage.width = img.width;
      stage.height = img.height;
    }
    const sctx = stage.getContext('2d');
    if (!sctx) return;
    sctx.putImageData(img, 0, 0);
    ctx2d.imageSmoothingEnabled = false;
    ctx2d.clearRect(0, 0, c.width, c.height);
    ctx2d.drawImage(stage, 0, 0, c.width, c.height);
  }
</script>

<div class="vcard card">
  <div class="stripe"></div>
  <header class="title">
    <ModuleTitle {id} {data} defaultLabel="Rasterize" inline />
    <button
      class="wrap-btn"
      class:clamp={wrap}
      onclick={toggleWrap}
      title={wrap ? 'Clamp (top-to-bottom repaint)' : 'Wrap (toroidal drift)'}
    >
      {wrap ? 'CLAMP' : 'WRAP'}
    </button>
  </header>

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="screen-wrap">
      <canvas
        bind:this={canvasEl}
        width="280"
        height="210"
        data-testid="rasterize-canvas"
      ></canvas>
    </div>

    <div class="fader-row">
      <NeonFader value={cursor}          min={CURSOR.min}  max={CURSOR.max}   defaultValue={CURSOR.defaultValue}  label="Scan"   curve={CURSOR.curve}  onchange={setParam('cursor')}          moduleId={id} paramId="cursor" />
      <NeonFader value={samplesPerFrame} min={SAMPLES.min} max={SAMPLES.max}  defaultValue={SAMPLES.defaultValue} label="Samp/F" curve={SAMPLES.curve} onchange={setParam('samplesPerFrame')} moduleId={id} paramId="samplesPerFrame" />
      <NeonFader value={gain}            min={GAIN.min}    max={GAIN.max}     defaultValue={GAIN.defaultValue}    label="Gain"   curve={GAIN.curve}    onchange={setParam('gain')}            moduleId={id} paramId="gain" />
    </div>
  </PatchPanel>
</div>

<style>
  .card {
    width: 320px;
    min-height: 260px;
  }
  .stripe {
/* mono-video cable color — RASTERIZE is an audio→video bridge module. */
    background: var(--cable-mono-video, var(--cable-cv));
  }
  .title {
    font-size: 0.85rem;
    font-weight: 500;
    text-align: center;
    margin: 0 0 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
  }
  .wrap-btn {
    height: 18px;
    min-width: 48px;
    padding: 0 6px;
    background: #14171c;
    border: 1px solid var(--border);
    color: var(--text-dim);
    border-radius: 3px;
    font-size: 0.6rem;
    font-family: ui-monospace, monospace;
    cursor: pointer;
    line-height: 1;
  }
  .wrap-btn.clamp {
    background: var(--accent);
    color: #1a1d23;
    border-color: var(--accent);
  }
  .screen-wrap {
    margin: 16px 30px 8px;
    border: 1px solid var(--border);
    border-radius: 3px;
    overflow: hidden;
    line-height: 0;
    background: #000;
  }
  canvas {
    display: block;
    width: 100%;
    height: 158px;
    image-rendering: pixelated;
  }
  .fader-row {
    display: flex;
    justify-content: center;
    gap: 6px;
    margin-top: 4px;
    padding: 0 12px;
  }
</style>
