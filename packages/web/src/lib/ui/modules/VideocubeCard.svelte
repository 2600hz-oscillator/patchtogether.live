<script lang="ts">
  // VideocubeCard — UI for VIDEOCUBE (the video isomorph of the audio CUBE).
  //
  // 2-column body (mirrors CubeCard): LEFT = the video_out live preview + the 3
  // frametable SLOT pickers (LIVE input / LOAD a .frametable.png file); RIGHT =
  // the WRAP / MATERIAL / SCREEN toggles, the global READER row (SMOOTH/MORPH/
  // CHAOS + FREEZE + LIVE) and the CUBE knob bank. Every knob drives BOTH the
  // picture (the GL combine) and the derived audio drone. The card stays a
  // Canvas2D previewer (NO WebGL here) so it is OUT of the WebGL attest basis.
  // All jacks live on the yellow drill-down PATCH PANEL.
  import { onMount, onDestroy } from 'svelte';
  import { type NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import XyPad from '$lib/ui/controls/XyPad.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { useEngine } from '$lib/audio/engine-context';
  import { setNodeParam } from '$lib/graph/mutate';
  import { videocubeDef } from '$lib/video/modules/videocube';
  import {
    VIDEOCUBE_MODE_SMOOTH,
    VIDEOCUBE_MODE_MORPH,
    VIDEOCUBE_MODE_CHAOS,
  } from '$lib/video/videocube-core';
  import { atlasGeometry, FRAMETABLE_FILE_ACCEPT, FRAMETABLE_ATLAS_COLS, FRAMETABLE_ATLAS_ROWS } from '$lib/video/frametable-atlas';
  import type { VideoEngine } from '$lib/video/engine';
  import { VIDEO_RES } from '$lib/video/engine';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  type Slot = 'a' | 'b' | 'c';
  const SLOTS: readonly Slot[] = ['a', 'b', 'c'];
  const SLOT_LABEL: Record<Slot, string> = { a: 'FLOOR', b: 'WALL', c: 'CEIL' };

  function p(name: string): number {
    const def = videocubeDef.params.find((d) => d.id === name);
    return node?.params[name] ?? def?.defaultValue ?? 0;
  }
  function pmin(name: string): number { return videocubeDef.params.find((d) => d.id === name)!.min; }
  function pmax(name: string): number { return videocubeDef.params.find((d) => d.id === name)!.max; }
  function pdef(name: string): number { return videocubeDef.params.find((d) => d.id === name)!.defaultValue; }
  function punits(name: string): string | undefined { return videocubeDef.params.find((d) => d.id === name)!.units; }
  function set(paramId: string) { return (v: number) => setNodeParam(id, paramId, v); }

  // FIELD / SLICE knobs — these move BOTH the picture (the volumetric combine +
  // the cutting slice) AND the derived audio, through the one shared 3-D field.
  // (Same order as CubeCard's field/slice knobs.) The natural X/Y PAIRS that were
  // knobs — slice ROT X/ROT Y, and the temporal SCAN/SPREAD — are now DRAGGABLE
  // JOYSTICK pads (see the XyPad blocks below); ROT Z / Y stay knobs.
  const FIELD_KNOBS: Array<{ pid: string; label: string }> = [
    { pid: 'morph_fc', label: 'Morph' },
    { pid: 'connect', label: 'Connect' },
    { pid: 'connect_strength', label: 'Cnct Str' },
    { pid: 'crush', label: 'Crush' },
    { pid: 'space_crush', label: 'Space Crush' },
    { pid: 'space_diffuse', label: 'Space Diffuse' },
    { pid: 'slice_y', label: 'Y' },
    { pid: 'slice_rz', label: 'Rot Z' },
  ];

  // AUDIO-ONLY knobs — these change ONLY the derived sound, never the picture:
  // TUNE / FINE (pitch), FOLD (a west-coast wavefolder with no image analog),
  // LEVEL (output gain), plus the CHROMASTACK colour→sound controls CHROMA
  // (overall colour→timbre intensity) and MOTION (frame-change "alive" drive).
  // Grouped under the "audio only" section header so the card visibly separates
  // picture+sound knobs from sound-only ones.
  const AUDIO_KNOBS: Array<{ pid: string; label: string }> = [
    { pid: 'tune', label: 'Tune' },
    { pid: 'fine', label: 'Fine' },
    { pid: 'fold', label: 'Fold' },
    { pid: 'level', label: 'Level' },
    { pid: 'chroma_depth', label: 'Chroma' },
    { pid: 'motion', label: 'Motion' },
  ];

  // The orbit-camera VIEW bank. VIEW X / VIEW Y are now a JOYSTICK pad (below);
  // ZOOM and VIEW Z remain knobs (zoom has no obvious 2nd joystick axis; ROLL is
  // rarely swept). Picture-only — flies the volumetric render around the 3D solid.
  const VIEW_KNOBS: Array<{ pid: string; label: string }> = [
    { pid: 'view_zoom', label: 'Zoom' },
    { pid: 'view_rot_z', label: 'View Z' },
  ];

  // ── JOYSTICK live-CV reflection ──
  // Poll the effective (CV-modulated) value of each joystick axis so a patched CV
  // cable MOVES the pad dot in real time (the motorized-Knob behaviour). readParam
  // returns intrinsic-knob + most-recent CV sample; at rest it is constant, so the
  // set-if-changed guard means an idle module never churns reactivity.
  const JOY_AXES = ['slice_rx', 'slice_ry', 'scan', 'spread', 'view_rot_x', 'view_rot_y'] as const;
  let liveAxis = $state<Record<string, number>>({});
  function pollLiveAxes(): void {
    const e = engineCtx.get();
    if (!e || !node) return;
    for (const pid of JOY_AXES) {
      const v = e.readParam(node, pid);
      if (typeof v === 'number' && v !== liveAxis[pid]) liveAxis = { ...liveAxis, [pid]: v };
    }
  }
  // Effective value for a joystick axis: the live CV-modulated sample if we have
  // one, else the stored param (default before the engine handle stands up).
  function pv(pid: string): number { return liveAxis[pid] ?? p(pid); }

  // ── Toggles ──
  let wrapOn = $derived(p('wrap') >= 0.5);
  let materialHard = $derived(p('material') >= 0.5);
  let screenOn = $derived(p('screen_on') >= 0.5);
  function toggleWrap() { setNodeParam(id, 'wrap', wrapOn ? 0 : 1); }
  function toggleMaterial() { setNodeParam(id, 'material', materialHard ? 0 : 1); }
  function toggleScreen() { setNodeParam(id, 'screen_on', screenOn ? 0 : 1); }

  // ── Reader mode (global, all 3 rings) + FREEZE + LIVE ──
  const MODES = [
    { v: VIDEOCUBE_MODE_SMOOTH, label: 'SMOOTH' },
    { v: VIDEOCUBE_MODE_MORPH, label: 'MORPH' },
    { v: VIDEOCUBE_MODE_CHAOS, label: 'CHAOS' },
  ] as const;
  let mode = $derived(Math.round(p('reader_mode')));
  function pickMode(v: number) { setNodeParam(id, 'reader_mode', v); }
  let freezeOn = $derived(p('freeze') >= 0.5);
  let liveOn = $derived(p('live') >= 0.5);
  function toggleFreeze() { setNodeParam(id, 'freeze', freezeOn ? 0 : 1); }
  function toggleLive() { setNodeParam(id, 'live', liveOn ? 0 : 1); }

  // ── SLICE VIEW flavour — the colorize for the slice-viz output ports
  // (slice_out + the smooth/morph/chaos triptych). Picture-only; NOT audio. ──
  const SLICE_VIEWS = [
    { v: 0, label: 'TEX' },
    { v: 1, label: 'XRAY' },
    { v: 2, label: 'WEIGHTS' },
  ] as const;
  let sliceView = $derived(Math.round(p('slice_view')));
  function pickSliceView(v: number) { setNodeParam(id, 'slice_view', v); }

  // ── CHROMASTACK hue-character bank toggle (audio-only): MUSICAL ↔ INSTRUMENT.
  //    A small toggle in the "audio only" group (CV-gated via hue_mode_cv). ──
  let hueMode = $derived(Math.round(p('hue_mode'))); // 0 musical / 1 instrument
  function toggleHueMode() { setNodeParam(id, 'hue_mode', hueMode >= 1 ? 0 : 1); }

  // ── Video engine access (FrametableCard pattern). ──
  function getVideoEngine(): VideoEngine | null {
    const e = engineCtx.get();
    if (!e) return null;
    try { return e.getDomain<VideoEngine>('video') ?? null; }
    catch { return null; }
  }

  // ── Per-slot ingest: LIVE input vs LOAD a .frametable.png (session-only v1). ──
  let slotStatus = $state<Record<Slot, string | null>>({ a: null, b: null, c: null });
  let slotError = $state<Record<Slot, string | null>>({ a: null, b: null, c: null });

  function setLive(slot: Slot): void {
    const ve = getVideoEngine();
    if (!ve) return;
    // A tiny tagged clear element resets the factory's slot back to LIVE capture.
    const c = document.createElement('canvas');
    c.width = 1; c.height = 1;
    c.dataset.videocubeSlot = slot;
    c.dataset.videocubeClear = '1';
    ve.attachExternalSource(id, 'image', c);
    slotStatus[slot] = 'live';
    slotError[slot] = null;
  }

  async function onSlotFileChange(slot: Slot, ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    slotError[slot] = null;
    slotStatus[slot] = 'loading...';
    try {
      const bmp = await createImageBitmap(file);
      const geo = atlasGeometry(bmp.width, bmp.height);
      if (!geo.valid) {
        bmp.close?.();
        throw new Error(`not a ${FRAMETABLE_ATLAS_COLS}×${FRAMETABLE_ATLAS_ROWS} frametable atlas`);
      }
      const ve = getVideoEngine();
      if (!ve) throw new Error('video engine not ready');
      const c = document.createElement('canvas');
      c.width = bmp.width; c.height = bmp.height;
      const cx = c.getContext('2d');
      if (!cx) throw new Error('no 2d context');
      cx.drawImage(bmp, 0, 0);
      c.dataset.videocubeSlot = slot;
      ve.attachExternalSource(id, 'image', c);
      bmp.close?.();
      slotStatus[slot] = `file · ${geo.frames}f`;
    } catch (err) {
      slotError[slot] = err instanceof Error ? err.message : String(err);
      slotStatus[slot] = null;
    } finally {
      try { input.value = ''; } catch { /* */ }
    }
  }

  // ── Live preview of video_out + the two on-card visualizers (Cube-parity).
  //    CubeCard's card carries a SLICE cross-section + an OUTPUT-WAVEFORM readout
  //    beside its 3-D viz; VIDEOCUBE mirrors them here:
  //      • SLICE  — the module's slice_out FBO (the 2-D cutting-plane readout,
  //        renderSlicePort/sliceTarget). Blitted via the engine's per-port blit
  //        (blitOutputPortToDrawingBuffer), which ALSO requests the port render
  //        while unpatched, so the inline SLICE stays ALWAYS-ON. Honours the
  //        card's SLICE VIEW / READER / Y·ROT exactly as the slice_out jack.
  //      • WAVE   — the derived 256-sample surface-height wave (read('lastWave'),
  //        the same wave audio_out plays + scope_out draws), traced with Canvas2D
  //        exactly like CubeCard's OUTPUT waveform — no WebGL in the card, so the
  //        card stays OUT of the WebGL attest basis.
  //    All three go through the shared engine drawing buffer (Canvas2D drawImage
  //    of engine.canvas), the SAME mechanism the existing video_out preview uses.
  const ENGINE_W = VIDEO_RES.width;
  const ENGINE_H = VIDEO_RES.height;
  let canvasEl: HTMLCanvasElement | null = $state(null);
  let sliceCanvasEl: HTMLCanvasElement | null = $state(null);
  let waveCanvasEl: HTMLCanvasElement | null = $state(null);
  let rafId: number | null = null;

  // Aspect-fit blit of the engine's drawing buffer (holding whatever was just
  // blitted into it) onto a target 2-D card canvas, with a small corner label.
  function drawEngineCanvasInto(
    target: HTMLCanvasElement,
    src: CanvasImageSource,
    label: string,
  ): void {
    const ctx2d = target.getContext('2d', { alpha: false });
    if (!ctx2d) return;
    const cw = target.width, ch = target.height;
    ctx2d.fillStyle = '#050608';
    ctx2d.fillRect(0, 0, cw, ch);
    const srcAspect = ENGINE_W / ENGINE_H;
    const dstAspect = cw / ch;
    let w = cw, h = ch, x = 0, y = 0;
    if (dstAspect > srcAspect) { h = ch; w = Math.round(h * srcAspect); x = Math.round((cw - w) / 2); }
    else { w = cw; h = Math.round(w / srcAspect); y = Math.round((ch - h) / 2); }
    ctx2d.drawImage(src, x, y, w, h);
    if (label) {
      ctx2d.fillStyle = 'rgba(255,255,255,0.55)';
      ctx2d.font = '9px ui-monospace, monospace';
      ctx2d.fillText(label, 4, 11);
    }
  }

  // OUTPUT WAVEFORM trace (mirrors CubeCard.drawWave) — the derived cube-slice
  // wave (read('lastWave')). Null/silent before the audio worklet stands up → a
  // flat baseline (same warm-up as audio_out / scope_out).
  function drawWave(target: HTMLCanvasElement, wave: Float32Array | null): void {
    const ctx2d = target.getContext('2d');
    if (!ctx2d) return;
    const W = target.width, H = target.height;
    ctx2d.fillStyle = '#0a0c12';
    ctx2d.fillRect(0, 0, W, H);
    ctx2d.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx2d.beginPath(); ctx2d.moveTo(0, H / 2); ctx2d.lineTo(W, H / 2); ctx2d.stroke();
    if (wave && wave.length > 1) {
      ctx2d.strokeStyle = '#5ee08a';
      ctx2d.lineWidth = 1.4;
      ctx2d.beginPath();
      const n = wave.length;
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * W;
        const y = H / 2 - (wave[i] ?? 0) * (H / 2) * 0.92;
        if (i === 0) ctx2d.moveTo(x, y); else ctx2d.lineTo(x, y);
      }
      ctx2d.stroke();
    }
    ctx2d.fillStyle = 'rgba(255,255,255,0.5)';
    ctx2d.font = '9px ui-monospace, monospace';
    ctx2d.fillText('WAVE', 4, 11);
  }

  function draw() {
    rafId = null;
    pollLiveAxes(); // move the joystick dots under a patched CV
    const e = engineCtx.get();
    if (!e || !canvasEl) { rafId = requestAnimationFrame(draw); return; }
    let videoEngine: VideoEngine | undefined;
    try { videoEngine = e.getDomain<VideoEngine>('video'); }
    catch { rafId = requestAnimationFrame(draw); return; }
    if (!videoEngine) { rafId = requestAnimationFrame(draw); return; }
    const src = videoEngine.canvas as CanvasImageSource;
    // 1) video_out preview (primary surface).
    try { videoEngine.blitOutputToDrawingBuffer(id); } catch { /* never nuke the rAF loop */ }
    drawEngineCanvasInto(canvasEl, src, '');
    // 2) SLICE cross-section (slice_out FBO — per-port blit also keeps it rendering
    //    while unpatched, so the inline viz is always-on). Blit→drawImage before
    //    the next blit overwrites the shared drawing buffer.
    if (sliceCanvasEl) {
      try { videoEngine.blitOutputPortToDrawingBuffer(id, 'slice_out'); } catch { /* */ }
      drawEngineCanvasInto(sliceCanvasEl, src, 'SLICE');
    }
    // 3) AUDIO WAVEFORM (derived wave, Canvas2D — no drawing-buffer read).
    if (waveCanvasEl) {
      let wave: Float32Array | null = null;
      try { wave = videoEngine.read(id, 'lastWave') as Float32Array | null; } catch { /* */ }
      drawWave(waveCanvasEl, wave);
    }
    rafId = requestAnimationFrame(draw);
  }

  onMount(() => { rafId = requestAnimationFrame(draw); });
  onDestroy(() => { if (rafId !== null) cancelAnimationFrame(rafId); });

  const inputs = portsFromDef(videocubeDef.inputs, {
    video_a: 'A', video_b: 'B', video_c: 'C',
    morph_cv: 'MORPH', connect_cv: 'CONNECT', connect_strength_cv: 'CNCT STR',
    crush_cv: 'CRUSH', space_crush_cv: 'SPC CRUSH', space_diffuse_cv: 'SPC DIFF',
    slice_y_cv: 'Y', slice_rx_cv: 'ROT X', slice_ry_cv: 'ROT Y', slice_rz_cv: 'ROT Z',
    view_x_cv: 'VIEW X', view_y_cv: 'VIEW Y',
    fold_cv: 'FOLD', spread_cv: 'SPREAD', scan_cv: 'SCAN', tune_cv: 'TUNE',
  });
  const outputs = portsFromDef(videocubeDef.outputs, {
    video_out: 'VIDEO', audio_out: 'AUDIO',
    scope_out: 'SCOPE', slice_out: 'SLICE', depth_out: 'DEPTH',
    smooth_out: 'SMOOTH', morph_out: 'MORPH', chaos_out: 'CHAOS',
  });
</script>

<div class="vcard card video" data-testid="videocube-card" data-node-id={id}>
  <div class="stripe"></div>
  <ModuleTitle {id} {data} defaultLabel="VIDEOCUBE" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="vc-body">
      <!-- LEFT: preview + 3 slot pickers -->
      <div class="vc-col vc-left">
        <div class="preview-wrap">
          <canvas
            bind:this={canvasEl}
            width={200}
            height={150}
            data-testid="videocube-preview"
            data-node-id={id}
          ></canvas>
        </div>

        <!-- Cube-parity inline visualizers: the SLICE cross-section (slice_out
             FBO) + the derived AUDIO WAVEFORM (lastWave). Both always-on. -->
        <div class="viz-row">
          <canvas
            bind:this={sliceCanvasEl}
            class="viz"
            width={96}
            height={72}
            data-testid="videocube-slice-viz"
            data-node-id={id}
          ></canvas>
          <canvas
            bind:this={waveCanvasEl}
            class="viz"
            width={96}
            height={72}
            data-testid="videocube-wave-viz"
            data-node-id={id}
          ></canvas>
        </div>

        <div class="slots">
          {#each SLOTS as slot (slot)}
            <div class="slot-row" data-testid={`videocube-${slot}-select`}>
              <span class="slot-label">{SLOT_LABEL[slot]}</span>
              <button
                type="button"
                class="vc-btn nodrag"
                data-testid={`videocube-${slot}-live`}
                title="Use the connected LIVE video input for this slot"
                onclick={() => setLive(slot)}
              >LIVE</button>
              <label class="vc-btn nodrag file-load" data-testid={`videocube-${slot}-load`}
                title="Load a .frametable.png atlas into this slot (session-only in v1)">
                <input type="file" accept={FRAMETABLE_FILE_ACCEPT}
                  onchange={(ev) => onSlotFileChange(slot, ev)}
                  data-testid={`videocube-${slot}-file-input`} />
                <span>Load…</span>
              </label>
              {#if slotStatus[slot]}<span class="slot-status">{slotStatus[slot]}</span>{/if}
              {#if slotError[slot]}<span class="slot-error">{slotError[slot]}</span>{/if}
            </div>
          {/each}
        </div>

        <!-- JOYSTICK PADS (field/temporal X-Y pairs). The slice ROT X/ROT Y pair
             and the temporal SCAN(position)/SPREAD(width) pair are draggable 2-D
             pads; each axis is CV-assignable (slice_rx/ry_cv, scan/spread_cv) so a
             patched cable moves the dot. Both drive PICTURE + SOUND. They live in
             the LEFT column's spare height (the 3u tier's fixed height can't grow),
             grouped with the VIEW joystick's sibling in the VIEW bank at right. -->
        <div class="joy-label">joysticks</div>
        <div class="pad-row" data-testid="videocube-field-joysticks">
          <XyPad
            title="ROT X / Y"
            xLabel="rot x"
            yLabel="rot y"
            xValue={pv('slice_rx')}
            yValue={pv('slice_ry')}
            xMin={pmin('slice_rx')}
            xMax={pmax('slice_rx')}
            yMin={pmin('slice_ry')}
            yMax={pmax('slice_ry')}
            xDefault={pdef('slice_rx')}
            yDefault={pdef('slice_ry')}
            onXChange={set('slice_rx')}
            onYChange={set('slice_ry')}
            testid="videocube-slice-rot-joystick"
          />
          <XyPad
            title="Scan / Spread"
            xLabel="scan"
            yLabel="sprd"
            xValue={pv('scan')}
            yValue={pv('spread')}
            xMin={pmin('scan')}
            xMax={pmax('scan')}
            yMin={pmin('spread')}
            yMax={pmax('spread')}
            xDefault={pdef('scan')}
            yDefault={pdef('spread')}
            onXChange={set('scan')}
            onYChange={set('spread')}
            testid="videocube-scan-spread-joystick"
          />
        </div>
      </div>

      <!-- RIGHT: toggles + reader + knob bank -->
      <div class="vc-col vc-right">
        <div class="toggles">
          <button class="toggle nodrag" class:on={wrapOn} onclick={toggleWrap}
            data-testid="videocube-wrap-toggle"
            title="WRAP: clamp edges (off) or mirror-fold coords (on)">WRAP: {wrapOn ? 'ON' : 'OFF'}</button>
          <button class="toggle nodrag" class:on={materialHard} onclick={toggleMaterial}
            data-testid="videocube-material-toggle"
            title="MATERIAL: SMOOTH blend or HARD one-table-wins mosaic">MAT: {materialHard ? 'HARD' : 'SMOOTH'}</button>
          <button class="toggle nodrag" class:on={screenOn} onclick={toggleScreen}
            data-testid="videocube-screen-toggle"
            title="SCREEN: skip the combine render when off + video unpatched">SCRN: {screenOn ? 'ON' : 'OFF'}</button>
        </div>

        <div class="reader-row" data-testid="videocube-reader">
          {#each MODES as m (m.v)}
            <button type="button" class="vc-btn nodrag seg" class:on={mode === m.v}
              data-testid={`videocube-reader-${m.label.toLowerCase()}`}
              onclick={() => pickMode(m.v)}>{m.label}</button>
          {/each}
        </div>
        <div class="reader-row">
          <button type="button" class="vc-btn nodrag" class:on={freezeOn}
            data-testid="videocube-freeze" onclick={toggleFreeze}>{freezeOn ? 'FROZEN' : 'FREEZE'}</button>
          <button type="button" class="vc-btn nodrag" class:on={liveOn}
            data-testid="videocube-live" onclick={toggleLive}>{liveOn ? 'LIVE!' : 'LIVE'}</button>
        </div>

        <!-- SLICE VIEW: the colorize flavour for the slice-viz output ports
             (slice/smooth/morph/chaos). Each viz jack renders only when patched. -->
        <div class="reader-row" data-testid="videocube-slice-view">
          <span class="seg-label">SLICE</span>
          {#each SLICE_VIEWS as sv (sv.v)}
            <button type="button" class="vc-btn nodrag seg" class:on={sliceView === sv.v}
              data-testid={`videocube-slice-view-${sv.label.toLowerCase()}`}
              title="Colorize flavour for the slice/smooth/morph/chaos output jacks"
              onclick={() => pickSliceView(sv.v)}>{sv.label}</button>
          {/each}
        </div>

        <!-- FIELD / SLICE knobs: these change the PICTURE + the SOUND together. -->
        <div class="knobs" data-testid="videocube-field-knobs">
          {#each FIELD_KNOBS as k (k.pid)}
            <Knob
              value={p(k.pid)}
              min={pmin(k.pid)}
              max={pmax(k.pid)}
              defaultValue={pdef(k.pid)}
              label={k.label}
              units={punits(k.pid)}
              curve="linear"
              onchange={set(k.pid)}
              moduleId={id}
              paramId={k.pid}
            />
          {/each}
        </div>

        <!-- AUDIO ONLY: knobs that change ONLY the derived sound, not the picture
             (TUNE / FINE pitch, FOLD wavefolder, LEVEL gain, CHROMASTACK CHROMA +
             MOTION), plus the HUE-character bank toggle. -->
        <div class="audio-only-label">audio only</div>
        <div class="reader-row" data-testid="videocube-hue-mode">
          <span class="seg-label">HUE</span>
          <button type="button" class="vc-btn nodrag" class:on={hueMode >= 1}
            data-testid="videocube-hue-mode-toggle" onclick={toggleHueMode}
            title="Colour→timbre character bank: MUSICAL (tonal) or INSTRUMENT (analog↔digital)"
            >{hueMode >= 1 ? 'INSTR' : 'MUSIC'}</button>
        </div>
        <div class="knobs audio-only-knobs" data-testid="videocube-audio-knobs">
          {#each AUDIO_KNOBS as k (k.pid)}
            <Knob
              value={p(k.pid)}
              min={pmin(k.pid)}
              max={pmax(k.pid)}
              defaultValue={pdef(k.pid)}
              label={k.label}
              units={punits(k.pid)}
              curve="linear"
              onchange={set(k.pid)}
              moduleId={id}
              paramId={k.pid}
            />
          {/each}
        </div>

        <!-- VIEW: orbit camera (picture only). VIEW X/Y is a joystick pad (each
             axis CV-assignable via view_x_cv / view_y_cv); ZOOM + ROLL stay knobs. -->
        <div class="view-label">VIEW</div>
        <div class="pad-row view-row" data-testid="videocube-view">
          <XyPad
            title="View X / Y"
            xLabel="view x"
            yLabel="view y"
            xValue={pv('view_rot_x')}
            yValue={pv('view_rot_y')}
            xMin={pmin('view_rot_x')}
            xMax={pmax('view_rot_x')}
            yMin={pmin('view_rot_y')}
            yMax={pmax('view_rot_y')}
            xDefault={pdef('view_rot_x')}
            yDefault={pdef('view_rot_y')}
            onXChange={set('view_rot_x')}
            onYChange={set('view_rot_y')}
            testid="videocube-view-joystick"
          />
          <div class="knobs view-knobs">
            {#each VIEW_KNOBS as k (k.pid)}
              <Knob
                value={p(k.pid)}
                min={pmin(k.pid)}
                max={pmax(k.pid)}
                defaultValue={pdef(k.pid)}
                label={k.label}
                units={punits(k.pid)}
                curve="linear"
                onchange={set(k.pid)}
                moduleId={id}
                paramId={k.pid}
              />
            {/each}
          </div>
        </div>
      </div>
    </div>
  </PatchPanel>
</div>

<style>
  .card {
    width: 540px;
    min-height: 260px;
    padding-bottom: 8px;
  }
  .vc-body {
    display: flex;
    gap: 10px;
    padding: 6px 12px 0;
  }
  .vc-col { display: flex; flex-direction: column; gap: 8px; }
  .vc-left { flex: 0 0 210px; }
  .vc-right { flex: 1 1 auto; min-width: 0; }
  .preview-wrap {
    width: 200px;
    display: flex;
    justify-content: center;
  }
  .preview-wrap canvas {
    width: 200px;
    height: 150px;
    background: #050608;
    border: 1px solid var(--cable-video, #3aa);
    border-radius: 1px;
    display: block;
  }
  .viz-row {
    display: flex;
    gap: 6px;
    justify-content: flex-start;
  }
  .viz {
    width: 96px;
    height: 72px;
    background: #050608;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 2px;
    display: block;
    image-rendering: auto;
  }
  .slots { display: flex; flex-direction: column; gap: 5px; }
  .slot-row {
    display: flex;
    align-items: center;
    gap: 5px;
    flex-wrap: wrap;
  }
  .slot-label {
    font-size: 0.55rem;
    letter-spacing: 0.06em;
    color: var(--text-dim);
    width: 42px;
    font-family: ui-monospace, monospace;
  }
  .vc-btn {
    background: var(--module-bg);
    color: var(--text-dim);
    border: 1px solid var(--border);
    border-radius: 3px;
    font-size: 0.55rem;
    letter-spacing: 0.06em;
    padding: 4px 6px;
    cursor: pointer;
    font-family: ui-monospace, monospace;
    touch-action: none;
    user-select: none;
  }
  .vc-btn:hover { border-color: var(--accent-dim); }
  .vc-btn.on {
    background: var(--accent-dim, #46506b);
    color: var(--text);
    border-color: var(--accent, #6884d7);
  }
  .file-load { display: inline-flex; align-items: center; justify-content: center; }
  .file-load input[type='file'] { display: none; }
  .slot-status, .slot-error {
    font-size: 0.5rem;
    font-family: ui-monospace, monospace;
    letter-spacing: 0.03em;
    width: 100%;
    word-break: break-word;
  }
  .slot-status { color: var(--text-dim); }
  .slot-error { color: var(--cable-video, #e66); }
  .toggles { display: flex; gap: 5px; }
  .toggle {
    flex: 1;
    background: var(--module-bg);
    color: var(--text-dim);
    border: 1px solid var(--border);
    border-radius: 3px;
    font-size: 0.52rem;
    letter-spacing: 0.04em;
    padding: 4px 2px;
    cursor: pointer;
    font-family: ui-monospace, monospace;
  }
  .toggle:hover { border-color: var(--accent-dim); }
  .toggle.on {
    background: var(--accent-dim, #46506b);
    color: var(--text);
    border-color: var(--accent, #6884d7);
  }
  .reader-row { display: flex; gap: 5px; align-items: center; }
  .reader-row .vc-btn { flex: 1; text-align: center; }
  .reader-row .seg { font-size: 0.52rem; padding: 4px 2px; }
  .seg-label {
    font-size: 0.5rem;
    letter-spacing: 0.08em;
    color: var(--text-dim);
    font-family: ui-monospace, monospace;
    flex: 0 0 auto;
  }
  .knobs {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 4px 6px;
    margin-top: 2px;
  }
  .view-label,
  .audio-only-label,
  .joy-label {
    font-size: 0.5rem;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--text-dim);
    font-family: ui-monospace, monospace;
    margin-top: 4px;
    border-top: 1px solid var(--border);
    padding-top: 4px;
  }
  /* 6 audio-only knobs (Tune/Fine/Fold/Level + CHROMASTACK Chroma/Motion) fit on
     ONE row in the wide right column — 6 columns keeps the card within its tier
     height (a 4-col grid would wrap to a 2nd row and overflow the bottom edge). */
  .audio-only-knobs { margin-top: 2px; grid-template-columns: repeat(6, 1fr); }
  /* JOYSTICK pad rows: the draggable X/Y pads (+ the residual VIEW knobs) laid
     out side by side. flex-wrap keeps them within the right column's width on the
     3u/hp4 tier (the control-overflow gate). */
  .pad-row {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    flex-wrap: wrap;
    margin-top: 4px;
  }
  .view-row { align-items: center; }
  .view-knobs {
    margin-top: 0;
    grid-template-columns: repeat(2, 1fr);
    flex: 1 1 auto;
    align-self: center;
  }
</style>
