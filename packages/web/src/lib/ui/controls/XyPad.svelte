<script lang="ts">
  // XyPad — a reusable draggable 2-D joystick control.
  //
  // Presents a PAIR of continuous params as one square pad whose dot you drag
  // in 2-D: the HORIZONTAL axis drives `x`, the VERTICAL axis drives `y`
  // (dragging UP = larger `y`, the joystick convention). It is the shared
  // draggable-pad primitive the module cards had been hand-cloning inline
  // (JoystickCard / QuadralogicalCard / WavesculptCard each grew their own copy).
  //
  // It writes through the SAME seam the Knob/Fader use: each axis calls its
  // `onXChange` / `onYChange` (the card wires these to `setNodeParam`), and the
  // high-frequency pointer stream is rAF-coalesced through `createDragCommit`
  // (identical to Knob) so a hand-drag can't storm the SyncedStore / Y.Doc.
  //
  // CV-assignable: the pad is a controlled component — the card passes the
  // CURRENT (CV-modulated) value as `xValue`/`yValue` (polled from the engine's
  // readParam), so a patched CV cable MOVES the dot in real time, exactly like a
  // motorized Knob. During a user drag the pad owns the dot (its own synchronous
  // live value) so the poll can't fight the gesture.
  //
  // a11y: the pad is focusable (role="application") and the arrow keys nudge each
  // axis (Left/Right = x, Up/Down = y; Shift = fine). Double-click resets both
  // axes to their defaults.
  //
  // MIDI / Electra ASSIGN (per axis): a 2-D pad isn't a single-CC <Knob>, but its
  // TWO axes each ARE single params, so when the caller passes `moduleId` +
  // `xParamId`/`yParamId` the pad renders a tiny per-axis ASSIGN BUTTON (X / Y).
  // The button doesn't change the value (the pad still drives it) — click or
  // right-click opens the SAME shared ControlContextMenu a Knob uses (MIDI Learn /
  // Forget / Send to Control Surface / Electra ▸ Row ▸ knob), wired through the
  // SAME makeMidiAssignable factory (kind:'cc') against that axis's paramId, so a
  // bound CC / surface / Electra control drives the axis exactly like a knob CC.
  // (midi-learn-wiring-audit now COVERS these axes — see that test's XyPad scan.)

  import { createDragCommit } from './drag-commit';
  import { onDestroy, onMount, untrack } from 'svelte';
  import ControlContextMenu from './ControlContextMenu.svelte';
  import { makeMidiAssignable } from './midi-assignable.svelte';

  interface Props {
    /** Current HORIZONTAL-axis value (already CV-modulated by the caller). */
    xValue: number;
    /** Current VERTICAL-axis value (already CV-modulated by the caller). */
    yValue: number;
    xMin: number;
    xMax: number;
    yMin: number;
    yMax: number;
    /** Short label shown for each axis in the readout. */
    xLabel: string;
    yLabel: string;
    /** Default values for the double-click reset (fall back to min if absent). */
    xDefault?: number;
    yDefault?: number;
    /** Commit seams — the card wires these to setNodeParam(id, paramId, v). */
    onXChange: (v: number) => void;
    onYChange: (v: number) => void;
    /** Pad edge length in px (square). */
    size?: number;
    /** Group caption drawn above the pad. */
    title?: string;
    /** data-testid base: `<testid>-pad` / `-dot` / `-readout` / `-assign-x` / `-assign-y`. */
    testid?: string;
    /** Patch-graph node id. When set together with xParamId + yParamId, the pad
     *  renders per-axis MIDI/Electra ASSIGN buttons (the axes become learnable). */
    moduleId?: string;
    /** Param id the HORIZONTAL axis drives (for the X assign button). */
    xParamId?: string;
    /** Param id the VERTICAL axis drives (for the Y assign button). */
    yParamId?: string;
  }

  let {
    xValue,
    yValue,
    xMin,
    xMax,
    yMin,
    yMax,
    xLabel,
    yLabel,
    xDefault,
    yDefault,
    onXChange,
    onYChange,
    size = 84,
    title,
    testid,
    moduleId,
    xParamId,
    yParamId,
  }: Props = $props();

  function clampX(v: number): number { return Math.min(xMax, Math.max(xMin, v)); }
  function clampY(v: number): number { return Math.min(yMax, Math.max(yMin, v)); }

  // ── drag state ──
  let padEl: HTMLDivElement | null = $state(null);
  let dragging = $state(false);
  // Synchronous live values during a drag (mirror the coalesced store commit so
  // the dot tracks the pointer at full rate — the Knob liveValue pattern).
  // untrack: seed from the initial prop only (the drag/poll own it afterwards).
  let liveX = $state(untrack(() => xValue));
  let liveY = $state(untrack(() => yValue));

  // Displayed values: the pad's own live value WHILE dragging (the gesture owns
  // the dot), otherwise the caller's prop (which reflects the CV-modulated store).
  let dispX = $derived(dragging ? liveX : xValue);
  let dispY = $derived(dragging ? liveY : yValue);

  // Dot position (0..size). Vertical is flipped: larger y = higher on screen.
  let dotLeft = $derived(
    xMax > xMin ? ((clampX(dispX) - xMin) / (xMax - xMin)) * size : size / 2,
  );
  let dotTop = $derived(
    yMax > yMin ? (1 - (clampY(dispY) - yMin) / (yMax - yMin)) * size : size / 2,
  );

  const commitX = createDragCommit((v) => onXChange(v));
  const commitY = createDragCommit((v) => onYChange(v));

  // ── per-axis MIDI / Electra assign (shared makeMidiAssignable factory) ──
  // One kind:'cc' assignable per axis, bound to that axis's paramId + range +
  // setter. A learned CC (0..127 → [min,max]) drives the axis exactly like a
  // knob CC; Send-to-Surface / Electra flow through the SAME menu a Knob opens.
  // Getters keep the factory reading the CURRENT reactive props. Registration is
  // a no-op when moduleId/paramId are absent (a pad used without assign buttons).
  const midiX = makeMidiAssignable({
    kind: 'cc',
    get moduleId() { return moduleId; },
    get paramId() { return xParamId; },
    get min() { return xMin; },
    get max() { return xMax; },
    get onchange() { return onXChange; },
  });
  const midiY = makeMidiAssignable({
    kind: 'cc',
    get moduleId() { return moduleId; },
    get paramId() { return yParamId; },
    get min() { return yMin; },
    get max() { return yMax; },
    get onchange() { return onYChange; },
  });
  let assignable = $derived(!!(moduleId && xParamId && yParamId));

  // ONE shared context menu; the active axis picks which assignable it drives.
  let ctxOpen = $state(false);
  let ctxX = $state(0);
  let ctxY = $state(0);
  let ctxAxis = $state<'x' | 'y'>('x');
  let ctxMidi = $derived(ctxAxis === 'x' ? midiX : midiY);
  let ctxLabel = $derived(ctxAxis === 'x' ? xLabel : yLabel);

  function openAxisMenu(axis: 'x' | 'y', ev: MouseEvent): void {
    ev.preventDefault();
    ev.stopPropagation();
    ctxAxis = axis;
    (axis === 'x' ? midiX : midiY).refresh();
    ctxX = ev.clientX;
    ctxY = ev.clientY;
    ctxOpen = true;
  }

  onMount(() => { midiX.register(); midiY.register(); });
  onDestroy(() => {
    commitX.dispose();
    commitY.dispose();
    midiX.unregister();
    midiY.unregister();
  });

  function writeFromPointer(ev: PointerEvent): void {
    if (!padEl) return;
    const rect = padEl.getBoundingClientRect();
    const px = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
    const py = Math.min(1, Math.max(0, (ev.clientY - rect.top) / rect.height));
    const nx = clampX(xMin + px * (xMax - xMin));
    const ny = clampY(yMin + (1 - py) * (yMax - yMin)); // flip: up = +y
    liveX = nx;
    liveY = ny;
    if (nx !== xValue) commitX.commit(nx);
    if (ny !== yValue) commitY.commit(ny);
  }

  function onPointerDown(ev: PointerEvent): void {
    if (ev.button !== 0 || !padEl) return;
    dragging = true;
    liveX = xValue;
    liveY = yValue;
    padEl.setPointerCapture(ev.pointerId);
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
    try { padEl?.releasePointerCapture(ev.pointerId); } catch { /* */ }
    // No snap-back: a 2-D position control should stay where you put it.
  }
  function onLostCapture(): void {
    if (!dragging) return;
    dragging = false;
    commitX.flush();
    commitY.flush();
  }

  function onDblClick(): void {
    onXChange(clampX(xDefault ?? xMin));
    onYChange(clampY(yDefault ?? yMin));
  }

  // ── keyboard a11y — arrow keys nudge each axis (Shift = fine). ──
  function onKeyDown(ev: KeyboardEvent): void {
    const div = ev.shiftKey ? 200 : 40;
    const stepX = (xMax - xMin) / div;
    const stepY = (yMax - yMin) / div;
    let handled = true;
    switch (ev.key) {
      case 'ArrowLeft': onXChange(clampX(dispX - stepX)); break;
      case 'ArrowRight': onXChange(clampX(dispX + stepX)); break;
      case 'ArrowUp': onYChange(clampY(dispY + stepY)); break;
      case 'ArrowDown': onYChange(clampY(dispY - stepY)); break;
      case 'Home': onXChange(clampX(xDefault ?? xMin)); onYChange(clampY(yDefault ?? yMin)); break;
      default: handled = false;
    }
    if (handled) { ev.preventDefault(); ev.stopPropagation(); }
  }

  function fmt(v: number): string {
    const a = Math.abs(v);
    return a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : v.toFixed(2);
  }
  let ariaLabel = $derived(
    `${title ?? 'XY pad'}: ${xLabel} ${fmt(dispX)}, ${yLabel} ${fmt(dispY)}`,
  );
</script>

<div class="xy-pad-wrap">
  {#if title}<div class="xy-title">{title}</div>{/if}
  <!-- role="application" is the correct ARIA role for a 2-D manipulation surface
       with its own keyboard handling; Svelte's a11y linter still flags the
       tabindex + listeners on the <div>, so silence those specific rules. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class="xy-pad nodrag"
    bind:this={padEl}
    style="width: {size}px; height: {size}px;"
    role="application"
    tabindex="0"
    aria-label={ariaLabel}
    data-testid={testid ? `${testid}-pad` : undefined}
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={onPointerUp}
    onlostpointercapture={onLostCapture}
    onpointercancel={onPointerUp}
    ondblclick={onDblClick}
    onkeydown={onKeyDown}
  >
    <div class="xy-cross-h"></div>
    <div class="xy-cross-v"></div>
    <div
      class="xy-dot"
      class:active={dragging}
      style="left: {dotLeft}px; top: {dotTop}px;"
      data-testid={testid ? `${testid}-dot` : undefined}
    ></div>
  </div>
  <div class="xy-readout" data-testid={testid ? `${testid}-readout` : undefined}>
    <span>{xLabel} <strong>{fmt(dispX)}</strong></span>
    <span>{yLabel} <strong>{fmt(dispY)}</strong></span>
  </div>

  {#if assignable}
    <!-- Per-axis MIDI/Electra ASSIGN handles. They do NOT change the value —
         click or right-click opens the shared ControlContextMenu for that axis's
         param. A learned CC (or a Surface/Electra proxy) then drives the axis. -->
    <div class="xy-assign" role="group" aria-label="{title ?? 'axis'} MIDI assign">
      <button
        type="button"
        class="xy-assign-btn nodrag"
        class:learning={midiX.learning}
        class:bound={!!midiX.binding}
        title="Assign MIDI / Control Surface / Electra to {xLabel} (right-click or click)"
        data-testid={testid ? `${testid}-assign-x` : undefined}
        onclick={(e) => openAxisMenu('x', e)}
        oncontextmenu={(e) => openAxisMenu('x', e)}
      >x{#if midiX.badge}<span class="xy-badge">{midiX.badge}</span>{/if}</button>
      <button
        type="button"
        class="xy-assign-btn nodrag"
        class:learning={midiY.learning}
        class:bound={!!midiY.binding}
        title="Assign MIDI / Control Surface / Electra to {yLabel} (right-click or click)"
        data-testid={testid ? `${testid}-assign-y` : undefined}
        onclick={(e) => openAxisMenu('y', e)}
        oncontextmenu={(e) => openAxisMenu('y', e)}
      >y{#if midiY.badge}<span class="xy-badge">{midiY.badge}</span>{/if}</button>
    </div>
  {/if}
</div>

{#if assignable}
  <ControlContextMenu
    open={ctxOpen}
    x={ctxX}
    y={ctxY}
    title={`${moduleId} · ${ctxLabel}`}
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
{/if}

<style>
  .xy-pad-wrap {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 3px;
  }
  .xy-title {
    font-size: 0.5rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-dim);
    font-family: ui-monospace, monospace;
    align-self: stretch;
    text-align: center;
  }
  .xy-pad {
    position: relative;
    background: #0c0e14;
    border: 1px solid var(--border);
    border-radius: 3px;
    touch-action: none;
    user-select: none;
    cursor: crosshair;
  }
  .xy-pad:hover { border-color: var(--accent-dim); }
  .xy-pad:focus-visible { outline: 1px solid var(--accent, #6884d7); outline-offset: 1px; }
  .xy-cross-h,
  .xy-cross-v {
    position: absolute;
    background: rgba(255, 255, 255, 0.08);
    pointer-events: none;
  }
  .xy-cross-h { left: 0; right: 0; top: 50%; height: 1px; }
  .xy-cross-v { top: 0; bottom: 0; left: 50%; width: 1px; }
  .xy-dot {
    position: absolute;
    width: 10px;
    height: 10px;
    margin-left: -5px;
    margin-top: -5px;
    border-radius: 50%;
    background: var(--accent, #6884d7);
    border: 1px solid rgba(255, 255, 255, 0.7);
    box-shadow: 0 0 4px rgba(104, 132, 215, 0.6);
    pointer-events: none;
  }
  .xy-dot.active {
    background: var(--accent, #8aa2ef);
    box-shadow: 0 0 6px rgba(138, 162, 239, 0.9);
  }
  .xy-readout {
    display: flex;
    gap: 6px;
    font-size: 0.5rem;
    font-family: ui-monospace, monospace;
    letter-spacing: 0.02em;
    color: var(--text-dim);
  }
  .xy-readout strong { color: var(--text); font-weight: 600; }

  /* Per-axis MIDI/Electra assign handles — tiny so they stay within the card
     control-overflow bounds. They are pure assign handles (no value change). */
  .xy-assign {
    display: flex;
    gap: 4px;
  }
  .xy-assign-btn {
    position: relative;
    min-width: 15px;
    height: 13px;
    padding: 0 3px;
    line-height: 1;
    font-size: 0.5rem;
    font-family: ui-monospace, monospace;
    letter-spacing: 0.02em;
    color: var(--text-dim);
    background: var(--module-bg);
    border: 1px solid var(--border);
    border-radius: 2px;
    cursor: context-menu;
    user-select: none;
  }
  .xy-assign-btn:hover { border-color: var(--accent-dim); color: var(--text); }
  .xy-assign-btn.bound {
    color: #a8d3ff;
    border-color: rgba(96, 165, 250, 0.5);
  }
  .xy-assign-btn.learning {
    outline: 1px solid #f5c248;
    outline-offset: 1px;
    animation: xy-learn-pulse 1.1s ease-in-out infinite;
  }
  @keyframes xy-learn-pulse {
    0%, 100% { outline-color: rgba(245, 194, 72, 1); }
    50%      { outline-color: rgba(245, 194, 72, 0.3); }
  }
  .xy-badge {
    margin-left: 2px;
    font-size: 0.45rem;
    color: #a8d3ff;
  }
</style>
