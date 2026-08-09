<script lang="ts">
  // MacrooscillatorHeroPanel — the faceplate's HERO: a short window of the
  // CURRENT engine at the CURRENT macros, with OUT solid and AUX as a ghost,
  // drawn from the live knobs through the module's own pure-math mirror.
  //
  // ⚠ WHY THE PICTURE EXISTS, AND WHY IT IS NOT A SCOPE. A `scope` glyph shows
  // the OUTPUT — which on this module is a flat line most of the time you are
  // looking at it, because five of the fourteen engines are silent with nothing
  // patched into TRIG and a rack at rest is not sounding. This is a picture of
  // the PATCH: it says what the voice WILL do before anything has struck it,
  // which is the only way "what does GRANULAR sound like at these macros"
  // becomes answerable without wiring a trigger first.
  //
  // ⚠ AND IT IS THE ONLY SURFACE THAT SHOWS THE OUT/AUX RELATIONSHIP. AUX is a
  // sibling rendering of the same note and is NOT scaled by LEVEL, so the two
  // outputs are routinely far apart — at LEVEL 0, OUT is a flat line while AUX
  // is unchanged at full scale on eight engines. Drawing both at ONE shared
  // gain is what makes that a picture rather than a sentence.
  //
  // ⚠ TWO CAPTIONS CARRY FACTS THE PICTURE WOULD OTHERWISE HIDE:
  //   • THE GAIN. MODAL peaks at 0.0028, so an un-scaled trace is a flat line —
  //     indistinguishable from silence, and from the WAVETABLE-morph kind of
  //     dead control this face exists to expose. `×357` beside the trace is the
  //     difference between "very quiet" and "broken".
  //   • THE LEAD-IN. MODAL's exciter is a fixed 4 Hz impulse train, so its
  //     first non-zero sample is #11999 (250.0 ms, measured). A 43 ms window
  //     drawn from t=0 would show nothing at all, so the window is opened after
  //     a quarter-second warm-up — and the caption says so, because a picture
  //     that silently skips a quarter of a second is lying by omission.
  //
  // ⚠ SVG, NOT CANVAS, AND NO rAF — the two new VRT scenes stay deterministic
  // with no mask, and a masked hero picture asserts nothing.
  //
  // ⚠ THIS PANEL EMITS NO `control-<paramId>` TESTID (shell-cells rule 1).
  // Nothing here re-renders a dial: the six params are all in their bands.

  import { patch } from '$lib/graph/store';
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
  import {
    fmtMacroGain,
    macroEngine,
    macroFaceParams,
    macroHeroTrace,
    type MacroFaceParams,
  } from './macrooscillator-face-model';

  interface Props {
    nodeId: string;
  }
  let { nodeId }: Props = $props();

  /** ⚠ THE VERSION IS CARRIED IN THE RESULT (the ModuleShell `liveCell`
   *  pattern) — a bare SyncedStore proxy is `===` to itself, so the picture
   *  would freeze at whatever values it first read. */
  let live = $derived.by(() => ({ v: nodeVersion(nodeId), n: patch.nodes[nodeId] }));

  let p = $derived.by<MacroFaceParams>(() =>
    macroFaceParams((id) => {
      const v = live.n?.params?.[id];
      return typeof v === 'number' ? v : undefined;
    }),
  );

  /** ⚠ A FIXED RATE, DELIBERATELY. The picture must be byte-identical across
   *  machines for the dock VRT scene, and a 44.1 vs 48 kHz host would otherwise
   *  move every trace by a few pixels. The window is expressed in ms from this
   *  rate, so the caption stays honest. */
  const PLOT_SR = 48000;
  const PLOT_W = 200;
  const PLOT_H = 100;
  const COLUMNS = 200;

  /** FIT normalises the taller trace into the box and prints the gain; TRUE
   *  draws both against full scale. ⚠ COMPONENT STATE, never `node.data`: a
   *  private view setting must not re-scale every collaborator's plot or dirty
   *  the patch (the kickdrum `windowMs` argument verbatim). */
  let fit = $state(true);

  let engine = $derived(macroEngine(p));
  let trace = $derived(macroHeroTrace(p, PLOT_SR, COLUMNS));
  let gain = $derived(fit ? 1 : trace.gain > 0 ? 1 / trace.gain : 1);

  /** One filled min/max band per trace — an envelope, not a polyline, so a
   *  window holding 10 samples per column cannot alias into a fake waveform. */
  function band(cols: readonly (readonly [number, number])[]): string {
    const w = PLOT_W / Math.max(1, cols.length);
    const top: string[] = [];
    const bot: string[] = [];
    for (let i = 0; i < cols.length; i++) {
      const x = (i + 0.5) * w;
      const hi = Math.max(-1, Math.min(1, cols[i]![1] * gain));
      const lo = Math.max(-1, Math.min(1, cols[i]![0] * gain));
      top.push(`${x.toFixed(2)},${((1 - (hi + 1) / 2) * PLOT_H).toFixed(2)}`);
      bot.unshift(`${x.toFixed(2)},${((1 - (lo + 1) / 2) * PLOT_H).toFixed(2)}`);
    }
    return `${top.join(' ')} ${bot.join(' ')}`;
  }

  let outPts = $derived(band(trace.out));
  let auxPts = $derived(band(trace.aux));

  /** The caption the SCALE button drives — and therefore the panel's
   *  operability probe. It names the window, the display gain and (only when
   *  there is one) the lead-in that had to be skipped. */
  let caption = $derived(
    [
      `${engine.name} · ${trace.windowMs.toFixed(0)} ms`,
      fit ? fmtMacroGain(trace.gain) : '×1 true',
      trace.warmupMs > 0 ? `after ${trace.warmupMs.toFixed(0)} ms lead-in` : null,
    ]
      .filter(Boolean)
      .join(' · '),
  );
</script>

<div class="macro-hero" data-testid="macro-hero">
  <svg
    viewBox="0 0 {PLOT_W} {PLOT_H}"
    preserveAspectRatio="none"
    role="img"
    aria-label="{engine.name}: the OUT and AUX outputs over {trace.windowMs.toFixed(
      0,
    )} ms at the current macro settings"
  >
    <line class="mid" x1="0" x2={PLOT_W} y1={PLOT_H / 2} y2={PLOT_H / 2} />
    <!-- AUX first, so OUT draws over it. AUX is the one that is NOT scaled by
         LEVEL, which is why it is often the taller of the two. -->
    <polygon class="aux" points={auxPts} />
    <polygon class="out" points={outPts} />
  </svg>

  <div class="axis">
    <span class="key">
      <span class="k-out">out</span>
      <span class="k-aux">aux</span>
    </span>
    <span class="cap" data-testid="macro-hero-caption">{caption}</span>
    <button
      type="button"
      class="scale"
      data-testid="macro-hero-scale"
      title="Vertical scale — {fit
        ? 'switch to TRUE amplitude (full scale = the box), which is how quiet this engine really is'
        : 'switch to FIT (normalise the taller trace and print the gain)'}. Your screen only: not shared with the rackspace, not saved with the patch."
      onclick={() => (fit = !fit)}>{fit ? 'fit' : '1:1'}</button
    >
  </div>
</div>

<style>
  .macro-hero {
    width: 100%;
    display: grid;
    grid-template-rows: 1fr auto;
    gap: 3px;
  }

  .macro-hero svg {
    width: 100%;
    height: 104px;
    display: block;
    background: rgb(0 0 0 / 0.35);
    border: 1px solid rgb(255 255 255 / 0.08);
    border-radius: 3px;
  }

  .mid {
    fill: none;
    stroke: rgb(255 255 255 / 0.1);
    stroke-width: 1;
    vector-effect: non-scaling-stroke;
  }
  /* OUT in the module's DOMAIN hue — the signal you patch. */
  .out {
    fill: color-mix(in srgb, var(--domain, #4dd6c1) 55%, transparent);
    stroke: none;
  }
  /* AUX as a ghost: present, comparable in HEIGHT, visibly secondary. */
  .aux {
    fill: rgb(255 255 255 / 0.16);
    stroke: none;
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
    flex: 0 0 auto;
    display: flex;
    gap: 8px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .k-out {
    color: var(--domain, #4dd6c1);
  }
  .k-aux {
    color: rgb(255 255 255 / 0.35);
  }
  .cap {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-align: right;
  }

  .scale {
    appearance: none;
    background: rgb(255 255 255 / 0.06);
    border: 1px solid rgb(255 255 255 / 0.12);
    border-radius: 3px;
    color: inherit;
    font: inherit;
    padding: 1px 5px;
    cursor: pointer;
    flex: 0 0 auto;
  }
  .scale:hover {
    background: rgb(255 255 255 / 0.12);
  }
</style>
