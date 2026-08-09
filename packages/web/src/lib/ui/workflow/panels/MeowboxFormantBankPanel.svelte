<script lang="ts">
  // FORMANT BANK — a registered `custom` dock-sidebar panel (PF-20).
  //
  // The picture: three resonance peaks on a LOG frequency ruler, with the four
  // source partials (F · 2F · 3F · 4F) marked underneath. It says in one glance
  // the two things this voice most needs to say and that no knob can:
  //
  //   1. WHICH HARMONIC IS INSIDE WHICH FORMANT. The excitation is a fixed
  //      harmonic stack on the SETTLED fundamental; the formants move with MORPH
  //      and not with PITCH. So playing an octave up walks the partials across a
  //      stationary bank, and that is what makes a cat sound like a different
  //      cat rather than the same one transposed.
  //   2. THE PEAKS ARE DRAWN AT `a·Q`, NOT AT `a`. `fi.resonbp(fc, Q, gain)` has
  //      |H(fc)| = gain·Q exactly, so band 1's height goes 6 → 14 across morph
  //      0.5 → 0.75 (+7.36 dB) while its amplitude-table weight sits flat at 1.0
  //      the whole way. A picture drawn from the `a` table would be MOTIONLESS
  //      across that move. That is the same blindness the `meowbox-formant-gain`
  //      readout is negative-controlled against, made visual.
  //
  // ⚠ NOT A TRACE. Every point comes from `meowbox-face-model`, which mirrors the
  // .dsp's own crossfade over the live params — so the picture says what the
  // voice WILL do before anything has gated it, which is what a `scope` glyph on
  // a silent rack cannot do. (This module is bit-silent with no gate patched.)
  //
  // ⚠ THE WINDOW IS FIXED at 80 Hz – 10 kHz, not fitted to the current formants.
  // A window that rescaled with MORPH would make every anchor look identical,
  // which is the one thing this picture exists to disprove.
  //
  // ⚠ It emits NO `control-<paramId>` testid — it is a READ-ONLY picture, and a
  // control-shaped testid would read as an unbacked extra control to
  // faces-parity's exact multiset (see sidebar-panels.ts rule 1).

  import { patch } from '$lib/graph/store';
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
  import type { ModuleNode, ParamDef } from '$lib/graph/types';
  import {
    MEOWBOX_PLOT_MAX_HZ,
    MEOWBOX_PLOT_MIN_HZ,
    meowboxBands,
    meowboxParams,
    meowboxPartials,
    meowboxPeakCeiling,
    meowboxPlotX,
    type MeowboxParams,
  } from '$lib/ui/modules/meowbox-face-model';

  interface Props {
    nodeId: string;
    props?: Readonly<Record<string, string | number>>;
    /** The def's params — needed for the DEFAULT fallback below. */
    params?: readonly ParamDef[];
  }
  let { nodeId, params = [] }: Props = $props();

  /**
   * ⚠ THE `?? defaultValue` IS LOAD-BEARING, not defensive noise. `node.params`
   * is a SPARSE overlay of what has been TOUCHED, so reading it bare prints the
   * wrong picture on a fresh spawn — the scar StereoCrossoverPanel carries in its
   * own header. `meowboxParams` resolves the gap against the def, and the def
   * params are passed in here so the panel never imports the registry.
   *
   * ⚠ THE VERSION IS READ INSIDE THE DERIVED (the ModuleShell `liveCell`
   * pattern): `patch.nodes[id]` is a stable SyncedStore proxy, so a derived that
   * does not touch `nodeVersion(id)` freezes at first render.
   */
  let voice = $derived.by<MeowboxParams>(() => {
    void nodeVersion(nodeId);
    const n = patch.nodes[nodeId] as ModuleNode | undefined;
    const live = n?.params as Record<string, number> | undefined;
    return meowboxParams((id) => {
      const v = live?.[id];
      if (typeof v === 'number') return v;
      return params.find((p) => p.id === id)?.defaultValue;
    });
  });

  const W = 100;
  const H = 44;
  /** The partial ticks live in the bottom strip; the peaks own the rest. */
  const FLOOR = 34;

  let ceiling = $derived(meowboxPeakCeiling(voice));
  let bands = $derived(meowboxBands(voice));
  let partials = $derived(meowboxPartials(voice));

  /**
   * One resonance peak as a polyline over the log axis.
   *
   * The shape is the resonbp magnitude itself rather than a decorative bump:
   * |H(f)| for `s = j·f/fc` in `gain·s / (s² + s/Q + 1)` is
   * `gain·(f/fc) / hypot(1 − (f/fc)², (f/fc)/Q)`. Sampling THAT is what makes a
   * high-Q band visibly narrow and a Q-0.5 band visibly a smear — the difference
   * between kitten and hiss on band 1, which is the whole point.
   */
  function peakPoints(hz: number, q: number, gain: number): string {
    const pts: string[] = [];
    const STEPS = 48;
    for (let i = 0; i <= STEPS; i++) {
      const t = i / STEPS;
      const f = MEOWBOX_PLOT_MIN_HZ * Math.pow(MEOWBOX_PLOT_MAX_HZ / MEOWBOX_PLOT_MIN_HZ, t);
      const r = hz > 0 ? f / hz : 0;
      const mag = r > 0 ? (gain * r) / Math.hypot(1 - r * r, r / q) : 0;
      const y = FLOOR - (Math.min(mag, ceiling) / ceiling) * (FLOOR - 3);
      pts.push(`${(t * W).toFixed(2)},${y.toFixed(2)}`);
    }
    return pts.join(' ');
  }

  /** Decade rules, so the log axis is readable as frequency and not just as
   *  "left is low". 100 Hz / 1 kHz / 10 kHz are the three inside the window. */
  const DECADES = [100, 1000, 10000] as const;
</script>

<div class="fbank" data-testid="sidebar-panel-formant-bank">
  <svg
    viewBox="0 0 {W} {H}"
    preserveAspectRatio="none"
    role="img"
    aria-label="the three formant peaks and the four source partials, on a log frequency axis"
  >
    {#each DECADES as d (d)}
      <line class="decade" x1={meowboxPlotX(d) * W} x2={meowboxPlotX(d) * W} y1="0" y2={FLOOR} />
    {/each}
    <line class="floor" x1="0" x2={W} y1={FLOOR} y2={FLOOR} />

    {#each bands as b, i (i)}
      <polyline class="peak peak-{i}" points={peakPoints(b.hz, b.q, b.gain)} />
    {/each}

    <!-- The four source partials, as stems from the floor. Height is the .dsp's
         own amplitude (1 / 0.5 / 0.25 / 0.125); a partial past the window's top
         end simply falls off the right, which is the honest picture of a note
         played high enough that its upper harmonics leave the bank. -->
    {#each partials as p, i (i)}
      {#if meowboxPlotX(p.hz) > 0 && p.hz < MEOWBOX_PLOT_MAX_HZ}
        <line
          class="partial"
          x1={meowboxPlotX(p.hz) * W}
          x2={meowboxPlotX(p.hz) * W}
          y1={FLOOR}
          y2={FLOOR + 2 + p.amp * 7}
        />
      {/if}
    {/each}
  </svg>
  <div class="fbank-legend">
    <span class="k-peak">3 formants · height = a×Q</span>
    <span class="k-partial">F · 2F · 3F · 4F</span>
  </div>
</div>

<style>
  .fbank {
    display: grid;
    gap: 3px;
  }
  .fbank svg {
    width: 100%;
    height: 62px;
    display: block;
    background: rgb(0 0 0 / 0.35);
    border: 1px solid rgb(255 255 255 / 0.08);
    border-radius: 3px;
  }
  .peak {
    fill: none;
    stroke: var(--domain, #4dd6c1);
    stroke-width: 1.25;
    vector-effect: non-scaling-stroke;
  }
  /* The three bands are the same hue at descending weight, so "which peak is
     which" reads without a colour key the sidebar has no room for. */
  .peak-1 { opacity: 0.62; }
  .peak-2 { opacity: 0.38; }
  .partial {
    stroke: #f0a44a;
    stroke-width: 1;
    vector-effect: non-scaling-stroke;
  }
  .decade {
    stroke: rgb(255 255 255 / 0.07);
    stroke-width: 1;
    vector-effect: non-scaling-stroke;
  }
  .floor {
    stroke: rgb(255 255 255 / 0.16);
    stroke-width: 1;
    vector-effect: non-scaling-stroke;
  }
  .fbank-legend {
    display: flex;
    justify-content: space-between;
    gap: 6px;
    font-size: 9px;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }
  .k-peak { color: var(--domain, #4dd6c1); }
  .k-partial { color: #f0a44a; }
</style>
