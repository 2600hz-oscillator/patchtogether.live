<script lang="ts">
  // WavecelWavetablePanel — the faceplate's HERO: the loaded wavetable, drawn
  // either as a 3D stack of frames in perspective or as a single-frame scope
  // trace, with the frame MORPH points at picked out.
  //
  // ⚠ WHY THE PICTURE EXISTS. This module's whole gesture is scanning a STACK
  // of single-cycle frames, and the stack is the one thing no control can
  // describe: MORPH's dial says `0.42`, and the picture says which of forty
  // waveforms that is and what the two either side look like. SPREAD is the
  // same argument doubled — it reads NEIGHBOURING frames, so the highlighted
  // band, not a number, is what shows how wide the read is.
  //
  // ⚠ PARAM- AND DATA-DERIVED, NOT AN ANALYSER TRACE — which is what makes it
  // a PANEL rather than the glyph, the `analogvco-cycle` argument exactly. The
  // wavetable comes from `node.data`, the read position from the params plus
  // the live CV taps; nothing here reads an AnalyserNode. `face.hero.cell`
  // therefore suppresses the dock glyph, so a knob-INVARIANT live trace never
  // sits beside this knob-DERIVED picture.
  //
  // ⚠ NO rAF, and that is a VRT decision rather than a performance one. The
  // legacy card drives this canvas from a permanent `requestAnimationFrame`
  // loop; here the draw is an EFFECT over its inputs, so it repaints when the
  // wavetable, the knobs or the taps change and is otherwise still. Under the
  // face harness's audio freeze the tap reads 0 and every input is pinned, so
  // the picture is a pure function of (frames, morph, spread, mode) and the
  // two scenes need no mask — and a masked hero picture asserts nothing.
  //
  // ⚠ THE VIZ TOGGLE LIVES HERE, NOT AS A SHELL CELL. `WavecelCard.svelte:54`
  // holds it as component `$state`, and both VIDEO OUTPUTS render their own
  // view regardless of it, so it is a private view preference over this
  // picture rather than module state — the `foxy` case, and the bluebox
  // bank-label precedent puts a panel's own view control inside the panel. It
  // is also this cell's PROBE: a `text` probe on its caption observes THIS
  // panel's own subject, which is what a probe reading some other control's
  // caption could not do.
  //
  // ⚠ THIS PANEL EMITS NO `control-<paramId>` TESTID (shell-cells rule 1).
  // MORPH and SPREAD are ranked cells elsewhere on the faceplate; re-rendering
  // either here would emit a duplicate and fail faces-parity's exact multiset.

  import { patch } from '$lib/graph/store';
  import { mutateNode } from '$lib/graph/mutate';
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
  import { useEngine } from '$lib/audio/engine-context';
  import { wavecelDef, type WavecelData } from '$lib/audio/modules/wavecel';
  import { drawWave3D, drawWaveScope } from '$lib/audio/modules/wavecel-draw';
  import {
    getFactoryTables,
    DEFAULT_FACTORY_TABLE_ID,
    framesFromPlain,
  } from '$lib/audio/wavetable-factory-tables';
  import { spreadTaps } from '$lib/audio/wavecel-math';

  interface Props {
    nodeId: string;
  }
  let { nodeId }: Props = $props();

  const engineCtx = useEngine();
  const defFor = (pid: string): number =>
    wavecelDef.params.find((p) => p.id === pid)!.defaultValue;

  /** ⚠ THE VERSION IS CARRIED IN THE RESULT (the ModuleShell `liveCell`
   *  pattern) — a bare SyncedStore proxy is `===` to itself, so without this
   *  the picture would freeze at the values it first read. */
  let live = $derived.by(() => ({ v: nodeVersion(nodeId), n: patch.nodes[nodeId] }));
  let morph = $derived((live.n?.params?.morph as number | undefined) ?? defFor('morph'));
  let spread = $derived((live.n?.params?.spread as number | undefined) ?? defFor('spread'));

  /** The wavetable itself: the persisted user upload, else the chosen factory
   *  table. Read from `node.data` — the same key the card reads, so a table
   *  loaded before this face existed still draws. */
  let frames = $derived.by(() => {
    const d = live.n?.data as WavecelData | undefined;
    if (d?.wavetableSource === 'user' && Array.isArray(d.wavetableFrames)) {
      return framesFromPlain(d.wavetableFrames);
    }
    const id = (d?.wavetableSource ?? `factory:${DEFAULT_FACTORY_TABLE_ID}`).slice(
      'factory:'.length,
    );
    const factories = getFactoryTables();
    return (factories.find((t) => t.id === id) ?? factories[0]!).frames;
  });

  // ⚠ THE VIEW MODE LIVES ON `node.data`, AND THE CARD'S DOES NOT — a
  // deliberate divergence, not an oversight. `WavecelCard.svelte:54` holds it
  // as component `$state`, so the card's view silently resets to 3D on every
  // remount: the #1531 / #1574 / #1583 class (dock collapse, LRU eviction).
  // The owner's ruling for the directly analogous SCREEN toggle is explicit
  // that this kind of state belongs on `node.data` — it survives a tab switch,
  // a remount and a reload, and syncs to collaborators.
  //
  // ⚠ IT IS ALSO WHAT MAKES THE PROBE HONEST, which is how the design got
  // here rather than the other way round. `shell-cells` refused a `text` probe
  // whose witness was the button's OWN caption: *"a control that only relabels
  // itself is indistinguishable from a dead one"*. Exactly right — a button
  // that flips its label while the picture stays put would have passed. With
  // the mode on `node.data` the probe watches the STATE the picture is drawn
  // from, so a dead panel cannot satisfy it.
  //
  // One write per CLICK, never per frame — nowhere near the CV write-storm rule.
  let vizMode = $derived<'scope' | '3d'>(
    ((live.n?.data as WavecelData | undefined)?.vizMode as 'scope' | '3d' | undefined) ?? '3d',
  );
  function toggleVizMode(): void {
    const next = vizMode === '3d' ? 'scope' : '3d';
    mutateNode(nodeId, (n) => {
      if (!n.data) n.data = {};
      (n.data as WavecelData).vizMode = next;
    });
  }

  let canvasEl: HTMLCanvasElement | null = $state(null);

  // The draw, as an EFFECT over its inputs rather than a frame loop. Every
  // value it reads is tracked, so a knob move, a table change or a mode flip
  // repaints exactly once and nothing repaints otherwise.
  $effect(() => {
    const el = canvasEl;
    if (!el) return;
    const ctx = el.getContext('2d');
    if (!ctx) return;
    const w = el.width;
    const h = el.height;

    const fs = frames;
    if (!fs || fs.length === 0) {
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = '#0a0c11';
      ctx.fillRect(0, 0, w, h);
      return;
    }

    // Effective morph/spread = knob PLUS any CV modulation, mirroring the
    // worklet's own clamps (clamp01 / clampRange) so the highlight stays on
    // canvas when CV pushes past the range. With the graph frozen, or nothing
    // patched, both taps read 0 and this is just the knob.
    const eng = engineCtx.get();
    const morphCv = eng?.readModulatorTap(nodeId, 'morph_cv') ?? 0;
    const spreadCv = eng?.readModulatorTap(nodeId, 'spread_cv') ?? 0;
    const liveMorph = Math.max(0, Math.min(1, morph + morphCv));
    const liveSpread = Math.max(1, Math.min(5, spread + spreadCv * 2));
    const centerFrame = liveMorph * (fs.length - 1);
    const taps = spreadTaps(liveSpread, centerFrame);
    const activeFrame = Math.round(centerFrame);

    if (vizMode === '3d') {
      drawWave3D(ctx, fs, w, h, { activeFrame, taps });
    } else {
      drawWaveScope(ctx, fs, w, h, { activeFrame });
    }
  });
</script>

<div class="wt-panel" data-testid="wavecel-wavetable-panel">
  <div class="viz-wrap">
    <canvas
      bind:this={canvasEl}
      width={320}
      height={160}
      data-testid="wavecel-face-viz"
    ></canvas>
    <button
      type="button"
      class="viz-toggle nodrag"
      onclick={toggleVizMode}
      data-testid="wavecel-viz-toggle-1"
      aria-label="Toggle wavetable view between 3D stack and single-frame scope"
    >{vizMode === '3d' ? '3D' : 'SCOPE'}</button>
  </div>
</div>

<style>
  .wt-panel {
    display: flex;
    justify-content: center;
    width: 100%;
  }
  /* The switch OVERLAYS the picture's corner rather than taking a row of its
     own — the measured rule from module-faceplates.md: a stacked toggle cost
     ~18.8px on a card with ~11px of slack and reddened io-spec-consistency's
     card sweep. Inside the picture's box, the delta is ZERO. */
  .viz-wrap {
    position: relative;
    display: flex;
    justify-content: center;
  }
  .viz-wrap canvas {
    display: block;
    border-radius: 3px;
    background: #0a0c11;
    max-width: 100%;
    height: auto;
  }
  .viz-toggle {
    position: absolute;
    right: 4px;
    bottom: 4px;
    font-size: 0.55rem;
    letter-spacing: 0.06em;
    padding: 2px 8px;
    border: 1px solid var(--border);
    border-radius: 2px;
    /* Legible over the picture — a transparent button was not. */
    background: rgba(5, 6, 8, 0.72);
    color: var(--text-dim);
    cursor: pointer;
  }
  .viz-toggle:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px; }
</style>
