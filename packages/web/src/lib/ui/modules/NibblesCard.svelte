<script lang="ts">
  // NibblesCard — 320×200 game screen + AUTO toggle + arrow-key driving.
  //
  // The card polls the engine's `read(node, 'snapshot')` at ~30 Hz for the
  // current ImageData and putImageData()s it into the on-card <canvas>.
  // When the card has focus AND AUTO is off, arrow keydowns are translated
  // into the four NibblesDirection values via the factory's extras handle.
  //
  // Resize behaviour: CSS scales the 320×200 source up with image-rendering:
  // pixelated. The on-card knobs / buttons stay fixed-size; only the
  // game-screen area scales.

  import type { NodeProps } from '@xyflow/svelte';
  import { onMount, onDestroy } from 'svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { patch } from '$lib/graph/store';
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
  import { nibblesDef } from '$lib/video/modules/nibbles';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { cardParams, portsFromDef } from './card-kit';
  // ⚠ ONE IMPLEMENTATION, TWO SURFACES. Every gesture below is now the same
  // call the v2 faceplate makes (`nibbles-game-actions.ts`), so a change to how
  // this game is driven cannot land on only one of them. Two of the four are
  // also BUG FIXES the card gets in the same move:
  //   * AUTO was a raw `patch.nodes[id].params.auto = …` store write, carried
  //     in raw-write-ledger.ts as `kind: 'debt'` ("should be undoable +
  //     synced"). It goes through `setNodeParam` now, and the ledger entry is
  //     DELETED in the same commit — promotion would otherwise have made that
  //     debt unreachable without paying it, i.e. green forever while describing
  //     a path nobody can take.
  //   * SCALE was component `$state`, so it died with the component — and under
  //     the shipping shell this card lives ONLY inside the dock full view, so
  //     collapsing the pane (or the dock's LRU evicting it) already reset a
  //     user's 4x zoom to 1x. It lives on `node.data.previewScale` now
  //     (#1531 / #1574 / #1583), which is also the key the faceplate reads, so
  //     the two surfaces show one zoom.
  import {
    cycleNibblesScale,
    fireNibblesReset,
    nibblesDirectionForKey,
    nibblesPreviewScale,
    pushNibblesDirection,
    toggleNibblesAuto,
  } from './nibbles-game-actions';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  const { defaultFor, paramVal, set } = cardParams(nibblesDef, () => id, () => node);

  // ---------- Card surface ----------
  let cardEl: HTMLDivElement | null = $state(null);
  let canvasEl: HTMLCanvasElement | null = $state(null);
  let ctx2d: CanvasRenderingContext2D | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let score = $state(4);
  let alive = $state(true);

  // ---------- Resize state ----------
  // Scale step in multiples of the native 320×200 source. 1×, 2×, 3×, 4×.
  // ⚠ ON THE NODE, NOT IN THIS COMPONENT — see the import block. `nodeVersion`
  // is the dependency because `patch.nodes[id].data` is a Y-backed proxy whose
  // identity never changes, so a derived reading through it would never
  // recompute inside xyflow's node subtree.
  let scale = $derived.by<number>(() => {
    void nodeVersion(id);
    return nibblesPreviewScale(patch.nodes[id] as ModuleNode | undefined);
  });

  // ---------- Auto + focus ----------
  let autoOn = $derived(paramVal('auto') >= 0.5);
  let hasFocus = $state(false);

  function pollStatus() {
    const eng = engineCtx.get(); if (!eng || !node || !ctx2d) return;
    const snap = eng.read(node, 'snapshot') as ImageData | undefined;
    if (snap) ctx2d.putImageData(snap, 0, 0);
    const sc = eng.read(node, 'score') as number | undefined;
    if (typeof sc === 'number') score = sc;
    const al = eng.read(node, 'alive') as boolean | undefined;
    if (typeof al === 'boolean') alive = al;
  }

  onMount(() => {
    if (canvasEl) {
      canvasEl.width = 320;
      canvasEl.height = 200;
      ctx2d = canvasEl.getContext('2d');
    }
    pollTimer = setInterval(pollStatus, 33); // ~30 Hz
  });
  onDestroy(() => {
    if (pollTimer) clearInterval(pollTimer);
  });

  function toggleAuto() { toggleNibblesAuto(id); }

  function resetGame() { fireNibblesReset(id); }

  function cycleScale() { cycleNibblesScale(id); }

  // Keyboard: arrow keys drive direction only when the card holds focus.
  function onKeyDown(e: KeyboardEvent) {
    if (!hasFocus) return;
    const dir = nibblesDirectionForKey(e.key);
    if (!dir) return;
    // Same pattern as the DoomCard arrow-key handling (PR #275): stop
    // propagation so SvelteFlow's keyboard-pan handler doesn't move the
    // viewport while we're driving the snake.
    e.preventDefault();
    e.stopPropagation();
    // ⚠ THE AUTO GUARD IS THE FACTORY'S, NOT THIS COMPONENT'S. `pushDirection`
    // already returns false while AUTO is on; the card used to re-derive that
    // rule locally, which is one more place for it to disagree.
    pushNibblesDirection(id, dir);
  }

  function onFocusIn() { hasFocus = true; }
  function onFocusOut() { hasFocus = false; }

  let screenW = $derived(320 * scale);
  let screenH = $derived(200 * scale);

  const outputs = portsFromDef(nibblesDef.outputs, { dir_change: 'DIR', length_cv: 'LENGTH' });
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions
     — `role="application"` is exactly right here: the card OWNS its key handling (arrows drive
     the snake when AUTO is off), so it MUST be focusable and MUST take a keydown. Svelte's
     rules do not model `application` as interactive. -->
<div
  bind:this={cardEl}
  class="mod-card nibbles-card"
  class:has-focus={hasFocus}
  tabindex="0"
  role="application"
  aria-label="NIBBLES — arrow keys drive snake when AUTO is off"
  onkeydown={onKeyDown}
  onfocusin={onFocusIn}
  onfocusout={onFocusOut}
>
  <div class="stripe" style="background: var(--cable-video);"></div>
  <ModuleTitle {id} {data} defaultLabel="NIBBLES" />

  <PatchPanel nodeId={id} {outputs}>
  <div class="header-row">
    <div class="score" data-testid="nibbles-score">LEN {score}{alive ? '' : ' †'}</div>
    <button
      type="button"
      class="btn auto-btn"
      class:on={autoOn}
      onclick={toggleAuto}
      data-testid="nibbles-auto"
      title="Toggle self-play (AUTO bot drives the snake)"
    >AUTO {autoOn ? 'ON' : 'OFF'}</button>
  </div>

  <div class="screen-wrap" style={`width: ${screenW}px; height: ${screenH}px;`}>
    <canvas bind:this={canvasEl} class="screen" data-testid="nibbles-screen"></canvas>
  </div>

  <div class="row">
    <Knob
      value={paramVal('tick_ms')}
      min={40} max={200} defaultValue={defaultFor('tick_ms')}
      label="TICK" curve="linear"
      onchange={set('tick_ms')} moduleId={id} paramId="tick_ms"
    />
    <div class="buttons">
      <button type="button" class="btn small" onclick={cycleScale} data-testid="nibbles-scale">{scale}×</button>
      <button type="button" class="btn small" onclick={resetGame} data-testid="nibbles-reset">RESET</button>
    </div>
  </div>

  <div class="tip">Click to focus → arrow keys drive snake. AUTO = self-play.</div>
  </PatchPanel>
</div>

<style>
  .mod-card {
    /* Width grows with the scale knob (screen-wrap width + chrome
     *  padding), but never narrower than the chrome row needs. */
    width: max-content;
    min-width: 380px;
    background: var(--module-bg);
    border: 1px solid var(--border);
    border-radius: 2px;
    color: var(--text);
    /* Rack-compaction (#759): tighter bottom padding to fit the 2u tier.
     * padding-top stays 18px because the output handles are absolutely
     * positioned (top: 56–224px) relative to the card top. */
    padding: 18px 14px 9px;
    position: relative;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    outline: none;
  }
  :global(.svelte-flow__node:hover) .mod-card { border-color: var(--accent-dim); }
  :global(.svelte-flow__node.selected) .mod-card {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent-glow), 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  .has-focus {
    box-shadow: 0 0 0 1px var(--accent), 0 2px 12px rgba(135, 200, 255, 0.4);
  }
  .stripe {
    position: absolute; top: 0; left: 0; right: 0; height: 2px;
    border-radius: 2px 2px 0 0;
  }
  .header-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin: 4px 0 8px;
    padding: 0 8px;
  }
  .score {
    font-family: ui-monospace, monospace;
    font-size: 0.75rem;
    color: var(--text);
    letter-spacing: 0.08em;
  }
  .screen-wrap {
    /* Rack-compaction (#759): tighter vertical margin to fit the 2u tier. */
    margin: 3px auto 6px;
    border: 1px solid #000;
    box-shadow: inset 0 0 12px rgba(0, 0, 0, 0.6), 0 0 4px rgba(0, 0, 0, 0.3);
    background: #000;
    border-radius: 3px;
    overflow: hidden;
    display: block;
  }
  .screen {
    width: 100%;
    height: 100%;
    image-rendering: pixelated;
    display: block;
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 14px;
    padding: 0 12px;
  }
  .buttons {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .btn {
    background: var(--module-bg);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 3px;
    font-size: 0.7rem;
    letter-spacing: 0.08em;
    padding: 6px 12px;
    cursor: pointer;
    font-family: ui-monospace, monospace;
  }
  .btn:hover { border-color: var(--accent-dim); }
  .btn.on {
    background: rgba(135, 200, 255, 0.2);
    color: #87c8ff;
    border-color: #87c8ff;
  }
  .btn.small { font-size: 0.6rem; padding: 4px 8px; }
  .auto-btn { min-width: 86px; text-align: center; }
  .tip {
    font-family: ui-monospace, monospace;
    font-size: 0.55rem;
    color: var(--text-dim);
    text-align: center;
    margin-top: 8px;
    letter-spacing: 0.04em;
  }
</style>
