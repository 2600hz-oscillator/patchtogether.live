<script lang="ts">
  // NeonFader — the fader drawn in the CONIC KNOB's visual language.
  //
  // Owner review of #1738: *"we need to re-do that level setting fader entirely
  // with a new UI control for faders that matches our blue neon controls."*
  //
  // ── WHY A NEW COMPONENT AND NOT AN EDIT TO `Fader.svelte` ─────────────────
  //
  // `Fader.svelte` is imported by 93 card components; `e2e/vrt/__screenshots__/
  // vrt.spec.ts/` holds 115 per-card baselines, and eight FACED modules
  // (attenumix, marbles, moog907a, moog914, noise, rings, sidecar,
  // warrensspectrum) each carry a compact AND a dock face baseline on top. A
  // pixel change in that file moves all of them for one module's review note.
  // That is the same argument `console.css` makes for its custom-property
  // route — and the reason THAT route is not enough here is that the review is
  // about the widget's FORM, not its colour: an accent applied to a 22 px
  // grey slot is still a 22 px grey slot.
  //
  // ── WHAT "MATCHES THE NEON KNOBS" MEANS, CONCRETELY ───────────────────────
  //
  // Every visual decision below is lifted from `KnobConic.svelte` rather than
  // invented, so the two controls match BY CONSTRUCTION under any skin:
  //
  //   * the accent token chain, verbatim — `--_ka: var(--ka, var(--domain,
  //     var(--accent)))` (KnobConic:347). `--domain` is set on the shell root
  //     from the module's own spine colour, so re-skinning moves both controls
  //     together and no hex is chosen here.
  //   * the VALUE ARC. The knob's identity is a conic sweep of `--_ka` over an
  //     unlit track; a fader's equivalent is the travelled part of the slot lit
  //     in the same colour over the same unlit remainder.
  //   * the 5 px GLOW — `box-shadow: 0 0 5px var(--_ka)` (KnobConic:391), on
  //     the thumb, which is this control's pointer.
  //   * the LABEL: 9 px mono, `0.07em`, `--text-dim` (KnobConic's `.label`).
  //     ⚠ The RESTING READOUT this control used to copy from KnobConic no
  //     longer exists on either of them (owner, 2026-08-17) — a level's readout
  //     can only ever be a number, so there is nothing left of it here at all.
  //   * the detent TICK vocabulary for a bipolar centre.
  //
  // ── AND IT CLOSES THREE GAPS `Fader.svelte` HAS ───────────────────────────
  //
  // These are additions, never removals — every behaviour the old fader has is
  // reproduced below and asserted by `neon-fader-parity.test.ts`:
  //
  //   1. KEYBOARD. `Fader.svelte` has `role="slider"` and `tabindex="0"` and NO
  //      key handler at all — a slider that announces itself to assistive tech
  //      and then ignores every key. Arrows/PageUp/PageDown/Home/End work here.
  //      (This is not a keyboard-NAVIGATION affordance, which the owner has
  //      ruled out; it is the control's own value gesture, the same one the
  //      role already promises.)
  //   2. `aria-valuetext` — the knob emits it, the fader did not, so a screen
  //      reader read "0.8" where the screen said "-1.9 dB".
  //   3. A PERSISTENT READOUT at the dock tier, so a faceplate's faders print
  //      their value like its knobs do instead of only on hover.
  //
  // ⚠ THE `.fader-wrap` CLASS AND `role="slider"` ARE LOad-BEARING, NOT
  // COSMETIC. `DockCardHost.onFrameWheel` leaves ctrl/meta-wheel to any target
  // matching `.knob-wrap, .fader-wrap, [role="slider"]`; drop either and
  // fine-adjust over this control silently becomes a dock zoom.

  import type { KnobCurve } from '$lib/graph/types';
  import { onDestroy, onMount, untrack } from 'svelte';
  import { createDragCommit } from './drag-commit';
  import ControlContextMenu from './ControlContextMenu.svelte';
  import { makeMidiAssignable } from './midi-assignable.svelte';
  import { notifyAutomationTouch, notifyAutomationRelease } from '$lib/audio/automation-touch';
  import { formatParamNumber, isBipolarRange } from './param-format';

  // Touch-suspend cross-wire (#183), verbatim from Fader.svelte: a live grab
  // suspends this param's clip-automation until the PHYSICAL release, with
  // per-surface holders so a wheel-idle timer cannot clear a pointer drag.
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

  interface Props {
    value: number;
    min: number;
    max: number;
    defaultValue: number;
    label: string;
    units?: string;
    curve?: KnobCurve;
    onchange: (value: number) => void;
    /** Motorized read — polled per rAF while idle, so CV visibly moves it. */
    readLive?: () => number | undefined;
    /** Override for the readout text (a discrete index → a word). */
    formatValue?: (v: number) => string;
    moduleId?: string;
    paramId?: string;
    /** Track length in px. ONE number drives the track box AND the thumb
     *  travel, exactly as on `Fader.svelte`. */
    trackHeight?: number;
    /**
     * DROP THE PER-CONTROL CAPTION — the `.label` line under the throw.
     *
     * ⚠ TEXT ONLY. `aria-label`, the annotate menu's title and the MIDI-learn
     * address all still carry `label`. Declared per cell (`face.bareCells`)
     * because a caption is clutter only where a section heading already says
     * it — see KnobConic's copy of this prop for the owner's rule.
     */
    hideCaption?: boolean;
    /** Explicit accent override for one cell — the `--ka` seam KnobConic uses.
     *  Omitted, the domain chain applies. */
    accent?: string;
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
    trackHeight = 80,
    hideCaption = false,
    accent,
  }: Props = $props();

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
  onDestroy(() => midi.unregister());

  let liveValue = $state(untrack(() => value));
  let dragging = $state(false);
  let hovering = $state(false);

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
  });

  function valueToFrac(v: number): number {
    const clamped = Math.max(min, Math.min(max, v));
    if (curve === 'log') {
      if (min <= 0 || max <= 0) return (clamped - min) / (max - min);
      return Math.log(clamped / min) / Math.log(max / min);
    }
    if (curve === 'exp') {
      const f = (clamped - min) / (max - min);
      return f * f;
    }
    return (clamped - min) / (max - min);
  }
  function fracToValue(f: number): number {
    const fr = Math.max(0, Math.min(1, f));
    if (curve === 'log') {
      if (min <= 0 || max <= 0) return min + fr * (max - min);
      return min * Math.pow(max / min, fr);
    }
    if (curve === 'exp') return min + Math.sqrt(fr) * (max - min);
    if (curve === 'discrete') return Math.round(min + fr * (max - min));
    return min + fr * (max - min);
  }

  let displayFrac = $derived(valueToFrac(liveValue));

  let startY = 0;
  let startFrac = 0;
  let mod: 'none' | 'shift' | 'fine' = 'none';

  function fracFromClientY(trackEl: HTMLElement, clientY: number): number {
    const rect = trackEl.getBoundingClientRect();
    return Math.max(0, Math.min(1, 1 - (clientY - rect.top) / rect.height));
  }

  function pointerdown(e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    touchAutomation();
    const trackEl = e.currentTarget as HTMLElement;
    mod = e.shiftKey ? 'shift' : (e.ctrlKey || e.metaKey) ? 'fine' : 'none';

    // Click-to-jump unless the grab is close to the thumb — the same 8% radius
    // the shipped fader uses, so the gesture feels identical.
    const clickFrac = fracFromClientY(trackEl, e.clientY);
    const jumped = Math.abs(clickFrac - displayFrac) > 0.08;
    const initialFrac = jumped ? clickFrac : displayFrac;

    dragging = true;
    startY = e.clientY;
    startFrac = initialFrac;

    if (jumped) {
      const newValue = fracToValue(clickFrac);
      liveValue = newValue;
      if (newValue !== value) onchange(newValue);
    }
    trackEl.setPointerCapture(e.pointerId);
  }

  function pointermove(e: PointerEvent) {
    if (!dragging) return;
    e.preventDefault();
    const dy = startY - e.clientY;
    // 100 px = full range, shift ×0.1, ctrl/meta ×0.01 — Fader.svelte's ladder.
    const sensitivity = mod === 'fine' ? 1 / 10000 : mod === 'shift' ? 1 / 1000 : 1 / 100;
    const newValue = fracToValue(Math.max(0, Math.min(1, startFrac + dy * sensitivity)));
    liveValue = newValue;
    if (newValue !== value) dragCommit.commit(newValue);
  }
  function endDrag(e: PointerEvent, release: boolean) {
    dragging = false;
    releaseAutomation();
    dragCommit.flush();
    if (release) {
      try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); }
      catch { /* capture may already be gone */ }
    }
  }
  function pointerup(e: PointerEvent) { endDrag(e, true); }
  function pointercancel(e: PointerEvent) { endDrag(e, true); }
  /** ⚠ `Fader.svelte` has NO lost-capture handler and `KnobConic` does. Without
   *  it a capture stolen by the OS leaves `dragging` true forever, which gates
   *  the motorized loop off and FREEZES the control. Added here deliberately. */
  function lostpointercapture(e: PointerEvent) { if (dragging) endDrag(e, false); }

  function dblclick(e: MouseEvent) {
    e.stopPropagation();
    onchange(defaultValue);
  }
  function wheel(e: WheelEvent) {
    e.preventDefault();
    e.stopPropagation();
    wheelTouch();
    const step = e.shiftKey ? 0.001 : (e.ctrlKey || e.metaKey) ? 0.0001 : 0.01;
    const newValue = fracToValue(displayFrac + (e.deltaY < 0 ? 1 : -1) * step);
    if (newValue !== value) onchange(newValue);
  }

  /** KEYBOARD — the gesture `role="slider"` already promised and the shipped
   *  fader never delivered. Shift = fine, matching the pointer ladder. */
  function keydown(e: KeyboardEvent) {
    const fine = e.shiftKey ? 0.001 : 0.01;
    let frac: number | null = null;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') frac = displayFrac + fine;
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') frac = displayFrac - fine;
    else if (e.key === 'PageUp') frac = displayFrac + 0.1;
    else if (e.key === 'PageDown') frac = displayFrac - 0.1;
    else if (e.key === 'Home') frac = 0;
    else if (e.key === 'End') frac = 1;
    if (frac === null) return;
    e.preventDefault();
    e.stopPropagation();
    const newValue = fracToValue(frac);
    liveValue = newValue;
    if (newValue !== value) onchange(newValue);
  }

  const format = formatParamNumber;
  let TRACK_HEIGHT = $derived(trackHeight);
  const THUMB_HEIGHT = 12;
  let thumbY = $derived((1 - displayFrac) * (TRACK_HEIGHT - THUMB_HEIGHT));
  let isBipolar = $derived(isBipolarRange(min, max));

  function valueText(v: number): string {
    return formatValue ? formatValue(v) : format(v, units);
  }
  let readoutText = $derived(valueText(liveValue));
</script>

<!-- ⚠ `.fader-wrap` is kept VERBATIM: it is the class `DockCardHost` greps to
     leave ctrl/meta-wheel alone. `.neon` is the new look's own hook. -->
<div
  class="fader-wrap neon"
  class:dragging
  class:midi-learning={midi.learning}
  class:midi-bound={!!midi.binding}
  data-control-style="neon"
  style:--ka={accent ?? undefined}
  style:--v={displayFrac}
  role="presentation"
  onpointerenter={() => (hovering = true)}
  onpointerleave={() => (hovering = false)}
>
  <div class="fader-row-inner">
    {#if dragging || hovering}
      <div class="value-tag">{readoutText}</div>
    {/if}
    <div
      class="track"
      style:height="{TRACK_HEIGHT}px"
      role="slider"
      tabindex="0"
      data-testid={paramId ? `control-${paramId}` : undefined}
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={liveValue}
      aria-valuetext={readoutText}
      onpointerdown={pointerdown}
      onpointermove={pointermove}
      onpointerup={pointerup}
      onpointercancel={pointercancel}
      onlostpointercapture={lostpointercapture}
      oncontextmenu={openContextMenu}
      ondblclick={dblclick}
      onwheel={wheel}
      onkeydown={keydown}
    >
      <!-- THE LIT TRAVEL — this control's value arc. Height is the fraction, so
           the lit column IS the value, the way the conic sweep is on the knob. -->
      <div class="lit" aria-hidden="true"></div>
      {#if isBipolar}
        <div class="zero-hash" aria-hidden="true" data-testid="fader-zero-hash"></div>
      {/if}
      <div class="thumb" style:transform="translateY({thumbY}px)" aria-hidden="true"></div>
    </div>
  </div>
  <!-- THE CAPTION. Suppressed per cell by `face.bareCells`; `aria-label` on the
       track above is untouched, so nothing addressable is lost.

       ⚠ THERE IS NO READOUT LINE HERE ANY MORE, AND THERE IS NOTHING TO PUT
       BACK. A fader's readout is a number by construction — there is no
       option/landmark NAME a level could print — so the whole element went
       (owner, 2026-08-17: *"all of our white decimely representatons of fader
       state ... should be removed"*, and *"i want the data gone, not there but
       hidden or something"*). `readoutText` still feeds `aria-valuetext` and
       the drag/hover `.value-tag`, so the value is speakable, assertable, and
       visible WHILE YOU SET IT — it just does not sit on the panel at rest. -->
  {#if !hideCaption}<div class="label" title={label}>{label}</div>{/if}
  {#if midi.binding}
    <div class="midi-badge" title={`Bound to MIDI ${midi.bindingLabel}`}>{midi.badge}</div>
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
  /* The accent chain, VERBATIM from KnobConic:347 — no colour is chosen here. */
  .fader-wrap {
    --_ka: var(--ka, var(--domain, var(--accent)));
    position: relative;
    display: inline-flex;
    flex-direction: column;
    align-items: center;
    gap: 5px; /* KnobConic's, not the old fader's 4px — they sit in one grid */
    user-select: none;
    touch-action: none;
  }
  .fader-row-inner {
    position: relative;
    display: flex;
    align-items: flex-start;
  }

  /* THE SLOT. Darker than the old track so the lit column has something to sit
     against — the same argument console.css made for `--fader-track-bg-color`. */
  .track {
    position: relative;
    width: 12px;
    border-radius: 6px;
    background: var(--module-bg-deep, #0a0c0f);
    border: 1px solid color-mix(in srgb, var(--_ka) 34%, transparent);
    box-sizing: border-box;
    cursor: ns-resize;
    outline: none;
    overflow: hidden;
  }
  .track:focus-visible {
    box-shadow: 0 0 0 2px var(--_ka);
  }

  /* The VALUE ARC's analogue: the travelled part, lit in the accent. */
  .lit {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: calc(var(--v, 0) * 100%);
    background: linear-gradient(
      180deg,
      var(--_ka) 0%,
      color-mix(in srgb, var(--_ka) 55%, transparent) 100%
    );
    opacity: 0.55;
    pointer-events: none;
  }

  /* The centre detent for a bipolar range — the knob's `.tick.at` vocabulary. */
  .zero-hash {
    position: absolute;
    left: 0;
    right: 0;
    top: 50%;
    height: 1px;
    background: var(--_ka);
    opacity: 0.75;
    pointer-events: none;
  }

  /* THE THUMB IS THIS CONTROL'S POINTER: solid accent plus the SAME 5px glow
     the conic knob's `.ptr` carries (KnobConic:391). */
  .thumb {
    position: absolute;
    left: -2px;
    right: -2px;
    top: 0;
    height: 12px;
    border-radius: 3px;
    background: var(--_ka);
    box-shadow: 0 0 5px var(--_ka);
    pointer-events: none;
  }
  .thumb::after {
    content: '';
    position: absolute;
    left: 2px;
    right: 2px;
    top: 50%;
    height: 1px;
    background: var(--text-on-accent, #0e1013);
    opacity: 0.7;
  }
  .fader-wrap.dragging .track {
    border-color: var(--_ka);
    box-shadow: 0 0 6px color-mix(in srgb, var(--_ka) 45%, transparent);
  }

  /* LABEL — KnobConic's `.label` metrics, verbatim. The `.readout` rule that
     sat beside it is gone with the element (see the markup note). */
  .label {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-align: center;
    font-family: var(--mono, ui-monospace, monospace);
    font-size: 9px;
    line-height: 1;
    text-transform: uppercase;
    font-weight: 700;
    letter-spacing: 0.07em;
    color: var(--text-dim, #8a9099);
  }

  /* The hover tag — KnobConic:468-481's tokens, positioned for a vertical
     throw (beside the slot) rather than above a dial. */
  .value-tag {
    position: absolute;
    left: 100%;
    top: 0;
    margin-left: 6px;
    z-index: 10;
    padding: 1px 4px;
    border-radius: 3px;
    background: var(--module-bg-deep, #14171c);
    border: 1px solid var(--border-strong, #404652);
    color: var(--text, #eef1f5);
    font-family: var(--mono, ui-monospace, monospace);
    font-size: 0.7rem;
    white-space: nowrap;
    pointer-events: none;
  }

  /* MIDI learn/bound — byte-identical vocabulary to Fader/KnobConic. */
  .fader-wrap.midi-learning {
    outline: 2px solid #f5c248;
    outline-offset: 2px;
    border-radius: 4px;
    animation: neon-fader-midi-learn-pulse 1s ease-in-out infinite;
  }
  @keyframes neon-fader-midi-learn-pulse {
    0%, 100% { outline-color: #f5c248; }
    50% { outline-color: #7a6220; }
  }
  .midi-badge {
    position: absolute;
    bottom: -2px;
    right: -2px;
    font-family: var(--mono, ui-monospace, monospace);
    font-size: 0.55rem;
    line-height: 1;
    padding: 1px 3px;
    border-radius: 3px;
    background: rgba(96, 165, 250, 0.18);
    color: #a8d3ff;
    pointer-events: none;
  }
</style>
