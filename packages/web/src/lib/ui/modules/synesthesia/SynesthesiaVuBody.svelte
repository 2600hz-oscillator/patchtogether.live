<script lang="ts">
  // packages/web/src/lib/ui/modules/synesthesia/SynesthesiaVuBody.svelte
  //
  // The SYNESTHESIA dock full-view body: the VU WALL — both copies' four band
  // meters — and the SCREEN ON/OFF switch.
  //
  // ⚠ WHY THIS FILE EXISTS. Promotion stops BOTH surfaces rendering
  // `SynesthesiaCard.svelte`, and that card owns the only picture this module
  // has. A faceplate with twenty-two controls and no meters would be
  // twenty-two ways to balance an analysis nobody can see, on the one module
  // whose entire product is "which quarter of this signal is loud right now".
  //
  // ⚠ AND WHY IT IS NOT THE GLYPH. See the `face` block on `synesthesiaDef`.
  // Short version: a glyph WOULD resolve LIVE here (`a_band1_audio` is a
  // declared audio output, unlike dockscope's empty roster) and would still be
  // blind — it taps copy A's BASS band alone, so the trace is invariant to the
  // other three bands, to copy B entirely, and to every depth and polarity on
  // the face. Live, green, and false.
  //
  // ⚠ THIS BODY IS A READER, NOT A PRODUCER — and that distinction decides a
  // registry entry. `synesthesia` is in `CARD_PRODUCER_LANE_TYPES`, so the
  // headless source host keeps the REAL card mounted off-screen; the card's
  // rAF is what samples the patched video frames and pushes
  // `write(node,'video_levels_a'/'_b')` into the worklet. This component
  // pushes nothing — it only reads `read('snapshot')` — so `synesthesia` must
  // stay OUT of `FACE_MOUNTS_PRODUCER` (dom-source-modules.ts), whose entries
  // declare "my faceplate mounts the producer, drop the headless host". Taking
  // that exemption here would kill the VIDEO-mode pump the moment the dock
  // opened, which is the timelorde shape that set the safe default.
  //
  // ⚠ `onMeterFrame`, NOT A RAW rAF. `readSnapshot` reads a worklet-posted
  // level array and mutates nothing, so there is no inversion of the
  // `RasterizeOutputBody` kind to justify an ungated loop. `onMeterFrame` is
  // IntersectionObserver-gated, which is what `SynesthesiaCard` has always
  // used for the same draw.
  //
  // ⚠ NO WATCH MARK. `markWatched` is a VideoEngine PULL-SET concept; these
  // levels come from the AudioWorklet, which the module's own muted keep-alive
  // gain keeps processing whether or not anyone is looking (synesthesia.ts's
  // `keepAlive`). There is no pull set to fall out of. Stated rather than
  // omitted, so "this body has no markWatched" reads as a derived answer and
  // not as a copy that lost a line.
  import { patch } from '$lib/graph/store';
  import { mutateNode } from '$lib/graph/mutate';
  import { onMeterFrame } from '$lib/ui/meter-frame';
  import { useEngine } from '$lib/audio/engine-context';
  import type { SynesthesiaSnapshot } from '$lib/audio/modules/synesthesia';
  import { drawVuMeters } from '$lib/audio/modules/synesthesia-draw';
  import type { ModuleNode } from '$lib/graph/types';

  interface Props {
    /** The graph node this faceplate is showing — the ONLY prop the slot gets
     *  (`ShellExtensionFullViewBodyProps`). */
    nodeId: string;
  }
  let { nodeId }: Props = $props();

  const engineCtx = useEngine();

  let node = $derived(patch.nodes[nodeId] as ModuleNode | undefined);

  // ── SCREEN ON/OFF ────────────────────────────────────────────────────────
  //
  // The fleet ruling applied on scope's side of it, not dockscope's. dockscope
  // and spectrograph refuse the switch because THEIR picture IS the product —
  // collapsing it deletes the module. SYNESTHESIA's product is its 48 output
  // jacks: the envelopes, gates, triggers and rasters keep flowing whether or
  // not these meters paint, so the wall is a MONITOR sitting beside
  // twenty-two controls, which is exactly the shape the ruling is about.
  //
  // ⚠ STATE LIVES ON THE NODE, NOT IN THIS COMPONENT. A `$state` here dies
  // with the component, and this component unmounts on dock collapse / LRU
  // eviction — the card-unmount-kills-node-lifetime-state class. `node.data`
  // survives a tab switch (the owner's stated floor), a remount, a reload, and
  // syncs to collaborators. Absent ⇒ false ⇒ ON, so an existing rack opens
  // unchanged. One boolean per CLICK, never per frame.
  let previewCollapsed = $derived<boolean>(
    (patch.nodes[nodeId]?.data?.previewCollapsed as boolean | undefined) ?? false,
  );
  function togglePreview(): void {
    const next = !previewCollapsed;
    mutateNode(nodeId, (live) => {
      if (!live.data) live.data = {};
      live.data.previewCollapsed = next;
    });
  }

  // ── THE WALL ─────────────────────────────────────────────────────────────

  /** Band names, in column order — the same musical split the def's `docs` and
   *  the worklet's filter bank use. Column 0 is band 1. */
  const BAND_NAMES = ['bass', 'low-mid', 'high-mid', 'treble'] as const;
  /** In VIDEO mode the four lanes are the frame's colour channels instead. */
  const CHANNEL_NAMES = ['red', 'green', 'blue', 'luma'] as const;

  let canvasA: HTMLCanvasElement | null = $state(null);
  let canvasB: HTMLCanvasElement | null = $state(null);

  /**
   * What the wall ANNOUNCES — the numbers that are painted NOWHERE.
   *
   * The meters are bars, so the levels behind them have no rendered text and
   * this is the only seam that can carry them: speakable, assertable,
   * unpainted, exactly the shape the readout ruling leaves open. It also names
   * the LANES by what they currently mean, which is the one fact a bar chart
   * cannot show — in VIDEO mode column 0 is RED, not bass.
   *
   * Recomputed only when the ROUNDED tuple changes, so an idle wall costs one
   * string compare per frame and patches no DOM.
   */
  let labelA = $state('copy a levels: idle');
  let labelB = $state('copy b levels: idle');
  let lastA = '';
  let lastB = '';

  function levelLabel(copy: 'a' | 'b', levels: readonly number[], video: boolean): string {
    const names = video ? CHANNEL_NAMES : BAND_NAMES;
    const parts = names.map((n, i) => `${n} ${(levels[i] ?? 0).toFixed(2)}`);
    return `copy ${copy} levels (${video ? 'video' : 'audio'}): ${parts.join(', ')}`;
  }

  function isVideo(copy: 'a' | 'b'): boolean {
    return Math.round((node?.params?.[`${copy}_mode`] as number | undefined) ?? 0) === 1;
  }

  function paint(c: HTMLCanvasElement | null, levels: readonly number[]): void {
    if (!c) return;
    const ctx2d = c.getContext('2d');
    if (!ctx2d) return;
    drawVuMeters(ctx2d, [...levels], c.width, c.height);
  }

  $effect(() => {
    const host = canvasA ?? canvasB;
    if (!host) return;
    const h = onMeterFrame(host, () => {
      const n = node;
      if (!n) return;
      const eng = engineCtx.get();
      // The wall is a pure reader (see the header): nothing is pushed here, so
      // there is no "push then read" ordering to honour and no state that goes
      // stale when the dock closes.
      const snap = eng?.read(n, 'snapshot') as SynesthesiaSnapshot | undefined;
      const la = snap?.levelsA ?? [0, 0, 0, 0];
      const lb = snap?.levelsB ?? [0, 0, 0, 0];

      const nextA = levelLabel('a', la, isVideo('a'));
      if (nextA !== lastA) { lastA = nextA; labelA = nextA; }
      const nextB = levelLabel('b', lb, isVideo('b'));
      if (nextB !== lastB) { lastB = nextB; labelB = nextB; }

      // ⚠ THE READ ABOVE RUNS WHETHER OR NOT THE SCREEN IS ON; only the PAINT
      // is skipped. The owner's floor is "it KEEPS RENDERING while OFF", and
      // the accessible names are what a screen reader and every spec use to
      // observe this module — stopping the read on collapse would freeze them
      // at whatever was last seen, which is the stale-bitmap shape rather than
      // a saved frame. The levels arrive from the worklet regardless, so this
      // is cheap: skip the paint, never the loop.
      if (previewCollapsed) return;
      paint(canvasA, la);
      paint(canvasB, lb);
    });
    return () => h.stop();
  });
</script>

<div class="syn-wall" data-testid="synesthesia-face-body">
  <div class="preview-wrap" data-preview-collapsed={previewCollapsed ? 'true' : 'false'}>
    {#if !previewCollapsed}
      <!-- 240 × 96 per copy. The card uses 208; the SHARED PURE FUNCTION is what
           makes the two surfaces agree, not a shared number — `drawVuMeters`
           divides `w` into four columns, so the picture is identical at both
           sizes. The face is wider because the control bands beneath it already
           ask the plate for more, and leaving a margin around the reason to open
           the dock is the grey space the width ruling is about (see the style
           block for the measurement). -->
      <!-- ⚠ THE ACCESSIBLE NAME IS ON A SIBLING, NOT ON THE CANVAS, and that is
           the scope precedent rather than a workaround: a `<canvas>` may not
           carry `role="img"` (svelte-check a11y), so each copy's meter pairs its
           canvas with a zero-paint element that carries the name over it. The
           element draws nothing and never intercepts a pointer. -->
      <div class="copies">
        <div class="vu">
          <canvas
            bind:this={canvasA}
            width={240}
            height={96}
            data-testid="synesthesia-face-vu-a"
            data-node-id={nodeId}
          ></canvas>
          <div class="vu-a11y" role="img" aria-label={labelA} data-testid="synesthesia-face-levels-a"></div>
        </div>
        <div class="vu">
          <canvas
            bind:this={canvasB}
            width={240}
            height={96}
            data-testid="synesthesia-face-vu-b"
            data-node-id={nodeId}
          ></canvas>
          <div class="vu-a11y" role="img" aria-label={labelB} data-testid="synesthesia-face-levels-b"></div>
        </div>
      </div>
    {/if}
    <button
      type="button"
      class="screen-btn nodrag"
      class:on={!previewCollapsed}
      onclick={togglePreview}
      data-testid="synesthesia-face-screen-toggle"
      aria-pressed={!previewCollapsed}
      title="SCREEN: turn the meters off to reclaim their space. The analysis keeps running and every output keeps flowing."
    >SCREEN {previewCollapsed ? 'OFF' : 'ON'}</button>
  </div>
</div>

<style>
  .syn-wall {
    display: flex;
    justify-content: center;
    padding: 6px 0 2px;
  }
  /* ⚠ THE SWITCH COSTS ZERO LAYOUT HEIGHT — the overlay the fleet settled on.
     Stacking it under the meters would add ~18.8 px of chrome to a body that is
     already the tallest thing on the plate, so it overlays the wall's
     bottom-right corner and the body is exactly the height the picture is. */
  .preview-wrap {
    position: relative;
    display: flex;
    justify-content: center;
    /* Only load-bearing with SCREEN OFF: the canvases are gone, and without a
       floor the wrap would collapse to zero and take the absolutely-positioned
       button with it. Inert behind the meters whenever the wall shows. */
    min-height: 18px;
  }
  /* ⚠ THIS BODY EARNS NO WIDTH, AND THAT IS DELIBERATE. Compact is the default
     and the burden of proof is on the wide face. Two 208 px meters plus a gap
     is ~428 px — narrower than the `band gain` band's eight dials in two
     clusters — so the wall never sets the plate's width. `max-width` on the
     canvases keeps it that way if the plate is ever narrower than the meters. */
  /* ⚠ EVERY WIDTH HERE IS DEFINITE, AND BOTH HALVES OF THAT WERE MEASURED.
     `.faceplate-body` is `width: max-content`, and the dock scene fails a face
     that RESERVES more width than it DRAWS (40 CSS px ceiling).

     The first draft wrote `.vu { width: 100%; max-width: 208px }` inside a
     `flex-wrap: wrap` row. That reads as "responsive" and is a max-content trap:
     a percentage-width flex child has no definite basis to resolve against under
     intrinsic sizing. Definite tracks make the asked-for width and the drawn
     width the same number by construction.

     ⚠ AND THE TRACK IS 240, NOT THE CARD'S 208, WHICH IS THE OTHER HALF. With
     the meters at 208 the wall drew 428 px while the control bands beneath it
     were already asking the plate for 537 — so the picture was the WIDEST DRAWN
     thing on the plate and STILL left 55 px of grey (measured: content 482, body
     537). The fix is not to add width, it is to USE the width the controls have
     already earned: 2×240 + 12 = 492, which spends the plate the bands define
     instead of leaving a margin around a picture that is the reason to open the
     dock. `drawVuMeters` is scale-free (it divides `w` into four columns), so
     the card at 208 and the face at 240 draw the identical picture at two sizes
     — the shared pure function is what guarantees that, not a shared number. */
  .copies {
    display: flex;
    gap: 12px;
    justify-content: center;
  }
  .vu {
    position: relative;
    display: block;
    width: 240px;
  }
  .vu canvas {
    display: block;
    width: 240px;
    height: 96px;
    border: 1px solid var(--border);
    border-radius: 3px;
    background: #0c0e12;
  }
  /* Zero paint: no background, no border, no content. It exists to carry an
     accessible name over the meter the canvas draws, and it must never
     intercept a pointer aimed at the picture. */
  .vu-a11y {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }
  .screen-btn {
    position: absolute;
    right: 4px;
    bottom: 4px;
    font-size: 0.55rem;
    letter-spacing: 0.06em;
    padding: 2px 8px;
    border: 1px solid var(--border);
    border-radius: 2px;
    /* Legible over a live picture — a transparent button was not. */
    background: rgba(5, 6, 8, 0.72);
    color: var(--text-dim);
    cursor: pointer;
  }
  .screen-btn.on { color: var(--text); border-color: var(--accent-dim); }
  .screen-btn:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px; }
</style>
