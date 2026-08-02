<script lang="ts">
  // KickdrumHeroPanel — the faceplate's HERO VISUALISATION.
  //
  // The amplitude + pitch-sweep graph the design mock puts at the top of the
  // face, plus the output meter block (PEAK / ACCENT / V·OCT) beside it. It is
  // promoted into the platform's hero slot by `face.hero.cell`.
  //
  // ⚠ NOT A DRAWING. Every point comes from `kickdrum-face-model`, which
  // computes them through the WORKLET'S OWN functions (`decayCoeff`,
  // `kickSubFreqHz`, `kickBodyFreqHz`) off the LIVE param values. Turn SUB DEC
  // and the curve stretches; turn P AMT and the chirp starts higher. The
  // model's tests negative-control exactly that (perturb the param, assert the
  // number moves), because a hero graph that sits still while the knobs move is
  // a picture of A kick, not of THIS kick.
  //
  // ⚠ THE NUMBERS BESIDE IT ARE NOT DRAWN HERE. `TAIL` / `SWEEP` / `SETTLES TO`
  // are the platform's hero READOUTS, declared on the def (`face.hero
  // .readouts`) and painted by ModuleShell — TAIL through the derived-value
  // registry, which is what stops it being a `sub_decay` readback. A caption
  // baked into this component would be a second, per-module readout mechanism
  // saying the same three things, which is how two faceplates end up
  // formatting one number two ways.
  //
  // ⚠ THIS PANEL EMITS NO `control-<paramId>` TESTID (shell-cells rule 1). Its
  // one writable affordance is the plot WINDOW, which is PRIVATE VIEW STATE —
  // see the note on `windowMs`. TUNE and STRIKE are NOT re-rendered here even
  // though the mock groups them with the hero: they are promoted cells of the
  // same hero rail and already sit beside this panel, and a duplicate
  // `control-tune` would break faces-parity's exact param multiset (the gate
  // that proves no control was lost).

  import { patch } from '$lib/graph/store';
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
  import { useEngine } from '$lib/audio/engine-context';
  import { VuMeter } from '$lib/ui/controls';
  import { createShellGlyphTap, type ShellGlyphTap } from '$lib/ui/workflow/shell-glyph-live';
  import {
    fmtHz,
    kickdrumEnvelopeParams,
    kickdrumGraph,
    unwarpX,
    type KickdrumEnvelopeParams,
  } from './kickdrum-face-model';

  interface Props {
    nodeId: string;
  }
  let { nodeId }: Props = $props();

  const engineCtx = useEngine();

  /**
   * ⚠ THE VERSION IS CARRIED IN THE RESULT (the ModuleShell `liveCell`
   * pattern). `patch.nodes[id]` is a stable SyncedStore proxy: a derived that
   * bumps on `nodeVersion(id)` and returns it bare is `===` to its previous
   * value, Svelte suppresses the invalidation, and this whole graph freezes at
   * the values it first read — the worst possible failure for a display whose
   * entire claim is that it moves with the knobs. Making the TICK the identity
   * is what re-runs the projection on every bump.
   */
  let live = $derived.by(() => ({ v: nodeVersion(nodeId), n: patch.nodes[nodeId] }));

  /** The envelope params off the live node, with the def's defaults for
   *  anything untouched — resolved in the model, which owns that fallback. */
  let envParams = $derived.by<KickdrumEnvelopeParams>(() =>
    kickdrumEnvelopeParams((id) => {
      const v = live.n?.params?.[id];
      return typeof v === 'number' ? v : undefined;
    }),
  );

  /**
   * The plotted window, ms. 600 covers the default voice; 1200 covers the
   * longest tail `sub_decay`'s maximum can produce (SUB BOOM's is over 700 ms).
   *
   * ⚠ COMPONENT STATE, NOT `node.data`. An earlier draft stored it on the node,
   * which puts it in the Y.Doc: one player zooming their own plot would have
   * re-zoomed every collaborator's screen AND dirtied the patch, for a setting
   * that changes no sound. `node.data` is for patch DESIGN (the DX7's operator
   * values); a private view setting is not that. The cost is that the panel's
   * operability probe cannot read `node.data` — so it asserts the AXIS LABELS
   * moved instead, which a dead button cannot fake (shell-cells `text` probe).
   */
  const WINDOWS_MS = [600, 1200] as const;
  let windowMs = $state<number>(WINDOWS_MS[0]);
  let graph = $derived(kickdrumGraph(envParams, windowMs));

  // ── the plot, in a 0..100 × 0..100 viewBox ─────────────────────────────
  const PLOT_W = 100;
  const PLOT_H = 100;

  /** The live PEAK, formatted. `getLevel` is the 0..1 RMS the meter paints;
   *  printing it in dBFS is what a `PEAK` caption means, and `-∞` is the honest
   *  answer for silence rather than a made-up floor number. */
  let peakText = $state('−∞ dB');

  /** A polyline `points` string for one series (`amp` or `pitch`). */
  function series(key: 'amp' | 'pitch'): string {
    return graph.points
      .map((p) => `${(p.x * PLOT_W).toFixed(2)},${((1 - p[key]) * PLOT_H).toFixed(2)}`)
      .join(' ');
  }

  /** The amplitude series closed into a filled area under the curve. */
  let ampArea = $derived(`0,${PLOT_H} ${series('amp')} ${PLOT_W},${PLOT_H}`);

  /**
   * Time gridlines. The axis is WARPED (t = x²·window — see `warpX`), so an
   * evenly-spaced grid would be a lie about where the time is; these are placed
   * at fixed PLOT positions and LABELLED with the time that actually falls
   * there, which is the only honest way round.
   */
  let ticks = $derived(
    [0.25, 0.5, 0.75].map((x) => ({ x, ms: Math.round(unwarpX(x, windowMs)) })),
  );

  // ── the meter block ─────────────────────────────────────────────────────
  //
  // PEAK is LIVE, off the same analyser seam the shell's own glyph uses (one
  // tap on the module's primary audio output; it self-detaches when nobody
  // reads it). ACCENT and V·OCT are not readable as values — accent is LATCHED
  // inside the worklet at the strike edge and pitch_cv is a per-sample audio
  // input — so they report the thing that IS knowable and that a player
  // actually needs from a faceplate: whether the jack is PATCHED, and what the
  // voice is therefore tracking. A readout that invented a number for them
  // would be the "wrong metric reads exactly like a finding" trap in CLAUDE.md.
  //
  // ⚠ THE TEARDOWN IS THE `$effect` CLEANUP, and it is the ONLY teardown. Svelte
  // runs it on destroy as well as on re-run, so a belt-and-braces `onDestroy`
  // beside it would be a second owner of one resource — and the tap holds a
  // live AnalyserNode plus an idle-release interval, which is exactly the kind
  // of thing that must have one owner.
  let tap: ShellGlyphTap | null = null;
  $effect(() => {
    const t = createShellGlyphTap(() => engineCtx.get(), nodeId, 'audio_l');
    tap = t;
    return () => {
      t.dispose();
      if (tap === t) tap = null;
    };
  });

  function getLevel(): number {
    return tap?.getLevel() ?? 0;
  }

  /**
   * The PEAK figure, polled beside the meter it labels.
   *
   * ⚠ THIS `<dd>` USED TO PRINT THE LITERAL STRING `out L`. That is a SOURCE
   * LABEL, not a peak — a caption reading `PEAK  out L` states nothing about
   * the signal and is indistinguishable, from the render, from a meter that
   * never got a tap. It now prints the live level in dBFS off the SAME
   * `getLevel` seam the bar paints from, so the number and the bar cannot
   * disagree, and `−∞ dB` is the honest reading for silence.
   *
   * 100 ms, not rAF: this is a text row, and repainting a string 60×/s on
   * every open faceplate is real main-thread cost for no readable gain. The
   * interval is torn down by the same effect cleanup that owns it.
   */
  $effect(() => {
    const tick = (): void => {
      const v = getLevel();
      peakText = v > 1e-4 ? `${(20 * Math.log10(Math.min(1, v))).toFixed(1)} dB` : '−∞ dB';
    };
    tick();
    const h = setInterval(tick, 100);
    return () => clearInterval(h);
  });

  /** Is `portId` the target of any cable? (Pure read off the live edge map.)
   *  The entries are typed `Edge | undefined` under `noUncheckedIndexedAccess`,
   *  and a Y.Map projection really can hand back a hole mid-transaction. */
  function patched(portId: string): boolean {
    return Object.values(patch.edges).some(
      (e) => e?.target.nodeId === nodeId && e?.target.portId === portId,
    );
  }

  let accentText = $derived(patched('accent_in') ? 'CV' : 'FIXED');
  let voctText = $derived(
    patched('pitch_cv') ? `TRACK ${fmtHz(envParams.tune)}` : fmtHz(envParams.tune),
  );
</script>

<div class="kick-hero" data-testid="kickdrum-hero">
  <div class="plot">
    <svg
      viewBox="0 0 {PLOT_W} {PLOT_H}"
      preserveAspectRatio="none"
      role="img"
      aria-label="amplitude and pitch sweep over the first {windowMs} ms after the strike"
    >
      <!-- Time gridlines at fixed PLOT positions, labelled below with the time
           that actually falls there (the axis is warped, so an evenly-spaced
           grid of round numbers would be the lie). -->
      {#each ticks as t (t.x)}
        <line class="grid" x1={t.x * PLOT_W} x2={t.x * PLOT_W} y1="0" y2={PLOT_H} />
      {/each}
      <!-- The BODY's resting pitch: an octave over the fundamental, which is
           where the punch actually lands. Drawn because the pitch trace stops
           THERE rather than at the floor (see KickdrumGraph.bodySettledY). -->

      <line
        class="octave"
        x1="0"
        x2={PLOT_W}
        y1={(1 - graph.bodySettledY) * PLOT_H}
        y2={(1 - graph.bodySettledY) * PLOT_H}
      />
      <polygon class="amp-fill" points={ampArea} />
      <polyline class="amp" points={series('amp')} />
      <polyline class="pitch" points={series('pitch')} />
      {#if graph.tailX !== null}
        <line class="tail" x1={graph.tailX * PLOT_W} x2={graph.tailX * PLOT_W} y1="0" y2={PLOT_H} />
      {/if}
    </svg>
    <div class="axis">
      <!-- ⚠ THE AXIS ROW IS THE PANEL'S OPERABILITY PROBE TARGET. Its labels
           are computed from the window through the warp, so a WINDOW button
           that did nothing cannot change them — which is what makes the `text`
           probe on this element a real liveness assertion rather than a button
           relabelling itself. -->
      <span class="axis-ticks" data-testid="kickdrum-graph-axis">
        <span>0</span>
        {#each ticks as t (t.x)}<span>{t.ms} ms</span>{/each}
      </span>
      <button
        type="button"
        class="win"
        data-testid="kickdrum-graph-window"
        title="Plot window — flip to {windowMs === WINDOWS_MS[0]
          ? WINDOWS_MS[1]
          : WINDOWS_MS[0]} ms (a long tail can outrun the short view). Your screen only: this is not shared or saved."
        onclick={() => (windowMs = windowMs === WINDOWS_MS[0] ? WINDOWS_MS[1] : WINDOWS_MS[0])}
      >{windowMs} ms</button>
    </div>
    <div class="key">
      <span class="k-amp">amplitude</span>
      <span class="k-pitch">pitch sweep</span>
    </div>
  </div>

  <div class="meter" data-testid="kickdrum-meter">
    <VuMeter {getLevel} orientation="vertical" length={78} thickness={10} testid="kickdrum-vu" />
    <dl>
      <div><dt>peak</dt><dd data-testid="kickdrum-peak">{peakText}</dd></div>
      <div><dt>accent</dt><dd data-testid="kickdrum-accent">{accentText}</dd></div>
      <div><dt>v·oct</dt><dd data-testid="kickdrum-voct">{voctText}</dd></div>
    </dl>
  </div>
</div>

<style>
  .kick-hero {
    display: flex;
    gap: 10px;
    align-items: stretch;
    width: 100%;
  }

  .plot {
    flex: 1 1 auto;
    min-width: 0;
    margin: 0;
    display: grid;
    grid-template-rows: 1fr auto auto;
    gap: 3px;
  }

  .plot svg {
    width: 100%;
    height: 104px;
    display: block;
    background: rgb(0 0 0 / 0.35);
    border: 1px solid rgb(255 255 255 / 0.08);
    border-radius: 3px;
  }

  /* The traces stroke in the module's DOMAIN hue (the spine cable colour the
     shell sets on the tile), so the hero reads as part of the same instrument
     as every other live surface. `vector-effect` keeps a 1px stroke 1px wide
     under the non-uniform viewBox scale (preserveAspectRatio="none" stretches
     x and y by different factors, which would otherwise smear the strokes). */
  .amp,
  .pitch,
  .octave,
  .tail {
    fill: none;
    vector-effect: non-scaling-stroke;
  }
  .amp {
    stroke: var(--domain, #4dd6c1);
    stroke-width: 1.5;
  }
  .amp-fill {
    fill: color-mix(in srgb, var(--domain, #4dd6c1) 18%, transparent);
    stroke: none;
  }
  .pitch {
    stroke: #f0a44a;
    stroke-width: 1.25;
    stroke-dasharray: 3 2;
  }
  .octave {
    stroke: rgb(255 255 255 / 0.16);
    stroke-width: 1;
    stroke-dasharray: 1 3;
  }
  .grid {
    stroke: rgb(255 255 255 / 0.07);
    stroke-width: 1;
  }
  .tail {
    stroke: rgb(255 255 255 / 0.3);
    stroke-width: 1;
    stroke-dasharray: 2 2;
  }

  /* The tick labels sit at the SAME fractions the gridlines do (0.25 / 0.5 /
     0.75 of the plot), which a grid row with equal-basis items reproduces
     without a second copy of the numbers. */
  .axis {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 9px;
    color: rgb(255 255 255 / 0.42);
    font-variant-numeric: tabular-nums;
  }
  .axis-ticks {
    flex: 1 1 auto;
    min-width: 0;
    display: grid;
    grid-template-columns: repeat(4, 1fr);
  }
  .axis-ticks > span {
    text-align: left;
  }

  .win {
    appearance: none;
    background: rgb(255 255 255 / 0.06);
    border: 1px solid rgb(255 255 255 / 0.12);
    border-radius: 3px;
    color: inherit;
    font: inherit;
    padding: 1px 5px;
    cursor: pointer;
    font-variant-numeric: tabular-nums;
  }
  .win:hover {
    background: rgb(255 255 255 / 0.12);
  }

  .key {
    display: flex;
    gap: 10px;
    font-size: 9px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .k-amp {
    color: var(--domain, #4dd6c1);
  }
  .k-pitch {
    color: #f0a44a;
  }

  .meter {
    flex: 0 0 auto;
    display: flex;
    gap: 6px;
    align-items: flex-start;
    max-width: 118px;
  }
  .meter dl {
    margin: 0;
    display: grid;
    gap: 3px;
    align-content: start;
    min-width: 0;
  }
  .meter dl > div {
    display: grid;
    gap: 0;
    min-width: 0;
  }
  .meter dt {
    font-size: 8px;
    letter-spacing: 0.09em;
    text-transform: uppercase;
    color: rgb(255 255 255 / 0.4);
  }
  .meter dd {
    margin: 0;
    font-size: 10px;
    color: rgb(255 255 255 / 0.82);
    font-variant-numeric: tabular-nums;
  }
</style>
