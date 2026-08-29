<script lang="ts">
  // packages/web/src/lib/ui/modules/gibribbon/GibribbonScreen.svelte
  //
  // The ONE gibribbon playfield — shared by the dock faceplate body
  // (GibribbonBody) and the legacy card (GibribbonCard), so there is exactly
  // one renderer-consumer and one keyboard map and the two surfaces cannot
  // diverge (the frogger "one painter" rule, applied to a blitted screen).
  //
  // WHAT IT IS: a READ-ONLY display + input bridge. The game runs in the
  // module FACTORY on the shared scheduler clock; this component polls the
  // rasterised ImageData snapshot each rAF and pushes keyboard intent through
  // the same judge path a patched cable uses (`extras.pushButton` /
  // `extras.pushRestart`). Unmounting it stops a blit and NOTHING else.
  //
  // KEYBOARD CANON (GAMES.md): capture only while the playfield holds focus;
  // handled keys are exactly F/D/J/K + arrows (ABXY) and R (restart) — ESC
  // and every dock chrome key fall through untouched. SCREEN OFF unmounts
  // this component, which releases capture by construction.
  //
  // THE HUD IS IN THE PICTURE, NOT HERE. Score / combo / ATTRACT / count-in /
  // GAME OVER are painted by the module's own rasteriser into the frame (the
  // GAMES.md-permitted shape). This component adds NO derived text — the
  // numbers reach the a11y tree through `aria-label` on the playfield
  // (role="application": the playfield genuinely owns its key handling), and
  // the only literal text below is control captions (RESET, WAD).
  import { patch } from '$lib/graph/store';
  import { useEngine } from '$lib/audio/engine-context';
  import {
    INTERNAL_W as GIB_W,
    INTERNAL_H as GIB_H,
    type GibribbonHandleExtras,
  } from '$lib/video/modules/gibribbon';
  import type { GibButton } from '$lib/video/modules/gibribbon-engine';
  import type { ModuleNode } from '$lib/graph/types';

  interface Props {
    nodeId: string;
  }
  let { nodeId }: Props = $props();

  const engineCtx = useEngine();

  // The card's display geometry, carried over: a fixed 480×270 CSS screen
  // over the 1024×576 buffer (putImageData does not scale; CSS does).
  const CSS_W = 480;
  const CSS_H = 270;

  let canvasEl: HTMLCanvasElement | null = $state(null);
  let ctx2d: CanvasRenderingContext2D | null = null;
  let rafId: number | null = null;
  let hasFocus = $state(false);
  let wadMissing = $state(false);
  let wadDetail = $state('');
  let ariaLabel = $state('GIBRIBBON — click to focus, then F/D/J/K (or arrows) play ABXY, R restarts');

  function node(): ModuleNode | undefined {
    return patch.nodes[nodeId] as ModuleNode | undefined;
  }
  function getExtras(): GibribbonHandleExtras | null {
    const eng = engineCtx.get();
    const n = node();
    if (!eng || !n) return null;
    return (eng.read(n, 'extras') as GibribbonHandleExtras | undefined) ?? null;
  }

  function labelFor(x: GibribbonHandleExtras): string {
    const mode = x.getMode();
    if (x.isDead()) {
      return `GIBRIBBON — game over at score ${x.getScore()}; press R, the RESET button, or pulse the restart gate`;
    }
    if (mode === 'attract') {
      return 'GIBRIBBON — attract mode self-play; press any play key (F/D/J/K or arrows) to start a run';
    }
    return `GIBRIBBON — score ${x.getScore()}, combo ${x.getCombo()}, marine ${x.getHealth()}; F/D/J/K or arrows play ABXY, R restarts`;
  }

  function draw() {
    rafId = null;
    const x = getExtras();
    if (x) {
      const next = labelFor(x);
      if (next !== ariaLabel) ariaLabel = next;
      const err = x.loadError();
      const missing = err.length > 0;
      if (missing !== wadMissing) wadMissing = missing;
      if (err !== wadDetail) wadDetail = err;
      if (canvasEl && ctx2d) {
        const snap = x.snapshot();
        if (snap) ctx2d.putImageData(snap, 0, 0);
      }
    }
    rafId = requestAnimationFrame(draw);
  }

  $effect(() => {
    if (canvasEl && !ctx2d) {
      canvasEl.width = GIB_W;
      canvasEl.height = GIB_H;
      ctx2d = canvasEl.getContext('2d');
    }
    if (rafId === null) rafId = requestAnimationFrame(draw);
    return () => {
      if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
      ctx2d = null;
    };
  });

  // Keyboard → ABXY. F/D/J/K with arrow aliases; R restarts. Handled keys
  // ONLY — anything else (ESC included) passes through to the host.
  function keyToButton(e: KeyboardEvent): GibButton | null {
    switch (e.key.toLowerCase()) {
      case 'f': case 'arrowleft':  return 'a';
      case 'd': case 'arrowdown':  return 'b';
      case 'j': case 'arrowright': return 'x';
      case 'k': case 'arrowup':    return 'y';
      default: return null;
    }
  }
  function onKeyDown(e: KeyboardEvent) {
    if (!hasFocus) return;
    if (e.key.toLowerCase() === 'r') {
      e.preventDefault();
      e.stopPropagation();
      getExtras()?.pushRestart();
      return;
    }
    const btn = keyToButton(e);
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    getExtras()?.pushButton(btn);
  }
  function onFocusIn() { hasFocus = true; }
  function onFocusOut() { hasFocus = false; }

  function resetGame() { getExtras()?.pushRestart(); }
</script>

<div class="gibribbon-screen" data-testid="gibribbon-screen-wrap">
  <!-- role="application" is exactly right: the playfield OWNS its key
       handling (F/D/J/K + arrows play ABXY, R restarts), so it MUST be
       focusable and MUST take a keydown — svelte-check treats the role as
       interactive, so no a11y suppression is needed. The accessible name
       carries the live score/health/mode as an ATTRIBUTE — never as
       rendered text. -->
  <div
    class="playfield"
    class:has-focus={hasFocus}
    tabindex="0"
    role="application"
    aria-label={ariaLabel}
    data-testid="gibribbon-playfield"
    onkeydown={onKeyDown}
    onfocusin={onFocusIn}
    onfocusout={onFocusOut}
  >
    <canvas
      bind:this={canvasEl}
      class="screen"
      style={`width: ${CSS_W}px; height: ${CSS_H}px;`}
      data-testid="gibribbon-screen"
    ></canvas>
  </div>
  <div class="controls nodrag">
    <button type="button" class="btn" onclick={resetGame} data-testid="gibribbon-reset"
      title="Restart the run — same path as the restart gate input and the R key.">RESET</button>
    {#if wadMissing}
      <span
        class="wad-lamp"
        data-testid="gibribbon-wad-lamp"
        role="img"
        title={`DOOM1.WAD not loaded — playing in line-art fallback. ${wadDetail}`}
        aria-label={`WAD missing: ${wadDetail || 'line-art fallback active'}`}
      >WAD</span>
    {/if}
  </div>
</div>

<style>
  .gibribbon-screen {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
  }
  .playfield {
    border: 1px solid #000;
    box-shadow: inset 0 0 12px rgba(0, 0, 0, 0.6), 0 0 4px rgba(0, 0, 0, 0.3);
    background: #000;
    border-radius: 3px;
    overflow: hidden;
    outline: none;
    line-height: 0;
  }
  .playfield.has-focus {
    box-shadow: 0 0 0 1px var(--accent), inset 0 0 12px rgba(0, 0, 0, 0.6);
  }
  .playfield:focus-visible {
    outline: 1px solid var(--accent);
    outline-offset: 1px;
  }
  .screen {
    image-rendering: pixelated;
    display: block;
    max-width: 100%;
  }
  .controls {
    display: flex;
    align-items: center;
    gap: 10px;
    align-self: flex-end;
    padding-right: 2px;
  }
  .btn {
    background: var(--module-bg);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 3px;
    font-size: 0.6rem;
    letter-spacing: 0.08em;
    padding: 3px 10px;
    cursor: pointer;
    font-family: ui-monospace, monospace;
  }
  .btn:hover { border-color: var(--accent-dim); }
  .btn:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px; }
  .wad-lamp {
    font-family: ui-monospace, monospace;
    font-size: 0.55rem;
    letter-spacing: 0.08em;
    color: #f2c14e;
    border: 1px solid color-mix(in oklab, #f2c14e 50%, transparent);
    border-radius: 2px;
    padding: 2px 6px;
  }
</style>
