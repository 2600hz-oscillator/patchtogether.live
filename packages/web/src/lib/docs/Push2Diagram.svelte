<script lang="ts">
  // Push2Diagram.svelte — an annotated Ableton Push 2 picture for the docs.
  // Faithful to the hardware shape: a top row of 8 round display buttons, a row
  // of 11 encoder circles, the 8×8 pad grid, a D-Pad cluster to the left, and a
  // Play button. Plain SVG computed from DATA (same idea as LaunchpadDiagram /
  // GridDiagram) — the caller (Push2Docs) feeds it labels derived from the REAL
  // push2-map CC constants, so the picture cannot drift from the code. The 8×8
  // uses the device's BOTTOM-origin y (row 0 = bottom), matching the hardware.

  interface Pad {
    x: number; // 0..7 (col)
    y: number; // 0..7 PHYSICAL row from the BOTTOM
    fill: string;
    label?: string;
  }
  interface TopBtn {
    col: number; // 0..7
    fill: string;
    label?: string; // short label above (e.g. "CH1")
  }
  interface Encoder {
    col: number; // 0..10 (0 = Tempo … 10 = Master)
    fill: string;
    label?: string;
  }
  interface Props {
    pads?: Pad[];
    top?: TopBtn[];
    encoders?: Encoder[];
    playLabel?: string;
    dpadLabel?: string;
    accent?: string;
    caption?: string;
  }
  let {
    pads = [],
    top = [],
    encoders = [],
    playLabel,
    dpadLabel,
    accent = '#7a5cd6',
    caption,
  }: Props = $props();

  const N = 8;
  const CELL = 28;
  const GAP = 6;
  const PITCH = CELL + GAP;
  const PAD = 16;
  const ENC_R = 11;
  const LABEL_H = 15;
  const ROW_GAP = 14;

  const OFF = '#181a20';

  // Layout tiers (top → bottom): encoder row, top-button row, then the grid with
  // the D-Pad + Play to its left.
  const encY = PAD + LABEL_H + ENC_R;
  const topRowY = encY + ENC_R + ROW_GAP + LABEL_H;
  const gridTop = topRowY + CELL + ROW_GAP;
  const gridH = N * PITCH - GAP;

  const leftGutter = 54; // room for the D-Pad + Play to the left of the grid
  const gridLeft = PAD + leftGutter;

  const W = gridLeft + N * PITCH - GAP + PAD;
  const H = gridTop + gridH + PAD + (caption ? 18 : 0);

  const svgRow = (y: number): number => N - 1 - y;
  const colX = (c: number): number => gridLeft + c * PITCH;
  const colCx = (c: number): number => gridLeft + c * PITCH + CELL / 2;
  // 11 encoders spread across the grid width.
  const encCx = (c: number): number => gridLeft + (c / 10) * (N * PITCH - GAP - CELL) + CELL / 2;
  const dpadCx = PAD + leftGutter / 2 - 6;
  const dpadCy = gridTop + gridH * 0.32;
  const playCy = gridTop + gridH * 0.72;
</script>

<figure class="p2-diagram">
  <svg viewBox="0 0 {W} {H}" width={W} height={H} role="img" aria-label={caption ?? 'Push 2 layout'}>
    <!-- encoder row (11 small circles) -->
    {#each encoders as e (e.col)}
      <circle cx={encCx(e.col)} cy={encY} r={ENC_R} fill={e.fill || OFF} stroke="#333844" stroke-width="1" />
      {#if e.label}
        <text x={encCx(e.col)} y={encY - ENC_R - 3} text-anchor="middle" class="enc-lbl">{e.label}</text>
      {/if}
    {/each}

    <!-- top display-button row (8 round buttons = channel select) -->
    {#each top as b (b.col)}
      <rect x={colX(b.col)} y={topRowY} width={CELL} height={CELL} rx={CELL / 2} fill={b.fill || OFF} />
      {#if b.label}
        <text x={colCx(b.col)} y={topRowY - 4} text-anchor="middle" class="top-lbl">{b.label}</text>
      {/if}
    {/each}

    <!-- D-Pad cluster + Play, to the left of the grid -->
    <g class="dpad">
      <rect x={dpadCx - 8} y={dpadCy - 22} width={16} height={16} rx="3" fill={accent} opacity="0.5" />
      <rect x={dpadCx - 8} y={dpadCy + 6} width={16} height={16} rx="3" fill={accent} opacity="0.5" />
      <rect x={dpadCx - 24} y={dpadCy - 8} width={16} height={16} rx="3" fill={accent} opacity="0.5" />
      <rect x={dpadCx + 8} y={dpadCy - 8} width={16} height={16} rx="3" fill={accent} opacity="0.5" />
      {#if dpadLabel}
        <text x={dpadCx} y={dpadCy + 38} text-anchor="middle" class="side-lbl" fill={accent}>{dpadLabel}</text>
      {/if}
    </g>
    <g class="play">
      <circle cx={dpadCx} cy={playCy} r={13} fill="#1f7a34" />
      {#if playLabel}
        <text x={dpadCx} y={playCy + 26} text-anchor="middle" class="side-lbl" fill={accent}>{playLabel}</text>
      {/if}
    </g>

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
  </svg>
  {#if caption}<figcaption>{caption}</figcaption>{/if}
</figure>

<style>
  .p2-diagram {
    margin: 1rem 0 1.4rem;
  }
  .p2-diagram svg {
    max-width: 100%;
    height: auto;
  }
  .top-lbl,
  .enc-lbl,
  .pad-lbl {
    font: 600 8px/1 ui-monospace, 'SF Mono', Menlo, monospace;
    fill: #cdd2de;
    letter-spacing: 0.02em;
  }
  .pad-lbl {
    fill: #0c0e12;
  }
  .side-lbl {
    font: 600 10px/1 ui-monospace, 'SF Mono', Menlo, monospace;
    letter-spacing: 0.03em;
  }
  figcaption {
    margin-top: 0.4rem;
    font-size: 0.82rem;
    color: var(--muted, #98a);
    font-style: italic;
  }
</style>
