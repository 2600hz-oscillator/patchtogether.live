<script lang="ts">
  // SpirographsCard — UI for SPIROGRAPHS (1–3 independent spirograph video
  // GENERATOR). A COUNT knob (1..3 discrete) picks how many spiros render; a
  // per-spiro SELECTOR (1/2/3) swaps the knob bank to that spiro's ten
  // params (R / r / pen / inside / rotation / scale / X / Y / thickness +
  // a CHROMA colorwheel). A live preview of the colour OUT sits on top.
  //
  // ALL ports live in the shared yellow drill-down <PatchPanel> (the post-#767
  // hard standard — NO raw side <Handle> jacks). The panel uses the SECTIONED
  // grouping so the CV inputs break down per-spiro: a `count` section plus
  // spiro1 / spiro2 / spiro3 sections. Port ids are byte-identical to
  // spirographsDef so the CV bridge + persisted edges route unchanged.
  import { onMount, onDestroy } from 'svelte';
  import { type NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { useEngine } from '$lib/audio/engine-context';
  import { setNodeParam } from '$lib/graph/mutate';
  import {
    spirographsDef,
    spiroParamId,
    SPIRO_PARAM_STEMS,
    SPIRO_COUNT_MAX,
    SPIRO_RANGES,
    type SpiroParamStem,
  } from '$lib/video/modules/spirographs';
  import type { VideoEngine } from '$lib/video/engine';
  import { VIDEO_RES } from '$lib/video/engine';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);

  function p(name: string): number {
    const def = spirographsDef.params.find((d) => d.id === name);
    return node?.params[name] ?? def?.defaultValue ?? 0;
  }
  function pdef(name: string): number {
    return spirographsDef.params.find((d) => d.id === name)!.defaultValue;
  }
  function setParam(paramId: string) {
    return (v: number) => setNodeParam(id, paramId, v);
  }

  // --- COUNT (1..3 discrete) ---
  const COUNT_TICKS = [1, 2, 3].map((n) => ({ frac: (n - 1) / (SPIRO_COUNT_MAX - 1), label: String(n) }));

  // --- Which spiro's knob bank is showing (1..3). Independent of COUNT — the
  //     user can edit spiro 3's params even when COUNT is 1, then raise COUNT. ---
  let activeSpiro = $state(1);

  // Short, friendly labels per stem for the fader bank.
  const STEM_LABELS: Record<SpiroParamStem, string> = {
    R: 'Fixed',
    r: 'Roll',
    p: 'Pen',
    inside: 'In/Out',
    rotation: 'Rot',
    scale: 'Scale',
    xOffset: 'X',
    yOffset: 'Y',
    thickness: 'Width',
    chroma: 'Hue',
  };

  // The fader bank for the active spiro: every stem EXCEPT chroma (which gets
  // the colorwheel) and inside (which gets a toggle button).
  const FADER_STEMS: SpiroParamStem[] = SPIRO_PARAM_STEMS.filter(
    (s) => s !== 'chroma' && s !== 'inside',
  );

  function formatInside(v: number): string {
    return v >= 0.5 ? 'INSIDE' : 'OUTSIDE';
  }

  // --- CHROMA colorwheel: a conic-gradient hue ring; click/drag picks the hue
  //     (0..1) for the active spiro, written straight into its chroma param.
  let wheelEl: HTMLDivElement | null = $state(null);
  let wheelDragging = $state(false);

  function hueFromPointer(e: PointerEvent): number | null {
    const el = wheelEl;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const dx = e.clientX - cx;
    const dy = e.clientY - cy;
    // Angle CW from top, normalised to 0..1 (so 0 = red at top, matching the
    // conic-gradient below).
    let ang = Math.atan2(dx, -dy); // 0 at top, +CW
    if (ang < 0) ang += Math.PI * 2;
    return ang / (Math.PI * 2);
  }

  function onWheelDown(e: PointerEvent) {
    e.preventDefault();
    wheelDragging = true;
    wheelEl?.setPointerCapture(e.pointerId);
    const h = hueFromPointer(e);
    if (h !== null) setNodeParam(id, spiroParamId(activeSpiro, 'chroma'), h);
  }
  function onWheelMove(e: PointerEvent) {
    if (!wheelDragging) return;
    const h = hueFromPointer(e);
    if (h !== null) setNodeParam(id, spiroParamId(activeSpiro, 'chroma'), h);
  }
  function onWheelUp(e: PointerEvent) {
    wheelDragging = false;
    try { wheelEl?.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  }

  let activeHue = $derived(p(spiroParamId(activeSpiro, 'chroma')));
  // The picker dot position on the ring (CW from top).
  let dotAngle = $derived(activeHue * Math.PI * 2);

  // --- Live preview of the colour OUT (canonical surface). ---
  const ENGINE_W = VIDEO_RES.width;
  const ENGINE_H = VIDEO_RES.height;
  let canvasEl: HTMLCanvasElement | null = $state(null);
  let rafId: number | null = null;
  const engineCtx = useEngine();

  function draw() {
    rafId = null;
    const e = engineCtx.get();
    if (!e || !canvasEl) { rafId = requestAnimationFrame(draw); return; }
    let videoEngine: VideoEngine | undefined;
    try { videoEngine = e.getDomain<VideoEngine>('video'); }
    catch { rafId = requestAnimationFrame(draw); return; }
    if (!videoEngine) { rafId = requestAnimationFrame(draw); return; }
    const ctx2d = canvasEl.getContext('2d', { alpha: false });
    if (ctx2d) {
      try { videoEngine.blitOutputToDrawingBuffer(id); } catch { /* never nuke the rAF loop */ }
      const src = videoEngine.canvas as CanvasImageSource;
      const cw = canvasEl.width;
      const ch = canvasEl.height;
      ctx2d.fillStyle = '#050608';
      ctx2d.fillRect(0, 0, cw, ch);
      const srcAspect = ENGINE_W / ENGINE_H;
      const dstAspect = cw / ch;
      let w = cw, h = ch, x = 0, y = 0;
      if (dstAspect > srcAspect) { h = ch; w = Math.round(h * srcAspect); x = Math.round((cw - w) / 2); }
      else { w = cw; h = Math.round(w / srcAspect); y = Math.round((ch - h) / 2); }
      ctx2d.drawImage(src, x, y, w, h);
    }
    rafId = requestAnimationFrame(draw);
  }

  onMount(() => { rafId = requestAnimationFrame(draw); });
  onDestroy(() => { if (rafId !== null) cancelAnimationFrame(rafId); });

  // --- PatchPanel ports: SECTIONED so the CV inputs break down per-spiro. ---
  function spiroSection(i: number): { label: string; inputs: PortDescriptor[] } {
    return {
      label: `spiro${i}`,
      inputs: SPIRO_PARAM_STEMS.map((stem) => ({
        id: spiroParamId(i, stem),
        label: STEM_LABELS[stem],
        cable: 'cv',
      })),
    };
  }
  const sections = [
    { label: 'count', inputs: [{ id: 'count', label: 'COUNT', cable: 'cv' }] as PortDescriptor[] },
    spiroSection(1),
    spiroSection(2),
    spiroSection(3),
    { label: 'out', outputs: [
      { id: 'out', label: 'COLOR', cable: 'video' },
      { id: 'mono_out', label: 'MONO', cable: 'video' },
      { id: 'overlap', label: 'CANDY', cable: 'video' },
    ] as PortDescriptor[] },
  ];
</script>

<div class="vcard card video" data-testid="spirographs-card" data-node-id={id}>
  <div class="stripe"></div>
  <ModuleTitle {id} {data} defaultLabel="SPIROGRAPHS" />

  <PatchPanel nodeId={id} groupingStrategy="sectioned" {sections} panelWidth={300}>
    <!-- OUT live preview -->
    <div class="preview-wrap">
      <canvas
        bind:this={canvasEl}
        width={160}
        height={120}
        data-testid="spirographs-preview"
        data-node-id={id}
      ></canvas>
    </div>

    <!-- COUNT + spiro selector -->
    <div class="top-row">
      <Fader
        value={p('count')}
        min={1}
        max={SPIRO_COUNT_MAX}
        defaultValue={pdef('count')}
        label="Count"
        curve="discrete"
        ticks={COUNT_TICKS}
        onchange={setParam('count')}
        moduleId={id}
        paramId="count"
      />
      <div class="spiro-tabs" role="tablist" aria-label="Select spiro to edit">
        {#each [1, 2, 3] as i (i)}
          <button
            type="button"
            class="spiro-tab"
            class:active={activeSpiro === i}
            role="tab"
            aria-selected={activeSpiro === i}
            data-testid="spiro-tab"
            data-spiro={i}
            onclick={() => (activeSpiro = i)}
          >{i}</button>
        {/each}
      </div>
    </div>

    <!-- Active spiro: IN/OUT toggle + chroma colorwheel -->
    <div class="spiro-head">
      <button
        type="button"
        class="inout-toggle"
        data-testid="spiro-inout"
        onclick={() => setNodeParam(id, spiroParamId(activeSpiro, 'inside'), p(spiroParamId(activeSpiro, 'inside')) >= 0.5 ? 0 : 1)}
      >{formatInside(p(spiroParamId(activeSpiro, 'inside')))}</button>

      <div
        class="colorwheel"
        bind:this={wheelEl}
        role="slider"
        aria-label="Spiro hue"
        aria-valuenow={Math.round(activeHue * 360)}
        aria-valuemin={0}
        aria-valuemax={360}
        tabindex="0"
        data-testid="spiro-colorwheel"
        onpointerdown={onWheelDown}
        onpointermove={onWheelMove}
        onpointerup={onWheelUp}
      >
        <div
          class="wheel-dot"
          style:transform={`rotate(${dotAngle}rad) translateY(-15px)`}
          style:background={`hsl(${activeHue * 360}, 95%, 58%)`}
        ></div>
      </div>
    </div>

    <!-- Active spiro fader bank -->
    <div class="fader-grid">
      {#each FADER_STEMS as stem (stem)}
        {@const pid = spiroParamId(activeSpiro, stem)}
        <Fader
          value={p(pid)}
          min={SPIRO_RANGES[stem].min}
          max={SPIRO_RANGES[stem].max}
          defaultValue={pdef(pid)}
          label={STEM_LABELS[stem]}
          curve="linear"
          onchange={setParam(pid)}
          moduleId={id}
          paramId={pid}
        />
      {/each}
    </div>
  </PatchPanel>
</div>

<style>
  .card {
    width: 260px;
    min-height: 320px;
    padding-bottom: 12px;
  }
  .preview-wrap {
    margin: 6px auto 0;
    width: 160px;
    display: flex;
    justify-content: center;
  }
  .preview-wrap canvas {
    width: 160px;
    height: 120px;
    background: #050608;
    border: 1px solid var(--cable-video);
    border-radius: 1px;
    image-rendering: pixelated;
    display: block;
  }
  .top-row {
    margin-top: 8px;
    padding: 0 14px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }
  .spiro-tabs {
    display: flex;
    gap: 4px;
  }
  .spiro-tab {
    width: 22px;
    height: 22px;
    border: 1px solid var(--border);
    border-radius: 2px;
    background: var(--module-bg-deep);
    color: var(--text-dim);
    cursor: pointer;
    font-family: ui-monospace, monospace;
    font-size: 0.7rem;
  }
  .spiro-tab.active {
    border-color: var(--accent);
    color: var(--text);
    background: rgba(0, 240, 255, 0.1);
  }
  .spiro-head {
    margin-top: 10px;
    padding: 0 14px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .inout-toggle {
    border: 1px solid var(--border);
    border-radius: 2px;
    background: var(--module-bg-deep);
    color: var(--text);
    cursor: pointer;
    font-family: ui-monospace, monospace;
    font-size: 0.6rem;
    letter-spacing: 0.06em;
    padding: 4px 8px;
  }
  .inout-toggle:hover { border-color: var(--accent-dim); }
  .colorwheel {
    position: relative;
    width: 44px;
    height: 44px;
    border-radius: 50%;
    cursor: pointer;
    background: conic-gradient(
      from 0deg,
      hsl(0,95%,55%), hsl(60,95%,55%), hsl(120,95%,55%),
      hsl(180,95%,55%), hsl(240,95%,55%), hsl(300,95%,55%), hsl(360,95%,55%)
    );
    box-shadow: inset 0 0 0 1px rgba(0,0,0,0.4), 0 0 0 1px var(--border);
    flex: 0 0 auto;
    touch-action: none;
  }
  .wheel-dot {
    position: absolute;
    top: 50%;
    left: 50%;
    width: 8px;
    height: 8px;
    margin: -4px 0 0 -4px;
    border-radius: 50%;
    border: 1.5px solid #fff;
    box-shadow: 0 0 2px rgba(0,0,0,0.6);
    transform-origin: 50% 50%;
    pointer-events: none;
  }
  .fader-grid {
    margin-top: 10px;
    padding: 0 10px;
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 12px 4px;
    justify-items: center;
  }
</style>
