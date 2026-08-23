<script lang="ts">
  // packages/web/src/lib/ui/modules/dockscope/DockscopeOutputBody.svelte
  //
  // The DOCKSCOPE dock full-view body: the live time-domain trace, carried
  // forward from `DockscopeCard.svelte` onto the faceplate.
  //
  // ⚠ WHY THIS FILE EXISTS. Promotion stops BOTH surfaces rendering the legacy
  // card, and on this module that would delete the entire product — dockscope
  // has no outputs, so the trace is not a monitor OF the work, it IS the work.
  // A faceplate with two faders and a toggle and no picture would be three
  // controls over nothing.
  //
  // ⚠ AND WHY IT IS NOT THE `scope` GLYPH. See `shell-extension.ts` in this
  // directory: `glyphBinding` needs a primary AUDIO OUTPUT to reach a live tap,
  // dockscope declares none, and the glyph would silently resolve to the STATIC
  // placeholder waveform. The samples exist only behind the engine handle's
  // `read('snapshot')` key, and this slot is what can call it.
  //
  // ⚠ NO SCREEN ON/OFF SWITCH, AND THAT IS THE RULING APPLIED RATHER THAN
  // SKIPPED. The 2026-08-18 fleet standard puts a SCREEN toggle on every VIDEO
  // card, and `video-face-screen-source.test.ts` enforces it over
  // `STRICT_FACES ∩ video defs` — dockscope is an AUDIO def, so the gate does
  // not reach it and it needs no exemption entry. But the substantive reason is
  // `videoOut`'s, the one module the video gate DOES exempt by name: its
  // faceplate body IS the output picture, so a switch that collapses it "would
  // collapse the module's entire reason to exist rather than reclaiming space
  // beside it". That is exactly dockscope. The ruling is about a preview
  // sitting NEXT TO a module's controls; here the preview is the module.
  //
  // ⚠ AND THERE IS NO WATCH MARK TO KEEP. Every video body in this pattern
  // carries a `markWatched` call in its collapsed branch, because
  // `blitOutputForPreview` is the VideoEngine's "someone is watching" signal and
  // a lapsed mark drops the node out of the PULL SET. None of that machinery
  // exists here: dockscope is an audio module whose `AnalyserNode` is fed by the
  // Web Audio graph, which runs whether or not anything is looking. There is no
  // pull set, nothing to fall out of, and no producer to mute. Stated rather
  // than omitted, because "this body has no markWatched" should read as a
  // derived answer and not as a copy that lost a line.
  import { onMount } from 'svelte';
  import { patch } from '$lib/graph/store';
  import { onMeterFrame } from '$lib/ui/meter-frame';
  import { dockscopeDef, type DockscopeSnapshot } from '$lib/audio/modules/dockscope';
  import { drawDockscope } from '$lib/audio/modules/dockscope-draw';
  import { useEngine } from '$lib/audio/engine-context';

  interface Props {
    /** The graph node this faceplate is showing — the ONLY prop the slot gets
     *  (`ShellExtensionFullViewBodyProps`). */
    nodeId: string;
  }
  let { nodeId }: Props = $props();

  const engineCtx = useEngine();

  let node = $derived(patch.nodes[nodeId]);
  let timeMs = $derived(node?.params?.timeMs ?? dockscopeDef.params[0]!.defaultValue);
  let scale = $derived(node?.params?.scale ?? dockscopeDef.params[1]!.defaultValue);
  let range = $derived(node?.params?.range ?? dockscopeDef.params[2]!.defaultValue);

  // Trace colour: the audio cable tint, resolved post-mount so it tracks the
  // theme — the same convention `DockscopeCard` and `ScopeCard` both use.
  let traceColor = $state('#fbbf24');
  onMount(() => {
    const cs = getComputedStyle(document.documentElement);
    traceColor = cs.getPropertyValue('--cable-audio').trim() || traceColor;
  });

  // ⚠ THE SAME VRT SEED THE CARD HONOURS, and it has to be. A live analyser
  // window is different pixels every run, so a dock baseline over this body
  // would be pure noise. `__dockscopeVrtSeed` swaps the live window for a fixed
  // synthetic sine; reading the same global here is what lets this surface take
  // a baseline at all, and reading a DIFFERENT one would leave the face
  // unbaselinable while the card stayed pinned. No-op in production.
  function vrtSeed(): { freq: number } | null {
    const s = (globalThis as unknown as { __dockscopeVrtSeed?: { freq?: number } | boolean })
      .__dockscopeVrtSeed;
    if (!s) return null;
    return { freq: (typeof s === 'object' ? s.freq : undefined) ?? 220 };
  }
  function seededSnapshot(seed: { freq: number }): DockscopeSnapshot {
    const n = 2048;
    const sampleRate = 48000;
    const samples = new Float32Array(n);
    for (let i = 0; i < n; i++) samples[i] = Math.sin((2 * Math.PI * seed.freq * i) / sampleRate);
    return { samples, sampleRate };
  }

  let canvasEl: HTMLCanvasElement | null = $state(null);

  /** Crisp-resize + vector redraw: size the backing store to the LIVE on-screen
   *  pixels (gBCR × dpr — the dock's CSS scale folded in), then re-plot. This is
   *  the card's `paint`, unchanged: the whole point of routing through
   *  `drawDockscope` is that the two surfaces cannot draw different traces. */
  function paint(c: HTMLCanvasElement, snap: DockscopeSnapshot): void {
    const rect = c.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return;
    const dpr = typeof devicePixelRatio === 'number' && devicePixelRatio > 0 ? devicePixelRatio : 1;
    const w = Math.round(rect.width * dpr);
    const h = Math.round(rect.height * dpr);
    if (c.width !== w) c.width = w;
    if (c.height !== h) c.height = h;
    const ctx2d = c.getContext('2d');
    if (!ctx2d) return;
    const logicalW = c.clientWidth || rect.width;
    drawDockscope(ctx2d, snap.samples, snap.sampleRate, {
      timeMs, scale, range,
      color: traceColor,
      pixelRatio: logicalW > 0 ? w / logicalW : dpr,
    }, w, h);
  }

  $effect(() => {
    if (!canvasEl) return;
    const h = onMeterFrame(canvasEl, () => {
      const c = canvasEl;
      const n = node;
      if (!c || !n) return;
      const seed = vrtSeed();
      if (seed) {
        paint(c, seededSnapshot(seed));
        return;
      }
      const eng = engineCtx.get();
      const snap = eng?.read(n, 'snapshot') as DockscopeSnapshot | undefined;
      if (snap) paint(c, snap);
    });
    return () => h.stop();
  });
</script>

<div class="dockscope-output" data-testid="dockscope-output-body">
  <canvas
    bind:this={canvasEl}
    class="trace"
    data-testid="dockscope-face-canvas"
    data-node-id={nodeId}
  ></canvas>
</div>

<style>
  .dockscope-output {
    display: flex;
    justify-content: center;
    padding: 6px 0 2px;
  }
  /* ⚠ THE TRACE IS THE WIDTH-EARNER, and it is one the ruling names outright:
     "a live picture, a scope trace". A scope's whole readability is horizontal
     — the x axis IS the time window TIME sets — so a narrow trace is a trace
     you cannot read. This is the one thing on this faceplate that claims width,
     and the controls beneath it stay compact. */
  .trace {
    display: block;
    width: 100%;
    max-width: 480px;
    height: 120px;
    border-radius: 3px;
    background: #0a0c10;
  }
</style>
