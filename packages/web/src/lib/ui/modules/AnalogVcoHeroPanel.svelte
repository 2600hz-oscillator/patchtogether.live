<script lang="ts">
  // AnalogVcoHeroPanel — the faceplate's HERO: one cycle of ALL FIVE wave taps,
  // drawn from the live knobs through the DSP's own tap laws. The four fixed
  // taps are thin ghosts; MORPH is picked out in the domain hue.
  //
  // ⚠ WHY THE PICTURE EXISTS. analogVco is ONE phase accumulator with SIX taps,
  // and its six knobs do NOT all address the same tap. Drawing the five
  // together is what makes "SHAPE moves exactly one of these" VISIBLE instead
  // of written — and it is the only surface on which "PW moves SQUARE from
  // spawn but reaches MORPH only past WAVE 0.5" can be seen at all.
  //
  // ⚠ PARAM-DERIVED, NOT AN ANALYSER TRACE — the opposite of what the legacy
  // card does. That canvas reads `engine.read(node, 'waveform')` off an
  // AnalyserNode on the MORPH output, so it draws a flat line on a rack that is
  // not sounding (i.e. most of the time you are looking at it, and exactly the
  // state every VRT scene captures) and shows only ONE of the five taps.
  //
  // ⚠ SVG, NOT CANVAS, and no rAF: the two new VRT scenes stay deterministic
  // with no mask — which matters, because a masked hero picture asserts nothing.
  //
  // ⚠ THIS PANEL EMITS NO `control-<paramId>` TESTID (shell-cells rule 1).
  // TUNE is not re-rendered here: it is the promoted `hero.control` sitting
  // beside this panel, and a duplicate would fail faces-parity's exact param
  // multiset.

  import { patch } from '$lib/graph/store';
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
  import {
    VCO_TAPS,
    vcoCyclePoints,
    vcoFaceParams,
    vcoKnobHz,
    type VcoFaceParams,
    type VcoTap,
  } from './analog-vco-face-model';

  interface Props {
    nodeId: string;
  }
  let { nodeId }: Props = $props();

  /** ⚠ THE VERSION IS CARRIED IN THE RESULT (the ModuleShell `liveCell`
   *  pattern) — a bare SyncedStore proxy is `===` to itself and the picture
   *  would freeze at the values it first read. */
  let live = $derived.by(() => ({ v: nodeVersion(nodeId), n: patch.nodes[nodeId] }));

  let p = $derived.by<VcoFaceParams>(() =>
    vcoFaceParams((id) => {
      const v = live.n?.params?.[id];
      return typeof v === 'number' ? v : undefined;
    }),
  );

  /** The plotted window in CYCLES. ⚠ COMPONENT STATE, never `node.data`: a
   *  private view setting must not re-zoom every collaborator's plot or dirty
   *  the patch (the kickdrum `windowMs` argument verbatim). */
  let cycles = $state<1 | 2>(1);

  const PLOT_W = 100;
  const PLOT_H = 100;
  const N = 400;

  function poly(tap: VcoTap): string {
    return vcoCyclePoints(tap, p.shape, p.pw, cycles, N)
      .map((q) => `${(q.x * PLOT_W).toFixed(2)},${((1 - (q.y + 1) / 2) * PLOT_H).toFixed(2)}`)
      .join(' ');
  }

  let ghosts = $derived(VCO_TAPS.filter((t) => t !== 'morph').map((t) => ({ t, pts: poly(t) })));
  let morphPts = $derived(poly('morph'));

  /** The window's own caption: the period the KNOBS currently imply. It is what
   *  the CYCLES button drives, and therefore the panel's operability probe. */
  let axisText = $derived(
    `${cycles} cycle${cycles === 1 ? '' : 's'} · ${((1000 * cycles) / vcoKnobHz(p)).toFixed(1)} ms`,
  );
</script>

<div class="vco-hero" data-testid="analogvco-cycle">
  <svg
    viewBox="0 0 {PLOT_W} {PLOT_H}"
    preserveAspectRatio="none"
    role="img"
    aria-label="one cycle of the saw, square, triangle, sine and morph taps at the current knobs"
  >
    <line class="mid" x1="0" x2={PLOT_W} y1={PLOT_H / 2} y2={PLOT_H / 2} />
    {#each ghosts as g (g.t)}
      <polyline class="ghost" points={g.pts} />
    {/each}
    <polyline class="morph" points={morphPts} />
  </svg>

  <div class="axis">
    <span class="key">
      <span class="k-ghost">saw · square · triangle · sine</span>
      <span class="k-morph">morph</span>
    </span>
    <span class="span" data-testid="analogvco-cycle-axis">{axisText}</span>
    <button
      type="button"
      class="win"
      data-testid="analogvco-cycle-window"
      title="Plot window — show {cycles === 1 ? 2 : 1} cycle{cycles === 1
        ? 's'
        : ''}. Your screen only: this is not shared with the rackspace or saved with the patch."
      onclick={() => (cycles = cycles === 1 ? 2 : 1)}
    >{cycles}×</button>
  </div>
</div>

<style>
  .vco-hero {
    width: 100%;
    display: grid;
    grid-template-rows: 1fr auto;
    gap: 3px;
  }

  .vco-hero svg {
    width: 100%;
    height: 104px;
    display: block;
    background: rgb(0 0 0 / 0.35);
    border: 1px solid rgb(255 255 255 / 0.08);
    border-radius: 3px;
  }

  .ghost,
  .morph,
  .mid {
    fill: none;
    vector-effect: non-scaling-stroke;
  }
  /* The four fixed taps are THIN GHOSTS — they are what SHAPE does NOT move. */
  .ghost {
    stroke: rgb(255 255 255 / 0.22);
    stroke-width: 1;
  }
  /* MORPH in the module's DOMAIN hue: the one tap SHAPE addresses. */
  .morph {
    stroke: var(--domain, #4dd6c1);
    stroke-width: 1.6;
  }
  .mid {
    stroke: rgb(255 255 255 / 0.1);
    stroke-width: 1;
  }

  .axis {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 9px;
    color: rgb(255 255 255 / 0.42);
    font-variant-numeric: tabular-nums;
  }
  .key {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    gap: 8px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    overflow: hidden;
  }
  .k-ghost {
    color: rgb(255 255 255 / 0.35);
  }
  .k-morph {
    color: var(--domain, #4dd6c1);
  }
  .span {
    flex: 0 0 auto;
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
</style>
