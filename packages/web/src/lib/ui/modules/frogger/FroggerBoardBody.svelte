<script lang="ts">
  // packages/web/src/lib/ui/modules/frogger/FroggerBoardBody.svelte
  //
  // The FROGGER dock full-view body: the live arcade board plus its SCREEN
  // ON/OFF switch. This is the module's identity — the thing you look at — and
  // before promotion it existed ONLY on a legacy card the shipping shell does
  // not mount.
  //
  // ⚠ IT IMPORTS `drawFrogger` FROM THE DEF AND DOES NOT RE-IMPLEMENT IT. The
  // painter is already a pure exported function that the legacy card calls; a
  // second painter would be two renderers for one picture with nothing able to
  // catch a divergence between them.
  //
  // ⚠ AND IT DOES NOT COPY THE CARD'S CALL SIGNATURE, WHICH WAS WRONG. The card
  // passed `canvasEl.width/height` — the BACKING STORE at DPR 2, i.e. 400x452 —
  // into a function that lays out in those same units and then draws its HUD at
  // an ABSOLUTE `'700 9px ui-monospace'` with an absolute `HUD_H = 22`. Every
  // GRID dimension is derived from w/h so the board itself scaled correctly,
  // but the HUD did not: the strip rendered 11 CSS px tall with ~4.5 CSS px
  // text. Passing CSS px and scaling the context by DPR is the fix, and the
  // card has been fixed the same way in this diff so there are never two boards
  // at two HUD scales.
  //
  // ⚠ SCREEN OFF IS UNUSUALLY SAFE HERE, AND THE REASON IS THE POINT. The game
  // runs on the shared SCHEDULER CLOCK, subscribed inside the module's FACTORY
  // — not in this component, not on rAF, and not gated on anything watching.
  // (That clock is a Web Worker `setInterval` and is not even gated on the
  // AudioContext.) So collapsing the preview stops a `drawFrogger` call and
  // NOTHING ELSE: the timer counts, the traffic moves, the frog dies, and
  // `home_gate` / `dead_gate` / `level_gate` keep firing into whatever is
  // patched. That is the owner's "it KEEPS RENDERING while OFF" floor satisfied
  // by construction rather than by care — and it is worth stating because
  // `skifree`, one module away in the same family, does NOT have this property.
  // Pinned as a permanent leg of frogger-face-model.test.ts.
  import { patch } from '$lib/graph/store';
  import { mutateNode } from '$lib/graph/mutate';
  import { useEngine } from '$lib/audio/engine-context';
  import { drawFrogger, type FroggerState } from '$lib/audio/modules/frogger';
  import type { ModuleNode } from '$lib/graph/types';

  interface Props {
    /** The graph node this faceplate is showing — the ONLY prop the slot gets
     *  (`ShellExtensionFullViewBodyProps`). */
    nodeId: string;
  }
  let { nodeId }: Props = $props();

  const engineCtx = useEngine();

  // The card's own geometry, carried over unchanged: 200 CSS px wide x 226 tall
  // for a 14x13 grid plus the HUD strip. ⚠ NOT INFLATED TO FILL A WIDE PLATE.
  // A live picture is a genuine width earner, but only for the width it
  // actually needs — "we do not want useless gray horizontal space on cards,
  // ever. prefer compact." One 200 px board and one knob column is among the
  // narrowest plates in the fleet, which is the correct outcome of the compact
  // default rather than a defect.
  const CSS_W = 200;
  const CSS_H = 226;
  const DPR = 2;

  let canvasEl: HTMLCanvasElement | null = $state(null);
  let rafId: number | null = null;

  // ⚠ STATE LIVES ON THE NODE, NOT IN THIS COMPONENT. A `$state` here dies with
  // the component, and this component unmounts on dock collapse / LRU eviction
  // — the card-unmount-kills-node-lifetime-state class (#1531 / #1574 / #1583).
  // `node.data` survives a tab switch, a remount and a reload, and syncs to
  // collaborators. Absent => false => ON, so an existing rack opens unchanged.
  // One boolean per CLICK, never per frame.
  let previewCollapsed = $derived<boolean>(
    (patch.nodes[nodeId]?.data?.previewCollapsed as boolean | undefined) ?? false,
  );
  function togglePreview(): void {
    const next = !previewCollapsed;
    mutateNode(nodeId, (live) => {
      if (!live.data) live.data = {};
      live.data.previewCollapsed = next;
    });
  }

  // ── THE SPEAKABLE HALF OF A PAINTED HUD ────────────────────────────────────
  // `drawFrogger` paints LIVES / LV / T / SCORE into the CANVAS, by the
  // module's own pure function — which the resting-text ruling allows (a game's
  // score inside its playfield is the game's artwork) and which a screen reader
  // cannot reach at all. This label is where those numbers become speakable.
  //
  // ⚠ IT IS AN `aria-label` ON A `role="img"`, NOT A CHROME ROW AND NOT
  // `aria-valuetext`. A picture is not a range role. And the face deliberately
  // adds NO text of its own beside the board — no LIVES pill, no T readout, no
  // state word. That shape is the hero readout strip with a different label and
  // it is refused by name.
  let ariaLabel = $state('FROGGER board');
  function labelFor(s: FroggerState): string {
    if (!s.isGameInPlay) {
      return s.player.lives < 1
        ? 'FROGGER — game over, pulse the START gate to restart'
        : 'FROGGER — ready, pulse the START gate to play';
    }
    return `FROGGER — lives ${s.player.lives}, level ${s.level}, `
      + `${s.time} seconds, score ${s.player.score}`;
  }

  function draw() {
    rafId = null;
    const eng = engineCtx.get();
    const node = patch.nodes[nodeId] as ModuleNode | undefined;
    if (eng && node) {
      const snap = eng.read(node, 'snapshot') as FroggerState | undefined;
      if (snap) {
        // The accessible name tracks the game even while the picture is off —
        // SCREEN OFF hides the board, it does not stop the module.
        const next = labelFor(snap);
        if (next !== ariaLabel) ariaLabel = next;
        if (!previewCollapsed && canvasEl) {
          const ctx2d = canvasEl.getContext('2d');
          if (ctx2d) {
            // CSS px in, DPR on the context — see the header note.
            ctx2d.setTransform(DPR, 0, 0, DPR, 0, 0);
            drawFrogger(ctx2d, snap, CSS_W, CSS_H);
          }
        }
      }
    }
    rafId = requestAnimationFrame(draw);
  }

  // ONE place owns the loop, so it cannot be started twice.
  $effect(() => {
    if (rafId === null) rafId = requestAnimationFrame(draw);
    return () => {
      if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
    };
  });
</script>

<div class="frogger-board" data-testid="frogger-board-body">
  <div class="preview-wrap" data-preview-collapsed={previewCollapsed ? 'true' : 'false'}>
    {#if !previewCollapsed}
      <!-- ⚠ role="img" SITS ON THE FRAME, NOT ON THE <canvas>. svelte-check
           refuses an `img` role on a canvas element
           (a11y_no_interactive_element_to_noninteractive_role) and the
           typecheck gate runs --fail-on-warnings, so this is a required shape
           rather than a preference. The accessible name is identical either
           way: the wrapper is the picture, the canvas is how it is drawn. -->
      <div class="board-frame" role="img" aria-label={ariaLabel}>
        <canvas
          bind:this={canvasEl}
          width={CSS_W * DPR}
          height={CSS_H * DPR}
          style={`width: ${CSS_W}px; height: ${CSS_H}px;`}
          data-testid="frogger-face-canvas"
        ></canvas>
      </div>
    {/if}
    <button
      type="button"
      class="screen-btn nodrag"
      class:on={!previewCollapsed}
      onclick={togglePreview}
      data-testid="frogger-face-screen-toggle"
      aria-pressed={!previewCollapsed}
      title="SCREEN: turn the board off to reclaim its space. The game keeps playing and the HOME / DEAD / LEVEL gates keep firing."
    >SCREEN {previewCollapsed ? 'OFF' : 'ON'}</button>
  </div>
</div>

<style>
  .frogger-board {
    display: flex;
    justify-content: center;
    padding: 6px 0 2px;
  }
  /* ⚠ THE SWITCH COSTS ZERO LAYOUT HEIGHT. Stacking it under the canvas cost
     spirographs ~18.8px against ~11px of slack and reddened io-spec-consistency.
     It OVERLAYS the board's bottom-right corner, so the body is exactly the
     height the picture is. */
  .preview-wrap {
    position: relative;
    display: flex;
    justify-content: center;
    /* Only load-bearing with SCREEN OFF: the canvas is gone, and without a
       floor the wrap would collapse to zero and take the absolutely-positioned
       button with it. Inert behind the canvas whenever the board shows. */
    min-height: 18px;
  }
  .board-frame { display: block; }
  .preview-wrap canvas {
    display: block;
    /* The board is drawn as solid grid cells — never smooth them. */
    image-rendering: pixelated;
    border: 1px solid color-mix(in oklab, var(--cable-gate) 30%, transparent);
    border-radius: 2px;
    background: #070b12;
    max-width: 100%;
  }
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
