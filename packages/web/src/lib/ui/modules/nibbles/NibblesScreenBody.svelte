<script lang="ts">
  // packages/web/src/lib/ui/modules/nibbles/NibblesScreenBody.svelte
  //
  // The NIBBLES dock full-view body: the live 320x200 game screen, its SCREEN
  // and SCALE overlay switches, and the module's PLAYING INTERFACE — the arrow
  // keys.
  //
  // ── ⚠ THE ARROW KEYS ARE THE INSTRUMENT, NOT KEYBOARD-A11Y ────────────────
  //
  // The standing owner ruling is "no keyboard-a11y work; Tab IS the flip
  // gesture". Nothing here is a11y keyboard NAV — reaching and operating a
  // CONTROL without a mouse — and no control's key handling is touched. What is
  // here is the way this module is PLAYED, exactly as a ribbon is moog956's and
  // a mouse is skifree's: `pushDirection` is the only manual steering NIBBLES
  // has, and it returns false while AUTO is on so the two drivers cannot fight.
  //
  // ⚠ AND THE FOCUS AFFORDANCE IS `tabindex="-1"`, NOT THE CARD'S `"0"`. That
  // is the one change from the card and it exists to honour BOTH rules at once:
  // `-1` keeps the screen out of the tab order, so Tab still flips the
  // faceplate and this promotion adds no tab stop inside the plate, while a
  // POINTER press still focuses it (explicitly, via `.focus()`, rather than
  // relying on a browser default) so the card's "click to focus, then steer"
  // gesture survives verbatim. skifree solved the same problem by replacing
  // focus with click-to-arm; that works there because the mouse is its
  // instrument, and it would not work here — a keydown has to land on a focused
  // element, and the alternative (a window-level listener) would swallow arrow
  // keys for the whole rack.
  //
  // ── ⚠ SCREEN OFF STOPS THE BLIT AND NOTHING ELSE, AND HERE THAT MATTERS
  //    MORE THAN ON ANY SIBLING ────────────────────────────────────────────
  //
  // `nibbles.ts` ticks the GAME inside `surface.draw` — `dt` accumulates into
  // `tickAccumS` and drives `advanceGame()` — so a collapse that stopped the
  // draw would stop the game and silence every gate, the length CV and both
  // oscillators. It does not: this component only READS `snapshot`, and the
  // draw belongs to the VideoEngine.
  //
  // Two things keep that true rather than one, and both are deliberate:
  //   * NIBBLES is STRUCTURALLY pull-exempt — `VideoEngine.isPullExempt`
  //     returns true for a handle with a non-empty `audioSources` map and names
  //     this module in its own comment — so it renders while unwatched anyway;
  //   * and the loop below calls `markWatched` in BOTH screen states, so the
  //     module's pull-root status cannot become a function of whether anyone is
  //     looking at the picture. That is the #1720/#1721 producer-kill-switch
  //     class, and the second guard is what makes the switch safe INDEPENDENT
  //     of the audio topology (the `blood` argument, reached the same way).
  //
  // ⚠ NO MOUNT-TIME HEAVY WORK. The only thing this component does on mount is
  // start one rAF and size a 2-D canvas; there is no probe, no decode, no
  // engine query. (#2314 shipped a 60-scene VRT regression from a tile `$effect`
  // that ran a real encoder probe on every rack boot.)
  //
  // ⚠ IT MUST STAY 2-D. `nibbles.ts` is in the WebGL attest basis and this file
  // is deliberately outside it; attest membership is derived from CONTENT, so a
  // GL context here would enrol every future face edit in the real-GPU attest.
  // `putImageData` of the factory's own `ImageData` is the same copy the card
  // has always made.
  import { patch } from '$lib/graph/store';
  import { mutateNode } from '$lib/graph/mutate';
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
  import { useEngine } from '$lib/audio/engine-context';
  import type { VideoEngine } from '$lib/video/engine';
  import type { ModuleNode } from '$lib/graph/types';
  import {
    cycleNibblesScale,
    fireNibblesReset,
    nibblesDirectionForKey,
    nibblesPreviewCollapsed,
    nibblesPreviewScale,
    nibblesScreenLabel,
    pushNibblesDirection,
  } from '../nibbles-game-actions';

  interface Props {
    /** The graph node this faceplate is showing — the ONLY prop the slot gets
     *  (`ShellExtensionFullViewBodyProps`). */
    nodeId: string;
  }
  let { nodeId }: Props = $props();

  const engineCtx = useEngine();

  /** The module's native framebuffer. Not a layout choice: `snapshot` is an
   *  `ImageData` of exactly this size and `putImageData` ignores every
   *  transform, so the backing store must match it and the ZOOM has to be CSS.
   *  Which is also what keeps the 1991-grid pixels on whole pixels. */
  const SRC_W = 320;
  const SRC_H = 200;

  let canvasEl: HTMLCanvasElement | null = $state(null);
  let frameEl: HTMLDivElement | null = $state(null);
  let ctx2d: CanvasRenderingContext2D | null = null;
  let rafId: number | null = null;

  /** Live game facts, read off the engine each frame. They exist ONLY to feed
   *  the accessible name (see `nibblesScreenLabel`) — the card's `LEN {n} †`
   *  chrome row is DELETED by the resting-text ruling, and this face paints no
   *  text of its own beside the picture. */
  let score = $state<number | null>(null);
  let alive = $state(true);
  let autoOn = $state(false);

  /** Does this surface hold the keyboard? Per-viewer, per-surface performance
   *  state with no meaning to a collaborator, so it is component `$state` by
   *  design and must NOT ride the Y.Doc. (Contrast the two below.) */
  let hasFocus = $state(false);

  // ⚠ STATE ON THE NODE, NOT IN THE COMPONENT — for BOTH switches. This
  // component unmounts on a dock collapse / LRU eviction (the
  // #1531 / #1574 / #1583 class), and for SCALE that is not a hypothetical:
  // holding the zoom in component `$state` is what the legacy card does, which
  // is why collapsing the pane already resets a user's 4x zoom to 1x today.
  //
  // ⚠ `nodeVersion(nodeId)` IS THE DEPENDENCY. `patch.nodes[id].data` is a
  // Y-backed proxy whose IDENTITY never changes, so a derived that reads
  // through it has no dependency on anything inside it; the per-node version
  // signal is the same one ModuleShell's own `liveCell` is built on.
  //
  // ⚠⚠ AND EACH DERIVED MUST END AT A LEAF — a boolean, a number — NEVER at the
  // node. This was written the obvious way first (one `node` derived over
  // `nodeVersion`, then `previewCollapsed`/`scale` derived off IT) and it
  // SHIPPED BOTH SWITCHES DEAD. The version signal fires, the node derived
  // re-runs, and it returns the SAME Y-backed proxy object — so Svelte's
  // value-equality check stops the propagation right there and nothing
  // downstream ever recomputes. The graph was perfectly correct underneath:
  // `node.data.previewCollapsed` and `previewScale` both moved on every press
  // while the picture and the button captions sat still.
  //
  // ⚠ NOTHING BUT A RENDER CAN SEE THAT. `video-face-screen-source.test.ts`
  // was green (this file reads the key, writes the key and exposes a button —
  // all three true), the face model test was green, and typecheck was green.
  // Only `face-nibbles.spec.ts` pressing the real button caught it.
  let previewCollapsed = $derived.by<boolean>(() => {
    void nodeVersion(nodeId);
    return nibblesPreviewCollapsed(patch.nodes[nodeId] as ModuleNode | undefined);
  });
  let scale = $derived.by<number>(() => {
    void nodeVersion(nodeId);
    return nibblesPreviewScale(patch.nodes[nodeId] as ModuleNode | undefined);
  });

  let ariaLabel = $derived(nibblesScreenLabel(score, alive, autoOn));

  /**
   * ⚠ THE SCREEN WRITE IS INLINE, AND THE OTHER THREE GESTURES ARE NOT. That
   * asymmetry is deliberate rather than an oversight, and it has two reasons
   * pointing the same way:
   *
   *   * RESET / SCALE / the arrow keys have TWO callers each — this body and
   *     the legacy card — so they must be one shared implementation or they
   *     will drift. SCREEN has exactly ONE: the card never had a screen switch,
   *     because the ruling that requires one post-dates it and is about the
   *     surface promotion DESTROYS. There is nothing here to keep in step.
   *   * `video-face-screen-source.test.ts` reads this file's SOURCE and
   *     requires it to WRITE `.data.previewCollapsed` — that is the leg that
   *     separates a body which can actually toggle the screen from one that
   *     merely displays its state, and it is worth keeping literal rather than
   *     widening the gate to chase a call through a helper.
   */
  function togglePreview(): void {
    const next = !previewCollapsed;
    mutateNode(nodeId, (live) => {
      if (!live.data) live.data = {};
      live.data.previewCollapsed = next;
    });
  }
  function cycleScale(): void { cycleNibblesScale(nodeId); }
  function reset(): void { fireNibblesReset(nodeId); }

  /**
   * Arrow keys drive the snake while this surface holds focus.
   *
   * ⚠ `stopPropagation` IS LOAD-BEARING, carried over from the card (and from
   * DoomCard before it, #275): without it SvelteFlow's keyboard-pan handler
   * moves the viewport while you are steering.
   */
  function onKeyDown(e: KeyboardEvent): void {
    const dir = nibblesDirectionForKey(e.key);
    if (!dir) return;
    e.preventDefault();
    e.stopPropagation();
    // `pushDirection` itself refuses while AUTO is on, so the rule lives in the
    // factory and is not re-derived here.
    pushNibblesDirection(nodeId, dir);
  }

  /** Click to take the keyboard. Explicit rather than relying on a browser's
   *  click-focus behaviour for a `tabindex="-1"` element. */
  function onPointerDown(): void { frameEl?.focus(); }
  function onFocusIn(): void { hasFocus = true; }
  function onFocusOut(): void { hasFocus = false; }

  function draw(): void {
    rafId = null;
    const eng = engineCtx.get();
    const live = patch.nodes[nodeId] as ModuleNode | undefined;
    if (eng && live) {
      // ⚠ THE WATCH MARK IS RENEWED IN BOTH SCREEN STATES, and ABOVE the
      // collapse branch. See the header: a mark that stopped with the picture
      // would make this switch a producer kill switch on a rack where the
      // structural exemption did not hold.
      try {
        eng.getDomain<VideoEngine>('video')?.markWatched(nodeId);
      } catch { /* never nuke the rAF loop */ }

      // ⚠ READ FIRST, PAINT SECOND. The accessible name tracks the game even
      // while the screen is off; the collapse skips the BLIT and nothing else.
      const s = eng.read(live, 'score');
      if (typeof s === 'number' && s !== score) score = s;
      const a = eng.read(live, 'alive');
      if (typeof a === 'boolean' && a !== alive) alive = a;
      const au = eng.read(live, 'auto');
      if (typeof au === 'boolean' && au !== autoOn) autoOn = au;

      if (!previewCollapsed && canvasEl) {
        if (!ctx2d) ctx2d = canvasEl.getContext('2d');
        const snap = eng.read(live, 'snapshot') as ImageData | undefined;
        if (ctx2d && snap) ctx2d.putImageData(snap, 0, 0);
      }
    }
    rafId = requestAnimationFrame(draw);
  }

  // ONE place owns the loop, and it runs in BOTH screen states (see above), so
  // nothing has to restart it on toggle — which removes the "switched back on
  // and the picture never came back" failure mode by construction.
  $effect(() => {
    if (rafId === null) rafId = requestAnimationFrame(draw);
    return () => {
      if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
      ctx2d = null;
    };
  });
</script>

<div class="nibbles-screen" data-testid="nibbles-face-body">
 <div class="screen-box">
  <!-- ⚠ THE ZOOM SCROLLS, IT DOES NOT WIDEN THE PLATE. The card does the
       opposite (`.mod-card { width: max-content }` plus an inline
       `width: 320*scale`), so a 4x zoom makes the CARD 1280 px wide — exactly
       the "useless gray horizontal space" the compact ruling forbids. The
       plate is sized to the 1x preview and everything above 1x pans inside
       this box.
       ⚠ THE TWO SWITCHES ARE SIBLINGS OF THIS BOX, NOT CHILDREN OF IT: an
       absolutely-positioned child of a scroll container SCROLLS WITH the
       content, so at 4x they would slide off the picture. -->
  <div
    class="preview-wrap"
    data-preview-collapsed={previewCollapsed ? 'true' : 'false'}
    data-preview-scale={scale}
  >
    {#if !previewCollapsed}
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions
           — `role="application"` is exactly right for a surface that owns its
           own key handling (the arrows ARE how this module is played); Svelte's
           rules do not model it as interactive. -->
      <div
        bind:this={frameEl}
        class="screen-frame nodrag"
        class:has-focus={hasFocus}
        role="application"
        tabindex="-1"
        aria-label={ariaLabel}
        data-armed={hasFocus ? 'true' : 'false'}
        data-testid="nibbles-face-screen-frame"
        onkeydown={onKeyDown}
        onpointerdown={onPointerDown}
        onfocusin={onFocusIn}
        onfocusout={onFocusOut}
      >
        <canvas
          bind:this={canvasEl}
          width={SRC_W}
          height={SRC_H}
          style={`width: ${SRC_W * scale}px; height: ${SRC_H * scale}px;`}
          data-testid="nibbles-screen"
        ></canvas>
      </div>
    {/if}
  </div>

    <!-- ⚠ ALL THREE CONTROLS OVERLAY THE PICTURE'S CORNERS AND COST ZERO
         LAYOUT HEIGHT. A stacked row cost spirographs ~18.8 px against ~11 px
         of slack and reddened io-spec-consistency; rows here would cost ~37 px
         for two and ~56 px for three. -->
    <button
      type="button"
      class="corner-btn scale-btn nodrag"
      onclick={cycleScale}
      data-testid="nibbles-scale"
      aria-label={`Preview scale ${scale}x`}
    >{scale}×</button>
    <!-- ⚠ RESET LIVES HERE RATHER THAN AS A RANKED `ShellActionCell`, AND THE
         REASON IS A MEASUREMENT, NOT A PREFERENCE. An `action` cell's probe
         must be an AUDITION (reset writes no param and no node.data — the game
         is factory-internal — so `readParam`/`readData` are structurally blind
         to it, and a `data-rev` probe is outlawed as "a revision-only probe
         passes on a dead button that bumps the counter"). But `faces-parity`
         spawns EVERY module with `spawnPatch({ id, type, position })` and no
         `domain`, which `_helpers.ts` defaults to `'audio'` — so a VIDEO
         module's factory is never constructed in that sweep and
         `engine.read(node, 'extras')` returns `undefined`. MEASURED on this
         module, both directions, on the default shell: spawned `domain:
         'video'` the ledger records `delivered: true`; spawned the sweep's way
         it records `delivered: false`. A ranked cell would therefore have gone
         RED for a reason that has nothing to do with this module.
         ⚠ THE PROBE IS NOT LOST, IT MOVED SOMEWHERE STRICTLY STRONGER:
         `face-nibbles.spec.ts` presses THIS button on a real, constructed
         nibbles and asserts the audition ledger — which is what the sweep's
         probe was trying to be. `outToLaunch` is the only other video module
         with an `engine-message` audition and it does not hit this because its
         seam never touches the node handle (it asks WebMIDI). -->
    <button
      type="button"
      class="corner-btn reset-btn nodrag"
      onclick={reset}
      data-testid="nibbles-reset"
      title="Restart the game — a fresh snake, a new pellet, the length CV and both pitches re-derived. Changes no setting and is not undoable."
    >RESET</button>
    <button
      type="button"
      class="corner-btn screen-btn nodrag"
      class:on={!previewCollapsed}
      onclick={togglePreview}
      data-testid="nibbles-face-screen-toggle"
      aria-pressed={!previewCollapsed}
      title={previewCollapsed
        ? 'SCREEN is OFF — the game screen is collapsed and its space reclaimed. The snake keeps moving and the PELLET / DEATH / DIR gates, the LENGTH CV and both audio outs keep firing; switching it back on shows the LIVE game, not a stale frame.'
        : 'SCREEN — turn the game screen off to collapse it and reclaim the vertical space. The game keeps playing and every output keeps firing either way.'}
    >SCREEN {previewCollapsed ? 'OFF' : 'ON'}</button>
  </div>
</div>

<style>
  .nibbles-screen {
    display: flex;
    justify-content: center;
    padding: 6px 0 2px;
  }
  /* The positioning context for the two corner switches. Sized to the 1x
     picture, so the plate is sized to 1x — an entry justified by 4x would be
     justifying the card's bug. */
  .screen-box {
    position: relative;
    max-width: 322px;
  }
  .preview-wrap {
    display: flex;
    justify-content: flex-start;
    /* Above 1x the canvas overflows and THIS box scrolls; the plate never
       grows. */
    max-width: 100%;
    overflow: auto;
    /* Only load-bearing with SCREEN OFF: the canvas is gone, and without a
       floor the wrap would collapse to zero and take the absolutely-positioned
       buttons with it. Inert behind the canvas whenever the screen shows. */
    min-height: 18px;
  }
  .screen-frame {
    display: block;
    line-height: 0;
    outline: none;
    border: 1px solid #000;
    border-radius: 3px;
    background: #000;
    box-shadow: inset 0 0 12px rgba(0, 0, 0, 0.6), 0 0 4px rgba(0, 0, 0, 0.3);
  }
  /* The card's focus glow, carried over: it is the ONLY signal that the arrow
     keys will do anything, and the `.tip` sentence that used to say so is
     deleted by the resting-text ruling. */
  .screen-frame.has-focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent), 0 2px 12px rgba(135, 200, 255, 0.4);
  }
  .preview-wrap canvas {
    display: block;
    /* 320x200 pixel art. Never smooth it. */
    image-rendering: pixelated;
  }
  .corner-btn {
    position: absolute;
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
    font-family: ui-monospace, monospace;
  }
  .corner-btn:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px; }
  .scale-btn { left: 4px; }
  /* Beside SCALE rather than in a row of its own — see the markup note. */
  .reset-btn { left: 44px; }
  .screen-btn { right: 4px; }
  .screen-btn.on { color: var(--text); border-color: var(--accent-dim); }
</style>
