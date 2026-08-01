<script lang="ts">
  // Dx7AlgorithmGlyph — the DX7 algorithm routing diagram (dx7 PR 4).
  //
  // A THIN renderer over `dx7-glyph-model`. All the arithmetic — and therefore
  // every way this picture can be wrong — lives in that pure module and is
  // pinned across all 32 algorithms by its sibling spec. This file only turns
  // numbers into elements, so there is nothing here a unit test could catch
  // that the model test does not already.
  //
  // Scales by `viewBox` alone: the same component is the 40px face glyph, a
  // ~26px cell in the 32-entry picker, and (PR 6) the operator map. Nothing
  // about the SHAPE may differ between those — one geometry, three sizes.
  //
  // Colour comes from `currentColor` so the caller owns it: the shell passes
  // the module's spine colour, the picker inherits the chip's. That also keeps
  // it correct in both themes without this file knowing which one is active.

  import { dx7AlgorithmLayout } from '$lib/audio/dx7-algorithm-layout';
  import { dx7GlyphGeometry } from './dx7-glyph-model';

  interface Props {
    /** Algorithm number 1..32. Out-of-range renders nothing, never throws. */
    num: number;
    /** Draw the operator numbers. Off for the smallest picker cells, where a
     *  2px digit is noise rather than information. */
    numbers?: boolean;
    testid?: string;
  }

  let { num, numbers = true, testid }: Props = $props();

  let geom = $derived.by(() => {
    const layout = dx7AlgorithmLayout(num);
    return layout ? dx7GlyphGeometry(layout) : undefined;
  });
</script>

{#if geom}
  <svg
    class="dx7-alg"
    viewBox={geom.viewBox}
    preserveAspectRatio="xMidYMid meet"
    role="img"
    aria-label="algorithm {geom.num}"
    data-testid={testid}
    data-algorithm={geom.num}
  >
    <!-- Edges first so the blocks paint over their endpoints. -->
    <g class="edges">
      {#each geom.edges as e (`${e.from}-${e.to}`)}
        <line x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2} />
      {/each}
    </g>

    {#if geom.feedback}
      <path class="feedback" d={geom.feedback.d} />
    {/if}

    <g class="blocks">
      {#each geom.blocks as b (b.op)}
        <!-- CARRIER (row 0) is filled: it reaches the output directly. A
             modulator is outlined — it is only heard through what it bends. -->
        <rect
          class="op"
          class:carrier={b.carrier}
          x={b.x}
          y={b.y}
          width={b.w}
          height={b.h}
          rx="1.5"
        />
        {#if numbers}
          <text class="op-num" class:carrier={b.carrier} x={b.x + b.w / 2} y={b.y + b.h / 2}>
            {b.op + 1}
          </text>
        {/if}
      {/each}
    </g>
  </svg>
{/if}

<style>
  .dx7-alg {
    display: block;
    width: 100%;
    height: 100%;
    overflow: visible;
  }

  .edges line,
  .feedback {
    stroke: currentColor;
    stroke-width: 0.9;
    fill: none;
    opacity: 0.75;
  }

  .feedback {
    stroke-dasharray: 1.6 1.2;
  }

  .op {
    fill: none;
    stroke: currentColor;
    stroke-width: 0.9;
  }

  .op.carrier {
    fill: currentColor;
    fill-opacity: 0.9;
  }

  .op-num {
    fill: currentColor;
    font-size: 5px;
    font-weight: 600;
    text-anchor: middle;
    dominant-baseline: central;
    /* The digit sits INSIDE a filled carrier, so it has to punch out of it. */
    paint-order: stroke;
  }

  .op-num.carrier {
    fill: var(--module-bg, #101014);
  }
</style>
