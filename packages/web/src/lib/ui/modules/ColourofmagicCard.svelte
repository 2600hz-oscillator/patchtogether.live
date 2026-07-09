<script lang="ts">
  // ColourofmagicCard — UI for COLOUR OF MAGIC (multi-colorspace video
  // processor). Three block columns (RGB | YDbDr | HSV/HSL), each a header +
  // three channel rows (a Knob + an OVER/CLAMP pill). The HSV/HSL header
  // carries the HSV↔HSL toggle; the RGB header carries the palette REPLACE
  // toggle + three colour-picker swatches (pal_r/g/b). A live preview canvas
  // on top shows the `preview`-selected output; a pill row switches it. All
  // CV + mono-override jacks + the 8 outputs live in the sectioned drill-down
  // <PatchPanel> (IN / RGB / YDbDr / HSV-HSL / OUT) — no raw side jacks. Port
  // ids are byte-identical to colourofmagicDef.
  import { onMount, onDestroy } from 'svelte';
  import { type NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { setNodeParam } from '$lib/graph/mutate';
  import { colourofmagicDef } from '$lib/video/modules/colourofmagic';
  import { packColor01, unpackColor01 } from '$lib/video/colourofmagic-colorspace';
  import type { VideoEngine } from '$lib/video/engine';
  import { VIDEO_RES } from '$lib/video/engine';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { cardParams } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const { set, live, engineCtx } = cardParams(colourofmagicDef, () => id, () => node);

  function defaultFor(key: string): number {
    return colourofmagicDef.params.find((p) => p.id === key)!.defaultValue;
  }
  function pget(key: string): number {
    return (node?.params?.[key] ?? defaultFor(key)) as number;
  }
  function paramRange(pid: string): { min: number; max: number } {
    const p = colourofmagicDef.params.find((x) => x.id === pid)!;
    return { min: p.min, max: p.max };
  }
  // Motorized live-CV read so a patched LFO / bound CC rotates the tick.

  // ── channel-row config per block ──
  interface Chan { bias: string; over: string; label: string; deg?: boolean; advisory?: boolean }
  const RGB_CH: Chan[] = [
    { bias: 'bias_r', over: 'over_r', label: 'r' },
    { bias: 'bias_g', over: 'over_g', label: 'g' },
    { bias: 'bias_b', over: 'over_b', label: 'b' },
  ];
  const YDB_CH: Chan[] = [
    { bias: 'bias_y', over: 'over_y', label: 'y' },
    { bias: 'bias_db', over: 'over_db', label: 'db' },
    { bias: 'bias_dr', over: 'over_dr', label: 'dr' },
  ];
  const HSV_CH: Chan[] = [
    { bias: 'bias_h', over: 'over_h', label: 'h', deg: true, advisory: true },
    { bias: 'bias_s', over: 'over_s', label: 's' },
    { bias: 'bias_v', over: 'over_v', label: 'v' },
  ];
  const YIQ_CH: Chan[] = [
    { bias: 'bias_yiq_y', over: 'over_yiq_y', label: 'y' },
    { bias: 'bias_yiq_i', over: 'over_yiq_i', label: 'i' },
    { bias: 'bias_yiq_q', over: 'over_yiq_q', label: 'q' },
  ];
  const YCC_CH: Chan[] = [
    { bias: 'bias_ycc_y', over: 'over_ycc_y', label: 'y' },
    { bias: 'bias_ycc_cb', over: 'over_ycc_cb', label: 'cb' },
    { bias: 'bias_ycc_cr', over: 'over_ycc_cr', label: 'cr' },
  ];

  function toggleOver(pid: string): void {
    setNodeParam(id, pid, pget(pid) >= 0.5 ? 0 : 1);
  }
  function overLabel(pid: string): string {
    return pget(pid) >= 0.5 ? 'WRAP' : 'CLAMP';
  }

  // ── HSV/HSL + REPLACE toggles ──
  let isHsl = $derived(pget('mode_hsl') >= 0.5);
  function toggleHsl(): void {
    setNodeParam(id, 'mode_hsl', isHsl ? 0 : 1);
  }
  let replaceOn = $derived(pget('replace') >= 0.5);
  function toggleReplace(): void {
    setNodeParam(id, 'replace', replaceOn ? 0 : 1);
  }

  // ── palette colour pickers (ChromaCard idiom: swatch + hidden <input color>) ──
  const PAL_IDS = ['pal_r', 'pal_g', 'pal_b'] as const;
  const PAL_LABELS: Record<string, string> = { pal_r: 'R', pal_g: 'G', pal_b: 'B' };
  function colorHex(pid: string): string {
    const [r, g, b] = unpackColor01(pget(pid));
    const h = (v: number) => Math.round(v * 255).toString(16).padStart(2, '0');
    return `#${h(r)}${h(g)}${h(b)}`;
  }
  function onColorPick(pid: string, ev: Event): void {
    const hex = (ev.currentTarget as HTMLInputElement).value; // "#rrggbb"
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    setNodeParam(id, pid, packColor01(r, g, b));
    // Discoverability nudge: picking a swatch auto-enables REPLACE so the recolour
    // is immediately visible on the rgb out (REPLACE defaults off + is easy to miss).
    if (!replaceOn) setNodeParam(id, 'replace', 1);
  }

  // ── preview select (22 outputs; index === uOutMode === preview value) ──
  const PREVIEW_LABELS = [
    'PASS', 'RGB', 'YDbDr', 'HSV', 'R', 'G', 'B', 'LUMA',
    'dY', 'Db', 'Dr', 'H', 'S', 'V',
    'YIQ', 'iY', 'I', 'Q',
    'YCC', 'cY', 'Cb', 'Cr',
  ];
  let previewSel = $derived(Math.round(pget('preview')));
  function selectPreview(n: number): void {
    setNodeParam(id, 'preview', n);
  }

  // ── on-card preview canvas (blitOutputToDrawingBuffer → letterboxed 2D) ──
  const ENGINE_W = VIDEO_RES.width;
  const ENGINE_H = VIDEO_RES.height;
  const CANVAS_W = 300;
  const CANVAS_H = 170;
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

  onMount(() => { drawRaf = requestAnimationFrame(draw); });
  onDestroy(() => { if (drawRaf !== null) cancelAnimationFrame(drawRaf); });

  // ── patch panel (sectioned drill-down) ──
  const sections = [
    { label: 'IN', inputs: [{ id: 'in', label: 'IN', cable: 'video' }] as PortDescriptor[] },
    {
      label: 'RGB',
      inputs: [
        { id: 'rgb_r_cv', label: 'R CV', cable: 'cv' },
        { id: 'rgb_r_in', label: 'R OVR', cable: 'mono-video' },
        { id: 'rgb_g_cv', label: 'G CV', cable: 'cv' },
        { id: 'rgb_g_in', label: 'G OVR', cable: 'mono-video' },
        { id: 'rgb_b_cv', label: 'B CV', cable: 'cv' },
        { id: 'rgb_b_in', label: 'B OVR', cable: 'mono-video' },
      ] as PortDescriptor[],
    },
    {
      label: 'YDbDr',
      inputs: [
        { id: 'ydb_y_cv', label: 'Y CV', cable: 'cv' },
        { id: 'ydb_y_in', label: 'Y OVR', cable: 'mono-video' },
        { id: 'ydb_db_cv', label: 'Db CV', cable: 'cv' },
        { id: 'ydb_db_in', label: 'Db OVR', cable: 'mono-video' },
        { id: 'ydb_dr_cv', label: 'Dr CV', cable: 'cv' },
        { id: 'ydb_dr_in', label: 'Dr OVR', cable: 'mono-video' },
      ] as PortDescriptor[],
    },
    {
      label: 'HSV / HSL',
      inputs: [
        { id: 'hsv_h_cv', label: 'H CV', cable: 'cv' },
        { id: 'hsv_h_in', label: 'H OVR', cable: 'mono-video' },
        { id: 'hsv_s_cv', label: 'S CV', cable: 'cv' },
        { id: 'hsv_s_in', label: 'S OVR', cable: 'mono-video' },
        { id: 'hsv_v_cv', label: 'V CV', cable: 'cv' },
        { id: 'hsv_v_in', label: 'V OVR', cable: 'mono-video' },
      ] as PortDescriptor[],
    },
    {
      label: 'YIQ',
      inputs: [
        { id: 'yiq_y_cv', label: 'Y CV', cable: 'cv' },
        { id: 'yiq_y_in', label: 'Y OVR', cable: 'mono-video' },
        { id: 'yiq_i_cv', label: 'I CV', cable: 'cv' },
        { id: 'yiq_i_in', label: 'I OVR', cable: 'mono-video' },
        { id: 'yiq_q_cv', label: 'Q CV', cable: 'cv' },
        { id: 'yiq_q_in', label: 'Q OVR', cable: 'mono-video' },
      ] as PortDescriptor[],
    },
    {
      label: 'YCbCr',
      inputs: [
        { id: 'ycc_y_cv', label: 'Y CV', cable: 'cv' },
        { id: 'ycc_y_in', label: 'Y OVR', cable: 'mono-video' },
        { id: 'ycc_cb_cv', label: 'Cb CV', cable: 'cv' },
        { id: 'ycc_cb_in', label: 'Cb OVR', cable: 'mono-video' },
        { id: 'ycc_cr_cv', label: 'Cr CV', cable: 'cv' },
        { id: 'ycc_cr_in', label: 'Cr OVR', cable: 'mono-video' },
      ] as PortDescriptor[],
    },
    {
      label: 'OUT',
      outputs: [
        { id: 'pass', label: 'PASS', cable: 'video' },
        { id: 'rgb', label: 'RGB', cable: 'video' },
        { id: 'ydbdr', label: 'YDbDr', cable: 'video' },
        { id: 'hsvhsl', label: 'HSV/HSL', cable: 'video' },
        { id: 'yiq', label: 'YIQ', cable: 'video' },
        { id: 'ycc', label: 'YCbCr', cable: 'video' },
        { id: 'r', label: 'R', cable: 'mono-video' },
        { id: 'g', label: 'G', cable: 'mono-video' },
        { id: 'b', label: 'B', cable: 'mono-video' },
        { id: 'luma', label: 'LUMA', cable: 'mono-video' },
        { id: 'ydb_y', label: 'Y (YDbDr)', cable: 'mono-video' },
        { id: 'ydb_db', label: 'Db', cable: 'mono-video' },
        { id: 'ydb_dr', label: 'Dr', cable: 'mono-video' },
        { id: 'hsv_h', label: 'H', cable: 'mono-video' },
        { id: 'hsv_s', label: 'S', cable: 'mono-video' },
        { id: 'hsv_v', label: 'V', cable: 'mono-video' },
        { id: 'yiq_y', label: 'Y (YIQ)', cable: 'mono-video' },
        { id: 'yiq_i', label: 'I', cable: 'mono-video' },
        { id: 'yiq_q', label: 'Q', cable: 'mono-video' },
        { id: 'ycc_y', label: 'Y (YCbCr)', cable: 'mono-video' },
        { id: 'ycc_cb', label: 'Cb', cable: 'mono-video' },
        { id: 'ycc_cr', label: 'Cr', cable: 'mono-video' },
      ] as PortDescriptor[],
    },
  ];
</script>

<div class="mod-card colourofmagic-card" data-testid="colourofmagic-card" data-node-id={id}>
  <div class="stripe" style="background: var(--cable-video);"></div>
  <ModuleTitle {id} {data} defaultLabel="COLOUR OF MAGIC" />

  <PatchPanel nodeId={id} groupingStrategy="sectioned" {sections} panelWidth={320}>
    <div class="body">
      <!-- Preview canvas + output selector -->
      <div class="canvas-wrap">
        <canvas
          bind:this={canvasEl}
          width={CANVAS_W}
          height={CANVAS_H}
          data-testid="colourofmagic-canvas"
          data-node-id={id}
        ></canvas>
      </div>
      <div class="preview-pills" data-testid="colourofmagic-preview">
        {#each PREVIEW_LABELS as label, n (label)}
          <button
            type="button"
            class="pill"
            class:active={previewSel === n}
            data-testid={`colourofmagic-preview-${n}`}
            onclick={() => selectPreview(n)}
            title={`Preview ${label} output`}
          >{label}</button>
        {/each}
      </div>

      <!-- three block columns -->
      <div class="blocks">
        <!-- RGB -->
        <div class="block" data-testid="colourofmagic-block-rgb">
          <div class="block-head">
            <span class="block-name">RGB</span>
            <button
              type="button"
              class="mode-toggle"
              class:on={replaceOn}
              data-testid="colourofmagic-replace"
              onclick={toggleReplace}
              title="Palette REPLACE: remap R/G/B channels to picked colours"
            >{replaceOn ? 'REPLACE' : 'DIRECT'}</button>
          </div>
          {#each RGB_CH as ch (ch.bias)}
            {@const r = paramRange(ch.bias)}
            <div class="chan">
              <Knob
                value={pget(ch.bias)}
                min={r.min}
                max={r.max}
                defaultValue={defaultFor(ch.bias)}
                label={ch.label}
                curve="linear"
                onchange={set(ch.bias)}
                readLive={live(ch.bias)}
                moduleId={id}
                paramId={ch.bias}
              />
              <button
                type="button"
                class="over-pill"
                class:wrap={pget(ch.over) >= 0.5}
                data-testid={`colourofmagic-over-${ch.over}`}
                onclick={() => toggleOver(ch.over)}
                title="Overflow: CLAMP (clip) vs WRAP (fract)"
              >{overLabel(ch.over)}</button>
            </div>
          {/each}
          <!-- palette swatches (apply under REPLACE) -->
          <div class="swatches" class:dim={!replaceOn} data-testid="colourofmagic-swatches">
            {#each PAL_IDS as pid (pid)}
              {@const hex = colorHex(pid)}
              <label class="swatch-wrap" title={`Palette colour for the ${PAL_LABELS[pid]} channel`}>
                <span class="swatch" style="background: {hex};"></span>
                <input
                  type="color"
                  class="color-input"
                  value={hex}
                  oninput={(ev) => onColorPick(pid, ev)}
                  data-testid={`colourofmagic-${pid}`}
                />
                <span class="swatch-label">{PAL_LABELS[pid]}</span>
              </label>
            {/each}
          </div>
        </div>

        <!-- YDbDr -->
        <div class="block" data-testid="colourofmagic-block-ydbdr">
          <div class="block-head">
            <span class="block-name">YDbDr</span>
          </div>
          {#each YDB_CH as ch (ch.bias)}
            {@const r = paramRange(ch.bias)}
            <div class="chan">
              <Knob
                value={pget(ch.bias)}
                min={r.min}
                max={r.max}
                defaultValue={defaultFor(ch.bias)}
                label={ch.label}
                curve="linear"
                onchange={set(ch.bias)}
                readLive={live(ch.bias)}
                moduleId={id}
                paramId={ch.bias}
              />
              <button
                type="button"
                class="over-pill"
                class:wrap={pget(ch.over) >= 0.5}
                data-testid={`colourofmagic-over-${ch.over}`}
                onclick={() => toggleOver(ch.over)}
                title="Overflow: CLAMP (clip) vs WRAP (fract)"
              >{overLabel(ch.over)}</button>
            </div>
          {/each}
        </div>

        <!-- HSV / HSL -->
        <div class="block" data-testid="colourofmagic-block-hsv">
          <div class="block-head">
            <span class="block-name">{isHsl ? 'HSL' : 'HSV'}</span>
            <button
              type="button"
              class="mode-toggle"
              class:on={isHsl}
              data-testid="colourofmagic-hsl"
              onclick={toggleHsl}
              title="Switch the third block between HSV and HSL"
            >{isHsl ? 'HSL' : 'HSV'}</button>
          </div>
          {#each HSV_CH as ch (ch.bias)}
            {@const r = paramRange(ch.bias)}
            <div class="chan">
              <Knob
                value={pget(ch.bias)}
                min={r.min}
                max={r.max}
                defaultValue={defaultFor(ch.bias)}
                label={ch.label}
                units={ch.deg ? 'deg' : ''}
                curve="linear"
                onchange={set(ch.bias)}
                readLive={live(ch.bias)}
                moduleId={id}
                paramId={ch.bias}
              />
              {#if ch.advisory}
                <span
                  class="over-pill advisory"
                  data-testid={`colourofmagic-over-${ch.over}`}
                  title="Hue always wraps — the wrap toggle is advisory here"
                >WRAP</span>
              {:else}
                <button
                  type="button"
                  class="over-pill"
                  class:wrap={pget(ch.over) >= 0.5}
                  data-testid={`colourofmagic-over-${ch.over}`}
                  onclick={() => toggleOver(ch.over)}
                  title="Overflow: CLAMP (clip) vs WRAP (fract)"
                >{overLabel(ch.over)}</button>
              {/if}
            </div>
          {/each}
        </div>

        <!-- YIQ (NTSC composite) -->
        <div class="block" data-testid="colourofmagic-block-yiq">
          <div class="block-head">
            <span class="block-name">YIQ</span>
          </div>
          {#each YIQ_CH as ch (ch.bias)}
            {@const r = paramRange(ch.bias)}
            <div class="chan">
              <Knob
                value={pget(ch.bias)}
                min={r.min}
                max={r.max}
                defaultValue={defaultFor(ch.bias)}
                label={ch.label}
                curve="linear"
                onchange={set(ch.bias)}
                readLive={live(ch.bias)}
                moduleId={id}
                paramId={ch.bias}
              />
              <button
                type="button"
                class="over-pill"
                class:wrap={pget(ch.over) >= 0.5}
                data-testid={`colourofmagic-over-${ch.over}`}
                onclick={() => toggleOver(ch.over)}
                title="Overflow: CLAMP (clip) vs WRAP (fract)"
              >{overLabel(ch.over)}</button>
            </div>
          {/each}
        </div>

        <!-- YCbCr studio-swing (broadcast-legal) -->
        <div class="block" data-testid="colourofmagic-block-ycc">
          <div class="block-head">
            <span class="block-name">YCbCr</span>
            <span class="block-sub" title="16–235 / 16–240 broadcast-legal — bias crushes super-black/white">legal</span>
          </div>
          {#each YCC_CH as ch (ch.bias)}
            {@const r = paramRange(ch.bias)}
            <div class="chan">
              <Knob
                value={pget(ch.bias)}
                min={r.min}
                max={r.max}
                defaultValue={defaultFor(ch.bias)}
                label={ch.label}
                curve="linear"
                onchange={set(ch.bias)}
                readLive={live(ch.bias)}
                moduleId={id}
                paramId={ch.bias}
              />
              <button
                type="button"
                class="over-pill"
                class:wrap={pget(ch.over) >= 0.5}
                data-testid={`colourofmagic-over-${ch.over}`}
                onclick={() => toggleOver(ch.over)}
                title="Overflow: CLAMP (clip) vs WRAP (fract)"
              >{overLabel(ch.over)}</button>
            </div>
          {/each}
        </div>
      </div>
    </div>
  </PatchPanel>
</div>

<style>
  .colourofmagic-card { width: 840px; }
  .stripe {
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    border-radius: 2px 2px 0 0;
  }
  .body {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 8px;
    margin-top: 8px;
  }
  .canvas-wrap {
    border: 1px solid var(--cable-video);
    border-radius: 2px;
    overflow: hidden;
    line-height: 0;
    background: #050608;
    align-self: center;
  }
  .canvas-wrap canvas {
    display: block;
    image-rendering: pixelated;
    background: #050608;
  }
  .preview-pills {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    justify-content: center;
  }
  .pill {
    background: #1a1f29;
    color: var(--text-dim, #9aa);
    border: 1px solid #2c333f;
    border-radius: 3px;
    padding: 2px 6px;
    font-size: 0.58rem;
    font-family: ui-monospace, monospace;
    letter-spacing: 0.03em;
    cursor: pointer;
  }
  .pill:hover { border-color: var(--cable-video); }
  .pill.active {
    background: var(--cable-video);
    color: #12060d;
    border-color: var(--cable-video);
    font-weight: 600;
  }
  .blocks {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 8px;
  }
  .block {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    background: #12161d;
    border: 1px solid #262d38;
    border-radius: 4px;
    padding: 6px 4px 8px;
    min-width: 0;
  }
  .block-head {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    width: 100%;
    min-height: 20px;
  }
  .block-name {
    font-size: 0.64rem;
    letter-spacing: 0.06em;
    color: var(--text);
    font-family: ui-monospace, monospace;
    font-weight: 600;
  }
  .block-sub {
    font-size: 0.48rem;
    letter-spacing: 0.04em;
    color: var(--text-dim, #9aa);
    font-family: ui-monospace, monospace;
    text-transform: uppercase;
  }
  .mode-toggle {
    background: #1a1f29;
    color: var(--text-dim, #9aa);
    border: 1px solid #333b47;
    border-radius: 3px;
    padding: 1px 6px;
    font-size: 0.55rem;
    font-family: ui-monospace, monospace;
    letter-spacing: 0.04em;
    cursor: pointer;
  }
  .mode-toggle:hover { border-color: var(--cable-video); }
  .mode-toggle.on {
    background: var(--cable-video);
    color: #12060d;
    border-color: var(--cable-video);
    font-weight: 600;
  }
  .chan {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 3px;
  }
  .over-pill {
    background: #161a22;
    color: var(--text-dim, #9aa);
    border: 1px solid #2c333f;
    border-radius: 2px;
    padding: 0 5px;
    font-size: 0.5rem;
    font-family: ui-monospace, monospace;
    letter-spacing: 0.04em;
    cursor: pointer;
    min-width: 44px;
    text-align: center;
  }
  .over-pill:hover { border-color: var(--cable-video); }
  .over-pill.wrap {
    color: #ffd24a;
    border-color: #ffd24a;
  }
  .over-pill.advisory {
    opacity: 0.4;
    cursor: default;
  }
  .swatches {
    display: flex;
    gap: 6px;
    justify-content: center;
    padding-top: 2px;
  }
  .swatches.dim { opacity: 0.45; }
  .swatch-wrap {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    cursor: pointer;
  }
  .swatch {
    width: 20px;
    height: 20px;
    border-radius: 3px;
    border: 1px solid #3a4250;
    display: block;
  }
  .swatch-label {
    font-size: 0.5rem;
    color: var(--text-dim, #9aa);
    font-family: ui-monospace, monospace;
  }
  .color-input {
    position: absolute;
    top: 0;
    left: 0;
    width: 20px;
    height: 20px;
    opacity: 0;
    cursor: pointer;
    border: none;
    padding: 0;
  }
</style>
