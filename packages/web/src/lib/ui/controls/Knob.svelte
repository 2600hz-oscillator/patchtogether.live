<script lang="ts">
  // D15 Knob: vertical drag, Shift = ×0.1 fine, Cmd/Ctrl = ×0.01 fine,
  // double-click = reset to default, value tooltip on drag and on hover.
  // Curve maps display angle ↔ internal value while DSP stays linear (D15).
  //
  // Motorized: when readLive is provided and we're not dragging, the tick
  // angle reflects the LIVE current value (intrinsic + connected CV) so
  // patching an LFO into a knob's CV input visibly rotates the tick.
  import type { KnobCurve } from '$lib/graph/types';
  import { onDestroy, onMount, untrack } from 'svelte';
  import { createDragCommit } from './drag-commit';
  import ControlContextMenu from './ControlContextMenu.svelte';
  import { makeMidiAssignable } from './midi-assignable.svelte';
  import { notifyAutomationTouch, notifyAutomationRelease } from '$lib/audio/automation-touch';
  import { formatParamNumber } from './param-format';

  // Touch-suspend cross-wire (task #183): a live grab of this control suspends
  // its clip-automation playback until the PHYSICAL RELEASE ("live wins"), not
  // the loop wrap. Fires on the screen-gesture choke points below; the MIDI path
  // notifies from makeMidiAssignable so screen + MIDI share the SAME seam.
  // PER-SURFACE holders ('pointer' vs 'wheel' here, 'midi'/'electra' elsewhere):
  // the override ends only when the LAST holder releases, so a wheel-idle timer
  // can't clear a concurrent pointer drag (or a MIDI twist) mid-gesture.
  function touchAutomation() {
    if (moduleId && paramId) notifyAutomationTouch({ nodeId: moduleId, paramId }, 'pointer');
  }
  // Release = pointer-up (drag) / a short idle after a wheel tick. Ends the
  // override so playback resumes (gliding back to the envelope).
  function releaseAutomation() {
    if (moduleId && paramId) notifyAutomationRelease({ nodeId: moduleId, paramId }, 'pointer');
  }
  let wheelReleaseTimer: ReturnType<typeof setTimeout> | null = null;
  function wheelTouch() {
    if (moduleId && paramId) notifyAutomationTouch({ nodeId: moduleId, paramId }, 'wheel');
    if (wheelReleaseTimer !== null) clearTimeout(wheelReleaseTimer);
    // ~200 ms of no wheel motion = the "release" (a wheel has no pointer-up).
    wheelReleaseTimer = setTimeout(() => {
      wheelReleaseTimer = null;
      if (moduleId && paramId) notifyAutomationRelease({ nodeId: moduleId, paramId }, 'wheel');
    }, 200);
  }

  interface Props {
    value: number;
    min: number;
    max: number;
    defaultValue: number;
    label: string;
    units?: string;
    curve?: KnobCurve;
    onchange: (value: number) => void;
    /**
     * Optional live-value reader. If provided, the knob polls this each rAF
     * (when not being dragged) and renders that as the tick angle.
     */
    readLive?: () => number | undefined;
    /**
     * Optional override for the value-tag text — the `ParamDef.format` seam
     * (PF-3), matching `Fader.svelte`'s prop of the same name.
     *
     * It exists because a def-declared `format` that a card never forwards is
     * a DISAGREEMENT, not a downgrade: the curated face reads the param and
     * prints (say) `SR/2.0` while this dial, reading the same param, prints
     * `0.50`. `card-range-source.test.ts` requires `formatValue={p.format}` on
     * every control whose param declares one — a requirement no Knob-based
     * card could satisfy until this prop existed.
     */
    formatValue?: (v: number) => string;
    /** MIDI Learn — when both moduleId + paramId are set the knob becomes
     *  right-clickable to bind a MIDI CC. Cards that don't pass these
     *  silently skip the feature. */
    moduleId?: string;
    paramId?: string;
    /**
     * OVERRIDE for the emitted `data-testid`, for a knob that is MIDI-assignable
     * but is NOT a def param cell.
     *
     * ⚠ IT EXISTS BECAUSE THE DEFAULT `control-<paramId>` IS A CLAIM, NOT A
     * NAME. `faces-parity.spec.ts` asserts EXACT MULTISET EQUALITY between the
     * dock's `[data-testid^="control-"]` elements and the live def's ParamDef
     * ids, so any knob emitting that prefix is asserting "I am one of this
     * module's declared params". A PF-14 panel edits `node.data`, not params
     * (shell-cells.ts rule 1), and a panel knob keyed by a pseudo-param
     * (`cv1:scale`) would read to that gate as an EXTRA control with no def
     * backing and fail the whole face.
     *
     * ⚠ AND DROPPING `paramId` IS NOT THE FIX — that is the trap this prop
     * exists to avoid. `paramId` is also the MIDI-learn binding key
     * (makeMidiAssignable), so a panel that suppressed the testid by omitting
     * it would silently delete MIDI Learn from every control in the panel.
     * Separating the two lets a panel keep the binding and give up only the
     * claim it has no right to make.
     */
    testid?: string;
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
    formatValue,
    moduleId,
    paramId,
    testid,
  }: Props = $props();

  // ---------------- MIDI Learn integration (shared factory) ----------------
  // The single CC-vs-NOTE branch lives in makeMidiAssignable; the knob is a
  // kind:'cc' consumer. `args` uses getters so the factory always reads the
  // CURRENT reactive prop (min/max/onchange can change across re-renders).
  const midi = makeMidiAssignable({
    kind: 'cc',
    get moduleId() { return moduleId; },
    get paramId() { return paramId; },
    get min() { return min; },
    get max() { return max; },
    get onchange() { return onchange; },
    // Streaming CC: track the tick at full message rate LOCALLY while the
    // store commit is coalesced (mirrors the drag path's synchronous
    // liveValue update). The $effects below gate on midi.ccActive so the
    // tick never snaps back to a not-yet-committed store value mid-stream.
    onTransient: (v) => { if (!dragging) liveValue = v; },
  });

  let ctxOpen = $state(false);
  let ctxX = $state(0);
  let ctxY = $state(0);

  function openContextMenu(e: MouseEvent) {
    if (!moduleId || !paramId) return;
    midi.refresh();
    // Plain right-click on a wired knob opens the control menu (MIDI Learn /
    // Forget). We stopPropagation so the event does NOT bubble to the node
    // menu — right-clicking the card *background* still gets the node menu
    // (Docs / Duplicate / Unpatch / Delete) because only the knob surface
    // is covered by this handler.
    e.preventDefault();
    e.stopPropagation();
    ctxX = e.clientX;
    ctxY = e.clientY;
    ctxOpen = true;
  }
  onMount(() => midi.register());

  let dragging = $state(false);
  let hovering = $state(false);
  // Display value for the tick. Driven by drag while user is interacting,
  // by readLive when motorized + idle, by the prop value otherwise.
  let liveValue = $state(untrack(() => value));
  let raf: number | null = null;
  let currentValue = $derived(value);

  $effect(() => {
    // midi.ccActive mirrors the `dragging` guard: while a CC stream drives
    // this knob, liveValue comes from the per-message onTransient hook — the
    // store lags by design (coalesced commits) and must not yank the tick.
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

  // rAF-coalesced commit pump — see Fader.svelte for the full rationale.
  // Knob lives on the same pointermove → onchange → SyncedStore mutation
  // path that produces the hand-modulation tempo-drift symptom; without
  // coalescing, a 240 Hz drag floods the snapshot bus + reconciler.
  const dragCommit = createDragCommit((v) => onchange(v));

  onDestroy(() => {
    if (raf !== null) cancelAnimationFrame(raf);
    if (wheelReleaseTimer !== null) clearTimeout(wheelReleaseTimer);
    dragCommit.dispose();
    midi.unregister();
  });

  // Map internal value ↔ normalized [0,1] using the declared curve.
  function valueToFrac(v: number): number {
    const clamped = Math.max(min, Math.min(max, v));
    if (curve === 'log') {
      // Guard against zero/negative endpoints; fall back to linear in that case.
      if (min <= 0 || max <= 0) return (clamped - min) / (max - min);
      return Math.log(clamped / min) / Math.log(max / min);
    }
    if (curve === 'exp') {
      const frac = (clamped - min) / (max - min);
      return frac * frac;
    }
    return (clamped - min) / (max - min);
  }

  function fracToValue(f: number): number {
    const fr = Math.max(0, Math.min(1, f));
    if (curve === 'log') {
      if (min <= 0 || max <= 0) return min + fr * (max - min);
      return min * Math.pow(max / min, fr);
    }
    if (curve === 'exp') {
      return min + Math.sqrt(fr) * (max - min);
    }
    return min + fr * (max - min);
  }

  let angle = $derived(-135 + valueToFrac(liveValue) * 270);

  let startY = 0;
  let startFrac = 0;
  let mod: 'none' | 'shift' | 'fine' = 'none';

  function pointerdown(e: PointerEvent) {
    if (e.button !== 0) return;
    touchAutomation(); // grab → suspend this param's automation (live wins)
    dragging = true;
    startY = e.clientY;
    startFrac = valueToFrac(value);
    mod = e.shiftKey ? 'shift' : (e.ctrlKey || e.metaKey) ? 'fine' : 'none';
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  function pointermove(e: PointerEvent) {
    if (!dragging) return;
    const dy = startY - e.clientY; // up = positive
    // Sensitivity scales: 1 unit / 200 px linearly; Shift = 10×, Cmd = 100× finer.
    const sensitivity = mod === 'fine' ? 1 / 20000 : mod === 'shift' ? 1 / 2000 : 1 / 200;
    const newFrac = startFrac + dy * sensitivity;
    const newValue = fracToValue(newFrac);
    liveValue = newValue;
    if (newValue !== value) dragCommit.commit(newValue);
  }

  function pointerup(e: PointerEvent) {
    dragging = false;
    releaseAutomation(); // hand lifted → end the override (glide back to envelope)
    // Force-commit the final drag position so the patch store can't lag
    // the last visible tick angle by one frame on release.
    dragCommit.flush();
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
  }

  // Safety net: if the browser revokes pointer capture without a pointerup
  // (OS gesture, touch interruption), still end the drag + the automation
  // override so a grabbed param can't stay suspended forever.
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
    wheelTouch(); // wheel adjust is a live grab too (auto-releases after idle)
    // Wheel ticks: small step in normalized space.
    const step = e.shiftKey ? 0.001 : e.ctrlKey || e.metaKey ? 0.0001 : 0.005;
    const direction = e.deltaY < 0 ? 1 : -1;
    const newFrac = valueToFrac(value) + direction * step;
    const newValue = fracToValue(newFrac);
    if (newValue !== value) onchange(newValue);
  }

  // The readout ladder lives in ONE place (param-format.ts) — this dial, the
  // conic dial, the fader and the Push 2 card all print the same string.
  const format = formatParamNumber;

  /** Display string for the live value, applying the optional override (the
   *  same precedence Fader.svelte uses: a declared `format` outranks the
   *  shared ladder). */
  function valueText(v: number): string {
    return formatValue ? formatValue(v) : format(v, units);
  }
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
    <div class="value">{valueText(liveValue)}</div>
  {/if}
  <div
    class="knob"
    role="slider"
    tabindex="0"
    data-testid={testid ?? (paramId ? `control-${paramId}` : undefined)}
    aria-label={label}
    aria-valuemin={min}
    aria-valuemax={max}
    aria-valuenow={liveValue}
    oncontextmenu={openContextMenu}
    onpointerdown={pointerdown}
    onpointermove={pointermove}
    onpointerup={pointerup}
    onlostpointercapture={lostcapture}
    ondblclick={dblclick}
    onwheel={wheel}
  >
    <div class="tick" style:transform="rotate({angle}deg)"></div>
  </div>
  <!-- (Automation assignment is MODULE-level now — the assigned MODULE's card
       gets the lane-colour border via the shared node wrapper; the old
       per-control name border is gone.) -->
  <div class="label">{label}</div>
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
  .knob-wrap {
    position: relative;
    display: inline-flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    user-select: none;
    touch-action: none;
  }
  .knob {
    width: 36px;
    height: 36px;
    border-radius: 50%;
    background: #2a2f3a;
    border: 1px solid #404652;
    position: relative;
    cursor: ns-resize;
    outline: none;
  }
  .knob:focus-visible {
    box-shadow: 0 0 0 2px var(--accent);
  }
  .knob-wrap.dragging .knob {
    background: #353a47;
    box-shadow: 0 0 0 2px var(--accent), 0 0 6px var(--accent-glow);
  }
  .tick {
    position: absolute;
    top: 50%;
    left: 50%;
    width: 2px;
    height: 14px;
    margin-left: -1px;
    margin-top: -16px;
    background: var(--text);
    transform-origin: 50% 100%;
    border-radius: 1px;
    pointer-events: none;
  }
  .label {
    font-size: 0.65rem;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    pointer-events: none;
    /* Keep long param labels (e.g. "CUTOFF", "RES 2") from spilling past the
       knob and colliding with a sibling knob's label in a cramped host (the
       Control Surface group box). Clamp to the wrap width + ellipsize. */
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-align: center;
  }
  /* MIDI Learn visual states (mirror Fader.svelte). */
  .knob-wrap.midi-learning {
    outline: 2px solid #f5c248;
    outline-offset: 2px;
    border-radius: 4px;
    animation: knob-midi-learn-pulse 1.1s ease-in-out infinite;
  }
  @keyframes knob-midi-learn-pulse {
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
    background: #14171c;
    border: 1px solid #404652;
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
