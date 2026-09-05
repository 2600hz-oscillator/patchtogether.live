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
  // ⚠ THE TRACE IS `ScopeTraceSurface`, NOT A THIRD COPY OF `drawScope`
  // (legacy-removal S1). This body used to carry its own `vrtSeed` /
  // `seededSnapshot` / `paint` trio, and so did `ScopeCard.svelte` — one pasted
  // from the other, agreeing exactly because of that, which is the condition
  // under which two implementations stop agreeing silently. The `GroupCard`
  // viz-passthrough mount made it three. One file paints a scope trace now.
  //
  // ⚠ AND THIS BODY NO LONGER PRODUCES ANYTHING, WHICH IS THE HALF WORTH
  // READING. It used to run `write(node,'cvCombined')` — a SECOND writer of the
  // module's CV shadows, beside the card's — with a long note explaining why the
  // push had to run even with the SCREEN off. That push belongs to the NODE now
  // (`$lib/ui/media/frame-producers`), so the argument evaporates rather than
  // being restated: the producer runs whether this component exists or not, the
  // `out` texture cannot desync from the controls, and SCREEN OFF is free to be
  // exactly what it says — no canvas.
  //
  // ⚠ THERE IS NO WATCH MARK HERE. `markWatched` is a VideoEngine PULL-SET
  // concept; this module's AnalyserNodes are fed by the Web Audio graph, which
  // runs whether or not anyone is looking. There is no pull set to fall out of
  // and no producer to mute. Stated rather than omitted, so "this body has no
  // markWatched" reads as a derived answer and not as a copy that lost a line.
  import { onDestroy } from 'svelte';
  import { patch } from '$lib/graph/store';
  import { mutateNode } from '$lib/graph/mutate';
  import { type PitchResult } from '$lib/audio/modules/scope';
  import { type ScopeTuning } from '$lib/audio/modules/scope-draw';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import ScopeTraceSurface from './ScopeTraceSurface.svelte';

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
  //
  // ⚠ SCREEN OFF UNMOUNTS THE SURFACE, AND THAT IS NOW SAFE RATHER THAN MERELY
  // CHEAP. While this body owned a `write(node,'cvCombined')` push it had to
  // keep its loop running with the screen off, because stopping it would have
  // desynced the module's `out` texture from its controls — a preview toggle
  // acting as a producer kill switch, the #1720/#1721 class. The producer is the
  // NODE's now, so the owner's "it KEEPS RENDERING while OFF" floor is satisfied
  // by construction: nothing this component does can reach `out`.
</script>

<div class="scope-output" data-testid="scope-output-body">
  <div class="preview-wrap" data-preview-collapsed={previewCollapsed ? 'true' : 'false'}>
    {#if !previewCollapsed}
      <!-- 480 × 360 — 4:3 KEPT ON PURPOSE. XY mode plots a CIRCLE for a 1:1
           Lissajous, and a non-square aspect makes it an ellipse: a WRONG
           picture, not merely a stretched one.

           THE trace, not a copy of it: the surface emits the `scope-face-canvas`
           element itself and no wrapper, so this box is unchanged. -->
      <ScopeTraceSurface
        nodeId={nodeId}
        width={480}
        height={360}
        testid="scope-face-canvas"
        {tuning}
      />
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
  /* `:global(canvas)` because the element belongs to `ScopeTraceSurface` now —
     Svelte's scoped selector would not reach a child component's DOM. Scoped by
     `.preview-wrap`, so nothing leaks. */
  .preview-wrap :global(canvas) {
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
