<script lang="ts">
  // SidecarTransferPanel — SIDECAR's static gain computer, as a PF-14 panel.
  //
  // ⚠ WHY THIS PICTURE EXISTS. The adversarial audit that produced this face
  // (#1657) found four knobs printing a number that is not the answer, and the
  // face answered three of them with derived READOUTS — one value, at one
  // operating point, because `(read) => string` is all a FaceReadoutValue is.
  // What no readout can carry is the SHAPE:
  //
  //   · The THRESHOLD dial prints -18.00 dB and ducking begins at a main peak
  //     of -27.02 dBFS. Two independent terms make up the gap, and a single
  //     `onset` number cannot say which of them moved: the detector is
  //     `|aL| + |aR|`, so a mono main reads 6.02 dB above its own peak (the
  //     `thr` tick), and the soft knee opens another `knee/2` below that (the
  //     `onset` tick). BOTH marks are drawn, on an axis calibrated in the MAIN
  //     dBFS a player actually reads off a meter.
  //   · The RATIO dial is badly non-linear in its own top half — 0 / -12.0 /
  //     -18.0 / -21.0 / -22.8 dB at 1 / 2 / 4 / 8 / 20. That is a SLOPE.
  //   · Everything between silence and full scale, which is every real kick.
  //     The cursor asks the readout row's own questions at a level the player
  //     picks, and answers them in the readout row's own words.
  //
  // ⚠ NOT THE HERO, DELIBERATELY. `face.hero.control` is THRESHOLD and stays
  // there: a `hero.cell` MOVES its key into the hero slot and SUPPRESSES the
  // shell glyph at the dock, so promoting this picture would demote the dial it
  // exists to explain and drop the module's output meter. It ranks 7 — the
  // first legal rank for a panel (the 'full' lane cap is 6) — and paints in the
  // `detect` band beside the two controls the hero move left there.
  //
  // ⚠ EVERY NUMBER COMES FROM `sidecar-face-model`, WHICH IS THE SHIPPING DSP.
  // `sidecarGainDb` is `compressor-dsp.ts` `computeGainDb` with the log2→dB
  // conversion the worklet does one line earlier; ENV is the shipping `envOut`.
  // Nothing about the knee, the slope or the three regions is re-typed here. A
  // curve drawn from a second copy of the law would be wrong at every x rather
  // than at one, and would look authoritative doing it.
  //
  // ⚠ THIS PANEL EMITS NO `control-<paramId>` TESTID (shell-cells rule 1) and
  // no Knob/Fader at all: it EDITS NOTHING. Its one affordance is the cursor,
  // which is a private VIEW setting held in component state — never
  // `node.data`, because a rack-mate reading their own kick's level must not
  // drag yours (the dx7 operator-map / kickdrum window rule). That is why its
  // declared probe is `text` rather than `data`: there is no graph write to
  // watch, and the caption it drives cannot be faked by a control relabelling
  // itself.
  //
  // ⚠ SVG, NO CANVAS, NO rAF, NO ANALYSER. The picture is a pure function of
  // nine params, so the dock VRT scene is deterministic on a frozen graph, a
  // running one and a silent rack alike — no mask, no VRT_LIVE_SURFACES entry.

  import { patch } from '$lib/graph/store';
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
  import {
    SIDECAR_CURVE_DUCK_FLOOR_DB,
    SIDECAR_CURVE_MAIN_MAX_DBFS,
    SIDECAR_CURVE_MAIN_MIN_DBFS,
    SIDECAR_REFERENCE_MAIN_DBFS,
    sidecarClampMainDbfs,
    sidecarCurvePoints,
    sidecarCursorText,
    sidecarDuckDbAt,
    sidecarFaceParams,
    sidecarOnsetMarkDbfs,
    sidecarThresholdMarkDbfs,
    type SidecarFaceParams,
  } from './sidecar-face-model';

  interface Props {
    nodeId: string;
  }
  let { nodeId }: Props = $props();

  /** ⚠ THE VERSION IS CARRIED IN THE RESULT (the ModuleShell `liveCell`
   *  pattern, as RingsCombPanel and WarrensspectrumBankPanel both document).
   *  `patch.nodes[id]` is a stable SyncedStore proxy, so a `$derived` that
   *  bumps on `nodeVersion(id)` and returns it BARE is `===` to its previous
   *  value and the curve freezes at whatever it first read. */
  let live = $derived.by(() => ({ v: nodeVersion(nodeId), n: patch.nodes[nodeId] }));

  /** `node.params` is a SPARSE overlay of what has been TOUCHED, so a fresh
   *  node reads `undefined` for everything — `sidecarFaceParams` defaults each
   *  key INDEPENDENTLY against the def, which is why a just-spawned SIDECAR
   *  draws its shipped curve rather than a hard knee at 0 dB. */
  let p = $derived.by<SidecarFaceParams>(() =>
    sidecarFaceParams((id) => {
      const v = live.n?.params?.[id];
      return typeof v === 'number' ? v : undefined;
    }),
  );

  const PLOT_W = 200;
  const PLOT_H = 100;
  /** Plot resolution. The knee is a quadratic over at most 24 dB of a 60 dB
   *  window, so 120 columns put ≥ 48 samples inside the widest knee — the
   *  curvature is the thing being drawn and it must not alias into a corner. */
  const COLUMNS = 120;
  const SPAN = SIDECAR_CURVE_MAIN_MAX_DBFS - SIDECAR_CURVE_MAIN_MIN_DBFS;
  /** Gridlines, in dB, on each axis — every 12 dB, which is also the spacing
   *  the RATIO landmarks fall on. */
  const V_GRID = [-48, -36, -24, -12];
  const H_GRID = [-12, -24, -36];

  /** ⚠ COMPONENT STATE, never `node.data`. It RESTS at the readouts' own
   *  reference (`@ FS`), so the panel and the row above it say the same thing
   *  until the player asks a different question. */
  let cursorDbfs = $state(SIDECAR_REFERENCE_MAIN_DBFS);

  let curve = $derived(sidecarCurvePoints(p, COLUMNS));
  let thrMark = $derived(sidecarThresholdMarkDbfs(p));
  let onsetMark = $derived(sidecarOnsetMarkDbfs(p));
  let caption = $derived(sidecarCursorText(p, cursorDbfs));

  const xOf = (mainDbfs: number) => ((mainDbfs - SIDECAR_CURVE_MAIN_MIN_DBFS) / SPAN) * PLOT_W;
  const yOf = (db: number) => (db / SIDECAR_CURVE_DUCK_FLOOR_DB) * PLOT_H;

  let points = $derived(
    curve.points.map((pt) => `${xOf(pt.mainDbfs).toFixed(2)},${yOf(pt.plotDb).toFixed(2)}`).join(' '),
  );
  let cursorX = $derived(xOf(cursorDbfs));
  let cursorY = $derived(
    yOf(Math.min(0, Math.max(SIDECAR_CURVE_DUCK_FLOOR_DB, sidecarDuckDbAt(p, cursorDbfs)))),
  );

  /** Map a pointer to a MAIN level. Reads the element's live rect rather than a
   *  cached width: the dock pane is resizable and a stale width would move the
   *  cursor to a level the player did not point at. */
  function pick(e: PointerEvent): void {
    const el = e.currentTarget as HTMLElement | null;
    const r = el?.getBoundingClientRect();
    if (!r || r.width <= 0) return;
    cursorDbfs = sidecarClampMainDbfs(
      SIDECAR_CURVE_MAIN_MIN_DBFS + ((e.clientX - r.left) / r.width) * SPAN,
    );
  }
</script>

<div class="sc-curve" data-testid="sidecar-curve">
  <!-- A <button>, not a bare <svg> with handlers: the plot IS an affordance, so
       it gets the element that already carries the role, the focus ring and the
       press semantics rather than a static div plus three a11y suppressions. -->
  <button
    type="button"
    class="plot"
    data-testid="sidecar-curve-plot"
    title="Point anywhere to read the ducking at that MAIN level. Your screen only: not shared with the rackspace, not saved with the patch."
    aria-label="Transfer curve: main input level against gain reduction. Point to move the read cursor."
    onpointerdown={pick}
    onpointermove={(e) => {
      if (e.buttons & 1) pick(e);
    }}
  >
    <svg viewBox="0 0 {PLOT_W} {PLOT_H}" preserveAspectRatio="none" aria-hidden="true">
      {#each V_GRID as g (g)}
        <line class="grid" x1={xOf(g)} x2={xOf(g)} y1="0" y2={PLOT_H} />
      {/each}
      {#each H_GRID as g (g)}
        <line class="grid" x1="0" x2={PLOT_W} y1={yOf(g)} y2={yOf(g)} />
      {/each}

      <!-- THE DIAL'S OWN MARK. Dashed and muted because it is where the number
           on the knob lands, which is NOT where anything happens — the gap to
           the solid tick is the `|aL| + |aR|` sum plus half the knee. -->
      {#if thrMark !== null}
        <line class="thr" x1={xOf(thrMark)} x2={xOf(thrMark)} y1="0" y2={PLOT_H} />
      {/if}
      <!-- WHERE DUCKING ACTUALLY BEGINS — the same value the ONSET readout
           prints, from the same function, so the tick and the number cannot
           disagree. Absent at ratio 1, where the readout says `never`. -->
      {#if onsetMark !== null}
        <line class="onset" x1={xOf(onsetMark)} x2={xOf(onsetMark)} y1="0" y2={PLOT_H} />
      {/if}

      <polyline class="curve" points={points} />

      <line class="cursor" x1={cursorX} x2={cursorX} y1="0" y2={PLOT_H} />
      <circle class="dot" cx={cursorX} cy={cursorY} r="2.5" />
    </svg>
  </button>

  <div class="axis">
    <span>{SIDECAR_CURVE_MAIN_MIN_DBFS}</span>
    <span class="unit">main dBFS</span>
    <span>{SIDECAR_CURVE_MAIN_MAX_DBFS}</span>
  </div>

  <div class="foot">
    <span class="key">
      <span class="k-thr">thr</span>
      <span class="k-onset">onset</span>
    </span>
    <!-- THE PANEL'S DECLARED OPERABILITY PROBE (shell-cells `sidecar-curve-{n}`).
         `duck` and `env` here are the `duck @ FS` / `env @ FS` readouts verbatim
         while the cursor rests, and every field moves when it does not. -->
    <span class="cap" data-testid="sidecar-curve-cursor">{caption}</span>
    {#if curve.clipped}
      <!-- The y window is FIXED so a RATIO change is visible as a slope change;
           the cost is that the deepest settings run past the floor, and saying
           so beats drawing a flat bottom that reads as a limit the module has. -->
      <span class="clip" data-testid="sidecar-curve-clip">&gt;{-SIDECAR_CURVE_DUCK_FLOOR_DB}</span>
    {/if}
  </div>
</div>

<style>
  .sc-curve {
    width: 100%;
    display: grid;
    grid-template-rows: 1fr auto auto;
    gap: 3px;
  }

  .plot {
    appearance: none;
    display: block;
    width: 100%;
    padding: 0;
    border: 1px solid rgb(255 255 255 / 0.08);
    border-radius: 3px;
    background: rgb(0 0 0 / 0.35);
    cursor: crosshair;
  }
  .plot svg {
    display: block;
    width: 100%;
    height: 104px;
  }

  .grid {
    stroke: rgb(255 255 255 / 0.07);
    stroke-width: 1;
    vector-effect: non-scaling-stroke;
  }
  .thr {
    stroke: rgb(255 255 255 / 0.3);
    stroke-width: 1;
    stroke-dasharray: 3 3;
    vector-effect: non-scaling-stroke;
  }
  .onset {
    stroke: color-mix(in srgb, var(--domain, #4dd6c1) 60%, transparent);
    stroke-width: 1;
    vector-effect: non-scaling-stroke;
  }
  .curve {
    fill: none;
    stroke: var(--domain, #4dd6c1);
    stroke-width: 1.5;
    stroke-linejoin: round;
    vector-effect: non-scaling-stroke;
  }
  .cursor {
    stroke: rgb(255 255 255 / 0.45);
    stroke-width: 1;
    vector-effect: non-scaling-stroke;
  }
  .dot {
    fill: var(--domain, #4dd6c1);
    stroke: rgb(0 0 0 / 0.6);
    stroke-width: 1;
    vector-effect: non-scaling-stroke;
  }

  .axis,
  .foot {
    display: flex;
    align-items: baseline;
    gap: 6px;
    font-size: 9px;
    color: rgb(255 255 255 / 0.42);
    font-variant-numeric: tabular-nums;
  }
  .axis {
    justify-content: space-between;
  }
  .axis .unit {
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .key {
    flex: 0 0 auto;
    display: flex;
    gap: 8px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .k-thr {
    color: rgb(255 255 255 / 0.35);
  }
  .k-onset {
    color: var(--domain, #4dd6c1);
  }
  .cap {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-align: right;
  }
  .clip {
    flex: 0 0 auto;
    color: rgb(255 255 255 / 0.3);
  }
</style>
