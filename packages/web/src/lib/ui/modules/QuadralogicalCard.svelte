<script lang="ts">
  // QuadralogicalCard — UI for QUADRALOGICAL (4-input video MIXER).
  //
  // Centerpiece: a large XY pad (cloned from JoystickCard, scaled ~2.75×:
  // PAD_PX=440, dot ~34px) with an inner 45°-rotated YELLOW DIAMOND drawn to
  // scale so it literally shows the |x|+|y| <= diamond_margin all-4-composite
  // zone. The dot uses the SAME quadWeights() as the GLSL MIX, so dragging into
  // the diamond visibly enters the 4-way blend, pushing to an edge a 2-input
  // region, and a corner a single input.
  //
  // Below the pad: an on-card preview canvas (shows the canonical MIX via
  // blitOutputToDrawingBuffer, same pattern as BackdraftCard) + FOUR PER-EDGE
  // effect selectors (Edge 1–2 / 2–3 / 3–4 / 4–1), each a compact 8-mode
  // dropdown with that edge's two control faders re-labelled for the selected
  // effect (EFFECTS[fx]) + a shared chroma key-colour row for CHROMA edges.
  //
  // Per-axis MIDI: the pad right-click opens a BESPOKE 2-axis menu (Assign X /
  // Assign Y / Forget X / Forget Y) — ControlContextMenu is single-action so we
  // can't reuse it for two axes. pos_x + pos_y are DISTINCT paramIds so their
  // midi-learn localStorage keys never clobber each other. The pad stays a
  // <div> (not a Knob/Fader) so midi-learn-wiring-audit exempts it.

  import { onMount, onDestroy } from 'svelte';
  import { useStore, type NodeProps } from '@xyflow/svelte';
  import { useEngine } from '$lib/audio/engine-context';
  import { patch } from '$lib/graph/store';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import type { ModuleNode } from '$lib/graph/types';
  import type { VideoEngine } from '$lib/video/engine';
  import { liveEngineAspect } from '$lib/ui/modules/video-card-aspect';
  import {
    quadralogicalDef,
    quadWeights,
    clampJoy,
    TRANSITIONS,
    EFFECTS,
    EDGES,
  } from '$lib/video/modules/quadralogical';
  import {
    beginLearn,
    registerSetter,
    unregisterSetter,
    getBinding,
    clearBinding,
    cancelLearn,
    learnSpecRune,
    bindingsRune,
  } from '$lib/midi/midi-learn.svelte';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();
  // useStore() is intentionally read so the card participates in SvelteFlow's
  // node context (parity with the other video cards); not otherwise used yet.
  useStore();

  function defaultFor(key: string): number {
    return quadralogicalDef.params.find((p) => p.id === key)!.defaultValue;
  }
  function pget(key: string): number {
    return (node?.params?.[key] ?? defaultFor(key)) as number;
  }
  const set = (k: string) => (v: number) => {
    const t = patch.nodes[id];
    if (t) t.params[k] = v;
  };
  // Wavesculpt-style live-CV poll (suppressed during a drag) so a patched LFO /
  // bound MIDI CC moves the dot in real time. engine.readParam returns
  // intrinsic-knob + most-recent-CV sample.
  const live = (k: string) => () => {
    const e = engineCtx.get();
    if (!e || !node) return undefined;
    return e.readParam(node, k);
  };

  // ---- joystick state ----
  let draggingPad = $state(false);
  let livePosX = $state<number | null>(null);
  let livePosY = $state<number | null>(null);
  let pos_x = $derived(clampJoy(!draggingPad && livePosX !== null ? livePosX : pget('pos_x')));
  let pos_y = $derived(clampJoy(!draggingPad && livePosY !== null ? livePosY : pget('pos_y')));

  let margin = $derived(pget('diamond_margin'));
  let sharp = $derived(pget('blend_sharp'));
  // Per-edge selected effects (one per edge slot 1–2 / 2–3 / 3–4 / 4–1).
  let edgeFx = $derived(EDGES.map((e) => Math.round(pget(`${e.id}_fx`))));

  // Live weights for the dot tint (dominant input drives the ring colour) — the
  // SAME function the GLSL MIX uses, so the dot is 1:1 with the composite.
  let weights = $derived(quadWeights(pos_x, pos_y, margin, sharp));
  const INPUT_COLORS = ['#ff5a5a', '#5aff7a', '#5a9bff', '#ffd24a']; // in1..in4
  let dominantIdx = $derived(weights.indexOf(Math.max(...weights)));
  let dotColor = $derived(INPUT_COLORS[dominantIdx] ?? '#ffd24a');

  // ---- pad geometry ----
  const PAD_PX = 440;
  let dotX = $derived(((pos_x + 1) / 2) * PAD_PX);
  let dotY = $derived(((-pos_y + 1) / 2) * PAD_PX);
  // A CSS square of side s rotated 45° has its vertices at distance s/√2 from
  // center. We want those vertices at the normalized-coord points (±margin,0) /
  // (0,±margin), i.e. screen distance (margin/2)·PAD_PX from center → solve
  // s/√2 = (margin/2)·PAD_PX → s = margin·PAD_PX/√2. So the drawn diamond's L1
  // boundary == the `margin` fed to quadWeights — geometry is 1:1 with the math.
  let diamondSide = $derived((margin * PAD_PX) / Math.SQRT2);

  function fmt(v: number): string {
    return v.toFixed(2);
  }

  // ---- pointer drag (Y flipped so dragging UP = +y, matching JoystickCard) ----
  let padEl: HTMLDivElement | null = $state(null);

  function writePos(x: number, y: number): void {
    const t = patch.nodes[id];
    if (!t) return;
    t.params.pos_x = clampJoy(x);
    t.params.pos_y = clampJoy(y);
  }
  function updateFromPointer(ev: PointerEvent): void {
    if (!padEl) return;
    const rect = padEl.getBoundingClientRect();
    const px = (ev.clientX - rect.left) / rect.width;
    const py = (ev.clientY - rect.top) / rect.height;
    writePos(px * 2 - 1, -(py * 2 - 1));
  }
  function onPointerDown(ev: PointerEvent): void {
    if (!padEl || ev.button !== 0) return;
    draggingPad = true;
    padEl.setPointerCapture(ev.pointerId);
    updateFromPointer(ev);
    ev.preventDefault();
    ev.stopPropagation();
  }
  function onPointerMove(ev: PointerEvent): void {
    if (!draggingPad) return;
    updateFromPointer(ev);
  }
  function onPointerUp(ev: PointerEvent): void {
    if (!draggingPad) return;
    draggingPad = false;
    try { padEl?.releasePointerCapture(ev.pointerId); } catch { /* */ }
    // No snap-back: a mixer position should stay where you put it.
  }

  // Poll the live-CV value each rAF so a patched CV / bound MIDI CC moves the
  // dot. Suppressed during a drag (the user's gesture owns the dot).
  let pollRaf: number | null = null;
  function pollLive(): void {
    pollRaf = null;
    if (!draggingPad) {
      livePosX = live('pos_x')() ?? null;
      livePosY = live('pos_y')() ?? null;
    }
    pollRaf = requestAnimationFrame(pollLive);
  }

  // ---- per-axis MIDI Learn ----
  // Reactive badges per axis (mirrors Knob.svelte).
  let bindX = $derived.by(() => { void bindingsRune(); return getBinding(id, 'pos_x'); });
  let bindY = $derived.by(() => { void bindingsRune(); return getBinding(id, 'pos_y'); });
  let learningX = $derived.by(() => {
    const ls = learnSpecRune();
    return !!ls && ls.moduleId === id && ls.paramId === 'pos_x';
  });
  let learningY = $derived.by(() => {
    const ls = learnSpecRune();
    return !!ls && ls.moduleId === id && ls.paramId === 'pos_y';
  });

  // ---- bespoke 2-axis right-click menu ----
  let menuOpen = $state(false);
  let menuX = $state(0);
  let menuY = $state(0);

  function openMenu(ev: MouseEvent): void {
    // The dot has pointer-events:none, so a dot right-click lands here on the
    // pad. preventDefault + stopPropagation so SvelteFlow's node menu doesn't
    // also open.
    ev.preventDefault();
    ev.stopPropagation();
    menuX = ev.clientX;
    menuY = ev.clientY;
    menuOpen = true;
  }
  function closeMenu(): void { menuOpen = false; }
  function assignAxis(axis: 'pos_x' | 'pos_y'): void {
    beginLearn({ moduleId: id, paramId: axis, min: -1, max: 1, onchange: set(axis) });
    closeMenu();
  }
  function forgetAxis(axis: 'pos_x' | 'pos_y'): void {
    clearBinding(id, axis);
    closeMenu();
  }

  // Portal the menu to <body> so position:fixed resolves against the viewport,
  // not the transformed SvelteFlow viewport (same rationale as ControlContextMenu).
  function portal(el: HTMLElement) {
    document.body.appendChild(el);
    return { destroy() { el.remove(); } };
  }

  // ---- on-card MIX preview canvas ----
  const ENGINE_W = 640;
  const ENGINE_H = 480;
  const CANVAS_W = 280;
  const CANVAS_H = 158;
  let canvasEl: HTMLCanvasElement | null = $state(null);
  let drawRaf: number | null = null;

  function fitRect(
    cw: number,
    ch: number,
    srcAspect: number = ENGINE_W / ENGINE_H,
  ): { x: number; y: number; w: number; h: number } {
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
      const r = fitRect(cw, ch, liveEngineAspect(videoEngine));
      ctx2d.drawImage(src, r.x, r.y, r.w, r.h);
    }
    drawRaf = requestAnimationFrame(draw);
  }

  onMount(() => {
    // Register both axes' setters so a bound CC drives the dot after a reload
    // (the binding may load before the card mounts — registerSetter is
    // unconditional, see midi-learn.svelte.ts).
    registerSetter(id, 'pos_x', { min: -1, max: 1, onchange: set('pos_x') });
    registerSetter(id, 'pos_y', { min: -1, max: 1, onchange: set('pos_y') });
    drawRaf = requestAnimationFrame(draw);
    pollRaf = requestAnimationFrame(pollLive);
  });
  onDestroy(() => {
    if (drawRaf !== null) cancelAnimationFrame(drawRaf);
    if (pollRaf !== null) cancelAnimationFrame(pollRaf);
    unregisterSetter(id, 'pos_x');
    unregisterSetter(id, 'pos_y');
    if (learningX || learningY) cancelLearn();
  });

  // ---- per-edge effect selection ----
  function selectEdgeFx(edgeId: string, fx: number): void {
    const t = patch.nodes[id];
    if (t) t.params[`${edgeId}_fx`] = fx;
  }
  // The two control labels for an edge given its selected effect (null = hide
  // that fader for this effect — e.g. DISSOLVE is pure ratio).
  function ctrlLabels(fx: number): { amount: string | null; param: string | null } {
    return EFFECTS[fx] ?? { amount: null, param: null };
  }
  // Any edge running CHROMA → expose the shared key-colour faders.
  let anyChroma = $derived(edgeFx.some((fx) => fx === 4));
  // Min/max lookups so the dynamic faders read the def's ranges.
  function paramRange(pid: string): { min: number; max: number } {
    const p = quadralogicalDef.params.find((x) => x.id === pid)!;
    return { min: p.min, max: p.max };
  }

  // ---- patch panel ports ----
  const inputs: PortDescriptor[] = [
    { id: 'in1', label: 'IN1', cable: 'video' },
    { id: 'in2', label: 'IN2', cable: 'video' },
    { id: 'in3', label: 'IN3', cable: 'video' },
    { id: 'in4', label: 'IN4', cable: 'video' },
    { id: 'pos_x', label: 'X', cable: 'cv' },
    { id: 'pos_y', label: 'Y', cable: 'cv' },
    { id: 'diamond_margin', label: 'DIAMOND', cable: 'cv' },
    { id: 'blend_sharp', label: 'SHARP', cable: 'cv' },
    { id: 'edge1_amount', label: '1–2 AMT', cable: 'cv' },
    { id: 'edge1_param', label: '1–2 PRM', cable: 'cv' },
    { id: 'edge2_amount', label: '2–3 AMT', cable: 'cv' },
    { id: 'edge2_param', label: '2–3 PRM', cable: 'cv' },
    { id: 'edge3_amount', label: '3–4 AMT', cable: 'cv' },
    { id: 'edge3_param', label: '3–4 PRM', cable: 'cv' },
    { id: 'edge4_amount', label: '4–1 AMT', cable: 'cv' },
    { id: 'edge4_param', label: '4–1 PRM', cable: 'cv' },
    { id: 'keyR', label: 'KEY R', cable: 'cv' },
    { id: 'keyG', label: 'KEY G', cable: 'cv' },
    { id: 'keyB', label: 'KEY B', cable: 'cv' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'out', label: 'MIX', cable: 'video' },
    { id: 'preview', label: 'PREVIEW', cable: 'video' },
  ];
</script>

<div class="mod-card quadralogical-card" data-testid="quadralogical-card" data-node-id={id}>
  <div class="stripe" style="background: var(--cable-video);"></div>
  <ModuleTitle {id} {data} defaultLabel="QUADRALOGICAL" />

  <PatchPanel nodeId={id} {inputs} {outputs} panelWidth={340}>
    <div class="body">
      <!-- The XY pad — pointer-events on the PAD (not the dot), so a dot
           right-click lands here on the pad for the 2-axis MIDI menu. -->
      <div class="pad-wrap">
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="pad nodrag"
          bind:this={padEl}
          style="width: {PAD_PX}px; height: {PAD_PX}px;"
          role="application"
          aria-label="Quadralogical XY mix pad"
          data-testid="quadralogical-pad"
          onpointerdown={onPointerDown}
          onpointermove={onPointerMove}
          onpointerup={onPointerUp}
          onpointercancel={onPointerUp}
          oncontextmenu={openMenu}
        >
          <!-- corner labels: in1 TL / in2 TR / in3 BL / in4 BR -->
          <span class="corner tl">IN1</span>
          <span class="corner tr">IN2</span>
          <span class="corner bl">IN3</span>
          <span class="corner br">IN4</span>

          <div class="crosshair-h"></div>
          <div class="crosshair-v"></div>

          <!-- inner yellow 45° diamond = the |x|+|y| <= margin all-4 zone -->
          <div
            class="diamond"
            data-testid="quadralogical-diamond"
            style="width: {diamondSide}px; height: {diamondSide}px;"
          ></div>

          <div
            class="dot"
            class:active={draggingPad}
            class:learning={learningX || learningY}
            style="left: {dotX}px; top: {dotY}px; background: {dotColor}; border-color: {dotColor};"
            data-testid="quadralogical-dot"
          ></div>
        </div>

        <div class="readout" data-testid="quadralogical-readout">
          <span>x: <strong>{fmt(pos_x)}</strong></span>
          <span>y: <strong>{fmt(pos_y)}</strong></span>
          {#if bindX}<span class="midi-badge" title="X bound to CH {bindX.channel + 1} · CC {bindX.cc}">X·MIDI</span>{/if}
          {#if bindY}<span class="midi-badge" title="Y bound to CH {bindY.channel + 1} · CC {bindY.cc}">Y·MIDI</span>{/if}
        </div>
      </div>

      <!-- on-card MIX preview (the canonical surface) -->
      <div class="canvas-wrap">
        <canvas
          bind:this={canvasEl}
          width={CANVAS_W}
          height={CANVAS_H}
          data-testid="quadralogical-canvas"
          data-node-id={id}
        ></canvas>
      </div>

      <!-- FOUR per-edge effect slots: each edge of the joystick cycle
           (1–2 / 2–3 / 3–4 / 4–1) selects its own effect + shows that
           effect's two controls. -->
      <div class="edges" data-testid="quadralogical-edges">
        {#each EDGES as edge, e (edge.id)}
          {@const fx = edgeFx[e]}
          {@const labels = ctrlLabels(fx)}
          <div class="edge-slot" data-testid={`quadralogical-edge-${e + 1}`}>
            <div class="edge-head">
              <span class="edge-name">EDGE {edge.label}</span>
              <select
                class="fx-select nodrag"
                data-testid={`quadralogical-edge-${e + 1}-fx`}
                value={fx}
                onchange={(ev) => selectEdgeFx(edge.id, Number((ev.currentTarget as HTMLSelectElement).value))}
                title={`Effect for edge ${edge.label}`}
              >
                {#each TRANSITIONS as label, i (label)}
                  <option value={i}>{label}</option>
                {/each}
              </select>
            </div>
            {#if labels.amount || labels.param}
              <div class="edge-faders">
                {#if labels.amount}
                  {@const r = paramRange(`${edge.id}_amount`)}
                  <Fader
                    value={pget(`${edge.id}_amount`)}
                    min={r.min}
                    max={r.max}
                    defaultValue={defaultFor(`${edge.id}_amount`)}
                    label={labels.amount}
                    curve="linear"
                    onchange={set(`${edge.id}_amount`)}
                    readLive={live(`${edge.id}_amount`)}
                    moduleId={id}
                    paramId={`${edge.id}_amount`}
                  />
                {/if}
                {#if labels.param}
                  {@const r = paramRange(`${edge.id}_param`)}
                  <Fader
                    value={pget(`${edge.id}_param`)}
                    min={r.min}
                    max={r.max}
                    defaultValue={defaultFor(`${edge.id}_param`)}
                    label={labels.param}
                    curve="linear"
                    onchange={set(`${edge.id}_param`)}
                    readLive={live(`${edge.id}_param`)}
                    moduleId={id}
                    paramId={`${edge.id}_param`}
                  />
                {/if}
              </div>
            {:else}
              <p class="edge-hint">pure dissolve (joystick ratio)</p>
            {/if}
          </div>
        {/each}
      </div>

      <!-- shared chroma key colour (shown only when an edge runs CHROMA) -->
      {#if anyChroma}
        <div class="key-row" data-testid="quadralogical-keycolor">
          <span class="key-label">CHROMA KEY</span>
          <Fader value={pget('keyR')} min={0} max={1} defaultValue={defaultFor('keyR')} label="R" curve="linear" onchange={set('keyR')} readLive={live('keyR')} moduleId={id} paramId="keyR" />
          <Fader value={pget('keyG')} min={0} max={1} defaultValue={defaultFor('keyG')} label="G" curve="linear" onchange={set('keyG')} readLive={live('keyG')} moduleId={id} paramId="keyG" />
          <Fader value={pget('keyB')} min={0} max={1} defaultValue={defaultFor('keyB')} label="B" curve="linear" onchange={set('keyB')} readLive={live('keyB')} moduleId={id} paramId="keyB" />
        </div>
      {/if}
    </div>
  </PatchPanel>
</div>

{#if menuOpen}
  <div use:portal>
    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
    <div
      class="ctx-overlay"
      onclick={closeMenu}
      oncontextmenu={(e) => { e.preventDefault(); closeMenu(); }}
      role="presentation"
    ></div>
    <div
      class="ctx-menu"
      style:left="{menuX}px"
      style:top="{menuY}px"
      role="menu"
      aria-label="Quadralogical axis MIDI actions"
      data-testid="quadralogical-axis-menu"
    >
      <div class="ctx-header">QUADRALOGICAL — JOYSTICK</div>
      <button class="ctx-item" role="menuitem" data-testid="quadralogical-assign-x" onclick={() => assignAxis('pos_x')}>Assign MIDI to X…</button>
      <button class="ctx-item" role="menuitem" data-testid="quadralogical-assign-y" onclick={() => assignAxis('pos_y')}>Assign MIDI to Y…</button>
      {#if bindX}
        <button class="ctx-item subtle" role="menuitem" data-testid="quadralogical-forget-x" onclick={() => forgetAxis('pos_x')}>Forget X (CH {bindX.channel + 1} · CC {bindX.cc})</button>
      {/if}
      {#if bindY}
        <button class="ctx-item subtle" role="menuitem" data-testid="quadralogical-forget-y" onclick={() => forgetAxis('pos_y')}>Forget Y (CH {bindY.channel + 1} · CC {bindY.cc})</button>
      {/if}
    </div>
  </div>
{/if}

<style>
  .quadralogical-card { width: 480px; }
  .stripe {
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    border-radius: 2px 2px 0 0;
  }
  .body {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    margin-top: 8px;
  }
  .pad-wrap {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
  }
  .pad {
    position: relative;
    background: #0c0e14;
    border: 1px solid var(--cable-video);
    border-radius: 3px;
    touch-action: none;
    cursor: crosshair;
    user-select: none;
    overflow: hidden;
  }
  .corner {
    position: absolute;
    font-size: 0.62rem;
    color: var(--text-dim, #9aa);
    font-family: ui-monospace, monospace;
    pointer-events: none;
    letter-spacing: 0.04em;
  }
  .corner.tl { top: 4px; left: 6px; }
  .corner.tr { top: 4px; right: 6px; }
  .corner.bl { bottom: 4px; left: 6px; }
  .corner.br { bottom: 4px; right: 6px; }
  .crosshair-h, .crosshair-v {
    position: absolute;
    background: rgba(255, 255, 255, 0.08);
    pointer-events: none;
  }
  .crosshair-h { left: 0; right: 0; top: 50%; height: 1px; transform: translateY(-0.5px); }
  .crosshair-v { top: 0; bottom: 0; left: 50%; width: 1px; transform: translateX(-0.5px); }
  .diamond {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%) rotate(45deg);
    border: 1px solid var(--yellow, #ffd24a);
    background: rgba(255, 220, 0, 0.10);
    pointer-events: none;
  }
  .dot {
    position: absolute;
    width: 34px;
    height: 34px;
    border-radius: 50%;
    border: 2px solid #fff;
    transform: translate(-50%, -50%);
    box-shadow: 0 0 12px rgba(255, 255, 255, 0.35);
    transition: box-shadow 80ms ease-out;
    pointer-events: none;
  }
  .dot.active { box-shadow: 0 0 20px rgba(255, 255, 255, 0.7); }
  .dot.learning { animation: learn-pulse 0.9s ease-in-out infinite; }
  @keyframes learn-pulse {
    0%, 100% { box-shadow: 0 0 8px rgba(0, 240, 255, 0.5); }
    50% { box-shadow: 0 0 22px rgba(0, 240, 255, 1); }
  }
  .readout {
    display: flex;
    gap: 12px;
    align-items: center;
    font-size: 0.72rem;
    color: var(--text-dim, #aaa);
    font-variant-numeric: tabular-nums;
  }
  .readout strong { color: var(--text); font-weight: 500; }
  .midi-badge {
    font-size: 0.55rem;
    color: var(--accent, #6cf);
    border: 1px solid var(--accent, #6cf);
    border-radius: 2px;
    padding: 0 3px;
    letter-spacing: 0.04em;
  }
  .canvas-wrap {
    border: 1px solid var(--cable-video);
    border-radius: 2px;
    overflow: hidden;
    line-height: 0;
    background: #050608;
  }
  .canvas-wrap canvas {
    display: block;
    image-rendering: pixelated;
    background: #050608;
  }
  /* four per-edge effect slots, laid out 2×2 so they're roomy not cramped */
  .edges {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    width: 100%;
    padding: 0 6px;
  }
  .edge-slot {
    display: flex;
    flex-direction: column;
    gap: 6px;
    background: #161a22;
    border: 1px solid #2c333f;
    border-radius: 4px;
    padding: 6px 8px;
    min-height: 88px;
  }
  .edge-head {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .edge-name {
    font-size: 0.58rem;
    letter-spacing: 0.06em;
    color: var(--text-dim);
    font-family: ui-monospace, monospace;
  }
  .fx-select {
    width: 100%;
    background: #2a2f3a;
    color: var(--text);
    border: 1px solid #404652;
    border-radius: 3px;
    padding: 2px 4px;
    font-size: 0.66rem;
    font-family: ui-monospace, monospace;
    letter-spacing: 0.02em;
    cursor: pointer;
  }
  .fx-select:hover { border-color: var(--cable-video); }
  .edge-faders {
    display: flex;
    gap: 12px;
    justify-content: center;
    padding: 2px 0;
  }
  .edge-hint {
    font-size: 0.6rem;
    color: var(--text-dim);
    margin: 4px 0;
    font-style: italic;
    text-align: center;
  }
  .key-row {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 4px 8px;
    background: #161a22;
    border: 1px solid #2c333f;
    border-radius: 4px;
  }
  .key-label {
    font-size: 0.58rem;
    letter-spacing: 0.06em;
    color: var(--text-dim);
    font-family: ui-monospace, monospace;
  }

  /* bespoke 2-axis menu (mirrors ControlContextMenu chrome) */
  .ctx-overlay { position: fixed; inset: 0; z-index: 200; }
  .ctx-menu {
    position: fixed;
    z-index: 201;
    min-width: 200px;
    background: var(--module-bg);
    border: 1px solid #404652;
    border-radius: 6px;
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.5);
    overflow: hidden;
    font-size: 0.85rem;
    padding: 4px 0;
  }
  .ctx-header {
    font-size: 0.65rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-dim);
    padding: 6px 12px 4px;
    pointer-events: none;
  }
  .ctx-item {
    display: block;
    width: 100%;
    background: transparent;
    border: none;
    color: var(--text);
    text-align: left;
    padding: 6px 12px;
    font-size: 0.85rem;
    font-family: inherit;
    cursor: pointer;
  }
  .ctx-item.subtle { color: var(--text-dim); font-size: 0.78rem; }
  .ctx-item:hover, .ctx-item:focus-visible {
    background: rgba(96, 165, 250, 0.1);
    outline: none;
  }
</style>
