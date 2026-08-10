<script lang="ts">
  // WavesculptRoomPanel — the faceplate's HERO: the room, seen from above.
  //
  // ⚠ THIS IS NOT A DIAGRAM BESIDE THE KNOBS. It IS the joystick. A PF-14
  // `panel` cell is "a picture you EDIT" (shell-cells.ts), and dragging the
  // camera marker writes `pos_x` + `pos_z` through the sanctioned mutation seam
  // — the exact inverse of `eyeFromCamera`, asserted in the model test, so the
  // marker lands where you drop it rather than chasing it.
  //
  // ⚠ AND IT DRAGS THE PAIR THE LEGACY CARD NEVER PUT TOGETHER. The card gives
  // its two big joystick axes to `pos_x` and `rot` — measured at 4.6 dB and
  // 3.2 dB of total-gain swing, the two LEAST consequential camera controls —
  // while `pos_z`, the second most consequential at 27.6 dB, is a small
  // "Height" knob wedged between them. A top-down plan is X × Z by
  // construction, so the plan hands the drag to the 27.6 dB axis for free.
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

  // ── THE DRAG ─────────────────────────────────────────────────────────────

  let dragging = $state(false);

  /**
   * Pointer → plan coords.
   *
   * ⚠ IT MUST UNDO THE LETTERBOX, and the naive version was WRONG — caught by
   * looking at the rendered baseline rather than by any gate. The viewBox is
   * SQUARE and `preserveAspectRatio` defaults to `xMidYMid meet`, so in a
   * 780 × 168 hero bay the drawing occupies a 168 px square in the MIDDLE and
   * the rest is empty. Mapping straight off `getBoundingClientRect()` would
   * make the far-left of the bay read as `px = -1` — a camera position 4.6×
   * further out than where the marker actually is — so the room plan would not
   * follow the pointer. Recovering the drawn square from `min(w, h)` is exact
   * at ANY element size, which a pinned CSS width would not be: a later layout
   * change could silently re-break it.
   */
  function planFromEvent(ev: PointerEvent): { px: number; py: number } {
    const el = ev.currentTarget as SVGSVGElement;
    const r = el.getBoundingClientRect();
    // Guard a zero-size rect (a hidden tab's band is CSS-hidden, not unmounted,
    // and faces-parity scrolls cells into view before driving them).
    const side = Math.min(r.width, r.height) || 1;
    const left = r.left + (r.width - side) / 2;
    const top = r.top + (r.height - side) / 2;
    return {
      px: Math.max(-1, Math.min(1, ((ev.clientX - left) / side) * 2 - 1)),
      py: Math.max(-1, Math.min(1, ((ev.clientY - top) / side) * 2 - 1)),
    };
  }

  function writeCamera(ev: PointerEvent): void {
    const { px, py } = planFromEvent(ev);
    const next = wavesculptDragToCamera(camera, px, py);
    // A user gesture, so it is a DURABLE, undoable write — the same seam and
    // the same per-pointermove cadence the legacy card's XY pads already use.
    setNodeParam(nodeId, 'pos_x', next.pos_x);
    setNodeParam(nodeId, 'pos_z', next.pos_z);
  }

  function onDown(ev: PointerEvent): void {
    dragging = true;
    (ev.currentTarget as SVGSVGElement).setPointerCapture?.(ev.pointerId);
    writeCamera(ev);
    ev.preventDefault();
  }
  function onMove(ev: PointerEvent): void {
    if (!dragging) return;
    writeCamera(ev);
  }
  function onUp(ev: PointerEvent): void {
    if (!dragging) return;
    dragging = false;
    (ev.currentTarget as SVGSVGElement).releasePointerCapture?.(ev.pointerId);
  }

  /** Keyboard parity for the drag — a picture you edit must be operable
   *  without a pointer. One step is 0.05 of each param's ±1 range. */
  function onKey(ev: KeyboardEvent): void {
    const step = ev.shiftKey ? 0.2 : 0.05;
    const dx = ev.key === 'ArrowLeft' ? -step : ev.key === 'ArrowRight' ? step : 0;
    const dz = ev.key === 'ArrowUp' ? -step : ev.key === 'ArrowDown' ? step : 0;
    if (dx === 0 && dz === 0) return;
    ev.preventDefault();
    const cl = (v: number): number => Math.max(-1, Math.min(1, v));
    setNodeParam(nodeId, 'pos_x', cl(camera.pos_x + dx));
    setNodeParam(nodeId, 'pos_z', cl(camera.pos_z + dz));
  }

  let caption = $derived(`${wavesculptTapCaption(camera, tap)}  ·  ${wavesculptCameraCaption(camera)}`);
  let darkCount = $derived(plan.emitters.filter((e) => e.dark).length);
</script>

<div class="ws-room" data-testid="wavesculpt-room">
  <div class="stage">
  <svg
    viewBox="0 0 {VB} {VB}"
    class:dragging
    role="application"
    tabindex="0"
    aria-label="Room plan seen from above — drag the camera to fly it through the box. Horizontal is camera X, vertical is camera Z (height into the room)."
    data-testid="wavesculpt-room-stage"
    onpointerdown={onDown}
    onpointermove={onMove}
    onpointerup={onUp}
    onpointercancel={onUp}
    onkeydown={onKey}
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
     the legend takes the width a letterboxed square would have wasted. The
     drag maths recovers the drawn square from `min(w, h)` regardless, so this
     is a layout choice and not a correctness dependency. */
  .stage {
    display: grid;
    grid-template-columns: 196px minmax(0, 320px);
    gap: 10px;
    align-items: start;
    justify-content: start;
  }

  .ws-room svg {
    width: 196px;
    height: 196px;
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

  .legend {
    margin: 0;
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
