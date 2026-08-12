<script lang="ts">
  // KnobConic — the RACKLINE canonical dial (ux-fullview `.knob`): a
  // conic-gradient VALUE ARC driven by a single normalized `--v` (0..1) + a
  // steel `.cap` + a `.ptr` pointer, tinted by the faceplate's `--domain`
  // (falls back to `--accent`). Behaviour is identical to Knob.svelte — vertical
  // drag (Shift = fine, Cmd/Ctrl = finer), wheel, double-click reset, motorized
  // readLive, MIDI-Learn + ControlContextMenu, clip-automation touch-suspend —
  // so a card swaps Knob → KnobConic with no plumbing change. The existing
  // Knob.svelte is untouched (its ~79 importers keep the flat dial).
  import type { KnobCurve, ParamLandmark, ParamOption } from '$lib/graph/types';
  import { onDestroy, onMount, untrack } from 'svelte';
  import { createDragCommit } from './drag-commit';
  import ControlContextMenu from './ControlContextMenu.svelte';
  import { makeMidiAssignable } from './midi-assignable.svelte';
  import { notifyAutomationTouch, notifyAutomationRelease } from '$lib/audio/automation-touch';
  import { knobValueToFrac, knobFracToValue, knobPointerAngle } from './knob-conic-model';
  import { knobMarks, knobReadout, knobValueReadout } from './knob-vocabulary-model';
  import { formatParamNumber } from './param-format';

  interface Props {
    value: number;
    min: number;
    max: number;
    defaultValue: number;
    label: string;
    units?: string;
    curve?: KnobCurve;
    onchange: (value: number) => void;
    /** Optional live-value reader — polled each rAF (when not dragging) so a
     *  patched LFO visibly rotates the pointer + arc (motorized dial). */
    readLive?: () => number | undefined;
    /** MIDI-Learn addressing — both set ⇒ right-click binds a CC. */
    moduleId?: string;
    paramId?: string;
    /** Dial size. md = the lane default, lg/xl = dock hero, sm = dense grids. */
    size?: 'sm' | 'md' | 'lg' | 'xl';
    /** Override the arc/pointer accent (defaults to the domain colour). */
    accent?: string;
    /**
     * PARAM VOCABULARY (PF-1 / PF-3 / PF-10) — what this dial's numbers MEAN.
     * Supplying ANY of the three earns a PERSISTENT readout under the dial.
     *
     * ⚠ SUPPLYING NONE KEEPS THE BARE KNOB **IN THE LANE ROW ONLY**. PF-20
     * overturned the dock (`readoutMode='always'`, below): an undeclared param
     * there falls back to the numeric ladder, because every mocked faceplate
     * prints a value under every knob and bare labels were the single largest
     * share of the shell-vs-mock drift. And the FULL-tier lane plate overturns
     * it the other way (`readoutMode='none'`): a fixed 42 px grid track has no
     * row to spend at all. The "a readout is earned" argument survives where it
     * was always true — a 46px lane column cannot spend a text row on what
     * hovering already shows.
     *
     * `options` (discrete states) and `landmarks` (continuous waypoints) also
     * paint detent TICKS around the arc. They are never interchangeable — see
     * ParamOption / ParamLandmark; the vocabulary gate enforces the split.
     */
    options?: readonly ParamOption[];
    landmarks?: readonly ParamLandmark[];
    format?: (v: number) => string;
    /**
     * WHICH READOUT RULE THIS DIAL IS UNDER. Three surfaces, three answers, and
     * the reason each one differs is HOW MUCH VERTICAL ROOM THE CELL HAS.
     *
     *   'earned' (default) — the PF-3 gate: the readout line renders only for a
     *      param that declared a vocabulary (`knobReadout` is null otherwise).
     *      The lane ROW layout, which is a flex line with no fixed track and a
     *      112 px body, so one extra text row costs nothing.
     *
     *   'always' — PF-20, the DOCK. The gate above was silently applied to the
     *      faceplate too and that is where it was wrong: every mocked faceplate
     *      carries a formatted value under every knob, and bare labels were the
     *      single largest share of the shell-vs-mock drift. An undeclared param
     *      falls back to the numeric ladder.
     *
     *   'none' — the FULL-tier lane PLATE, added 2026-08-12. That grid's
     *      `grid-auto-rows` is a FIXED 42 px track and `align-items: start`, so
     *      a cell taller than the track is not clipped — IT PAINTS OVER THE ROW
     *      BELOW. MEASURED on adsr: a knob column is 41 px bare and 55 px with a
     *      readout (57 under the VRT scenes' pinned webfonts), in a 46 px row
     *      pitch, i.e. 9 px of row-1-over-row-2 and 13 px of track overrun, seen
     *      as the A/D/S/R values colliding with the knobs beneath them. Two rows
     *      of readout-bearing cells do not fit the 112 px body at any font
     *      (2×57+4 = 118), so the choice is 6 controls without values or 3 with;
     *      see ModuleShell for why it is the former.
     *
     * ⚠ 'none' SUPPRESSES THE PAINTED LINE ONLY. `aria-valuetext` still reports
     * the resolved readout and the active detent tick still lights — a screen
     * reader and the arc must not lose the state name because a grid row is
     * short.
     */
    readoutMode?: 'earned' | 'always' | 'none';
  }

  let {
    value,
    min,
    max,
    defaultValue,
    label,
    units = '',
    curve = 'linear',
    onchange,
    readLive,
    moduleId,
    paramId,
    size = 'md',
    accent,
    options,
    landmarks,
    format: formatValue,
    readoutMode = 'earned',
  }: Props = $props();

  // ---- MIDI-Learn (shared factory, kind:'cc') — getters so the factory reads
  //      the CURRENT reactive props across re-renders (mirrors Knob.svelte). ----
  const midi = makeMidiAssignable({
    kind: 'cc',
    get moduleId() { return moduleId; },
    get paramId() { return paramId; },
    get min() { return min; },
    get max() { return max; },
    get onchange() { return onchange; },
    onTransient: (v) => { if (!dragging) liveValue = v; },
  });

  let ctxOpen = $state(false);
  let ctxX = $state(0);
  let ctxY = $state(0);

  function openContextMenu(e: MouseEvent) {
    if (!moduleId || !paramId) return;
    midi.refresh();
    e.preventDefault();
    e.stopPropagation();
    ctxX = e.clientX;
    ctxY = e.clientY;
    ctxOpen = true;
  }
  onMount(() => midi.register());

  function touchAutomation() {
    if (moduleId && paramId) notifyAutomationTouch({ nodeId: moduleId, paramId }, 'pointer');
  }
  function releaseAutomation() {
    if (moduleId && paramId) notifyAutomationRelease({ nodeId: moduleId, paramId }, 'pointer');
  }
  let wheelReleaseTimer: ReturnType<typeof setTimeout> | null = null;
  function wheelTouch() {
    if (moduleId && paramId) notifyAutomationTouch({ nodeId: moduleId, paramId }, 'wheel');
    if (wheelReleaseTimer !== null) clearTimeout(wheelReleaseTimer);
    wheelReleaseTimer = setTimeout(() => {
      wheelReleaseTimer = null;
      if (moduleId && paramId) notifyAutomationRelease({ nodeId: moduleId, paramId }, 'wheel');
    }, 200);
  }

  let dragging = $state(false);
  let hovering = $state(false);
  let liveValue = $state(untrack(() => value));
  let raf: number | null = null;
  let currentValue = $derived(value);

  $effect(() => {
    if (dragging || midi.ccActive) return;
    if (!readLive) {
      liveValue = currentValue;
      return;
    }
    const reader = readLive;
    function tick() {
      const v = reader();
      liveValue = v ?? currentValue;
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => {
      if (raf !== null) cancelAnimationFrame(raf);
      raf = null;
    };
  });

  $effect(() => {
    if (!dragging && !readLive && !midi.ccActive) liveValue = currentValue;
  });

  const dragCommit = createDragCommit((v) => onchange(v));

  onDestroy(() => {
    if (raf !== null) cancelAnimationFrame(raf);
    if (wheelReleaseTimer !== null) clearTimeout(wheelReleaseTimer);
    dragCommit.dispose();
    midi.unregister();
  });

  // Arc fraction (0..1) → the `--v` custom property + pointer rotation.
  let frac = $derived(knobValueToFrac(liveValue, min, max, curve));
  let ptrAngle = $derived(knobPointerAngle(frac));

  // ── PARAM VOCABULARY (PF-1 / PF-3 / PF-10), resolved in the pure layer ──
  let vocab = $derived({ options, landmarks, format: formatValue });
  /** The RESOLVED readout text — `null` for a plain param under the 'earned'
   *  gate; at the dock ('always') a plain param falls back to the numeric
   *  ladder, so every dial on a faceplate prints its value. This is the
   *  SEMANTIC value: it feeds `aria-valuetext` and the active detent tick
   *  regardless of whether the line is painted. */
  let readout = $derived(
    readoutMode === 'always'
      ? knobValueReadout(liveValue, vocab, units)
      : knobReadout(liveValue, vocab),
  );
  /** …and whether the TEXT LINE is painted. 'none' (the lane plate) resolves
   *  the readout and then does not spend a row on it — see the prop's note. */
  let readoutShown = $derived(readoutMode !== 'none' && readout !== null);
  /** Detent ticks around the arc. Empty unless options/landmarks were declared. */
  let marks = $derived(knobMarks(vocab, min, max, curve));

  let startY = 0;
  let startFrac = 0;
  let mod: 'none' | 'shift' | 'fine' = 'none';

  function pointerdown(e: PointerEvent) {
    if (e.button !== 0) return;
    touchAutomation();
    dragging = true;
    startY = e.clientY;
    startFrac = knobValueToFrac(value, min, max, curve);
    mod = e.shiftKey ? 'shift' : (e.ctrlKey || e.metaKey) ? 'fine' : 'none';
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  function pointermove(e: PointerEvent) {
    if (!dragging) return;
    const dy = startY - e.clientY;
    const sensitivity = mod === 'fine' ? 1 / 20000 : mod === 'shift' ? 1 / 2000 : 1 / 200;
    const newFrac = startFrac + dy * sensitivity;
    const newValue = knobFracToValue(newFrac, min, max, curve);
    liveValue = newValue;
    if (newValue !== value) dragCommit.commit(newValue);
  }

  function pointerup(e: PointerEvent) {
    dragging = false;
    releaseAutomation();
    dragCommit.flush();
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
  }

  function lostcapture() {
    if (!dragging) return;
    dragging = false;
    dragCommit.flush();
    releaseAutomation();
  }

  function dblclick() {
    onchange(defaultValue);
  }

  function wheel(e: WheelEvent) {
    e.preventDefault();
    wheelTouch();
    const step = e.shiftKey ? 0.001 : e.ctrlKey || e.metaKey ? 0.0001 : 0.005;
    const direction = e.deltaY < 0 ? 1 : -1;
    const newFrac = knobValueToFrac(value, min, max, curve) + direction * step;
    const newValue = knobFracToValue(newFrac, min, max, curve);
    if (newValue !== value) onchange(newValue);
  }

  // The readout ladder lives in ONE place (param-format.ts) — see Knob.svelte.
  const format = formatParamNumber;
</script>

<div
  class="knob-wrap"
  class:dragging
  class:midi-learning={midi.learning}
  class:midi-bound={!!midi.binding}
  onpointerenter={() => (hovering = true)}
  onpointerleave={() => (hovering = false)}
  role="presentation"
>
  {#if dragging || hovering}
    <div class="value">{format(liveValue, units)}</div>
  {/if}
  <div
    class="knob {size}"
    role="slider"
    tabindex="0"
    data-testid={paramId ? `control-${paramId}` : undefined}
    aria-label={label}
    aria-valuemin={min}
    aria-valuemax={max}
    aria-valuenow={liveValue}
    aria-valuetext={readout ?? undefined}
    style:--v={frac}
    style:--ka={accent ?? undefined}
    oncontextmenu={openContextMenu}
    onpointerdown={pointerdown}
    onpointermove={pointermove}
    onpointerup={pointerup}
    onlostpointercapture={lostcapture}
    ondblclick={dblclick}
    onwheel={wheel}
  >
    <span class="cap"></span>
    <span class="ptr" style:transform="translate(-50%, -100%) rotate({ptrAngle}deg)"></span>
    <!-- DETENT TICKS (PF-1 options / PF-10 landmarks). Positioned on the SAME
         270° arc as the pointer, so a tick sits exactly where the pointer
         rests at that value under this curve. Decorative: the value is
         reported by aria-valuenow/valuetext, and the ticks are not hit
         targets (the drag gesture owns the whole dial). -->
    {#each marks as m (m.value)}
      <span
        class="tick"
        class:at={readout !== null && m.label !== '' && m.label === readout}
        style:transform="translate(-50%, -100%) rotate({knobPointerAngle(m.frac)}deg)"
      ></span>
    {/each}
  </div>
  <div class="label">{label}</div>
  <!-- PERSISTENT READOUT. In the lane ROW it renders only when the param
       declared a vocabulary (`knobReadout` returns null otherwise) — the "a
       readout is earned" gate, which is a 46px-column argument. At the DOCK
       ('always') an undeclared param falls back to the numeric ladder, so every
       dial on a faceplate prints its value. In the lane PLATE ('none') the line
       is suppressed: its grid track is a fixed 42 px and an over-tall cell
       paints over the row below rather than being clipped. Same ladder in every
       case that DOES print, which is what stops a hero readout and the dial
       under it disagreeing about one number. -->
  {#if readoutShown}
    <div class="readout" data-testid={paramId ? `readout-${paramId}` : undefined}>{readout}</div>
  {/if}
  {#if midi.binding}
    <div class="midi-badge" title={`Bound to MIDI ${midi.bindingLabel}`}>
      {midi.badge}
    </div>
  {/if}
</div>

{#if moduleId && paramId}
  <ControlContextMenu
    open={ctxOpen}
    x={ctxX}
    y={ctxY}
    title={`${moduleId} · ${label}`}
    hasBinding={!!midi.binding}
    bindingLabel={midi.bindingLabel}
    onlearn={midi.learn}
    onforget={midi.forget}
    onclose={() => (ctxOpen = false)}
    surfaces={midi.surfaces}
    onsendtosurface={midi.sendToSurface}
    onremovefromsurface={midi.removeFromSurface}
    electras={midi.electras}
    onassignelectra={midi.assignElectra}
    onclearelectra={midi.clearElectra}
    automationRecorded={midi.automationRecorded}
    onclearautomation={midi.clearAutomation}
  />
{/if}

<style>
  /* ── RACKLINE conic dial (_kit.css §5.1). --v drives the value arc; --ka
     the accent (domain, else app accent). Structural steel/track colours are
     literal per the kit (they are NOT themed). ── */
  .knob-wrap {
    position: relative;
    display: inline-flex;
    flex-direction: column;
    align-items: center;
    gap: 5px;
    user-select: none;
    touch-action: none;
  }
  .knob {
    --kb: 40px; /* md */
    --_ka: var(--ka, var(--domain, var(--accent)));
    position: relative;
    width: var(--kb);
    height: var(--kb);
    border-radius: 50%;
    padding: 3px;
    cursor: ns-resize;
    outline: none;
    background: conic-gradient(
      from 225deg,
      var(--_ka) calc(var(--v, 0.5) * 270deg),
      #2a313d 0 270deg,
      transparent 0
    );
    filter: drop-shadow(0 2px 3px rgba(0, 0, 0, 0.5));
  }
  .knob.sm { --kb: 26px; }
  .knob.lg { --kb: var(--kn-lg, 46px); }
  .knob.xl { --kb: 64px; }
  .knob:focus-visible {
    box-shadow: 0 0 0 2px var(--_ka);
  }
  .knob-wrap.dragging .knob {
    filter: drop-shadow(0 2px 3px rgba(0, 0, 0, 0.5)) brightness(1.08);
  }
  .cap {
    position: absolute;
    inset: 15%;
    border-radius: 50%;
    background: radial-gradient(circle at 38% 30%, #333b47, #12161d 74%);
    border: 1px solid #0a0d12;
    box-shadow: inset 0 1px 1px rgba(255, 255, 255, 0.08);
    pointer-events: none;
  }
  .ptr {
    position: absolute;
    left: 50%;
    top: 50%;
    width: 2px;
    height: calc(var(--kb) / 2 - 3px);
    background: var(--_ka);
    border-radius: 2px;
    transform-origin: 50% 100%;
    /* transform set inline (rotation) — origin/translate here */
    box-shadow: 0 0 5px var(--_ka);
    pointer-events: none;
  }
  /* DETENT TICK (PF-1 options / PF-10 landmarks): a short spoke on the SAME
     270° arc + origin as `.ptr`, drawn OUTSIDE the cap so it reads as a panel
     marking rather than a second pointer. `.at` lights the landmark the
     readout is currently naming. */
  .tick {
    position: absolute;
    left: 50%;
    top: 50%;
    width: 1px;
    height: calc(var(--kb) / 2 + 3px);
    background: var(--border, #2c3037);
    border-radius: 1px;
    transform-origin: 50% 100%;
    /* transform set inline (rotation) — origin/translate here */
    pointer-events: none;
  }
  .tick.at {
    background: var(--_ka);
    opacity: 0.75;
  }
  .label {
    font-family: var(--mono, ui-monospace, monospace);
    font-size: 9px;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    color: var(--text-dim);
    pointer-events: none;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-align: center;
  }
  /* PERSISTENT READOUT — the option/landmark NAME (or a bespoke format), shown
     under the label. Only rendered for a param that declared a vocabulary. */
  .readout {
    font-family: var(--mono, ui-monospace, monospace);
    font-size: 9px;
    line-height: 1;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    font-weight: 700;
    color: var(--_ka);
    pointer-events: none;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-align: center;
  }
  .knob-wrap.midi-learning {
    outline: 2px solid #f5c248;
    outline-offset: 2px;
    border-radius: 4px;
    animation: knob-conic-midi-learn-pulse 1.1s ease-in-out infinite;
  }
  @keyframes knob-conic-midi-learn-pulse {
    0%, 100% { outline-color: rgba(245, 194, 72, 1); }
    50%      { outline-color: rgba(245, 194, 72, 0.3); }
  }
  .midi-badge {
    position: absolute;
    bottom: -2px;
    right: -2px;
    font-family: ui-monospace, monospace;
    font-size: 0.55rem;
    line-height: 1;
    padding: 2px 4px;
    background: rgba(96, 165, 250, 0.18);
    color: #a8d3ff;
    border-radius: 2px;
    pointer-events: none;
    letter-spacing: 0.02em;
  }
  .value {
    position: absolute;
    background: var(--module-bg-deep, #14171c);
    border: 1px solid var(--border-strong, #404652);
    color: var(--text);
    padding: 2px 6px;
    font-size: 0.7rem;
    font-family: ui-monospace, monospace;
    border-radius: 3px;
    white-space: nowrap;
    transform: translateY(-22px);
    pointer-events: none;
    z-index: 10;
  }
</style>
