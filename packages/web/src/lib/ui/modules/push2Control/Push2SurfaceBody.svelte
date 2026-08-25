<script lang="ts">
  // Push2SurfaceBody — the PUSH 2 SURFACE, at the head of the dock full view.
  //
  // ── THE PICTURE IS THE POINT, AND IT IS A REPLICA RATHER THAN A VIEW ───────
  //
  // The 960×160 element below is not a visualisation of the hardware screen: it
  // is painted by `paintPushOps(ctx, pushDisplayOps())` — the SAME op list
  // already on its way to the physical OLED over WebUSB. There is no second
  // renderer, so the plate and the panel cannot disagree about what is on
  // screen, and holding the hardware LEGEND button changes this picture too.
  // That is also the only reason the feature is reviewable with no Push on the
  // desk, which is how it was built. The card's own header says all of this and
  // the body inherits it verbatim.
  //
  // ── WHAT IT CARRIES, AND WHY EACH PART IS ALLOWED TO ──────────────────────
  //
  // The resting-text rulings permit the module NAME, section LABELS, control
  // CAPTIONS and option/landmark NAMES. Everything here is one of those, an
  // ERROR, an EMPTY STATE, a LAMP, or the picture:
  //
  //   * THE REPLICA — eight strips of name + bar + formatted readout, or the
  //     LEGEND grid. Those readouts are the MODULE'S ARTWORK, not the face's
  //     chrome (the wave-5 games ruling), and here more strongly than anywhere
  //     else in the fleet: deleting them would not remove a readout from the
  //     product, because the hardware still paints it — it would only make the
  //     on-screen copy DISAGREE with the panel, which is the one property the
  //     shared-seam design exists to make impossible. A "compact" replica with
  //     half the strips would be "there but hidden" applied to a picture of a
  //     real object, and additionally wrong.
  //     ⚠ IT IS A 2-D CONTEXT AND MUST STAY ONE. WebGL-attest basis membership
  //     is derived mechanically by walking this directory tree for a context
  //     request naming the GL flavours, so a shader here would enrol a meta
  //     module in the GPU attest for a picture that is eight rectangles and
  //     some text.
  //   * THE LANE SELECT and THE VIEW SEGMENT — option NAMES inside the controls
  //     that select them, with `aria-pressed`, which is the one text class the
  //     ruling admits on otherwise-identical controls. Eight lanes rendered
  //     from ONE `{#each}`: one control with eight positions, not eight
  //     controls.
  //   * THE CARD FLIP — the ‹ › pair that walks the selected lane's modules,
  //     the #2-from-the-left encoder's gesture. The card printed the module's
  //     name and an `i/N` badge beside it; the NAME is deleted because the
  //     canvas three pixels above already paints it, and the POSITION lives on
  //     the flip group's `aria-label` (see `push2FlipValue`, and the note at
  //     the call site for why `aria-valuetext` would be invalid on a group).
  //   * THE BIND CONTROL — a button whose caption names the action it will
  //     perform. HERE and not a ranked cell for two mechanical reasons:
  //     `ShellActionCell.label` is a plain `string`, so a cell could not say
  //     which of the two it is about to do; and the gesture is a NO-OP on a
  //     rack with no clip-player, which is the state a fresh rack is always in,
  //     while an action cell has no `disabled`.
  //   * CONNECT DISPLAY — a separate WebUSB permission, never required, and
  //     conditional on the capability being present at all.
  //   * THE LAMPS, through `StatusLed`: a static literal caption, a boolean
  //     that IS the picture, and the derived sentence in `aria-label`/`title`.
  //     They carry the card's nine-branch status region — see
  //     `push2-binder-status-model.ts` for what each one absorbed.
  //   * THE ERROR AND EMPTY-STATE LINES — absent whenever nothing is wrong, and
  //     replaced by the surface the moment the surface exists.
  //
  // ⚠ NO CONNECT PUSH 2 BUTTON HERE, DELIBERATELY — midiclock's rule. That
  // gesture is the RANKED ACTION CELL in the band below, which is what puts it
  // on the lane tile at all; a second button on the same plate would be one
  // gesture with two affordances and a second thing to keep in sync.
  //
  // ⚠ NO PAD MIRROR, AND IT MUST NOT GROW ONE. The 8×8 grid this module drives
  // is on the HARDWARE; nothing in the app has ever painted it, so nothing
  // loses a surface by its absence here. The one thing the app DOES mirror is
  // the display, and it mirrors it byte-for-byte through the shared seam rather
  // than at half fidelity.
  //
  // ⚠ THIS BODY OWNS ITS SUBSCRIPTION AND RELEASES IT.

  import { onDestroy } from 'svelte';
  import { StatusLed } from '$lib/ui/controls';
  import { nodesStructuralVersion, docVersion } from '$lib/graph/node-versions.svelte';
  import {
    midiAvailable,
    isConnected,
    boundClipNode,
    selectedChannelIndex,
    selectChannel,
    currentPushCardView,
    scrollPushCard,
    statusRune,
    setLaunchpadView,
    pushDisplayOps,
    isLegendHeld,
  } from '$lib/control/push2/push2-control.svelte';
  import {
    usbAvailable,
    connectDisplay,
    isDisplayConnected,
    displayStatus,
    displayStatusRune,
  } from '$lib/control/push2/push2-display.svelte';
  import { PUSH_SCREEN_W, PUSH_SCREEN_H } from '$lib/control/push2/push-screen-layout';
  import { paintPushOps } from '$lib/control/push2/push-card-paint';
  // ⚠ `viewRune` AND `bindingRune` ARE THE LAUNCHPAD LAYER'S, AND READING THEM
  // HERE IS NOT BELT-AND-BRACES. `launchpadActiveView()` and `boundClipNode()`
  // are owned by the parity brain, and the HARDWARE can change both without
  // passing through any push2 setter — a device button press reaches
  // `setLaunchpadView` inside launchpad-control directly. push2's own
  // `statusRune()` would never bump, and this plate would keep painting the
  // previous view. (The UI route is fixed on the other side too: push2's
  // `setLaunchpadView` wrapper bumps, which is what repairs the LEGACY CARD.)
  import { launchpadActiveView, viewRune, bindingRune } from '$lib/control/launchpad/launchpad-control.svelte';
  import type { SingleView } from '$lib/control/launchpad/launchpad-map';
  // ⚠ THE LANE ROSTER IS DERIVED, NOT DECLARED HERE. `PUSH2_LANE_INDICES` is
  // `MIXMSTRS_CHANNELS.map((_, i) => i)`, exported beside `selectChannel` —
  // the function that clamps against that same authority. Painting a literal
  // `[0,1,2,3,4,5,6,7]` in this file would be a second source of truth for a
  // population, invisible to every runtime gate because it lives in `.svelte`.
  import { PUSH2_LANE_INDICES } from '$lib/control/push2/push2-control.svelte';
  import {
    firstClipplayer,
    onPush2Gesture,
    push2GestureOutcome,
    push2ToggleBind,
    type Push2GestureOutcome,
  } from '../push2-cell-actions';
  import {
    PUSH2_VIEWS,
    push2BindLabel,
    push2BindVisible,
    push2BoundDetail,
    push2EmptyLine,
    push2ErrorLine,
    push2FlipValue,
    push2PushDetail,
    push2ScreenDetail,
    push2ScreenTone,
    push2UsbLine,
    push2ViewName,
    push2ViewSegVisible,
    type Push2BinderView,
  } from './push2-binder-status-model';

  let { nodeId }: { nodeId: string } = $props();

  // The gesture outcome lives OUTSIDE this component (see push2-cell-actions):
  // the ranked CONNECT cell is rendered by the shared shell and cannot reach
  // component state.
  let outcomeV = $state(0);
  const off = onPush2Gesture(() => { outcomeV++; });
  onDestroy(off);

  // Every read is re-derived on the push2 layer's own version runes — the same
  // signals the card used, and the reason the lane select is a BODY control
  // rather than a selector cell: none of this state is on `node.data`, so a
  // cell (re-projected only on `nodeVersion`) would never see it move.
  let usbOk = usbAvailable();
  let v = $derived<Push2BinderView>(
    (statusRune(),
    displayStatusRune(),
    viewRune(),
    bindingRune(),
    nodesStructuralVersion(),
    void outcomeV,
    {
      supported: midiAvailable(),
      connected: isConnected(),
      usbOk,
      displayOn: isDisplayConnected(),
      displayStatus: displayStatus(),
      boundNode: boundClipNode(),
      hasClip: firstClipplayer() !== null,
      view: launchpadActiveView(),
      outcome: push2GestureOutcome() as Push2GestureOutcome,
    }),
  );

  let lane = $derived((statusRune(), selectedChannelIndex()));
  // The push card, re-derived on lane/focus change, on any structural graph
  // change, and on any param write — the same signals the panel's own repaint
  // tick reacts to, so the replica cannot lag the hardware.
  let card = $derived((statusRune(), nodesStructuralVersion(), docVersion(), currentPushCardView()));
  let legendOn = $derived((statusRune(), isLegendHeld()));

  let errorLine = $derived(push2ErrorLine(v));
  let usbLine = $derived(push2UsbLine(v));
  let emptyLine = $derived(push2EmptyLine(v));

  let previewCanvas = $state<HTMLCanvasElement | null>(null);
  $effect(() => {
    const c = previewCanvas;
    void card; // tracked — repaint on any card change
    void legendOn; // tracked — repaint when the legend overlay comes/goes
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    paintPushOps(ctx, pushDisplayOps());
  });

  async function openScreen(): Promise<void> {
    await connectDisplay(); // false on decline/unsupported — never throws
  }

  function pickView(view: SingleView): void {
    setLaunchpadView(view);
  }
</script>

<div class="p2-surface" data-testid="push2-surface-body-{nodeId}">
  <!-- THE REPLICA. `.p2-screen` is the width-bearing element on this plate and
       the rows below stretch to it, so the face's widest ink is a picture that
       is entirely drawn — not reserved space. -->
  <div class="p2-screen">
    <canvas
      bind:this={previewCanvas}
      width={PUSH_SCREEN_W}
      height={PUSH_SCREEN_H}
      data-testid="push2-face-canvas-{nodeId}"
      data-card-module={card.moduleType}
      data-card-lane={card.lane}
      data-card-empty={card.empty ?? ''}
    ></canvas>
    <!-- ⚠ THE ACCESSIBLE NAME IS A SIBLING, NOT `role="img"` ON THE CANVAS —
         `<canvas>` is an interactive element and cannot take a non-interactive
         role (svelte-check a11y, `--fail-on-warnings`). This is synesthesia's
         shape: an inert overlay carrying the name, so what the replica shows is
         speakable and assertable without the picture becoming text. -->
    <div
      class="p2-screen-a11y"
      role="img"
      aria-label="Push 2 screen — {push2FlipValue(card)}"
      data-testid="push2-face-screen-name-{nodeId}"
    ></div>
  </div>

  <!-- LANE SELECT — the eight buttons above the hardware display. -->
  <div class="p2-row p2-lanes" role="group" aria-label="Push lane" data-testid="push2-face-lanes-{nodeId}">
    {#each PUSH2_LANE_INDICES as c (c)}
      <button
        class="p2-btn p2-lane-btn nodrag"
        class:active={lane === c}
        type="button"
        aria-pressed={lane === c}
        aria-label="Lane {c + 1}"
        data-testid="push2-face-lane-{c + 1}-{nodeId}"
        onclick={() => selectChannel(c)}
      >{c + 1}</button>
    {/each}
  </div>

  <div class="p2-row p2-steer">
    <!-- CARD FLIP — the #2-from-the-left encoder. The position that used to be
         painted as `i/N` is on `aria-valuetext`; the name is on the canvas. -->
    <!-- ⚠ THE POSITION RIDES `aria-label`, NOT `aria-valuetext`. The platform's
         home for a control's derived value is `aria-valuetext`, and that
         attribute is only valid on a RANGE role (slider / spinbutton /
         progressbar). This is a `group` of two one-shot buttons, not a range,
         so `aria-valuetext` here would be invalid ARIA that no assistive
         technology reads — a value moved somewhere unreachable is the same
         coverage loss as deleting it. `aria-label` is the group's own
         announced name, it is speakable, and it is what the face spec asserts. -->
    <span
      class="p2-flip"
      role="group"
      aria-label="Push card — {push2FlipValue(card)}"
      data-testid="push2-face-flip-{nodeId}"
    >
      <button
        class="p2-btn p2-flip-btn nodrag"
        type="button"
        aria-label="Previous module in this lane"
        data-testid="push2-face-card-prev-{nodeId}"
        onclick={() => scrollPushCard(-1)}
      >‹</button>
      <button
        class="p2-btn p2-flip-btn nodrag"
        type="button"
        aria-label="Next module in this lane"
        data-testid="push2-face-card-next-{nodeId}"
        onclick={() => scrollPushCard(1)}
      >›</button>
    </span>

    {#if push2ViewSegVisible(v)}
      <span class="p2-seg" role="group" aria-label="Push view" data-testid="push2-face-view-seg-{nodeId}">
        {#each PUSH2_VIEWS as opt (opt.id)}
          <button
            class="p2-btn p2-seg-btn nodrag"
            class:active={v.view === opt.id}
            type="button"
            aria-pressed={v.view === opt.id}
            aria-label={push2ViewName(opt.id)}
            data-testid="push2-face-view-{opt.id}-{nodeId}"
            onclick={() => pickView(opt.id)}
          >{opt.label}</button>
        {/each}
      </span>
    {/if}

    {#if push2BindVisible(v)}
      <button
        class="p2-btn nodrag"
        type="button"
        data-testid="push2-face-bind-{nodeId}"
        onclick={() => push2ToggleBind()}
      >{push2BindLabel(v)}</button>
    {/if}

    {#if usbOk && !v.displayOn}
      <button
        class="p2-btn nodrag"
        type="button"
        data-testid="push2-face-display-connect-{nodeId}"
        onclick={openScreen}
      >Connect display</button>
    {/if}

    <span class="p2-lamps">
      <StatusLed
        caption="PUSH"
        lit={v.connected}
        detail={push2PushDetail(v)}
        testid="push2-face-led-push-{nodeId}"
      />
      <StatusLed
        caption="SCREEN"
        lit={v.displayOn}
        detail={push2ScreenDetail(v)}
        tone={push2ScreenTone(v)}
        testid="push2-face-led-screen-{nodeId}"
      />
      <StatusLed
        caption="BOUND"
        lit={v.boundNode !== null}
        detail={push2BoundDetail(v)}
        testid="push2-face-led-bound-{nodeId}"
      />
    </span>
  </div>

  {#if errorLine}
    <p class="p2-err" data-testid="push2-face-error-{nodeId}">{errorLine}</p>
  {:else if emptyLine}
    <p class="p2-hint" data-testid="push2-face-empty-{nodeId}">{emptyLine}</p>
  {/if}
  {#if usbLine}
    <p class="p2-hint" data-testid="push2-face-nousb-{nodeId}">{usbLine}</p>
  {/if}
</div>

<style>
  /* ⚠ NO PANEL CHROME — NO BORDER, NO BACKGROUND, NO SIDE PADDING, and that is
     a WIDTH decision with a measurement behind it rather than a taste one. The
     dock width gate measures `bodyW - contentW`: the plate's own box against
     the rightmost thing the face DRAWS, with a 40 CSS px ceiling. `canvas` is
     one of the shapes that gate counts as ink by its BOX, so the replica sets
     `contentW` at its own right edge — but only while nothing wraps a wider,
     text-terminated box around it. A bordered strip's rightmost ink is a TEXT
     RANGE that stops inside its own padding, which is exactly how `gamepad`
     measured 42 px against the 40 px ceiling and how `launchpadControl`
     measured 44. Do not re-add a border, a background or horizontal padding
     here without re-reading the slack.

     The replica is the widest element and every row stretches to it, so the
     plate is sized by a picture that is entirely drawn. */
  .p2-surface {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 2px 0 6px;
  }
  /* THE WIDTH ARGUMENT, in one number. The panel is 960 backing px across 8
     strips; at 0.5× each strip's 104 px of content lands on 52 CSS px and the
     32 px readout renders at 16 — pixel-exact on a DPR-2 display and legible at
     DPR 1. The card's 340 px (0.354×) puts that readout at 11 px, where the
     numbers stop being numbers, and a 192 px lane tile (0.20×) is eight
     coloured bars with no legible text at all — which is why this body is
     dock-only and the lane keeps the ranked CONNECT cell instead. 480 px is the
     smallest width at which the replica is still a replica. */
  .p2-screen {
    position: relative;
    width: 480px;
    max-width: 100%;
    background: #000;
    border-radius: 3px;
    overflow: hidden;
    line-height: 0;
  }
  .p2-screen-a11y {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }
  .p2-screen canvas {
    display: block;
    width: 100%;
    height: auto;
    image-rendering: pixelated;
  }
  .p2-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  /* ⚠ NEVER `flex-wrap` THESE ROWS. A wrapped row can end at a control that
     paints no text node, and the gate's ink measure would stop short of the
     plate by whatever that control's box is worth — the slack would then jump
     on any machine with slightly wider fonts. */
  .p2-lanes { gap: 3px; }
  .p2-steer { gap: 10px; }
  .p2-btn {
    appearance: none;
    border: 1px solid var(--accent, #5a7);
    background: transparent;
    color: var(--accent, #5a7);
    border-radius: 4px;
    padding: 3px 8px;
    font-size: 10px;
    cursor: pointer;
  }
  .p2-btn:hover { filter: brightness(1.2); }
  .p2-lane-btn {
    flex: 1 1 0;
    min-width: 0;
    padding: 3px 0;
    text-align: center;
    opacity: 0.6;
  }
  .p2-lane-btn.active {
    border-color: #6f9bd6;
    color: #9cc0f0;
    background: rgba(80, 120, 200, 0.18);
    opacity: 1;
  }
  .p2-flip { display: inline-flex; gap: 4px; }
  .p2-flip-btn { padding: 1px 8px; line-height: 1.3; }
  .p2-seg { display: inline-flex; gap: 4px; }
  .p2-seg-btn { letter-spacing: 0.06em; opacity: 0.72; }
  .p2-seg-btn.active {
    border-color: #8a6fd6;
    color: #b79cf0;
    background: rgba(120, 80, 200, 0.14);
    opacity: 1;
  }
  .p2-lamps {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    margin-left: auto;
  }
  .p2-hint,
  .p2-err {
    margin: 0;
    font-size: 10px;
    line-height: 1.3;
    max-width: 58ch;
  }
  .p2-hint { color: var(--muted, #888); }
  .p2-err { color: #d66; }
</style>
