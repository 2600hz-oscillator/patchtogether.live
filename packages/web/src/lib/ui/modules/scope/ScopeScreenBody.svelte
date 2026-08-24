<script lang="ts">
  // packages/web/src/lib/ui/modules/scope/ScopeScreenBody.svelte
  //
  // The SCOPE dock full-view body: the live dual-trace / Lissajous screen, the
  // tuning graticule, and the SCREEN ON/OFF switch.
  //
  // ⚠ WHY THIS FILE EXISTS. Promotion stops BOTH surfaces rendering
  // `ScopeCard.svelte`, and the card is where the picture lives. A faceplate
  // with nine controls and no screen would be nine ways to adjust nothing, on
  // the one module whose entire contract is "this picture is your signal, drawn
  // the way you dialled it".
  //
  // ⚠ AND WHY IT IS NOT THE `scope` GLYPH. See `shell-extension.ts` in this
  // directory. Short version: the glyph WOULD resolve LIVE here (`ch1_out` is a
  // declared audio output, unlike dockscope's empty roster) and would still be
  // blind — `ch1_out` is bit-exactly the CH1 input, so the trace it paints is
  // invariant to all nine controls. Live, green, and false.
  //
  // ⚠ `onMeterFrame`, NOT A RAW rAF — and NOT a copy of `RasterizeOutputBody`.
  // That body runs an ungated `requestAnimationFrame` loop and its header
  // explains the exemption: rasterize's painter is advanced INSIDE
  // `read('imageData')`, so its loop is the only thing moving the raster.
  // SCOPE HAS NO SUCH INVERSION — `readSnapshot()` reads two analysers and
  // mutates nothing, and the video bridge's `drawFrame` is independent of any
  // card. Copying the exemption without its reason would ship an ungated
  // full-canvas redraw on a collapsed dock. `onMeterFrame` is
  // IntersectionObserver-gated, which is what `ScopeCard` has always used.
  //
  // ⚠ THERE IS NO WATCH MARK HERE. `markWatched` is a VideoEngine PULL-SET
  // concept; this module's AnalyserNodes are fed by the Web Audio graph, which
  // runs whether or not anyone is looking. There is no pull set to fall out of
  // and no producer to mute. Stated rather than omitted, so "this body has no
  // markWatched" reads as a derived answer and not as a copy that lost a line.
  import { onDestroy, onMount } from 'svelte';
  import { patch } from '$lib/graph/store';
  import { mutateNode } from '$lib/graph/mutate';
  import { onMeterFrame } from '$lib/ui/meter-frame';
  import { scopeDef, type ScopeSnapshot, type PitchResult } from '$lib/audio/modules/scope';
  import { drawScope, type ScopeTuning } from '$lib/audio/modules/scope-draw';
  import { useEngine } from '$lib/audio/engine-context';
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
  // ⚠ THE FLEET RULING APPLIED, NOT INHERITED — and scope lands on the opposite
  // side of it from its own sibling, which is worth stating because a reader
  // who knows `DockscopeOutputBody` will expect no switch here.
  //
  // dockscope and spectrograph refuse the switch on `videoOut`'s argument: when
  // the picture IS the module, collapsing it deletes the product rather than
  // reclaiming space beside it. dockscope declares `outputs: []` — observe and
  // never pass through — so that argument holds there exactly.
  //
  // SCOPE IS AN INLINE PROBE. `ch1_out` / `ch2_out` carry the signal onward
  // untouched and the `out` mono-video texture keeps rendering from the
  // module's own `drawFrame`, none of which this component owns. So the screen
  // here IS a preview sitting next to nine controls, which is precisely the
  // shape the ruling is about, and collapsing it costs the player nothing but
  // the view.
  //
  // ⚠ AND NO GATE WILL CHECK ANY OF IT. `video-face-screen-source.test.ts`
  // builds its subject as `listVideoModuleDefs() ∩ STRICT_FACES`, and scope is
  // `domain: 'audio'` — out of scope BY CONSTRUCTION, exactly as `rasterize` is
  // today. The switch ships compliant and unguarded, and a future edit deleting
  // it would go green. Recorded here so the absence of a gate is a KNOWN
  // CONDITION rather than a later discovery. `scope-face-model.test.ts` asserts
  // the switch's presence at the source, which is the only thing that does.
  //
  // ⚠ STATE LIVES ON THE NODE, NOT IN THIS COMPONENT. A `$state` here dies with
  // the component, and this component unmounts on dock collapse / LRU eviction
  // — the card-unmount-kills-node-lifetime-state class (#1531 / #1574 / #1583).
  // `node.data` survives a tab switch (the owner's stated floor), a remount, a
  // reload, and syncs to collaborators. Absent ⇒ false ⇒ ON, so an existing
  // rack opens unchanged. One boolean per CLICK, never per frame.
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

  // ── THE TUNER ────────────────────────────────────────────────────────────
  //
  // ⚠ THE CARD'S DOM READOUT ROW DOES NOT COME ACROSS, AND IS NOT REPLACED BY A
  // HIDDEN ONE. `ScopeCard.svelte` paints `PITCH 440.0 Hz | NOTE A4` as a
  // labelled row of derived values under the screen — mechanism 3 in CLAUDE.md's
  // list, deleted from the fleet on 2026-08-19. A hover reveal or an opt-in
  // would be "there but hidden", refused by name.
  //
  // So the METER becomes part of the instrument (drawn into the canvas by
  // `drawScope`'s tuning graticule, the same class of annotation as its `±5V`
  // corner label — every hardware scope prints its cursor readout on the CRT),
  // and the NUMBERS land on `aria-label`: speakable, assertable, unpainted.
  //
  // ⚠ THIS RECOVERS A PITCH ASSERTION THE FLEET CURRENTLY DOES NOT HAVE.
  // `e2e/tests/scope-tuner.spec.ts`'s only value-reading leg is a `test.fixme`
  // parked under #1847 (nondeterministic on CI); the one live leg asserts the
  // em-dash PLACEHOLDER on the legacy card, which promotion retains, so it is
  // unaffected by any of this. A `toHaveAttribute` on a stable accessible name
  // is deterministic where a rendered Hz string chasing a live YIN estimate is
  // what got parked. ⚠ That is NOT an un-parking of #1847 and must not be read
  // as one.
  //
  // ~10 Hz, NOT per frame: this mirrors the card exactly, and the reason is the
  // card's — frame-rate jitter would make the reading flicker, and YIN over a
  // 2048-sample window costs ~1 ms. It is a product-side interval, defined here
  // and in `ScopeCard.svelte` alike.
  const PITCH_POLL_MS = 100;
  let pitch: PitchResult = $state({ hz: null, note: null, cents: null, confidence: null });
  let pitchTimer: ReturnType<typeof setInterval> | null = null;

  $effect(() => {
    pitchTimer = setInterval(() => {
      const eng = engineCtx.get();
      const n = node;
      if (!eng || !n) return;
      const p = eng.read(n, 'pitch') as PitchResult | undefined;
      if (p) pitch = p;
    }, PITCH_POLL_MS);
    return () => {
      if (pitchTimer !== null) clearInterval(pitchTimer);
      pitchTimer = null;
    };
  });
  onDestroy(() => {
    if (pitchTimer !== null) clearInterval(pitchTimer);
  });

  /** What the graticule DRAWS — note letter and cents only. */
  let tuning = $derived<ScopeTuning>({ note: pitch.note, cents: pitch.cents });

  /** What the graticule ANNOUNCES — the numbers that are painted nowhere. The
   *  idle string names the condition rather than leaving the control unnamed;
   *  YIN's energy gate returns empty on silence, which is a real state and not
   *  an error. */
  let tuningLabel = $derived(
    pitch.note === null || pitch.cents === null || pitch.hz === null
      ? 'tuning: no pitch detected'
      : `tuning: ${pitch.note}, ${pitch.hz.toFixed(1)} Hz, `
        + `${pitch.cents >= 0 ? '+' : ''}${Math.round(pitch.cents)} cents`,
  );

  // ── THE TRACE ────────────────────────────────────────────────────────────

  // Trace colours: the cable tints, resolved post-mount so they track the
  // theme — the convention `ScopeCard` and `DockscopeOutputBody` both use.
  // ⚠ `onMount`, NOT `$effect`, and deliberately — this is the convention both
  // `ScopeCard` and `DockscopeOutputBody` use. An effect here would READ each
  // colour in its own `||` fallback and WRITE it, so it would depend on the
  // state it assigns: it converges (Svelte stops on an equal write) but it is a
  // self-referencing effect for a one-shot read of a CSS custom property.
  let ch1Color = $state('#fbbf24');
  let ch2Color = $state('#60a5fa');
  onMount(() => {
    const cs = getComputedStyle(document.documentElement);
    ch1Color = cs.getPropertyValue('--cable-audio').trim() || ch1Color;
    ch2Color = cs.getPropertyValue('--cable-pitch').trim() || ch2Color;
  });

  // ⚠ THE SAME VRT SEED THE CARD HONOURS, INCLUDING ITS SHAPE AND DEFAULTS.
  // Two live oscillators driving ch1/ch2 are NOT phase-locked, so a Lissajous
  // figure's orientation drifts run-to-run and a dock baseline over this body
  // would be noise. `__scopeVrtSeed` swaps the live analyser windows for fixed
  // phase-locked sines. Reading a DIFFERENT global here would leave this
  // surface unbaselinable while the card stayed pinned — dockscope records that
  // trap by name. No-op in production (the global is never set).
  function vrtSeed(): { ch1Freq: number; ch2Freq: number; ch2Phase?: number } | null {
    const s = (globalThis as unknown as {
      __scopeVrtSeed?: { ch1Freq?: number; ch2Freq?: number; ch2Phase?: number } | boolean;
    }).__scopeVrtSeed;
    if (!s) return null;
    const cfg = typeof s === 'object' ? s : {};
    return { ch1Freq: cfg.ch1Freq ?? 220, ch2Freq: cfg.ch2Freq ?? 330, ch2Phase: cfg.ch2Phase ?? 0 };
  }
  function seededSnapshot(seed: { ch1Freq: number; ch2Freq: number; ch2Phase?: number }): ScopeSnapshot {
    const n = 2048;
    const sampleRate = 48000;
    const ch1 = new Float32Array(n);
    const ch2 = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      ch1[i] = Math.sin((2 * Math.PI * seed.ch1Freq * i) / sampleRate);
      ch2[i] = Math.sin((2 * Math.PI * seed.ch2Freq * i) / sampleRate + (seed.ch2Phase ?? 0));
    }
    return { ch1, ch2, sampleRate };
  }

  let canvasEl: HTMLCanvasElement | null = $state(null);

  /** Every param's shipped default, keyed BY ID.
   *
   *  ⚠ BY ID RATHER THAN BY INDEX, and that is not style. `ScopeCard.svelte`
   *  reads its fallbacks as `scopeDef.params[4]!.defaultValue` — nine positional
   *  literals that are silently wrong the day anyone reorders the array, and
   *  wrong in the worst way (a plausible number from the neighbouring control,
   *  not a crash). Keying by id cannot drift. */
  const DEFAULTS: Record<string, number> = Object.fromEntries(
    scopeDef.params.map((p) => [p.id, p.defaultValue]),
  );

  /** Knob fallbacks — what the trace draws with before an engine exists. With
   *  nothing patched these equal the combined values anyway. */
  function knob(id: string): number {
    return (node?.params?.[id] as number | undefined) ?? DEFAULTS[id]!;
  }

  function paint(c: HTMLCanvasElement, snap: ScopeSnapshot, live?: Record<string, number>): void {
    const ctx2d = c.getContext('2d');
    if (!ctx2d) return;
    drawScope(
      ctx2d,
      snap,
      {
        timeMs: live?.timeMs ?? knob('timeMs'),
        ch1Scale: live?.ch1Scale ?? knob('ch1Scale'),
        ch1Offset: live?.ch1Offset ?? knob('ch1Offset'),
        ch1Range: live?.ch1Range ?? knob('ch1Range'),
        ch2Scale: live?.ch2Scale ?? knob('ch2Scale'),
        ch2Offset: live?.ch2Offset ?? knob('ch2Offset'),
        ch2Range: live?.ch2Range ?? knob('ch2Range'),
        mode: live?.mode ?? knob('mode'),
        intensity: live?.intensity ?? knob('intensity'),
        ch1Color,
        ch2Color,
        tuning,
      },
      c.width,
      c.height,
    );
  }

  $effect(() => {
    if (!canvasEl) return;
    const h = onMeterFrame(canvasEl, () => {
      const c = canvasEl;
      const n = node;
      if (!c || !n) return;
      const eng = engineCtx.get();

      // ⚠ PUSH THEN READ, UNCONDITIONALLY — and it is NOT optional here.
      // `scope` is in `CARD_PRODUCER_LANE_TYPES`, which means the headless
      // source host keeps `ScopeCard` mounted and that mount owns the
      // `cvCombined` push. But a param that was under CV when the pump stopped
      // LATCHES AT ITS LAST MODULATED VALUE — it does not fall back to the
      // knob — so a docked scope with a patched TIME cable would otherwise draw
      // on a stale timebase. `eng.readParam` returns the knob PLUS the engine's
      // own per-port CV tap and costs nothing extra (the tap already exists for
      // any patched port); with nothing patched there is no tap, so this equals
      // the knob and no render moves. (#1664)
      let live: Record<string, number> | undefined;
      if (eng) {
        const combined: Record<string, number> = {};
        for (const p of scopeDef.params) {
          const v = eng.readParam(n, p.id);
          if (typeof v === 'number' && Number.isFinite(v)) combined[p.id] = v;
        }
        eng.write(n, 'cvCombined', combined);
        live = eng.read(n, 'drawParams') as Record<string, number> | undefined;
      }

      // ⚠ THE PUSH ABOVE RUNS WHETHER OR NOT THE SCREEN IS ON; only the PAINT
      // is skipped. The owner's floor is "it KEEPS RENDERING while OFF", and
      // the module's own video-out `drawFrame` reads the same shadows this push
      // feeds — so stopping the push on collapse would desync the `out` texture
      // from the controls, which is a real regression rather than a saved
      // frame. Scope's analysers are fed by the audio graph regardless, so this
      // is cheap: skip the paint, never the loop.
      if (previewCollapsed) return;

      const seed = vrtSeed();
      const snap = seed
        ? seededSnapshot(seed)
        : (eng?.read(n, 'snapshot') as ScopeSnapshot | undefined);
      if (snap) paint(c, snap, live);
    });
    return () => h.stop();
  });
</script>

<div class="scope-output" data-testid="scope-output-body">
  <div class="preview-wrap" data-preview-collapsed={previewCollapsed ? 'true' : 'false'}>
    {#if !previewCollapsed}
      <!-- 480 × 360 — 4:3 KEPT ON PURPOSE. XY mode plots a CIRCLE for a 1:1
           Lissajous, and a non-square aspect makes it an ellipse: a WRONG
           picture, not merely a stretched one. -->
      <canvas
        bind:this={canvasEl}
        width={480}
        height={360}
        data-testid="scope-face-canvas"
        data-node-id={nodeId}
      ></canvas>
      <!-- The tuning graticule's own element. It PAINTS NOTHING — it carries
           the accessible name for the meter `drawScope` draws inside the canvas
           along this rectangle, which is how the Hz / cents / confidence
           survive the readout ruling: speakable, assertable, unpainted. -->
      <div
        class="tuning-a11y"
        role="img"
        aria-label={tuningLabel}
        data-testid="scope-face-tuning"
      ></div>
    {/if}
    <button
      type="button"
      class="screen-btn nodrag"
      class:on={!previewCollapsed}
      onclick={togglePreview}
      data-testid="scope-face-screen-toggle"
      aria-pressed={!previewCollapsed}
      title="SCREEN: turn the trace off to reclaim its space. The signal still passes through and the video out keeps rendering."
    >SCREEN {previewCollapsed ? 'OFF' : 'ON'}</button>
  </div>
</div>

<style>
  .scope-output {
    display: flex;
    justify-content: center;
    padding: 6px 0 2px;
  }
  /* ⚠ THE SWITCH COSTS ZERO LAYOUT HEIGHT — the same OVERLAY the fleet settled
     on. Stacking it under the canvas cost ~18.8px on a card with ~11px of slack
     and reddened io-spec-consistency's card sweep, so it overlays the picture's
     bottom-right corner and the body is exactly the height the picture is. */
  .preview-wrap {
    position: relative;
    display: flex;
    justify-content: center;
    /* Only load-bearing with SCREEN OFF: the canvas is gone, and without a
       floor the wrap would collapse to zero and take the absolutely-positioned
       button with it. Inert behind the canvas whenever the picture shows. */
    min-height: 18px;
  }
  /* ⚠ THE TRACE IS THE WIDTH-EARNER, and it is one the ruling names outright:
     "a live picture, a scope trace". A scope's readability is horizontal — the
     x axis IS the window TIME sets — so a narrow trace is a trace you cannot
     read. This is the one thing on this faceplate that claims width; the nine
     controls beneath it stay compact. */
  .preview-wrap canvas {
    display: block;
    width: 100%;
    max-width: 480px;
    height: auto;
    border-radius: 3px;
    background: #0a0c10;
  }
  /* Zero paint: no background, no border, no content. It exists to carry an
     accessible name over the strip the canvas draws, and it must never
     intercept a pointer aimed at the picture. */
  .tuning-a11y {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 13px;
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
