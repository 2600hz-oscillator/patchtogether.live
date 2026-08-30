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

  // ⚠ IS THE CANVAS ON SCREEN? Tracked here rather than taken from
  // `onMeterFrame`'s own gate, and the distinction is the whole fix. That gate
  // SKIPS THE CALLBACK ENTIRELY when its element is off-screen, which is right
  // for an ordinary meter and wrong for this module: the painter is advanced
  // INSIDE `read('imageData')` (`advanceOncePerFrame`), so with nothing
  // downstream patched THIS LOOP IS THE ONLY THING ADVANCING THE RASTER, and
  // skipping it would freeze the module rather than merely stop drawing it —
  // the #1720/#1721 class the "it KEEPS RENDERING while OFF" floor exists to
  // prevent. `RasterizeOutputBody` makes exactly this split for the SCREEN
  // toggle; this is the same split for the viewport.
  //
  // `rootMargin` matches meter-frame's own 100px so the two surfaces agree
  // about what "off-screen" means.
  let onScreen = $state(true);
  $effect(() => {
    const el = canvasEl;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) onScreen = e.isIntersecting;
      },
      { rootMargin: '100px' },
    );
    io.observe(el);
    return () => io.disconnect();
  });

  $effect(() => {
    if (!canvasEl) return;
    // ⚠ SUBSCRIBED WITH `null`, NOT WITH THE CANVAS. That is the documented way
    // to take the SHARED, COALESCED rAF without taking its visibility skip —
    // which is precisely what this module needs (see `onScreen` above). The
    // win it does collect is the one meter-frame exists for: this card used to
    // run its OWN `requestAnimationFrame` chain, one more independent callback
    // and paint flush per mounted rasterize, on the same main thread as the
    // audio render.
    const handle = onMeterFrame(null, () => {
      const eng = engineCtx.get();
      if (eng && node && canvasEl) {
        // PUSH then READ. `eng.readParam` returns the knob PLUS the engine's
        // own per-port CV tap — the combined value — and costs nothing extra:
        // the tap already exists for any patched port. The painter runs inside
        // read('imageData'), so the push has to land first (#1664). With
        // nothing patched there is no tap, so this equals the knob.
        const combined: Record<string, number> = {};
        for (const p of rasterizeDef.params) {
          const v = eng.readParam(node, p.id);
          if (typeof v === 'number' && Number.isFinite(v)) combined[p.id] = v;
        }
        eng.write(node, 'cvCombined', combined);
        // ⚠ READ UNCONDITIONALLY — this is what ADVANCES the painter, and the
        // advance is the cheap half (it writes ~800 pixels). The costly half is
        // the 1024x768 -> 480x360 scale-draw below, and THAT is what the
        // viewport gate skips. Same shape as the dock body's SCREEN split.
        const img = eng.read(node, 'imageData') as ImageData | undefined;
        if (img && onScreen) blit(canvasEl, img);
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
