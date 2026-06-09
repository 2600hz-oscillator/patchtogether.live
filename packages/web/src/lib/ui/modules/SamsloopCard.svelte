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
  //   - The mic-record state machine in $lib/audio/modules/samsloop.ts
  //     (samsloopRec*) is REUSED as the in-progress accumulator — same
  //     start/append/stop/fail/cap-stop transitions, just driven by the
  //     samsloop-tap worklet's MessagePort instead of a ScriptProcessor.
  //   - The samsloop-tap worklet (packages/dsp/src/samsloop-tap.ts)
  //     captures patched audio and posts L+R Float32 chunks to the main
  //     thread when enabled.
  //
  // Drawing strategy for the live waveform:
  //   - The bar's horizontal axis = `maxSeconds` at the current settings.
  //     One pixel = one slice of that timeline. As samples accumulate we
  //     fill from the left, drawing peak-per-pixel just like the static
  //     waveform after a recording finishes.
  //   - Local-only state (recRunningPeaks) — never written to Yjs. The
  //     only Yjs write is the single `setData` on STOP (one update per
  //     recording, not per frame — see relay-single-process-and-drift
  //     memory).

  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import {
    samsloopDef,
    loadSamsloopWav,
    samsloopDecodeBytesB64,
    SAMSLOOP_MAX_FILE_BYTES,
    SAMSLOOP_RATE_RANGE,
    createSamsloopRecMachine,
    samsloopRecStart,
    samsloopRecAppend,
    samsloopRecStop,
    samsloopRecFail,
    type SamsloopData,
    type SamsloopRecMachine,
  } from '$lib/audio/modules/samsloop';
  import {
    knobToRate,
    rateToKnob,
    formatRatePercent,
  } from '$lib/audio/modules/samsloop-rate';
  import {
    samsloopMaxSeconds,
    samsloopMaxSecondsExact,
    encodeRecordingBytes,
    makeWavBlob,
    samsloopDownloadFilename,
    bytesToBase64,
    base64ToBytes,
    SAMSLOOP_REC_DEFAULTS,
    SAMSLOOP_RECORD_BUDGET_BYTES,
    type SamsloopRecRate,
    type SamsloopRecBits,
    type SamsloopRecChannels,
  } from '$lib/audio/modules/samsloop-record';
  import { useEngine } from '$lib/audio/engine-context';
  import { AudioEngine } from '$lib/audio/engine';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

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
  // Defaults come from SAMSLOOP_REC_DEFAULTS — match the brief's spec
  // (CHAN=Stereo, BITS=16, RATE=44 kHz).
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

  const set = (k: string) => (v: number) => { const t = patch.nodes[id]; if (t) t.params[k] = v; };
  const live = (k: string) => () => {
    const e = engineCtx.get(); if (!e || !node) return undefined;
    return e.readParam(node, k);
  };

  const inputs: PortDescriptor[] = [
    { id: 'trig',       cable: 'gate' },
    { id: 'rate_cv',    label: 'RATE (CV)', cable: 'cv' },
    { id: 'audio_l_in', label: 'L IN',      cable: 'audio' },
    { id: 'audio_r_in', label: 'R IN',      cable: 'audio' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'out', cable: 'audio' },
  ];

  let canvasEl: HTMLCanvasElement | null = $state(null);
  let uploadStatus = $state<string | null>(null);
  let uploadError = $state<string | null>(null);
  let isLoop = $derived(Math.round(mode) === 1);

  // ---------- recording state ----------
  //
  // The state machine is the source of truth for the recording lifecycle
  // (idle → recording → stopped/idle). The tap-worklet port is acquired
  // lazily from the engine handle via the 'recTap' read key. We retry
  // briefly because the handle isn't always present immediately after
  // spawn — the engine factory finishes asynchronously.

  let recMachine = $state<SamsloopRecMachine>(createSamsloopRecMachine(48000));
  let recStartTimeMs = $state<number>(0);
  let recCounterTicker: ReturnType<typeof setInterval> | null = null;
  let recElapsedSec = $state<number>(0);

  // Live peak-per-pixel buffer. One entry per "time slot" along the bar's
  // horizontal axis (the bar maps `maxSeconds` to its width). When a
  // recording starts we allocate a buffer sized to the current bar pixel
  // width; the chunk handler folds incoming samples into the slot they
  // belong to. State is local — never written to Yjs.
  let recBarWidth = $state<number>(200);
  let recRunningPeaks = $state<Float32Array>(new Float32Array(0));

  // Tap port subscription bookkeeping. We attach the listener for the
  // lifetime of an active recording and detach on stop/teardown so
  // chunks don't fire after we've committed.
  let attachedTap: { port: MessagePort; setEnabled: (e: boolean) => void; sampleRate: number } | null = null;
  let tapHandler: ((e: MessageEvent) => void) | null = null;
  // rAF throttle: chunks arrive every ~3 ms at 48 kHz; without throttle
  // the waveform $effect would redraw 300+ times per second. We coalesce
  // redraw requests to one per animation frame.
  let pendingPeakRaf: number | null = null;

  // L/R accumulators for the current recording. We keep raw Float32 so
  // the quantize + downsample step on STOP works on the full-precision
  // capture (not on the visual peak slots, which are lossy by design).
  let accL: Float32Array = new Float32Array(0);
  let accR: Float32Array = new Float32Array(0);

  let isRecording = $derived(recMachine.state === 'recording');
  let isCapStopped = $derived(
    recMachine.state === 'stopped' && recMachine.stopReason === 'cap',
  );
  let uploadInFlight = $derived(uploadStatus !== null);
  let recButtonDisabled = $derived(uploadInFlight);
  let fileInputDisabled = $derived(isRecording);

  // maxSeconds at the current settings — drives the bar's x-axis AND
  // the auto-stop trigger.
  let maxSeconds = $derived(samsloopMaxSeconds(recRate, recBits, recChannels));
  let maxSecondsExact = $derived(samsloopMaxSecondsExact(recRate, recBits, recChannels));

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
    // cleanly. Whatever was captured up to that point is committed.
    if (isRecording) {
      stopRecording('user');
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
  function getTap(): { port: MessagePort; setEnabled: (e: boolean) => void; sampleRate: number } | null {
    const eng = engineCtx.get();
    if (!eng || !node) return null;
    try {
      const r = eng.read(node, 'recTap');
      if (!r) return null;
      return r as { port: MessagePort; setEnabled: (e: boolean) => void; sampleRate: number };
    } catch {
      return null;
    }
  }

  function startRecording() {
    const tap = getTap();
    if (!tap) {
      recMachine = samsloopRecFail(
        recMachine,
        'Audio engine not ready yet — start audio first.',
      );
      return;
    }
    uploadStatus = null;
    uploadError = null;

    // Allocate the visual peak slot buffer at the current bar pixel
    // width. Reading the canvas width lazily so the bar is real (it can
    // change if the user resizes the window between recordings).
    const w = canvasEl?.width ?? 200;
    recBarWidth = w;
    recRunningPeaks = new Float32Array(w);
    accL = new Float32Array(0);
    accR = new Float32Array(0);

    recMachine = samsloopRecStart(recMachine, tap.sampleRate);

    attachedTap = tap;
    tapHandler = (ev: MessageEvent) => {
      const msg = ev.data as { type?: string; l?: Float32Array; r?: Float32Array; channels?: number } | null;
      if (!msg || msg.type !== 'chunk' || !msg.l || !msg.r) return;
      onTapChunk(msg.l, msg.r);
    };
    tap.port.addEventListener('message', tapHandler);
    // start() on the port — addEventListener requires the port to be
    // started; onmessage = ... auto-starts it but addEventListener does NOT.
    try { tap.port.start(); } catch { /* */ }
    tap.setEnabled(true);

    recStartTimeMs = performance.now();
    recElapsedSec = 0;
    recCounterTicker = setInterval(() => {
      recElapsedSec = (performance.now() - recStartTimeMs) / 1000;
    }, 50);

  }

  function onTapChunk(l: Float32Array, r: Float32Array) {
    if (recMachine.state !== 'recording') return;

    // Append to the float accumulators (the real recording — full
    // AudioContext-rate Float32 source for the quantize/downsample step).
    const lNext = new Float32Array(accL.length + l.length);
    lNext.set(accL, 0);
    lNext.set(l, accL.length);
    accL = lNext;
    const rNext = new Float32Array(accR.length + r.length);
    rNext.set(accR, 0);
    rNext.set(r, accR.length);
    accR = rNext;

    // Update the visual peak buffer. We compute the |max| sample of the
    // new chunk and fold it into the slot(s) it maps to on the bar.
    const sr = attachedTap?.sampleRate ?? 48000;
    // The bar's x-axis is `maxSeconds` long. Each slot's time width is
    // `maxSecondsExact / barWidth` seconds.
    const slotSec = maxSecondsExact / recBarWidth;
    const samplesPerSlot = Math.max(1, Math.floor(sr * slotSec));
    // Walk the entire accumulator and refresh slots — cheap (linear in
    // chunk length, not buffer length) since we only need to update
    // slots covered by the new samples. Compute the slot range the new
    // samples belong to.
    const startSlot = Math.floor((accL.length - l.length) / samplesPerSlot);
    const endSlot   = Math.min(recBarWidth - 1, Math.floor((accL.length - 1) / samplesPerSlot));
    for (let s = startSlot; s <= endSlot && s >= 0; s++) {
      const lo = s * samplesPerSlot;
      const hi = Math.min(accL.length, lo + samplesPerSlot);
      let peak = 0;
      for (let i = lo; i < hi; i++) {
        const v = Math.abs(accL[i] ?? 0);
        if (v > peak) peak = v;
      }
      // Mirror into the visual buffer (mono mix of L for display — keeps
      // the bar shape stable regardless of CHAN setting).
      recRunningPeaks[s] = peak;
    }

    // Force the waveform $effect to re-run by reassigning the reactive
    // ref — coalesced to one per animation frame so we don't redraw
    // 300+ times per second.
    if (pendingPeakRaf === null) {
      pendingPeakRaf = requestAnimationFrame(() => {
        pendingPeakRaf = null;
        recRunningPeaks = recRunningPeaks;
      });
    }

    // Auto-stop on cap. The trigger is the exact-byte budget, not the
    // rounded display value. We compute it from the current settings'
    // bytes-per-second × elapsed seconds.
    const elapsedSec = accL.length / sr;
    if (elapsedSec >= maxSecondsExact) {
      stopRecording('cap');
    }
  }

  function stopRecording(reason: 'user' | 'cap') {
    if (recMachine.state !== 'recording') return;
    // Detach the tap first so no chunks land after we've committed.
    if (attachedTap) {
      try { attachedTap.setEnabled(false); } catch { /* */ }
      if (tapHandler) {
        try { attachedTap.port.removeEventListener('message', tapHandler); } catch { /* */ }
      }
    }
    attachedTap = null;
    tapHandler = null;
    if (pendingPeakRaf !== null) {
      cancelAnimationFrame(pendingPeakRaf);
      pendingPeakRaf = null;
    }
    if (recCounterTicker !== null) {
      clearInterval(recCounterTicker);
      recCounterTicker = null;
    }
    recMachine = reason === 'cap'
      ? { ...recMachine, state: 'stopped', stopReason: 'cap' }
      : samsloopRecStop(recMachine);

    // Encode + commit. ONE Yjs setData per recording — never per chunk.
    // The byte payload is a base64 string (opaque to Yjs); broadcast is
    // one update. (A 144 kB number[] would recurse syncedstore's YArray
    // wrapper and blow the stack at insert.)
    if (accL.length === 0) return;
    const bytes = encodeRecordingBytes(
      accL,
      accR,
      recMachine.sampleRate,
      recRate,
      recBits,
      recChannels,
    );
    // Hard-cap defense — the encoder shouldn't exceed the budget at this
    // point (the auto-stop fires when elapsed seconds reach the exact
    // budget) but slice as a safety net so we never overshoot.
    const trimmed = bytes.byteLength > SAMSLOOP_RECORD_BUDGET_BYTES
      ? bytes.subarray(0, SAMSLOOP_RECORD_BUDGET_BYTES)
      : bytes;
    const t = patch.nodes[id];
    if (!t) return;
    if (!t.data) t.data = {};
    const d = t.data as SamsloopData;
    // Base64 the bytes for Yjs storage — see SamsloopData.sample comment.
    // A 144 kB number[] would recurse syncedstore's YArray wrapper and
    // blow the stack; a base64 string is one opaque value, one Yjs update.
    const bytesB64 = bytesToBase64(trimmed);
    const bytesPerSample = Math.ceil(recBits / 8);
    const totalSamples = trimmed.byteLength / (bytesPerSample * recChannels);
    d.sample = {
      bytesB64,
      rate: recRate,
      bits: recBits,
      channels: recChannels,
      byteLength: trimmed.byteLength,
      durationSec: totalSamples / recRate,
    };
  }

  function toggleRecord() {
    if (isRecording) {
      stopRecording('user');
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

  // Tear down the tap subscription on unmount so we don't leave the
  // tap enabled if the user destroys the card mid-recording.
  $effect(() => {
    return () => {
      if (attachedTap) {
        try { attachedTap.setEnabled(false); } catch { /* */ }
        if (tapHandler) {
          try { attachedTap.port.removeEventListener('message', tapHandler); } catch { /* */ }
        }
      }
      if (pendingPeakRaf !== null) cancelAnimationFrame(pendingPeakRaf);
      if (recCounterTicker !== null) clearInterval(recCounterTicker);
    };
  });

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
    void isRecording; void recRunningPeaks; void maxSeconds; void hasRecorded;
    if (!canvasEl) return;
    const ctx2d = canvasEl.getContext('2d');
    if (!ctx2d) return;
    const w = canvasEl.width;
    const h = canvasEl.height;
    ctx2d.clearRect(0, 0, w, h);
    ctx2d.fillStyle = '#0a0c11';
    ctx2d.fillRect(0, 0, w, h);

    if (isRecording) {
      // Live-record view: bar's x-axis = maxSeconds.
      // Draw the running peaks. Each slot maps to one column.
      const peaks = recRunningPeaks;
      const cols = Math.min(w, peaks.length);
      ctx2d.fillStyle = 'rgba(255, 60, 60, 0.18)';
      // Highlight already-filled region.
      const filledFrac = Math.min(1, recElapsedSec / Math.max(maxSecondsExact, 0.001));
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
      // preview. Only L channel for the visual (stereo files draw the
      // left channel's peaks).
      const s = d.sample;
      const bytesPerSample = Math.ceil(s.bits / 8);
      const bytes = base64ToBytes(s.bytesB64);
      const frames = Math.floor(bytes.byteLength / (bytesPerSample * s.channels));
      samplesForDraw = new Float32Array(frames);
      const view = new DataView(bytes.buffer);
      if (s.bits === 16) {
        for (let i = 0; i < frames; i++) {
          samplesForDraw[i] = view.getInt16(i * bytesPerSample * s.channels, true) / 0x7fff;
        }
      } else {
        // 8-bit signed (as stored — we used Int8 in our quantizer; bytes
        // in node.data are the SIGNED int8 values cast to uint8 = the
        // raw two's-complement byte).
        for (let i = 0; i < frames; i++) {
          const u = view.getUint8(i * bytesPerSample * s.channels);
          const signed = (u << 24) >> 24;
          samplesForDraw[i] = signed / 0x7f;
        }
      }
    }
    if (!samplesForDraw || samplesForDraw.length === 0) {
      ctx2d.fillStyle = '#5a6275';
      ctx2d.font = '10px ui-monospace, monospace';
      ctx2d.textAlign = 'center';
      ctx2d.fillText('NO SAMPLE LOADED', w / 2, h / 2);
      return;
    }
    const samples = samplesForDraw;
    // For file-upload samples we keep the start/end highlight band; for
    // recorded-only samples the start/end params haven't been touched
    // yet, so skip the band. "File-upload" is now detected by EITHER
    // the new fileBytesB64 path OR the legacy samples field.
    const isFileUpload =
      (d?.fileBytesB64 && d.fileBytesB64.length > 0) ||
      (d?.samples && d.samples.length > 0);
    if (isFileUpload) {
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
          <button
            type="button"
            class="rec-setting-opt"
            class:active={recRate === 22050}
            disabled={isRecording}
            onclick={() => pickRecRate(22050)}
            data-testid="samsloop-rate-22k"
          >22k</button>
          <button
            type="button"
            class="rec-setting-opt"
            class:active={recRate === 44100}
            disabled={isRecording}
            onclick={() => pickRecRate(44100)}
            data-testid="samsloop-rate-44k"
          >44k</button>
        </div>
      </div>

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
      {#if isCapStopped}
        <div class="upload-status" data-testid="samsloop-rec-cap-msg">max length reached</div>
      {/if}
      {#if recMachine.error}
        <div class="upload-error" data-testid="samsloop-rec-error">{recMachine.error}</div>
      {/if}

      <div class="waveform-row">
        <Fader
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
        <Fader
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
        <Fader
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
  }
  .samsloop-card .title {
    font-family: var(--font-display, inherit);
    font-size: 0.85rem;
    letter-spacing: 0.04em;
  }
  .samsloop-card .subtitle {
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
