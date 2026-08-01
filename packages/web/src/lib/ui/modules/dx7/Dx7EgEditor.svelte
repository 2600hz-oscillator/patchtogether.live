<script lang="ts">
  // Dx7EgEditor — the draggable 4-point operator envelope (dx7 PR 6).
  //
  // GEOMETRY, not seconds. Y = LEVEL 0..99. X = the RATE of the segment
  // ARRIVING at that point, mapped `x = (99 - rate) / 99` — so dragging RIGHT
  // makes a segment SLOWER. Never plot seconds: rate 0 is 317 s, which would
  // make the first segment 300x wider than the rest and the editor unusable.
  //
  // GHOST CURVES: the other five operators draw faintly behind the active one.
  // That is the single FM8 property the map's 20x12 thumbnails cannot deliver
  // — cross-operator envelope comparison WHILE editing — and it costs ~10 LOC.

  import { dx7EgCurve, dx7WidthToRate } from '$lib/audio/dx7-eg-curve';

  interface Props {
    /** The active operator's four rates + four levels. */
    r: readonly number[];
    l: readonly number[];
    /** The other operators, drawn as ghosts. */
    ghosts?: { r: readonly number[]; l: readonly number[]; level: number }[];
    /** Commit one edited handle. `index` is 0..3 (the R1/L1 .. R4/L4 pairs). */
    oncommit: (index: number, rate: number, level: number) => void;
  }

  let { r, l, ghosts = [], oncommit }: Props = $props();

  const W = 240;
  const H = 90;
  const PAD = 8;

  // Unscaled shape (outputLevel 99) — the editor edits the ENVELOPE, and
  // scaling it by output level here would make the handles disagree with the
  // numbers underneath.
  let curve = $derived(dx7EgCurve(r, l, 99));
  let maxX = $derived(Math.max(...curve.points.map((p) => p.x), 1e-6));

  const px = (x: number) => PAD + (x / maxX) * (W - PAD * 2);
  const py = (y: number) => H - PAD - y * (H - PAD * 2);

  let pts = $derived(curve.points.map((p) => ({ ...p, px: px(p.x), py: py(p.y) })));
  let poly = $derived(pts.map((p) => `${p.px},${p.py}`).join(' '));

  let dragging = $state<number | null>(null);
  let svgEl = $state<SVGSVGElement | null>(null);

  function ghostPoly(g: { r: readonly number[]; l: readonly number[] }): string {
    const c = dx7EgCurve(g.r, g.l, 99);
    const m = Math.max(...c.points.map((p) => p.x), 1e-6);
    return c.points.map((p) => `${PAD + (p.x / m) * (W - PAD * 2)},${py(p.y)}`).join(' ');
  }

  function onPointerDown(e: PointerEvent, index: number) {
    if (index < 0) return; // the two undraggable points
    dragging = index;
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    e.stopPropagation();
    e.preventDefault();
  }

  function onPointerMove(e: PointerEvent) {
    if (dragging === null || !svgEl) return;
    const rect = svgEl.getBoundingClientRect();
    // Map client px → viewBox units. The SVG scales, so a raw pixel delta
    // would move the handle by the wrong amount at any width but one.
    const vx = ((e.clientX - rect.left) / rect.width) * W;
    const vy = ((e.clientY - rect.top) / rect.height) * H;

    const level = clamp(Math.round(((H - PAD - vy) / (H - PAD * 2)) * 99), 0, 99);

    // X is CUMULATIVE across segments, so this handle's own segment width is
    // the distance from the PREVIOUS DRAWN POINT — not its absolute x. The
    // draw order is [L4 start, L1, L2, L3, hold end, L4 end], so a handle's
    // predecessor is simply the entry before it in that array; deriving it
    // from the handle index instead would skip the hold plateau and make R4
    // measure from the wrong place.
    const pos = pts.findIndex((p) => p.index === dragging);
    const prevPx = pos > 0 ? pts[pos - 1]!.px : PAD;
    const widthUnits = ((clamp(vx, prevPx, W - PAD) - prevPx) / (W - PAD * 2)) * maxX;
    const rate = clamp(Math.round(dx7WidthToRate(Math.max(widthUnits, 0))), 0, 99);

    oncommit(dragging, rate, level);
  }

  function onPointerUp(e: PointerEvent) {
    if (dragging === null) return;
    (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
    dragging = null;
  }

  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
</script>

<svg
  bind:this={svgEl}
  class="eg"
  viewBox="0 0 {W} {H}"
  preserveAspectRatio="none"
  data-testid="dx7-eg-editor"
  role="group"
  aria-label="operator envelope"
  onpointermove={onPointerMove}
  onpointerup={onPointerUp}
  onpointercancel={onPointerUp}
>
  <!-- GHOSTS first, so the active curve always wins the z-order. -->
  {#each ghosts as g, i (i)}
    <polyline class="ghost" points={ghostPoly(g)} />
  {/each}

  <polyline class="curve" points={poly} />

  {#each pts as p, i (i)}
    {#if p.index >= 0}
      <circle
        class="handle"
        class:active={dragging === p.index}
        cx={p.px}
        cy={p.py}
        r="5"
        role="slider"
        tabindex="0"
        aria-label="envelope point {p.index + 1}"
        aria-valuenow={p.level}
        aria-valuemin="0"
        aria-valuemax="99"
        data-testid="dx7-eg-point-{p.index + 1}"
        onpointerdown={(e) => onPointerDown(e, p.index)}
        onkeydown={(e) => {
          const step = e.shiftKey ? 10 : 1;
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            oncommit(p.index, r[p.index] ?? 0, clamp((l[p.index] ?? 0) + (e.key === 'ArrowUp' ? step : -step), 0, 99));
          } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            e.preventDefault();
            // RIGHT = slower = LOWER rate byte. Inverting this is the easiest
            // way to make the editor feel backwards.
            oncommit(p.index, clamp((r[p.index] ?? 0) + (e.key === 'ArrowRight' ? -step : step), 0, 99), l[p.index] ?? 0);
          }
        }}
      />
    {/if}
  {/each}
</svg>

<style>
  .eg {
    display: block;
    width: 100%;
    height: 90px;
    background: var(--module-bg-deep, #0a0c0f);
    border: 1px solid var(--border, #2c3037);
    border-radius: 3px;
    touch-action: none;
  }
  .curve {
    fill: none;
    stroke: var(--accent, #6cf);
    stroke-width: 1.6;
    vector-effect: non-scaling-stroke;
  }
  .ghost {
    fill: none;
    stroke: var(--text-dim, #8a9099);
    stroke-width: 1;
    opacity: 0.22;
    vector-effect: non-scaling-stroke;
  }
  .handle {
    fill: var(--module-bg, #14171c);
    stroke: var(--accent, #6cf);
    stroke-width: 1.6;
    cursor: grab;
    vector-effect: non-scaling-stroke;
  }
  .handle.active,
  .handle:hover {
    fill: var(--accent, #6cf);
  }
</style>
