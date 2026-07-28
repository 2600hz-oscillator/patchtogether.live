<script lang="ts">
  // BackdraftCard — UI for BACKDRAFT (video feedback generator).
  //
  // A CONTROL SURFACE with an ON-DEMAND output screen.
  //
  // ── What changed and why ─────────────────────────────────────────────────
  // BACKDRAFT is a video PROCESSOR with ~20 faders, mode rows and (with the
  // virtual camera) a joystick section. The old card spent more than half its
  // width on an always-on live thumbnail of its own output and squeezed every
  // control into a fixed 280px column — which is what made it "a mess", and
  // what made it overflow its own bottom edge the moment a mode-conditional
  // row was added. So the IN-RACK PREVIEW is gone and the full card width goes
  // to the controls, grouped into labelled banks.
  //
  // ── What did NOT go with it ──────────────────────────────────────────────
  // Full Frame / Full Screen / Present-on-another-display are PERFORMANCE
  // features, not preview decoration, so they stay — they simply no longer
  // hang off a thumbnail. The output <canvas> is still here; it is just INERT
  // (1px, invisible, not drawn) until the card is in one of those expanded
  // modes, and it is reached from an explicit OUTPUT button instead of a
  // right-click on a preview that no longer exists. Net effect in the rack:
  // the card stops doing a per-frame GL readback it was only doing to paint a
  // thumbnail, so it is CHEAPER than before, and every presentation route the
  // old card had still works.
  //
  // What genuinely went away is the CORNER-DRAG RESIZE (its whole job was
  // scaling that thumbnail) and with it the persisted node.data.width/height.
  // The card is a fixed 5hp × 3u rack tier (rack-sizes.ts); stale width/height
  // on an already-saved patch are ignored rather than half-honoured. A
  // full-framed BACKDRAFT is therefore a fixed-size video panel — for an
  // arbitrarily-sized one, patch OUT into VIDEO OUT, which is still resizable.
  //
  // A rAF loop runs always, but in the rack it ONLY reflects gate-driven param
  // changes (mirror / shape / pure-geo / TV mode toggled by a rising edge
  // INSIDE the engine) back into the patch store so the buttons show live
  // state. The blit runs only while expanded.
  //
  // Every port (2 video + 2 KEY masks + CV/gate inputs + the `out` video
  // output) lives in the yellow PatchPanel drill-down. Every Fader carries
  // moduleId={id} + paramId so MIDI-Learn binds.

  import { onMount, onDestroy } from 'svelte';
  import { type NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { useEngine } from '$lib/audio/engine-context';
  import { patch, ydoc } from '$lib/graph/store';
  import { setNodeParam, mutateNode } from '$lib/graph/mutate';
  import { createFullscreen } from './use-fullscreen.svelte';
  import { createFullFrame } from './use-full-frame.svelte';
  import { createPresent } from './use-present.svelte';
  import { fullscreenCanvasDims } from './fullscreen-canvas-dims';
  import { liveEngineAspect } from './video-card-aspect';
  import VideoCanvasContextMenu from './VideoCanvasContextMenu.svelte';
  import type { VideoEngine } from '$lib/video/engine';
  import { VIDEO_RES } from '$lib/video/engine';
  import {
    backdraftDef,
    BACKDRAFT_SHAPES,
    BACKDRAFT_TV_MODE_LABELS,
    BACKDRAFT_TV_MODE_COUNT,
    backdraftNextTvMode,
    backdraftTvFill,
    backdraftTvDepth,
    backdraftTvGain,
    backdraftTvOpNorm,
    backdraftTvAgcRate,
    BACKDRAFT_FLICKER_OPTIONS,
    BACKDRAFT_FLICKER_HZ,
    backdraftBeatHz,
    backdraftStorageResponse,
    backdraftNextShape,
  } from '$lib/video/modules/backdraft';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  // ── THE DEF OWNS EVERY CONTROL RANGE ──────────────────────────────────────
  // A control's min/max/default is read STRAIGHT off the ParamDef — never
  // retyped as a literal here. A card that restates a range can drift from the
  // contract, and that drift is INVISIBLE to every gate we have: contract-lock,
  // the docs lint and the def unit tests all read the def, so they agree with
  // themselves while the card lies. That is not hypothetical — both camera
  // joysticks shipped hardcoded ±1 against a def constrained to ±0.2 / ±0.5,
  // so the sticks WROTE values the contract forbids and the model silently
  // clamped them; most of the travel did nothing. Deriving from the def makes
  // that class of bug unrepresentable. `card-control-ranges.test.ts` pins it.
  function pdefOf(name: string) {
    const def = backdraftDef.params.find((d) => d.id === name);
    if (!def) throw new Error(`BackdraftCard: no param def for "${name}"`);
    return def;
  }
  function pdef(name: string): number {
    return pdefOf(name).defaultValue;
  }
  function pmin(name: string): number {
    return pdefOf(name).min;
  }
  function pmax(name: string): number {
    return pdefOf(name).max;
  }
  function p(name: string): number {
    const def = backdraftDef.params.find((d) => d.id === name);
    return node?.params[name] ?? def?.defaultValue ?? 0;
  }
  function setParam(paramId: string) {
    return (v: number) => setNodeParam(id, paramId, v);
  }

  // ── FADER LENGTH IS DERIVED FROM THE TIER, NOT PICKED ────────────────────
  // The rack pins this card to EXACTLY 2u = 360px (min AND max height), so any
  // height the content does not use is dead grey on every instance. Everything
  // above the fader banks is fixed:
  //
  //   49  chrome    (border 1 + .vcard pad-top 18 + title 16 + margin 8 + 6)
  //   64  switches  (two 22px mode rows + two 10px gaps)
  //   11  banks     (border-top 1 + padding-top 10)
  //   25  footer    (.bd-body pad-bottom 10 + .vcard pad-bottom 14 + border 1)
  //  ───
  //  149  →  211px left for a bank, and a bank is
  //          title 10 + gap 4 + [track H + 2px border + 4 gap + ~12 label]
  //          = H + 32, so H = 179 fills the tier exactly.
  //
  // 176 leaves a 3px cushion for sub-pixel label metrics. The card-control-
  // overflow gate is what actually holds this honest — if a future control row
  // pushes past the tier it goes red rather than silently clipping.
  //
  // The long throw is a genuine control win too, not just space-filling: 176px
  // spreads each param over 2.2× the pixels an 80px fader gives, which matters
  // on a feedback module where FB and ZOOM are usably adjustable only near
  // their top end.
  const FADER_H = 176;

  // ---- MIRROR X / MIRROR Y kaleidoscope toggles ----
  // Each button flips a boolean param (mirrorX / mirrorY). A rising edge on
  // the matching gate input also flips it in the engine; the button reflects
  // the (possibly gate-toggled) param value.
  let mirrorXOn = $derived(p('mirrorX') >= 0.5);
  let mirrorYOn = $derived(p('mirrorY') >= 0.5);
  function toggleMirror(paramId: 'mirrorX' | 'mirrorY') {
    return () => {
      setNodeParam(id, paramId, (p(paramId) ?? 0) >= 0.5 ? 0 : 1);
    };
  }

  // ---- SHAPE (cycle) + PURE GEO (toggle) geometry mask ----
  // The SHAPE button cycles square→circle→pentagon→triangle→octagon (also
  // driven by a rising edge on shape_gate); the PURE GEO button toggles the
  // masking space (also driven by pure_geo_gate). The buttons reflect the
  // (possibly gate-driven) engine value via syncFromEngine below.
  let shapeIdx = $derived(
    Math.max(0, Math.min(BACKDRAFT_SHAPES.length - 1, Math.round(p('shape')))),
  );
  let shapeName = $derived(BACKDRAFT_SHAPES[shapeIdx] ?? 'square');
  let pureGeoOn = $derived(p('pureGeo') >= 0.5);

  // ---- TV MODE (3-position cycle: OFF / PURE TV / CRITICAL) ----
  // The button cycles; a rising edge on tv_gate cycles the same param in the
  // engine, and the reconcile effect below mirrors that back into the store.
  let tvModeIdx = $derived(
    Math.max(0, Math.min(BACKDRAFT_TV_MODE_COUNT - 1, Math.round(p('tvMode')))),
  );
  let tvOn = $derived(tvModeIdx > 0);
  let tvCritical = $derived(tvModeIdx === 2);
  function cycleTvMode(): void {
    setNodeParam(id, 'tvMode', backdraftNextTvMode(p('tvMode')));
  }
  // Readouts. The band count is the HONEST one — the level at which the bezel
  // band (the only thing separating level k from k+1) goes sub-pixel, which is
  // the binding constraint, not the amplitude or resolution ceiling.
  let tvFill = $derived(backdraftTvFill(p('zoom')));
  let tvDepth = $derived(backdraftTvDepth({
    fill: tvFill,
    gain: backdraftTvGain(
      backdraftTvOpNorm({ r: p('r'), g: p('g'), b: p('b'), luma: p('luma'), chroma: p('chroma') }),
      p('feedback'), 1,
    ),
    widthPx: 1024,
  }));
  // CRITICAL's servo rate, and which side of the bifurcation it is on. DRIVE
  // 0.5 is the measured Hopf point: below it the nest is dead still, above it
  // it breathes.
  let tvRate = $derived(backdraftTvAgcRate(p('drive')));
  let tvRiding = $derived(p('drive') >= 0.5);
  function cycleShape() {
    setNodeParam(id, 'shape', backdraftNextShape(p('shape')));
  }
  function togglePureGeo() {
    setNodeParam(id, 'pureGeo', pureGeoOn ? 0 : 1);
  }

  // ---- FLICKER (6-position discrete: OFF / 6 / 24 / 50 / 60 / 120 Hz) ----
  // A labelled button row rather than a detent Fader, so all six positions
  // read at a glance (the FrametableCard MODE idiom).
  const FLICKERS = BACKDRAFT_FLICKER_OPTIONS.map((key, v) => {
    const hz = BACKDRAFT_FLICKER_HZ[v] ?? 0;
    const beat = backdraftBeatHz(hz);
    const store = backdraftStorageResponse(beat);
    // Fast beats are cut hard by the camera's storage integrator (soft
    // shimmer); slow ones pass essentially untouched (full breathing swing).
    const character = store.mag < 0.35 ? 'a soft shimmer' : 'a slow breathing swell';
    return {
      v,
      key,
      label: key === 'off' ? 'OFF' : key,
      // Tooltip carries the physics: what beats against the 60fps virtual
      // camera, and what the camera's own storage does to that beat.
      title:
        key === 'off'
          ? 'FLICKER OFF — constant loop gain (feedback saturates to white and stays there). The exact pre-FLICKER behaviour.'
          : `FLICKER ${key}Hz — the display emits pulses at ${hz.toFixed(2)}Hz, ` +
            `beating against the 60fps virtual camera at ${beat.toFixed(2)}Hz. ` +
            `The camera's multi-frame storage passes ${(store.mag * 100).toFixed(0)}% of that beat, ` +
            `so it reads as ${character}.`,
    };
  });
  let flickerIdx = $derived(
    Math.max(0, Math.min(FLICKERS.length - 1, Math.round(p('flicker')))),
  );
  function pickFlicker(v: number) {
    setNodeParam(id, 'flicker', v);
  }

  // ---- DELAY CLOCK override indicator ----
  // When a cable is patched into the `delay_clock` input, the clock drives
  // the feedback delay (one pulse = the delay time) and OVERRIDES the DELAY
  // knob. We show a small "CLK" badge + dim the Delay fader so it reads as
  // overridden. patch.edges is a SyncedStore/Yjs proxy (not a Svelte signal),
  // so we bump a real $state from a Yjs observer to stay reactive on cable
  // add/remove — same pattern as DoomCard's edgesVersion.
  let edgesVersion = $state(0);
  let clockPatched = $derived.by<boolean>(() => {
    void edgesVersion;
    for (const edge of Object.values(patch.edges)) {
      if (!edge) continue;
      if (edge.target.nodeId === id && edge.target.portId === 'delay_clock') return true;
    }
    return false;
  });
  let edgesUnobserve: (() => void) | null = null;

  // ---------------- Output surface (Full Frame / Full Screen / Present) ------
  // The <canvas> below is NOT an in-rack preview. It is INERT — 1px, invisible,
  // never drawn — until the card enters an expanded output mode, at which point
  // it becomes the live surface those modes present. That is the whole reason
  // the preview could be removed WITHOUT losing the performance features that
  // used to hang off it.
  const ENGINE_W = VIDEO_RES.width;
  const ENGINE_H = VIDEO_RES.height;

  let canvasEl: HTMLCanvasElement | null = $state(null);
  let wrapEl: HTMLDivElement | null = $state(null);
  let cardEl: HTMLDivElement | null = $state(null);

  // Live engine canvas dims, mirrored each rAF (the engine isn't a reactive
  // store) so the drawing-buffer derive tracks a 4:3 ↔ 16:9 OUTPUT switch.
  let engineW = $state<number>(ENGINE_W);
  let engineH = $state<number>(ENGINE_H);

  // TRUE fullscreen: the wrap IS the fullscreen element.
  const fs = createFullscreen();
  $effect(() => { fs.setTarget(wrapEl); });
  $effect(() => fs.attach());

  // Present on a second display: a separate popup fed by a per-frame blit of
  // THIS canvas; the main window stays interactive. Capability-gated by the
  // menu (getScreenDetails + >1 screen).
  const present = createPresent({ getCanvas: () => canvasEl, fullscreen: fs });

  // Full Frame (in-app): the card's chrome is hidden and the output surface
  // consumes the card border — the "wall of TVs" layout. Persisted in
  // node.data.fullFrame (Y.Doc-synced) so it survives reload + is shareable.
  let fullFrame = $derived<boolean>((node?.data?.fullFrame as boolean | undefined) ?? false);
  const ff = createFullFrame({
    setFullFrame: (on) => {
      mutateNode(id, (live) => {
        if (!live.data) live.data = {};
        live.data.fullFrame = on;
      });
    },
    // Mutual exclusion: entering full-frame drops any active true-fullscreen.
    exitFullscreen: () => void fs.exit(),
  });
  // Double-click a full-frame card exits back to normal chrome.
  $effect(() => ff.attach(cardEl, () => fullFrame));

  /** The card is showing video (and therefore blitting) in exactly these modes. */
  let expanded = $derived(fs.isFullscreen || present.isPresenting || fullFrame);

  // Drawing-buffer dims. Expanded: the live ENGINE dims, so fitRect fills the
  // buffer edge-to-edge and object-fit:contain height-fills the screen (side
  // pillarbox only) — see fullscreen-canvas-dims.ts. Idle: the smallest legal
  // buffer, because nothing is drawn into it.
  let bufferDims = $derived(
    fullscreenCanvasDims(
      expanded,
      { canvas: { width: engineW, height: engineH } },
      { width: 2, height: 2 },
    ),
  );

  // The output menu (Full Frame / Full Screen / Present), opened from the
  // OUTPUT button. The old card opened this by right-clicking the preview;
  // with no preview to right-click it needs an explicit affordance, and a
  // button is also discoverable in a way the hidden right-click never was.
  let ctxOpen = $state(false);
  let ctxX = $state(0);
  let ctxY = $state(0);
  function openOutputMenu(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    ctxX = r.left;
    ctxY = r.bottom + 2;
    ctxOpen = true;
  }

  function fitRect(cw: number, ch: number): { x: number; y: number; w: number; h: number } {
    // Letterbox at the LIVE engine aspect.
    const srcAspect = liveEngineAspect({ canvas: { width: engineW, height: engineH } });
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

  // ---------------- rAF: gate reflection always, blit only when expanded -----
  // A rising edge on a mirror / shape / pure-geo / tv gate flips the param
  // INSIDE the engine instance. Mirror that live value back into the patch
  // store so the toggle persists + syncs to collaborators + the button shows
  // it. That runs every frame and is pure param reads — no GL readback.
  //
  // The blit (which IS a readback, and which used to run unconditionally to
  // paint the in-rack thumbnail) now runs ONLY while the card is expanded.
  let rafId: number | null = null;

  function tick() {
    rafId = null;
    const e = engineCtx.get();
    let videoEngine: VideoEngine | undefined;
    if (e) {
      try { videoEngine = e.getDomain<VideoEngine>('video'); } catch { /* not ready */ }
    }
    if (videoEngine) {
      // Cheap property reads — keeps the buffer derive honest about the live
      // engine resolution even before the first expanded frame.
      const ew = videoEngine.canvas.width || ENGINE_W;
      const eh = videoEngine.canvas.height || ENGINE_H;
      if (ew !== engineW) engineW = ew;
      if (eh !== engineH) engineH = eh;
      if (expanded) drawOutput(videoEngine);
    }
    try { syncFromEngine(e, node); } catch { /* defensive — never kill the loop */ }
    rafId = requestAnimationFrame(tick);
  }

  function drawOutput(videoEngine: VideoEngine): void {
    if (!canvasEl) return;
    const ctx2d = canvasEl.getContext('2d', { alpha: false });
    if (!ctx2d) return;
    try {
      videoEngine.blitOutputToDrawingBuffer(id);
    } catch {
      // Never let an engine error nuke the rAF loop.
    }
    const src = videoEngine.canvas as CanvasImageSource;
    const cw = canvasEl.width;
    const ch = canvasEl.height;
    ctx2d.fillStyle = '#050608';
    ctx2d.fillRect(0, 0, cw, ch);
    const r = fitRect(cw, ch);
    // drawImage() from a WebGL canvas already presents upright (the browser
    // accounts for GL's bottom-left origin). A straight blit is correct.
    ctx2d.drawImage(src, r.x, r.y, r.w, r.h);
  }

  // Only writes when the engine value differs from the store, so user clicks
  // (store → engine via setParam) and gate flips (engine → store here)
  // converge without fighting.
  function syncFromEngine(e: ReturnType<typeof engineCtx.get>, n: ModuleNode | undefined): void {
    if (!e || !n) return;
    // Boolean toggles: compare on the 0.5 threshold.
    for (const k of ['mirrorX', 'mirrorY', 'pureGeo'] as const) {
      const live = e.readParam(n, k);
      if (typeof live !== 'number') continue;
      const stored = (patch.nodes[id]?.params[k] ?? 0);
      if ((live >= 0.5) !== (stored >= 0.5)) {
        const target = patch.nodes[id];
        if (target) target.params[k] = live >= 0.5 ? 1 : 0; // guard:allow-raw-write — per-frame engine→store reflect, must NOT pollute undo
      }
    }
    // Discrete TV mode index: gate-cycled in the engine, same as shape.
    const liveTv = e.readParam(n, 'tvMode');
    if (typeof liveTv === 'number' && Number.isFinite(liveTv)) {
      const storedTv = Math.round(patch.nodes[id]?.params.tvMode ?? 0);
      if (Math.round(liveTv) !== storedTv) {
        const target = patch.nodes[id];
        if (target) target.params.tvMode = Math.round(liveTv); // guard:allow-raw-write — per-frame engine→store reflect, must NOT pollute undo
      }
    }
    // Discrete shape index: compare on the rounded value.
    const liveShape = e.readParam(n, 'shape');
    if (typeof liveShape === 'number') {
      const storedShape = Math.round(patch.nodes[id]?.params.shape ?? 0);
      if (Math.round(liveShape) !== storedShape) {
        const target = patch.nodes[id];
        if (target) target.params.shape = Math.round(liveShape); // guard:allow-raw-write — per-frame engine→store reflect, must NOT pollute undo
      }
    }
  }

  onMount(() => {
    rafId = requestAnimationFrame(tick);
    const edgesMap = ydoc.getMap('edges');
    const handler = (): void => { edgesVersion++; };
    edgesMap.observeDeep(handler);
    edgesUnobserve = () => edgesMap.unobserveDeep(handler);
    edgesVersion++; // seed for a patch loaded with the cable already present
  });
  onDestroy(() => {
    if (rafId !== null) cancelAnimationFrame(rafId);
    // Close any present popup + stop its blit loop when the card is gone.
    present.dispose();
    if (edgesUnobserve) { try { edgesUnobserve(); } catch { /* */ } edgesUnobserve = null; }
  });

  // ---------------- Patch-panel ports ----------------
  // Port ids match the def EXACTLY (handle id === port id — the cross-domain
  // CV bridge + saved patches route by id). lighten/darken CV use the `_cv`
  // suffix; gate-style inputs (delay_clock / mirror_*_gate) carry raw swing.
  const inputs: PortDescriptor[] = [
    { id: 'in_a',    label: 'IN A',    cable: 'video' },
    { id: 'in_b',    label: 'IN B',    cable: 'video' },
    { id: 'lighten', label: 'KEY +',   cable: 'video' },
    { id: 'darken',  label: 'KEY -',   cable: 'video' },
    { id: 'mix',         label: 'MIX',       cable: 'cv' },
    { id: 'feedback',    label: 'FEEDBACK',  cable: 'cv' },
    { id: 'delay',       label: 'DELAY',     cable: 'cv' },
    { id: 'delay_clock', label: 'DELAY CLK', cable: 'gate' },
    { id: 'luma',        label: 'LUMA',      cable: 'cv' },
    { id: 'chroma',      label: 'CHROMA',    cable: 'cv' },
    { id: 'r',           label: 'R',         cable: 'cv' },
    { id: 'g',           label: 'G',         cable: 'cv' },
    { id: 'b',           label: 'B',         cable: 'cv' },
    { id: 'lighten_cv',  label: 'LIGHTEN',   cable: 'cv' },
    { id: 'darken_cv',   label: 'DARKEN',    cable: 'cv' },
    { id: 'pixelate',    label: 'PIXELATE',  cable: 'cv' },
    { id: 'zoom',        label: 'ZOOM',      cable: 'cv' },
    { id: 'rotate',      label: 'ROTATE',    cable: 'cv' },
    { id: 'offsetx',     label: 'OFF X',     cable: 'cv' },
    { id: 'offsety',     label: 'OFF Y',     cable: 'cv' },
    { id: 'mirror_x_gate', label: 'MIRROR X', cable: 'gate' },
    { id: 'mirror_y_gate', label: 'MIRROR Y', cable: 'gate' },
    { id: 'shape_gate',    label: 'SHAPE',    cable: 'gate' },
    { id: 'pure_geo_gate', label: 'PURE GEO', cable: 'gate' },
    { id: 'tv_gate',       label: 'TV MODE',  cable: 'gate' },
    // PURE TV / CRITICAL continuous CV. ROOM is Crutchfield's flashlight (his
    // rig needs external light to restart a dark screen); DRIVE rides the edge
    // of white-out and is the one worth a slow LFO.
    { id: 'room',        label: 'ROOM',      cable: 'cv' },
    { id: 'phosphor',    label: 'PHOSPHOR',  cable: 'cv' },
    { id: 'drive',       label: 'DRIVE',     cable: 'cv' },
  ];
  const outputs = portsFromDef(backdraftDef.outputs);
</script>

<div
  bind:this={cardEl}
  class="vcard card video"
  class:full-frame={fullFrame}
  data-testid="backdraft-card"
  data-node-id={id}
  data-tv-mode={tvModeIdx}
  data-full-frame={fullFrame}
>
  <div class="stripe"></div>
  <ModuleTitle {id} {data} defaultLabel="BACKDRAFT" />

  <PatchPanel nodeId={id} {inputs} {outputs} panelWidth={300}>
    <div class="bd-body">
      <!-- ── MODE rows: the discrete switches, across the top ────────────── -->
      <div class="mode-row">
        <div class="btn-group" data-testid="backdraft-mirror-row">
          <button
            type="button"
            class="mirror-btn nodrag"
            class:on={mirrorXOn}
            data-testid="backdraft-mirror-x"
            title="MIRROR X — fold the left half over the right (kaleidoscope)"
            onclick={toggleMirror('mirrorX')}
          >MIRROR X</button>
          <button
            type="button"
            class="mirror-btn nodrag"
            class:on={mirrorYOn}
            data-testid="backdraft-mirror-y"
            title="MIRROR Y — fold the top half over the bottom (kaleidoscope)"
            onclick={toggleMirror('mirrorY')}
          >MIRROR Y</button>
        </div>

        <div class="btn-group" data-testid="backdraft-shape-row">
          <button
            type="button"
            class="mirror-btn nodrag wide"
            class:on={shapeIdx > 0}
            data-testid="backdraft-shape"
            title="SHAPE — cycle the geometry mask (square = full frame, then circle / pentagon / triangle / octagon)"
            onclick={cycleShape}
          >SHAPE: {shapeName.toUpperCase()}</button>
          <button
            type="button"
            class="mirror-btn nodrag"
            class:on={pureGeoOn && !tvOn}
            class:inert={tvOn}
            data-testid="backdraft-pure-geo"
            title={tvOn
              ? 'PURE GEO is ignored in PURE TV / CRITICAL — SHAPE means exactly one thing there: the screen’s outline. Still live: set it here and it takes effect the moment TV MODE cycles back to OFF.'
              : 'PURE GEO — masking space. ON: fixed shape in screen space (cuts content outside at all zooms). OFF: shape in the zoomed feedback space (scales with Zoom, spills through the tunnel).'}
            onclick={togglePureGeo}
          >PURE GEO</button>
        </div>

        <div class="btn-group tv-group" data-testid="backdraft-tv-row">
          <button
            type="button"
            class="mirror-btn nodrag wide"
            class:on={tvOn}
            data-testid="backdraft-tv-mode"
            title={tvModeIdx === 0
              ? 'TV MODE OFF — the classic infinite-plane feedback composite. The exact pre-PURE-TV behaviour.'
              : tvModeIdx === 1
                ? 'PURE TV — a bounded SCREEN instead of an infinite plane. The previous frame is drawn whole inside a bezelled TV; OUTSIDE it is your live input, so IN THIS MODE YOUR INPUT IS THE ROOM, NOT THE PICTURE. The view nests one level per pass and converges to a STILL image.'
                : 'CRITICAL — PURE TV plus the camera’s AUTO-EXPOSURE servo. The servo integrates, so it overshoots: past DRIVE 0.5 the picture blooms toward white, gets hauled back, and each correction rides inward through the nest one level per DELAY. This is the mode for riding the edge of white-out; back DRIVE off and it always recovers.'}
            onclick={cycleTvMode}
          >TV: {BACKDRAFT_TV_MODE_LABELS[tvModeIdx]}</button>
          {#if tvOn}
            <span class="tv-readout" data-testid="backdraft-tv-readout">
              fill {(tvFill * 100).toFixed(0)}% · ≈{tvDepth.resolved} bands
              {#if tvCritical} · Λ-servo {tvRate.toFixed(1)}/f {tvRiding ? '· RIDING' : '· steady'}{/if}
            </span>
          {/if}
        </div>
      </div>

      <div class="mode-row">
        <div class="btn-group" data-testid="backdraft-flicker-row">
          <span class="row-label">FLICKER</span>
          {#each FLICKERS as f (f.v)}
            <button
              type="button"
              class="mirror-btn nodrag seg"
              class:on={flickerIdx === f.v}
              data-testid={`backdraft-flicker-${f.key}`}
              title={f.title}
              onclick={() => pickFlicker(f.v)}
            >{f.label}</button>
          {/each}
        </div>

        <!-- OUTPUT — the presentation surface. Opens the same menu the old
             card hid behind a right-click on its preview thumbnail: Full Frame
             (card becomes a video panel in the rack), Full Screen, and Present
             on another display. -->
        <button
          type="button"
          class="mirror-btn nodrag out-btn"
          class:on={expanded}
          data-testid="backdraft-output-menu"
          title="OUTPUT — show BACKDRAFT's picture: Full Frame (the card becomes a video panel in the rack), Full Screen, or Present on another display. For an arbitrarily-sized monitor, patch OUT into VIDEO OUT."
          onclick={openOutputMenu}
        >⛶ OUTPUT</button>
      </div>

      <!-- ── FADER BANKS ────────────────────────────────────────────────────
           Grouped by what the control DOES to the loop, in signal order:
           LOOP (how much comes back) → COLOUR (what happens on the way round)
           → KEY (where it happens) → GEOMETRY (where the frame goes next pass)
           → TV SCREEN (the bounded-screen model). An undifferentiated 5×4 grid
           of 19 unlabelled faders was the single least readable thing on the
           old card. The row WRAPS (it is flex-wrap), so a narrower host or a
           longer bank reflows instead of spilling past the card edge. -->
      <div class="banks" data-testid="backdraft-controls">
        <div class="bank-row">
          <section class="bank">
            <h4 class="bank-title">LOOP</h4>
            <div class="bank-faders">
              <Fader value={p('mix')}      min={pmin('mix')}      max={pmax('mix')}      defaultValue={pdef('mix')}      label="Mix" curve="linear" onchange={setParam('mix')}      moduleId={id} paramId="mix" trackHeight={FADER_H} />
              <Fader value={p('feedback')} min={pmin('feedback')} max={pmax('feedback')} defaultValue={pdef('feedback')} label="FB"  curve="linear" onchange={setParam('feedback')} moduleId={id} paramId="feedback" trackHeight={FADER_H} />
              <div class="delay-cell" class:clk-driven={clockPatched}>
                <Fader value={p('delay')} min={pmin('delay')} max={pmax('delay')} units="ms" defaultValue={pdef('delay')} label={clockPatched ? 'Dly·CLK' : 'Delay'} curve="linear" onchange={setParam('delay')} moduleId={id} paramId="delay" trackHeight={FADER_H} />
                {#if clockPatched}<span class="clk-badge" data-testid="backdraft-clk-badge" title="DELAY CLOCK is driving the feedback delay (knob overridden)">CLK</span>{/if}
              </div>
            </div>
          </section>

          <section class="bank">
            <h4 class="bank-title">COLOUR</h4>
            <div class="bank-faders">
              <Fader value={p('luma')}   min={pmin('luma')}   max={pmax('luma')}   defaultValue={pdef('luma')}   label="Luma" curve="linear" onchange={setParam('luma')}   moduleId={id} paramId="luma" trackHeight={FADER_H} />
              <Fader value={p('chroma')} min={pmin('chroma')} max={pmax('chroma')} defaultValue={pdef('chroma')} label="Chr"  curve="linear" onchange={setParam('chroma')} moduleId={id} paramId="chroma" trackHeight={FADER_H} />
              <Fader value={p('r')}      min={pmin('r')}      max={pmax('r')}      defaultValue={pdef('r')}      label="R"    curve="linear" onchange={setParam('r')}      moduleId={id} paramId="r" trackHeight={FADER_H} />
              <Fader value={p('g')}      min={pmin('g')}      max={pmax('g')}      defaultValue={pdef('g')}      label="G"    curve="linear" onchange={setParam('g')}      moduleId={id} paramId="g" trackHeight={FADER_H} />
              <Fader value={p('b')}      min={pmin('b')}      max={pmax('b')}      defaultValue={pdef('b')}      label="B"    curve="linear" onchange={setParam('b')}      moduleId={id} paramId="b" trackHeight={FADER_H} />
            </div>
          </section>

          <section class="bank">
            <h4 class="bank-title">KEY</h4>
            <div class="bank-faders">
              <Fader value={p('lighten')} min={pmin('lighten')} max={pmax('lighten')} defaultValue={pdef('lighten')} label="Lgt" curve="linear" onchange={setParam('lighten')} moduleId={id} paramId="lighten" trackHeight={FADER_H} />
              <Fader value={p('darken')}  min={pmin('darken')}  max={pmax('darken')}  defaultValue={pdef('darken')}  label="Drk" curve="linear" onchange={setParam('darken')}  moduleId={id} paramId="darken" trackHeight={FADER_H} />
            </div>
          </section>

          <section class="bank">
            <h4 class="bank-title">GEOMETRY</h4>
            <div class="bank-faders">
              <Fader value={p('zoom')}     min={pmin('zoom')}     max={pmax('zoom')}     defaultValue={pdef('zoom')}     label="Zoom" curve="linear" onchange={setParam('zoom')}     moduleId={id} paramId="zoom" trackHeight={FADER_H} />
              <Fader value={p('rotate')}   min={pmin('rotate')}   max={pmax('rotate')}   units="°" defaultValue={pdef('rotate')} label="Rot" curve="linear" onchange={setParam('rotate')} moduleId={id} paramId="rotate" trackHeight={FADER_H} />
              <Fader value={p('offsetX')}  min={pmin('offsetX')}  max={pmax('offsetX')}  defaultValue={pdef('offsetX')}  label="OffX" curve="linear" onchange={setParam('offsetX')}  moduleId={id} paramId="offsetX" trackHeight={FADER_H} />
              <Fader value={p('offsetY')}  min={pmin('offsetY')}  max={pmax('offsetY')}  defaultValue={pdef('offsetY')}  label="OffY" curve="linear" onchange={setParam('offsetY')}  moduleId={id} paramId="offsetY" trackHeight={FADER_H} />
              <Fader value={p('pixelate')} min={pmin('pixelate')} max={pmax('pixelate')} defaultValue={pdef('pixelate')} label="Pix"  curve="linear" onchange={setParam('pixelate')} moduleId={id} paramId="pixelate" trackHeight={FADER_H} />
            </div>
          </section>

          <!-- The bounded-SCREEN model. These four only DO anything in PURE TV
               / CRITICAL, so the bank dims when TV MODE is OFF — the same
               "grey it, don't hide it" rule PURE GEO already follows, and it
               keeps the card's height identical in all three modes. -->
          <section class="bank tv-bank" class:dim={!tvOn}>
            <h4 class="bank-title">
              TV SCREEN
              {#if tvOn}
                <span class="bank-hint">{BACKDRAFT_TV_MODE_LABELS[tvModeIdx]}</span>
              {:else}
                <button
                  type="button"
                  class="bank-hint hint-btn nodrag"
                  data-testid="backdraft-tv-screen-hint"
                  title="These four only act on the bounded screen. Click to turn TV MODE on (PURE TV)."
                  onclick={cycleTvMode}
                >TV MODE OFF ▸ turn on</button>
              {/if}
            </h4>
            <div
              class="bank-faders"
              title={tvOn
                ? 'The bounded-screen model: ROOM is the light in the room the TV stands in, BEZEL the screen’s border width, PHOSPHOR the display’s glow/persistence, DRIVE the auto-exposure servo (CRITICAL).'
                : 'ROOM / BEZEL / PHOSPHOR / DRIVE only act in PURE TV or CRITICAL — cycle TV MODE to bring the bounded screen in.'}
            >
              <Fader value={p('room')}     min={pmin('room')}     max={pmax('room')}     defaultValue={pdef('room')}     label="Room"  curve="linear" onchange={setParam('room')}     moduleId={id} paramId="room" trackHeight={FADER_H} />
              <Fader value={p('bezel')}    min={pmin('bezel')}    max={pmax('bezel')}    defaultValue={pdef('bezel')}    label="Bez"   curve="linear" onchange={setParam('bezel')}    moduleId={id} paramId="bezel" trackHeight={FADER_H} />
              <Fader value={p('phosphor')} min={pmin('phosphor')} max={pmax('phosphor')} defaultValue={pdef('phosphor')} label="Phos"  curve="linear" onchange={setParam('phosphor')} moduleId={id} paramId="phosphor" trackHeight={FADER_H} />
              <Fader value={p('drive')}    min={pmin('drive')}    max={pmax('drive')}    defaultValue={pdef('drive')}    label="Drive" curve="linear" onchange={setParam('drive')}    moduleId={id} paramId="drive" trackHeight={FADER_H} />
            </div>
          </section>
        </div>
      </div>
    </div>
  </PatchPanel>

  <!-- OUTPUT SURFACE — inert in the rack (1px, invisible, not drawn), the live
       picture in Full Frame / Full Screen / Present. Kept OUTSIDE the
       PatchPanel slot so full-frame can simply cover the card with it, with no
       display:contents gymnastics on the panel host. -->
  <div
    bind:this={wrapEl}
    class="canvas-wrap"
    class:fullscreen={fs.isFullscreen}
    class:full-frame={fullFrame}
    data-testid="backdraft-fs-wrap"
  >
    <canvas
      bind:this={canvasEl}
      width={bufferDims.width}
      height={bufferDims.height}
      style="aspect-ratio: {bufferDims.aspectRatio};"
      data-testid="backdraft-canvas"
      data-node-id={id}
    ></canvas>
  </div>
</div>

<VideoCanvasContextMenu
  bind:open={ctxOpen}
  x={ctxX}
  y={ctxY}
  title="BACKDRAFT"
  availableScreens={fs.availableScreens}
  onrequestscreens={() => void fs.loadScreens()}
  onfullscreen={(screenId) => { ff.exit(); void fs.enter(screenId); }}
  onfullframe={() => ff.toggle(fullFrame)}
  isFullFrame={fullFrame}
  onpresent={(screenId) => present.present(screenId)}
  onpresentall={() => present.presentAll(fs.availableScreens.filter((s) => !s.isPrimary).map((s) => s.id))}
  onstoppresent={() => present.stop()}
  isPresenting={present.isPresenting}
  onclose={() => { ctxOpen = false; }}
/>

<style>
  /* FIXED 5hp × 2u (900×360). The rack/dock wrappers pin the exact tier
   * (rack-sizes.ts → --rack-hp/--rack-u, specificity 0,3,0); this scoped rule
   * (0,2,0) is the fallback for a bare plain-mount. The card is NO LONGER
   * corner-resizable — the resize existed to scale the preview canvas that no
   * longer exists.
   *
   * WHY 2u AND NOT 3u: the rack pins height to EXACTLY u × 180 (min AND max),
   * so any tier taller than the content is DEAD GREY SPACE on every instance of
   * the card. The content measures ~261 px — two switch rows over one bank row,
   * plus chrome — which does not fit 1u (180) and leaves ~280 px empty at 3u.
   * 2u is the smallest tier it fits. That is the whole reason this card is 2u:
   * pick the tier from the MEASURED content, never round up "for headroom",
   * because headroom in a pinned tier is not headroom, it is a hole. */
  .card {
    width: 900px;
    min-height: 360px;
    overflow: hidden;
    /* Flex column so .bd-body can CLAIM the leftover tier height (below).
     * .stripe is absolute and the patch-triggers are absolute, so the only
     * flex items are the title and .bd-body. */
    display: flex;
    flex-direction: column;
  }
  /* The content measures ~237px against a 360px tier, and the tier is quantized
   * to 180px steps — 1u cannot hold it (the floor is ~197 with the switch rows),
   * so ~120px of slack is STRUCTURAL, not a layout mistake. Rather than pool it
   * in one dead grey block under the faders, .bd-body claims the full height and
   * distributes it: switches pinned to the top, fader banks pinned to the
   * BOTTOM edge, and the slack becomes the gap across the .banks divider — which
   * is exactly the switch-section / fader-section split a hardware panel has.
   * `flex: 1` + `margin-top: auto` does it with NO magic number, so it stays
   * correct if the tier or the control set changes. */
  .bd-body {
    padding: 6px 14px 10px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    flex: 1;
    min-height: 0;
  }

  /* ── Mode rows ── */
  .mode-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 14px;
  }
  .btn-group {
    display: flex;
    gap: 6px;
    align-items: center;
    min-width: 0;
  }
  .mirror-btn {
    flex: 0 0 auto;
    background: var(--module-bg);
    color: var(--text-dim);
    border: 1px solid var(--border);
    border-radius: 3px;
    font-size: 0.6rem;
    letter-spacing: 0.08em;
    padding: 4px 10px;
    cursor: pointer;
    font-family: ui-monospace, monospace;
    white-space: nowrap;
  }
  /* Cycling buttons whose label changes length (SHAPE: PENTAGON, TV: CRITICAL)
   * get a floor so the row doesn't reflow as the user cycles them. */
  .mirror-btn.wide { min-width: 122px; text-align: left; }
  .mirror-btn.on {
    background: var(--accent-dim, #46506b);
    color: var(--text);
    border-color: var(--accent, #6884d7);
  }
  .mirror-btn:hover { border-color: var(--accent-dim); }
  /* PURE GEO is IGNORED in PURE TV / CRITICAL (SHAPE means exactly one thing
     there: the screen's outline), so the button is greyed rather than hidden —
     the state stays legible instead of the control silently vanishing. */
  .mirror-btn.inert {
    opacity: 0.35;
  }
  /* FLICKER's six positions: equal-width segments so the row reads as one
     6-position switch rather than six buttons of varying label width. */
  .mirror-btn.seg {
    flex: 0 0 auto;
    min-width: 42px;
    padding: 4px 2px;
    font-size: 0.56rem;
    letter-spacing: 0.02em;
    text-align: center;
  }
  .row-label {
    flex: 0 0 auto;
    color: var(--text-dim);
    font-size: 0.55rem;
    letter-spacing: 0.09em;
    font-family: ui-monospace, monospace;
  }
  /* OUTPUT sits at the far end of its row, away from the parameter switches —
     it changes how the card is DISPLAYED, not what it does to the signal. */
  .out-btn {
    margin-left: auto;
    border-color: var(--cable-video);
    color: var(--text);
  }
  /* TV MODE readout: fill %, the HONEST resolved band count, and in CRITICAL
     the servo rate plus which side of the bifurcation DRIVE is on. */
  .tv-readout {
    font-size: 9px;
    letter-spacing: 0.02em;
    opacity: 0.75;
    white-space: nowrap;
  }

  /* ── Fader banks ── */
  .banks {
    display: flex;
    flex-direction: column;
    gap: 12px;
    border-top: 1px solid var(--border);
    padding-top: 10px;
  }
  /* All five banks sit on ONE line at the 5hp tier (~830px of the 872px inner
   * width). It is flex-WRAP, not a fixed grid, so a narrower host reflows the
   * banks onto a second line instead of running them off the card edge. */
  .bank-row {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 14px 30px;
  }
  .bank {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }
  .bank-title {
    margin: 0;
    font-family: ui-monospace, monospace;
    font-size: 0.52rem;
    font-weight: 500;
    letter-spacing: 0.14em;
    color: var(--text-dim);
    text-transform: uppercase;
    white-space: nowrap;
    display: flex;
    align-items: baseline;
    gap: 8px;
  }
  .bank-hint {
    letter-spacing: 0.06em;
    opacity: 0.6;
  }
  /* A dimmed bank carries its own cure. Styled to sit on the title's baseline
     as text, not as a second button in the layout — it must add ZERO height. */
  .hint-btn {
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    color: inherit;
    letter-spacing: inherit;
    cursor: pointer;
    text-transform: inherit;
  }
  .hint-btn:hover { opacity: 1; color: var(--accent, #6884d7); }
  .bank-faders {
    display: flex;
    align-items: flex-start;
    gap: 10px;
  }
  /* TV SCREEN with TV MODE OFF: dimmed but still interactive + still occupying
     its space, so the card's height never changes with the mode. */
  .tv-bank.dim { opacity: 0.45; }

  .delay-cell {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
  }
  /* When the DELAY CLOCK drives the delay, dim the track + thumb so the
     knob reads as overridden (the fader stays interactive + MIDI-learnable;
     the value-tag + label stay full-opacity so the badge is legible). */
  .delay-cell.clk-driven :global(.track),
  .delay-cell.clk-driven :global(.thumb) {
    opacity: 0.45;
  }
  .clk-badge {
    margin-top: 2px;
    font-size: 0.5rem;
    line-height: 1;
    letter-spacing: 0.05em;
    color: var(--cable-cv, #6cf);
    border: 1px solid var(--cable-cv, #6cf);
    border-radius: 2px;
    padding: 1px 2px;
    font-family: ui-monospace, monospace;
    pointer-events: none;
  }

  /* ── Output surface ─────────────────────────────────────────────────────
   * IDLE (the rack default): 1px, transparent, non-interactive, and NOT drawn
   * into (the rAF blit is gated on `expanded`). It stays in the DOM rather
   * than behind an {#if} because requestFullscreen() needs a real element to
   * target at the moment the menu item is clicked, and `display: none` cannot
   * be fullscreened. 1px + opacity 0 keeps it costless and invisible while
   * remaining a legal fullscreen target. */
  .canvas-wrap {
    position: absolute;
    left: 0;
    top: 0;
    width: 1px;
    height: 1px;
    /* visibility (not just opacity) so it is genuinely hidden — an opacity-0
     * box still counts as VISIBLE to assertions and to hit-testing, which
     * would let "no in-rack preview" pass while a preview was still there. */
    visibility: hidden;
    opacity: 0;
    pointer-events: none;
    overflow: hidden;
    line-height: 0;
    background: #050608;
  }
  .canvas-wrap canvas {
    display: block;
    width: 100%;
    height: 100%;
    image-rendering: pixelated;
    background: #050608;
  }
  /* FULL FRAME (in-app): the surface consumes the whole card — a video panel
   * in the rack ("wall of TVs"). The card keeps its position + tier; the
   * chrome is hidden and a double-click exits. */
  .canvas-wrap.full-frame {
    inset: 0;
    width: 100%;
    height: 100%;
    visibility: visible;
    opacity: 1;
    pointer-events: auto;
    background: #000;
    cursor: pointer;
    z-index: 4;
  }
  /* TRUE fullscreen: the wrap IS the fullscreen element, filling the physical
   * screen. object-fit:contain centres the engine-aspect canvas with bars on
   * the short axis only (the buffer is engine-sized while expanded, so no
   * double letterbox — see fullscreen-canvas-dims.ts). */
  .canvas-wrap.fullscreen {
    position: fixed;
    inset: 0;
    width: 100%;
    height: 100%;
    visibility: visible;
    opacity: 1;
    pointer-events: auto;
    background: #000;
    z-index: 4;
  }
  .canvas-wrap.fullscreen canvas,
  .canvas-wrap.full-frame canvas {
    width: 100%;
    height: 100%;
    object-fit: contain;
    cursor: pointer;
  }
  /* Card chrome while full-frame: hide everything but the video. */
  .card.full-frame :global(.title),
  .card.full-frame .stripe,
  .card.full-frame .bd-body {
    display: none;
  }
  /* Hide the card's OWN Svelte Flow jacks + patch-panel triggers while
   * full-frame — keep the handles in the DOM (opacity/pointer-events, NOT
   * display:none) so existing cables stay connected; we hide the jacks
   * visually, we do not disconnect them. */
  .card.full-frame :global(.svelte-flow__handle) {
    opacity: 0;
    pointer-events: none;
  }
  .card.full-frame :global(.patch-trigger) {
    display: none;
  }
</style>
