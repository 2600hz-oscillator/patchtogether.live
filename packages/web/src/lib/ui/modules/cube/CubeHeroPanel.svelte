<script lang="ts">
  // CubeHeroPanel — the faceplate's HERO: cube's whole picture, unreduced.
  //
  // ⚠ IT IS THE SAME RENDERER THE CARD USES, not a reduction of it. The face
  // spec priced a cheaper 2-D hero that blits a simplified frame; the owner
  // required full visualisation parity, and the parity is not decoration — the
  // module IS "a solid and a cut", and the ONLY surface anywhere that shows the
  // cut INSIDE the solid is the volume render. All three surfaces survive:
  //
  //   • the rotatable WebGL2 VOLUME — 28 alpha-blended Z-slice quads, the cube
  //     wireframe, and the live slicing plane at slice_y / slice_rx / ry / rz,
  //     orbited by view_zoom + view_rot_x/y;
  //   • the 2-D SLICE cross-section, the field the plane actually cuts;
  //   • the OUTPUT waveform, i.e. the 256 samples that ARE one cycle.
  //
  // WHAT THE HERO ADDS OVER THE CARD is the two caption lines, and both carry
  // facts no control on this module shows:
  //
  //   • THE CAMERA readout, which is also the drag-to-orbit WITNESS. The card
  //     had three camera knobs and no way to grab the picture; the hero has
  //     both, and the printed angle is what makes a dead drag distinguishable
  //     from a live one (faces-parity drives exactly this).
  //   • THE WAVE caption — solid %, DC against the audio, levels · turns. cube's
  //     L and R carry MORE DC THAN SIGNAL at spawn (|DC| = 1.06× the acRms) and
  //     nothing else in the module says so; `levels` is the instrument that sees
  //     MATERIAL, which RMS ranks dead last while it halves the wave's
  //     structure. See cube-face-model for the measurements.
  //
  // ⚠ THE CAPTION IS COMPUTED, NOT TAPPED. The factory posts a snapshot only
  // once the worklet has ticked, so a suspended graph — every VRT face capture
  // — has none, and a tapped caption would read `—` in precisely the frames a
  // baseline is taken. This runs the REAL `sampleSlice` (0.56 ms) over the REAL
  // resolved tables, so it is the same number the sound will have.
  //
  // ⚠ NO `control-<paramId>` TESTID ANYWHERE IN HERE (shell-cells rule 1). The
  // orbit drag WRITES `view_rot_x/y`, but those params keep their own cells in
  // the `view` band — the gesture and the knob are two affordances over one
  // param, which is what the parity gate's exact multiset requires.

  import { patch } from '$lib/graph/store';
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
  import { setNodeParam } from '$lib/graph/mutate';
  import { cubeDef, resolveSlotFrames, type CubeData, type CubeSlot, type CubeSlotData } from '$lib/audio/modules/cube';
  import {
    cubeCamText,
    cubeFaceParams,
    cubeHeroCaption,
    cubeHeroWave,
    cubeWaveStats,
    type CubeFaceParams,
  } from '../cube-face-model';
  import CubeVizSurface from './CubeVizSurface.svelte';

  interface Props {
    nodeId: string;
  }
  let { nodeId }: Props = $props();

  /** ⚠ THE VERSION IS CARRIED IN THE RESULT — a bare SyncedStore proxy is
   *  `===` to itself, so the caption would freeze at its first read. */
  let live = $derived.by(() => ({ v: nodeVersion(nodeId), n: patch.nodes[nodeId] }));

  const defaultFor = (pid: string): number | undefined =>
    cubeDef.params.find((p) => p.id === pid)?.defaultValue;

  let p = $derived.by<CubeFaceParams>(() =>
    cubeFaceParams((id) => {
      const v = live.n?.params?.[id];
      return typeof v === 'number' ? v : defaultFor(id);
    }),
  );

  /** The three tables, from `node.data` through the factory's OWN resolver, so
   *  a loaded .wav or a picked factory table is reflected without an engine. */
  let tableSig = $derived.by(() => {
    const d = (live.n?.data ?? {}) as CubeData;
    return (['floor', 'wall', 'ceiling'] as CubeSlot[])
      .map((s) => {
        const sd = (d[s] as CubeSlotData | undefined) ?? {};
        return `${sd.source ?? ''}:${sd.label ?? ''}:${sd.frames?.length ?? 0}`;
      })
      .join('|');
  });
  let tables = $derived.by(() => {
    void tableSig;
    const d = (live.n?.data ?? {}) as CubeData;
    return {
      floor: resolveSlotFrames('floor', d.floor).frames,
      wall: resolveSlotFrames('wall', d.wall).frames,
      ceiling: resolveSlotFrames('ceiling', d.ceiling).frames,
    };
  });

  let stats = $derived(cubeWaveStats(cubeHeroWave(p, tables.floor, tables.wall, tables.ceiling)));
  let caption = $derived(cubeHeroCaption(stats));
  let cam = $derived(cubeCamText(p));

  /** ⚠ RANGES COME FROM THE DEF, never re-typed here (the card-vs-def
   *  divergence class: a control that writes values its own contract forbids). */
  const rangeOf = (pid: string): [number, number] => {
    const d = cubeDef.params.find((q) => q.id === pid)!;
    return [d.min, d.max];
  };
  /** Radians per CSS px of drag. A full sweep of the 300 px view is a bit over
   *  half a turn, which is the sensitivity the camera knobs give over their
   *  own travel. */
  const ORBIT_RAD_PER_PX = 0.01;

  function orbit(dxPx: number, dyPx: number): void {
    const bump = (pid: string, delta: number): void => {
      const [lo, hi] = rangeOf(pid);
      const cur = (typeof live.n?.params?.[pid] === 'number'
        ? (live.n!.params![pid] as number)
        : defaultFor(pid)) ?? 0;
      const next = Math.max(lo, Math.min(hi, cur + delta));
      if (next !== cur) setNodeParam(nodeId, pid, next);
    };
    // Vertical drag = elevation (view_rot_x), horizontal = azimuth
    // (view_rot_y) — the same two angles the eye vector is built from.
    if (dyPx !== 0) bump('view_rot_x', dyPx * ORBIT_RAD_PER_PX);
    if (dxPx !== 0) bump('view_rot_y', -dxPx * ORBIT_RAD_PER_PX);
  }
</script>

<div class="cube-view" data-testid="cube-view">
  <CubeVizSurface
    {nodeId}
    vizW={300}
    vizH={210}
    sliceW={147}
    sliceH={104}
    waveW={147}
    waveH={104}
    onOrbit={orbit}
  />
  <div class="caps">
    <span class="cap cam" data-testid="cube-hero-cam">cam {cam} · drag to orbit</span>
    <span class="cap" data-testid="cube-hero-caption">{caption}</span>
  </div>
</div>

<style>
  .cube-view { display: flex; flex-direction: column; gap: 6px; align-items: center; }
  .caps { display: flex; flex-direction: column; gap: 2px; align-items: center; width: 100%; }
  .cap {
    font-family: var(--font-mono, monospace);
    font-size: 0.58rem;
    letter-spacing: 0.02em;
    color: var(--text-dim, #9fb6c9);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100%;
  }
  .cam { color: var(--text-faint, #7f93a6); }
</style>
