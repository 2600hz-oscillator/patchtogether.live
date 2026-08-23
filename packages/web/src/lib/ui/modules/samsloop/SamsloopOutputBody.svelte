<script lang="ts">
  // packages/web/src/lib/ui/modules/samsloop/SamsloopOutputBody.svelte
  //
  // The SAMSLOOP dock full-view body: the waveform, its START..END window wash
  // and the live playhead, carried forward from `SamsloopCard.svelte` onto the
  // faceplate.
  //
  // ⚠ WHY THIS FILE EXISTS. Promotion stops BOTH surfaces rendering the legacy
  // card. On a sampler that would leave the player placing loop points BLIND —
  // START and END are the two controls whose whole meaning is "where in this
  // picture", and a fader pair with no picture beside it is a worse instrument
  // than the card it replaced. See `shell-extension.ts` for why this is a body
  // rather than a registered panel.
  //
  // ⚠ THE DRAW IS SHARED, NOT COPIED — `samsloop-waveform-draw.ts` is the one
  // implementation and the card calls it too. The peak fold, the window wash and
  // the playhead are all arithmetic that can drift, and this module has already
  // paid for a duplicated PCM path once (a recording that drew correctly and made
  // no sound).
  import { patch } from '$lib/graph/store';
  import { useEngine } from '$lib/audio/engine-context';
  import { nodeSamsloop } from '../node-samsloop-registry.svelte';
  import { drawSamsloopWaveform } from '../samsloop-waveform-draw';
  import { samsloopDecodeBytesB64, type SamsloopData } from '$lib/audio/modules/samsloop';
  import { decodeRecordedPcm } from '$lib/audio/modules/samsloop-record';
  import { AudioEngine } from '$lib/audio/engine';

  interface Props {
    /** The graph node this faceplate is showing — the ONLY prop the slot gets
     *  (`ShellExtensionFullViewBodyProps`). */
    nodeId: string;
  }
  let { nodeId }: Props = $props();

  const engineCtx = useEngine();

  let node = $derived(patch.nodes[nodeId]);
  let data = $derived(node?.data as SamsloopData | undefined);
  let startFrac = $derived(node?.params?.start ?? 0);
  let endFrac = $derived(node?.params?.end ?? 1);
  let isRecording = $derived(nodeSamsloop.isRecording(nodeId));

  let canvasEl: HTMLCanvasElement | null = $state(null);
  let rafId: number | null = null;

  // Decoded PCM for the picture, cached against the sample's own signature so a
  // repaint does not re-decode. ⚠ The decoded buffer is deliberately NOT on
  // node.data — at the sample cap it would be ~12 MB of YArray entries.
  let displaySamples = $state<Float32Array | null>(null);
  let displaySig = $state<string | null>(null);

  $effect(() => {
    const d = data;
    if (!d) return;
    const sig = `${d.fileSize ?? 0}:${d.fileName ?? ''}:${d.sampleLength ?? 0}`;
    if (sig === displaySig) return;

    // The RECORDED path decodes synchronously off the persisted bytes, through
    // the SAME decoder the playback path uses. `'left'` keeps the trace's shape
    // stable regardless of the CHAN setting; playback asks for `'mix'`.
    if (d.sample && d.sample.byteLength > 0) {
      displaySamples = decodeRecordedPcm(d.sample, 'left');
      displaySig = sig;
      return;
    }
    // The UPLOAD path needs an AudioContext to decode, so it waits for the
    // engine and re-runs when this effect does.
    const b64 = d.fileBytesB64;
    if (!b64) {
      displaySamples = null;
      displaySig = sig;
      return;
    }
    let ctx: BaseAudioContext | undefined;
    try {
      const e = engineCtx.get();
      if (e?.hasDomain('audio')) ctx = e.getDomain<AudioEngine>('audio').ctx;
    } catch {
      ctx = undefined;
    }
    if (!ctx) return; // Try again once the engine boots — the effect re-runs.
    let cancelled = false;
    void (async () => {
      const r = await samsloopDecodeBytesB64(b64, ctx);
      if (cancelled) return;
      if (r?.ok && r.samples) {
        displaySamples = r.samples;
        displaySig = sig;
      }
    })();
    return () => { cancelled = true; };
  });

  // ⚠ ONE rAF LOOP, PULLING. The playhead is pushed to the main thread at ~20 Hz
  // and rests on the engine handle; this reads it at paint rate rather than
  // subscribing, so a collapsed dock costs nothing and a freshly-mounted body is
  // correct on its FIRST frame instead of waiting for the next publish.
  $effect(() => {
    if (!canvasEl) return;
    function tick(): void {
      const c = canvasEl;
      const ctx2d = c?.getContext('2d');
      if (c && ctx2d) {
        let playheadFrac = -1;
        try {
          const e = engineCtx.get();
          if (e && node) {
            const p = e.read(node, 'playhead') as { position?: number } | undefined;
            if (p && typeof p.position === 'number') playheadFrac = p.position;
          }
        } catch {
          playheadFrac = -1;
        }
        const live = isRecording ? nodeSamsloop.progress(nodeId) : null;
        drawSamsloopWaveform(ctx2d, c.width, c.height, {
          samples: displaySamples,
          startFrac,
          endFrac,
          playheadFrac,
          recordPeaks: live?.peaks ?? null,
          recordFilledFrac: live
            ? Math.min(1, (live.elapsed ?? 0) / Math.max(live.barSeconds ?? 1, 0.001))
            : 0,
        });
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

<div class="samsloop-output" data-testid="samsloop-output-body">
  <canvas
    bind:this={canvasEl}
    class="waveform"
    width={512}
    height={128}
    data-testid="samsloop-face-canvas"
    data-node-id={nodeId}
  ></canvas>
</div>

<style>
  .samsloop-output {
    display: flex;
    justify-content: center;
    padding: 6px 0 2px;
  }
  /* ⚠ THE WAVEFORM IS THE WIDTH-EARNER, and it is one the compact-by-default
     ruling names outright ("a live picture"). Time runs along X, and the two
     controls that matter most on this module — START and END — are positions
     IN it, so a narrow plate is a coarser instrument rather than merely a
     smaller picture. It is the only thing on this faceplate claiming width;
     every cell beneath it stays compact. */
  .waveform {
    display: block;
    width: 100%;
    max-width: 512px;
    height: auto;
    aspect-ratio: 4 / 1;
    border-radius: 3px;
    background: #0a0c11;
  }
</style>
