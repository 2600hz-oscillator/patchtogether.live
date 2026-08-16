<script lang="ts">
  // THE THREE MAPS — a registered `custom` dock-sidebar panel (PF-20) for
  // FEATURECV.
  //
  // One rail per feature CV, drawn on the LIVE POLARITY's output range, with
  // the rack's own generators marked where they land. The rail's left edge is
  // the jack's RESTING level (−1.00 bipolar, 0.00 unipolar) and its right edge
  // is full scale, so the picture answers the two questions a featurecv patch
  // actually raises: where does this jack sit when nothing is happening, and
  // how much of its range does my source use.
  //
  // ⚠ IT REPLACES A LIVE METER, AND THAT IS A DECISION MADE ON MEASUREMENT.
  // `FeaturecvCard.svelte` pumps three bars off `engine.read(node,'snapshot')`
  // every rAF, and the snapshot is the extractor's UNSMOOTHED, always-UNIPOLAR
  // target — so those bars disagree with the jacks they are named after: at the
  // shipped BIPOLAR default with white noise in, the PUNCH bar reads 0.145
  // while the PUNCH jack sits at −0.703, and no ATTACK or RELEASE setting moves
  // the bar at all. Reproducing them here would have promoted a third,
  // disagreeing view of the module. This picture is DRAWN from the same
  // constants the worklet inlines (`featurecv-face-model` →
  // `packages/dsp/src/lib/featurecv-dsp`), so it is deterministic on a running
  // graph, a frozen one and a silent rack alike — the `noise-taps` precedent.
  //
  // ⚠ TWO OF THE THREE RAILS ARE GAIN-INVARIANT ON PURPOSE, and the panel says
  // so rather than pretending otherwise. BRIGHT counts zero crossings and PUNCH
  // is a peak-to-RMS ratio; both are scale-invariant, so a trim in front of the
  // analyser genuinely cannot move them. Only LOUD's markers slide, and its
  // CLIP flag is where the trim shows up. A picture that moved all three with
  // GAIN would be lying.
  //
  // ⚠ THE SOURCE MARKERS ARE THE AUDIT'S FINDING. The DSP core's crest
  // calibration comment claimed "white noise (~3.5) → ~0.5"; the rack's `white`
  // tap is UNIFORM in [−1,+1] whose crest is √3 ≈ 1.73, so NOISE → FEATURECV
  // lands PUNCH at the BOTTOM of its rail, not the middle. Every marker
  // position is re-derived from the shipping generators on every run by
  // `featurecv-face-model.test.ts`.
  //
  // ⚠ It emits NO `control-<paramId>` testid — it is a READ-ONLY picture, and a
  // control-shaped testid would read as an unbacked extra control to
  // faces-parity's exact multiset (see sidebar-panels.ts rule 1).

  import { patch } from '$lib/graph/store';
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
  import type { ModuleNode, ParamDef } from '$lib/graph/types';
  import {
    FEATURECV_FEATURES,
    FEATURECV_GAIN_REACHES,
    FEATURECV_SOURCES,
    featurecvFaceParams,
    featurecvIdleCv,
    featurecvLoudClipReachable,
    featurecvRailFill,
    featurecvSourceCv,
    fmtFeaturecvClip,
    fmtFeaturecvCv,
    type FeaturecvFaceParams,
    type FeaturecvFeature,
  } from '$lib/ui/modules/featurecv-face-model';

  interface Props {
    nodeId: string;
    props?: Readonly<Record<string, string | number>>;
    /** The def's params — needed for the DEFAULT fallback below. */
    params?: readonly ParamDef[];
  }
  let { nodeId, params = [] }: Props = $props();

  /**
   * ⚠ THE `?? defaultValue` IS LOAD-BEARING. `node.params` is a SPARSE overlay
   * of what has been TOUCHED, so reading it bare draws an idle rail at the
   * unipolar floor beside a POLARITY control reading `BI` on a fresh spawn (the
   * StereoCrossoverPanel scar).
   *
   * ⚠ THE VERSION IS READ INSIDE THE DERIVED (the ModuleShell `liveCell`
   * pattern): `patch.nodes[id]` is a stable SyncedStore proxy, so a derived
   * that does not touch `nodeVersion(id)` freezes at first render.
   */
  let voice = $derived.by<FeaturecvFaceParams>(() => {
    void nodeVersion(nodeId);
    const n = patch.nodes[nodeId] as ModuleNode | undefined;
    const live = n?.params as Record<string, number> | undefined;
    return featurecvFaceParams((id) => {
      const v = live?.[id];
      if (typeof v === 'number') return v;
      return params.find((p) => p.id === id)?.defaultValue;
    });
  });

  /** Which features this GAIN can move — a constant of the DSP, not of the
   *  patch, so the caption states it rather than animating it. */
  const gainReaches = new Set<FeaturecvFeature>(FEATURECV_GAIN_REACHES);
</script>

<div class="maps" data-testid="sidebar-panel-featurecv-maps">
  {#each FEATURECV_FEATURES as feature (feature)}
    <div class="rail-row" data-testid="featurecv-map-{feature}">
      <span class="rail-label">{feature}</span>
      <span class="rail-track">
        <!-- The IDLE tick sits at the very left by construction (the rail is
             drawn from the resting level up), so the marker that matters is
             each source's. -->
        {#each FEATURECV_SOURCES as src (src.id)}
          {@const cv = featurecvSourceCv(feature, src, voice)}
          <span
            class="mark m-{src.id}"
            data-testid="featurecv-mark-{feature}-{src.id}"
            data-cv={cv.toFixed(4)}
            data-fill={featurecvRailFill(cv, voice).toFixed(4)}
            style={`left:${(featurecvRailFill(cv, voice) * 100).toFixed(2)}%`}
            title={`${src.label} → ${fmtFeaturecvCv(cv)}`}
          ></span>
        {/each}
      </span>
      <span class="rail-note" class:muted={!gainReaches.has(feature)}>
        {gainReaches.has(feature) ? (featurecvLoudClipReachable(voice) ? fmtFeaturecvClip(voice) : 'no clip') : 'no gain'}
      </span>
    </div>
  {/each}

  <div class="axis">
    <span data-testid="featurecv-rail-floor">{fmtFeaturecvCv(featurecvIdleCv(voice))}</span>
    <span class="key">
      {#each FEATURECV_SOURCES as src (src.id)}
        <span class="key-item"><i class="swatch m-{src.id}"></i>{src.label}</span>
      {/each}
    </span>
    <span>+1.00</span>
  </div>
</div>

<style>
  .maps {
    display: grid;
    gap: 4px;
  }
  .rail-row {
    display: grid;
    grid-template-columns: 38px 1fr 56px;
    align-items: center;
    gap: 5px;
    font-size: 9px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .rail-label {
    opacity: 0.72;
  }
  .rail-track {
    position: relative;
    display: block;
    height: 10px;
    border-radius: 2px;
    background: rgb(0 0 0 / 0.35);
    border: 1px solid rgb(255 255 255 / 0.08);
  }
  .mark {
    position: absolute;
    top: -1px;
    bottom: -1px;
    width: 2px;
    margin-left: -1px;
    border-radius: 1px;
  }
  .rail-note {
    text-align: right;
    font-variant-numeric: tabular-nums;
    opacity: 0.88;
  }
  .rail-note.muted {
    opacity: 0.45;
  }
  /* One colour per canonical source, shared between the rails and the key. */
  .m-sine {
    background: #8fd7ff;
  }
  .m-brown {
    background: #c98b4b;
  }
  .m-pink {
    background: #ef7fa6;
  }
  .m-white {
    background: #dfe7ec;
  }
  .axis {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 6px;
    font-size: 9px;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    opacity: 0.72;
    font-variant-numeric: tabular-nums;
  }
  .key {
    display: flex;
    gap: 6px;
  }
  .key-item {
    display: inline-flex;
    align-items: center;
    gap: 3px;
  }
  .swatch {
    display: inline-block;
    width: 6px;
    height: 6px;
    border-radius: 1px;
  }
</style>
