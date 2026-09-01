<script lang="ts">
  // packages/web/src/lib/ui/modules/modtris/ModtrisWellBody.svelte
  //
  // The MODTRIS dock full-view body: the live well + NEXT strip + LN/LV counts,
  // plus its SCREEN ON/OFF switch. This is the module's identity — the thing you
  // look at — and before promotion it existed ONLY on a legacy card the shipping
  // shell does not mount.
  //
  // ⚠ IT IMPORTS `drawModtris` FROM THE DEF AND DOES NOT RE-IMPLEMENT IT. The
  // painter is already a pure exported function that the legacy card calls; a
  // second painter would be two renderers for one picture with nothing able to
  // catch a divergence between them.
  //
  // ⚠ AND IT DOES NOT COPY THE CARD'S OLD CALL SIGNATURE, WHICH WAS WRONG. The
  // card passed `canvasEl.width/height` — the BACKING STORE at DPR 2, i.e.
  // 400x520 — into a function that lays out in those same units and then draws
  // its NEXT strip at an ABSOLUTE `'700 9px'` with absolute `+14`/`+90`/`+102`
  // offsets. Every WELL dimension is derived from w/h so the board scaled
  // correctly, but the strip did not: NEXT / LN / the count rendered at ~4.5-5.5
  // CSS px with a compressed vertical rhythm. Passing CSS px and scaling the
  // context by DPR is the fix, and the card is fixed the same way in this diff
  // so there are never two wells at two label scales.
  //
  // ⚠ SCREEN OFF IS UNUSUALLY SAFE HERE, AND THE REASON IS THE POINT. The game
  // runs on the shared SCHEDULER CLOCK, subscribed inside the module's FACTORY
  // (`modtris.ts`) — not in this component, not on rAF, and not gated on
  // anything watching. (That clock is a Web Worker `setInterval` and is not even
  // gated on the AudioContext, which is why the harness's audio suspend could
  // never stop this game and why the VRT pin had to be a module-side seam.) So
  // collapsing the preview stops a `drawModtris` call and NOTHING ELSE: pieces
  // keep falling, lines keep clearing, and `line_cleared` / `overfill` keep
  // pulsing into whatever is patched. That is the owner's "it KEEPS RENDERING
  // while OFF" floor satisfied by construction rather than by care — and it is
  // worth stating because `skifree`, one module away in the same family, does
  // NOT have this property.
  //
  // ⚠ THE ACCESSIBLE NAME OUTLIVES THE PICTURE, DELIBERATELY. The `role="img"`
  // frame is rendered UNCONDITIONALLY and only the `<canvas>` is inside the
  // collapse guard, so with SCREEN OFF a screen reader still tracks the lines,
  // the level and the next piece. (`FroggerBoardBody.svelte` puts the frame
  // inside the guard, so its own comment's claim that "the accessible name
  // tracks the game even while the picture is off" is false there. Not fixed
  // here — it is another module's file — and reported instead.)
  import { patch } from '$lib/graph/store';
  import { mutateNode } from '$lib/graph/mutate';
  import { useEngine } from '$lib/audio/engine-context';
  import { drawModtris, type ModtrisState } from '$lib/audio/modules/modtris';
  import type { ModuleNode } from '$lib/graph/types';

  interface Props {
    /** The graph node this faceplate is showing — the ONLY prop the slot gets
     *  (`ShellExtensionFullViewBodyProps`). */
    nodeId: string;
  }
  let { nodeId }: Props = $props();

  const engineCtx = useEngine();

  // The card's own geometry, carried over unchanged: 200 CSS px wide x 260 tall
  // for a 10x20 well plus the 30 % NEXT strip the painter reserves
  // (`wellWidthPx = w * 0.7`). ⚠ NOT INFLATED TO FILL A WIDE PLATE. A live
  // picture is a genuine width earner, but only for the width it actually needs
  // — "we do not want useless gray horizontal space on cards, ever. prefer
  // compact." One 200 px well and two fader columns is among the narrowest
  // plates in the fleet, which is the correct outcome of the compact default
  // rather than a defect.
  const CSS_W = 200;
  const CSS_H = 260;
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
  // `drawModtris` paints NEXT, the next-piece preview, LN and LV into the
  // CANVAS, by the module's own pure function — which the resting-text ruling
  // allows (a game's score inside its playfield is the game's artwork) and which
  // a screen reader cannot reach at all. This label is where those numbers
  // become speakable.
  //
  // ⚠ IT IS AN `aria-label` ON A `role="img"`, NOT A CHROME ROW AND NOT
  // `aria-valuetext`. A picture is not a range role. And the face deliberately
  // adds NO text of its own beside the well — no LINES pill, no LEVEL readout,
  // no GAME OVER banner. That shape is the hero readout strip with a different
  // label and it is refused by name.
  let ariaLabel = $state('MODTRIS well');
  function labelFor(s: ModtrisState): string {
    const filled = s.well.reduce((n, v) => (v === 0 ? n : n + 1), 0);
    const pct = Math.round((filled / s.well.length) * 100);
    const next = s.queue[0] ?? '—';
    return `MODTRIS — ${s.lines} lines, level ${s.level}, next piece ${next}, well ${pct}% full`;
  }

  function draw() {
    rafId = null;
    const eng = engineCtx.get();
    const node = patch.nodes[nodeId] as ModuleNode | undefined;
    if (eng && node) {
      const snap = eng.read(node, 'snapshot') as ModtrisState | undefined;
      if (snap) {
        // The accessible name tracks the game even while the picture is off —
        // SCREEN OFF hides the well, it does not stop the module.
        const next = labelFor(snap);
        if (next !== ariaLabel) ariaLabel = next;
        if (!previewCollapsed && canvasEl) {
          const ctx2d = canvasEl.getContext('2d');
          if (ctx2d) {
            // CSS px in, DPR on the context — see the header note.
            ctx2d.setTransform(DPR, 0, 0, DPR, 0, 0);
            drawModtris(ctx2d, snap, CSS_W, CSS_H);
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

<div class="modtris-well" data-testid="modtris-well-body">
  <div class="preview-wrap" data-preview-collapsed={previewCollapsed ? 'true' : 'false'}>
    <!-- ⚠ role="img" SITS ON THE FRAME, NOT ON THE <canvas>. svelte-check
         refuses an `img` role on a canvas element
         (a11y_no_interactive_element_to_noninteractive_role) and the typecheck
         gate runs --fail-on-warnings, so this is a required shape rather than a
         preference. The accessible name is identical either way: the wrapper is
         the picture, the canvas is how it is drawn.
         ⚠ AND THE FRAME IS OUTSIDE THE COLLAPSE GUARD so the name survives
         SCREEN OFF — see the header. -->
    <div class="well-frame" role="img" aria-label={ariaLabel}>
      {#if !previewCollapsed}
        <canvas
          bind:this={canvasEl}
          width={CSS_W * DPR}
          height={CSS_H * DPR}
          style={`width: ${CSS_W}px; height: ${CSS_H}px;`}
          data-testid="modtris-face-canvas"
        ></canvas>
      {/if}
    </div>
    <button
      type="button"
      class="screen-btn nodrag"
      class:on={!previewCollapsed}
      onclick={togglePreview}
      data-testid="modtris-face-screen-toggle"
      aria-pressed={!previewCollapsed}
      title="SCREEN: turn the well off to reclaim its space. The game keeps playing and the LINE / OVERFILL gates keep firing."
    >SCREEN {previewCollapsed ? 'OFF' : 'ON'}</button>
  </div>
</div>

<style>
  .modtris-well {
    display: flex;
    justify-content: center;
    padding: 6px 0 2px;
  }
  /* ⚠ THE SWITCH COSTS ZERO LAYOUT HEIGHT. Stacking it under the canvas cost
     spirographs ~18.8px against ~11px of slack and reddened io-spec-consistency.
     It OVERLAYS the well's bottom-right corner, so the body is exactly the
     height the picture is. */
  .preview-wrap {
    position: relative;
    display: flex;
    justify-content: center;
    /* Only load-bearing with SCREEN OFF: the canvas is gone, and without a floor
       the wrap would collapse to zero and take the absolutely-positioned button
       with it. Inert behind the canvas whenever the well shows. */
    min-height: 18px;
  }
  .well-frame { display: block; }
  .preview-wrap canvas {
    display: block;
    /* The well is drawn as solid grid cells — never smooth them. */
    image-rendering: pixelated;
    border: 1px solid color-mix(in oklab, var(--cable-gate) 30%, transparent);
    border-radius: 2px;
    background: #0b121a;
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
