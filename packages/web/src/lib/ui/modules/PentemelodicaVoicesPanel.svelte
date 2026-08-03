<script lang="ts">
  // PentemelodicaVoicesPanel — the faceplate's HERO: all FIVE voices at once.
  //
  // ⚠ IT EXISTS BECAUSE THE FACEPLATE IS TABBED. Eight bands trip
  // DOCK_TAB_MIN_BANDS, so the dock renders a rail and FOUR of the five voice
  // strips are hidden at any moment. This is the one place the whole
  // instrument is visible.
  //
  // ⚠ A PICTURE OF THE PATCH, NOT A TRACE. Each lane draws one cycle of that
  // voice's own morphed waveform through the DSP's OWN `moogWaves`/`waveMorph`
  // — the same functions the audio uses and the same ones the legacy card's
  // canvas uses — plus its coarse/fine offset, its mixer level and its pan.
  // pentemelodica makes NO sound until a poly source gates it, so a live scope
  // would be a flat line for most of the time you are looking at it.
  //
  // ⚠ SVG, NOT CANVAS, and NO rAF: the two new VRT scenes stay deterministic
  // with no mask.
  //
  // ⚠ THIS PANEL EMITS NO `control-<paramId>` TESTID (shell-cells rule 1) —
  // faces-parity asserts exact multiset equality against the def's 48 param
  // ids. Everything here is namespaced `pentemelodica-hero-*`, which also
  // satisfies the `pentemelodica-voice` family testid grep.

  import { patch } from '$lib/graph/store';
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
  import { moogWaves } from '../../../../../dsp/src/lib/moog-vco-dsp';
  import { PENTE_VOICES, waveMorph } from '../../../../../dsp/src/lib/pentemelodica-dsp';
  import { pentemelodicaDef } from '$lib/audio/modules/pentemelodica';

  interface Props {
    nodeId: string;
  }
  let { nodeId }: Props = $props();

  /** ⚠ THE VERSION IS CARRIED IN THE RESULT (the ModuleShell `liveCell`
   *  pattern) — a bare SyncedStore proxy is `===` to itself and the picture
   *  would freeze at first render. */
  let live = $derived.by(() => ({ v: nodeVersion(nodeId), n: patch.nodes[nodeId] }));

  /** A param off the live node, falling back to the DEF DEFAULT — `node.params`
   *  is a sparse overlay of what has been TOUCHED, so a fresh spawn would
   *  otherwise draw five flat lines at level 0. */
  function pv(id: string): number {
    const v = live.n?.params?.[id];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    const pd = pentemelodicaDef.params.find((p) => p.id === id);
    return pd ? pd.defaultValue : 0;
  }

  interface Lane {
    v: number;
    tune: number;
    fine: number;
    wave: number;
    pw: number;
    level: number;
    pan: number;
    points: string;
  }

  const PTS = 96;
  const PLOT_W = 100;
  const PLOT_H = 100;

  function cycle(wave: number, pw: number): string {
    const dt = 1 / PTS;
    const out: string[] = [];
    for (let i = 0; i <= PTS; i++) {
      const phase = i / PTS;
      const y = waveMorph(moogWaves(phase, dt, pw), wave);
      out.push(`${((i / PTS) * PLOT_W).toFixed(2)},${(PLOT_H / 2 - y * PLOT_H * 0.44).toFixed(2)}`);
    }
    return out.join(' ');
  }

  let lanes = $derived.by<Lane[]>(() => {
    const out: Lane[] = [];
    for (let v = 1; v <= PENTE_VOICES; v++) {
      const wave = pv(`v${v}_wave`);
      const pw = pv(`v${v}_pw`);
      out.push({
        v,
        tune: pv(`v${v}_tune`),
        fine: pv(`v${v}_fine`),
        wave,
        pw,
        level: pv(`v${v}_level`),
        pan: pv(`v${v}_pan`),
        points: cycle(wave, pw),
      });
    }
    return out;
  });

  /** The SELECTED lane, whose exact resolved tuning the detail line prints.
   *
   *  ⚠ COMPONENT STATE, never `node.data` (the dx7 operator-selection
   *  precedent). It changes no sound, it is not saved with the rack, and a
   *  rack-mate must not have their panel yanked when someone else clicks. */
  let selected = $state<number>(1);
  let sel = $derived(lanes[selected - 1] ?? lanes[0]!);

  function panText(pan: number): string {
    if (Math.abs(pan) < 0.005) return 'C';
    return pan < 0 ? `L ${Math.abs(pan).toFixed(2)}` : `R ${pan.toFixed(2)}`;
  }

  /** The voice's frequency MULTIPLIER off the incoming note — coarse semitones
   *  plus fine cents, which is all this module's per-voice tuning is. */
  function ratio(tune: number, fine: number): string {
    return `×${Math.pow(2, tune / 12 + fine / 1200).toFixed(3)}`;
  }

  function st(v: number): string {
    return v > 0 ? `+${Math.round(v)} st` : `${Math.round(v)} st`;
  }
  function cents(v: number): string {
    return v > 0 ? `+${Math.round(v)} ¢` : `${Math.round(v)} ¢`;
  }
</script>

<div class="pente-hero" data-testid="pentemelodica-hero">
  <div class="lanes">
    {#each lanes as l (l.v)}
      <button
        type="button"
        class="lane"
        class:sel={l.v === selected}
        data-testid={`pentemelodica-hero-lane-${l.v}`}
        title="Voice {l.v} — read its resolved tuning below. Your screen only: the selection is not saved and no collaborator sees it."
        onclick={() => (selected = l.v)}
      >
        <svg viewBox="0 0 {PLOT_W} {PLOT_H}" preserveAspectRatio="none" aria-hidden="true">
          <line class="mid" x1="0" x2={PLOT_W} y1={PLOT_H / 2} y2={PLOT_H / 2} />
          <polyline class="wave" points={l.points} />
        </svg>
        <span class="n">{l.v}</span>
        <span class="bar" style="--lv: {Math.max(0, Math.min(1, l.level)) * 100}%"></span>
        <span class="pan" style="--px: {((Math.max(-1, Math.min(1, l.pan)) + 1) / 2) * 100}%"></span>
      </button>
    {/each}
  </div>

  <!-- ⚠ THE DETAIL LINE IS THE PANEL'S OPERABILITY PROBE TARGET, and it LEADS
       WITH THE VOICE NUMBER on purpose: at the shipped defaults all five voices
       are byte-identical, so nothing else about lane 1 and lane 2 differs and
       the probe would have nothing to observe on a freshly spawned module. -->
  <div class="detail" data-testid="pentemelodica-hero-detail">
    VOICE {sel.v} · {st(sel.tune)} {cents(sel.fine)} · {ratio(sel.tune, sel.fine)} · L
    {sel.level.toFixed(2)} · {panText(sel.pan)}
  </div>
</div>

<style>
  .pente-hero {
    width: 100%;
    display: grid;
    gap: 4px;
  }

  .lanes {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 4px;
  }

  .lane {
    appearance: none;
    background: rgb(0 0 0 / 0.35);
    border: 1px solid rgb(255 255 255 / 0.08);
    border-radius: 3px;
    padding: 2px 2px 4px;
    color: inherit;
    font: inherit;
    cursor: pointer;
    display: grid;
    gap: 2px;
    min-width: 0;
  }
  .lane:hover {
    border-color: rgb(255 255 255 / 0.2);
  }
  .lane.sel {
    border-color: var(--domain, #4dd6c1);
  }

  .lane svg {
    width: 100%;
    height: 40px;
    display: block;
  }
  .wave {
    fill: none;
    stroke: var(--domain, #4dd6c1);
    stroke-width: 1.5;
    vector-effect: non-scaling-stroke;
  }
  .mid {
    stroke: rgb(255 255 255 / 0.12);
    stroke-width: 1;
    vector-effect: non-scaling-stroke;
  }

  .n {
    font-size: 8px;
    letter-spacing: 0.09em;
    color: rgb(255 255 255 / 0.42);
    text-align: left;
  }

  /* LEVEL as a bar, PAN as a dot on a rail — the two mixer facts a waveform
     cannot carry, at a glance, for all five voices at once. */
  .bar {
    display: block;
    height: 3px;
    border-radius: 2px;
    background: linear-gradient(
      to right,
      var(--domain, #4dd6c1) var(--lv),
      rgb(255 255 255 / 0.1) var(--lv)
    );
  }
  .pan {
    display: block;
    height: 3px;
    border-radius: 2px;
    background:
      radial-gradient(circle at var(--px) 50%, #f0a44a 0 1.5px, transparent 1.6px),
      rgb(255 255 255 / 0.08);
  }

  .detail {
    font-size: 9px;
    letter-spacing: 0.04em;
    color: rgb(255 255 255 / 0.68);
    font-variant-numeric: tabular-nums;
  }
</style>
