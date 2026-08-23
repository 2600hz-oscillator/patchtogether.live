<script lang="ts">
  // PongCourtGlyph — pong's LANE IDENTITY PICTURE, filling the shell's glyph
  // slot through the extension seam (`pongDef.face.extension: 'pong'` → the
  // `glyph` slot → `binding.layoutSource === 'pong'`).
  //
  // A THIN renderer over `pong-glyph-model`, exactly as `Dx7AlgorithmGlyph` is a
  // thin renderer over `dx7-glyph-model`: all the arithmetic — and therefore
  // every way this picture can be wrong — lives in the pure model and is pinned
  // by its sibling spec. This file only turns numbers into elements.
  //
  // Scales by `viewBox` alone (the shell gives the plate a 40 px lane / 64 px
  // dock height and a fluid width), and takes its colour from `currentColor` so
  // the caller owns it — the shell passes the module's spine colour, which keeps
  // this correct in both themes without the component knowing which is active.
  //
  // ⚠ WHY THE STATE IS THE REST STATE AND NOT THE LIVE GAME. The glyph slot's
  // props are `{ num, numbers?, testid? }` — there is no `nodeId`, so this
  // component cannot resolve a graph node and cannot call
  // `eng.read(node, 'snapshot')`. That is a property of the seam, not an
  // oversight here, and it is the right seam: a glyph is an IDENTITY picture
  // repeated across every tile in a rack, while the LIVE court is the dock
  // `fullViewBody` (`PongCourtBody.svelte`), which does get a `nodeId` and does
  // read the snapshot every frame. So this draws pong's own `initPongState` —
  // ball centred, both paddles centred — which is the exact frame the game
  // shows at rest, sourced from the module's law rather than typed in here.
  //
  // ⚠ `num` IS ACCEPTED AND UNUSED, DELIBERATELY. The slot's contract passes the
  // bound topology param's value, but pong's binding resolves `paramId: null`
  // (its layout source is this extension, not a param), so the shell passes 0
  // and there is nothing for a caption to say. Declaring the prop keeps the
  // component assignable to `Component<ShellExtensionGlyphProps>`; using it
  // would be inventing a meaning the binding explicitly does not carry.

  import { initPongState } from '$lib/audio/modules/pong-state';
  import { pongDef } from '$lib/audio/modules/pong';
  import { paramSpec } from '../card-kit';
  import { pongGlyphGeometry } from './pong-glyph-model';

  interface Props {
    /** The bound topology param's value — see the note above: pong has none. */
    num?: number;
    /** Part of the slot contract (dx7's operator numbers). This glyph paints no
     *  text at any size, so it has nothing to turn off. */
    numbers?: boolean;
    testid?: string;
  }

  let { testid }: Props = $props();

  const pSpeed = paramSpec(pongDef, 'speed');
  const pPaddleH = paramSpec(pongDef, 'paddleH');
  const pServeAngle = paramSpec(pongDef, 'serveAngle');

  // The module's OWN rest frame. `rng: () => 0.5` makes the call total and
  // repeatable; it only picks the serve VELOCITY, which this picture does not
  // draw, so the geometry is identical for any rng.
  const geom = pongGlyphGeometry(
    initPongState(
      {
        speed: pSpeed.defaultValue as number,
        paddleH: pPaddleH.defaultValue as number,
        serveAngle: pServeAngle.defaultValue as number,
      },
      { rng: () => 0.5 },
    ),
    pPaddleH.defaultValue as number,
  );
</script>

<svg
  class="pong-court"
  viewBox={geom.viewBox}
  preserveAspectRatio="xMidYMid meet"
  role="img"
  aria-label="pong court"
  data-testid={testid}
>
  <!-- The court outline first, so the paddles sit ON its walls. -->
  <rect
    class="court"
    x={geom.court.x}
    y={geom.court.y}
    width={geom.court.w}
    height={geom.court.h}
    rx="2"
  />

  <line
    class="net"
    x1={geom.net.x}
    y1={geom.net.y1}
    x2={geom.net.x}
    y2={geom.net.y2}
    stroke-dasharray={geom.net.dashArray}
  />

  {#each geom.paddles as p, i (i)}
    <rect class="paddle" x={p.x} y={p.y} width={p.w} height={p.h} rx="1" />
  {/each}

  <rect
    class="ball"
    x={geom.ball.x}
    y={geom.ball.y}
    width={geom.ball.size}
    height={geom.ball.size}
  />
</svg>

<style>
  .pong-court {
    display: block;
    width: 100%;
    height: 100%;
  }

  /* The walls are the quietest mark — they frame the picture without competing
     with the two paddles and the ball, which are what say "pong". */
  .court {
    fill: none;
    stroke: currentColor;
    stroke-width: 1;
    opacity: 0.4;
  }

  .net {
    stroke: currentColor;
    stroke-width: 1;
    opacity: 0.55;
  }

  /* Solid, like `drawPong`'s filled rects — the play pieces are the signal. */
  .paddle,
  .ball {
    fill: currentColor;
  }
</style>
