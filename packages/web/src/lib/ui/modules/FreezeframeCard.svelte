<script lang="ts">
  // FreezeframeCard — UI for FREEZEFRAME, the video sample & hold +
  // per-channel posterize module.
  //
  // Layout:
  //   Left:   video_in (VID) + gate_in (GATE).
  //   Right:  video_out (OUT) + r_out / g_out / b_out / luma_out (R/G/B/L).
  //   Body:   4 QUANT knobs (R/G/B/LUMA), the DECAY row (DECAY + INVERT
  //           switches, DECAY TIME fader) + a live preview of video_out.
  //
  // The S&H + posterize + decay logic lives in the module factory; this card
  // just wires the controls to node.params and shows a small preview of the
  // combined output (the canonical surface.texture), mirroring
  // FourPlexVidCard's blit.
  //
  // ⚠ RANGES COME FROM THE DEF, NEVER RE-TYPED HERE. `def('decay_time').min`
  // rather than `min={0.05}`: a card that restates a number its def already
  // declares is not a duplicate, it is a SECOND value that can silently
  // disagree — the backdraft ±0.2-vs-±1 defect, which every def-reading gate
  // was structurally blind to. (The QUANT faders' literal `min={0}`/`max={1}`
  // predate that rule; they agree with the def and card-def-agreement checks
  // that they keep agreeing.)
  import { onMount, onDestroy } from 'svelte';
  import { type NodeProps } from '@xyflow/svelte';
  import NeonFader from '$lib/ui/controls/NeonFader.svelte';
  import Toggle from '$lib/ui/controls/Toggle.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { useEngine } from '$lib/audio/engine-context';
  import { mutateNode, setNodeParam } from '$lib/graph/mutate';
  import { freezeframeDef } from '$lib/video/modules/freezeframe';
  import type { VideoEngine } from '$lib/video/engine';
  import { VIDEO_RES } from '$lib/video/engine';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { portsFromDef } from './card-kit';
  import { drawPreviewDownscaled } from './preview-downscale';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  function p(name: string): number {
    const def = freezeframeDef.params.find((d) => d.id === name);
    return node?.params[name] ?? def?.defaultValue ?? 0;
  }
  function setParam(paramId: string) {
    return (v: number) => setNodeParam(id, paramId, v);
  }
  function def(name: string) {
    return freezeframeDef.params.find((x) => x.id === name)!;
  }

  // ── THE DECAY ROW HAS TO FIT IN A HARD 540 px, and it is arithmetic ──────
  // freezeframe is a 3u/2hp card and the rack CLAMPS a 3u card to 540 CSS px —
  // that is a ceiling, not a min-height that grows. The first cut of this row
  // was a default 80 px-track Fader (a 94 px `.fader-wrap`, so a 112 px row)
  // and it put a control 35.8 px PAST the card's bottom edge. Nobody saw that
  // by looking; `card-control-overflow` measured it.
  //
  // Two changes pay for the row, and both figures below are MEASURED with the
  // gate's own metric — worst control-bottom minus card-bottom, in CSS px, so
  // xyflow's zoom transform can't inflate them:
  //
  //   44 px decay track  → a 58 px wrap, still taller than the 48 px toggles,
  //                        so the fader (not the switches) sets the row height
  //   QUANT grid margin 22→12 px and row gap 26→16 px  (two rows = ONE gap)
  //
  //   before:  +35.8 px  (overflowing)
  //   after:   −30.2 px  (deepest control sits 30 px ABOVE the card's edge)
  //
  // The QUANT faders themselves are untouched. ⚠ Re-measure before adding
  // anything else here — 30 px is one short row's worth of slack and no more.
  const DECAY_TRACK_PX = 44;

  // ── SCREEN ON / OFF (owner ruling, 2026-08-18) ──────────────────────────
  //
  // "'screen on / off' on the card like that is a thing all video modules
  // should have moving forward." backdraft's BackdraftOutputBody is the
  // reference and this is the same mechanism, deliberately: the state lives on
  // `node.data`, so it PERSISTS across tab switches (the owner's stated floor),
  // survives remount and reload, and syncs to collaborators.
  //
  // ⚠ IT IS NOT TRANSIENT RENDER STATE. One boolean per CLICK, never per frame
  // — the Y.Doc write-storm rule is about per-frame CV writes, and a click is
  // exactly what `node.data` is for.
  //
  // ⚠ OFF DOES NOT STOP THE MODULE. The rAF `draw()` loop below is untouched
  // and the video engine goes on rendering; only the BLIT into this card's
  // canvas is skipped. That is the #1720/#1721 bug class — tearing the producer
  // down means switching the screen back on shows a STALE frame (or black)
  // instead of the live picture. Absent ⇒ false ⇒ preview ON, so every existing
  // rack opens unchanged.
  let previewCollapsed = $derived<boolean>(
    (node?.data?.previewCollapsed as boolean | undefined) ?? false,
  );
  function togglePreview(): void {
    const next = !previewCollapsed;
    mutateNode(id, (live) => {
      if (!live.data) live.data = {};
      live.data.previewCollapsed = next;
    });
  }

  const inputs = portsFromDef(freezeframeDef.inputs, { video_in: 'VIDEO', gate_in: 'GATE' });
  const outputs = portsFromDef(freezeframeDef.outputs, {
    video_out: 'OUT', r_out: 'R', g_out: 'G', b_out: 'B', luma_out: 'LUMA',
  });

  // --- Live preview of video_out (the canonical surface.texture). ---
  const ENGINE_W = VIDEO_RES.width;
  const ENGINE_H = VIDEO_RES.height;
  // Bigger on-card preview (fills the previously-empty card body). 4:3 box.
  const PREVIEW_W = 228;
  const PREVIEW_H = Math.round(PREVIEW_W * (ENGINE_H / ENGINE_W)); // 171
  let canvasEl: HTMLCanvasElement | null = $state(null);
  let rafId: number | null = null;

  function draw() {
    rafId = null;
    const e = engineCtx.get();
    if (!e || !canvasEl) { rafId = requestAnimationFrame(draw); return; }
    // SCREEN OFF — skip the BLIT, never the LOOP. Re-arming the rAF here is the
    // whole point: the module and the video engine go on rendering, so turning
    // the screen back on paints the LIVE frame on the very next tick instead of
    // whatever was left in the canvas (#1720/#1721). Returning without
    // re-arming would be the stale-frame bug wearing a performance costume.
    if (previewCollapsed) { rafId = requestAnimationFrame(draw); return; }
    let videoEngine: VideoEngine | undefined;
    try { videoEngine = e.getDomain<VideoEngine>('video'); }
    catch { rafId = requestAnimationFrame(draw); return; }
    if (!videoEngine) { rafId = requestAnimationFrame(draw); return; }
    const ctx2d = canvasEl.getContext('2d', { alpha: false });
    if (ctx2d) {
      // #1802 — gated preview blit (see VideoEngine.blitOutputForPreview).
      let blitted = false;
      try { blitted = videoEngine.blitOutputForPreview(id); } catch { /* never nuke the rAF loop */ }
      if (!blitted) { rafId = requestAnimationFrame(draw); return; }
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
      drawPreviewDownscaled(ctx2d, src, x, y, w, h);
    }
    rafId = requestAnimationFrame(draw);
  }

  onMount(() => { rafId = requestAnimationFrame(draw); });
  onDestroy(() => { if (rafId !== null) cancelAnimationFrame(rafId); });
</script>

<div class="vcard card video" data-testid="freezeframe-card" data-node-id={id}>
  <div class="stripe"></div>
  <ModuleTitle {id} {data} defaultLabel="FREEZEFRAME" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <!-- video_out live preview (enlarged to fill the card body) -->
    <div class="preview-wrap" class:collapsed={previewCollapsed}>
      <!-- SCREEN ON/OFF — owner ruling 2026-08-18: every video module's card
           carries this.
           ⚠ IT OVERLAYS THE PICTURE; IT DOES NOT TAKE A ROW. That is the house
           pattern (SpirographsCard) and it is a FIX rather than a style choice:
           spirographs stacked this button under its canvas, which added
           ~18.8 px to a card with ~11 px of slack and produced a measured
           7.8 px bottom overflow the card sweep caught. This card has more
           slack (30.2 px) and an earlier draft did ride the OUT caption row for
           ~6 px, which measured clean — but "clean today" is still slack spent
           on a control the owner has made universal, and two cards carrying the
           same required control should not carry it two different ways. The
           overlay costs ZERO layout height, so the expanded card is exactly the
           height it was before this feature. -->
      <div class="canvas-holder">
        <canvas
          bind:this={canvasEl}
          width={PREVIEW_W}
          height={PREVIEW_H}
          data-testid="freezeframe-preview"
          data-node-id={id}
        ></canvas>
        <button
          type="button"
          class="screen-btn nodrag"
          class:on={!previewCollapsed}
          data-testid="freezeframe-preview-toggle"
          aria-pressed={!previewCollapsed}
          title={previewCollapsed
            ? 'SCREEN is OFF — the preview is collapsed and its space reclaimed. FREEZEFRAME keeps rendering: switching it back on shows the LIVE picture, not a stale frame.'
            : 'SCREEN — turn the preview off to collapse it and reclaim the vertical space. The module goes on rendering either way.'}
          onclick={togglePreview}
        >{previewCollapsed ? 'SCREEN OFF' : 'SCREEN ON'}</button>
      </div>
      <span class="preview-label">OUT</span>
    </div>

    <div class="fader-grid">
      <NeonFader value={p('quant_r')}    min={0} max={1} defaultValue={def('quant_r').defaultValue}    label="QUANT R"    curve="linear" onchange={setParam('quant_r')}    moduleId={id} paramId="quant_r" />
      <NeonFader value={p('quant_g')}    min={0} max={1} defaultValue={def('quant_g').defaultValue}    label="QUANT G"    curve="linear" onchange={setParam('quant_g')}    moduleId={id} paramId="quant_g" />
      <NeonFader value={p('quant_b')}    min={0} max={1} defaultValue={def('quant_b').defaultValue}    label="QUANT B"    curve="linear" onchange={setParam('quant_b')}    moduleId={id} paramId="quant_b" />
      <NeonFader value={p('quant_luma')} min={0} max={1} defaultValue={def('quant_luma').defaultValue} label="QUANT LUMA" curve="linear" onchange={setParam('quant_luma')} moduleId={id} paramId="quant_luma" />
    </div>

    <!-- PHOSPHOR DECAY. Only observable while the image is FROZEN — a captured
         frame is age zero, so with GATE unpatched these do nothing visible.
         That is the effect's definition, not a card bug; the authored docs on
         the def say it in the user's words. -->
    <div class="decay-row">
      <Toggle
        value={p('decay')}
        label={def('decay').label}
        hint="held frames fade"
        onchange={setParam('decay')}
        moduleId={id}
        paramId="decay"
      />
      <Toggle
        value={p('decay_invert')}
        label={def('decay_invert').label}
        hint="to white"
        onchange={setParam('decay_invert')}
        moduleId={id}
        paramId="decay_invert"
      />
      <NeonFader
        value={p('decay_time')}
        min={def('decay_time').min}
        max={def('decay_time').max}
        defaultValue={def('decay_time').defaultValue}
        label={def('decay_time').label}
        units={def('decay_time').units}
        curve={def('decay_time').curve}
        trackHeight={DECAY_TRACK_PX}
        onchange={setParam('decay_time')}
        moduleId={id}
        paramId="decay_time"
      />
    </div>
  </PatchPanel>
</div>

<style>
  .card {
    width: 260px;
    min-height: 460px;
  }
  .preview-wrap {
    margin: 8px auto 0;
    width: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
  }
  .preview-wrap canvas {
    width: 228px;
    height: 171px;
    max-width: calc(100% - 28px);
    background: #050608;
    border: 1px solid var(--cable-video);
    border-radius: 1px;
    image-rendering: pixelated;
    display: block;
  }
  .preview-label { font-size: 0.55rem; color: var(--text-dim); letter-spacing: 0.1em; font-family: ui-monospace, monospace; }
  /* ⚠ THE SCREEN SWITCH COSTS ZERO LAYOUT HEIGHT, and on this card that is a
     deliberate match to SpirographsCard rather than an independent choice.
     Stacking the button in a row of its own is what produced a measured 7.8 px
     bottom overflow there; overlaying it on the picture's bottom-right corner
     means the expanded card is exactly the height it was before the feature.
     This card has 30.2 px of slack and could have afforded a row — the reason
     not to is that a control the owner has made universal should look and
     behave the same on every video card. */
  .canvas-holder {
    position: relative;
    display: flex;
    justify-content: center;
    /* Load-bearing ONLY when the canvas is gone: with SCREEN off the holder
       would otherwise collapse to zero height and carry the absolutely
       positioned button off the card with it. Far smaller than the 171 px
       canvas, so it is inert whenever the picture is showing. */
    min-height: 16px;
  }
  .screen-btn {
    position: absolute;
    right: 2px;
    bottom: 2px;
    font-size: 0.55rem;
    letter-spacing: 0.06em;
    font-family: ui-monospace, monospace;
    line-height: 1;
    padding: 2px 8px;
    border-radius: 2px;
    cursor: pointer;
    border: 1px solid var(--border, #2a3040);
    /* Legible over a LIVE picture — a transparent background is not. */
    background: rgba(5, 6, 8, 0.72);
    color: var(--text-dim);
  }
  .screen-btn.on {
    color: var(--text, #cfd6e4);
    border-color: var(--cable-video, #7a5cff);
  }
  /* OFF collapses the canvas and RECLAIMS its height. The holder's min-height
     and the OUT caption both stay, so the control that turns the picture back
     on never disappears with it. */
  .preview-wrap.collapsed canvas {
    display: none;
  }
  .fader-grid {
    /* 22px→12px margin and 26px→16px row gap: 20px reclaimed for the DECAY row
       inside the 3u card's hard 540px clamp. See DECAY_TRACK_PX above. */
    margin-top: 12px;
    padding: 0 14px;
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 16px 6px;
    justify-items: center;
  }
  .decay-row {
    margin-top: 8px;
    padding: 0 14px;
    display: grid;
    /* The fader is the tall item; the switches sit on the same baseline as its
       track rather than floating at the top of the row. */
    grid-template-columns: repeat(3, 1fr);
    align-items: end;
    gap: 6px;
    justify-items: center;
  }
</style>
