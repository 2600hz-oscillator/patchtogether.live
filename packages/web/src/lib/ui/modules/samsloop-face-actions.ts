// packages/web/src/lib/ui/modules/samsloop-face-actions.ts
//
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
// of a number. So the card now calls this, and so does the face.
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
import { patch } from '$lib/graph/store';
import type { ModuleNode } from '$lib/graph/types';
import type { SelectorOption } from '$lib/ui/controls';
import { recordAudition } from './audition-ledger';
import { nodeSamsloop, type SamsloopTap } from './node-samsloop-registry.svelte';
import {
  loadSamsloopWav,
  SAMSLOOP_WINDOW_RANGE,
  type SamsloopData,
} from '$lib/audio/modules/samsloop';
import {
  bytesToBase64,
  samsloopAchievedRate,
  samsloopMaxCaptureFrames,
  samsloopMaxSecondsExact,
  samsloopRackFullMessage,
  samsloopRackLedger,
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

/** What a transport gesture did, so the CARD can render its error line and the
 *  FACE can record an audition from the same one call. */
export interface SamsloopTakeResult {
  ok: boolean;
  /** User-facing refusal text, or null on success. The card renders this in
   *  `samsloop-rec-error`; the face has nowhere to paint it (a faceplate paints
   *  no derived-state text) and reports `delivered: false` instead. */
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
 */
export function toggleSamsloopRecord(nodeId: string): boolean {
  if (samsloopIsRecording(nodeId)) {
    stopSamsloopTake(nodeId);
    recordAudition({ nodeId, seam: 'engine-message', delivered: true });
    return true;
  }
  const r = startSamsloopTake(nodeId);
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
  const d = liveNode(nodeId)?.data as SamsloopData | undefined;
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
  recordAudition({ nodeId, seam: 'file-export', delivered: false });
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
  const target = liveNode(nodeId);
  if (!target) return { status: null, error: 'Module was removed during upload.' };
  if (!target.data) target.data = {};
  const d = target.data as SamsloopData;

  // Store the ORIGINAL bytes, never the decoded PCM: at the sample cap a
  // number[] of decoded samples is ~12 MB and one YArray entry per sample would
  // explode the CRDT. The factory hydrates fileBytesB64 → buffer on load.
  if (result.fileBytes) {
    d.fileBytesB64 = bytesToBase64(result.fileBytes);
    d.fileSize = result.fileSize ?? result.fileBytes.byteLength;
    d.fileMime = result.fileMime ?? '';
  }
  // ONE SAMPLE AT A TIME, both directions: drop the legacy decoded array AND any
  // recording. Without this the keys coexist and the READER'S PRECEDENCE — not
  // the user's last action — decides what plays.
  if (d.samples) delete d.samples;
  if (d.sample) delete d.sample;
  d.sampleRate = result.sampleRate;
  d.sampleLength = samples.length;
  d.fileName = file.name;
  // A fresh load opens the window to the WHOLE sample — 0..1 as a fraction.
  target.params.start = SAMSLOOP_WINDOW_RANGE.min;
  target.params.end = SAMSLOOP_WINDOW_RANGE.max;

  return {
    status: `loaded ${samples.length} samples @ ${result.sampleRate} Hz`,
    error: null,
  };
}
