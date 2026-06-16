<script lang="ts">
  // GridDiagram.svelte — docs component kit
  //
  // A data-driven "annotated hardware grid" diagram (the monome-manual style):
  // a rows×cols pad grid with rounded cells, plus labeled CALLOUTS drawn below
  // — a bracket spanning a range of columns for a group, or a single tick for
  // one control. Everything is plain SVG computed from props, so it's
  // reproducible, theme-able, and stays in sync with the code that feeds it
  // (no AI image-gen, no hand-pixel-pushing). Reused across grid modules
  // (clipplayer / grids / kria / monome).
  //
  // Sibling of IoDiagram.svelte; the same "diagram = pure function of data" idea.

  import type { GridCell, GridCallout, GridSideLabel } from './grid-diagram-types';

  interface Props {
    cols: number;
    rows: number;
    cells?: GridCell[];
    callouts?: GridCallout[];
    sideLabels?: GridSideLabel[];
    /** accent for labels + brackets (default the docs red). */
    accent?: string;
    caption?: string;
  }
  let {
    cols,
    rows,
    cells = [],
    callouts = [],
    sideLabels = [],
    accent = '#c0392b',
    caption,
  }: Props = $props();

  // ---- geometry (all derived; SVG re-lays-out if props change) ----
  const CELL = 30; // pad edge
  const GAP = 6; // between pads
  const PITCH = CELL + GAP;
  const PAD = 14; // outer margin
  const TIER_H = 30; // vertical space per callout tier
  const LABEL_GAP = 18; // gap from grid bottom to first bracket

  const SIDE_W = 130; // right gutter for sideLabels
  const gridW = $derived(cols * PITCH - GAP);
  const gridH = $derived(rows * PITCH - GAP);
  const maxTier = $derived(callouts.reduce((m, c) => Math.max(m, c.tier ?? 0), 0));
  const hasSide = $derived(sideLabels.length > 0);
  const W = $derived(gridW + PAD * 2 + (hasSide ? SIDE_W : 0));
  const H = $derived(gridH + PAD * 2 + LABEL_GAP + (maxTier + 1) * TIER_H + (caption ? 18 : 0));
  const cyRow = (row: number): number => PAD + row * PITCH + CELL / 2;

  // fast lookup of a cell's fill
  const fillAt = $derived.by(() => {
    const m = new Map<string, string>();
    for (const c of cells) m.set(`${c.x},${c.y}`, c.fill ?? '');
    return m;
  });
  function cellFill(x: number, y: number): string {
    return fillAt.get(`${x},${y}`) || '#2c2f36'; // dim default
  }

  const cx = (col: number): number => PAD + col * PITCH + CELL / 2;
  const colLeft = (col: number): number => PAD + col * PITCH;
  const colRight = (col: number): number => PAD + col * PITCH + CELL;
</script>

<figure class="grid-diagram">
  <svg viewBox="0 0 {W} {H}" width={W} height={H} role="img"
       aria-label={caption ?? 'grid layout diagram'}>
    <!-- frame (grid area only; the right gutter holds side-labels) -->
    <rect x="2" y="2" width={gridW + PAD * 2 - 4} height={gridH + PAD * 2 - 4} rx="10"
          fill="#1b1d22" stroke="#3a3d44" stroke-width="1" />
    <!-- pads -->
    {#each Array(rows) as _, y (y)}
      {#each Array(cols) as _, x (x)}
        <rect
          x={PAD + x * PITCH}
          y={PAD + y * PITCH}
          width={CELL}
          height={CELL}
          rx="6"
          fill={cellFill(x, y)}
        />
      {/each}
    {/each}

    <!-- callouts -->
    {#each callouts as c (c.label + c.fromCol)}
      {@const tier = c.tier ?? 0}
      {@const baseY = PAD + gridH + LABEL_GAP + tier * TIER_H}
      {@const lo = colLeft(c.fromCol)}
      {@const hi = colRight(c.toCol ?? c.fromCol)}
      {@const mid = (lo + hi) / 2}
      {#if (c.toCol ?? c.fromCol) > c.fromCol}
        <!-- group bracket -->
        <path
          d="M {lo} {baseY} v 6 H {hi} v -6 M {mid} {baseY + 6} v 6"
          fill="none"
          stroke={accent}
          stroke-width="1.5"
        />
        <text x={mid} y={baseY + 26} text-anchor="middle" class="lbl" fill={accent}
          >{c.label}</text
        >
      {:else}
        <!-- single tick -->
        <line x1={cx(c.fromCol)} y1={baseY} x2={cx(c.fromCol)} y2={baseY + 12}
              stroke={accent} stroke-width="1.5" />
        <text x={cx(c.fromCol)} y={baseY + 26} text-anchor="middle" class="lbl" fill={accent}
          >{c.label}</text
        >
      {/if}
    {/each}

    <!-- side labels (leader from a specific pad to the right gutter) -->
    {#each sideLabels as s (s.label)}
      {@const py = cyRow(s.atY)}
      {@const x0 = colRight(s.atX)}
      {@const gx = gridW + PAD * 2 + 6}
      <path d="M {x0} {py} h {gx - x0}" fill="none" stroke={accent} stroke-width="1.5" />
      <circle cx={x0} cy={py} r="2.5" fill={accent} />
      <text x={gx + 5} y={py + 4} class="lbl" fill={accent}>{s.label}</text>
    {/each}
  </svg>
  {#if caption}<figcaption>{caption}</figcaption>{/if}
</figure>

<style>
  .grid-diagram {
    margin: 1.25rem 0;
  }
  .grid-diagram svg {
    max-width: 100%;
    height: auto;
  }
  .lbl {
    font: 600 12px/1 ui-monospace, 'SF Mono', Menlo, monospace;
    letter-spacing: 0.04em;
  }
  figcaption {
    margin-top: 0.4rem;
    font-size: 0.8rem;
    color: var(--text-dim, #98a);
    font-style: italic;
  }
</style>
