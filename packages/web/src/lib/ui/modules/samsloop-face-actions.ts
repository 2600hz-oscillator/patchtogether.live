// THE ONE SAMSLOOP TRANSPORT — shared by `SamsloopCard.svelte` (the legacy card)
// and the curated face's SHELL_CELLS entry (`shell-cells.ts`).
//
// ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
//
// Promoting a module REMOVES its card from both surfaces (`migrated(type)` is
// read by `DockFullView` and by `laneRenderKind`), so every affordance the card
// owned has to exist as a shell cell or it is deleted by the promotion. samsloop
// carries the fleet's richest card: a file loader, a manual trigger, three
// recording-format switches, a REC transport and a sample export.
//
// ⚠ THE PART THAT IS NOT A COPY-PASTE, AND THE REASON THE TRANSPORT MOVED HERE
// RATHER THAN BEING RE-TYPED IN THE REGISTRY. `startRecording` carries a RACE
// GUARD: it re-reads the rack ledger FRESH at press time rather than trusting
// the `$derived` snapshot, because a peer's sample can land between the last
// render and the click, and it REFUSES TO ARM rather than silently shortening
// the take. That guard is the module's own hard-won correctness (the truncation
// it replaced cut 8 % off every take without saying so). Re-typing it beside the
// face would produce two copies that drift, and the drifting copy would be the
// one that silently records over a full rack — the exact two-sided-contract
// class CLAUDE.md's backdraft section is about, applied to a PROCEDURE instead
// of a number.
//
// ⚠ AND THE DRIFT ALREADY EXISTS — this header used to end "so the card now
// calls this, and so does the face", which is FALSE in the tree and was
// measured false on 2026-09-03. `SamsloopCard.svelte` imports nothing from this
// file: its `startRecording()` is a SECOND copy of the guard below, and the two
// have already diverged in one place — the card DISCARDS `nodeSamsloop.start`'s
// boolean, so the third refusal path ("Recording could not start.") is
// unreachable on the card even though the card is the surface that has an error
// line. The face is the caller; the card is the copy. It is left alone here on
// purpose (it is deleted by the legacy-removal branch, and editing a surface
// with days of life left buys risk and no player anything) — recorded rather
// than silently tidied, because a comment claiming a shared seam that is not
// shared is what makes the next author trust the wrong file.
//
// ── WHAT IS DELIBERATELY *NOT* HERE ─────────────────────────────────────────
//
// The take itself. `node-samsloop-registry.svelte.ts` owns the tap, the PCM
// accumulator, the live peak buffer and the encode-and-commit, keyed to the
// NODE rather than to any component, so a dock collapse cannot destroy a
// recording (#1588). This module only DECIDES and DELEGATES; it holds no handle
// it could tear down, and the registry still exposes no per-card teardown.

import { getActiveEngine } from '$lib/audio/engine-ref';
import { AudioEngine } from '$lib/audio/engine';
import { patch, undoManager } from '$lib/graph/store';
import { mutateNode } from '$lib/graph/mutate';
import type { ModuleNode } from '$lib/graph/types';
import type { SelectorOption } from '$lib/ui/controls';
import { recordAudition, type AuditionSeam } from './audition-ledger';
import { nodeSamsloop, type SamsloopTap } from './node-samsloop-registry.svelte';
import { setSamsloopRecRefusal } from './samsloop/samsloop-rec-refusal.svelte';
import { setSamsloopTransformStatus } from './samsloop/samsloop-transform-status.svelte';
import {
  loadSamsloopWav,
  resolveSamsloopSource,
  samsloopDecodeBytesB64,
  SAMSLOOP_WINDOW_RANGE,
  type SamsloopData,
} from '$lib/audio/modules/samsloop';
import {
  bytesToBase64,
  clearSamsloopUploadKeys,
  samsloopAchievedRate,
  samsloopMaxCaptureFrames,
  samsloopMaxSecondsExact,
  samsloopRackFullMessage,
  samsloopRackLedger,
  samsloopTransformCapRefusal,
  samsloopDownloadFilename,
  makeWavBlob,
  base64ToBytes,
  SAMSLOOP_REC_DEFAULTS,
  SAMSLOOP_RATE_OPTIONS,
  SAMSLOOP_MIN_RECORD_SECONDS,
  type SamsloopRecBits,
  type SamsloopRecChannels,
  type SamsloopRecRate,
} from '$lib/audio/modules/samsloop-record';
import {
  nextSamsloopTransformId,
  runSamsloopTransformAsync,
  type SamsloopTransformRunner,
} from '$lib/audio/samsloop-transform/transform-client';
import type {
  SamsloopTransformKind,
  SamsloopTransformRefusal,
  SamsloopTransformSource,
  SamsloopTransformStats,
} from '$lib/audio/samsloop-transform/transform-core';

/** What a transport gesture did, so the CARD can render its error line and the
 *  FACE can record an audition from the same one call. */
export interface SamsloopTakeResult {
  ok: boolean;
  /** User-facing refusal text, or null on success.
   *
   *  The card renders this in `samsloop-rec-error`. THE FACE NOW RENDERS IT TOO
   *  — `toggleSamsloopRecord` routes it into
   *  `./samsloop/samsloop-rec-refusal.svelte.ts` and `SamsloopOutputBody`
   *  paints it as `samsloop-face-rec-error`. This doc used to say the faceplate
   *  had nowhere to put it and reported `delivered: false` instead; that was
   *  true and it was also the bug — `delivered` is a TEST instrument, so the
   *  three refusal paths reached the audition ledger and no human. A refusal
   *  nobody can read is the same failure as a silent one, which is the reason
   *  `samsloopRackFullMessage` was exported in the first place. */
  error: string | null;
}

/** The live node, or undefined. Used by every action below — a nodeId alone can
 *  reach the store, which is where `node.data` lives. */
function liveNode(nodeId: string): ModuleNode | undefined {
  return patch.nodes[nodeId] as ModuleNode | undefined;
}

/** Acquire the record tap off the live engine handle.
 *
 *  ⚠ `getActiveEngine()` IS the sanctioned route from plain `.ts` — it is
 *  already exported (`$lib/audio/engine-ref`) and already consumed this way by
 *  `clipplayer.ts` and `push2-control.svelte.ts`. The shell's `ShellCellEnv`
 *  carries only a `write` seam, so a cell that needs to READ a handle key uses
 *  this rather than growing the env; `manual-strike-actions.ts` resolves its
 *  strike callable exactly the same way. */
function resolveTap(node: ModuleNode | undefined): SamsloopTap | null {
  const eng = getActiveEngine();
  if (!eng || !node) return null;
  try {
    const r = eng.read(node, 'recTap');
    if (!r) return null;
    const tap = r as SamsloopTap;
    return tap.sampleRate > 0 ? tap : null;
  } catch {
    return null;
  }
}

/**
 * ARM A TAKE. Returns the refusal rather than throwing, because both callers
 * need to say something different about it.
 *
 * `barWidth` is the live canvas width the peak bar is drawn into — the card
 * passes its own canvas so a resized window still fills edge to edge; the face
 * passes nothing and takes the registry's default.
 */
export function startSamsloopTake(nodeId: string, barWidth?: number): SamsloopTakeResult {
  const node = liveNode(nodeId);
  const tap = resolveTap(node);
  if (!tap) {
    return { ok: false, error: 'Audio engine not ready yet — start audio first.' };
  }

  const d = (node?.data ?? {}) as SamsloopData;
  const recRate = (d.recRate ?? SAMSLOOP_REC_DEFAULTS.rate) as SamsloopRecRate;
  const recBits = (d.recBits ?? SAMSLOOP_REC_DEFAULTS.bits) as SamsloopRecBits;
  const recChannels = (d.recChannels ?? SAMSLOOP_REC_DEFAULTS.channels) as SamsloopRecChannels;

  // ⚠ THE RACK GATE, READ FRESH — never the `$derived`. A peer's sample can land
  // between the last render and this press, and a budget check that trusts a
  // stale snapshot is a budget check that can be raced past. REFUSE TO ARM
  // rather than shorten silently.
  const liveLedger = samsloopRackLedger(patch.nodes, nodeId);
  const liveMaxSeconds = samsloopMaxSecondsExact(
    samsloopAchievedRate(tap.sampleRate, recRate),
    recBits,
    recChannels,
    liveLedger.freeBytes,
  );
  if (liveMaxSeconds < SAMSLOOP_MIN_RECORD_SECONDS) {
    return { ok: false, error: samsloopRackFullMessage(liveLedger) };
  }

  const started = nodeSamsloop.start(nodeId, {
    tap,
    captureFrames: samsloopMaxCaptureFrames(
      tap.sampleRate, recRate, recBits, recChannels, liveLedger.freeBytes,
    ),
    barWidth: barWidth ?? 200,
    barSeconds: liveMaxSeconds,
    rate: recRate,
    bits: recBits,
    channels: recChannels,
  });
  return started
    ? { ok: true, error: null }
    : { ok: false, error: 'Recording could not start.' };
}

/** USER INTENT ONLY. The cap-stop lives in the registry, because it has to fire
 *  whether or not any surface is mounted. */
export function stopSamsloopTake(nodeId: string): void {
  nodeSamsloop.stop(nodeId, 'user');
}

/** Is this node mid-take? Registry state, NOT `node.data` — a take publishes one
 *  commit on STOP, not one per frame. */
export function samsloopIsRecording(nodeId: string): boolean {
  return nodeSamsloop.isRecording(nodeId);
}

/**
 * THE FACE'S REC TRANSPORT — one button that arms or ends the take.
 *
 * ⚠ WHY AN `engine-message` AUDITION AND NOT A `data` PROBE. Pressing REC writes
 * NOTHING to `node.data`: the registry owns the take and commits exactly once,
 * on STOP. So `readData` — the oracle every other cell branch uses — is
 * structurally blind to an arm, and a `data` probe would fail on a perfectly
 * live button. What the press DOES do is resolve a callable off the live engine
 * handle (`read(node,'recTap')`) and drive it, which is precisely what the
 * audition ledger exists to witness: `delivered` is true only when the tap
 * resolved and the registry accepted the take. A no-engine press is RECORDED as
 * `delivered: false`, never dropped — "never pressed" and "pressed and reached
 * nothing" have to stay distinguishable.
 *
 * ⚠ AND THE LEDGER IS NOT A SURFACE. `delivered: false` is how a GATE learns the
 * press reached nothing; it is not how the PLAYER learns it. Until this seam
 * existed the three refusal paths (engine-not-ready, rack-full,
 * could-not-start) were silent no-ops on the faceplate: the button moved, the
 * ledger recorded a miss, and nothing on screen changed. `setSamsloopRecRefusal`
 * is the human half — read by `SamsloopOutputBody`, which is where the take
 * would have been drawn.
 *
 * ⚠ EVERY EXIT WRITES THE SEAM, INCLUDING THE SUCCESSFUL ONES. A refusal that
 * only ever gets set is a refusal that stays on screen while a take is running.
 * Arming and stopping both clear it.
 */
export function toggleSamsloopRecord(nodeId: string): boolean {
  if (samsloopIsRecording(nodeId)) {
    stopSamsloopTake(nodeId);
    setSamsloopRecRefusal(nodeId, null);
    recordAudition({ nodeId, seam: 'engine-message', delivered: true });
    return true;
  }
  const r = startSamsloopTake(nodeId);
  setSamsloopRecRefusal(nodeId, r.error);
  recordAudition({ nodeId, seam: 'engine-message', delivered: r.ok });
  return r.ok;
}

/**
 * EXPORT THE SAMPLE — the recording as a WAV, or the upload's ORIGINAL bytes
 * verbatim (an mp3 stays an mp3). A recording wins when both exist: it is the
 * more recent user intent.
 *
 * ⚠ THE SEAM IS `file-export`, AND IT IS A NEW MEMBER RATHER THAN A REUSED ONE.
 * An export reaches no engine and no worklet, so calling it `engine-message`
 * would make the ledger lie about what was touched — and a probe watching
 * `engine-message` on this node would then be satisfied by a REC press, which is
 * the aliasing `manual-press` was split out to prevent. It records
 * `delivered: false` when there is nothing to export, which is the honest answer
 * for a button the shell renders unconditionally.
 */
export function downloadSamsloopSample(nodeId: string): boolean {
  const node = liveNode(nodeId);
  // ⚠ `delivered` MEANS "THE SEAM WAS REACHED", NOT "THERE WAS SOMETHING TO
  // SEND" — the ledger's own definition is that false is a press that reached
  // NOTHING (no engine, no node, a handle that does not answer). An empty
  // samsloop is not that case: the handler ran, resolved a live node and
  // correctly determined there is nothing to export, which is a successful
  // no-op rather than a dead control. Recording false there would have made
  // every bare-rack press look like a broken button — and faces-parity presses
  // on a BARE RACK, so it would have been a permanently red gate reporting the
  // wrong defect.
  //
  // ⚠ WHAT THIS PROBE THEREFORE CANNOT SEE, stated rather than left implicit:
  // that BYTES actually reached a file. Nothing on a bare rack can see that.
  // `samsloop-download.spec.ts` is the gate that does — it records a take,
  // presses DOWNLOAD and validates the RIFF/WAVE header of what lands.
  if (!node) {
    recordAudition({ nodeId, seam: 'file-export', delivered: false });
    return false;
  }
  const d = node.data as SamsloopData | undefined;
  const deliver = (blob: Blob, filename: string): boolean => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    recordAudition({ nodeId, seam: 'file-export', delivered: true });
    return true;
  };

  const sample = d?.sample;
  if (sample && sample.byteLength > 0) {
    const u8 = base64ToBytes(sample.bytesB64);
    return deliver(
      makeWavBlob(u8, sample.rate, sample.bits, sample.channels),
      samsloopDownloadFilename(),
    );
  }
  if (d?.fileBytesB64 && d.fileBytesB64.length > 0) {
    const u8 = base64ToBytes(d.fileBytesB64);
    const mime = d.fileMime && d.fileMime.length > 0 ? d.fileMime : 'application/octet-stream';
    return deliver(
      new Blob([u8 as BlobPart], { type: mime }),
      d.fileName && d.fileName.length > 0 ? d.fileName : samsloopDownloadFilename(),
    );
  }
  // Nothing loaded and nothing recorded — the seam was still reached (see the
  // note above); there was simply no subject. Reported as DELIVERED with a
  // `false` RETURN, so a caller that cares about the difference has it.
  recordAudition({ nodeId, seam: 'file-export', delivered: true });
  return false;
}

// ── The three RECORD-FORMAT switches (node.data, not params) ────────────────
//
// ⚠ THE ROSTERS ARE DERIVED, NEVER TYPED. `SAMSLOOP_RATE_OPTIONS` is the
// module's own list and the card renders the same one; a second hand-written
// copy here is the drift this repo keeps paying for. CHAN and BITS are labelled
// with the module's real vocabulary (MONO/STEREO, 8/16) — the same strings the
// card paints — so nothing is invented.

/** Write one record setting, ending any take in flight. The settings are frozen
 *  for a take's duration, so this is the only way they can change under it —
 *  the card has always stopped cleanly here and the face must too, or a take
 *  would keep encoding against a format the user has already changed. */
function pushRecSetting<K extends 'recChannels' | 'recBits' | 'recRate'>(
  nodeId: string,
  key: K,
  value: SamsloopData[K],
): void {
  const t = liveNode(nodeId);
  if (!t) return;
  if (!t.data) t.data = {};
  (t.data as SamsloopData)[key] = value;
  if (samsloopIsRecording(nodeId)) stopSamsloopTake(nodeId);
}

export function samsloopChannelsOptions(): SelectorOption<string>[] {
  return [
    { value: '1', label: 'mono' },
    { value: '2', label: 'stereo' },
  ];
}
export function samsloopChannelsValue(node: ModuleNode | undefined): string {
  const d = node?.data as SamsloopData | undefined;
  return String(d?.recChannels ?? SAMSLOOP_REC_DEFAULTS.channels);
}
export function selectSamsloopChannels(nodeId: string, value: string): void {
  pushRecSetting(nodeId, 'recChannels', Number(value) as SamsloopRecChannels);
}

export function samsloopBitsOptions(): SelectorOption<string>[] {
  return [
    { value: '8', label: '8' },
    { value: '16', label: '16' },
  ];
}
export function samsloopBitsValue(node: ModuleNode | undefined): string {
  const d = node?.data as SamsloopData | undefined;
  return String(d?.recBits ?? SAMSLOOP_REC_DEFAULTS.bits);
}
export function selectSamsloopBits(nodeId: string, value: string): void {
  pushRecSetting(nodeId, 'recBits', Number(value) as SamsloopRecBits);
}

export function samsloopRateOptions(): SelectorOption<string>[] {
  return SAMSLOOP_RATE_OPTIONS.map((hz) => ({
    value: String(hz),
    label: `${Math.round(hz / 1000)}k`,
  }));
}
export function samsloopRateValue(node: ModuleNode | undefined): string {
  const d = node?.data as SamsloopData | undefined;
  return String(d?.recRate ?? SAMSLOOP_REC_DEFAULTS.rate);
}
export function selectSamsloopRate(nodeId: string, value: string): void {
  pushRecSetting(nodeId, 'recRate', Number(value) as SamsloopRecRate);
}

// ── The FILE loader ─────────────────────────────────────────────────────────

/**
 * Decode an audio file and install it as THE sample (there is exactly one).
 *
 * Returns the `{ status, error }` pair `ShellFileCell` renders under the button
 * — the same two strings the card paints in `samsloop-upload-status` /
 * `samsloop-upload-error`, which the file cell's contract carries for free.
 */
export async function loadSamsloopAudioFile(
  nodeId: string,
  file: File,
): Promise<{ status: string | null; error: string | null }> {
  const eng = getActiveEngine();
  let ctx: BaseAudioContext | undefined;
  try {
    if (eng?.hasDomain('audio')) ctx = eng.getDomain<AudioEngine>('audio').ctx;
  } catch {
    ctx = undefined;
  }
  if (!ctx) {
    return { status: null, error: 'Audio engine not ready yet — start audio first.' };
  }

  const result = await loadSamsloopWav(file, ctx);
  if (!result.ok) return { status: null, error: result.error ?? 'Unknown error' };

  const samples = result.samples!;
  if (!liveNode(nodeId)) return { status: null, error: 'Module was removed during upload.' };

  // ⚠ ONE TRANSACTION, AND IT IS `mutateNode` RATHER THAN A RAW STORE WRITE.
  // A file load is a USER GESTURE that edits `node.data` AND both window params
  // together, so the two must land as ONE undo step and ONE collaborator update
  // — otherwise a single Ctrl-Z can leave a window that does not describe the
  // sample beside it. The legacy card writes these raw and is carried in
  // `raw-write-ledger.ts` as DEBT for exactly that reason; the face's path does
  // not inherit it. `cloudseed-preset-actions.ts` is the precedent for an
  // in-place multi-field write inside the origin-tagged transact.
  mutateNode(nodeId, (live) => {
    if (!live.data) live.data = {};
    const d = live.data as SamsloopData;

    // Store the ORIGINAL bytes, never the decoded PCM: at the sample cap a
    // number[] of decoded samples is ~12 MB and one YArray entry per sample
    // would explode the CRDT. The factory hydrates fileBytesB64 → buffer.
    if (result.fileBytes) {
      d.fileBytesB64 = bytesToBase64(result.fileBytes);
      d.fileSize = result.fileSize ?? result.fileBytes.byteLength;
      d.fileMime = result.fileMime ?? '';
    }
    // ONE SAMPLE AT A TIME, both directions: drop the legacy decoded array AND
    // any recording. Without this the keys coexist and the READER'S PRECEDENCE
    // — not the user's last action — decides what plays.
    if (d.samples) delete d.samples;
    if (d.sample) delete d.sample;
    d.sampleRate = result.sampleRate;
    d.sampleLength = samples.length;
    d.fileName = file.name;
    // A fresh load opens the window to the WHOLE sample — 0..1 as a fraction,
    // which needs no knowledge of the frame count.
    live.params.start = SAMSLOOP_WINDOW_RANGE.min; // guard:allow-raw-write
    live.params.end = SAMSLOOP_WINDOW_RANGE.max; // guard:allow-raw-write
  });

  return {
    status: `loaded ${samples.length} samples @ ${result.sampleRate} Hz`,
    error: null,
  };
}

// ── NORMALIZE / DENOISE — the two in-place transforms ───────────────────────
//
// OWNER (2026-09-11): "samsloop should have a normalize button intended for
// low-volume vocal samples which normalizes the buffer … we also want a
// Denoise button that attempts to remove unwanted background noise or tape
// hiss." Rulings (2026-09-15): a transform rewrites the sample IN PLACE as
// PCM at the stored rate (an uploaded mp3 then EXPORTS as a WAV); it is NOT
// UNDOABLE, like REC — export first is the way back; NORMALIZE targets 0 dBFS
// after DC removal, and silence / already-full-scale are REFUSALS with a
// reason; DENOISE on a pad or drone REFUSES ("no steady noise floor found")
// through the same refusal seam REC uses, leaving the sample untouched.
//
// ⚠ THE SHAPE, AND WHY EACH SEAM IS WHERE IT IS.
//   * The DSP runs in a module WORKER (`$lib/audio/samsloop-transform`): 0.2–
//     0.4 s of STFT at the sample caps plus a 3 MB quantize + base64 must not
//     sit on the thread that schedules audio. The record path's bytes are
//     decoded THERE; an upload is decoded HERE (a worker has no AudioContext)
//     and its Float32 transferred.
//   * The write is REC's own shape — `clearSamsloopUploadKeys` then a fresh
//     `sample` record with `sampleLength` / `sampleRate` — in ONE `mutateNode`
//     transaction under an UNTRACKED origin (`raw-write-ledger.ts` carries
//     REC's commit as the precedent for a sample write that is not an undo
//     entry). `undoManager.stopCapturing()` first, so the next tracked edit
//     opens a fresh undo step instead of merging across the rewrite.
//   * The SIGNATURE is re-checked INSIDE the transact against the one read at
//     press time (H10): a REC take, an upload or a peer's write that lands
//     while the worker is busy makes the result stale, and a stale result is
//     discarded with a reason rather than written over the newer sample.
//   * The window (`params.start/end`) is NOT touched — the frame count is
//     unchanged and a fraction describes the same slice.
//   * The three size ceilings are re-checked on the write
//     (`samsloopTransformCapRefusal`): an upload was never sized under REC's
//     per-take 3 MB / 60 s caps, and the rack ledger is re-read fresh.
//   * EVERY EXIT WRITES THE STATUS SEAM (`samsloop-transform-status.svelte.ts`)
//     and the audition ledger. The seam is sig-stamped: a line about a sample
//     that has since changed never paints.
//
// ⚠ WHY TWO AUDITION SEAMS AND NOT `engine-message` OR `file-export`. A
// transform reaches no engine and no file; and one shared seam for both
// buttons would let a probe watching DENOISE be satisfied by a NORMALIZE
// press on the same node — the aliasing `file-export` was split out to
// prevent. `delivered: true` with a `false` return on a bare rack is the
// DOWNLOAD precedent above: the handler ran, resolved a live node, and there
// was no subject — a successful no-op, not a dead button.

/** Refusal sentences — exported so the tests assert IDENTITY with the seam's
 *  string rather than a copy typed beside it. */
export const SAMSLOOP_TRANSFORM_NO_SAMPLE = 'Load or record a sample first.';
export const SAMSLOOP_TRANSFORM_RECORDING = 'Stop recording first.';
export const SAMSLOOP_TRANSFORM_BUSY = 'A transform is already running on this sample.';
export const SAMSLOOP_TRANSFORM_ALREADY_DENOISED =
  'Already denoised — a second pass would only dull the sample. Export first if you want to try again.';
export const SAMSLOOP_TRANSFORM_SAMPLE_CHANGED =
  'The sample changed while the transform ran — result discarded. Press again.';
export const SAMSLOOP_TRANSFORM_DECODE_FAILED = 'Could not decode the sample.';
export const SAMSLOOP_TRANSFORM_ENGINE_NOT_READY =
  'Audio engine not ready yet — start audio first.';

/** The reason the dsp core gave, as the sentence the player reads. */
export function samsloopTransformRefusalText(
  kind: SamsloopTransformKind,
  reason: SamsloopTransformRefusal,
): string {
  const verb = kind === 'normalize' ? 'normalize' : 'denoise';
  switch (reason) {
    case 'silent':
      return `Nothing to ${verb}: the sample is silent.`;
    case 'already-full-scale':
      return 'Already at full scale (0 dBFS peak, no DC offset) — nothing to normalize.';
    case 'no-steady-noise-floor':
      return 'No steady noise floor found — this sample has no gaps where hiss stands alone (a pad, a drone, or a clean take). Sample untouched.';
    case 'too-short':
      return 'Too short to denoise — the sample needs about a third of a second of audio.';
    case 'not-finite':
      return `Could not ${verb}: the sample contains non-finite values.`;
    case 'empty':
      return SAMSLOOP_TRANSFORM_NO_SAMPLE;
  }
}

/** The success line under the waveform: what moved, and the bits the record
 *  was WRITTEN at — the REC bits/chan selectors still show the REC setting,
 *  which is not what a transformed record holds, so the line says so. */
export function samsloopTransformStatusText(
  stats: SamsloopTransformStats,
  written: { bits: number; rate: number },
): string {
  const fmt = (v: number, d: number) => `${v < 0 ? '−' : v > 0 ? '+' : ''}${Math.abs(v).toFixed(d)}`;
  const tail = ` · written ${written.bits}-bit mono @ ${(written.rate / 1000).toFixed(1)} kHz`;
  if (stats.kind === 'normalize') {
    const dc = Math.abs(stats.dcOffset) < 0.0005 ? 'dc 0' : `dc ${fmt(stats.dcOffset, 3)}`;
    return `normalized ${fmt(stats.gainDb, 1)} dB, ${dc}${tail}`;
  }
  return `denoised −${stats.reductionDb.toFixed(1)} dB in the gaps, floor ${fmt(Math.round(stats.noiseFloorDb), 0)} dBFS${tail}`;
}

/** The Yjs origin the transform commit is tagged with. NOT `LOCAL_ORIGIN`, so
 *  the UndoManager (trackedOrigins = [LOCAL_ORIGIN]) does not capture it —
 *  the owner's "not undoable, like REC" ruling, expressed as the origin axis
 *  `graph/mutate.ts` documents rather than as a flag. */
export const SAMSLOOP_TRANSFORM_ORIGIN = Symbol('samsloop-transform');

/** Injectable collaborators, so the unit test drives the real commit against
 *  a real Y.Doc with no Worker and no AudioContext. */
export interface SamsloopTransformDeps {
  run?: SamsloopTransformRunner;
  /** Decode an upload's stored bytes (needs an AudioContext). */
  decodeFile?: (
    b64: string,
    ctx: BaseAudioContext,
  ) => Promise<{ ok: boolean; samples?: Float32Array; sampleRate?: number } | null>;
  /** The engine's AudioContext, or undefined when it is down. */
  audioCtx?: () => BaseAudioContext | undefined;
  now?: () => number;
}

const transformsInFlight = new Set<string>();

function defaultAudioCtx(): BaseAudioContext | undefined {
  const eng = getActiveEngine();
  try {
    if (eng?.hasDomain('audio')) return eng.getDomain<AudioEngine>('audio').ctx;
  } catch {
    return undefined;
  }
  return undefined;
}

function transformSeam(kind: SamsloopTransformKind): AuditionSeam {
  return kind === 'normalize' ? 'sample-normalize' : 'sample-denoise';
}

/**
 * THE ONE TRANSFORM ACTION — both buttons call this. Resolves to `true` when
 * a record was written, `false` on every refusal (each of which has already
 * been painted through the status seam and recorded in the ledger).
 */
export async function transformSamsloopSample(
  nodeId: string,
  kind: SamsloopTransformKind,
  deps: SamsloopTransformDeps = {},
): Promise<boolean> {
  const seam = transformSeam(kind);
  const node = liveNode(nodeId);
  if (!node) {
    // No node: the press reached nothing. The ledger's own definition of false.
    recordAudition({ nodeId, seam, delivered: false });
    return false;
  }
  const d = (node.data ?? {}) as SamsloopData;
  const src = resolveSamsloopSource(d);
  const sigAtPress = src?.signature ?? 'empty';

  const refuse = (text: string): false => {
    setSamsloopTransformStatus(nodeId, { phase: 'refused', text, sig: sigAtPress });
    recordAudition({ nodeId, seam, delivered: true });
    return false;
  };

  // ⚠ EVERY PRE-DECODE REFUSAL IS SYNCHRONOUS — before the first `await` — so
  // a bare-rack press (faces-parity's whole world) has its audition recorded
  // by the time `onFire` returns.
  if (!src) return refuse(SAMSLOOP_TRANSFORM_NO_SAMPLE);
  if (samsloopIsRecording(nodeId)) return refuse(SAMSLOOP_TRANSFORM_RECORDING);
  if (transformsInFlight.has(nodeId)) return refuse(SAMSLOOP_TRANSFORM_BUSY);
  if (kind === 'denoise' && src.kind === 'record' && src.sample.denoised) {
    return refuse(SAMSLOOP_TRANSFORM_ALREADY_DENOISED);
  }
  const carriedDenoised = src.kind === 'record' && !!src.sample.denoised;

  transformsInFlight.add(nodeId);
  setSamsloopTransformStatus(nodeId, { phase: 'busy', text: `${kind}…`, sig: sigAtPress });
  try {
    let source: SamsloopTransformSource;
    if (src.kind === 'record') {
      const s = src.sample;
      source = { kind: 'pcm', bytesB64: s.bytesB64, bits: s.bits, channels: s.channels, rate: s.rate };
    } else if (src.kind === 'legacy') {
      const f32 = Float32Array.from(src.samples);
      source = { kind: 'f32', samples: f32.buffer, rate: src.sampleRate ?? d.sampleRate ?? 48_000, bits: 16 };
    } else {
      // An upload: decode through the AudioContext on THIS thread (a worker
      // has none), then hand the Float32 over. The stored bytes are the
      // ORIGINAL file, so this is the same decode the factory's hydrate does.
      const ctx = (deps.audioCtx ?? defaultAudioCtx)();
      if (!ctx) return refuse(SAMSLOOP_TRANSFORM_ENGINE_NOT_READY);
      const r = await (deps.decodeFile ?? samsloopDecodeBytesB64)(src.b64, ctx);
      if (!r?.ok || !r.samples || !r.sampleRate) return refuse(SAMSLOOP_TRANSFORM_DECODE_FAILED);
      // A private copy: `r.samples` may alias a buffer the decoder still holds.
      const f32 = new Float32Array(r.samples);
      source = { kind: 'f32', samples: f32.buffer, rate: r.sampleRate, bits: 16 };
    }

    const res = await (deps.run ?? runSamsloopTransformAsync)({
      id: nextSamsloopTransformId(),
      kind,
      source,
      denoised: carriedDenoised,
      now: deps.now?.(),
    });
    if (!res.ok) return refuse(samsloopTransformRefusalText(kind, res.reason));

    // ⚠ THE CAPS, RE-READ FRESH. The ledger excludes this node — its own
    // payload is what the write replaces.
    const cap = samsloopTransformCapRefusal({
      byteLength: res.sample.byteLength,
      frames: res.frames,
      rate: res.sample.rate,
      base64Length: res.sample.bytesB64.length,
      ledger: samsloopRackLedger(patch.nodes, nodeId),
    });
    if (cap) return refuse(cap);

    // ⚠ ONE TRANSACTION, UNTRACKED ORIGIN, SIGNATURE RE-CHECKED INSIDE IT.
    let written: string | null = null;
    let stale = false;
    undoManager.stopCapturing();
    mutateNode(
      nodeId,
      (live) => {
        if (!live.data) live.data = {};
        const ld = live.data as SamsloopData;
        const cur = resolveSamsloopSource(ld)?.signature ?? 'empty';
        if (cur !== sigAtPress) {
          stale = true;
          return;
        }
        clearSamsloopUploadKeys(ld as Record<string, unknown>);
        ld.sample = res.sample;
        ld.sampleLength = res.frames;
        ld.sampleRate = res.sample.rate;
        written = resolveSamsloopSource(ld)?.signature ?? null;
      },
      { origin: SAMSLOOP_TRANSFORM_ORIGIN },
    );
    if (stale || written === null) return refuse(SAMSLOOP_TRANSFORM_SAMPLE_CHANGED);

    setSamsloopTransformStatus(nodeId, {
      phase: 'done',
      text: samsloopTransformStatusText(res.stats, { bits: res.sample.bits, rate: res.sample.rate }),
      sig: written,
    });
    recordAudition({ nodeId, seam, delivered: true });
    return true;
  } finally {
    transformsInFlight.delete(nodeId);
  }
}

/** The NORMALIZE cell's `onFire`. Fire-and-forget from the shell; the promise
 *  is for callers that want the outcome. */
export function normalizeSamsloopSample(nodeId: string, deps?: SamsloopTransformDeps): Promise<boolean> {
  return transformSamsloopSample(nodeId, 'normalize', deps);
}

/** The DENOISE cell's `onFire`. */
export function denoiseSamsloopSample(nodeId: string, deps?: SamsloopTransformDeps): Promise<boolean> {
  return transformSamsloopSample(nodeId, 'denoise', deps);
}
