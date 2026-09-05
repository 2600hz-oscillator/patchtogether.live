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
  //
  // ⚠ IT ALSO CARRIES THE REC REFUSAL, and this is the only place on the
  // faceplate that could. `startSamsloopTake` refuses to arm when the engine is
  // down or the rack's sample budget is spent; the card printed that sentence in
  // `samsloop-rec-error` and the face had no equivalent, so the press moved the
  // button, recorded `delivered: false` in the audition ledger and changed
  // nothing a player can see. An `action` shell cell is a `<Button>` and has no
  // caption slot — only the `file` cell's `{status,error}` pair does, and only
  // at `faceplateView` — so the module's own body is the seam.
  //
  // ⚠ A DOCK-ONLY HOME IS COMPLETE HERE, DERIVED RATHER THAN HOPED. `face.order`
  // ranks `samsloop-rec-{n}` EIGHTH and `FACE_TIER_CAPS.full` is six, so REC is
  // unreachable at every lane tier — there is no surface that can press it and
  // not see this line. `samsloop-face-model.test.ts` pins that inequality, so a
  // future re-rank that promotes REC onto the lane plate goes red here instead
  // of quietly re-opening the silent-refusal hole.
  import { patch } from '$lib/graph/store';
  import { useEngine } from '$lib/audio/engine-context';
  import { nodeSamsloop } from '../node-samsloop-registry.svelte';
  import { drawSamsloopWaveform } from '../samsloop-waveform-draw';
  import { samsloopRecRefusal } from './samsloop-rec-refusal.svelte';
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
  /** The last REC press that REFUSED, or null. Absent at rest and cleared by
   *  the next press that arms, so nothing here is resting text. */
  let recRefusal = $derived(samsloopRecRefusal(nodeId));

  let canvasEl: HTMLCanvasElement | null = $state(null);
  let rafId: number | null = null;

  // Decoded PCM for the picture, cached against the sample's own signature so a
  // repaint does not re-decode. ⚠ The decoded buffer is deliberately NOT on
  // node.data — at the sample cap it would be ~12 MB of YArray entries.
  //
  // ⚠ PULLED FROM THE rAF TICK, NOT AN $effect — the proxy-identity lesson.
  // `node` is `$derived(patch.nodes[nodeId])`, and the store proxy keeps ONE
  // identity for the node's life, so a `$effect` reading `data.fileSize` here
  // never re-ran when an upload landed WHILE THE BODY WAS MOUNTED: the graph
  // was correct, the picture froze on the placeholder until a remount
  // (measured — samsloop.spec.ts's upload leg, 0 trace pixels live vs 25k
  // after close/reopen). The body already runs one pulling rAF loop for the
  // playhead; the signature check joins it — three property reads and a
  // string compare per frame, and the decode itself stays sig-guarded.
  let displaySamples = $state<Float32Array | null>(null);
  let displaySig = $state<string | null>(null);
  /** Sig of the decode currently in flight, so one upload decodes once and a
   *  newer upload supersedes a stale result. */
  let decodingSig: string | null = null;

  function refreshDisplaySamples(): void {
    const d = data;
    if (!d) return;
    const sig = `${d.fileSize ?? 0}:${d.fileName ?? ''}:${d.sampleLength ?? 0}`;
    if (sig === displaySig || sig === decodingSig) return;

    // The RECORDED path decodes synchronously off the persisted bytes, through
    // the SAME decoder the playback path uses. `'left'` keeps the trace's shape
    // stable regardless of the CHAN setting; playback asks for `'mix'`.
    if (d.sample && d.sample.byteLength > 0) {
      displaySamples = decodeRecordedPcm(d.sample, 'left');
      displaySig = sig;
      return;
    }
    // The UPLOAD path needs an AudioContext to decode, so it waits for the
    // engine — the next tick pulls again once it boots.
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
    if (!ctx) return;
    decodingSig = sig;
    void (async () => {
      const r = await samsloopDecodeBytesB64(b64, ctx);
      if (decodingSig !== sig) return; // superseded by a newer upload
      decodingSig = null;
      if (r?.ok && r.samples) {
        displaySamples = r.samples;
        displaySig = sig;
      }
    })();
  }

  // ⚠ ONE rAF LOOP, PULLING. The playhead is pushed to the main thread at ~20 Hz
  // and rests on the engine handle; this reads it at paint rate rather than
  // subscribing, so a collapsed dock costs nothing and a freshly-mounted body is
  // correct on its FIRST frame instead of waiting for the next publish.
  $effect(() => {
    if (!canvasEl) return;
    function tick(): void {
      // Pull the decoded-picture cache up to date (see the note above — the
      // node proxy's stable identity means no effect ever re-fires for us).
      refreshDisplaySamples();
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
  <!-- THE REFUSAL. The card's `samsloop-rec-error`, on the surface promotion
       leaves standing. It is a POLITE LIVE REGION rather than a plain line
       because it appears in response to a press that otherwise produced no
       observable change at all — announcing it is the whole point.

       ⚠ IT IS NOT RESTING TEXT AND CANNOT BECOME IT. Nothing renders until a
       press has been REFUSED, and the next press that arms (or a stop) clears
       it — so a faceplate opened on any rack, including every VRT capture, is
       byte-identical to before. It is also not a measurement of a control: it
       is the reason a gesture did not happen, which is the one thing
       `aria-valuetext` on the REC button could not carry, since REC has no
       value and the button is on a different band. -->
  {#if recRefusal}
    <p class="rec-refusal" role="status" data-testid="samsloop-face-rec-error">{recRefusal}</p>
  {/if}
</div>

<style>
  /* A COLUMN, so the refusal lands UNDER the waveform rather than beside it.
     With no refusal the single child still centres exactly as it did, so the
     resting layout is unchanged. */
  .samsloop-output {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 6px 0 2px;
  }
  /* The card's `.upload-error` vocabulary — the same 0.6rem monospace red the
     shell's own `.cell-cap.err` uses for a file cell's refusal, so a REC
     refusal and an UPLOAD refusal do not read as two different kinds of thing.
     Capped and wrapping: `samsloopRackFullMessage` is four clauses long and a
     nowrap line would push the plate wider than the waveform it sits under. */
  .rec-refusal {
    margin: 4px 0 0;
    max-width: 512px;
    font-size: 0.6rem;
    line-height: 1.35;
    font-family: ui-monospace, monospace;
    color: #ff6b6b;
    text-align: center;
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
