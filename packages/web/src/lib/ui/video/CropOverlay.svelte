<script lang="ts">
  // CropOverlay — the REUSABLE crop-editing overlay for video modules. Draws a
  // resizable, aspect-locked rectangle (thin RED border, dimmed outside) over a
  // module's on-card video screen; drag inside = move, drag a corner = resize
  // (aspect stays locked). Mirrors MappyEditor.svelte's ONE-SVG-owns-pointer-down
  // hit-test pattern, but for a single aspect-locked RECT rather than free quads.
  //
  // Module-agnostic: the parent passes the current rect + the output aspect and
  // an onchange callback; the overlay owns none of the persistence (the card
  // writes node.data.crop through the Yjs in-place discipline). All geometry
  // math lives in $lib/video/crop-core (pure + unit-tested), so the rect the
  // overlay RENDERS is exactly the stored normalized rect (UI-can't-lie).

  import {
    resolveCrop,
    resizeCropCorner,
    translateCrop,
    type CropRect,
    type CropCorner,
  } from '$lib/video/crop-core';

  let {
    rect,
    aspect,
    onchange,
  }: {
    /** Current stored crop rect (normalized, top-left origin, y-down). */
    rect: CropRect;
    /** Output aspect (width / height). The stage renders at this aspect so the
     *  aspect-locked rect looks like the output on screen; the crop samples the
     *  module's own output frame, so frame aspect === region aspect === this. */
    aspect: number;
    /** Called with a new (already-fitted) rect on every move/resize step. */
    onchange: (next: CropRect) => void;
  } = $props();

  // The rect resolved to explicit edges + derived height — what we draw.
  let resolved = $derived(resolveCrop(rect, aspect, aspect));

  // Corner grab radius in normalized space (Euclidean). Generous so the handles
  // are easy to grab; corners win over interior-move (below).
  const GRAB = 0.07;

  let svgEl: SVGSVGElement | null = $state(null);
  let drag = $state<
    | { kind: 'corner'; corner: CropCorner }
    | { kind: 'move'; lastX: number; lastY: number }
    | null
  >(null);

  function uvFromPointer(ev: PointerEvent): { x: number; y: number } | null {
    if (!svgEl) return null;
    const r = svgEl.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    return {
      x: (ev.clientX - r.left) / r.width,
      y: (ev.clientY - r.top) / r.height, // y-DOWN, matches the stored rect
    };
  }

  /** The four corners of the live rect in normalized space (0=TL,1=TR,2=BR,3=BL). */
  function corners(): Array<[number, number]> {
    const { x, y, w, h } = resolved;
    return [
      [x, y],
      [x + w, y],
      [x + w, y + h],
      [x, y + h],
    ];
  }

  function nearestCorner(px: number, py: number): CropCorner | null {
    let best: CropCorner | null = null;
    let bestD2 = GRAB * GRAB;
    const cs = corners();
    for (let i = 0; i < 4; i++) {
      const dx = cs[i]![0] - px;
      const dy = cs[i]![1] - py;
      const d2 = dx * dx + dy * dy;
      if (d2 <= bestD2) {
        bestD2 = d2;
        best = i as CropCorner;
      }
    }
    return best;
  }

  function insideRect(px: number, py: number): boolean {
    const { x, y, w, h } = resolved;
    return px >= x && px <= x + w && py >= y && py <= y + h;
  }

  function onDown(ev: PointerEvent): void {
    if (ev.button !== 0) return;
    const uv = uvFromPointer(ev);
    if (!uv) return;
    const corner = nearestCorner(uv.x, uv.y);
    if (corner !== null) {
      drag = { kind: 'corner', corner };
    } else if (insideRect(uv.x, uv.y)) {
      drag = { kind: 'move', lastX: uv.x, lastY: uv.y };
    } else {
      return; // empty space — ignore (don't leak to canvas pan/zoom)
    }
    svgEl?.setPointerCapture?.(ev.pointerId);
    ev.preventDefault();
    ev.stopPropagation();
  }

  function onMove(ev: PointerEvent): void {
    if (!drag) return;
    const uv = uvFromPointer(ev);
    if (!uv) return;
    if (drag.kind === 'corner') {
      onchange(resizeCropCorner(rect, resolved.h, drag.corner, uv.x, aspect, aspect));
    } else {
      onchange(translateCrop(rect, uv.x - drag.lastX, uv.y - drag.lastY, aspect, aspect));
      drag.lastX = uv.x;
      drag.lastY = uv.y;
    }
    ev.preventDefault();
    ev.stopPropagation();
  }

  function onUp(ev: PointerEvent): void {
    if (!drag) return;
    try { svgEl?.releasePointerCapture?.(ev.pointerId); } catch { /* */ }
    drag = null;
  }

  // Handle marker half-size (normalized). Purely visual — the SVG owns the
  // pointer hit-test (grab radius above), so distortion from the stretched
  // viewBox doesn't affect grabbing.
  const HS = 0.022;
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="crop-stage nodrag nowheel" style="aspect-ratio: {aspect};" data-testid="crop-overlay">
  <svg
    bind:this={svgEl}
    viewBox="0 0 1 1"
    preserveAspectRatio="none"
    onpointerdown={onDown}
    onpointermove={onMove}
    onpointerup={onUp}
    onpointercancel={onUp}
    data-testid="crop-overlay-svg"
  >
    <!-- Dim everything OUTSIDE the crop rect (four bands). -->
    <rect class="dim" x="0" y="0" width="1" height={resolved.y} />
    <rect class="dim" x="0" y={resolved.y + resolved.h} width="1" height={Math.max(0, 1 - (resolved.y + resolved.h))} />
    <rect class="dim" x="0" y={resolved.y} width={resolved.x} height={resolved.h} />
    <rect class="dim" x={resolved.x + resolved.w} y={resolved.y} width={Math.max(0, 1 - (resolved.x + resolved.w))} height={resolved.h} />

    <!-- The crop rectangle — thin RED border. UI-can't-lie: x/y/width/height
         are EXACTLY the resolved (stored) normalized rect. -->
    <rect
      class="crop-rect"
      x={resolved.x}
      y={resolved.y}
      width={resolved.w}
      height={resolved.h}
      data-testid="crop-rect"
      data-x={resolved.x}
      data-y={resolved.y}
      data-w={resolved.w}
      data-h={resolved.h}
    />

    <!-- Corner handles (visual). -->
    {#each corners() as c, i (i)}
      <rect
        class="handle"
        x={c[0] - HS}
        y={c[1] - HS}
        width={HS * 2}
        height={HS * 2}
        data-testid={`crop-handle-${i}`}
      />
    {/each}
  </svg>
</div>

<style>
  .crop-stage {
    position: absolute;
    inset: 0;
    margin: auto;
    max-width: 100%;
    max-height: 100%;
    z-index: 7;
    /* the stage is sized to the OUTPUT aspect and centered within the preview,
       so the aspect-locked rect reads as the output shape (pillar/letterbox
       matching how the output frame sits in the preview). */
  }
  svg {
    width: 100%;
    height: 100%;
    display: block;
    touch-action: none;
    cursor: move;
  }
  .dim {
    fill: rgba(4, 6, 8, 0.5);
    pointer-events: none;
  }
  .crop-rect {
    fill: none;
    stroke: #ff3b3b;
    stroke-width: 2;
    vector-effect: non-scaling-stroke;
    pointer-events: none;
  }
  .handle {
    fill: #ff3b3b;
    stroke: #000;
    stroke-width: 1;
    vector-effect: non-scaling-stroke;
    pointer-events: none;
  }
</style>
