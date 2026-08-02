<script lang="ts">
  // Dx7OperatorMap — THE operator view (dx7 PR 6).
  //
  // The algorithm diagram IS the operator view. One live map, one detail
  // panel. Deliberately NOT six Dexed strips (unusable below ~1400px, 6x the
  // parity cost) and NOT six `OP n` dock pages (that re-creates the hardware's
  // OPERATOR SELECT — the exact affordance this design kills).
  //
  // Each block carries five marks: number, role colour, ON/OFF dot, resolved
  // frequency, and an EG thumbnail scaled by output level.
  //
  // ⚠ ROLE IS NOT COMMUNICATED BY COLOUR ALONE. The CARRIER RAIL — the
  // horizontal line under the bottom row that every carrier drops onto — is
  // the primary cue and is pure geometry, so it survives any palette and any
  // colour-vision deficiency. Warm/cool/purple is REINFORCEMENT. If you ever
  // find yourself removing the rail to tidy the layout: that is the
  // deuteranopia trap the plan calls out by name.
  //
  // SELECTION IS LOCAL `$state`, deliberately NOT in `node.data` — a
  // rack-mate's click must never yank your panel to a different operator.

  import { patch } from '$lib/graph/store';
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
  import { dx7MapGeometry } from './dx7-op-map-model';
  import { dx7PanelOpOn, dx7PanelVoice, dx7ToggleOp } from './dx7-panel-actions';
  import { dx7Select, dx7Selected } from './dx7-selection.svelte';

  interface Props {
    nodeId: string;
  }

  let { nodeId }: Props = $props();

  // Shared with Dx7OpDetail through a module-level store — the two are
  // registered as INDEPENDENT shell cells and cannot share component state.
  let selected = $derived(dx7Selected(nodeId));

  let geom = $derived.by(() => {
    void nodeVersion(nodeId);
    const node = patch.nodes[nodeId];
    if (!node) return undefined;
    const voice = dx7PanelVoice(node);
    // `params.algorithm` is AUTHORITATIVE (the value the factory sends); the
    // voice's own field is only a stamp source. Same split as modules/dx7.ts.
    const algo = Math.round(Number(node.params?.algorithm ?? voice?.algorithm ?? 5));
    return dx7MapGeometry(algo, voice?.operators, dx7PanelOpOn(node));
  });
</script>

{#if geom}
  <div class="op-map" data-testid="dx7-operator-map" data-algorithm={geom.num}>
    <svg viewBox={geom.viewBox} preserveAspectRatio="xMidYMid meet" role="group" aria-label="operator map, algorithm {geom.num}">
      <!-- Modulation edges, behind the tiles. -->
      <g class="edges">
        {#each geom.edges as e (`${e.from}-${e.to}`)}
          <line x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2} />
        {/each}
      </g>

      {#if geom.feedback}
        <path class="feedback" d={geom.feedback.d} />
      {/if}

      <!-- THE CARRIER RAIL — see the header note. Geometry, not colour. -->
      <g class="rail" data-testid="dx7-carrier-rail">
        <line x1={geom.rail.x1} y1={geom.rail.y} x2={geom.rail.x2} y2={geom.rail.y} />
        {#each geom.rail.drops as d (d.op)}
          <line x1={d.x} y1={geom.rail.y - 6} x2={d.x} y2={geom.rail.y} />
        {/each}
      </g>

      {#each geom.blocks as b (b.op)}
        <g
          class="op"
          class:off={!b.on}
          class:sel={b.op === selected}
          data-role={b.role}
          data-testid="dx7-op-tile-{b.op + 1}"
          role="button"
          tabindex="0"
          aria-label="operator {b.op + 1}, {b.role}{b.on ? '' : ', muted'}"
          aria-pressed={b.op === selected}
          onclick={() => dx7Select(nodeId, b.op)}
          onkeydown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              dx7Select(nodeId, b.op);
            }
          }}
        >
          <rect class="tile" x={b.x} y={b.y} width={b.w} height={b.h} rx="3" />
          <text class="num" x={b.x + 4} y={b.y + 9}>{b.op + 1}</text>
          <text class="freq" x={b.x + b.w - 3} y={b.y + 9}>{b.freqLabel}</text>

          <!-- EG thumbnail (20x12 in tile-local units), scaled by output level. -->
          <polyline
            class="eg"
            points={b.egThumb.map((p) => `${b.x + 5 + p.x * 20},${b.y + b.h - 5 - p.y * 12}`).join(' ')}
          />
          <!-- Output-level bar down the right edge. -->
          <rect
            class="lvl"
            x={b.x + b.w - 5}
            y={b.y + b.h - 4 - (b.level / 99) * 14}
            width="2.5"
            height={(b.level / 99) * 14}
          />

          <!-- ON/OFF dot. Its own hit target so a mute never changes selection. -->
          <circle
            class="dot"
            class:on={b.on}
            cx={b.x + b.w - 7}
            cy={b.y + b.h - 6}
            r="3"
            role="switch"
            tabindex="0"
            aria-checked={b.on}
            aria-label="operator {b.op + 1} {b.on ? 'on' : 'off'}"
            data-testid="dx7-op-onoff-{b.op + 1}"
            onclick={(e) => {
              e.stopPropagation();
              dx7ToggleOp(nodeId, b.op);
            }}
            onkeydown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                e.stopPropagation();
                dx7ToggleOp(nodeId, b.op);
              }
            }}
          />
        </g>
      {/each}
    </svg>
  </div>
{/if}

<style>
  .op-map {
    width: 100%;
    min-width: 0;
  }
  svg {
    display: block;
    width: 100%;
    height: auto;
  }

  .edges line,
  .feedback {
    stroke: var(--border-strong, #4a5058);
    stroke-width: 1.2;
    fill: none;
  }
  .feedback {
    stroke-dasharray: 2.5 2;
  }

  /* The rail reads as the OUTPUT SUM — brighter than the modulation edges. */
  .rail line {
    stroke: var(--accent, #6cf);
    stroke-width: 1.4;
    opacity: 0.85;
  }

  .op {
    cursor: pointer;
  }
  .tile {
    fill: var(--module-bg, #14171c);
    stroke: var(--border-strong, #4a5058);
    stroke-width: 1.2;
  }
  /* Role colour — REINFORCEMENT for the rail, never the only cue. */
  .op[data-role='carrier'] .tile {
    stroke: var(--dx7-carrier, #f0a35e);
  }
  .op[data-role='modulator'] .tile {
    stroke: var(--dx7-modulator, #5ec8f0);
  }
  .op[data-role='both'] .tile {
    stroke: var(--dx7-both, #b98ef0);
  }
  .op.sel .tile {
    stroke-width: 2.4;
    fill: var(--module-bg-raised, #1b2027);
  }
  .op.off {
    opacity: 0.3;
  }

  .num {
    fill: var(--text, #e6e9ee);
    font-size: 9px;
    font-weight: 700;
  }
  .freq {
    fill: var(--text-dim, #8a9099);
    font-size: 6.5px;
    text-anchor: end;
    font-family: var(--mono, ui-monospace, monospace);
  }
  .eg {
    fill: none;
    stroke: var(--accent, #6cf);
    stroke-width: 1;
    opacity: 0.9;
  }
  .lvl {
    fill: var(--accent, #6cf);
    opacity: 0.55;
  }
  .dot {
    fill: var(--module-bg-deep, #0a0c0f);
    stroke: var(--text-dim, #8a9099);
    stroke-width: 1;
    cursor: pointer;
  }
  .dot.on {
    fill: var(--accent, #6cf);
    stroke: var(--accent, #6cf);
  }
</style>
