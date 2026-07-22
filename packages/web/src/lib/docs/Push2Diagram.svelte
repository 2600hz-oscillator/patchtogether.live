<script lang="ts">
  // Push2Diagram.svelte — an annotated Ableton Push 2 picture for the docs.
  // GEOMETRY VERIFIED against Ableton's official to-scale control map
  // (github.com/Ableton/push-interface — doc/MidiMapping.png + Push2-map.json).
  // Normalized 0..1 faceplate coordinates (top-left origin) taken off that
  // schematic, rendered into a 1.2:1 viewBox. Faithful placement:
  //   · 11 encoders across the TOP: Tempo, Swing (leftmost pair), 8 track
  //     encoders (above the display), Master (far right).
  //   · a row of 8 buttons ABOVE the display  = channel-select (CC 102–109).
  //   · the 960×160 display strip.
  //   · a row of 8 buttons BELOW the display   = the permanent-controls row
  //     (CC 20–27 → the Launchpad view/function top row).
  //   · the 8×8 pad grid (bottom-origin: note 36 = bottom-left, 99 = top-right).
  //   · the 8 SCENE-launch buttons down the RIGHT of the grid (CC 43 top … 36
  //     bottom).
  //   · the 4 ARROW / nav keys (CC 44–47) UPPER-RIGHT of the grid.
  //   · Play + Record in the bottom-LEFT transport column; the touch strip is
  //     the tall bar just left of the grid.
  // The caller (Push2Docs) feeds the LABELS (derived from the real push2-map CC
  // constants); the geometry lives here. Plain SVG, no deps.

  interface Pad {
    x: number; // 0..7 (col, left→right)
    y: number; // 0..7 PHYSICAL row from the BOTTOM
    fill: string;
  }
  interface Props {
    pads?: Pad[];
    /** 11 encoder labels, left→right: Tempo, Swing, V1..V8, Master. */
    encoderLabels?: string[];
    /** 8 above-display button labels (channel select), left→right. */
    upperLabels?: string[];
    /** 8 below-display button labels (permanent controls), left→right. */
    lowerLabels?: string[];
    /** 8 scene-launch labels, TOP→bottom. */
    sceneLabels?: string[];
    accent?: string;
    caption?: string;
  }
  let {
    pads = [],
    encoderLabels = [],
    upperLabels = [],
    lowerLabels = [],
    sceneLabels = [],
    accent = '#7a5cd6',
    caption,
  }: Props = $props();

  // viewBox — 1.2 : 1, matching the faceplate.
  const W = 600;
  const H = 500;
  const nx = (x: number): number => x * W;
  const ny = (y: number): number => y * H;

  const GRID_FILL = '#243044';
  const SEL_FILL = '#6f9bd6';
  const DIM = '#2a3040';
  const OFF = '#181a20';
  const STROKE = '#333844';

  // --- Encoder row (11): Tempo, Swing, V1..V8, Master. -----------------------
  const encX = [0.05, 0.14, 0.22, 0.29, 0.36, 0.44, 0.51, 0.59, 0.66, 0.74, 0.94];
  const encY = 0.05;
  const encR = 10;

  // --- Above-display buttons (channel select, CC 102–109). -------------------
  const rowX0 = 0.18;
  const rowX1 = 0.77;
  const btnW = ((rowX1 - rowX0) / 8) * W - 6;
  const upperY = 0.10;
  const lowerY = 0.335;
  const btnH = 16;
  const rowCx = (i: number): number => nx(rowX0 + ((rowX1 - rowX0) * (i + 0.5)) / 8);

  // --- Display strip. --------------------------------------------------------
  const dispX0 = 0.18, dispY0 = 0.16, dispX1 = 0.79, dispY1 = 0.30;

  // --- 8×8 grid. -------------------------------------------------------------
  const gX0 = 0.18, gY0 = 0.385, gX1 = 0.79, gY1 = 0.97;
  const cellW = ((gX1 - gX0) / 8) * W;
  const cellH = ((gY1 - gY0) / 8) * H;
  const padSize = Math.min(cellW, cellH) - 5;
  const gridLeftPx = nx(gX0);
  const gridTopPx = ny(gY0);
  const padX = (col: number): number => gridLeftPx + col * cellW + (cellW - padSize) / 2;
  const padY = (rowFromBottom: number): number => gridTopPx + (7 - rowFromBottom) * cellH + (cellH - padSize) / 2;

  // --- Scene-launch column (right of grid, CC 43 top … 36 bottom). -----------
  const sceneCx = 0.835;
  const sceneY = (i: number): number => gridTopPx + (i + 0.5) * cellH; // i=0 top

  // --- Arrow / nav cluster (CC 44–47) upper-right of the grid. ---------------
  const navCx = nx(0.945);
  const navCy = ny(0.40);
  const navR = 9;

  // --- Transport (Play / Record) bottom-left + touch strip. ------------------
  const leftCx = nx(0.045);
  const playCy = ny(0.94);
  const recCy = ny(0.88);
  const stripX = nx(0.09), stripY = ny(gY0), stripW = nx(0.13) - nx(0.09), stripH = ny(gY1) - ny(gY0);
</script>

<figure class="p2-diagram">
  <svg viewBox="0 0 {W} {H}" width={W} height={H} role="img" aria-label={caption ?? 'Push 2 layout'}>
    <!-- encoder row: Tempo, Swing, 8 track encoders, Master -->
    {#each encX as ex, i (i)}
      <circle cx={nx(ex)} cy={ny(encY)} r={encR} fill={DIM} stroke={STROKE} stroke-width="1" />
      {#if encoderLabels[i]}
        <text x={nx(ex)} y={ny(encY) - encR - 3} text-anchor="middle" class="lbl">{encoderLabels[i]}</text>
      {/if}
    {/each}

    <!-- above-display buttons = channel select (CC 102–109) -->
    {#each Array(8) as _, i (i)}
      <rect x={rowCx(i) - btnW / 2} y={ny(upperY)} width={btnW} height={btnH} rx="4"
            fill={i === 0 ? SEL_FILL : DIM} stroke={STROKE} stroke-width="0.75" />
      {#if upperLabels[i]}
        <text x={rowCx(i)} y={ny(upperY) - 3} text-anchor="middle" class="lbl">{upperLabels[i]}</text>
      {/if}
    {/each}

    <!-- 960×160 display -->
    <rect x={nx(dispX0)} y={ny(dispY0)} width={nx(dispX1) - nx(dispX0)} height={ny(dispY1) - ny(dispY0)}
          rx="4" fill="#0d1016" stroke={STROKE} stroke-width="1" />
    <text x={(nx(dispX0) + nx(dispX1)) / 2} y={(ny(dispY0) + ny(dispY1)) / 2 + 3} text-anchor="middle" class="disp">960 × 160 display · Phase 2</text>

    <!-- below-display buttons = permanent controls (CC 20–27) -->
    {#each Array(8) as _, i (i)}
      <rect x={rowCx(i) - btnW / 2} y={ny(lowerY)} width={btnW} height={btnH} rx="4" fill={DIM} stroke={STROKE} stroke-width="0.75" />
      {#if lowerLabels[i]}
        <text x={rowCx(i)} y={ny(lowerY) + btnH + 9} text-anchor="middle" class="lbl">{lowerLabels[i]}</text>
      {/if}
    {/each}

    <!-- touch strip (left of grid) -->
    <rect x={stripX} y={stripY} width={stripW} height={stripH} rx="3" fill={OFF} stroke={STROKE} stroke-width="0.75" />

    <!-- left transport column: Record + Play at the bottom-left -->
    <circle cx={leftCx} cy={recCy} r={11} fill="#7a2222" stroke={STROKE} stroke-width="1" />
    <text x={leftCx} y={recCy + 3} text-anchor="middle" class="mini">REC</text>
    <circle cx={leftCx} cy={playCy} r={12} fill="#1f7a34" stroke={STROKE} stroke-width="1" />
    <text x={leftCx} y={playCy + 3} text-anchor="middle" class="mini">▶</text>

    <!-- 8×8 grid -->
    {#each Array(8) as _, rowFromBottom (rowFromBottom)}
      {#each Array(8) as _, col (col)}
        {@const p = pads.find((q) => q.x === col && q.y === rowFromBottom)}
        <rect x={padX(col)} y={padY(rowFromBottom)} width={padSize} height={padSize} rx="5" fill={p?.fill || GRID_FILL} />
      {/each}
    {/each}

    <!-- scene-launch column (right of grid) -->
    {#each Array(8) as _, i (i)}
      <rect x={nx(sceneCx) - padSize / 2} y={sceneY(i) - btnH / 2} width={padSize} height={btnH} rx="4"
            fill={DIM} stroke={STROKE} stroke-width="0.75" />
      {#if sceneLabels[i]}
        <text x={nx(sceneCx) + padSize / 2 + 4} y={sceneY(i) + 3} text-anchor="start" class="mini">{sceneLabels[i]}</text>
      {/if}
    {/each}

    <!-- arrow / nav cluster (CC 44–47) upper-right of the grid -->
    <g class="nav">
      <rect x={navCx - navR / 2} y={navCy - navR * 2} width={navR} height={navR} rx="2" fill={accent} opacity="0.55" />
      <rect x={navCx - navR / 2} y={navCy + navR} width={navR} height={navR} rx="2" fill={accent} opacity="0.55" />
      <rect x={navCx - navR * 2} y={navCy - navR / 2} width={navR} height={navR} rx="2" fill={accent} opacity="0.55" />
      <rect x={navCx + navR} y={navCy - navR / 2} width={navR} height={navR} rx="2" fill={accent} opacity="0.55" />
      <text x={navCx} y={navCy - navR * 2 - 4} text-anchor="middle" class="mini" fill={accent}>NAV</text>
    </g>
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
  .lbl {
    font: 600 8px/1 ui-monospace, 'SF Mono', Menlo, monospace;
    fill: #cdd2de;
    letter-spacing: 0.02em;
  }
  .mini {
    font: 600 7px/1 ui-monospace, 'SF Mono', Menlo, monospace;
    fill: #cdd2de;
  }
  .disp {
    font: 600 9px/1 ui-monospace, 'SF Mono', Menlo, monospace;
    fill: #5a6478;
  }
  figcaption {
    margin-top: 0.4rem;
    font-size: 0.82rem;
    color: var(--muted, #98a);
    font-style: italic;
  }
</style>
