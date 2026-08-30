<script lang="ts">
  // LaunchpadBinderBody — the LAUNCHPAD BINDING surface, at the head of the
  // dock full view.
  //
  // ── WHAT IT CARRIES, AND WHY EACH PART IS ALLOWED TO ──────────────────────
  //
  // The resting-text rulings permit the module NAME, section LABELS, control
  // CAPTIONS and option/landmark NAMES. Everything here is one of those, an
  // ERROR, or a LAMP:
  //
  //   * THE BIND CONTROL — a button whose caption names the action it will
  //     perform (`Bind to clip-player` / `Unbind clip-player`). It is HERE and
  //     not a ranked cell for two mechanical reasons: `ShellActionCell.label`
  //     is a plain `string` (shell-cells.ts), so a cell could not say which of
  //     the two it is about to do; and the gesture is a NO-OP on a rack with no
  //     clip-player, which is the state a fresh rack is always in, while an
  //     action cell has no `disabled`. A ranked BIND would be a control that
  //     looks alive and is not. The body can keep the card's own condition
  //     (`LaunchpadControlCard.svelte:169`) because ordinary Svelte can.
  //   * THE FOUR-ROLE SEGMENT — GRID / CLIP / ARR / CTRL are OPTION NAMES, the
  //     one text class the ruling admits on otherwise-identical controls, and
  //     they are the names the device itself uses. It renders only in SINGLE
  //     mode (`:181`), because in PAIR mode the roles are fixed by the hardware
  //     split — a `ShellSelectorCell` whose roster is empty half the time is
  //     the same defect as the BIND cell above.
  //   * THE LAMPS, through `StatusLed`: a static literal caption, a boolean
  //     that IS the picture, and the derived sentence in `aria-label` / `title`.
  //     They carry the nine-branch status line the card painted — see
  //     `launchpad-binder-status-model.ts` for what each one absorbed.
  //   * THE ERROR LINES — absent whenever nothing is wrong.
  //   * THE EMPTY-STATE LINE — present only while BIND has nothing to act on,
  //     and replaced by BIND the moment it does.
  //   * THE PAIRING INSTRUCTION — reachable only mid-handshake, i.e. never at
  //     rest, and the only thing in the product that says what to do next while
  //     the pads you must press are on the hardware.
  //
  // ⚠ NO PAIR / CONNECT BUTTON HERE, DELIBERATELY — midiclock's rule, applied
  // in its own direction. Both gestures are RANKED ACTION CELLS in the band
  // below, which is what puts them on the lane tile at all; a second button on
  // the same plate would be one gesture with two affordances and a second thing
  // to keep in sync.
  //
  // ⚠ NO 8×8 PAD MIRROR, AND IT MUST NOT GROW ONE. The matrix this module
  // drives is on the HARDWARE; nothing in the app has ever painted it, so
  // nothing loses a surface by its absence here. Inventing a half-fidelity
  // mirror on a module PR would make it the fleet's answer to "show me the
  // device" by accident of being first, while the firmware-accurate colour
  // language already lives, at length, at /docs/modules/launchpadControlLeft.
  //
  // ⚠ THIS BODY OWNS ITS SUBSCRIPTION AND RELEASES IT.

  import { onDestroy } from 'svelte';
  import { StatusLed } from '$lib/ui/controls';
  import {
    midiAvailable,
    isPairBound,
    isSingleBound,
    statusRune,
  } from '$lib/control/launchpad/launchpad-device.svelte';
  import {
    isPairing,
    pairRune,
    bindingRune,
    boundClipNode,
    launchpadActiveView,
    setLaunchpadView,
    restoreLaunchpadDeployment,
    viewRune,
  } from '$lib/control/launchpad/launchpad-control.svelte';
  import type { SingleView } from '$lib/control/launchpad/launchpad-map';
  import {
    firstClipplayer,
    launchpadGestureOutcome,
    launchpadToggleBind,
    onLaunchpadGesture,
    type LaunchpadGestureOutcome,
  } from '../launchpad-cell-actions';
  import {
    LAUNCHPAD_VIEWS,
    launchpadBindLabel,
    launchpadBindVisible,
    launchpadClipDetail,
    launchpadEmptyLine,
    launchpadErrorLine,
    launchpadLinkDetail,
    launchpadPairingLine,
    launchpadViewName,
    launchpadViewSegVisible,
    type LaunchpadBinderView,
  } from './launchpad-binder-status-model';

  let { nodeId }: { nodeId: string } = $props();

  // ⚠ THE CARD CALLED THIS ON MOUNT AND NOTHING ELSE IN THE APP CALLS IT
  // (`LaunchpadControlCard.svelte:51`; grep is the check). It restores the
  // per-machine deployment + view so a reload resumes where the player left
  // off. It touches no device and prompts for nothing — the re-bind still needs
  // a gesture — so calling it from the body is the same act, one surface over.
  restoreLaunchpadDeployment();

  // The gesture outcome lives OUTSIDE this component (see
  // launchpad-cell-actions.ts): the ranked PAIR / SINGLE cells are rendered by
  // the shared shell and cannot reach component state.
  let outcomeV = $state(0);
  const off = onLaunchpadGesture(() => { outcomeV++; });
  onDestroy(off);

  // Every read is re-derived on the launchpad layer's own version runes, which
  // is the card's pattern (`:57-65`) — the device state is module-scope, not
  // node data, so there is nothing on the graph to key off.
  let v = $derived<LaunchpadBinderView>(
    (statusRune(),
    pairRune(),
    bindingRune(),
    viewRune(),
    void outcomeV,
    {
      supported: midiAvailable(),
      paired: isPairBound() || isSingleBound(),
      single: isSingleBound(),
      pairing: isPairing(),
      view: launchpadActiveView(),
      boundNode: boundClipNode(),
      hasClip: firstClipplayer() !== null,
      outcome: launchpadGestureOutcome() as LaunchpadGestureOutcome,
    }),
  );

  let errorLine = $derived(launchpadErrorLine(v));
  let pairingLine = $derived(launchpadPairingLine(v));
  let emptyLine = $derived(launchpadEmptyLine(v));

  function pickView(view: SingleView): void {
    setLaunchpadView(view);
  }
</script>

<div class="lp-binder" data-testid="launchpad-binder-body-{nodeId}">
  <div class="controls">
    {#if launchpadBindVisible(v)}
      <button
        class="lp-btn nodrag"
        type="button"
        data-testid="launchpad-binder-bind-{nodeId}"
        onclick={() => launchpadToggleBind()}
      >{launchpadBindLabel(v)}</button>
    {/if}

    {#if launchpadViewSegVisible(v)}
      <div class="seg" role="group" aria-label="Launchpad view" data-testid="launchpad-binder-view-seg-{nodeId}">
        {#each LAUNCHPAD_VIEWS as opt (opt.id)}
          <button
            class="lp-btn seg-btn nodrag"
            class:active={v.view === opt.id}
            type="button"
            aria-pressed={v.view === opt.id}
            aria-label={launchpadViewName(opt.id)}
            data-testid="launchpad-binder-view-{opt.id}-{nodeId}"
            onclick={() => pickView(opt.id)}
          >{opt.label}</button>
        {/each}
      </div>
    {/if}
  </div>

  {#if errorLine}
    <p class="err" data-testid="launchpad-binder-error-{nodeId}">{errorLine}</p>
  {:else if pairingLine}
    <p class="hint" data-testid="launchpad-binder-pairing-{nodeId}">{pairingLine}</p>
  {:else if emptyLine}
    <p class="hint" data-testid="launchpad-binder-empty-{nodeId}">{emptyLine}</p>
  {/if}

  <span class="lamps">
    <StatusLed
      caption="LINK"
      lit={v.paired}
      detail={launchpadLinkDetail(v)}
      testid="launchpad-led-link-{nodeId}"
    />
    <StatusLed
      caption="CLIP"
      lit={v.boundNode !== null}
      detail={launchpadClipDetail(v)}
      testid="launchpad-led-clip-{nodeId}"
    />
  </span>
</div>

<style>
  /* ⚠ NO PANEL CHROME — NO BORDER, NO BACKGROUND, NO SIDE PADDING, and that is
     a WIDTH decision with a measurement behind it rather than a taste one.
     `midiclock`'s device body is a bordered panel and can afford to be: its
     control band (five division chips plus the connect cell) is WIDER than its
     body, so the band's cell boxes set the plate and sit flush against it. This
     face's band is two buttons — 277 CSS px of max-content against a bordered
     strip's 340 — so the STRIP would set the plate, and a strip's rightmost ink
     is a TEXT RANGE that stops inside its own padding. Measured: 44 CSS px of
     empty plate to the right of the last ink, against the 40 px ceiling.
     Dropping the box is the only part of that gap this module owns (the rest is
     the shell's editor + tile padding, which every face pays), and it is the
     better shape anyway: the lamps now line up with the control cells above
     them instead of sitting in a box that is wider than the controls it
     describes. Do not re-add the border without re-reading the slack. */
  .lp-binder {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    padding: 2px 0 6px;
  }
  .controls {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .lp-btn {
    appearance: none;
    border: 1px solid var(--accent, #5a7);
    background: transparent;
    color: var(--accent, #5a7);
    border-radius: 4px;
    padding: 3px 8px;
    font-size: 10px;
    cursor: pointer;
  }
  .lp-btn:hover { filter: brightness(1.2); }
  .seg { display: flex; gap: 4px; }
  .seg-btn { letter-spacing: 0.06em; opacity: 0.72; }
  .seg-btn.active {
    border-color: #8a6fd6;
    color: #b79cf0;
    background: rgba(120, 80, 200, 0.14);
    opacity: 1;
  }
  .hint,
  .err {
    margin: 0;
    font-size: 10px;
    line-height: 1.3;
    max-width: 34ch;
  }
  .hint { color: var(--muted, #888); }
  .err { color: #d66; }
  .lamps {
    display: inline-flex;
    align-items: center;
    gap: 12px;
    margin-left: auto;
  }
</style>
