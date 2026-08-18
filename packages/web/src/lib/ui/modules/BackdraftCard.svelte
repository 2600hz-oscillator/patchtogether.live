<script lang="ts">
  // BackdraftCard — UI for BACKDRAFT (video feedback generator).
  //
  // NO DISPLAY. TWO ROWS OF CONTROLS. The owner's layout, verbatim:
  //
  //     +------------------- 720 -------------------+
  //     | GATES          | LOOP | COLOUR | KEY      |   ← upper row
  //     |  MIRROR X/Y    |                          |
  //     |  SHAPE·GEO     |                          |
  //     |  FLICKER ×6    |                          |
  //     |  TV   ⛶OUTPUT  |                          |
  //     |-------------------------------------------|
  //     | GEOMETRY | TV SCREEN | VIRTUAL CAMERA     |   ← lower row
  //     +-------------------------------------------+
  //
  // ── Why the display went away, and what that bought ──────────────────────
  // The 320×240 picture was the single biggest consumer of the card: it cost a
  // 240px band across the top AND it is why the card was 6hp (1080px) — the
  // banks had to collapse onto ONE row to leave a row free for the picture, and
  // one row of six banks needs 6hp. Take the picture out and BOTH costs come
  // back as slack: the banks can use two shorter rows again, which is what lets
  // the card shrink from 6hp to 4hp — 1080×540 → 720×540, a 33% narrower card
  // and 40% less faceplate — with the fader length GROWING, not shrinking
  // (153px → the derived value at FADER_H below).
  //
  // BACKDRAFT's output is still watchable at any size — that is what VIDEO OUT
  // is for, and what the ⛶ OUTPUT button's Full Frame / Full Screen / Present
  // are for (see "the output surface" below).
  //
  // ── THE OUTPUT SURFACE IS STILL HERE — it is just not SHOWN in the rack ───
  // Full Frame / Full Screen / Present all need a real <canvas> element to
  // target at the instant the menu item is clicked (`requestFullscreen()`
  // cannot be handed a `display: none` element, and the Present popup blits
  // FROM this canvas). So the surface is MOUNTED at all times and collapsed to
  // a 0×0 absolutely-positioned box while the card sits in the rack; each
  // expanded mode gives it its size back. It is never `{#if}`-ed away.
  //
  // With no picture to right-click, the ⛶ OUTPUT BUTTON is now the SOLE entry
  // point to that menu (it was one of two — the other was a right-click on the
  // display). backdraft-full-output.spec.ts drives the button and asserts every
  // mode still works, including Full Frame ↔ Full Screen mutual exclusion.
  //
  // ── Cost ─────────────────────────────────────────────────────────────────
  // A rAF loop runs always and reflects gate-driven param changes (mirror /
  // shape / pure-geo / TV mode toggled by a rising edge INSIDE the engine) back
  // into the patch store so the buttons show live state — pure param reads, no
  // GL. The BLIT is a GL readback, and in the rack there is now NOTHING TO BLIT
  // INTO, so it is not performed at all: the card's per-frame GL cost in the
  // rack is zero. It runs only while EXPANDED (Full Frame / Full Screen /
  // Present), at engine resolution, which is the picture the user is actually
  // watching. The node is still marked WATCHED every rAF so the engine keeps
  // the feedback nest advancing — a feedback module that stops rendering loses
  // its history, and that mark is a Map write, not GL work.
  //
  // ── All controls usable ──────────────────────────────────────────────────
  // A control that is inert IN THE MODEL is DIMMED — never `disabled`, never
  // `{#if}`-ed away. Both of those make a control unreachable WHILE ITS GATE CV
  // INPUT KEEPS WRITING THE SAME PARAM, and both make the card's height depend
  // on the mode. Dimming keeps drag, dbl-click reset, wheel and MIDI-Learn, and
  // a dimmed bank carries its own cure (its title is a "turn on" button).
  // card-control-ranges.test.ts pins the no-`disabled` rule on the source;
  // card-control-overflow.spec.ts measures the card in ALL THREE TV modes.
  //
  // Every port (2 video + 2 KEY masks + CV/gate inputs + the `out` video
  // output) lives in the yellow PatchPanel drill-down. Every Fader carries
  // moduleId={id} + paramId so MIDI-Learn binds.

  import { onMount, onDestroy } from 'svelte';
  import { type NodeProps } from '@xyflow/svelte';
  import XyPad from '$lib/ui/controls/XyPad.svelte';
  import NeonFader from '$lib/ui/controls/NeonFader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { useEngine } from '$lib/audio/engine-context';
  import { patch, ydoc } from '$lib/graph/store';
  import { setNodeParam, mutateNode } from '$lib/graph/mutate';
  import { createFullscreen } from './use-fullscreen.svelte';
  import { createFullFrame } from './use-full-frame.svelte';
  import { attachRenderLease } from './use-render-lease.svelte';
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
    BACKDRAFT_CAM_TILT_RANGE,
    BACKDRAFT_CAM_POS_RANGE,
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
  // The rack pins this card to EXACTLY 3u = 540px (min AND max height), so any
  // height the content does not use is dead grey on EVERY instance of the card.
  // The fader length is the free variable that makes the content meet the tier —
  // solve for it, never guess it. Cumulative from the card's top border, every
  // figure MEASURED in the browser at this layout (not estimated):
  //
  //     1    card top border                                  →   1
  //    18    .vcard padding-top                               →  19
  //    16.8  ModuleTitle text (0.85rem)                       →  35.8
  //     8    ModuleTitle margin-bottom                        →  43.8
  //     6    .bd-body padding-top                             →  49.8
  //   H+26   UPPER ROW  (GATES · LOOP · COLOUR · KEY)         →  75.8 + H
  //    18    .rows gap                                        →  93.8 + H
  //     1    .row-lower border-top                            →  94.8 + H
  //    18    .row-lower padding-top                           → 112.8 + H
  //   H+27   LOWER ROW  (GEOMETRY · TV SCREEN · VIRTUAL CAM)  → 139.8 + 2H
  //    10    .bd-body padding-bottom                          → 149.8 + 2H
  //    14    .vcard padding-bottom                            → 163.8 + 2H
  //     1    card bottom border                               → 164.8 + 2H
  //   ─────
  //   164.8 + 2H = 540  →  H = 187.6, taken as 187.
  //
  // (The two bank rows differ by 1px because the LOWER row's TV SCREEN /
  // VIRTUAL CAMERA titles carry the "TV MODE OFF ▸ turn on" BUTTON in the
  // default mode, whose line box is 1px taller than plain title text — 214 vs
  // 213 measured.)
  //
  // MEASURED at H = 187, all three TV modes: card 720×540 exactly, worst
  // bottom overflow 0.0 CSS px. Content floor 213 + 18 + 233 = 464 against the
  // 465.2 the tier gives `.rows`, i.e. 1.2px of residual — which `.row {
  // flex: 1 }` parks INSIDE the upper row as breathing room rather than as a
  // grey strip at the bottom edge. ✓
  //
  // Both rows are one bank row tall, so the SAME H appears twice — which is
  // why losing the display buys a LONGER fader (153 → 187) on a NARROWER card
  // rather than a shorter one: the 240px display band is exactly what the
  // second bank row spends, and 240 > the 26+18+1+18 of chrome that row costs.
  //
  // The GATES column is SHORTER than a bank row, so it never sets the height:
  // it `justify-content: space-between`s down the upper row, which is also why
  // the TV readout appearing in PURE TV / CRITICAL costs ZERO card height (it
  // lands in slack the column already had — measured identical 214.1px column
  // height in all three modes).
  //
  // card-control-overflow is what holds this honest: it measures this card in
  // ALL THREE TV modes, so if a future control pushes past the tier it goes red
  // rather than silently clipping under `.card { overflow: hidden }`.
  const FADER_H = 187;

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

  // ---------------- The output surface (Full Frame / Screen / Present) ------
  // MOUNTED ALWAYS, SHOWN ONLY WHEN EXPANDED. In the rack it is a 0×0
  // absolutely-positioned box (see .canvas-wrap): present in the DOM and
  // fullscreen-able, but occupying no space and painting nothing. Each expanded
  // mode restores its size.
  //
  // It cannot be `{#if}`-ed away or `display: none`-d: requestFullscreen() must
  // be handed a real, rendered element at the moment the menu item is clicked,
  // and the Present popup blits FROM this canvas every frame.
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
  // THIS NODE's engine output — not of the card's canvas, and not owned by this
  // card at all (node-present-registry). The main window stays interactive.
  // Capability-gated by the menu (getScreenDetails + >1 screen).
  const present = createPresent({
    nodeId: () => id,
    engine: () => engineCtx.get(),
    fullscreen: fs,
  });

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

  // Presenting = a surface that outlives the card's viewport rect (projector
  // popup / fullscreen / full-frame). Without the hard lease, scrolling this
  // card off-screen let pull-eval freeze the node — and the projector with it
  // (owner report 2026-08-05: backdraft → present froze on scroll). Shared
  // seam; see use-render-lease.
  attachRenderLease({ engine: () => engineCtx.get(), nodeId: () => id, presenting: () => expanded });

  // Drawing-buffer dims. Expanded: the live ENGINE dims, so fitRect fills the
  // buffer edge-to-edge and object-fit:contain height-fills the screen (side
  // pillarbox only) — see fullscreen-canvas-dims.ts. In the rack the surface is
  // 0×0 and never painted, so the buffer is held at the helper's 2px floor
  // rather than allocating a rack-sized one nothing would read.
  const IDLE_BUFFER = { width: 2, height: 2 };
  let bufferDims = $derived(
    fullscreenCanvasDims(
      expanded,
      { canvas: { width: engineW, height: engineH } },
      IDLE_BUFFER,
    ),
  );

  // The output menu (Full Frame / Full Screen / Present). With the display gone
  // the ⛶ OUTPUT button is the SOLE entry point — right-clicking the picture
  // was the other one, and there is no picture to right-click. That is exactly
  // why the button exists: it is the DISCOVERABLE half of the pair and it was
  // already the half every e2e case drives.
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
  // The blit IS a GL readback, and in the rack there is now no surface to blit
  // INTO, so it is skipped entirely: this card's per-frame GL cost in the rack
  // is ZERO. (The previous card rationed an in-rack thumbnail blit to ~8fps;
  // removing the thumbnail removes the last of it.)
  //
  // ── #1802: markWatched NO LONGER FIRES FROM THE COLLAPSED BRANCH ──────────
  //
  // It used to, every rAF, deliberately: keeping the node a PULL ROOT meant the
  // engine went on advancing the feedback nest even with nothing downstream
  // patched, so the first Full Frame opened on a WARM picture instead of a cold
  // one. That reasoning was sound and the cost was described as "a Map write,
  // not GL work".
  //
  // The Map write is not the cost. Being a pull root is: it pulls the whole
  // UPSTREAM CHAIN into the frame. MEASURED (#1802), `toybox → backdraft` with
  // backdraft's output patched NOWHERE and this card not expanded: both nodes
  // drew 481 frames in 4 s, rendering a picture presented on no surface at all,
  // on the same main thread the audio scheduler dispatches on (#1803).
  //
  // ⚠ THE TRADE, stated rather than hidden: opening Full Frame now starts the
  // feedback nest from cold and it takes a beat to build its trail, in the
  // specific case where NOTHING ELSE was observing the node. If anything is —
  // a downstream OUTPUT card, a render lease (fullscreen / projector /
  // full-frame), an export — pull evaluation keeps the chain warm through that
  // root, which is the correct reason to keep rendering. A collapsed card
  // presenting nothing is not one.
  //
  // The blit IS a GL readback, and in the rack there is now no surface to blit
  // INTO, so it is skipped entirely: this card's per-frame GL cost in the rack
  // is ZERO. (The previous card rationed an in-rack thumbnail blit to ~8fps;
  // removing the thumbnail removes the last of it.) Off-screen cards are
  // handled centrally by video-card-visibility.ts → engine.setCardVisibility,
  // and now also by the preview gate itself.
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
      // #1802 — "OFF" NOW MEANS "NOT THERE".
      //
      // This used to read `else if (!harnessFrozen() && !document.hidden)
      // videoEngine.markWatched?.(id);` — a collapsed card that presents
      // nothing still declared itself an OBSERVER of its node every frame,
      // which made the node a pull root, which dragged its whole upstream
      // chain in with it.
      //
      // MEASURED, `toybox → backdraft` with backdraft's output patched
      // NOWHERE and its card not expanded: both nodes drew 481 frames in 4 s
      // for a picture presented on no surface at all.
      //
      // Nothing is watched from here now. If something ELSE is looking — a
      // downstream OUTPUT card, a render lease (fullscreen / projector /
      // full-frame), an export — pull evaluation keeps the chain alive
      // through THAT root, which is the correct reason. If nothing is, the
      // chain stops, and re-expanding restarts it (`drawOutput` blits, the
      // blit marks watched, the next engine step renders).
      if (expanded) {
        drawOutput(videoEngine);
      }
    }
    try { syncFromEngine(e, node); } catch { /* defensive — never kill the loop */ }
    rafId = requestAnimationFrame(tick);
  }

  function drawOutput(videoEngine: VideoEngine): void {
    if (!canvasEl) return;
    const ctx2d = canvasEl.getContext('2d', { alpha: false });
    if (!ctx2d) return;
    // #1802 — gated preview blit (see VideoEngine.blitOutputForPreview).
    // BACKDRAFT only reaches here while `expanded`, and expanded takes a render
    // LEASE (attachRenderLease below), which bypasses both gates — so the
    // presented picture is never throttled. The call is still routed through
    // the gated method so this card cannot become the one place that marks a
    // node watched without presenting it.
    let blitted = false;
    try {
      blitted = videoEngine.blitOutputForPreview(id);
    } catch {
      // Never let an engine error nuke the rAF loop.
    }
    if (!blitted) return;
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
    // NO present teardown here — deliberately. The projector belongs to the
    // NODE, not to this card (see $lib/ui/modules/node-present-registry): under
    // the shell BACKDRAFT has no lane card at all, so collapsing its dock
    // full-view unmounts this component, and closing the popup here IS the
    // owner-reported "the output stops".
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
    // VIRTUAL CAMERA ORIENTATION — two joysticks + a fader, all CV-able.
    { id: 'cam_tilt_x',  label: 'TILT X',    cable: 'cv' },
    { id: 'cam_tilt_y',  label: 'TILT Y',    cable: 'cv' },
    { id: 'cam_pos_x',   label: 'CAM X',     cable: 'cv' },
    { id: 'cam_pos_y',   label: 'CAM Y',     cable: 'cv' },
    { id: 'cam_dist',    label: 'DIST',      cable: 'cv' },
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
      <div class="rows" data-testid="backdraft-controls">
        <!-- ── UPPER ROW: the GATES column, then LOOP / COLOUR / KEY ────────
             Grouped by what the control DOES to the loop, in signal order:
             the discrete switches that reshape the loop, then LOOP (how much
             comes back) → COLOUR (what happens on the way round) → KEY (where
             it happens). -->
        <div class="row row-upper">
          <!-- GATES. Every switch here is ALSO drivable from a cable — each has
               a matching gate input (mirror_x_gate / mirror_y_gate / shape_gate
               / pure_geo_gate / tv_gate), which is what the section is named
               for. FLICKER is the one discrete param without a gate input; it
               is a 6-position switch and belongs with the switches, not with a
               bank of continuous faders. -->
          <section class="bank gates" data-testid="backdraft-gates">
            <h4 class="bank-title">GATES</h4>
            <div class="gate-rows">
              <div class="mode-row" data-testid="backdraft-mirror-row">
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

              <div class="mode-row" data-testid="backdraft-shape-row">
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

              <!-- FLICKER's label sits ABOVE its six segments rather than
                   beside them. Inline, the label made this the widest row in
                   the column by ~44px, and the GATES column is what sets the
                   card's WIDTH — so stacking it takes 44px off the card for
                   ~14px of column height the column already had spare (it
                   space-betweens into the upper row's full height). -->
              <div class="mode-row stack" data-testid="backdraft-flicker-row">
                <span class="row-label">FLICKER</span>
                <div class="seg-group">
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
              </div>

              <!-- TV MODE and, at the far end of the same row, ⛶ OUTPUT. OUTPUT
                   is the SOLE entry point to Full Frame / Full Screen / Present
                   now that there is no picture to right-click, so it sits on the
                   card's most prominent switch row rather than tucked away. -->
              <div class="mode-row" data-testid="backdraft-tv-row">
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
                <button
                  type="button"
                  class="mirror-btn nodrag out-btn"
                  class:on={expanded}
                  data-testid="backdraft-output-menu"
                  title="OUTPUT — show BACKDRAFT's picture: Full Frame (the card becomes a video panel in the rack), Full Screen, or Present on another display. This card has no in-rack preview, so this button is the way to see it; for an arbitrarily-sized monitor, patch OUT into VIDEO OUT."
                  onclick={openOutputMenu}
                >⛶ OUTPUT</button>
              </div>

              {#if tvOn}
                <div class="mode-row">
                  <span class="tv-readout" data-testid="backdraft-tv-readout">
                    fill {(tvFill * 100).toFixed(0)}% · ≈{tvDepth.resolved} bands
                    {#if tvCritical} · Λ-servo {tvRate.toFixed(1)}/f {tvRiding ? '· RIDING' : '· steady'}{/if}
                  </span>
                </div>
              {/if}
            </div>
          </section>

          <section class="bank">
            <h4 class="bank-title">LOOP</h4>
            <div class="bank-faders">
              <NeonFader value={p('mix')}      min={pmin('mix')}      max={pmax('mix')}      defaultValue={pdef('mix')}      label="Mix" curve="linear" onchange={setParam('mix')}      moduleId={id} paramId="mix" trackHeight={FADER_H} />
              <NeonFader value={p('feedback')} min={pmin('feedback')} max={pmax('feedback')} defaultValue={pdef('feedback')} label="FB"  curve="linear" onchange={setParam('feedback')} moduleId={id} paramId="feedback" trackHeight={FADER_H} />
              <div class="delay-cell" class:clk-driven={clockPatched}>
                <NeonFader value={p('delay')} min={pmin('delay')} max={pmax('delay')} units="ms" defaultValue={pdef('delay')} label={clockPatched ? 'Dly·CLK' : 'Delay'} curve="linear" onchange={setParam('delay')} moduleId={id} paramId="delay" trackHeight={FADER_H} />
                {#if clockPatched}<span class="clk-badge" data-testid="backdraft-clk-badge" title="DELAY CLOCK is driving the feedback delay (knob overridden)">CLK</span>{/if}
              </div>
            </div>
          </section>

          <section class="bank">
            <h4 class="bank-title">COLOUR</h4>
            <div class="bank-faders">
              <NeonFader value={p('luma')}   min={pmin('luma')}   max={pmax('luma')}   defaultValue={pdef('luma')}   label="Luma" curve="linear" onchange={setParam('luma')}   moduleId={id} paramId="luma" trackHeight={FADER_H} />
              <NeonFader value={p('chroma')} min={pmin('chroma')} max={pmax('chroma')} defaultValue={pdef('chroma')} label="Chr"  curve="linear" onchange={setParam('chroma')} moduleId={id} paramId="chroma" trackHeight={FADER_H} />
              <NeonFader value={p('r')}      min={pmin('r')}      max={pmax('r')}      defaultValue={pdef('r')}      label="R"    curve="linear" onchange={setParam('r')}      moduleId={id} paramId="r" trackHeight={FADER_H} />
              <NeonFader value={p('g')}      min={pmin('g')}      max={pmax('g')}      defaultValue={pdef('g')}      label="G"    curve="linear" onchange={setParam('g')}      moduleId={id} paramId="g" trackHeight={FADER_H} />
              <NeonFader value={p('b')}      min={pmin('b')}      max={pmax('b')}      defaultValue={pdef('b')}      label="B"    curve="linear" onchange={setParam('b')}      moduleId={id} paramId="b" trackHeight={FADER_H} />
            </div>
          </section>

          <section class="bank">
            <h4 class="bank-title">KEY</h4>
            <div class="bank-faders">
              <NeonFader value={p('lighten')} min={pmin('lighten')} max={pmax('lighten')} defaultValue={pdef('lighten')} label="Lgt" curve="linear" onchange={setParam('lighten')} moduleId={id} paramId="lighten" trackHeight={FADER_H} />
              <NeonFader value={p('darken')}  min={pmin('darken')}  max={pmax('darken')}  defaultValue={pdef('darken')}  label="Drk" curve="linear" onchange={setParam('darken')}  moduleId={id} paramId="darken" trackHeight={FADER_H} />
            </div>
          </section>
        </div>

        <!-- ── LOWER ROW: GEOMETRY · TV SCREEN · VIRTUAL CAMERA ─────────────
             Where the frame goes next pass, then the bounded-screen model and
             the camera that photographs it. -->
        <div class="row row-lower">
          <section class="bank">
            <h4 class="bank-title">GEOMETRY</h4>
            <div class="bank-faders">
              <NeonFader value={p('zoom')}     min={pmin('zoom')}     max={pmax('zoom')}     defaultValue={pdef('zoom')}     label="Zoom" curve="linear" onchange={setParam('zoom')}     moduleId={id} paramId="zoom" trackHeight={FADER_H} />
              <NeonFader value={p('rotate')}   min={pmin('rotate')}   max={pmax('rotate')}   units="°" defaultValue={pdef('rotate')} label="Rot" curve="linear" onchange={setParam('rotate')} moduleId={id} paramId="rotate" trackHeight={FADER_H} />
              <NeonFader value={p('offsetX')}  min={pmin('offsetX')}  max={pmax('offsetX')}  defaultValue={pdef('offsetX')}  label="OffX" curve="linear" onchange={setParam('offsetX')}  moduleId={id} paramId="offsetX" trackHeight={FADER_H} />
              <NeonFader value={p('offsetY')}  min={pmin('offsetY')}  max={pmax('offsetY')}  defaultValue={pdef('offsetY')}  label="OffY" curve="linear" onchange={setParam('offsetY')}  moduleId={id} paramId="offsetY" trackHeight={FADER_H} />
              <NeonFader value={p('pixelate')} min={pmin('pixelate')} max={pmax('pixelate')} defaultValue={pdef('pixelate')} label="Pix"  curve="linear" onchange={setParam('pixelate')} moduleId={id} paramId="pixelate" trackHeight={FADER_H} />
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
                ? 'The bounded-screen model: ROOM is the light in the room the TV stands in, BORDER the screen frame’s thickness (the “bezel” — the only high-contrast edge between one nesting level and the next), PHOSPHOR the display’s glow/persistence, DRIVE the auto-exposure servo (CRITICAL).'
                : 'ROOM / BORDER (bezel thickness) / PHOSPHOR / DRIVE only act in PURE TV or CRITICAL — cycle TV MODE to bring the bounded screen in.'}
            >
              <NeonFader value={p('room')}     min={pmin('room')}     max={pmax('room')}     defaultValue={pdef('room')}     label="Room"  curve="linear" onchange={setParam('room')}     moduleId={id} paramId="room" trackHeight={FADER_H} />
              <!-- BORDER, not "Bez". This is the screen-frame WIDTH control —
                   the thing a user hunts for as "border thickness" — and it was
                   reported as MISSING from this card. It never was: it is
                   rendered, enabled, CV-less but MIDI-learnable, and the branch
                   gates prove it is reachable. It was UNFINDABLE, for two
                   reasons that stacked. (1) the card abbreviated the def's
                   "Bezel" to a three-letter "Bez", which reads as nothing at
                   all; (2) it lives in the TV SCREEN bank, which DIMS in TV
                   MODE OFF — the default — so the one control being looked for
                   was greyed AND cryptic in the only mode being looked at. The
                   dim now carries its own cure (the bank title is a "turn on"
                   button), and the label now says the word. Card-side only: the
                   def keeps `label: 'Bezel'`, so no contract and no re-attest. -->
              <NeonFader value={p('bezel')}    min={pmin('bezel')}    max={pmax('bezel')}    defaultValue={pdef('bezel')}    label="Border" curve="linear" onchange={setParam('bezel')}   moduleId={id} paramId="bezel" trackHeight={FADER_H} />
              <NeonFader value={p('phosphor')} min={pmin('phosphor')} max={pmax('phosphor')} defaultValue={pdef('phosphor')} label="Phos"  curve="linear" onchange={setParam('phosphor')} moduleId={id} paramId="phosphor" trackHeight={FADER_H} />
              <NeonFader value={p('drive')}    min={pmin('drive')}    max={pmax('drive')}    defaultValue={pdef('drive')}    label="Drive" curve="linear" onchange={setParam('drive')}    moduleId={id} paramId="drive" trackHeight={FADER_H} />
            </div>
          </section>

          <section class="bank cam-bank" class:dim={!tvOn}>
            <!-- No mode hint when TV is ON: the TV SCREEN bank beside it already
                 shows the mode, and BACKDRAFT_TV_MODE_LABELS[1] is itself the
                 string "VIRTUAL CAMERA" — so repeating it here reads as
                 "VIRTUAL CAMERA · VIRTUAL CAMERA". The OFF-state "turn on"
                 button stays: that one is the bank's own cure, not a readout. -->
            <h4 class="bank-title">
              VIRTUAL CAMERA
              {#if !tvOn}
                <button
                  type="button"
                  class="bank-hint hint-btn nodrag"
                  data-testid="backdraft-cam-hint"
                  title="The camera model only exists on the bounded-screen path. Click to turn TV MODE on (PURE TV)."
                  onclick={cycleTvMode}
                >TV MODE OFF ▸ turn on</button>
              {/if}
            </h4>
            <!-- DIMMED, never {#if}-ed. Unmounting these would make them
                 unreachable while cam_tilt_* / cam_pos_* / cam_dist keep writing
                 the same params from a cable, and would make the card's height
                 depend on the mode — the two things this card's rule exists to
                 prevent. Same treatment the TV SCREEN bank already gets. -->
            <div class="bank-faders" data-testid="backdraft-cam-row">
              <!-- The long prose lives on THESE wrappers as a native tooltip,
                   and in docs.controls. It must NOT go to XyPad's `title` prop:
                   that renders as a VISIBLE caption div (.xy-title, 0.5rem
                   uppercase, centred, no clamp), so a paragraph there becomes a
                   wall of tiny text in the middle of the faceplate. Short
                   captions are the design — VIDEOCUBE, the only other XyPad
                   caller, passes "ROT X / Y". -->
              <div
                class="cam-cell"
                title="TILT — swing the camera off the screen's normal. The set images as a trapezoid, and because every pass re-photographs the one before it the keystone COMPOUNDS: the nest curls toward the vanishing point instead of shrinking straight in. Centre = dead-on."
              >
                <XyPad
                  xValue={p('camTiltX')} yValue={p('camTiltY')}
                  xMin={-BACKDRAFT_CAM_TILT_RANGE} xMax={BACKDRAFT_CAM_TILT_RANGE}
                  yMin={-BACKDRAFT_CAM_TILT_RANGE} yMax={BACKDRAFT_CAM_TILT_RANGE}
                  xLabel="X" yLabel="Y"
                  xDefault={pdef('camTiltX')} yDefault={pdef('camTiltY')}
                  onXChange={setParam('camTiltX')} onYChange={setParam('camTiltY')}
                  size={96}
                  title="TILT"
                  testid="backdraft-cam-tilt"
                  moduleId={id} xParamId="camTiltX" yParamId="camTiltY"
                />
              </div>
              <div
                class="cam-cell"
                title="POSITION — slide the camera in its own plane, from dead centre out past the screen's borders. Position SHIFTS the view; TILT bends it. Together they are how you look at the set from above and off to one side: raise Cam Y, then tilt down to bring the screen back into frame."
              >
                <XyPad
                  xValue={p('camPosX')} yValue={p('camPosY')}
                  xMin={-BACKDRAFT_CAM_POS_RANGE} xMax={BACKDRAFT_CAM_POS_RANGE}
                  yMin={-BACKDRAFT_CAM_POS_RANGE} yMax={BACKDRAFT_CAM_POS_RANGE}
                  xLabel="X" yLabel="Y"
                  xDefault={pdef('camPosX')} yDefault={pdef('camPosY')}
                  onXChange={setParam('camPosX')} onYChange={setParam('camPosY')}
                  size={96}
                  title="POS"
                  testid="backdraft-cam-pos"
                  moduleId={id} xParamId="camPosX" yParamId="camPosY"
                />
              </div>
              <!-- Ranges READ FROM THE DEF like every other control on this
                   card. #1223 shipped bare numeric literals in this Fader's
                   range props (its joysticks were already correct, importing
                   the exported range constants) — card-control-ranges.test.ts
                   rejects a numeric-literal range prop on this file, so those
                   would have gone red the moment the fold landed.
                   NB that gate greps the SOURCE, so it cannot tell code from
                   comment: do not spell the literal form out here, or the
                   comment itself trips it. It caught exactly that while this
                   was being written, which is the gate working as intended. -->
              <NeonFader value={p('camDist')} min={pmin('camDist')} max={pmax('camDist')} defaultValue={pdef('camDist')} label="Dist" curve="linear" onchange={setParam('camDist')} moduleId={id} paramId="camDist" trackHeight={FADER_H} />
            </div>
          </section>
        </div>
      </div>
    </div>
  </PatchPanel>

  <!-- THE OUTPUT SURFACE. Mounted always; 0×0 and painting nothing while the
       card sits in the rack, full-size in Full Frame / Full Screen, and the
       Present popup's blit source. Kept OUTSIDE the PatchPanel body because it
       is absolutely positioned against the card in every one of those states. -->
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
  /* FIXED 4hp × 3u (720×540). The rack/dock wrappers pin the exact tier
   * (rack-sizes.ts → --rack-hp/--rack-u, specificity 0,3,0); this scoped rule
   * (0,2,0) is the fallback for a bare plain-mount. The card is NOT
   * corner-resizable: 3u is a hard tier, and a resize handle would fight the
   * `max-height` pin in _module-card.css and resurrect node.data.width/height
   * as a competing truth. card-control-ranges.test.ts pins BOTH numbers here
   * against RACK_SIZE_DEFAULTS, so this rule and the tier move together.
   *
   * WHY 4hp — MEASURED IN THE BROWSER, never estimated. (An ESTIMATE is what
   * put an earlier proposal at 7hp on an assumed ~830px of banks; the measured
   * figure was 602-636, and the same class of error is why these numbers are
   * read off the live layout.) At this layout, in CSS px:
   *
   *   inner width  720 − 2 borders − 28 .bd-body padding          =  690
   *   UPPER ROW    GATES 258.0 + LOOP 94.3 + COLOUR 155.0
   *                + KEY 54.0 = 561.3, + 3×24 gaps                =  633.3
   *   LOWER ROW    GEOMETRY 162.7 + TV SCREEN 169.6 (worst case —
   *                the "turn on" hint widens the title in TV OFF)
   *                + VIRTUAL CAMERA 234.1 = 566.4, + 2×24 gaps    =  614.4
   *
   * The UPPER row binds at 633.3 of 690 → 56.7px (8.2%) of slack; 3hp (540px
   * → 510 inner) does not hold EITHER row, so 4hp is the SMALLEST tier this
   * layout fits, at 360px narrower than the 6hp the display cost.
   *
   * That slack is also robust to FONT METRICS, which is the thing that
   * actually differs between this machine and the Linux CI runner the overflow
   * gate reports from. Almost none of the 633.3 is text-driven: the six FLICKER
   * segments are on a fixed `min-width` (258 of the GATES column's 258), the
   * SHAPE / TV buttons are on a fixed `.wide` floor, and a Fader's box is its
   * 22px track unless a label exceeds it (measured excess across the whole
   * upper row: 13.3px). A 20% wider font moves the binding row by single-digit
   * px, not by the 57 it would take to wrap.
   *
   * WHY 3u AND NOT 4u: the rack pins height to EXACTLY u × 180 (min AND max),
   * so a tier taller than the content is DEAD GREY on every instance of the
   * card. The content is solved to 540 (see FADER_H) — and 540 + chrome also
   * clears the dock full-view's 680px height ceiling, which 4u would not. */
  .card {
    width: 720px;
    min-height: 540px;
    overflow: hidden;
    /* Flex column so .bd-body can CLAIM the full tier height (below). .stripe,
     * the patch-triggers and the output surface are absolute, so the only flex
     * items are the title and .bd-body. */
    display: flex;
    flex-direction: column;
  }
  /* .bd-body CLAIMS the full tier height (flex: 1). Its paddings are terms in
   * the FADER_H arithmetic — see the derivation next to that constant. */
  .bd-body {
    padding: 6px 14px 10px;
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
  }
  .rows {
    display: flex;
    flex-direction: column;
    gap: 18px;
    flex: 1;
    min-height: 0;
  }

  /* ── The two control rows ─────────────────────────────────────────────────
   * Each row is `flex: 1` so the pair splits the body height evenly and any
   * residual lands INSIDE a row (as breathing room around its banks) rather
   * than as a grey hole at the bottom edge. The arithmetic is solved so that
   * residual is ~0; this is belt-and-braces against a future font nudge.
   *
   * `space-between` is what sets the VISIBLE spacing — it spreads the banks
   * edge to edge so the width is USED rather than pooling as a right-hand
   * margin. The `gap` is therefore only the WRAP THRESHOLD.
   *
   * flex-WRAP, not a fixed grid: a narrower host reflows onto another line
   * instead of running off the card edge, and the resulting height blow-up is
   * loudly caught by card-control-overflow — the correct failure mode. */
  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    justify-content: space-between;
    gap: 14px 24px;
    flex: 1;
    min-height: 0;
  }
  /* A hairline between the two rows, and the padding above it is a term in the
   * FADER_H arithmetic. */
  .row-lower {
    border-top: 1px solid var(--border);
    padding-top: 18px;
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
  /* TV SCREEN / VIRTUAL CAMERA with TV MODE OFF: dimmed but still interactive
     + still occupying their space, so the card's height never changes with the
     mode — the property the three card-control-overflow measurements pin. */
  .tv-bank.dim,
  .cam-bank.dim { opacity: 0.45; }

  /* The camera cluster is SHORTER than a 187px-fader bank (an XyPad wrap is
     ~145px at size 96), so centre it against the Dist fader rather than letting
     it hang from the top with a gap underneath. This costs no height: the
     bank's height is still set by the tallest child, which is the fader. */
  .cam-bank .bank-faders { align-items: center; }
  /* The wrapper exists to carry the long explanatory `title` as a real tooltip.
     It must generate a box for hover hit-testing, so NOT display:contents. */
  .cam-cell { display: flex; }

  /* ── GATES column ─────────────────────────────────────────────────────────
   * The switch rows SPACE-BETWEEN down the full height of the upper row, so
   * they bracket the fader banks beside them instead of clustering at the top
   * and leaving the difference as one void. That is also what makes the TV
   * readout free: in PURE TV / CRITICAL it lands in slack the column already
   * had, so the card's height is identical in all three modes. */
  .gates { flex: 0 1 auto; align-self: stretch; }
  .gate-rows {
    flex: 1;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    gap: 10px;
    padding-top: 2px;
  }
  .mode-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 6px;
  }
  /* FLICKER: label over segments (see the note in the markup). */
  .mode-row.stack {
    flex-direction: column;
    align-items: flex-start;
    gap: 3px;
  }
  .seg-group {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
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
    min-width: 38px;
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
     it changes how the card is DISPLAYED, not what it does to the signal. It is
     also the ONLY route to Full Frame / Full Screen / Present now that there is
     no picture to right-click, so it carries the video accent. */
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

  /* ── THE OUTPUT SURFACE ──────────────────────────────────────────────────
   * ONE element serves all three expanded sizes: the whole card in Full Frame,
   * the physical screen in Full Screen, and the popup's blit source in Present.
   *
   * IN THE RACK it is a 0×0 absolutely-positioned box — no space, no paint, no
   * GL readback (tick() does not blit while un-expanded). It is deliberately
   * NOT `display: none` and NOT behind an `{#if}`: requestFullscreen() has to
   * be handed a real element at the moment the menu item is clicked, and the
   * Present popup reads pixels out of this canvas every frame.
   *
   * Being `position: absolute` also keeps it out of card-control-overflow's
   * measurement, which skips absolutely-positioned and zero-size elements —
   * correct here, since it is chrome, not a control. */
  .canvas-wrap {
    position: absolute;
    top: 0;
    left: 0;
    width: 0;
    height: 0;
    overflow: hidden;
    line-height: 0;
    pointer-events: none;
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
   * chrome is hidden and a double-click exits. `inset: 0` resolves against
   * .vcard, the nearest positioned ancestor. */
  .canvas-wrap.full-frame {
    inset: 0;
    width: 100%;
    height: 100%;
    background: #000;
    pointer-events: auto;
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
    background: #000;
    pointer-events: auto;
    z-index: 4;
  }
  .canvas-wrap.fullscreen canvas,
  .canvas-wrap.full-frame canvas {
    width: 100%;
    height: 100%;
    object-fit: contain;
    cursor: pointer;
  }
  /* Card chrome while full-frame: hide everything but the video. Dropping the
   * card's own padding lets the `inset: 0` surface reach the border on all four
   * sides (the .vcard padding box is what `inset` resolves against).
   * backdraft-full-output.spec.ts asserts [data-testid="backdraft-controls"]
   * (= .rows) is hidden here, which .bd-body's display:none keeps true. */
  .card.full-frame {
    padding: 0;
  }
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
