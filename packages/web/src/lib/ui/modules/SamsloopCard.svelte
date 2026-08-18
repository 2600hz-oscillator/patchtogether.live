<script lang="ts">
  // SamsloopCard — loop-based sample player WITH a built-in stereo input
  // recorder. Patch any audio source(s) into audio_l_in / audio_r_in,
  // pick CHAN / BITS / RATE, hit REC, and the captured PCM lands in
  // node.data.sample so it persists with the rest of the patch envelope
  // (same persistence pattern PICTUREBOX uses for imageBytes — see PR
  // #441 / GGR demo). DOWNLOAD button synthesizes a standard WAV on the
  // fly for export.
  //
  // What lives where:
  //   - All recording math (max-seconds budget, quantize, downsample, WAV
  //     header) is in $lib/audio/modules/samsloop-record.ts so it's unit-
  //     testable without a DOM (samsloop-record.test.ts).
  //   - ⚠ THE RECORDING ITSELF BELONGS TO THE NODE, NOT TO THIS CARD (#1588).
  //     The tap subscription, the accumulating PCM buffer, the live peak
  //     buffer and the encode-and-commit all live in
  //     $lib/ui/modules/node-samsloop-registry. This card ADOPTS and READS;
  //     it does not CREATE and DESTROY. Before that, this card's unmount
  //     `$effect` called `attachedTap.setEnabled(false)` and dropped the
  //     buffer — and NOTHING called `stopRecording()` on unmount, so
  //     collapsing the module (or an LRU dock evict, ESC, M/E, navigation)
  //     silently destroyed up to 60 s of unrepeatable live audio with no
  //     commit path at all. There is deliberately no method on the registry
  //     this card could call to end a take.
  //   - The samsloop-tap worklet (packages/dsp/src/samsloop-tap.ts)
  //     captures patched audio and posts L+R Float32 chunks to the main
  //     thread when enabled.
  //
  // Drawing strategy for the live waveform:
  //   - The bar's horizontal axis = `maxSeconds` at the current settings.
  //     One pixel = one slice of that timeline. As samples accumulate we
  //     fill from the left, drawing peak-per-pixel just like the static
  //     waveform after a recording finishes.
  //   - The peak buffer is registry-owned (never written to Yjs), so it keeps
  //     filling while this card is unmounted and re-expanding shows the WHOLE
  //     take rather than a hole where the collapse was. The only Yjs write is
  //     the single commit on STOP (one update per recording, not per frame —
  //     see relay-single-process-and-drift memory).

  import type { NodeProps } from '@xyflow/svelte';
  import NeonFader from '$lib/ui/controls/NeonFader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { patch } from '$lib/graph/store';
  import { docVersion } from '$lib/graph/node-versions.svelte';
  import {
    samsloopDef,
    loadSamsloopWav,
    samsloopDecodeBytesB64,
    SAMSLOOP_MAX_FILE_BYTES,
    SAMSLOOP_RATE_RANGE,
    type SamsloopData,
  } from '$lib/audio/modules/samsloop';
  import {
    knobToRate,
    rateToKnob,
    formatRatePercent,
  } from '$lib/audio/modules/samsloop-rate';
  import {
    samsloopMaxSeconds,
    samsloopMaxSecondsExact,
    samsloopAchievedRate,
    samsloopMaxCaptureFrames,
    decodeRecordedPcm,
    makeWavBlob,
    samsloopDownloadFilename,
    bytesToBase64,
    base64ToBytes,
    samsloopRackLedger,
    samsloopRackFullMessage,
    samsloopBindingCap,
    SAMSLOOP_REC_DEFAULTS,
    SAMSLOOP_RATE_OPTIONS,
    SAMSLOOP_MIN_RECORD_SECONDS,
    type SamsloopRecRate,
    type SamsloopRecBits,
    type SamsloopRecChannels,
  } from '$lib/audio/modules/samsloop-record';
  import { AudioEngine } from '$lib/audio/engine';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { cardParams, portsFromDef } from './card-kit';
  import { nodeSamsloop, type SamsloopTap } from './node-samsloop-registry.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const { set, live, engineCtx } = cardParams(samsloopDef, () => id, () => node);

  const defaultFor = (k: string): number =>
    samsloopDef.params.find((p) => p.id === k)!.defaultValue;

  let rate  = $derived(node?.params.rate  ?? defaultFor('rate'));
  let mode  = $derived(node?.params.mode  ?? defaultFor('mode'));
  let start = $derived(node?.params.start ?? defaultFor('start'));
  let end   = $derived(node?.params.end   ?? defaultFor('end'));

  // Sample length is derived from node.data. Used as the upper clamp for
  // the start/end sliders; the param's declared max (1e6) is a generous
  // ceiling. When no sample is loaded the sliders snap to [0, 1].
  let sampleLength = $derived.by(() => {
    const d = node?.data as SamsloopData | undefined;
    return d?.sampleLength ?? 0;
  });
  let fileName = $derived.by(() => {
    const d = node?.data as SamsloopData | undefined;
    return d?.fileName ?? null;
  });

  // Local decoded buffer for the waveform preview when the upload
  // persists via the new `fileBytesB64` path (decoded PCM is intentionally
  // NOT in node.data — see samsloop.ts SamsloopData header comment). We
  // decode once per (fileSize, fileName) signature + cache. The legacy
  // `samples` path still draws directly from node.data.samples (no
  // decode needed) so old patches don't pay this cost.
  let displaySamples = $state<Float32Array | null>(null);
  let displaySamplesSig = $state<string | null>(null);

  // Recording settings live on node.data so they ride the Yjs envelope.
  // Defaults come from SAMSLOOP_REC_DEFAULTS (CHAN=Mono, BITS=16,
  // RATE=48 kHz) — see that constant for why each one is what it is.
  let recChannels: SamsloopRecChannels = $derived(
    ((node?.data as SamsloopData | undefined)?.recChannels ?? SAMSLOOP_REC_DEFAULTS.channels) as SamsloopRecChannels,
  );
  let recBits: SamsloopRecBits = $derived(
    ((node?.data as SamsloopData | undefined)?.recBits ?? SAMSLOOP_REC_DEFAULTS.bits) as SamsloopRecBits,
  );
  let recRate: SamsloopRecRate = $derived(
    ((node?.data as SamsloopData | undefined)?.recRate ?? SAMSLOOP_REC_DEFAULTS.rate) as SamsloopRecRate,
  );

  // Whether there's a finished recorded sample on node.data.
  let hasRecorded = $derived.by(() => {
    const d = node?.data as SamsloopData | undefined;
    return !!d?.sample && d.sample.byteLength > 0;
  });

  // Whether there's an uploaded file we could download (new fileBytesB64
  // path). Legacy `samples`-only patches can't download — they don't have
  // the original bytes, and re-encoding the decoded PCM back to WAV would
  // be one more code path to maintain. The DOWNLOAD button just stays
  // disabled in that legacy case (the patch still plays fine).
  let hasUploaded = $derived.by(() => {
    const d = node?.data as SamsloopData | undefined;
    return !!d?.fileBytesB64 && d.fileBytesB64.length > 0;
  });


  const inputs = portsFromDef(samsloopDef.inputs, {
    rate_cv: 'RATE (CV)', audio_l_in: 'L IN', audio_r_in: 'R IN',
  });
  const outputs = portsFromDef(samsloopDef.outputs);

  let canvasEl: HTMLCanvasElement | null = $state(null);
  let uploadStatus = $state<string | null>(null);
  let uploadError = $state<string | null>(null);
  let isLoop = $derived(Math.round(mode) === 1);

  // ---------- recording state ----------
  //
  // ⚠ THE TAKE IS NOT HELD HERE. `$lib/ui/modules/node-samsloop-registry` owns
  // the tap subscription, the PCM accumulator, the live peak buffer and the
  // encode-and-commit for the whole lifetime of a recording, keyed to the NODE.
  // Everything below is a READ of it. This card holds nothing it could kill,
  // which is the point: collapsing the module used to destroy the take (#1588),
  // and the fix is not "the card should be more careful" — it is that there is
  // nothing for a card unmount to reach.
  //
  // The tap-worklet port is still acquired lazily from the engine handle via
  // the 'recTap' read key at REC-press time, because that is a user gesture on
  // a mounted card. The registry owns it from there.

  /** Arm-time refusals only (engine not ready / rack full). Genuinely
   *  card-scoped: they are the response to a click on THIS card, and they must
   *  NOT survive a remount pretending to describe a live take. */
  let recError = $state<string | null>(null);

  /** The node's own take — null when this node has never recorded. */
  let take = $derived(nodeSamsloop.view(id));

  // The AudioContext rate the tap captures at. Everything downstream —
  // the achieved rate, the byte budget, the accumulator capacity — is a
  // function of this, so it is read from the live engine rather than
  // assumed. Seeded at 48 kHz (what almost every device reports) purely so
  // the max-seconds label reads sensibly before audio has started; the
  // value that reaches a recording is always the tap's own.
  let captureRate = $state<number>(48_000);

  // ⚠ READ FROM THE REGISTRY, NOT FROM CARD STATE. This is what makes a
  // re-expanded card show STOP (and the running bar) for a take that started
  // before it mounted — the collapse/re-expand round trip #1588 is about.
  let isRecording = $derived(nodeSamsloop.isRecording(id));
  // "max length reached". ⚠ ALSO GATED ON `hasRecorded`, which the card-local
  // version got for free: the registry entry now outlives the card (that is the
  // point), so without this an UPLOAD after a cap-stopped take would keep
  // showing a message about a recording the module no longer holds. The upload
  // path deletes `d.sample`, so `hasRecorded` is exactly the right term.
  let isCapStopped = $derived(
    take?.state === 'stopped' && take.stopReason === 'cap' && hasRecorded,
  );
  let uploadInFlight = $derived(uploadStatus !== null);
  // NOTE: `recButtonDisabled` is declared AFTER `rackFull` below — it depends
  // on the rack ledger, and a `$derived` that reads a later `let` is a TDZ
  // hazard rather than merely untidy.
  let fileInputDisabled = $derived(isRecording);

  // The rate the bytes will ACTUALLY be stored at. `recRate` is only the
  // RATE switch — `downsample` decimates by an integer factor, so asking
  // for 44.1 kHz from a 48 kHz context yields 48 kHz. Everything that
  // counts bytes or seconds must use THIS, not the switch; using the
  // switch is what made the encoder overshoot the budget on every take
  // (and then get silently trimmed) as well as detuning playback.
  let achievedRate = $derived(samsloopAchievedRate(captureRate, recRate));

  // THE RACK BUDGET. What every OTHER samsloop in this rack is already
  // costing, in the base64 bytes the relay actually accounts. This node is
  // excluded because a REC replaces its own payload (recording AND upload —
  // `clearSamsloopUploadKeys` runs first), so charging it for bytes it is
  // about to release would make re-recording progressively harder.
  //
  // Derived for DISPLAY only. `startRecording` re-reads it fresh, so the gate
  // never depends on reactivity having kept up.
  //
  // ⚠ `docVersion()` IS THE SUBSCRIPTION, and it is not optional. Reading
  // `patch.nodes` alone tracks nothing across nodes: a peer (or another card)
  // committing a sample on a DIFFERENT samsloop left this derived stale, so
  // the readout kept offering 31.25 s on a rack with no room. Caught by the
  // e2e, which is the only place it was observable — the arm-time gate reads
  // fresh and would still have refused correctly, i.e. the BUDGET was right
  // and only its VISIBILITY was broken, which is precisely the half the owner
  // called out as the thing that must not fail quietly.
  //
  // `docVersion()` is the coarse whole-doc counter (one bump per
  // transaction) rather than the per-node signals, because the ledger's
  // subject is "every samsloop in the rack" and enumerating them reactively
  // costs a second walk. MEASURED cost of the walk it re-triggers: 0.017 ms
  // at 40 nodes / 4 samsloops, 0.175 ms at 100 nodes / 20 samsloops (20 is
  // the hard per-rack instance cap) — ~1 % of a 60 fps frame at the realistic
  // shape. If that ever shows up in a profile, the lever is to subscribe to
  // `nodesStructuralVersion()` plus `nodeVersion(id)` for the samsloop ids
  // only, so an unrelated knob drag stops invalidating it.
  let rackLedger = $derived.by(() => {
    docVersion();
    return samsloopRackLedger(patch.nodes, id);
  });

  // maxSeconds at the current settings — drives the bar's x-axis AND
  // the auto-stop trigger. Bounded by the rack budget as well as the per-take
  // one, so the number on screen is what THIS rack can record, not what the
  // settings could in principle.
  let maxSeconds = $derived(
    samsloopMaxSeconds(achievedRate, recBits, recChannels, rackLedger.freeBytes),
  );
  let maxSecondsExact = $derived(
    samsloopMaxSecondsExact(achievedRate, recBits, recChannels, rackLedger.freeBytes),
  );
  // Which of the three caps is binding — the card says WHICH, because "your
  // settings are expensive", "60 s is the ceiling" and "this rack is full"
  // need three different actions.
  let bindingCap = $derived(
    samsloopBindingCap(achievedRate, recBits, recChannels, rackLedger.freeBytes),
  );
  // Not enough headroom to offer a usable take. REC refuses to arm — see
  // startRecording; this drives the disabled state so the refusal is visible
  // BEFORE the click, not only after it.
  let rackFull = $derived(maxSecondsExact < SAMSLOOP_MIN_RECORD_SECONDS);

  // Disabled while an upload is in flight, and while the rack has no room —
  // but NEVER while recording, or STOP would be unreachable.
  let recButtonDisabled = $derived(uploadInFlight || (rackFull && !isRecording));
  // Shown next to the RATE switch when the switch cannot be honoured, so
  // the control never silently claims a rate it does not produce.
  let rateIsExact = $derived(achievedRate === recRate);

  function pushRecSetting<K extends 'recChannels' | 'recBits' | 'recRate'>(
    key: K,
    value: SamsloopData[K],
  ) {
    const t = patch.nodes[id];
    if (!t) return;
    if (!t.data) t.data = {};
    const d = t.data as SamsloopData;
    d[key] = value as never;
    // If the user changes a setting mid-recording: stop the recording
    // cleanly. Whatever was captured up to that point is committed. (The
    // registry freezes the settings for a take's duration precisely because
    // this is the only way they can change under it.)
    if (isRecording) {
      stopRecording();
    }
  }

  function pickRecChannels(v: SamsloopRecChannels) {
    pushRecSetting('recChannels', v);
  }
  function pickRecBits(v: SamsloopRecBits) {
    pushRecSetting('recBits', v);
  }
  function pickRecRate(v: SamsloopRecRate) {
    pushRecSetting('recRate', v);
  }

  /** Acquire the tap from the engine handle. Returns null until the engine
   *  has finished mounting this node's handle — the card retries via the
   *  REC click handler (no-op spam protection). */
  function getTap(): SamsloopTap | null {
    const eng = engineCtx.get();
    if (!eng || !node) return null;
    try {
      const r = eng.read(node, 'recTap');
      if (!r) return null;
      const tap = r as SamsloopTap;
      if (tap.sampleRate > 0) captureRate = tap.sampleRate;
      return tap;
    } catch {
      return null;
    }
  }

  /** Read the live AudioContext rate. Returns false until the audio engine
   *  exists — the max-seconds label depends on it, and the label is on
   *  screen long before anyone presses REC. */
  function refreshCaptureRate(): boolean {
    const eng = engineCtx.get();
    if (!eng) return false;
    try {
      if (!eng.hasDomain('audio')) return false;
      const sr = eng.getDomain<AudioEngine>('audio').ctx.sampleRate;
      if (!(sr > 0)) return false;
      captureRate = sr;
      return true;
    } catch {
      return false;
    }
  }

  // `engineCtx.get()` is not reactive, so poll until the engine boots and
  // then stop. Bounded twice over — it clears the instant the engine appears,
  // and gives up after 500 ms × 60 = 30 s so a rack that never starts audio
  // does not keep 20 cards' worth of timers alive. After that the seeded
  // 48 kHz stands for the LABEL only: `startRecording` reads the tap's own
  // rate, so a recording is never encoded against a guess.
  $effect(() => {
    if (refreshCaptureRate()) return;
    let tries = 0;
    const t = setInterval(() => {
      if (refreshCaptureRate() || ++tries >= 60) clearInterval(t);
    }, 500);
    return () => clearInterval(t);
  });

  function startRecording() {
    const tap = getTap();
    if (!tap) {
      recError = 'Audio engine not ready yet — start audio first.';
      return;
    }

    // ⚠ THE RACK GATE, READ FRESH. Not the `$derived` — a peer's sample can
    // land between the last render and this click, and a budget check that
    // trusts a stale snapshot is a budget check that can be raced past.
    //
    // REFUSE TO ARM rather than shorten silently. This module just deleted a
    // truncation that cut 8 % off every take without saying so; the ceiling
    // one layer up must not repeat it. The refusal names the numbers and
    // lands in the same `samsloop-rec-error` line the engine-not-ready
    // message uses. Nothing is deleted and nothing already recorded stops
    // playing — a rack that is ALREADY over budget (they exist; the ledger is
    // new, the racks are not) is grandfathered in exactly this sense: it keeps
    // everything it has and simply cannot record more until something goes.
    const liveLedger = samsloopRackLedger(patch.nodes, id);
    const liveMaxSeconds = samsloopMaxSecondsExact(
      samsloopAchievedRate(tap.sampleRate, recRate),
      recBits,
      recChannels,
      liveLedger.freeBytes,
    );
    if (liveMaxSeconds < SAMSLOOP_MIN_RECORD_SECONDS) {
      recError = samsloopRackFullMessage(liveLedger);
      return;
    }

    recError = null;
    uploadStatus = null;
    uploadError = null;

    // Hand the fully-resolved configuration to the NODE-keyed registry. It owns
    // the tap, the accumulator, the peak bar and the commit from here; this card
    // keeps no handle it could tear down.
    //
    // The bar's pixel width is read lazily from the live canvas (it can change
    // if the window was resized between recordings), and the accumulator is
    // sized from the TAP'S OWN rate so the encoded result is provably inside
    // the byte budget and the 60 s length cap.
    nodeSamsloop.start(id, {
      tap,
      captureFrames: samsloopMaxCaptureFrames(
        tap.sampleRate, recRate, recBits, recChannels, liveLedger.freeBytes,
      ),
      barWidth: canvasEl?.width ?? 200,
      barSeconds: liveMaxSeconds,
      rate: recRate,
      bits: recBits,
      channels: recChannels,
    });
  }

  /** USER INTENT ONLY. The cap-stop lives in the registry, because it has to
   *  fire whether or not a card is mounted (`node-samsloop-registry`). */
  function stopRecording() {
    nodeSamsloop.stop(id, 'user');
  }

  function toggleRecord() {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  }

  function onDownloadClick() {
    const d = node?.data as SamsloopData | undefined;
    // Two download paths, with the recording sample taking precedence if
    // both exist (recording is the more recent user intent — they hit REC
    // after loading a file):
    //   1. Recording (`d.sample.bytesB64`) → WAV via makeWavBlob.
    //   2. Upload (`d.fileBytesB64`) → ORIGINAL file bytes verbatim with
    //      the original filename. No re-encoding: an mp3 stays an mp3, a
    //      wav stays a wav. Lossless + tiny code path; the user's
    //      already-encoded source is the best download artifact.
    const sample = d?.sample;
    if (sample && sample.byteLength > 0) {
      const u8 = base64ToBytes(sample.bytesB64);
      const blob = makeWavBlob(u8, sample.rate, sample.bits, sample.channels);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = samsloopDownloadFilename();
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      return;
    }
    if (d?.fileBytesB64 && d.fileBytesB64.length > 0) {
      const u8 = base64ToBytes(d.fileBytesB64);
      // Buffer-typed Uint8Array → Blob with the recorded mime (or
      // octet-stream as a safe default if the browser didn't supply one).
      const mime = d.fileMime && d.fileMime.length > 0 ? d.fileMime : 'application/octet-stream';
      // Use the explicit BlobPart array form (Uint8Array is BufferSource).
      const blob = new Blob([u8 as BlobPart], { type: mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      // Preserve the original filename when we have it; fall back to a
      // generic timestamped name like the recording path does.
      a.download = d.fileName && d.fileName.length > 0
        ? d.fileName
        : samsloopDownloadFilename();
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      return;
    }
  }

  // ⚠ THERE IS NO RECORDING TEARDOWN ON UNMOUNT, AND THAT IS THE FIX (#1588).
  //
  // What used to be here:
  //
  //     $effect(() => () => {
  //       if (attachedTap) {
  //         attachedTap.setEnabled(false);
  //         attachedTap.port.removeEventListener('message', tapHandler);
  //       }
  //       if (pendingPeakRaf !== null) cancelAnimationFrame(pendingPeakRaf);
  //       if (recCounterTicker !== null) clearInterval(recCounterTicker);
  //     });
  //
  // …with no `stopRecording()` anywhere on the unmount path, so the buffer was
  // dropped un-encoded. The comment that shipped with it — "so we don't leave
  // the tap enabled if the user destroys the card mid-recording" — was correct
  // when a card unmount implied the module was going away. Under the faceplate
  // shell SAMSLOOP is un-migrated, so its card exists only inside the dock
  // full-view and a COLLAPSE produces the identical unmount; the teardown could
  // not tell the two apart, and the card is not entitled to decide because it
  // cannot distinguish them.
  //
  // Teardown is keyed to GRAPH lifetime instead: `nodeSamsloop.sweep(liveIds)`
  // runs from Canvas beside nodeMedia / nodePresent / nodeRecorder, so a node
  // deleted by ANY route (menu, lasso, undo, a peer's CRDT delete, Clear, a
  // patch load) ends its take and no delete site has to remember. The registry
  // exposes NO per-card teardown method — the absence is the guard, and `tsc`
  // refuses the regression before any test runs.

  async function onAudioFileChange(ev: Event) {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    uploadError = null;
    uploadStatus = 'parsing...';
    let successStatus: string | null = null;
    try {
      const eng = engineCtx.get();
      let ctx: BaseAudioContext | undefined;
      try {
        if (eng?.hasDomain('audio')) {
          const audioEngine = eng.getDomain<AudioEngine>('audio');
          ctx = audioEngine.ctx;
        }
      } catch {
        ctx = undefined;
      }
      if (!ctx) {
        uploadError = 'Audio engine not ready yet — start audio first.';
        return;
      }
      const result = await loadSamsloopWav(file, ctx);
      if (!result.ok) {
        uploadError = result.error ?? 'Unknown error';
        return;
      }
      const samples = result.samples!;
      const target = patch.nodes[id];
      if (!target) {
        uploadError = 'Module was removed during upload.';
        return;
      }
      if (!target.data) target.data = {};
      const d = target.data as SamsloopData;
      // NEW persistence path: store the ORIGINAL file bytes (base64)
      // as the single opaque Yjs value — NOT the decoded PCM. At the
      // 1.5M-sample cap a number[] of decoded samples would be ~12 MB
      // and would explode the syncedstore CRDT (one YArray entry per
      // sample). The factory hydrates fileBytesB64 → decoded buffer via
      // samsloopDecodeBytesB64 + reposts to the worklet on patch load.
      // See samsloop.ts SamsloopData header comment for the full design.
      if (result.fileBytes) {
        d.fileBytesB64 = bytesToBase64(result.fileBytes);
        d.fileSize = result.fileSize ?? result.fileBytes.byteLength;
        d.fileMime = result.fileMime ?? '';
      }
      // Drop the legacy decoded-PCM array on re-upload. Old patches that
      // hydrated with `samples` set should NOT carry a stale buffer
      // alongside fresh fileBytesB64; the factory prefers fileBytesB64
      // but cleaning up keeps the patch envelope sane.
      if (d.samples) delete d.samples;
      // Same reason, the other direction: an upload REPLACES a recording (the
      // one-sample invariant). Without this the two keys coexist and the
      // reader's precedence — not the user's last action — decides what plays.
      if (d.sample) delete d.sample;
      d.sampleRate = result.sampleRate;
      d.sampleLength = samples.length;
      d.fileName = file.name;
      target.params.start = 0;
      target.params.end = samples.length;
      // The engine factory polls node.data every POLL_MS (200ms) and
      // picks up the new fileBytesB64 signature → decodes + pushes to
      // the worklet. Sub-quarter-second audible delay; the alternative
      // (wiring a push channel through the engine handle) wasn't worth
      // the extra surface area.
      successStatus = `loaded ${samples.length} samples @ ${result.sampleRate} Hz`;
    } finally {
      uploadStatus = successStatus;
      try { input.value = ''; } catch { /* */ }
    }
  }

  function toggleMode() {
    const t = patch.nodes[id];
    if (!t) return;
    t.params.mode = Math.round(mode) === 1 ? 0 : 1;
  }

  // ---------- manual TRIGGER ----------
  //
  // SAMSLOOP is idle-by-default (no autoplay). The on-card TRIGGER button
  // fires a momentary rising edge straight at the playback worklet — the
  // engine handle exposes a `manualTrigger` function (read key) that posts a
  // `{ type: 'trigger' }` port message. It works whether or not a cable is
  // patched into the `trig` input, and is MODE-AWARE in the worklet: in
  // one-shot it plays the sample through once then returns to silence; in
  // loop it starts/restarts the loop. The play-state is worklet-private and
  // never persisted, so this never auto-resumes on patch load.
  let triggerPulse = $state(false); // momentary visual flash on the button
  function fireTrigger() {
    const e = engineCtx.get();
    if (!e || !node) return;
    const trig = e.read(node, 'manualTrigger');
    if (typeof trig === 'function') {
      (trig as () => void)();
      triggerPulse = true;
      setTimeout(() => { triggerPulse = false; }, 120);
    }
  }

  // Decode `fileBytesB64` lazily for the waveform preview. Runs on
  // signature change (new upload OR initial hydrate from a persisted
  // patch). Errors during decode here are silent — the playback path
  // (engine factory) is what surfaces decode failures to the user; this
  // is purely a draw assist. If the decode fails the waveform shows
  // "NO SAMPLE LOADED" but playback still works (or fails) on its own.
  $effect(() => {
    const d = node?.data as SamsloopData | undefined;
    if (!d?.fileBytesB64 || d.fileBytesB64.length === 0) {
      if (displaySamples !== null) {
        displaySamples = null;
        displaySamplesSig = null;
      }
      return;
    }
    const sig = `${d.fileSize ?? d.fileBytesB64.length}:${d.fileName ?? ''}`;
    if (sig === displaySamplesSig) return;
    const eng = engineCtx.get();
    let ctx: BaseAudioContext | undefined;
    try {
      if (eng?.hasDomain('audio')) {
        ctx = eng.getDomain<AudioEngine>('audio').ctx;
      }
    } catch {
      ctx = undefined;
    }
    if (!ctx) return; // Try again once the engine boots — $effect re-runs.
    let cancelled = false;
    const b64 = d.fileBytesB64;
    (async () => {
      const r = await samsloopDecodeBytesB64(b64, ctx);
      if (cancelled) return;
      if (r && r.ok && r.samples) {
        displaySamples = r.samples;
        displaySamplesSig = sig;
      }
    })();
    return () => { cancelled = true; };
  });

  // Peak-per-pixel waveform draw. Two modes:
  //   - While recording: draw the live-peak buffer (`recRunningPeaks`)
  //     with the bar's x-axis = maxSeconds. Slots that haven't been
  //     filled yet stay blank.
  //   - Idle / after recording: draw the loaded `samples` (file upload)
  //     OR the static peaks of the persisted node.data.sample.bytes
  //     (recorded). When neither exists, "NO SAMPLE LOADED" placeholder.
  $effect(() => {
    // Track reactivity dependencies explicitly.
    void sampleLength; void start; void end;
    void isRecording; void maxSeconds; void hasRecorded;
    if (!canvasEl) return;
    const ctx2d = canvasEl.getContext('2d');
    if (!ctx2d) return;
    const w = canvasEl.width;
    const h = canvasEl.height;
    ctx2d.clearRect(0, 0, w, h);
    ctx2d.fillStyle = '#0a0c11';
    ctx2d.fillRect(0, 0, w, h);

    if (isRecording) {
      // Live-record view: bar's x-axis = the take's own barSeconds.
      //
      // ⚠ `progress()` is read ONLY on this branch, and that is deliberate: it
      // subscribes to the registry's 20 Hz publish counter, and an IDLE
      // samsloop card's draw below decodes its persisted PCM on every run. A
      // single shared counter would have made every idle card re-decode 20×
      // a second whenever any samsloop in the rack was recording.
      const live = nodeSamsloop.progress(id);
      const peaks = live?.peaks ?? new Float32Array(0);
      const cols = Math.min(w, peaks.length);
      ctx2d.fillStyle = 'rgba(255, 60, 60, 0.18)';
      // Highlight already-filled region. ⚠ `elapsed` here is frames/rate — the
      // LENGTH OF THE TAKE, not the wall clock. A wall clock would keep the bar
      // sliding right even if the tap had gone silent, which is precisely the
      // half-fix this whole change exists to make impossible to ship.
      const axis = Math.max(live?.barSeconds ?? maxSecondsExact, 0.001);
      const filledFrac = Math.min(1, (live?.elapsed ?? 0) / axis);
      ctx2d.fillRect(0, 0, filledFrac * w, h);
      ctx2d.strokeStyle = 'rgb(255, 80, 60)';
      ctx2d.lineWidth = 1;
      ctx2d.beginPath();
      for (let x = 0; x < cols; x++) {
        const peak = peaks[x] ?? 0;
        if (peak === 0) continue;
        const y0 = (1 - peak * 0.5 - 0.5) * h;
        const y1 = (1 - (-peak) * 0.5 - 0.5) * h;
        ctx2d.moveTo(x + 0.5, y0);
        ctx2d.lineTo(x + 0.5, y1);
      }
      ctx2d.stroke();
      // Right edge: thin vertical to show the cap.
      ctx2d.strokeStyle = 'rgba(255, 200, 60, 0.5)';
      ctx2d.beginPath();
      ctx2d.moveTo(w - 0.5, 0);
      ctx2d.lineTo(w - 0.5, h);
      ctx2d.stroke();
      return;
    }

    // Idle / playback view. Source priority:
    //   1. `displaySamples` — locally-decoded buffer from the NEW
    //      fileBytesB64 path (current uploads use this).
    //   2. `d.samples` — legacy YArray PCM from pre-PR-#XXX patches.
    //   3. `d.sample.bytesB64` — the recording-path bytes (separate
    //      feature from uploads; the card draws L-channel peaks).
    const d = node?.data as SamsloopData | undefined;
    let samplesForDraw: Float32Array | null = null;
    if (displaySamples && displaySamples.length > 0) {
      samplesForDraw = displaySamples;
    } else if (d?.samples && d.samples.length > 0) {
      samplesForDraw = new Float32Array(d.samples);
    } else if (d?.sample && d.sample.byteLength > 0) {
      // Decode the persisted PCM bytes back to Float32 for the waveform
      // preview, through the SAME decoder the playback path uses. It used to
      // be a second hand-rolled copy of this arithmetic here — and the two
      // sides drifting is precisely how the recording came to draw correctly
      // while making no sound. `'left'` keeps the trace's shape stable
      // regardless of the CHAN setting; playback asks for `'mix'`.
      samplesForDraw = decodeRecordedPcm(d.sample, 'left');
    }
    if (!samplesForDraw || samplesForDraw.length === 0) {
      ctx2d.fillStyle = '#5a6275';
      ctx2d.font = '10px ui-monospace, monospace';
      ctx2d.textAlign = 'center';
      ctx2d.fillText('NO SAMPLE LOADED', w / 2, h / 2);
      return;
    }
    const samples = samplesForDraw;
    // The START..END highlight band. It used to be drawn for UPLOADS ONLY, on
    // the reasoning that "for recorded-only samples the start/end params
    // haven't been touched yet" — which was true only because a recording did
    // not play at all, so its window meant nothing. Now that it does, the
    // window is exactly as real for a take as for an upload and the band has
    // to show it: whatever is drawn here is the slice the worklet loops.
    {
      const wStartFrac = Math.max(0, Math.min(1, start / samples.length));
      const wEndFrac = Math.max(wStartFrac, Math.min(1, end / samples.length));
      ctx2d.fillStyle = 'rgba(80, 160, 220, 0.18)';
      ctx2d.fillRect(wStartFrac * w, 0, (wEndFrac - wStartFrac) * w, h);
    }
    const samplesPerPx = Math.max(1, Math.floor(samples.length / w));
    ctx2d.strokeStyle = 'rgb(255, 150, 40)';
    ctx2d.lineWidth = 1;
    ctx2d.beginPath();
    for (let x = 0; x < w; x++) {
      const i0 = x * samplesPerPx;
      const i1 = Math.min(samples.length, i0 + samplesPerPx);
      let mn = 0;
      let mx = 0;
      for (let i = i0; i < i1; i++) {
        const s = samples[i] ?? 0;
        if (s < mn) mn = s;
        if (s > mx) mx = s;
      }
      const y0 = (1 - (mx * 0.5 + 0.5)) * h;
      const y1 = (1 - (mn * 0.5 + 0.5)) * h;
      ctx2d.moveTo(x + 0.5, y0);
      ctx2d.lineTo(x + 0.5, y1);
    }
    ctx2d.stroke();
  });
</script>

<div class="mod-card samsloop-card" data-testid="samsloop-card">
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <ModuleTitle {id} {data} defaultLabel="SAMSLOOP" />
  <div class="subtitle">SAMPLE LOOPER · STEREO REC · −200%…+200%</div>

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="body">
      <div class="upload-row">
        <label
          class="upload-btn"
          class:disabled={fileInputDisabled}
          data-testid="samsloop-upload-label"
        >
          <input
            type="file"
            accept="audio/*"
            onchange={onAudioFileChange}
            disabled={fileInputDisabled}
            data-testid="samsloop-wav-input"
          />
          <span>Load audio (≤ {SAMSLOOP_MAX_FILE_BYTES / (1024 * 1024)} MB)…</span>
        </label>
        <button
          type="button"
          class="mode-btn"
          class:loop={isLoop}
          onclick={toggleMode}
          data-testid="samsloop-mode-toggle"
          aria-label="Toggle loop / one-shot"
        >{isLoop ? 'LOOP' : '1-SHOT'}</button>
      </div>

      <!-- TRIGGER row: SAMSLOOP is idle-by-default (no autoplay). This
           button fires a momentary rising edge at the worklet to START
           playback per the current mode (one-shot = play once; loop =
           start/restart). Mirrors the `trig` gate input; works with or
           without a cable patched. -->
      <div class="trigger-row">
        <button
          type="button"
          class="trigger-btn"
          class:pulse={triggerPulse}
          onclick={fireTrigger}
          data-testid="samsloop-trigger-button"
          aria-label="Trigger playback"
        >▶ TRIGGER</button>
        <span class="trigger-hint">{isLoop ? 'start / restart loop' : 'play once'}</span>
      </div>

      <!-- Record settings row: three discrete toggle switches matching
           the brief (CHAN / BITS / RATE). Each switch is a paired button:
           the active option is highlighted. -->
      <div class="rec-settings-row" data-testid="samsloop-rec-settings">
        <div class="rec-setting">
          <span class="rec-setting-label">CHAN</span>
          <button
            type="button"
            class="rec-setting-opt"
            class:active={recChannels === 1}
            disabled={isRecording}
            onclick={() => pickRecChannels(1)}
            data-testid="samsloop-chan-mono"
          >MONO</button>
          <button
            type="button"
            class="rec-setting-opt"
            class:active={recChannels === 2}
            disabled={isRecording}
            onclick={() => pickRecChannels(2)}
            data-testid="samsloop-chan-stereo"
          >STEREO</button>
        </div>
        <div class="rec-setting">
          <span class="rec-setting-label">BITS</span>
          <button
            type="button"
            class="rec-setting-opt"
            class:active={recBits === 8}
            disabled={isRecording}
            onclick={() => pickRecBits(8)}
            data-testid="samsloop-bits-8"
          >8</button>
          <button
            type="button"
            class="rec-setting-opt"
            class:active={recBits === 16}
            disabled={isRecording}
            onclick={() => pickRecBits(16)}
            data-testid="samsloop-bits-16"
          >16</button>
        </div>
        <div class="rec-setting">
          <span class="rec-setting-label">RATE</span>
          <!-- Options come from SAMSLOOP_RATE_OPTIONS so the switch cannot
               drift from the type + the budget table (card-vs-def divergence
               is a known blind spot — see CLAUDE.md). testids stay the
               stable `samsloop-rate-<n>k` shape the e2e specs use. -->
          {#each SAMSLOOP_RATE_OPTIONS as opt (opt)}
            <button
              type="button"
              class="rec-setting-opt"
              class:active={recRate === opt}
              disabled={isRecording}
              onclick={() => pickRecRate(opt)}
              data-testid={`samsloop-rate-${Math.round(opt / 1000)}k`}
            >{Math.round(opt / 1000)}k</button>
          {/each}
        </div>
      </div>
      {#if !rateIsExact}
        <!-- The RATE switch is a REQUEST. `downsample` decimates by an
             integer factor, so it cannot always be honoured — say so rather
             than letting the control claim a rate it does not produce. -->
        <div class="rec-rate-note" data-testid="samsloop-rate-note">
          records at {(achievedRate / 1000).toFixed(1)}k — {(captureRate / 1000).toFixed(1)}k
          input doesn't divide to {Math.round(recRate / 1000)}k
        </div>
      {/if}

      <div class="rec-bar-row">
        <button
          type="button"
          class="rec-btn-big"
          class:active={isRecording}
          disabled={recButtonDisabled}
          onclick={toggleRecord}
          data-testid="samsloop-rec-button"
          aria-label={isRecording ? 'Stop recording' : 'Start recording'}
        >
          <span class="rec-dot"></span>
          <span class="rec-label">{isRecording ? 'STOP' : 'REC'}</span>
        </button>
        <span class="rec-budget" data-testid="samsloop-max-seconds">
          {maxSeconds.toFixed(2)}s max
        </span>
        <button
          type="button"
          class="download-btn"
          disabled={(!hasRecorded && !hasUploaded) || isRecording}
          onclick={onDownloadClick}
          data-testid="samsloop-download-button"
          aria-label="Download sample"
        >DOWNLOAD</button>
      </div>

      {#if fileName}
        <div class="filename" data-testid="samsloop-filename">{fileName}</div>
      {/if}
      {#if uploadStatus}
        <div class="upload-status" data-testid="samsloop-upload-status">{uploadStatus}</div>
      {/if}
      {#if uploadError}
        <div class="upload-error" data-testid="samsloop-upload-error">{uploadError}</div>
      {/if}
      {#if bindingCap === 'rack'}
        <!-- ⚠ THE RACK BUDGET, MADE VISIBLE BEFORE THE CLICK. The whole point
             of the ledger is that hitting it is never a surprise: while it is
             the binding cap the "N.NNs max" readout above is ALREADY the
             shortened number, and this line says why and by how much. When
             there is no usable room left the REC button is disabled too, and
             clicking it (or arming via any other path) lands
             `samsloopRackFullMessage` in the error line below. -->
        <div class="upload-status" data-testid="samsloop-rack-budget-note">
          rack sample budget: {(rackLedger.usedBytes / 1_000_000).toFixed(1)} /
          {(rackLedger.budgetBytes / 1_000_000).toFixed(0)} MB used
          {#if rackFull}— no room to record{:else}— capped to {maxSeconds.toFixed(2)}s{/if}
        </div>
      {/if}
      {#if isCapStopped}
        <div class="upload-status" data-testid="samsloop-rec-cap-msg">max length reached</div>
      {/if}
      {#if recError}
        <div class="upload-error" data-testid="samsloop-rec-error">{recError}</div>
      {/if}

      <div class="waveform-row">
        <NeonFader
          value={start}
          min={0}
          max={Math.max(1, sampleLength)}
          defaultValue={0}
          label="Start"
          curve="linear"
          onchange={set('start')} moduleId={id} paramId="start"
          readLive={live('start')}
        />
        <canvas
          bind:this={canvasEl}
          width="200"
          height="100"
          class="waveform"
          data-testid="samsloop-waveform"
        ></canvas>
        <NeonFader
          value={end}
          min={0}
          max={Math.max(1, sampleLength)}
          defaultValue={Math.max(1, sampleLength)}
          label="End"
          curve="linear"
          onchange={set('end')} moduleId={id} paramId="end"
          readLive={live('end')}
        />
      </div>

      <div class="rate-row">
        <NeonFader
          value={rateToKnob(rate)}
          min={0}
          max={1}
          defaultValue={rateToKnob(SAMSLOOP_RATE_RANGE.defaultValue)}
          label="Rate"
          curve="linear"
          ticks={[
            { frac: 0.0,        label: '-200%' },
            { frac: 1 / 6,      label: '-100%' },
            { frac: 1 / 3,      label: '0%' },
            { frac: 0.5,        label: 'Norm' },
            { frac: 1.0,        label: '+200%' },
          ]}
          onchange={(k: number) => set('rate')(knobToRate(k))}
          moduleId={id}
          paramId="rate"
          readLive={() => {
            const e = engineCtx.get(); if (!e || !node) return undefined;
            const r = e.readParam(node, 'rate');
            return r === undefined ? undefined : rateToKnob(r);
          }}
          formatValue={(k: number) => formatRatePercent(knobToRate(k))}
        />
      </div>
    </div>
  </PatchPanel>
</div>

<style>
  .samsloop-card {
    width: 360px;
    min-height: 420px;
  }  .samsloop-card .subtitle {
    font-size: 0.55rem;
    color: var(--text-dim, #8b94a5);
    text-align: center;
    letter-spacing: 0.08em;
    margin-top: 2px;
  }
  .samsloop-card .body {
    margin-top: 12px;
    padding: 0 14px 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .samsloop-card .upload-row {
    display: flex;
    gap: 6px;
    align-items: stretch;
  }
  .samsloop-card .upload-btn {
    flex: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: #1a1f2a;
    color: var(--text-dim, #8b94a5);
    border: 1px dashed #404652;
    border-radius: 2px;
    padding: 4px 8px;
    font-size: 0.6rem;
    cursor: pointer;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }
  .samsloop-card .upload-btn input[type='file'] {
    display: none;
  }
  .samsloop-card .upload-btn:hover {
    color: var(--text, #d8dde6);
    border-color: #6a7282;
  }
  .samsloop-card .upload-btn.disabled {
    opacity: 0.4;
    pointer-events: none;
  }
  .samsloop-card .mode-btn {
    background: #1a1f2a;
    color: var(--text-dim, #8b94a5);
    border: 1px solid #404652;
    border-radius: 2px;
    padding: 4px 10px;
    font-size: 0.6rem;
    cursor: pointer;
    letter-spacing: 0.08em;
    font-family: ui-monospace, monospace;
    min-width: 64px;
  }
  .samsloop-card .mode-btn.loop {
    color: rgb(80, 200, 220);
    border-color: rgb(80, 160, 220);
  }
  .samsloop-card .mode-btn:hover {
    border-color: #6a7282;
  }

  .samsloop-card .trigger-row {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .samsloop-card .trigger-btn {
    background: #15211a;
    color: rgb(120, 220, 140);
    border: 1px solid rgb(80, 180, 110);
    border-radius: 2px;
    padding: 5px 14px;
    font-size: 0.65rem;
    cursor: pointer;
    letter-spacing: 0.1em;
    font-family: ui-monospace, monospace;
    font-weight: 600;
  }
  .samsloop-card .trigger-btn:hover {
    background: #1c3024;
    border-color: rgb(110, 220, 140);
  }
  .samsloop-card .trigger-btn:active,
  .samsloop-card .trigger-btn.pulse {
    background: rgb(60, 180, 100);
    color: #061008;
    border-color: rgb(120, 240, 160);
  }
  .samsloop-card .trigger-hint {
    font-size: 0.5rem;
    color: var(--text-dim, #8b94a5);
    letter-spacing: 0.06em;
    font-family: ui-monospace, monospace;
    text-transform: uppercase;
  }

  .samsloop-card .rec-settings-row {
    display: flex;
    gap: 8px;
    justify-content: space-between;
  }
  .samsloop-card .rec-setting {
    display: inline-flex;
    align-items: center;
    gap: 2px;
  }
  .samsloop-card .rec-setting-label {
    font-size: 0.5rem;
    color: var(--text-dim, #8b94a5);
    letter-spacing: 0.08em;
    margin-right: 4px;
    font-family: ui-monospace, monospace;
  }
  .samsloop-card .rec-setting-opt {
    background: #1a1f2a;
    color: var(--text-dim, #8b94a5);
    border: 1px solid #404652;
    border-radius: 2px;
    padding: 2px 6px;
    font-size: 0.55rem;
    cursor: pointer;
    letter-spacing: 0.05em;
    font-family: ui-monospace, monospace;
  }
  .samsloop-card .rec-setting-opt:hover:not(:disabled) {
    border-color: #6a7282;
  }
  .samsloop-card .rec-setting-opt.active {
    color: rgb(255, 200, 60);
    border-color: rgb(220, 180, 60);
    background: #2a2515;
  }
  .samsloop-card .rec-setting-opt:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .samsloop-card .rec-rate-note {
    font-size: 0.5rem;
    color: var(--text-dim, #8b94a5);
    font-family: ui-monospace, monospace;
    letter-spacing: 0.02em;
  }

  .samsloop-card .rec-bar-row {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .samsloop-card .rec-btn-big {
    background: #1a1f2a;
    color: var(--text-dim, #8b94a5);
    border: 1px solid #404652;
    border-radius: 2px;
    padding: 6px 12px;
    font-size: 0.65rem;
    cursor: pointer;
    letter-spacing: 0.1em;
    font-family: ui-monospace, monospace;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .samsloop-card .rec-btn-big:hover:not(:disabled) {
    border-color: #6a7282;
  }
  .samsloop-card .rec-btn-big:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .samsloop-card .rec-btn-big.active {
    color: #ffffff;
    background: #c0282e;
    border-color: #ff6b6b;
  }
  .samsloop-card .rec-btn-big .rec-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #ff5050;
    display: inline-block;
  }
  .samsloop-card .rec-btn-big.active .rec-dot {
    background: #ffffff;
    animation: samsloop-rec-pulse 1s ease-in-out infinite;
  }
  .samsloop-card .rec-btn-big .rec-label {
    font-weight: 600;
  }
  .samsloop-card .rec-budget {
    flex: 1;
    text-align: center;
    font-size: 0.55rem;
    color: var(--text-dim, #8b94a5);
    font-family: ui-monospace, monospace;
  }
  .samsloop-card .download-btn {
    background: #1a1f2a;
    color: var(--text-dim, #8b94a5);
    border: 1px solid #404652;
    border-radius: 2px;
    padding: 6px 10px;
    font-size: 0.6rem;
    cursor: pointer;
    letter-spacing: 0.08em;
    font-family: ui-monospace, monospace;
  }
  .samsloop-card .download-btn:hover:not(:disabled) {
    color: rgb(80, 200, 220);
    border-color: rgb(80, 160, 220);
  }
  .samsloop-card .download-btn:disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }

  @keyframes samsloop-rec-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
  }
  .samsloop-card .filename {
    font-size: 0.55rem;
    color: var(--text-dim, #8b94a5);
    font-family: ui-monospace, monospace;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .samsloop-card .upload-status {
    font-size: 0.6rem;
    color: var(--text-dim, #8b94a5);
    font-family: ui-monospace, monospace;
  }
  .samsloop-card .upload-error {
    font-size: 0.6rem;
    color: #ff6b6b;
    font-family: ui-monospace, monospace;
  }
  .samsloop-card .waveform-row {
    display: flex;
    gap: 8px;
    align-items: stretch;
  }
  .samsloop-card .waveform {
    flex: 1;
    display: block;
    height: 100px;
    background: #0a0c11;
    border: 1px solid #2a2f3a;
    border-radius: 2px;
  }
  .samsloop-card .rate-row {
    margin-top: 6px;
    display: flex;
    justify-content: center;
  }
</style>
