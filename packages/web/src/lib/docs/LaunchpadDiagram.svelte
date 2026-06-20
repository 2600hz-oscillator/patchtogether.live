<script lang="ts">
  // LaunchpadDiagram.svelte — an annotated Launchpad Mini Mk3 picture for the
  // docs. Faithful to the hardware shape: a top row of 8 round CC buttons, the
  // 8×8 pad grid, and a right column of 8 round scene CC buttons — each
  // colour-able + label-able. Plain SVG computed from data (same idea as
  // GridDiagram), so it stays in sync with the code that feeds it and themes
  // cleanly. The 8×8 uses the device's BOTTOM-origin y (row 0 = bottom), so the
  // picture matches what you see on the unit.
  //
  // Callouts (labelled ticks/brackets BELOW the grid) name the command-deck
  // function columns the way the monome manual does; top labels sit above the
  // top CC row; scene labels sit to the right of the scene column.

  interface Pad {
    x: number; // 0..7 (col / slot / step)
    y: number; // 0..7 PHYSICAL row from the BOTTOM (the L matrix flips lane→row
               // so lane 1 lands on the TOP row to match the on-screen card)
    fill: string; // any CSS colour
    label?: string; // tiny in-pad glyph (e.g. a number)
  }
  interface TopBtn {
    col: number; // 0..7
    fill: string;
    label?: string; // short glyph above (▲ ▼ ◀ ▶ etc.)
  }
  interface SceneBtn {
    row: number; // 0..7 from the BOTTOM
    fill: string;
    label?: string; // short label to the right
  }
  interface Callout {
    label: string;
    fromCol: number;
    toCol?: number;
    tier?: number;
  }

  interface Props {
    pads?: Pad[];
    top?: TopBtn[];
    scene?: SceneBtn[];
    callouts?: Callout[];
    accent?: string;
    caption?: string;
  }
  let {
    pads = [],
    top = [],
    scene = [],
    callouts = [],
    accent = '#c0392b',
    caption,
  }: Props = $props();

  const N = 8;
  const CELL = 28;
  const GAP = 6;
  const PITCH = CELL + GAP;
  const PAD = 16;
  const TOP_LABEL_H = 16; // room above the top CC row for its labels
  const TOP_GAP = 12; // between the top row and the grid
  const SCENE_GAP = 12; // between the grid and the scene column
  const SCENE_LABEL_W = 72; // right gutter for scene labels
  const LABEL_GAP = 16; // grid bottom → first callout tier
  const TIER_H = 28;

  const OFF = '#181a20'; // an unlit pad (visible outline, clearly dark)

  const topRowY = PAD + TOP_LABEL_H;
  const gridTop = topRowY + CELL + TOP_GAP;
  const sceneX = PAD + N * PITCH + SCENE_GAP;
  const gridH = N * PITCH - GAP;

  const maxTier = $derived(callouts.reduce((m, c) => Math.max(m, c.tier ?? 0), 0));
  const W = $derived(sceneX + CELL + SCENE_LABEL_W + PAD);
  const H = $derived(
    gridTop + gridH + LABEL_GAP + (callouts.length ? (maxTier + 1) * TIER_H : 0) + (caption ? 18 : 0) + 6,
  );

  // bottom-origin y → SVG row (0 = top)
  const svgRow = (y: number): number => N - 1 - y;
  const colX = (c: number): number => PAD + c * PITCH;
  const colCx = (c: number): number => PAD + c * PITCH + CELL / 2;
  const gridY = (y: number): number => gridTop + svgRow(y) * PITCH;
  const gridCy = (y: number): number => gridY(y) + CELL / 2;
</script>

<figure class="lp-diagram">
  <svg viewBox="0 0 {W} {H}" width={W} height={H} role="img" aria-label={caption ?? 'Launchpad layout'}>
    <!-- top CC row (rounded = round buttons on the hardware) -->
    {#each top as b (b.col)}
      <rect x={colX(b.col)} y={topRowY} width={CELL} height={CELL} rx={CELL / 2} fill={b.fill || OFF} />
      {#if b.label}
        <text x={colCx(b.col)} y={topRowY - 4} text-anchor="middle" class="top-lbl">{b.label}</text>
      {/if}
    {/each}

    <!-- 8×8 grid -->
    {#each Array(N) as _, yy (yy)}
      {#each Array(N) as _, xx (xx)}
        {@const p = pads.find((q) => q.x === xx && q.y === yy)}
        <rect x={colX(xx)} y={gridTop + svgRow(yy) * PITCH} width={CELL} height={CELL} rx="6" fill={p?.fill || OFF} />
        {#if p?.label}
          <text x={colCx(xx)} y={gridTop + svgRow(yy) * PITCH + CELL / 2 + 4} text-anchor="middle" class="pad-lbl">{p.label}</text>
        {/if}
      {/each}
    {/each}

    <!-- right scene column (round buttons) + labels -->
    {#each scene as s (s.row)}
      <rect x={sceneX} y={gridY(s.row)} width={CELL} height={CELL} rx={CELL / 2} fill={s.fill || OFF} />
      {#if s.label}
        <text x={sceneX + CELL + 6} y={gridCy(s.row) + 4} class="scene-lbl" fill={accent}>{s.label}</text>
      {/if}
    {/each}

    <!-- callouts below the grid (deck function columns) -->
    {#each callouts as c (c.label + c.fromCol)}
      {@const tier = c.tier ?? 0}
      {@const baseY = gridTop + gridH + LABEL_GAP + tier * TIER_H}
      {@const lo = colX(c.fromCol)}
      {@const hi = colX(c.toCol ?? c.fromCol) + CELL}
      {@const mid = (lo + hi) / 2}
      {#if (c.toCol ?? c.fromCol) > c.fromCol}
        <path d="M {lo} {baseY} v 6 H {hi} v -6 M {mid} {baseY + 6} v 6" fill="none" stroke={accent} stroke-width="1.5" />
        <text x={mid} y={baseY + 24} text-anchor="middle" class="call-lbl" fill={accent}>{c.label}</text>
      {:else}
        <line x1={colCx(c.fromCol)} y1={baseY} x2={colCx(c.fromCol)} y2={baseY + 11} stroke={accent} stroke-width="1.5" />
        <text x={colCx(c.fromCol)} y={baseY + 24} text-anchor="middle" class="call-lbl" fill={accent}>{c.label}</text>
      {/if}
    {/each}
  </svg>
  {#if caption}<figcaption>{caption}</figcaption>{/if}
</figure>

<style>
  .lp-diagram {
    margin: 1rem 0 1.4rem;
  }
  .lp-diagram svg {
    max-width: 100%;
    height: auto;
  }
  .top-lbl,
  .pad-lbl {
    font: 600 9px/1 ui-monospace, 'SF Mono', Menlo, monospace;
    fill: #cdd2de;
    letter-spacing: 0.02em;
  }
  .pad-lbl {
    fill: #0c0e12;
  }
  .scene-lbl,
  .call-lbl {
    font: 600 11px/1 ui-monospace, 'SF Mono', Menlo, monospace;
    letter-spacing: 0.03em;
  }
  figcaption {
    margin-top: 0.4rem;
    font-size: 0.82rem;
    color: var(--muted, #98a);
    font-style: italic;
  }
</style>
