<script lang="ts">
  // WavesculptRoomPanel — the faceplate's HERO: the room, seen from above.
  //
  // ⚠ THIS IS NOT A DIAGRAM BESIDE THE KNOBS. It IS a joystick. A PF-14
  // `panel` cell is "a picture you EDIT" (shell-cells.ts), and dragging the
  // camera marker writes `pos_x` + `pos_z` through the sanctioned mutation seam
  // — the exact inverse of `eyeFromCamera`, asserted in the model test, so the
  // marker lands where you drop it rather than chasing it.
  //
  // ⚠ IT IS NOT A REPLACEMENT FOR THE CARD'S TWO PADS, and shipping it as one
  // was the rejected mistake. The card offers pad(pos_x, pos_y), a HEIGHT knob
  // (pos_z), and pad(zoom, rot) — three affordances over five axes. This plan
  // is a FOURTH thing: a top-down X × Z fly, which happens to hand the drag to
  // the 27.6 dB axis the card gives a small knob. Restoring the two real pads
  // is tracked on the PR; the plan stands on its own picture, not as a
  // substitute for them.
  //
  // ── WHAT IT SAYS THAT NOTHING ELSE ON THIS MODULE EVER HAS ────────────────
  //
  // `distanceGain` multiplies a 1/(1+d²) falloff by a DIRECTIONAL term,
  // `max(0, dot(emission, toCamera))`, and that clamp means an emitter facing
  // away from you is not quiet — it is SILENT, and its per-voice tap
  // (`out_red/grn/blu/alp`) emits digital zero with it. At the SHIPPED DEFAULT
  // camera the eye sits at [0, 0, 2.5], directly behind BLUE on the +Z wall, so
  // BLUE's gain is exactly 0. Measured; see wavesculpt-face-model.ts for the
  // full table and the sweep. The plan draws that: a dark emitter is hollow,
  // crossed, and labelled, and the caption names it.
  //
  // ── ⚠ IT READS THE LIVE ENGINE, WHICH THE HERO READOUTS CANNOT ────────────
  //
  // All five camera axes carry `paramTarget` CV inputs, and a registered
  // `FaceReadoutValue` is handed a DURABLE-param reader — so the three captions
  // in the readout strip are captioned `knob …` and go stale the moment an LFO
  // flies the camera. `engine.readParam(node, id)` returns intrinsic + tap, so
  // THIS picture tracks the cable. That asymmetry is the reason the panel
  // exists as well as the readouts, and it is stated rather than discovered.
  //
  // ⚠ THE POLL ASSIGNS ONLY ON CHANGE. It runs on rAF, and Svelte re-renders on
  // `!==`, so the camera is memoised on a rounded tuple: an idle scene (the VRT
  // capture, a suspended AudioContext, a rack with nothing patched) repaints
  // nothing at all. Same discipline as BlueboxToneBankPanel's held-key mask.
  //
  // ⚠ NO `control-<paramId>` TESTID ANYWHERE IN HERE (shell-cells rule 1) —
  // faces-parity asserts exact multiset equality between the dock's
  // `control-*` ids and the def's params, so a panel that emitted one would
  // read as an unbacked extra control.

  import { onDestroy } from 'svelte';
  import { patch } from '$lib/graph/store';
  import { setNodeParam } from '$lib/graph/mutate';
  import XyPad from '$lib/ui/controls/XyPad.svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import { paramSpec } from './card-kit';
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import { unpackColor01, wavesculptDef } from '$lib/audio/modules/wavesculpt';
  import {
    WAVESCULPT_TAPS,
    WAVESCULPT_VOICES,
    wavesculptCamera,
    wavesculptCameraCaption,
    wavesculptDragToCamera,
    wavesculptRoomPlan,
    wavesculptTapCaption,
    type WavesculptCamera,
    type WavesculptTap,
  } from './wavesculpt-face-model';

  interface Props {
    nodeId: string;
  }
  let { nodeId }: Props = $props();

  const engineCtx = useEngine();

  /** ⚠ THE VERSION IS CARRIED IN THE RESULT (the ModuleShell `liveCell`
   *  pattern). `patch.nodes[id]` is a stable SyncedStore proxy, so a derived
   *  that bumps on `nodeVersion(id)` and returns it BARE is `===` to its
   *  previous value and the picture freezes at first render. */
  let live = $derived.by(() => ({ v: nodeVersion(nodeId), n: patch.nodes[nodeId] as ModuleNode | undefined }));

  /** The five axes as they are RIGHT NOW — engine first (so a CV cable moves
   *  the picture), durable second (so an unbooted dev/VRT render still draws
   *  the patch rather than zeros). */
  function readLive(id: string): number | undefined {
    const node = live.n;
    if (!node) return undefined;
    let v: number | undefined;
    // TOTAL: this runs once per axis per FRAME. `PatchEngine.readParam`
    // resolves a per-domain sub-engine off `node.domain` and throws when there
    // is none — reachable while a node is mid-spawn — so it is caught rather
    // than guarded against one known shape.
    try {
      v = engineCtx.get()?.readParam(node, id) ?? undefined;
    } catch {
      v = undefined;
    }
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    const p = node.params?.[id];
    return typeof p === 'number' ? p : undefined;
  }

  /** The polled camera. Quantised to 4 decimals before the identity check so a
   *  float that only jitters in its last bits cannot repaint the panel. */
  let camera = $state<WavesculptCamera>(wavesculptCamera(() => undefined));
  let cameraKey = '';

  function pollCamera(): void {
    // Touch the version so the poll re-arms on a graph write as well as on rAF.
    void live.v;
    const next = wavesculptCamera(readLive);
    const key = `${next.pos_x.toFixed(4)}|${next.pos_y.toFixed(4)}|${next.pos_z.toFixed(4)}|${next.zoom.toFixed(4)}|${next.rot.toFixed(4)}`;
    if (key === cameraKey) return;
    cameraKey = key;
    camera = next;
  }

  let rafId: number | null = null;
  function frame(): void {
    rafId = null;
    pollCamera();
    rafId = requestAnimationFrame(frame);
  }
  // Kick it synchronously so the FIRST paint is the patch, not the defaults —
  // a VRT capture must not depend on a frame having been granted.
  pollCamera();
  if (typeof requestAnimationFrame === 'function') rafId = requestAnimationFrame(frame);
  onDestroy(() => {
    if (rafId !== null) cancelAnimationFrame(rafId);
    rafId = null;
  });

  /** WHICH OUTPUT the caption describes. ⚠ COMPONENT STATE, never `node.data`:
   *  choosing what YOU are looking at must not re-point every collaborator's
   *  screen or dirty the patch (the analogVco `cycles` / kickdrum `windowMs`
   *  precedent). The five choices name the five real audio jacks. */
  let tap = $state<WavesculptTap>('mix');

  let plan = $derived(wavesculptRoomPlan(camera));

  /** Each voice's tint, off its own packed-RGB param, so the colour cells in
   *  the voice bands and this picture cannot disagree. ALPHA has no colour
   *  param — it is the mask layer — and draws near-white, matching the card. */
  function voiceHex(idx: number): string {
    const pid = WAVESCULPT_VOICES[idx]?.colorParam;
    if (!pid) return '#e8ecf2';
    const raw = live.n?.params?.[pid];
    const packed =
      typeof raw === 'number' && Number.isFinite(raw)
        ? raw
        : (wavesculptDef.params.find((p) => p.id === pid)?.defaultValue ?? 0);
    const [r, g, b] = unpackColor01(packed);
    const ch = (v: number): string =>
      Math.max(0, Math.min(255, Math.round(v * 255)))
        .toString(16)
        .padStart(2, '0');
    return `#${ch(r)}${ch(g)}${ch(b)}`;
  }

  // ── PLAN GEOMETRY ────────────────────────────────────────────────────────
  // The SVG is a square viewBox; plan coords are −1..+1 with +Z running DOWN
  // (a floor plan seen from above, so the BACK wall is at the bottom — the same
  // convention `VIDEO_WALL_FACES` labels).
  const VB = 100;
  const sx = (px: number): number => (px + 1) * (VB / 2);
  const sy = (py: number): number => (py + 1) * (VB / 2);
  /** Half-angle of the drawn emission wedge, in plan units at the box scale. */
  const WEDGE = 0.42;

  /**
   * The wedge for one emitter: a triangle from its wall position, aimed the way
   * `WALL_LAYOUT` aims it.
   *
   * ⚠ IT STOPS JUST PAST THE ROOM CENTRE rather than crossing to the far wall.
   * A cone widens with distance, so a full-crossing wedge puts most of its
   * colour mass on the OPPOSITE side from its emitter — the first render had
   * RED's bulk on the left of a plan whose RED dot is on the right, which reads
   * as the wrong voice. Stopping at the centre keeps each colour on its own
   * side and still shows the four cones meeting, which is the fact the picture
   * is for.
   */
  function wedgePoints(e: { px: number; py: number; dx: number; dy: number }): string {
    const len = plan.boxHalf * 1.15;
    const tipX = e.px + e.dx * len;
    const tipY = e.py + e.dy * len;
    const nx = -e.dy * WEDGE * plan.boxHalf;
    const ny = e.dx * WEDGE * plan.boxHalf;
    return [
      `${sx(e.px).toFixed(2)},${sy(e.py).toFixed(2)}`,
      `${sx(tipX + nx).toFixed(2)},${sy(tipY + ny).toFixed(2)}`,
      `${sx(tipX - nx).toFixed(2)},${sy(tipY - ny).toFixed(2)}`,
    ].join(' ');
  }

  /** Wedge opacity. The gains are tiny in absolute terms (5e-2 at spawn), so a
   *  linear map would paint four invisible wedges; this is a dB-ish curve
   *  normalised to the loudest voice present, with a floor so a live-but-quiet
   *  voice still reads as LIVE. Zero stays zero — that distinction is the whole
   *  point of the picture and must not be softened by a floor. */
  function wedgeOpacity(gain: number): number {
    if (!(gain > 0)) return 0;
    const hi = Math.max(...plan.emitters.map((e) => e.gain), 1e-9);
    return 0.16 + 0.5 * Math.min(1, gain / hi);
  }

  // ── THE TWO JOYSTICKS ────────────────────────────────────────────────────
  //
  // ⚠ RESTORED AFTER THE FACE SHIPPED WITHOUT THEM. The first cut replaced the
  // card's two pads with five knobs plus a draggable plan, and the parity table
  // did not notice because it had a row per PARAM and none per GESTURE — a 2-D
  // pad is ONE gesture over TWO params, so a metric whose unit is the param is
  // structurally invariant to "one pad" vs "two knobs". `faces-parity` is blind
  // the same way: it counts `control-<paramId>` ids, and both shapes emit the
  // same ones.
  //
  // These are the card's own two, with the card's own semantics
  // (`WavesculptCard.svelte:367`, `:408`): POSITION is x = pos_x, y = pos_y with
  // y UP-positive; VIEW is x = zoom on a LOG axis, y = rot, again y-up.
  //
  // ⚠ EVERY BOUND COMES FROM THE DEF VIA `paramSpec`, NEVER RE-TYPED — the
  // CubeCard defect, where a card passed literal `xMin={-1} xMax={1}` to a pad
  // whose def said ±0.2, so the pad WROTE values the contract forbade and the
  // model silently clamped them. (The legacy card still hardcodes `0.3`/`3` for
  // zoom in `writeZR`; this panel does not, and that divergence is worth
  // closing on the card too.)
  const P_POS_X = paramSpec(wavesculptDef, 'pos_x');
  const P_POS_Y = paramSpec(wavesculptDef, 'pos_y');
  const P_POS_Z = paramSpec(wavesculptDef, 'pos_z');
  const P_ZOOM = paramSpec(wavesculptDef, 'zoom');
  const P_ROT = paramSpec(wavesculptDef, 'rot');

  /**
   * ZOOM rides a LOG axis, and the pad is linear — so the pad is driven in LOG
   * SPACE and converted at the seam. `XyPad` takes a plain min/max, and feeding
   * it 0.3..3 linearly would put unity zoom at 10 % of the travel instead of
   * halfway, which is both wrong to the hand and a different control from the
   * card's. The bounds are still the def's; only the coordinate is logged.
   */
  const ZOOM_LOG_MIN = Math.log(P_ZOOM.min);
  const ZOOM_LOG_MAX = Math.log(P_ZOOM.max);
  const clampTo = (p: { min: number; max: number }, v: number): number =>
    Math.max(p.min, Math.min(p.max, v));

  // ⚠ THE PLAN IS A PICTURE, NOT A CONTROL, and it used to be both. Its drag
  // wrote pos_x/pos_z, which duplicated POSITION's x-axis with a DIFFERENT
  // second axis — two gestures writing one param, and neither matching the
  // card. With the real pads restored the plan goes read-only: one gesture per
  // axis, and the picture is free to show what no pad can (which emitters
  // currently reach you).

  let caption = $derived(`${wavesculptTapCaption(camera, tap)}  ·  ${wavesculptCameraCaption(camera)}`);
  let darkCount = $derived(plan.emitters.filter((e) => e.dark).length);
</script>

<div class="ws-room" data-testid="wavesculpt-room">
  <div class="stage">
  <svg
    viewBox="0 0 {VB} {VB}"
    role="img"
    aria-label="Room plan seen from above: the four wall oscillators with the cones they aim at the room centre, and the camera. A hollow crossed emitter is facing away and therefore silent."
    data-testid="wavesculpt-room-stage"
  >
    <!-- The unit box, seen from above. -->
    <rect
      class="box"
      x={sx(-plan.boxHalf)}
      y={sy(-plan.boxHalf)}
      width={sx(plan.boxHalf) - sx(-plan.boxHalf)}
      height={sy(plan.boxHalf) - sy(-plan.boxHalf)}
    />

    {#each plan.emitters as e (e.idx)}
      <polygon
        class="wedge"
        class:dark={e.dark}
        points={wedgePoints(e)}
        fill={voiceHex(e.idx)}
        fill-opacity={wedgeOpacity(e.gain)}
        stroke={voiceHex(e.idx)}
        stroke-opacity={e.dark ? 0.5 : 0}
      />
    {/each}

    {#each plan.emitters as e (e.idx)}
      <circle
        class="emitter"
        class:dark={e.dark}
        cx={sx(e.px)}
        cy={sy(e.py)}
        r="3.1"
        fill={e.dark ? 'none' : voiceHex(e.idx)}
        stroke={voiceHex(e.idx)}
      />
      {#if e.dark}
        <!-- A crossed emitter is SILENT, not merely far away — the clamped
             directional term, drawn. -->
        <path
          class="cross"
          d="M{(sx(e.px) - 2.1).toFixed(2)},{(sy(e.py) - 2.1).toFixed(2)} L{(sx(e.px) + 2.1).toFixed(
            2,
          )},{(sy(e.py) + 2.1).toFixed(2)} M{(sx(e.px) + 2.1).toFixed(2)},{(
            sy(e.py) - 2.1
          ).toFixed(2)} L{(sx(e.px) - 2.1).toFixed(2)},{(sy(e.py) + 2.1).toFixed(2)}"
          stroke={voiceHex(e.idx)}
        />
      {/if}
    {/each}

    <!-- THE CAMERA. Hollow when it has been clamped into frame (zoom 0.3 puts
         the eye 8.3 units out, well past the ±3 the plan draws). -->
    <g class="eye" class:clamped={plan.eyeClamped}>
      <circle cx={sx(plan.eyeX)} cy={sy(plan.eyeY)} r="4.4" />
      <circle class="pupil" cx={sx(plan.eyeX)} cy={sy(plan.eyeY)} r="1.5" />
    </g>
  </svg>

  <!-- THE LIVE LEGEND. A square plan in a wide hero bay leaves the width
       empty, and the most useful thing to put there is the number the plan
       can only imply: what each voice is ACTUALLY doing at this camera. It is
       also the only place the four per-voice JACKS are named next to their
       levels, which is what makes "which output do I patch" answerable. -->
  <ul class="legend">
    {#each plan.emitters as e (e.idx)}
      <li class:dark={e.dark} class:sel={WAVESCULPT_TAPS.find((t) => t.id === tap)?.voice === e.idx}>
        <span class="swatch" style="background: {voiceHex(e.idx)};" aria-hidden="true"></span>
        <span class="name">{e.label}</span>
        <span class="jack">{WAVESCULPT_VOICES[e.idx]!.outPort}</span>
        <span class="gain">{e.dark ? 'DARK' : `${(20 * Math.log10(e.gain)).toFixed(1)} dB`}</span>
      </li>
    {/each}
  </ul>

  <!-- THE TWO JOYSTICKS, in the card's own order and with the card's own
       axes. The HEIGHT knob sits BETWEEN them exactly as it does on the card,
       because pos_z is the third camera axis and belongs with the other two —
       not because a row of three looks tidy.
       ⚠ THEY ARE THE STAGE'S THIRD COLUMN, not a row beneath it. Stacked, the
       panel was 372 px tall and never wider than ~530 of the 786 px it had;
       the plan, the sticks and the legend are three ~170 px-tall blocks that
       fit side by side, so the same content is ~200 px. -->
  <div class="sticks">
    <XyPad
      xValue={camera.pos_x}
      yValue={camera.pos_y}
      xMin={P_POS_X.min}
      xMax={P_POS_X.max}
      yMin={P_POS_Y.min}
      yMax={P_POS_Y.max}
      xDefault={P_POS_X.defaultValue}
      yDefault={P_POS_Y.defaultValue}
      xLabel="X"
      yLabel="Y"
      title="position"
      size={96}
      testid="wavesculpt-pad-pos"
      moduleId={nodeId}
      xParamId="pos_x"
      yParamId="pos_y"
      onXChange={(v) => setNodeParam(nodeId, 'pos_x', clampTo(P_POS_X, v))}
      onYChange={(v) => setNodeParam(nodeId, 'pos_y', clampTo(P_POS_Y, v))}
    />

    <div class="height">
      <span class="cap">height</span>
      <!-- ⚠ NO `paramId`/`moduleId` ON THIS KNOB, deliberately. `Knob.svelte`
           emits `data-testid="control-<paramId>"` when given one, and pos_z
           already has its own cell in the ROOM band — a second one would be a
           duplicate `control-pos_z` and fail faces-parity's multiset equality.
           MIDI-assign lives on that real cell; this is the card's between-the-
           pads gesture, restored. -->
      <Knob
        value={camera.pos_z}
        min={P_POS_Z.min}
        max={P_POS_Z.max}
        defaultValue={P_POS_Z.defaultValue}
        label="H"
        curve={P_POS_Z.curve}
        onchange={(v) => setNodeParam(nodeId, 'pos_z', clampTo(P_POS_Z, v))}
      />
    </div>

    <XyPad
      xValue={Math.log(Math.max(P_ZOOM.min, Math.min(P_ZOOM.max, camera.zoom)))}
      yValue={camera.rot}
      xMin={ZOOM_LOG_MIN}
      xMax={ZOOM_LOG_MAX}
      yMin={P_ROT.min}
      yMax={P_ROT.max}
      xDefault={Math.log(P_ZOOM.defaultValue)}
      yDefault={P_ROT.defaultValue}
      xLabel="ZM"
      yLabel="ROT"
      title="view"
      size={96}
      testid="wavesculpt-pad-view"
      moduleId={nodeId}
      xParamId="zoom"
      yParamId="rot"
      xFormat={(v) => Math.exp(v).toFixed(2)}
      onXChange={(v) => setNodeParam(nodeId, 'zoom', clampTo(P_ZOOM, Math.exp(v)))}
      onYChange={(v) => setNodeParam(nodeId, 'rot', clampTo(P_ROT, v))}
    />
  </div>
  </div>

  <div class="taps" role="group" aria-label="Which output this readout describes">
    {#each WAVESCULPT_TAPS as t (t.id)}
      <button
        type="button"
        class="tap"
        class:on={tap === t.id}
        aria-pressed={tap === t.id}
        data-testid={`wavesculpt-room-tap-${t.id}`}
        title={`${t.label} — the ${t.ports} jack${t.voice === null ? ', post master gain' : ', pre master gain'}. Your screen only: this is not shared with the rackspace or saved with the patch.`}
        onclick={() => (tap = t.id)}>{t.label}</button
      >
    {/each}
    <span class="live" data-testid="wavesculpt-room-live"
      >{plan.emitters.length - darkCount} of {plan.emitters.length} live</span
    >
  </div>

  <p class="caption" data-testid="wavesculpt-room-caption">{caption}</p>
</div>

<style>
  .ws-room {
    width: 100%;
    display: grid;
    grid-template-rows: auto auto auto;
    gap: 4px;
  }

  /* The plan is SQUARE (the room is), so it is sized rather than stretched and
     the sticks and the legend take the width a letterboxed square would have
     wasted. The drag maths recovers the drawn square from `min(w, h)`
     regardless, so this is a layout choice and not a correctness dependency.
     THREE COLUMNS — plan · sticks · legend — because all three are ~170 px
     tall and the bay is 786 px wide. `flex-wrap` rather than a fixed grid so a
     narrow pane degrades into the stacked column instead of overflowing. */
  .stage {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 14px;
    align-items: flex-start;
    justify-content: flex-start;
  }

  .ws-room svg {
    width: 170px;
    height: 170px;
    display: block;
    background: rgb(0 0 0 / 0.4);
    border: 1px solid rgb(255 255 255 / 0.08);
    border-radius: 3px;
    cursor: grab;
    touch-action: none;
  }
  .ws-room svg:focus-visible {
    outline: 1px solid rgb(255 255 255 / 0.45);
    outline-offset: 1px;
  }
  .ws-room svg.dragging {
    cursor: grabbing;
  }

  .box {
    fill: rgb(255 255 255 / 0.03);
    stroke: rgb(255 255 255 / 0.22);
    stroke-width: 0.6;
  }

  .wedge {
    stroke-width: 0.5;
    stroke-dasharray: 2 2;
  }

  .emitter {
    stroke-width: 1.1;
  }
  .cross {
    stroke-width: 1;
    fill: none;
  }

  .eye circle {
    fill: none;
    stroke: rgb(255 255 255 / 0.9);
    stroke-width: 1.2;
  }
  .eye .pupil {
    fill: rgb(255 255 255 / 0.9);
  }
  /* A clamped eye is OUTSIDE the drawn frame — the caption carries the true
     numbers, and the marker says it is pinned rather than placed. */
  .eye.clamped circle {
    stroke-dasharray: 2 1.6;
    stroke: rgb(255 255 255 / 0.55);
  }
  .eye.clamped .pupil {
    fill: none;
  }

  /* ⚠ `margin-right: auto` IS LAYOUT, NOT SPACING. The hero bay is as wide as
     the faceplate, so on a wide screen this row left ~800 px dead to the RIGHT
     of everything (MEASURED at 1920×1080: bay 1426 px, content ending at
     x≈615) — the owner's "shitty use of horizontal space", in the one place a
     picture and its controls should own the width. Putting the auto margin on
     the MIDDLE flex item sends the slack between the legend and the sticks, so
     plan + legend stay one unit on the left (the legend names the dots in the
     plan; separating them would be worse than the void) and the two joysticks
     move right, beside the ZOOM dial that already sits there. `space-between`
     would instead have stranded the legend mid-row. No-op on a row with no
     slack — at 1280×720 this row is already full. */
  .legend {
    margin: 0 auto 0 0;
    padding: 0;
    list-style: none;
    display: grid;
    gap: 2px;
    align-content: start;
  }
  .legend li {
    display: grid;
    grid-template-columns: 8px 46px minmax(0, 1fr) auto;
    align-items: center;
    gap: 5px;
    padding: 2px 4px;
    border-radius: 2px;
    font: 600 9px/1 var(--font-mono, ui-monospace, monospace);
    letter-spacing: 0.04em;
    color: rgb(255 255 255 / 0.72);
  }
  .legend li.sel {
    background: rgb(255 255 255 / 0.07);
  }
  /* A DARK voice is not styled as "quiet" — it is struck through, because the
     gain is not small, it is zero, and its jack emits digital zero with it. */
  .legend li.dark {
    color: rgb(255 255 255 / 0.4);
  }
  .legend li.dark .gain {
    color: rgb(255 170 170 / 0.9);
  }
  .legend .swatch {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    box-shadow: 0 0 0 1px rgb(0 0 0 / 0.5);
  }
  .legend .jack,
  .legend .gain {
    font-weight: 500;
    color: rgb(255 255 255 / 0.5);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .legend li.dark .swatch {
    opacity: 0.35;
  }

  .sticks {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    flex-wrap: nowrap;
  }
  .height {
    display: grid;
    justify-items: center;
    gap: 3px;
    padding-top: 14px;
  }
  .height .cap {
    font: 600 8.5px/1 var(--font-mono, ui-monospace, monospace);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: rgb(255 255 255 / 0.45);
  }

  .taps {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 3px;
  }

  .tap {
    font: 600 9px/1 var(--font-mono, ui-monospace, monospace);
    letter-spacing: 0.04em;
    padding: 3px 5px;
    color: rgb(255 255 255 / 0.62);
    background: rgb(255 255 255 / 0.05);
    border: 1px solid rgb(255 255 255 / 0.12);
    border-radius: 2px;
    cursor: pointer;
  }
  .tap:hover {
    color: rgb(255 255 255 / 0.9);
  }
  .tap.on {
    color: rgb(0 0 0 / 0.85);
    background: rgb(255 255 255 / 0.82);
    border-color: rgb(255 255 255 / 0.82);
  }

  .live {
    margin-left: auto;
    font: 600 9px/1 var(--font-mono, ui-monospace, monospace);
    color: rgb(255 255 255 / 0.55);
  }

  .caption {
    margin: 0;
    font: 500 9.5px/1.35 var(--font-mono, ui-monospace, monospace);
    color: rgb(255 255 255 / 0.66);
    word-break: break-word;
  }
</style>
