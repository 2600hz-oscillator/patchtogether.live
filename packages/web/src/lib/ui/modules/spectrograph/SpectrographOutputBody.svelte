<script lang="ts">
  // packages/web/src/lib/ui/modules/spectrograph/SpectrographOutputBody.svelte
  //
  // The SPECTROGRAPH dock full-view body: the live scrolling sonogram, carried
  // forward from `SpectrographCard.svelte` onto the faceplate.
  //
  // ⚠ WHY THIS FILE EXISTS. Promotion stops BOTH surfaces rendering the legacy
  // card, and on this module that would delete the entire product: a
  // spectrograph IS an image, so a faceplate with a GAIN dial and a COLOR/B-W
  // switch and no picture is two controls over nothing.
  //
  // ⚠ IT CALLS `drawFrame` AND OWNS NO STATE OF ITS OWN — the important
  // property, and the reason this body is five lines of real logic. The 256-
  // column scroll buffer lives in the module's factory closure; `drawFrame` is
  // the only door to it. A second implementation here would advance at its own
  // rate and the two surfaces would disagree about what moment of the signal
  // they are showing. The module's 16 ms column gate already makes a second and
  // third caller in the same frame idempotent, so sharing is correct by
  // construction rather than by arrangement.
  //
  // ⚠ NO VRT SEED IS MIRRORED HERE, and that is a real difference from
  // `DockscopeOutputBody`. `__spectrographVrtFreeze` is read INSIDE the module,
  // so any caller of `drawFrame` inherits the frozen fill. Duplicating the
  // global here would be dead code pretending to be a determinism seam.
  //
  // ⚠ NO SCREEN ON/OFF SWITCH, by derivation rather than omission. The
  // 2026-08-18 fleet standard covers VIDEO defs, and
  // `video-face-screen-source.test.ts` runs over `STRICT_FACES ∩ video defs` —
  // this is `domain: 'audio'`, so the gate does not reach it and no exemption
  // entry is owed. The substantive reason is `videoOut`'s and `dockscope`'s:
  // when the picture IS the module, a switch that collapses it deletes the
  // product instead of reclaiming space beside it.
  //
  // ⚠ AND NO WATCH MARK. `markWatched` is a VideoEngine PULL-SET concept.
  // This module's outputs are published as `videoSource`s consumed by the
  // audio→video bridge, and its analyser is fed by the Web Audio graph, which
  // runs whether or not anything is looking. There is no pull set to fall out
  // of. Stated rather than omitted, so a future copy-paste from a video body
  // does not add a call that would silently do nothing.
  import { patch } from '$lib/graph/store';
  import { useEngine } from '$lib/audio/engine-context';

  interface Props {
    /** The graph node this faceplate is showing — the ONLY prop the slot gets
     *  (`ShellExtensionFullViewBodyProps`). */
    nodeId: string;
  }
  let { nodeId }: Props = $props();

  const engineCtx = useEngine();

  let node = $derived(patch.nodes[nodeId]);
  /** Which colormap the preview pulls — the `view` PARAM, so this surface and
   *  the legacy card read the switch from one place. */
  let viewBw = $derived((node?.params?.view ?? 0) >= 0.5);

  let canvasEl: HTMLCanvasElement | null = $state(null);
  let rafId: number | null = null;

  type VSrc = { drawFrame?: (c: OffscreenCanvas | HTMLCanvasElement) => void } | null;

  $effect(() => {
    if (!canvasEl) return;
    function tick(): void {
      const e = engineCtx.get();
      const c = canvasEl;
      if (e && node && c) {
        let audioEngine: { getVideoSource?: (n: string, p: string) => VSrc } | undefined;
        try {
          audioEngine = e.getDomain('audio') as unknown as typeof audioEngine;
        } catch {
          audioEngine = undefined;
        }
        // The SAME path the audio→video texture bridge uses, so the faceplate
        // is an honest WYSIWYG of what the patched output emits.
        const port = viewBw ? 'bw' : 'color';
        const vsrc = audioEngine?.getVideoSource?.(nodeId, port) ?? null;
        if (vsrc?.drawFrame) {
          try {
            vsrc.drawFrame(c);
          } catch {
            /* keep the loop alive on a transient draw error */
          }
        }
      }
      rafId = requestAnimationFrame(tick);
    }
    rafId = requestAnimationFrame(tick);
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = null;
    };
  });
</script>

<div class="spectrograph-output" data-testid="spectrograph-output-body">
  <canvas
    bind:this={canvasEl}
    class="sonogram"
    class:bw={viewBw}
    width={256}
    height={128}
    data-testid="spectrograph-face-canvas"
    data-node-id={nodeId}
  ></canvas>
</div>

<style>
  .spectrograph-output {
    display: flex;
    justify-content: center;
    padding: 6px 0 2px;
  }
  /* ⚠ THE SONOGRAM IS THE WIDTH-EARNER, and it is one the ruling names outright
     ("a live picture"). Time runs along X — 256 columns of history — so a
     narrow plate is a shorter memory, not merely a smaller picture. This is the
     only thing on this faceplate claiming width; the two controls beneath it
     stay compact. */
  .sonogram {
    display: block;
    width: 100%;
    max-width: 512px;
    height: auto;
    aspect-ratio: 2 / 1;
    border-radius: 3px;
    background: #050608;
    /* The module renders both colormaps continuously; `view` only picks which
       port this pulls. The filter is the card's own treatment, kept so the two
       surfaces look like the same instrument. */
    image-rendering: pixelated;
  }
</style>
