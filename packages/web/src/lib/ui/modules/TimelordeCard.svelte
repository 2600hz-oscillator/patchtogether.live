<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch, ydoc } from '$lib/graph/store';
  import { setNodeParam } from '$lib/graph/mutate';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import type { VideoEngine } from '$lib/video/engine';
  import ModuleTitle from './ModuleTitle.svelte';
  import {
    beatPulse,
    applyBeatBoost,
    wizardDisplayMode,
    type WizardDisplayMode,
  } from '$lib/audio/modules/timelorde-wizard';

  // The owner's folk-art OWL PAINTING — a bundled static asset (served at the
  // site root from packages/web/static/img). Drawn into the big display + used
  // as the small toggle thumbnail. Referenced by static path (the cadillac /
  // media-burn precedent) so the SAME url works for both <img> and a canvas
  // Image() load.
  const OWL_SRC = '/img/timelorde-owl.png';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  let cardVersion = $state(0);
  $effect(() => {
    const h = () => { cardVersion = cardVersion + 1; };
    ydoc.on('update', h);
    return () => ydoc.off('update', h);
  });

  // Live BPM the engine is currently locked to when an external clock
  // is patched (the worklet posts a measurement on each rising edge;
  // 0 means "no external lock right now, fall back to internal").
  // Polled at ~4 Hz — the worklet emits on edge so this just samples
  // the latest cached value.
  let measuredBpm = $state(0);
  $effect(() => {
    const e = engineCtx.get();
    if (!e || !node) return;
    const id = setInterval(() => {
      const v = e.read?.(node, 'measuredBpm');
      measuredBpm = typeof v === 'number' ? v : 0;
    }, 250);
    return () => clearInterval(id);
  });

  let bpm         = $derived((void cardVersion, node?.params.bpm         ?? 120));
  let swingAmount = $derived((void cardVersion, node?.params.swingAmount ?? 0));
  let swingSource = $derived((void cardVersion, node?.params.swingSource ?? 0));
  // v2: muteOutputs replaces isPlaying. Default 0 = unmuted/running.
  // Existing v1 patches save `isPlaying` (1=playing/0=stopped); the
  // factory's inline migrate-on-spawn flips them to muteOutputs, so
  // here we only read the new key.
  let muteOutputs = $derived((void cardVersion, (node?.params.muteOutputs ?? 0) >= 0.5));

  // running (v3): the GLOBAL transport. 1 = clock advances; 0 = HALTED (phase
  // freezes, gates go low). Distinct from MUTE (muteOutputs only silences gate
  // outputs; the internal clock keeps turning for LIVECODE). Every sequencer
  // locked to TIMELORDE — incl. the clip player — freezes when running = 0, so
  // this is the rack-wide stop/start.
  let running = $derived((void cardVersion, (node?.params.running ?? 1) >= 0.5));

  // wizardOn: the dot-matrix neon WIZARD graphic show/hide flag. Driven by
  // BOTH the on-card toggle button (toggleWizard, below) AND the `gate` input
  // level (the factory's pollWizardGate writes node.params.wizardOn from the
  // gate's level). They converge here on a single param — button = manual
  // override, gate = external control. Persisted on node.data + Y.Doc-synced.
  let wizardOn = $derived((void cardVersion, (node?.params.wizardOn ?? 1) >= 0.5));

  function toggleWizard() {
    set('wizardOn')(wizardOn ? 0 : 1);
  }

  // ---- Beat-pulse animation (the wizard flashes in time with the beat) ----
  //
  // The pulse intensity (0 dim … 1 flash) is computed by the PURE beatPulse()
  // helper from TIMELORDE's OWN bpm + running state (the same values the clock
  // worklet uses — we do NOT spin up a second clock; this is just a cheap
  // function of bpm and elapsed wall-clock time). An rAF loop re-evaluates it
  // each frame and writes the brightness to a CSS custom property.
  //
  // VRT/accessibility determinism: under `prefers-reduced-motion: reduce`
  // (which the VRT runner sets, alongside animations:'disabled') we DON'T run
  // the rAF loop and pin the pulse to 0 (the idle/dim frame) — so the card
  // renders one deterministic frame and stays in the strict VRT lane. Real
  // users without reduced-motion get the live beat pulse.
  let pulse = $state(0);
  // Wall-clock anchor: reset whenever the transport (re)starts so the flash
  // lands on the downbeat after a start rather than at an arbitrary offset.
  let beatAnchorMs = performance.now();
  let prevRunningForAnchor = running;

  function prefersReducedMotion(): boolean {
    return (
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    );
  }

  $effect(() => {
    // Re-anchor the beat phase on a stopped→running transition.
    if (running && !prevRunningForAnchor) beatAnchorMs = performance.now();
    prevRunningForAnchor = running;

    if (prefersReducedMotion()) {
      // Frozen, deterministic frame (VRT / reduced-motion): idle wizard.
      pulse = 0;
      return;
    }

    let raf: number | null = null;
    const tick = () => {
      // External-clock lock writes the measured tempo into node.params.bpm,
      // so reading the reactive `bpm` keeps the visual pulse on the real beat.
      pulse = beatPulse({
        bpm,
        running,
        nowMs: performance.now(),
        anchorMs: beatAnchorMs,
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      if (raf !== null) cancelAnimationFrame(raf);
      raf = null;
    };
  });

  // ── video_in → big display + video_out passthrough (cross-domain) ──
  //
  // TIMELORDE is an AUDIO module that also carries a `video_in` / `video_out`
  // pair so it can sit INLINE in a video chain. Both are consumed CARD-SIDE
  // (the SYNESTHESIA / WAVESCULPT-wall precedent — the audio engine has no
  // AudioNode for a video port): the card walks patch.edges to find the source
  // patched into video_in, blits its frame into the big display canvas, and
  // PUSHES that same frame back into the node (handle.write('displayFrame', …))
  // so video_out's drawFrame can pass it downstream. With nothing patched the
  // display shows the beat-pulsing wizard (the original behaviour) and we push
  // a snapshot of the wizard so video_out still emits a coherent picture.
  const DISPLAY_W = 220;
  const DISPLAY_H = 220;
  let displayCanvas: HTMLCanvasElement | null = $state(null);
  let displayRaf: number | null = null;

  // The owl painting, loaded once into an HTMLImageElement so the rAF can blit
  // it into the display each frame (then colour-key boost the eyes + border).
  // Until it decodes we paint the dark idle background, so the canvas is never
  // garbage. (createImageBitmap is overkill for a single static asset.)
  let owlImg: HTMLImageElement | null = null;
  let owlReady = $state(false);
  $effect(() => {
    if (typeof Image === 'undefined') return;
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => { owlImg = img; owlReady = true; };
    img.src = OWL_SRC;
    return () => { img.onload = null; owlImg = null; owlReady = false; };
  });
  // Off-screen scratch we composite into, then transfer to the node as an
  // ImageBitmap each frame (createImageBitmap is the cheapest DOM→node handoff,
  // and the node closes the previous bitmap — see timelorde.ts write()).
  let pushCanvas: HTMLCanvasElement | OffscreenCanvas | null = null;

  /** Resolve (nodeId, portId) currently patched into our video_in. */
  function findVideoInSource(): { nodeId: string; portId: string } | null {
    for (const eid of Object.keys(patch.edges)) {
      const e = patch.edges[eid];
      if (!e) continue;
      if (e.target?.nodeId === id && e.target?.portId === 'video_in') {
        return { nodeId: e.source.nodeId, portId: e.source.portId };
      }
    }
    return null;
  }

  let hasVideoIn = $derived.by(() => {
    void cardVersion;
    return findVideoInSource() !== null;
  });
  // The display mode is the PURE decision (video feed wins, else wizard/off).
  let displayMode: WizardDisplayMode = $derived(
    wizardDisplayMode({ hasVideoIn, wizardOn }),
  );

  function ensurePushCanvas(): HTMLCanvasElement | OffscreenCanvas | null {
    if (pushCanvas) return pushCanvas;
    if (typeof OffscreenCanvas !== 'undefined') {
      pushCanvas = new OffscreenCanvas(DISPLAY_W, DISPLAY_H);
    } else if (typeof document !== 'undefined') {
      const c = document.createElement('canvas');
      c.width = DISPLAY_W; c.height = DISPLAY_H;
      pushCanvas = c;
    }
    return pushCanvas;
  }

  /** Draw the LIVE video feed patched into video_in into a 2D context. Returns
   *  true on success (a frame was drawn). Mirrors SynesthesiaCard.readVideoLevels:
   *  a video-domain source blits via the VideoEngine; an audio-domain mono-video
   *  source pulls its drawFrame. */
  function drawVideoFeed(
    ctx2d: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    w: number,
    h: number,
  ): boolean {
    const e = engineCtx.get();
    if (!e) return false;
    const src = findVideoInSource();
    if (!src) return false;
    const srcNode = patch.nodes[src.nodeId];
    const srcDomain = srcNode?.domain ?? 'audio';
    if (srcDomain === 'video') {
      let ve: VideoEngine | undefined;
      try { ve = e.getDomain<VideoEngine>('video'); } catch { return false; }
      if (!ve) return false;
      try { ve.blitOutputToDrawingBuffer(src.nodeId); } catch { return false; }
      const img = ve.canvas as CanvasImageSource | undefined;
      if (!img) return false;
      try {
        ctx2d.clearRect(0, 0, w, h);
        ctx2d.drawImage(img, 0, 0, w, h);
        return true;
      } catch { return false; }
    }
    // Audio-domain mono-video / video source (SCOPE.out, WAVESCULPT.video_out,
    // even another TIMELORDE.video_out): pull its drawFrame into our scratch.
    let ae:
      | { getVideoSource?: (n: string, p: string) => { drawFrame?: (c: OffscreenCanvas | HTMLCanvasElement) => void } | null }
      | undefined;
    try { ae = e.getDomain('audio') as unknown as typeof ae; } catch { return false; }
    const vsrc = ae?.getVideoSource?.(src.nodeId, src.portId) ?? null;
    if (!vsrc?.drawFrame) return false;
    try {
      vsrc.drawFrame(ctx2d.canvas as OffscreenCanvas | HTMLCanvasElement);
      return true;
    } catch { return false; }
  }

  /** The owner's OWL PAINTING, painted into the big display. The owl fills the
   *  square (object-fit: contain, centred on the dark ground). After the blit
   *  we read the pixels back and apply the COLOUR-TARGETED beat boost
   *  (applyBeatBoost): the YELLOW EYES + the BLUE BORDER brighten by the pulse,
   *  the brown owl body stays steady — so only the eyes + border pulse with the
   *  music. (Pure per-pixel maths in timelorde-wizard.ts; this is the I/O.)
   *
   *  Until the image decodes we paint just the dark idle ground, so the display
   *  is never garbage (the same fallback the off-screen video_out idle uses). */
  function drawOwl(
    ctx2d: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    w: number,
    h: number,
    pulseNow: number,
  ): void {
    ctx2d.clearRect(0, 0, w, h);
    ctx2d.fillStyle = '#07090d';
    ctx2d.fillRect(0, 0, w, h);
    if (!owlImg || !owlReady) return;
    // object-fit: contain — preserve the painting's aspect, centred.
    const iw = owlImg.naturalWidth || owlImg.width;
    const ih = owlImg.naturalHeight || owlImg.height;
    if (!iw || !ih) return;
    const scale = Math.min(w / iw, h / ih);
    const dw = iw * scale;
    const dh = ih * scale;
    const dx = (w - dw) / 2;
    const dy = (h - dh) / 2;
    try {
      ctx2d.imageSmoothingEnabled = true;
      ctx2d.drawImage(owlImg, dx, dy, dw, dh);
    } catch {
      return; // image not yet usable (decode race) — idle ground stands
    }
    // Colour-key beat boost — only when pulsing (idle frame = the bare owl, so
    // the VRT capture under reduced-motion stays the deterministic steady owl).
    if (pulseNow <= 0) return;
    let frame: ImageData;
    try {
      frame = ctx2d.getImageData(0, 0, w, h);
    } catch {
      return; // tainted/locked canvas — skip the boost, owl still shows
    }
    applyBeatBoost(frame.data, pulseNow);
    ctx2d.putImageData(frame, 0, 0);
  }

  // rAF: paint the big display (live feed or wizard) + push the frame to the
  // node so video_out passes it through. Under reduced-motion (VRT) we still
  // paint ONE deterministic frame (pulse pinned to 0 by the effect above) and
  // then stop, so the capture is stable.
  function renderDisplay(): void {
    if (!displayCanvas) return;
    const ctx2d = displayCanvas.getContext('2d', { alpha: false });
    if (!ctx2d) return;
    const w = displayCanvas.width;
    const h = displayCanvas.height;
    let painted = false;
    if (hasVideoIn) {
      painted = drawVideoFeed(ctx2d, w, h);
    }
    if (!painted) {
      // No feed (or none patched) → the owl. (When wizardOff the visible card
      // shows the "wizard off" placeholder via markup; we still paint the owl
      // into the push canvas so video_out emits a coherent picture.)
      drawOwl(ctx2d, w, h, pulse);
    }
    // Push the composited display to the node for video_out passthrough.
    pushDisplayFrame();
  }

  function pushDisplayFrame(): void {
    const e = engineCtx.get();
    if (!e || !node || !displayCanvas) return;
    if (typeof createImageBitmap !== 'function') return;
    const scratch = ensurePushCanvas();
    if (!scratch) return;
    const sctx = scratch.getContext('2d') as
      | CanvasRenderingContext2D
      | OffscreenCanvasRenderingContext2D
      | null;
    if (!sctx) return;
    try {
      sctx.clearRect(0, 0, DISPLAY_W, DISPLAY_H);
      sctx.drawImage(displayCanvas, 0, 0, DISPLAY_W, DISPLAY_H);
    } catch { return; }
    void createImageBitmap(scratch as CanvasImageSource)
      .then((bmp) => {
        const eng = engineCtx.get();
        if (eng && node) eng.write(node, 'displayFrame', bmp);
        else { try { bmp.close(); } catch { /* */ } }
      })
      .catch(() => { /* best-effort — never break the rAF loop */ });
  }

  $effect(() => {
    // Track the inputs so the loop re-arms when video patch state / wizard
    // visibility / owl-image readiness changes (owlReady so the deterministic
    // reduced-motion frame repaints once the painting finishes decoding).
    void displayMode; void hasVideoIn; void displayCanvas; void owlReady;
    if (!displayCanvas) return;
    if (prefersReducedMotion()) {
      // One deterministic frame, then idle (VRT / reduced-motion).
      renderDisplay();
      return;
    }
    let raf: number | null = null;
    const loop = () => {
      renderDisplay();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    displayRaf = raf;
    return () => {
      if (raf !== null) cancelAnimationFrame(raf);
      raf = null;
      displayRaf = null;
    };
  });

  onDestroy(() => {
    if (displayRaf !== null) cancelAnimationFrame(displayRaf);
  });

  let hasExternalClock = $derived.by(() => {
    void cardVersion;
    for (const edge of Object.values(patch.edges)) {
      if (!edge) continue;
      if (edge.target.nodeId === id && edge.target.portId === 'clock') return true;
    }
    return false;
  });
  // When start_in / stop_in are patched, an external transport owns `running`
  // (MIDICLOCK etc.), so the card's transport button steps aside to avoid a fight.
  let transportSlaved = $derived.by(() => {
    void cardVersion;
    for (const edge of Object.values(patch.edges)) {
      if (!edge) continue;
      if (edge.target.nodeId === id && (edge.target.portId === 'start_in' || edge.target.portId === 'stop_in'))
        return true;
    }
    return false;
  });

  const set = (k: string) => (v: number) => setNodeParam(id, k, v);
  const live = (k: string) => () => {
    const e = engineCtx.get(); if (!e || !node) return undefined;
    return e.readParam(node, k);
  };

  function toggleMute() {
    // External clock no longer overrides — the user can mute the rack
    // even while MIDICLOCK drives TIMELORDE. The internal clock keeps
    // running for LIVECODE consumers regardless.
    set('muteOutputs')(muteOutputs ? 0 : 1);
  }
  function toggleRun() {
    // Global transport: halt/resume the whole rack clock. Musical position is
    // preserved (the worklet resumes from the frozen phase on restart).
    set('running')(running ? 0 : 1);
  }

  const OUT_LABELS = ['1x', '8x', '4x', '2x', '1/2', '1/3', '1/4', '1/8', '1/12', '1/16', '1/32', '1/64', 'swing'];
  const SRC_LABELS = ['1x', '8x', '4x', '2x', '1/2', '1/3', '1/4', '1/8', '1/12', '1/16', '1/32', '1/64'];

  const inputs: PortDescriptor[] = [
    { id: 'clock',    label: 'CLOCK IN', cable: 'gate' },
    // Transport gates — rising edge mirrors the ON / MUTE button.
    // Intended pairing: MIDICLOCK.midistart → START, MIDICLOCK.midistop → STOP.
    { id: 'start_in', label: 'START',    cable: 'gate' },
    { id: 'stop_in',  label: 'STOP',     cable: 'gate' },
    // ▭ = level-sensitive gate glyph. Drives the wizard show/hide (HIGH = on).
    { id: 'gate',     label: '▭ WIZARD', cable: 'gate' },
    // Patch a video feed here → the big display becomes a LIVE MONITOR of it
    // (the wizard steps aside) and video_out passes it through (inline in a
    // video chain). Unpatched → the display shows the wizard.
    { id: 'video_in', label: 'VIDEO IN', cable: 'video' },
  ];
  const outputs: PortDescriptor[] = [
    ...OUT_LABELS.map((label) => ({
      id: label,
      label: `CLOCK ${label.toUpperCase()}`,
      cable: 'gate' as const,
    })),
    // The picture the big display shows (live feed when video_in is patched,
    // else the wizard) — so TIMELORDE can sit inline in a video chain.
    { id: 'video_out', label: 'VIDEO OUT', cable: 'video' as const },
  ];
</script>

<div class="mod-card timelorde-card">
  <div class="stripe" style="background: var(--cable-gate);"></div>
  <header class="title">
    <ModuleTitle {id} {data} defaultLabel="TIMELORDE" inline />
    <!-- Global TRANSPORT (running): halts/resumes the whole rack clock — every
         sequencer locked to TIMELORDE (incl. the clip player) stops with it.
         Hidden when an external transport (start_in/stop_in) owns `running`. -->
    {#if !transportSlaved}
      <button class="play-btn run-btn" class:playing={running} onclick={toggleRun} title={running ? 'Stop transport (halt the rack clock)' : 'Start transport (resume the rack clock)'} data-testid={`timelorde-run-${id}`}>
        {running ? '■' : '▶'}
      </button>
    {/if}
    <!-- MUTE always shown (v2 — clock keeps running even when an
         external clock is patched; the mute only silences the gate
         outputs, not the internal phase that LIVECODE rides on). -->
    <button class="play-btn" class:playing={!muteOutputs} onclick={toggleMute} title={muteOutputs ? 'Unmute (gates fire)' : 'Mute (gates go silent; internal clock keeps running for LIVECODE)'}>
        {muteOutputs ? 'MUTE' : 'ON'}
      </button>
  </header>

  <!-- BIG SQUARE DISPLAY — ~4× the old sprite. Normally the owner's beat-pulsing
       OWL PAINTING: the owl is drawn into the canvas and its YELLOW EYES + BLUE
       BORDER brighten with the beat (the brown body stays steady — see
       applyBeatBoost). With a cable in video_in it becomes a LIVE MONITOR of
       that feed, and video_out passes the feed through. Rendered on a 2D canvas
       by the renderDisplay rAF (one frozen frame under reduced-motion / VRT —
       the steady owl, no boost). The small owl thumbnail toggle shows/hides it. -->
  <div class="wizard-wrap">
    <button
      class="wizard-toggle"
      class:on={wizardOn}
      onclick={toggleWizard}
      title={wizardOn ? 'Hide the owl' : 'Show the owl'}
      data-testid={`timelorde-wizard-toggle-${id}`}
    ><img class="wizard-thumb" src={OWL_SRC} alt="" draggable="false" /></button>
    <!-- The canvas is ALWAYS mounted (it feeds video_out's passthrough even
         when the visible card shows "wizard off"); we hide it visually in the
         wizard-off / no-feed case via the overlay below. -->
    <canvas
      bind:this={displayCanvas}
      class="display"
      class:hidden={displayMode === 'off'}
      width={DISPLAY_W}
      height={DISPLAY_H}
      data-testid={`timelorde-display-${id}`}
      data-display-mode={displayMode}
      style={`--wiz-pulse:${pulse.toFixed(3)};`}
    ></canvas>
    {#if displayMode === 'off'}
      <div class="wizard-off" data-testid={`timelorde-wizard-off-${id}`}>wizard off</div>
    {/if}
  </div>

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="knob-row">
      <Knob value={bpm}         min={10} max={300} defaultValue={120} label="BPM"   curve="log"      onchange={set('bpm')} moduleId={id} paramId="bpm"         readLive={live('bpm')} />
      <Knob value={swingAmount} min={0}  max={90}  defaultValue={0}   label="Swing" curve="linear"   onchange={set('swingAmount')} moduleId={id} paramId="swingAmount" readLive={live('swingAmount')} />
      <Knob value={swingSource} min={0}  max={10}  defaultValue={0}   label="Src"   curve="discrete" onchange={set('swingSource')} moduleId={id} paramId="swingSource" />
    </div>

    <div class="footer">
      {(hasExternalClock && measuredBpm > 0 ? measuredBpm : bpm).toFixed(0)} BPM ({hasExternalClock ? 'external' : 'internal'}) · src={SRC_LABELS[Math.round(swingSource)] ?? '1x'}
    </div>
  </PatchPanel>
</div>

<style>
  .timelorde-card {
    width: 300px;
    padding-bottom: 26px;
  }
  .timelorde-card > .title {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
  }
  .play-btn {
    width: 22px;
    height: 22px;
    background: #2a2f3a;
    border: 1px solid #404652;
    color: var(--text);
    border-radius: 3px;
    font-size: 0.7rem;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    line-height: 1;
    padding: 0;
  }
  .play-btn.playing {
    background: var(--cable-gate);
    color: #1a1d23;
    border-color: var(--cable-gate);
  }
  /* The global transport reads distinct from MUTE: accent-tinted while running. */
  .run-btn.playing {
    background: var(--accent, #6cf);
    border-color: var(--accent, #6cf);
    color: #1a1d23;
  }
  .knob-row {
    margin: 16px 0 0;
    display: flex;
    flex-direction: row;
    justify-content: center;
    gap: 14px;
  }
  .footer {
    margin-top: 12px;
    text-align: center;
    font-size: 0.6rem;
    color: var(--text-dim);
    font-family: ui-monospace, monospace;
    pointer-events: none;
  }

  /* ---- Big neon WIZARD / LIVE-VIDEO display ---- */
  .wizard-wrap {
    position: relative;
    margin: 12px 0 4px;
    display: flex;
    justify-content: center;
    align-items: center;
    min-height: 224px;
  }
  .wizard-toggle {
    position: absolute;
    top: -4px;
    right: 8px;
    width: 22px;
    height: 22px;
    background: #2a2f3a;
    border: 1px solid #404652;
    border-radius: 3px;
    line-height: 1;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    overflow: hidden;
    opacity: 0.55;
    filter: grayscale(1);
    z-index: 1;
  }
  /* A small thumbnail of the SAME owl painting (object-fit: cover so the owl
     fills the square chip). */
  .wizard-thumb {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
    pointer-events: none;
    -webkit-user-drag: none;
    user-select: none;
  }
  .wizard-toggle.on {
    opacity: 1;
    filter: none;
    border-color: var(--cable-gate);
    box-shadow: 0 0 4px var(--cable-gate);
  }
  /* The big square display canvas — the wizard glyph or the live video feed,
     painted by renderDisplay(). It's ~4× the old dot-matrix sprite. The glow +
     subtle beat-scale ride --wiz-pulse (pinned to 0 under reduced-motion/VRT,
     so the capture is a deterministic single frame). */
  .display {
    width: 220px;
    height: 220px;
    display: block;
    background: #07090d;
    border: 1px solid #1a1f2a;
    border-radius: 4px;
    box-shadow: 0 0 calc(2px + 10px * var(--wiz-pulse, 0)) var(--cable-gate, #ffd23f);
    transform: scale(calc(1 + 0.02 * var(--wiz-pulse, 0)));
    transform-origin: center bottom;
  }
  .display.hidden {
    /* wizard-off / no feed: keep the canvas mounted (it feeds video_out) but
       out of layout — the "wizard off" placeholder takes its place. */
    position: absolute;
    width: 1px;
    height: 1px;
    opacity: 0;
    pointer-events: none;
    box-shadow: none;
    transform: none;
  }
  .wizard-off {
    font-size: 0.6rem;
    letter-spacing: 0.1em;
    color: var(--text-dim);
    font-family: ui-monospace, monospace;
    padding: 100px 0;
    opacity: 0.5;
  }
  /* Reduced motion (also the VRT capture): no transform animation; the JS
     loop already pins pulse=0, so this is belt-and-braces for the scale. */
  @media (prefers-reduced-motion: reduce) {
    .display { transform: none; }
  }
</style>
