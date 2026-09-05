<script lang="ts">
  // HueWheel — the RACKLINE HUE CELL for a CONTINUOUS 0..1 hue param.
  //
  // The fifth answer to "which primitive does this param get", and the second
  // colour one. It exists because `chroma` is an ANGLE, and an angle is the one
  // scalar shape a linear dial genuinely cannot present:
  //
  //   * A HUE WRAPS. 0.99 and 0.01 are adjacent reds. A KnobConic puts its end
  //     stops at an arbitrary point in the middle of a continuous space, so
  //     travelling between two neighbouring reds means dragging the whole way
  //     back across every other colour.
  //   * A HUE IS ITS OWN LEGEND. The wheel shows what each position IS, so it
  //     needs no caption under it to say `0.72` — which matters here, because
  //     the resting faceplate is not allowed to print one (see the resting-text
  //     ruling in CLAUDE.md and `face-resting-text-source.test.ts`).
  //
  // ⚠ IT IS NOT `ColorField`. That primitive is a native `<input type="color">`
  // over a DISCRETE packed-RGB param (0..0xffffff) and picks an arbitrary sRGB
  // triple. This is a CONTINUOUS 0..1 ring at full saturation. Handing a hue to
  // ColorField would collapse 16.7 million states onto two; handing a packed RGB
  // to this wheel would make one turn sweep the entire 24-bit space.
  // `module-face-lint` refuses each on the other's shape.
  //
  // ⚠ THE VISIBLE RING IS THE OPERABLE ELEMENT. The legacy SpirographsCard drew
  // a conic-gradient `<div>` and attached pointer handlers to it; that is kept,
  // rather than hiding an input under a decorative swatch, so "visible" and
  // "operable" are one element and one assertion (the ColorField argument).
  //
  // ⚠ NO PAINTED VALUE. The angle is carried by `aria-valuetext` — speakable,
  // assertable, unpainted — which is exactly where the resting-text ruling puts
  // a derived or live value. The MARKER on the ring is the visual readout.
  import { onDestroy } from 'svelte';

  interface Props {
    /** Current hue, 0..1. */
    value: number | undefined;
    /** Commit a new hue (`params.set(paramId)`). */
    onchange: (value: number) => void;
    /** The param's declared range, passed from the DEF and never re-typed here.
     *  A hue is 0..1 by contract (module-face-lint asserts it), but the clamp
     *  reads what it is handed so the two cannot drift. */
    min: number;
    max: number;
    /** Accessible name. Never painted by this component. */
    label: string;
    paramId: string;
    /** Live value reader (CV displacement). `chroma` HAS a cv jack on every
     *  adopter, so unlike ColorField this primitive genuinely needs one: without
     *  it a hue being swept by an LFO would sit still on screen. */
    readLive?: (() => number | undefined) | undefined;
    /** Bigger at the dock than in a lane column. */
    hero?: boolean;
  }

  let { value, onchange, min, max, label, paramId, readLive, hero = false }: Props = $props();

  const clamp = (h: number): number => Math.min(max, Math.max(min, h));

  /** The angle actually shown: the LIVE value when a reader is supplied and
   *  returns a number (CV displacement), else the durable param. */
  let live = $state<number | undefined>(undefined);
  let raf = 0;
  $effect(() => {
    if (!readLive) {
      live = undefined;
      return;
    }
    const tick = () => {
      live = readLive();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  });
  onDestroy(() => cancelAnimationFrame(raf));

  let shown = $derived(clamp(live ?? value ?? min));
  /** Degrees around the ring, from the top, clockwise. */
  let deg = $derived(((shown - min) / (max - min || 1)) * 360);

  let wheelEl: HTMLDivElement | null = $state(null);
  let dragging = $state(false);

  /** The hue under the pointer: the ANGLE from the ring's centre, normalised so
   *  0 is straight up and it increases clockwise — the same mapping the conic
   *  gradient paints, so the colour under the cursor is the colour committed. */
  function hueFromPointer(e: PointerEvent): number | null {
    const el = wheelEl;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2);
    const dy = e.clientY - (r.top + r.height / 2);
    if (dx === 0 && dy === 0) return null;
    const turns = (Math.atan2(dx, -dy) / (Math.PI * 2) + 1) % 1;
    return clamp(min + turns * (max - min));
  }

  function commit(e: PointerEvent): void {
    const h = hueFromPointer(e);
    if (h !== null) onchange(h);
  }

  function onPointerDown(e: PointerEvent): void {
    dragging = true;
    // Guarded for the same reason `controls/Button.svelte` is: a capture that
    // throws must not take the gesture with it. The call sits BEFORE the write
    // below, so an unguarded throw leaves `dragging` true and the pointer's own
    // position never applied — the control looks grabbed and does nothing.
    try { wheelEl?.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
    commit(e);
  }
  function onPointerMove(e: PointerEvent): void {
    if (dragging) commit(e);
  }
  function onPointerUp(e: PointerEvent): void {
    dragging = false;
    try {
      wheelEl?.releasePointerCapture(e.pointerId);
    } catch {
      /* the pointer was already released */
    }
  }
</script>

<!-- `role="slider"` because that is what it is — one continuous value over a
     declared range. The ROTATION is presentation; the semantics are a slider,
     which is what every existing face assertion reads. -->
<div
  class="hue-wheel"
  class:hero
  bind:this={wheelEl}
  data-testid={`control-${paramId}`}
  data-hue-wheel={paramId}
  role="slider"
  tabindex="-1"
  aria-label={label}
  aria-valuemin={min}
  aria-valuemax={max}
  aria-valuenow={shown}
  aria-valuetext={`${Math.round(deg)}°`}
  onpointerdown={onPointerDown}
  onpointermove={onPointerMove}
  onpointerup={onPointerUp}
  onpointercancel={onPointerUp}
>
  <div class="ring"></div>
  <div class="marker" style={`transform: rotate(${deg}deg)`}>
    <span class="dot" style={`background: hsl(${deg} 100% 50%)`}></span>
  </div>
</div>

<style>
  .hue-wheel {
    position: relative;
    width: 44px;
    height: 44px;
    flex: 0 0 auto;
    touch-action: none;
    cursor: crosshair;
  }
  .hue-wheel.hero {
    width: 64px;
    height: 64px;
  }
  /* The ring itself: a full-saturation conic sweep with the centre punched out,
     so the control reads as a colour WHEEL rather than a filled disc. */
  .ring {
    position: absolute;
    inset: 0;
    border-radius: 50%;
    background: conic-gradient(
      hsl(0 100% 50%),
      hsl(60 100% 50%),
      hsl(120 100% 50%),
      hsl(180 100% 50%),
      hsl(240 100% 50%),
      hsl(300 100% 50%),
      hsl(360 100% 50%)
    );
    -webkit-mask: radial-gradient(circle, transparent 52%, #000 54%);
    mask: radial-gradient(circle, transparent 52%, #000 54%);
  }
  /* The marker is rotated as a whole so the dot rides the ring; the dot itself
     carries the live colour, which is the visual readout that replaces a
     printed number. */
  .marker {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }
  .dot {
    position: absolute;
    top: -3px;
    left: 50%;
    width: 10px;
    height: 10px;
    margin-left: -5px;
    border-radius: 50%;
    border: 2px solid var(--panel, #0e1219);
    box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.55);
  }
</style>
