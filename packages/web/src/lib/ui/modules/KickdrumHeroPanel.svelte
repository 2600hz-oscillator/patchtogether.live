<script lang="ts">
  // KickdrumHeroPanel — the faceplate's HERO VISUALISATION.
  //
  // The amplitude + pitch-sweep graph the design mock puts at the top of the
  // face, with its `tail ≈ 398 ms · +24 st → 50 Hz` caption, plus the output
  // meter block (PEAK / ACCENT / V·OCT) that sits beside it.
  //
  // ⚠ NOT A DRAWING. Every point and every number comes from
  // `kickdrum-face-model`, which computes them through the WORKLET'S OWN
  // functions (`decayCoeff`, `kickSubFreqHz`, `kickBodyFreqHz`) off the LIVE
  // param values. Turn SUB DEC and the curve stretches; turn P AMT and the
  // chirp starts higher; turn TUNE and the caption's target Hz follows. The
  // model's tests negative-control exactly that (perturb the param, assert the
  // number moves), because a hero graph that sits still while the knobs move is
  // a picture of A kick, not of THIS kick.
  //
  // ⚠ THIS PANEL EMITS NO `control-<paramId>` TESTID (shell-cells rule 1). Its
  // one writable affordance is the graph WINDOW, which is view state on
  // `node.data` — that is also the operability probe the parity sweep drives.
  // TUNE and STRIKE are NOT re-rendered here even though the mock groups them
  // with the hero: they are real cells of band 1 and already sit beside this
  // panel, and a duplicate `control-tune` would break faces-parity's exact
  // param multiset (which is the gate that proves no control was lost).

  import { patch } from '$lib/graph/store';
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
  import { useEngine } from '$lib/audio/engine-context';
  import { onDestroy } from 'svelte';
  import { VuMeter } from '$lib/ui/controls';
  import { kickdrumDef } from '$lib/audio/modules/kickdrum';
  import { createShellGlyphTap, type ShellGlyphTap } from '$lib/ui/workflow/shell-glyph-live';
  import {
    fmtHz,
    kickdrumGraph,
    kickdrumHeroCaption,
    unwarpX,
    type KickdrumEnvelopeParams,
  } from './kickdrum-face-model';
  import {
    KICK_GRAPH_WINDOWS_MS,
    kickdrumGraphWindowMs,
    toggleKickdrumGraphWindow,
  } from './kickdrum-preset-actions';

  interface Props {
    nodeId: string;
  }
  let { nodeId }: Props = $props();

  const engineCtx = useEngine();

  /** The def's declared default for a param — the ONE source for every number
   *  this panel needs but the node has not stored yet (CLAUDE.md: a control's
   *  range/default comes from one place). Throws loudly on a rename. */
  function defaultOf(id: string): number {
    const p = kickdrumDef.params.find((q) => q.id === id);
    if (!p) throw new Error(`KickdrumHeroPanel: kickdrum has no param '${id}'`);
    return p.defaultValue;
  }

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

  let envParams = $derived.by<KickdrumEnvelopeParams>(() => {
    const n = live.n;
    const val = (id: string): number => {
      const v = n?.params?.[id];
      return typeof v === 'number' ? v : defaultOf(id);
    };
    return {
      tune: val('tune'),
      pitch_amt: val('pitch_amt'),
      pitch_time: val('pitch_time'),
      tension: val('tension'),
      sub_decay: val('sub_decay'),
      body_decay: val('body_decay'),
      click_len: val('click_len'),
      sub_level: val('sub_level'),
      body_level: val('body_level'),
      click_level: val('click_level'),
    };
  });

  let windowMs = $derived(kickdrumGraphWindowMs(live.n));
  let graph = $derived(kickdrumGraph(envParams, windowMs));
  let caption = $derived(kickdrumHeroCaption(envParams));

  // ── the plot, in a 0..100 × 0..100 viewBox ─────────────────────────────
  const PLOT_W = 100;
  const PLOT_H = 100;

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
  let tap: ShellGlyphTap | null = null;
  $effect(() => {
    const t = createShellGlyphTap(() => engineCtx.get(), nodeId, 'audio_l');
    tap = t;
    return () => {
      t.dispose();
      if (tap === t) tap = null;
    };
  });
  onDestroy(() => tap?.dispose());

  function getLevel(): number {
    return tap?.getLevel() ?? 0;
  }

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
  <!-- A plain <div>, not a <figure>: the caption sits directly under the plot
       and above the axis row, which `<figcaption>` may not do (it must be the
       first or last child). The SVG already carries `role="img"` + the caption
       text in its `aria-label`, so nothing accessible is lost. -->
  <div class="plot">
    <svg
      viewBox="0 0 {PLOT_W} {PLOT_H}"
      preserveAspectRatio="none"
      role="img"
      aria-label="amplitude and pitch sweep — {caption}"
    >
      <!-- The BODY's resting pitch: an octave over the fundamental, which is
           where the punch actually lands. Drawn because the pitch trace stops
           there rather than at the floor (see KickdrumGraph.bodySettledY). -->
      {#each ticks as t (t.x)}
        <line class="grid" x1={t.x * PLOT_W} x2={t.x * PLOT_W} y1="0" y2={PLOT_H} />
      {/each}
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
    <p class="caption" data-testid="kickdrum-hero-caption">{caption}</p>
    <div class="axis">
      <span>0</span>
      {#each ticks as t (t.x)}<span>{t.ms} ms</span>{/each}
      <button
        type="button"
        class="win"
        data-testid="kickdrum-graph-window"
        title="Plot window — flip to {windowMs === KICK_GRAPH_WINDOWS_MS[0]
          ? KICK_GRAPH_WINDOWS_MS[1]
          : KICK_GRAPH_WINDOWS_MS[0]} ms (a long tail can outrun the short view)"
        onclick={() => toggleKickdrumGraphWindow(nodeId, live.n)}
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
      <div><dt>peak</dt><dd data-testid="kickdrum-peak">out L</dd></div>
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
    grid-template-rows: 1fr auto auto auto;
    gap: 3px;
  }

  .plot svg {
    width: 100%;
    height: 92px;
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

  .caption {
    margin: 0;
    font-size: 10px;
    letter-spacing: 0.04em;
    color: rgb(255 255 255 / 0.78);
    font-variant-numeric: tabular-nums;
  }

  /* The tick labels sit at the SAME fractions the gridlines do (0.25 / 0.5 /
     0.75 of the plot), which a flex row with equal-basis items reproduces
     without a second copy of the numbers. */
  .axis {
    display: grid;
    grid-template-columns: repeat(4, 1fr) auto;
    align-items: center;
    font-size: 9px;
    color: rgb(255 255 255 / 0.42);
    font-variant-numeric: tabular-nums;
  }
  .axis > span {
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
