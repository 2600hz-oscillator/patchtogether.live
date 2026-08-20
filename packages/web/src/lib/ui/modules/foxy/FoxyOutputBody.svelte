<script lang="ts">
  // packages/web/src/lib/ui/modules/foxy/FoxyOutputBody.svelte
  //
  // The FOXY dock full-view body: the module's whole internal world as five
  // live pictures, plus the three affordances that are not ParamDefs (the
  // SCOPE/3D view flip, SCREEN ON/OFF, and EXPORT TABLE).
  //
  // ⚠ WHY THIS FILE EXISTS — the rasterize (#2001) argument, five pictures over.
  // `hasVideoSurface(def)` is `def.domain === 'video'`; foxy is `domain: 'audio'`
  // with video OUTs whose frames are painted in JS (RasterPainter + the
  // foxy-draw / wavecel-draw renderers), so the shell has NO generic route to
  // any of them. Promoting foxy without this slot would replace three live
  // rasters, the XYZ field and the animated wavetable with knobs — on a module
  // whose entire proposition is that you can WATCH the table being built.
  //
  // ⚠ AND NOT A PF-14 PANEL, for the reason rasterize's inventory entry spells
  // out: a panel cell REQUIRES an operability probe, and a read-only picture's
  // only available probe watches a DIFFERENT control — an aliveness check that
  // cannot observe the thing it certifies. `fullViewBody` needs no such proxy.
  //
  // ⚠ THE PRODUCER IS PULL-DRIVEN, WHICH INVERTS THE COLLAPSE RULE (the
  // rasterize note, and it applies here for the same mechanical reason).
  // `bridgeTick()` runs INSIDE the engine handle's `read()` seam — `read('tick')`
  // and every `read('rasterImageData*')` call it — so when no video consumer is
  // patched, THIS LOOP IS THE ONLY THING ADVANCING THE RASTERS AND THE TABLE.
  // Stopping it on collapse would freeze the module itself, which is precisely
  // the #1720/#1721 class the owner's "it KEEPS RENDERING while OFF" floor
  // exists to prevent. So SCREEN OFF skips the BLITS and never the TICK. That is
  // also the cheap half to keep: the tick is throttled to ~24Hz inside the
  // module (BRIDGE_MS), while the blits are five scale-draws per frame.
  //
  // ⚠ ONE `read('tick')` ADVANCES EVERYTHING. Unlike rasterize — which has to
  // read its picture to advance its painter — foxy exposes a dedicated tick key,
  // so the advance and the painting are separable and the collapsed path costs
  // one throttled call rather than five ImageData reads.
  import { patch } from '$lib/graph/store';
  import { mutateNode } from '$lib/graph/mutate';
  import { useEngine } from '$lib/audio/engine-context';
  import {
    FOXY_GEN_MODE_NAMES,
    buildWavetableExport,
    buildWavetableExportFilename,
  } from '$lib/audio/modules/foxy';
  import { drawWave3D, drawWaveScope } from '$lib/audio/modules/wavecel-draw';
  import { drawFoxyXyz } from '$lib/audio/modules/foxy-draw';
  import { drawFoxyShapes } from '$lib/audio/modules/foxy-shapes-draw';
  import type { Shape as FoxyShape } from '$lib/audio/modules/foxy-shapes';
  import type { FoxyFieldRow } from '$lib/audio/modules/foxy-map';
  import type { ModuleNode } from '$lib/graph/types';

  interface Props {
    /** The graph node this faceplate is showing — the ONLY prop the slot gets
     *  (`ShellExtensionFullViewBodyProps`). */
    nodeId: string;
  }
  let { nodeId }: Props = $props();

  const engineCtx = useEngine();

  let rasterAEl: HTMLCanvasElement | null = $state(null);
  let rasterBEl: HTMLCanvasElement | null = $state(null);
  let rasterCEl: HTMLCanvasElement | null = $state(null);
  let xyzEl: HTMLCanvasElement | null = $state(null);
  let wtEl: HTMLCanvasElement | null = $state(null);
  let rafId: number | null = null;

  // ⚠ BOTH SWITCHES LIVE ON THE NODE, NOT IN THIS COMPONENT. A `$state` here
  // dies with the component, and this component unmounts on dock collapse / LRU
  // eviction — the card-unmount-kills-node-lifetime-state class (#1531 / #1574 /
  // #1583). `node.data` survives a tab switch (the owner's stated floor for the
  // SCREEN switch), a remount, a reload, and syncs to collaborators. One write
  // per CLICK, never per frame.
  //
  // ⚠ `previewCollapsed` REUSES THE FLEET KEY (rasterize / backdraft /
  // spirographs). Inventing a foxy-specific one would silently re-open the
  // preview of every rack saved before this face existed. Absent ⇒ false ⇒ ON.
  let previewCollapsed = $derived<boolean>(
    (patch.nodes[nodeId]?.data?.previewCollapsed as boolean | undefined) ?? false,
  );
  // The view flip. The legacy card keeps this in component state
  // (`FoxyCard.svelte`'s `vizMode`); the FACE cannot, for the unmount reason
  // above. Default '3d' matches the card, so a node that has never been flipped
  // renders identically on both surfaces.
  let vizMode = $derived<'scope' | '3d'>(
    (patch.nodes[nodeId]?.data?.vizMode as 'scope' | '3d' | undefined) ?? '3d',
  );
  // EXPORT is revealed only while FREEZE TABLE is on — the card's rule, kept
  // verbatim, because exporting a table that is being rewritten 24×/second
  // would dump an arbitrary frame of a moving target. It reads the PARAM (the
  // graph), not the engine, so the button appears the moment the toggle lands.
  let isFrozen = $derived<boolean>(
    ((patch.nodes[nodeId]?.params?.freezeTable as number | undefined) ?? 0) >= 0.5,
  );

  function togglePreview(): void {
    const next = !previewCollapsed;
    mutateNode(nodeId, (live) => {
      if (!live.data) live.data = {};
      live.data.previewCollapsed = next;
    });
  }
  function toggleVizMode(): void {
    const next = vizMode === '3d' ? 'scope' : '3d';
    mutateNode(nodeId, (live) => {
      if (!live.data) live.data = {};
      live.data.vizMode = next;
    });
  }

  // EXPORT TABLE — the same payload builder and the same in-DOM anchor click the
  // legacy card uses (`buildWavetableExport` / `buildWavetableExportFilename`),
  // so there is ONE implementation of the file format and not two.
  function exportTable(): void {
    const eng = engineCtx.get();
    const node = patch.nodes[nodeId] as ModuleNode | undefined;
    if (!eng || !node) return;
    const wt = eng.read(node, 'wavetableFrames') as Float32Array[] | undefined;
    if (!wt || wt.length === 0) return;
    const rawMode = Number((eng.read(node, 'genMode') as number | undefined) ?? 0);
    const modeIdx = Math.max(0, Math.min(FOXY_GEN_MODE_NAMES.length - 1, Math.round(rawMode)));
    const now = new Date();
    const payload = buildWavetableExport(wt, FOXY_GEN_MODE_NAMES[modeIdx], now);
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = buildWavetableExportFilename(now);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Defer the revoke a tick so Safari's late click-handling still sees the
    // blob — the VideoboxCard / FoxyCard export pattern.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  // Stage the native-resolution ImageData, then scale into the dock canvas with
  // NEAREST-NEIGHBOUR: the rasters are 256×256 of hard pixels and smoothing them
  // would turn the banding — the thing the picture is FOR — into mush.
  let stage: HTMLCanvasElement | null = null;
  function blitRaster(c: HTMLCanvasElement, img: ImageData): void {
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

  // LIVE WAVETABLE redraw guard, carried over from the legacy card because the
  // reason is still live: `drawWave3D`/`drawWaveScope` are pure functions of
  // (frames, activeFrame, mode), so re-running them every rAF re-rasterizes
  // identical pixels — and at a fractional canvas zoom each repaint composites
  // with non-deterministic sub-pixel AA, which is what broke the freeze-equality
  // e2e in #759/#411/#420. Skipping the redraw when the inputs are unchanged
  // keeps the composited layer byte-stable AND is a small perf win.
  let lastWtSig = '';
  function wtSignature(fs: Float32Array[], activeFrame: number, mode: string): string {
    const n = fs.length;
    let sig = `${mode}|${activeFrame}|${n}`;
    if (n > 0) {
      const f0 = fs[0]!;
      const fl = fs[n - 1]!;
      sig += `|${f0.length}`;
      const k = Math.max(1, f0.length >> 3);
      for (let i = 0; i < f0.length; i += k) sig += `,${f0[i]!.toFixed(4)}`;
      for (let i = 0; i < fl.length; i += k) sig += `;${fl[i]!.toFixed(4)}`;
    }
    return sig;
  }

  function draw(): void {
    rafId = null;
    const eng = engineCtx.get();
    const node = patch.nodes[nodeId] as ModuleNode | undefined;
    if (eng && node) {
      // ⚠ ADVANCE UNCONDITIONALLY — see the pull-driven note at the top. This is
      // the ONE call that must not be gated on `previewCollapsed`.
      eng.read(node, 'tick');
      if (!previewCollapsed) {
        const imgA = eng.read(node, 'rasterImageDataA') as ImageData | undefined;
        const imgB = eng.read(node, 'rasterImageDataB') as ImageData | undefined;
        const imgC = eng.read(node, 'rasterImageDataC') as ImageData | undefined;
        if (rasterAEl && imgA) blitRaster(rasterAEl, imgA);
        if (rasterBEl && imgB) blitRaster(rasterBEl, imgB);
        if (rasterCEl && imgC) blitRaster(rasterCEl, imgC);

        // The XYZ window swaps renderer on the GEN mode, exactly as the card
        // does: the heightfield scanlines in XYZ, the primitives scene in
        // 3D Shape Gen. Reading `genMode` from the ENGINE (not the param) keeps
        // this in step with whichever path the bridge actually ran.
        if (xyzEl) {
          const c = xyzEl.getContext('2d');
          if (c) {
            const genIdx = Math.round(Number((eng.read(node, 'genMode') as number | undefined) ?? 0));
            if (genIdx >= 1) {
              const shapes = (eng.read(node, 'shapes') as FoxyShape[] | undefined) ?? [];
              drawFoxyShapes(c, shapes, xyzEl.width, xyzEl.height);
            } else {
              const field = (eng.read(node, 'xyzField') as FoxyFieldRow[] | undefined) ?? [];
              drawFoxyXyz(c, field, xyzEl.width, xyzEl.height);
            }
          }
        }

        if (wtEl) {
          const c = wtEl.getContext('2d');
          if (c) {
            const fs = (eng.read(node, 'wavetableFrames') as Float32Array[] | undefined) ?? [];
            const activeFrame = (eng.read(node, 'activeFrame') as number | undefined) ?? 0;
            const sig = wtSignature(fs, activeFrame, vizMode);
            if (sig !== lastWtSig) {
              lastWtSig = sig;
              if (vizMode === '3d') drawWave3D(c, fs, wtEl.width, wtEl.height, { activeFrame });
              else drawWaveScope(c, fs, wtEl.width, wtEl.height, { activeFrame });
            }
          }
        }
      }
    }
    rafId = requestAnimationFrame(draw);
  }

  // ONE place owns the loop so it cannot be started twice. It runs for the
  // component's lifetime regardless of SCREEN state — `draw` itself decides what
  // to paint (the pull-driven note).
  $effect(() => {
    if (rafId === null) rafId = requestAnimationFrame(draw);
    return () => {
      if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
    };
  });
</script>

<div class="foxy-output" data-testid="foxy-output-body">
  <div class="preview-wrap" data-preview-collapsed={previewCollapsed ? 'true' : 'false'}>
    {#if !previewCollapsed}
      <!-- ONE ROW, and the height is the argument: the dock pane folds, so the
           expensive axis here is VERTICAL. Laid side by side the five pictures
           cost the height of the tallest (110px) instead of stacking to ~270px,
           and the horizontal space they occupy is filled with live picture
           rather than the grey the owner ruled against. -->
      <div class="pic-row">
        <div class="pic">
          <canvas bind:this={rasterAEl} width="72" height="72" data-testid="foxy-face-raster-a"></canvas>
          <span class="cap">raster a</span>
        </div>
        <div class="pic">
          <canvas bind:this={rasterBEl} width="72" height="72" data-testid="foxy-face-raster-b"></canvas>
          <span class="cap">raster b</span>
        </div>
        <div class="pic">
          <canvas bind:this={rasterCEl} width="72" height="72" data-testid="foxy-face-raster-c"></canvas>
          <span class="cap">raster c</span>
        </div>
        <div class="pic">
          <canvas bind:this={xyzEl} width="160" height="84" class="wide" data-testid="foxy-face-xyz"></canvas>
          <span class="cap">xyz field</span>
        </div>
        <div class="pic wt">
          <canvas bind:this={wtEl} width="280" height="110" class="wide" data-testid="foxy-face-wavetable"></canvas>
          <!-- The view flip overlays its own picture's top corner, so it costs
               no layout height (the stacked-row anti-pattern). -->
          <button
            type="button"
            class="pill nodrag viz"
            onclick={toggleVizMode}
            data-testid="foxy-face-viz-toggle"
            aria-pressed={vizMode === '3d'}
            title="Flip the live wavetable between the 3D surface and a single-frame scope trace"
          >{vizMode === '3d' ? '3D' : 'SCOPE'}</button>
          <span class="cap">live wavetable</span>
        </div>
      </div>
    {/if}

    {#if isFrozen}
      <!-- Revealed only while FREEZE TABLE is on — the one control on this face
           that appears in a single mode, which is the owner's named example of
           a genuine width earner. -->
      <button
        type="button"
        class="pill nodrag export"
        onclick={exportTable}
        data-testid="foxy-face-export-table"
        title="Export the frozen wavetable as a portable JSON file"
      >↓ EXPORT</button>
    {/if}

    <button
      type="button"
      class="pill nodrag screen"
      class:on={!previewCollapsed}
      onclick={togglePreview}
      data-testid="foxy-face-screen-toggle"
      aria-pressed={!previewCollapsed}
      title="SCREEN: turn the previews off to reclaim their space. The rasters and the wavetable keep building."
    >SCREEN {previewCollapsed ? 'OFF' : 'ON'}</button>
  </div>
</div>

<style>
  .foxy-output {
    display: flex;
    justify-content: center;
    padding: 6px 0 2px;
  }
  /* ⚠ THE SWITCHES COST ZERO LAYOUT HEIGHT — the OVERLAY paragraph in
     module-faceplates.md. A stacked row measured ~18.8px on a card carrying
     ~11px of slack and reddened io-spec-consistency's card sweep. */
  .preview-wrap {
    position: relative;
    display: flex;
    justify-content: center;
    /* Only load-bearing with SCREEN OFF: the pictures are gone and without a
       floor the wrap would collapse to zero and take the absolutely-positioned
       buttons with it. Inert behind the row whenever the pictures show. */
    min-height: 18px;
  }
  .pic-row {
    display: flex;
    align-items: flex-end;
    justify-content: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .pic {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
  }
  .pic canvas {
    display: block;
    border-radius: 3px;
    background: #05070b;
    border: 1px solid var(--border);
    max-width: 100%;
    height: auto;
    /* The rasters' pixels ARE the look — never smooth them. */
    image-rendering: pixelated;
  }
  /* The field and the wavetable are continuous renders, not pixel art. */
  .pic canvas.wide { image-rendering: auto; }
  /* A control CAPTION, which is permitted resting text (module NAME, tab/section
     labels, control captions, option names). No value, no measurement, no state
     word — those live in aria-valuetext on the controls themselves. */
  .cap {
    font-size: 0.5rem;
    letter-spacing: 0.08em;
    font-family: ui-monospace, monospace;
    color: var(--text-dim);
  }
  .pill {
    font-size: 0.55rem;
    letter-spacing: 0.06em;
    padding: 2px 8px;
    border: 1px solid var(--border);
    border-radius: 2px;
    /* Legible over a live picture — a transparent button was not. */
    background: rgba(5, 6, 8, 0.72);
    color: var(--text-dim);
    cursor: pointer;
  }
  .pill:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px; }
  .viz {
    position: absolute;
    top: 4px;
    right: 4px;
  }
  .screen {
    position: absolute;
    right: 4px;
    bottom: 4px;
  }
  .screen.on { color: var(--text); border-color: var(--accent-dim); }
  .export {
    position: absolute;
    left: 4px;
    bottom: 4px;
  }
  .export:hover { color: var(--text); border-color: var(--accent-dim); }
</style>
