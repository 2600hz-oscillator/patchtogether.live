<script lang="ts">
  // packages/web/src/lib/ui/modules/quadralogical/QuadralogicalScreenBody.svelte
  //
  // THE QUADRALOGICAL SCREEN — the dock full-view body, and the one surface on
  // this module where the PICTURE and the CONTROL are the same element.
  //
  // ── WHAT IT IS ─────────────────────────────────────────────────────────────
  //
  // The joystick field, exactly as the legacy card draws it — IN1..IN4 corner
  // labels on the quadWeights corner map, the crosshair at the origin, the
  // yellow diamond that IS `diamond_margin`, and the puck tinted by whichever
  // input the composite currently favours — with ONE addition and ONE
  // subtraction against that card:
  //
  //   + SCREEN ON puts a live preview of each input BEHIND its own quadrant.
  //   - the card's `x: 0.00  y: 0.00` row is GONE (owner ruling, four times
  //     over: the resting faceplate paints no derived-state text). The values
  //     live in this element's accessible name.
  //
  // ── ⚠ THE PREVIEW COSTS NO NEW GLSL ────────────────────────────────────────
  //
  // QUADRALOGICAL already renders a SECOND FBO every frame — a 2×2 tile of the
  // four RAW inputs, in1 TL / in2 TR / in3 BL / in4 BR, with a thin separator
  // cross — and already exposes it as the `preview` output port
  // (PREVIEW_FRAG_SRC). Its quadrant map is the SAME corner map `quadWeights`
  // uses, so the previews land under the corner labels by construction. This
  // component is one `blitOutputPortForPreview(nodeId, 'preview')`.
  //
  // ── ⚠ THE FRAME RE-ASPECTS ON ITS WIDTH, AND THE HEIGHT NEVER MOVES ────────
  //
  // A quadrant is one input at VIDEO_RES (1024×768 = 4:3), so a 2×2 of 4:3
  // tiles is 8:6 = 4:3 overall, while the OFF state is the card's square pad.
  // Pinning the HEIGHT and letting the WIDTH change is what makes the toggle
  // cost ZERO vertical reflow — which matters precisely because the four EDGE
  // boxes sit in the band directly below this body. A height-changing toggle
  // would jump them under the player's cursor mid-performance.
  //
  // ── ⚠ SCREEN OFF MEANS SOMETHING DIFFERENT HERE THAN ON THE OTHER BODIES ───
  //
  // The 2026-08-18 ruling says OFF collapses the preview and reclaims its space
  // while the module keeps rendering. On every other adopter the collapsed
  // thing is a canvas and nothing else, so OFF reclaims the whole box. HERE THE
  // FRAME IS ALSO THE CONTROL: collapsing it would delete the joystick, which
  // is the `joystick` (#1974) parity refusal, self-inflicted. So OFF unmounts
  // the canvases, keeps the field, and reclaims 120 px of WIDTH.
  //
  // ⚠ AND OFF STILL MARKS THE NODE WATCHED, EVERY FRAME (#1937 / #2015). The
  // blit IS the engine's "someone is watching" signal — `blitOutputForPreview`
  // calls `markWatched` itself — and a node is a pull root only while that mark
  // is fresh. A collapsed state that merely stopped blitting would drop this
  // node out of the pull set, turning a control labelled SCREEN into a PRODUCER
  // KILL SWITCH for everything downstream of `out`. On a MIXER that is worse
  // than on a generator: the module exists to feed something, and it has a
  // SECOND output (`preview`) a player may be watching on a downstream monitor
  // while this screen is off.

  import { onDestroy, onMount } from 'svelte';
  import { patch } from '$lib/graph/store';
  import { mutateNode } from '$lib/graph/mutate';
  import type { ModuleNode } from '$lib/graph/types';
  import type { VideoEngine } from '$lib/video/engine';
  import { cardParams } from '../card-kit';
  import { createDragCommit } from '$lib/ui/controls/drag-commit';
  import ControlContextMenu from '$lib/ui/controls/ControlContextMenu.svelte';
  import { makeMidiAssignable } from '$lib/ui/controls/midi-assignable.svelte';
  import {
    quadralogicalDef,
    quadWeights,
    clampJoy,
  } from '$lib/video/modules/quadralogical';
  // The PURE half — geometry + the accessible name. Imported rather than
  // re-typed so `quadralogical-face-model.test.ts` asserts the SAME numbers
  // this component renders, which is the only way those assertions mean
  // anything (the backdraft one-place rule, applied to geometry).
  import {
    QUAD_FIELD_H,
    QUAD_INPUT_NAMES,
    quadDiamondClipPath,
    quadDominantInput,
    quadFieldWidth,
    quadPadAriaLabel,
  } from '../quadralogical-face-model';

  interface Props {
    /** The graph node this faceplate is showing — the ONLY prop the slot gets
     *  (`ShellExtensionFullViewBodyProps`). */
    nodeId: string;
  }
  let { nodeId }: Props = $props();

  let node = $derived(patch.nodes[nodeId] as ModuleNode | undefined);
  const { set, live, engineCtx, defaultFor, paramVal } = cardParams(
    quadralogicalDef,
    () => nodeId,
    () => node,
  );

  // ── SCREEN ON/OFF ─────────────────────────────────────────────────────────
  // ⚠ STATE ON THE NODE, NOT IN THE COMPONENT. This component unmounts on dock
  // collapse / LRU eviction (the #1531 / #1574 / #1583 class), and `node.data`
  // is what survives a tab switch (the owner's stated floor), a remount, a
  // reload, and collab sync.
  //
  // ⚠ IT IS THE SAME `previewCollapsed` KEY EVERY OTHER VIDEO SURFACE USES,
  // deliberately: a rack saved before this promotion already carries it, and
  // reading a different key would silently re-open every preview collapsed
  // before the promotion. Absent ⇒ false ⇒ ON.
  let previewCollapsed = $derived<boolean>(
    (patch.nodes[nodeId]?.data?.previewCollapsed as boolean | undefined) ?? false,
  );
  function toggleScreen(): void {
    const next = !previewCollapsed;
    mutateNode(nodeId, (liveNode) => {
      if (!liveNode.data) liveNode.data = {};
      liveNode.data.previewCollapsed = next;
    });
  }
  let fieldW = $derived(quadFieldWidth(previewCollapsed));

  // ── THE JOYSTICK ──────────────────────────────────────────────────────────
  let fieldEl: HTMLDivElement | null = $state(null);
  let dragging = $state(false);
  // Live values polled off the engine so a patched CV / bound CC moves the puck
  // in real time; suppressed while the pointer owns the gesture.
  let livePosX = $state<number | null>(null);
  let livePosY = $state<number | null>(null);
  // Synchronous drag values, so the puck tracks the pointer at full rate while
  // the store commit is rAF-coalesced (the Knob/XyPad liveValue pattern).
  let dragX = $state(0);
  let dragY = $state(0);

  let pos_x = $derived(
    clampJoy(dragging ? dragX : (livePosX ?? paramVal('pos_x'))),
  );
  let pos_y = $derived(
    clampJoy(dragging ? dragY : (livePosY ?? paramVal('pos_y'))),
  );
  let margin = $derived(paramVal('diamond_margin'));
  let sharp = $derived(paramVal('blend_sharp'));

  // The SAME function the GLSL MIX runs, so the puck's tint, the drawn diamond
  // and the rendered composite agree to the number.
  let weights = $derived(quadWeights(pos_x, pos_y, margin, sharp));
  const INPUT_COLORS = ['#ff5a5a', '#5aff7a', '#5a9bff', '#ffd24a']; // in1..in4
  let dominantIdx = $derived(quadDominantInput(weights));
  let dotColor = $derived(INPUT_COLORS[dominantIdx] ?? '#ffd24a');

  // Puck position as a PERCENTAGE of the frame, so it is correct at either
  // aspect without a second derivation.
  let dotLeftPct = $derived(((pos_x + 1) / 2) * 100);
  let dotTopPct = $derived(((-pos_y + 1) / 2) * 100);

  /**
   * The diamond, as a clip-path polygon in PERCENTAGES of the frame.
   *
   * ⚠ IT IS A RHOMBUS AND IT CANNOT BE A ROTATED SQUARE. The boundary this
   * draws is `|x| + |y| = diamond_margin` in NORMALISED coordinates, whose
   * horizontal semi-axis is `margin·W/2` and vertical semi-axis `margin·H/2`.
   * The legacy card draws it as a CSS square with `rotate(45deg)`, which has
   * EQUAL semi-axes — correct at 1:1 and only at 1:1. With SCREEN ON this frame
   * is 4:3, so a rotated square would be wrong by 4/3 on one axis: it would
   * claim the all-four zone reaches further up the field than it does, and the
   * drawn geometry would stop being 1:1 with the math the shader runs.
   * Percentages are aspect-free, so ONE expression is right in both states.
   *
   * (The card is not changed — at 1:1 its version is correct where it lives,
   * and editing it would move a VRT baseline for no behaviour.)
   */
  let diamondClip = $derived(quadDiamondClipPath(margin));

  const commitX = createDragCommit((v) => set('pos_x')(v));
  const commitY = createDragCommit((v) => set('pos_y')(v));

  function writeFromPointer(ev: PointerEvent): void {
    if (!fieldEl) return;
    const rect = fieldEl.getBoundingClientRect();
    const px = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
    const py = Math.min(1, Math.max(0, (ev.clientY - rect.top) / rect.height));
    const nx = clampJoy(px * 2 - 1);
    const ny = clampJoy(-(py * 2 - 1)); // flip: dragging UP is +y
    dragX = nx;
    dragY = ny;
    commitX.commit(nx);
    commitY.commit(ny);
  }
  function onPointerDown(ev: PointerEvent): void {
    if (ev.button !== 0 || !fieldEl) return;
    dragging = true;
    dragX = pos_x;
    dragY = pos_y;
    fieldEl.setPointerCapture(ev.pointerId);
    writeFromPointer(ev);
    ev.preventDefault();
    ev.stopPropagation();
  }
  function onPointerMove(ev: PointerEvent): void {
    if (!dragging) return;
    writeFromPointer(ev);
  }
  function onPointerUp(ev: PointerEvent): void {
    if (!dragging) return;
    dragging = false;
    commitX.flush();
    commitY.flush();
    try { fieldEl?.releasePointerCapture(ev.pointerId); } catch { /* */ }
    // No snap-back: a mixer position stays where you put it.
  }
  function onLostCapture(): void {
    if (!dragging) return;
    dragging = false;
    commitX.flush();
    commitY.flush();
  }
  function onDblClick(): void {
    set('pos_x')(defaultFor('pos_x'));
    set('pos_y')(defaultFor('pos_y'));
  }

  // ── per-axis MIDI / Control Surface / Electra ─────────────────────────────
  // The SAME `makeMidiAssignable` + `ControlContextMenu` seam `XyPad` uses, one
  // assignable per axis. This is what carries the legacy card's bespoke 2-axis
  // menu across the promotion — Assign/Forget X and Y, Send/Remove X and Y to a
  // Control Surface, and the Electra ▸ Row ▸ knob cascade — through the SHARED
  // menu rather than a second hand-rolled copy of it.
  const midiX = makeMidiAssignable({
    kind: 'cc',
    get moduleId() { return nodeId; },
    get paramId() { return 'pos_x'; },
    get min() { return -1; },
    get max() { return 1; },
    get onchange() { return set('pos_x'); },
  });
  const midiY = makeMidiAssignable({
    kind: 'cc',
    get moduleId() { return nodeId; },
    get paramId() { return 'pos_y'; },
    get min() { return -1; },
    get max() { return 1; },
    get onchange() { return set('pos_y'); },
  });
  let ctxOpen = $state(false);
  let ctxX = $state(0);
  let ctxY = $state(0);
  let ctxAxis = $state<'x' | 'y'>('x');
  let ctxMidi = $derived(ctxAxis === 'x' ? midiX : midiY);
  function openAxisMenu(axis: 'x' | 'y', ev: MouseEvent): void {
    ev.preventDefault();
    ev.stopPropagation();
    ctxAxis = axis;
    (axis === 'x' ? midiX : midiY).refresh();
    ctxX = ev.clientX;
    ctxY = ev.clientY;
    ctxOpen = true;
  }

  // ── THE ACCESSIBLE VALUE ─────────────────────────────────────────────────
  // ⚠ `aria-label`, NOT `aria-valuetext`, and it is settled platform rather
  // than a shortcut: this is `role="application"` — the correct role for a 2-D
  // manipulation surface that owns its own handling — and `aria-valuetext` is
  // only meaningful on a RANGE role. `XyPad.svelte` records the same conclusion
  // where #2038 deleted the generic pad's readout row, and every spec proving a
  // pad tracks the graph reads this attribute.
  //
  // The trailing name is the one fact the card carried in a COLOUR and nowhere
  // else — which input the composite currently favours. A colour is not
  // speakable, and it is a NAME rather than a measurement.
  let ariaLabel = $derived(quadPadAriaLabel(pos_x, pos_y, dominantIdx));

  // ── THE RENDER LOOP ──────────────────────────────────────────────────────
  let previewEl: HTMLCanvasElement | null = $state(null);
  let puckEl: HTMLCanvasElement | null = $state(null);
  let rafId: number | null = null;

  /** Copy whatever the engine just blitted into its drawing buffer onto a 2-D
   *  canvas, letterboxing to preserve the source aspect. */
  function copyBuffer(canvas: HTMLCanvasElement, src: CanvasImageSource, srcAspect: number): void {
    const ctx2d = canvas.getContext('2d', { alpha: false });
    if (!ctx2d) return;
    const cw = canvas.width;
    const ch = canvas.height;
    ctx2d.fillStyle = '#050608';
    ctx2d.fillRect(0, 0, cw, ch);
    const dstAspect = cw / ch;
    let w = cw, h = ch, x = 0, y = 0;
    if (dstAspect > srcAspect) { h = ch; w = Math.round(h * srcAspect); x = Math.round((cw - w) / 2); }
    else { w = cw; h = Math.round(w / srcAspect); y = Math.round((ch - h) / 2); }
    ctx2d.drawImage(src, x, y, w, h);
  }

  function draw(): void {
    rafId = null;
    // The live-CV poll runs in BOTH screen states — the puck must follow a
    // patched LFO whether or not the picture is on.
    if (!dragging) {
      livePosX = live('pos_x')() ?? null;
      livePosY = live('pos_y')() ?? null;
    }

    const e = engineCtx.get();
    if (!e) { rafId = requestAnimationFrame(draw); return; }
    let videoEngine: VideoEngine | undefined;
    try { videoEngine = e.getDomain<VideoEngine>('video'); }
    catch { videoEngine = undefined; }
    if (!videoEngine) { rafId = requestAnimationFrame(draw); return; }

    if (previewCollapsed) {
      // ⚠ THE WATCH MARK IS RETAINED WITH THE SCREEN OFF. See the header: the
      // blit is the mark, so stopping the blit without this would make the
      // SCREEN switch a producer kill switch for both outputs.
      try { videoEngine.markWatched(nodeId); } catch { /* never nuke the loop */ }
      rafId = requestAnimationFrame(draw);
      return;
    }

    // ── the 2×2 raw-input tile, behind the joystick ──
    // Cadence is tracked per (node, port), so this and the MIX blit below do
    // not throttle each other — the VIDEOCUBE SLICE precedent.
    if (previewEl) {
      let blitted = false;
      try { blitted = videoEngine.blitOutputPortForPreview(nodeId, 'preview'); }
      catch { /* never nuke the loop */ }
      // The tile is 2×2 of 4:3 = 4:3 overall, and the canvas is authored at
      // that ratio, so the letterbox is a no-op — stated rather than assumed.
      if (blitted) copyBuffer(previewEl, videoEngine.canvas as CanvasImageSource, 4 / 3);
    }

    // ── the MIX, inside the puck ──
    // The standalone preview screen is removed; the puck is where the module's
    // own OUTPUT survives on this faceplate. It costs no layout — the dot
    // already existed, already had a position, and is already the one element
    // that is 1:1 with the composite (same `quadWeights`).
    if (puckEl) {
      let blitted = false;
      try { blitted = videoEngine.blitOutputForPreview(nodeId); }
      catch { /* never nuke the loop */ }
      if (blitted) copyBuffer(puckEl, videoEngine.canvas as CanvasImageSource, 4 / 3);
    }

    rafId = requestAnimationFrame(draw);
  }

  onMount(() => { midiX.register(); midiY.register(); });
  // ONE place owns the loop and it runs in BOTH screen states (see above), so
  // nothing has to restart it on toggle — which removes the "switched it back
  // on and the picture never came back" failure mode by construction.
  $effect(() => {
    if (rafId === null) rafId = requestAnimationFrame(draw);
    return () => {
      if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
    };
  });
  onDestroy(() => {
    commitX.dispose();
    commitY.dispose();
    midiX.unregister();
    midiY.unregister();
  });
</script>

<div class="ql-screen" data-testid="quadralogical-screen-body">
  <div class="screen-wrap">
    <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions
         — `role="application"` is exactly right for a control that OWNS its pointer handling.
         Svelte's rules do not model `application` as interactive. -->
    <div
      class="field nodrag"
      class:screen-on={!previewCollapsed}
      bind:this={fieldEl}
      style="width: {fieldW}px; height: {QUAD_FIELD_H}px;"
      role="application"
      tabindex="0"
      aria-label={ariaLabel}
      data-testid="control-pos_x"
      data-control-params="pos_x,pos_y"
      data-screen={previewCollapsed ? 'off' : 'on'}
      onpointerdown={onPointerDown}
      onpointermove={onPointerMove}
      onpointerup={onPointerUp}
      onlostpointercapture={onLostCapture}
      onpointercancel={onPointerUp}
      ondblclick={onDblClick}
    >
      {#if !previewCollapsed}
        <!-- ONE canvas: the module's own `preview` port, which already renders
             in1 TL / in2 TR / in3 BL / in4 BR with its own separator cross. -->
        <canvas
          class="tiles"
          bind:this={previewEl}
          width={480}
          height={360}
          data-testid="quadralogical-face-quadrants"
          data-node-id={nodeId}
        ></canvas>
      {/if}

      <!-- the joystick overlay, ON TOP of the previews -->
      <!-- The corner labels are NAMES — which INPUT each corner (and, with the
           screen on, each quadrant) is. They come from the same roster the
           accessible name reads, so the label under the picture and the word a
           screen reader speaks cannot disagree. -->
      <span class="corner tl"><i style="background: {INPUT_COLORS[0]}"></i>{QUAD_INPUT_NAMES[0]}</span>
      <span class="corner tr"><i style="background: {INPUT_COLORS[1]}"></i>{QUAD_INPUT_NAMES[1]}</span>
      <span class="corner bl"><i style="background: {INPUT_COLORS[2]}"></i>{QUAD_INPUT_NAMES[2]}</span>
      <span class="corner br"><i style="background: {INPUT_COLORS[3]}"></i>{QUAD_INPUT_NAMES[3]}</span>
      <div class="cross-h"></div>
      <div class="cross-v"></div>
      <div
        class="diamond"
        style="clip-path: {diamondClip}"
        data-testid="quadralogical-face-diamond"
      ></div>
      <div
        class="puck"
        class:active={dragging}
        style="left: {dotLeftPct}%; top: {dotTopPct}%; border-color: {dotColor};
               background: {previewCollapsed ? dotColor : 'transparent'};"
        data-testid="quadralogical-face-puck"
      >
        {#if !previewCollapsed}
          <canvas
            class="puck-mix"
            bind:this={puckEl}
            width={64}
            height={48}
            data-testid="quadralogical-face-mix"
            data-node-id={nodeId}
          ></canvas>
        {/if}
      </div>

      <!-- per-axis assign handles. They do NOT change the value — click or
           right-click opens the shared ControlContextMenu for that axis. -->
      <div class="assign" role="group" aria-label="joystick MIDI assign">
        <button
          type="button"
          class="assign-btn nodrag"
          class:learning={midiX.learning}
          class:bound={!!midiX.binding}
          title="Assign MIDI / Control Surface / Electra to X (right-click or click)"
          data-testid="quadralogical-face-assign-x"
          onclick={(ev) => openAxisMenu('x', ev)}
          oncontextmenu={(ev) => openAxisMenu('x', ev)}
        >x{#if midiX.badge}<span class="badge">{midiX.badge}</span>{/if}</button>
        <button
          type="button"
          class="assign-btn nodrag"
          class:learning={midiY.learning}
          class:bound={!!midiY.binding}
          title="Assign MIDI / Control Surface / Electra to Y (right-click or click)"
          data-testid="quadralogical-face-assign-y"
          onclick={(ev) => openAxisMenu('y', ev)}
          oncontextmenu={(ev) => openAxisMenu('y', ev)}
        >y{#if midiY.badge}<span class="badge">{midiY.badge}</span>{/if}</button>
      </div>
    </div>

    <button
      type="button"
      class="screen-btn nodrag"
      class:on={!previewCollapsed}
      onclick={toggleScreen}
      data-testid="quadralogical-face-screen-toggle"
      aria-pressed={!previewCollapsed}
      title={previewCollapsed
        ? 'SCREEN is OFF — the four input previews are collapsed and the field is square. QUADRALOGICAL keeps mixing and keeps rendering both outputs: switching it back on shows the LIVE picture, not a stale frame.'
        : 'SCREEN — turn the four input previews off to square the field and reclaim its width. QUADRALOGICAL goes on mixing and rendering either way.'}
    >{previewCollapsed ? 'SCREEN OFF' : 'SCREEN ON'}</button>
  </div>
</div>

<ControlContextMenu
  open={ctxOpen}
  x={ctxX}
  y={ctxY}
  title={`${nodeId} · ${ctxAxis === 'x' ? 'X' : 'Y'}`}
  hasBinding={!!ctxMidi.binding}
  bindingLabel={ctxMidi.bindingLabel}
  onlearn={ctxMidi.learn}
  onforget={ctxMidi.forget}
  onclose={() => (ctxOpen = false)}
  surfaces={ctxMidi.surfaces}
  onsendtosurface={ctxMidi.sendToSurface}
  onremovefromsurface={ctxMidi.removeFromSurface}
  electras={ctxMidi.electras}
  onassignelectra={ctxMidi.assignElectra}
  onclearelectra={ctxMidi.clearElectra}
  automationRecorded={ctxMidi.automationRecorded}
  onclearautomation={ctxMidi.clearAutomation}
/>

<style>
  .ql-screen {
    display: flex;
    justify-content: center;
    padding: 6px 0 2px;
  }
  /* ⚠ THE SWITCH COSTS ZERO LAYOUT HEIGHT — a fix, not a style choice. A
     stacked row cost ~18.8 px on a card with ~11 px of slack and reddened the
     card sweep (spirographs). It OVERLAYS the frame's bottom-right corner. */
  .screen-wrap {
    position: relative;
    display: flex;
    justify-content: center;
    /* Only load-bearing if the field ever unmounts; inert behind it otherwise. */
    min-height: 18px;
  }
  .field {
    position: relative;
    background: #0c0e14;
    border: 1px solid var(--cable-video);
    border-radius: 3px;
    touch-action: none;
    cursor: crosshair;
    user-select: none;
    overflow: hidden;
    /* The width transition is what the toggle's re-aspect looks like. The
       HEIGHT is a constant, so nothing below this body ever moves. */
    transition: width 120ms ease-out;
  }
  .field:focus-visible { outline: 1px solid var(--accent, #6884d7); outline-offset: 1px; }
  .tiles {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    display: block;
    background: #050608;
  }
  .corner {
    position: absolute;
    font-size: 0.62rem;
    color: var(--text-dim, #9aa);
    font-family: ui-monospace, monospace;
    pointer-events: none;
    letter-spacing: 0.04em;
  }
  .corner i {
    display: inline-block;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    margin-right: 4px;
    vertical-align: middle;
  }
  /* Over a live picture a dim label is unreadable, so SCREEN ON promotes it to
     white on a shadow. Same reason the switch sits on a backplate. */
  .screen-on .corner { color: #fff; text-shadow: 0 0 4px #000, 0 0 2px #000; }
  .corner.tl { top: 4px; left: 6px; }
  .corner.tr { top: 4px; right: 6px; }
  .corner.bl { bottom: 4px; left: 6px; }
  .corner.br { bottom: 4px; right: 6px; }
  .cross-h, .cross-v {
    position: absolute;
    background: rgba(255, 255, 255, 0.08);
    pointer-events: none;
  }
  .screen-on .cross-h, .screen-on .cross-v { background: rgba(255, 255, 255, 0.2); }
  .cross-h { left: 0; right: 0; top: 50%; height: 1px; transform: translateY(-0.5px); }
  .cross-v { top: 0; bottom: 0; left: 50%; width: 1px; transform: translateX(-0.5px); }
  .diamond {
    position: absolute;
    inset: 0;
    background: rgba(255, 220, 0, 0.1);
    outline: 1px solid rgba(255, 210, 74, 0.55);
    outline-offset: -1px;
    pointer-events: none;
  }
  .screen-on .diamond { background: rgba(255, 220, 0, 0.16); }
  .puck {
    position: absolute;
    width: 34px;
    height: 34px;
    border-radius: 50%;
    border: 2px solid #fff;
    transform: translate(-50%, -50%);
    box-shadow: 0 0 12px rgba(255, 255, 255, 0.35);
    transition: box-shadow 80ms ease-out;
    pointer-events: none;
    overflow: hidden;
  }
  .puck.active { box-shadow: 0 0 20px rgba(255, 255, 255, 0.7); }
  .puck-mix {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
    background: #050608;
  }
  .assign { position: absolute; left: 6px; top: 24px; display: flex; gap: 4px; }
  .assign-btn {
    position: relative;
    min-width: 15px;
    height: 13px;
    padding: 0 3px;
    line-height: 1;
    font-size: 0.5rem;
    font-family: ui-monospace, monospace;
    color: var(--text-dim);
    background: rgba(5, 6, 8, 0.72);
    border: 1px solid var(--border);
    border-radius: 2px;
    cursor: context-menu;
  }
  .assign-btn:hover { border-color: var(--accent-dim); color: var(--text); }
  .assign-btn.bound { color: #a8d3ff; border-color: rgba(96, 165, 250, 0.5); }
  .assign-btn.learning { outline: 1px solid #f5c248; outline-offset: 1px; }
  .badge { margin-left: 2px; font-size: 0.45rem; color: #a8d3ff; }
  .screen-btn {
    position: absolute;
    right: 4px;
    bottom: 4px;
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
  .screen-btn.on { color: var(--text); border-color: var(--accent-dim); }
  .screen-btn:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px; }
</style>
