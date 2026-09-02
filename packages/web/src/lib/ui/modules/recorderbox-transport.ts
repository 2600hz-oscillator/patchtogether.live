// packages/web/src/lib/ui/modules/recorderbox-transport.ts
//
// THE RECORDERBOX TRANSPORT SEAM — the one home for "arm a take, end a take,
// remember a folder, recover a crashed one", shared by every surface that can
// operate this module.
//
// ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
//
// Before it, all of it lived inside `RecorderboxCard.svelte`: a ~120-line
// `startRecording()` orchestration, the `probeEncoders` support probe, the
// `listRecoverable` crash scan, the folder re-pick, the download fallback, and
// — most importantly — the `$effect` that REACTS to `node.data.recording`.
//
// recorderbox is in NEITHER half of `HEADLESS_MOUNT_LANE_TYPES`, not in
// `DOM_SOURCE_LANE_TYPES` and not in `CARD_PRODUCER_LANE_TYPES`, so promotion
// stops that card being mounted ANYWHERE on the default shell. Every line above
// would have gone with it: a promoted recorderbox could not have been armed at
// all, and no def-reading gate would have said so — `module-surfaces`' STOP 2
// exactly.
//
// ⚠ THE `$effect` IS PORTED, NOT JUST THE FUNCTIONS, and that distinction is
// the whole design of `reconcileRecorderboxTransport` below. The effect is not
// merely "the button's click handler in disguise": `node.data.recording` is a
// Y.Doc-SYNCED key, so it also flips when
//
//   * a RACK-MATE presses RECORD on their copy of the module, and
//   * a saved patch is LOADED with `recording: true` still on it,
//
// neither of which passes through any click handler. Porting only the start/stop
// functions and re-writing an `if (clicked)` at each call site would have
// dropped both paths silently — everything would still record when YOU press the
// button, which is what a hand test checks.
//
// So the REACTIVE READS live in this file, inside the shared reconciler, and
// each surface's `$effect` is one line that cannot diverge:
//
//     $effect(() => { reconcileRecorderboxTransport(host); });
//
// The host supplies GETTERS rather than values, because the three surfaces are
// reactive to different things: the legacy card reads its xyflow `data.node`
// prop (`patch` reads are not reactive in that subtree —
// [[patch-reads-are-not-reactive-in-the-legacy-card-subtree]]), while the two
// faceplate bodies read `patch.nodes[id]` directly. Calling the getter INSIDE
// the reconciler is what makes each subtree track its own source.
//
// ── WHY `lib/ui`, NEVER `lib/video` ─────────────────────────────────────────
//
// `packages/web/src/lib/video/**` (minus `*.test.ts`) is hashed WHOLESALE for
// the real-GPU WebGL attestation — nine recorderbox files already sit in that
// basis. A transport module there would put every future edit to a folder
// picker on the GPU-attest critical path for nothing. `node-recorder-registry`
// states the same rule in its own header and `recorderbox-present-policy.ts`
// was placed here for the same reason. DO NOT MOVE THIS FILE.
//
// ── WHAT IS DELIBERATELY *NOT* HERE ─────────────────────────────────────────
//
//   * THE RECORDING'S LIFETIME. That is `node-recorder-registry.svelte.ts`'s,
//     on NODE lifetime, and has been since #1574 — the capture canvas, the
//     encode pump and the render lease are all its, it exposes no teardown by
//     design, and nothing in this file could end a take except by the user's own
//     `stop()`. This module RESOLVES a take's configuration (folders, codecs,
//     audio taps, overwrite confirms — all user-gesture and policy work) and
//     hands it over.
//   * THE PREVIEW. A preview blit is per-surface furniture and correct to die
//     with its component; the registry's own ungated pump under
//     `acquireRenderLease` is what keeps a RECORDING at full rate.

import { patch } from '$lib/graph/store';
import { mutateNode } from '$lib/graph/mutate';
import type { ModuleNode } from '$lib/graph/types';
import type { PatchEngine } from '$lib/audio/engine';
import { VIDEO_RES, type VideoEngine } from '$lib/video/engine';
import {
  probeEncoders,
  type RecorderState,
} from '$lib/video/recorderbox-recorder';
import {
  pickEncodeProfile,
  coerceQuality,
  type RecorderboxQuality,
} from '$lib/video/recorderbox-quality';
import {
  listRecoverable,
  readOpfsBytes,
  deleteOpfsFile,
  deleteManifest,
  markManifestDone,
  ensureHandleWritePermission,
  sanitizeRecordingFilename,
  canSaveViaPicker,
  type RecorderboxManifest,
} from '$lib/video/recorderbox-store';
import {
  promptSaveDestination,
  streamToHandle,
  promptSaveFolder,
  fileExistsInDir,
  fileHandleInDir,
} from '$lib/video/recorderbox-save-flow';
import { planRecordStartFolder, mayShowOverwriteConfirm } from './recorderbox-present-policy';
import { chunkFileName } from '$lib/video/recorderbox-chunk-name';
import { nodeRecorder } from './node-recorder-registry.svelte';

export type { RecorderState, RecorderboxQuality, RecorderboxManifest };

/** What a runtime can do, as the surfaces need to know it. `checked` separates
 *  "cannot record" from "have not asked yet" — the RECORD control is disabled
 *  only once the probe has actually answered, so a slow probe never paints a
 *  dead-looking switch on a machine that can encode. */
export interface RecorderboxSupport {
  canRecord: boolean;
  opfs: boolean;
  checked: boolean;
}

export const UNCHECKED_SUPPORT: RecorderboxSupport = {
  canRecord: false,
  opfs: false,
  checked: false,
};

/**
 * THE VRT/e2e DETERMINISM SEAM — a page global read at probe time, the
 * `__loopbackTestFrame` / `__tvLibrarianTestCountries` shape.
 *
 * ⚠ IT EXISTS BECAUSE THE CAPABILITY ANSWER IS A PROPERTY OF THE MACHINE, NOT
 * OF THE CODE, AND IT ARRIVES LATE. `probeEncoders` does not trust
 * `VideoEncoder.isConfigSupported` — that returns a FALSE POSITIVE on headless
 * software runners — so it ANDs the config check with a real encode-and-flush
 * smoke test. That is the right probe and it takes an unknown number of frames,
 * which means a faceplate's resting picture has TWO legal states (probe pending
 * → no fault lamp, RECORD enabled; probe answered → possibly a fault lamp and a
 * disabled RECORD) and a pixel baseline would pin whichever one the runner
 * happened to be in. That is a coin-flip on the runner's mood, not a
 * regression gate.
 *
 * Pinning it makes the scene a function of the CODE. It costs no attest window
 * (this file is `lib/ui`, outside the WebGL basis) and it removes the network
 * of machine facts entirely rather than making them fast.
 *
 * Read as a tri-state: absent ⇒ probe for real; truthy ⇒ "a runtime that can
 * encode"; falsy-but-present ⇒ "a runtime that cannot", so the FAULT state is
 * reachable from a scene too rather than only being disabled-by-luck.
 */
function pinnedSupport(): RecorderboxSupport | null {
  const pin = (globalThis as { __recorderboxTestEncoder?: unknown }).__recorderboxTestEncoder;
  if (pin === undefined || pin === null) return null;
  return pin ? { canRecord: true, opfs: true, checked: true } : { canRecord: false, opfs: false, checked: true };
}

/**
 * Ask the runtime whether it can encode at this resolution.
 *
 * ⚠ THE ONLY CALLER OF `probeEncoders` IN THE TREE was `RecorderboxCard`'s
 * `onMount`. Promotion unmounts that card everywhere, so without this seam the
 * `canRecord` / `opfs` answer would simply never be computed on the default
 * shell and RECORD would sit permanently enabled over a runtime that cannot
 * encode — the shape the module's own e2e records as a real CI condition.
 *
 * Never throws: a probe failure is "cannot record", not a broken surface.
 */
export async function probeRecorderboxSupport(
  width: number,
  height: number,
): Promise<RecorderboxSupport> {
  const pinned = pinnedSupport();
  if (pinned) return pinned;
  try {
    const s = await probeEncoders(width, height);
    return { canRecord: s.canRecord, opfs: s.opfs, checked: true };
  } catch {
    return { canRecord: false, opfs: false, checked: true };
  }
}

/**
 * This node's mid-flight takes left behind by a crash.
 *
 * ⚠ ALSO A FORMER ONLY-CALLER: `listRecoverable` was reached from the card's
 * `onMount` and nowhere else. The recovery block is the ONE thing on this
 * module with UNSAVED USER DATA behind it, so losing its scan to a promotion
 * would have been the most expensive of the six.
 */
export async function scanRecoverableTakes(nodeId: string): Promise<RecorderboxManifest[]> {
  try {
    return await listRecoverable(nodeId);
  } catch {
    return [];
  }
}

/**
 * Write one `node.data` key through the ORIGIN-TAGGED mutation seam.
 *
 * ⚠ THE ORIGIN IS `RECORDERBOX_TRANSPORT_ORIGIN`, NOT `LOCAL_ORIGIN`, and that
 * is parity rather than a preference. The legacy card wrote these keys through
 * the bare SyncedStore proxy, which transacts with NO origin and is therefore
 * NOT tracked by the UndoManager. Defaulting to `LOCAL_ORIGIN` here would have
 * quietly made Cmd-Z able to ARM OR END A RECORDING — a view-level gesture
 * reaching the user's file, which is the exact class #1574 was a P0 for.
 * `filename` and `quality` ride the same origin: an undo that renamed the file
 * a running take is writing into is the same hazard one step removed.
 */
export const RECORDERBOX_TRANSPORT_ORIGIN = Symbol('recorderbox-transport');

export type RecorderboxDataKey = 'filename' | 'recording' | 'quality';

export function setRecorderboxData(
  nodeId: string,
  key: RecorderboxDataKey,
  value: string | boolean,
): void {
  mutateNode(
    nodeId,
    (live) => {
      // IN PLACE — never rebuild `data` ([[yjs-save-load-real-ydoc]]).
      if (!live.data) live.data = {};
      live.data[key] = value;
    },
    { origin: RECORDERBOX_TRANSPORT_ORIGIN },
  );
}

/** The live node, off the store. Null when it has been deleted or has not
 *  synced yet — every caller treats that as "do nothing". */
export function recorderboxNode(nodeId: string): ModuleNode | null {
  return (patch.nodes[nodeId] as ModuleNode | undefined) ?? null;
}

/** `node.data.filename`, defaulted the way both surfaces paint it. */
export function recorderboxFilename(node: ModuleNode | null): string {
  return (node?.data?.filename as string | undefined) ?? 'recording';
}

/** `node.data.recording`, defaulted false. */
export function recorderboxRecording(node: ModuleNode | null): boolean {
  return (node?.data?.recording as boolean | undefined) ?? false;
}

/** `node.data.quality`, coerced to a legal tier. */
export function recorderboxQuality(node: ModuleNode | null): RecorderboxQuality {
  return coerceQuality(node?.data?.quality);
}

/** MM:SS, for an `aria-label` / `title` — never a painted text node. */
export function formatElapsed(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const mm = String(Math.floor(total / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

/** The remembered folder's display name, or null. (`FileSystemDirectoryHandle`
 *  typing does not surface `.name`; every real handle has one.) */
export function folderDisplayName(handle: FileSystemDirectoryHandle | null): string | null {
  return handle ? ((handle as { name?: string }).name ?? null) : null;
}

// ── The download fallback (no directory picker, or a recovery handle gone) ───

/** The recorder's `saveBytes` contract: used ONLY when no destination handle
 *  exists (Firefox/Safari, or a lapsed recovery handle). */
export async function saveBytesViaDownload(
  bytes: Uint8Array,
  name: string,
  mime: string,
): Promise<void> {
  const safeName = sanitizeRecordingFilename(name, 'mp4');
  const blob = new Blob([bytes as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = safeName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// ── The destination folder ──────────────────────────────────────────────────

/** Chrome refuses `readwrite` on the Documents/Desktop/Downloads/home ROOTS
 *  ("contains system files") and reports that refusal as an ordinary dismiss,
 *  so an empty pick has to name the actionable difference. */
export const FOLDER_HINT_ROOT_BLOCKED =
  'Pick a SUBFOLDER — Chrome blocks Documents/Desktop/Downloads roots ("contains system files").';
export const FOLDER_HINT_NO_PICKER =
  'This browser has no folder picker — recordings download instead.';
export const FOLDER_HINT_DENIED = 'Write permission was denied for that folder.';
export const FOLDER_HINT_PRESENTING =
  'Recording to downloads — set a folder before presenting to save straight to disk.';

/**
 * Re-pick the destination folder at any time (the click is the user gesture
 * `showDirectoryPicker` requires).
 *
 * @returns the transient hint to paint under the folder row, or null on success.
 */
export async function changeRecorderboxFolder(nodeId: string): Promise<string | null> {
  const live = nodeRecorder.view(nodeId);
  const state = live?.state ?? 'idle';
  if (state === 'recording' || state === 'finalizing') return null;
  const picked = await promptSaveFolder();
  if (picked === 'cancel') return FOLDER_HINT_ROOT_BLOCKED;
  if (picked == null) return FOLDER_HINT_NO_PICKER;
  if (!(await ensureHandleWritePermission(picked))) return FOLDER_HINT_DENIED;
  // On the NODE, so a collapse or an LRU eviction cannot forget it (#1583).
  nodeRecorder.rememberFolder(nodeId, picked);
  return null;
}

// ── Crash recovery ──────────────────────────────────────────────────────────

async function retireRecovery(opfsPath: string): Promise<void> {
  await markManifestDone(opfsPath);
  await deleteOpfsFile(opfsPath);
  await deleteManifest(opfsPath);
}

/**
 * Save one recovered take back to disk, preferring the destination the take was
 * STARTED against so nothing has to be re-picked.
 *
 * `requestPermission` needs a user gesture, which is why this is called from the
 * Save button and never on mount.
 */
export async function recoverTake(m: RecorderboxManifest): Promise<void> {
  try {
    // 1a) The persisted destination FOLDER (Chromium, the folder model):
    //     re-acquire write permission, resolve the chunk's handle INSIDE it and
    //     stream the partial straight back under its own chunk name.
    if (m.dirHandle && (await ensureHandleWritePermission(m.dirHandle))) {
      const name = m.chunkName ?? sanitizeRecordingFilename(m.filename, 'mp4');
      const fh = await fileHandleInDir(m.dirHandle, name);
      const written = await streamToHandle(m.opfsPath, fh);
      if (written > 0) {
        await retireRecovery(m.opfsPath);
        return;
      }
    }

    // 1b) The legacy persisted single-file handle (Chromium, pre-folder model).
    if (m.destHandle && (await ensureHandleWritePermission(m.destHandle))) {
      const written = await streamToHandle(m.opfsPath, m.destHandle);
      if (written > 0) {
        await retireRecovery(m.opfsPath);
        return;
      }
      // Nothing written — fall through to the picker/download fallback.
    }

    // 2) Handle gone / permission denied / no picker: prompt for a NEW
    //    destination and stream to it, else download the bytes. Either way the
    //    suggested name is the chunk's.
    const suggestedName = m.chunkName ?? sanitizeRecordingFilename(m.filename, 'mp4');
    const dest =
      m.dirHandle == null && m.destHandle == null && canSaveViaPicker()
        ? await promptSaveDestination(suggestedName)
        : null;
    if (dest && dest !== 'cancel') {
      await streamToHandle(m.opfsPath, dest);
    } else if (dest === 'cancel') {
      // The user dismissed the picker — KEEP the candidate.
      return;
    } else {
      const bytes = await readOpfsBytes(m.opfsPath);
      if (bytes && bytes.byteLength > 0) {
        await saveBytesViaDownload(bytes, suggestedName, m.mime);
      }
    }
    await retireRecovery(m.opfsPath);
  } catch {
    // Keep the candidate if the save was cancelled or failed.
  }
}

/** Throw one recovered take away. */
export async function discardTake(m: RecorderboxManifest): Promise<void> {
  try {
    await deleteOpfsFile(m.opfsPath);
    await deleteManifest(m.opfsPath);
  } catch {
    /* the rescan is what reports the outcome */
  }
}

// ── Starting a take ─────────────────────────────────────────────────────────

/** Everything the start orchestration needs from whichever surface armed it. */
export interface StartTakeHost {
  readonly nodeId: string;
  /** The page's PatchEngine, or undefined before it exists. */
  engine(): PatchEngine | null | undefined;
  /**
   * IS THE MODULE STILL ARMED? Re-read after every await.
   *
   * ⚠ FIVE await points here can each take arbitrarily long — a folder picker,
   * a permission prompt, an overwrite confirm, a codec probe and the audio-tap
   * Promise — and the user (or a rack-mate) may flip RECORD off during any of
   * them. Without the re-read the take starts anyway, against a switch that
   * already reads OFF.
   */
  stillArmed(): boolean;
  /** Paint a transient, non-modal hint under the folder row. */
  setFolderHint(hint: string | null): void;
}

/** Resolve the live VideoEngine off a PatchEngine, or undefined. */
export function videoEngineOf(engine: PatchEngine | null | undefined): VideoEngine | undefined {
  if (!engine) return undefined;
  try {
    return engine.getDomain<VideoEngine>('video');
  } catch {
    return undefined;
  }
}

/** Nodes whose START is mid-flight, so the reconciler cannot re-enter it while
 *  an async user-gesture dialog is open. Keyed by node, not per surface — the
 *  lane tile and the dock full view can both be mounted for one node. */
const STARTING = new Set<string>();

/** Exported for the unit suite's own reset; production never calls it. */
export function __resetStartingGuard(): void {
  STARTING.clear();
}

/**
 * Resolve a take's whole configuration and hand it to the node-keyed registry.
 *
 * Returns true when a recording is running afterwards. On any refusal it reverts
 * `node.data.recording` itself, so the switch never reads ON over a take that
 * did not start.
 */
export async function startRecorderboxTake(host: StartTakeHost): Promise<boolean> {
  const { nodeId } = host;
  if (STARTING.has(nodeId)) return false;

  const patchEngine = host.engine();
  const ve = videoEngineOf(patchEngine);
  if (!ve) {
    setRecorderboxData(nodeId, 'recording', false);
    return false;
  }

  STARTING.add(nodeId);
  try {
    // ── PRESENTATION-SAFE folder resolution ──
    // While in element-fullscreen, opening ANY modal (the folder picker, a
    // permission prompt, the overwrite confirm) makes Chrome EXIT fullscreen —
    // kicking the performer out mid-take. So while presenting we open none:
    // use an already-chosen folder, else fall back to the download path with a
    // non-modal hint. (`planRecordStartFolder` / `mayShowOverwriteConfirm` are
    // pure and unit-tested in recorderbox-present-policy.ts.)
    const isFullscreen = typeof document !== 'undefined' && !!document.fullscreenElement;

    let dirHandle: FileSystemDirectoryHandle | null = nodeRecorder.folderFor(nodeId);
    if (dirHandle && !(await ensureHandleWritePermission(dirHandle))) {
      dirHandle = null; // permission lapsed — re-resolve below.
    }
    const plan = planRecordStartFolder(!!dirHandle, isFullscreen);
    if (plan.action === 'prompt') {
      const picked = await promptSaveFolder();
      if (picked === 'cancel') {
        setRecorderboxData(nodeId, 'recording', false);
        return false;
      }
      if (!host.stillArmed()) return false;
      if (picked) {
        dirHandle = picked;
        nodeRecorder.rememberFolder(nodeId, picked);
      }
      // picked === null → no FS-Access → dirHandle stays null → download path.
    } else if (plan.action === 'download') {
      host.setFolderHint(FOLDER_HINT_PRESENTING);
    }
    // plan.action === 'use' → keep the already-granted handle, no prompt.

    // ── OVERWRITE prompt — a modal, so SKIPPED while presenting. ──
    // Chunk names carry a unique DATETIME so a real collision is near-impossible;
    // outside fullscreen this stays a genuine safety net.
    const node = recorderboxNode(nodeId);
    const filename = recorderboxFilename(node);
    if (dirHandle && mayShowOverwriteConfirm(isFullscreen)) {
      const firstName = chunkFileName(filename, 1, new Date());
      if (await fileExistsInDir(dirHandle, firstName)) {
        const ok =
          typeof confirm === 'function' ? confirm(`"${firstName}" already exists. Overwrite?`) : true;
        if (!ok) {
          setRecorderboxData(nodeId, 'recording', false);
          return false;
        }
      }
    }
    if (!host.stillArmed()) return false;

    const ew = ve.canvas.width || VIDEO_RES.width;
    const eh = ve.canvas.height || VIDEO_RES.height;

    // The encode profile for the chosen tier AT THIS RESOLUTION: HIGH = the
    // original H.264 / 14 Mbps; BALANCED/SMALL prefer hardware HEVC when the
    // runtime can encode it. Probed against the real runtime.
    const profile = await pickEncodeProfile(recorderboxQuality(recorderboxNode(nodeId)), ew, eh);
    if (!host.stillArmed()) return false;

    // The live audio source the module published. PREFER the sample-accurate
    // capture tap (`read('audioCapture')` → { port, sampleRate } | null): the
    // worklet posts planar f32 stereo from the audio thread and the recorder
    // drains it losslessly. Fall back to the legacy capture MediaStream's audio
    // track. Absent/null on both = record video only.
    let audioCapture: { port: MessagePort; sampleRate: number } | null = null;
    let audioTrack: MediaStreamTrack | null = null;
    const liveNode = recorderboxNode(nodeId);
    if (patchEngine && liveNode) {
      try {
        audioCapture = (await patchEngine.read(liveNode, 'audioCapture')) as
          | { port: MessagePort; sampleRate: number }
          | null;
      } catch {
        audioCapture = null;
      }
      if (!host.stillArmed()) return false;
      const stream = patchEngine.read(liveNode, 'audioStream') as MediaStream | null | undefined;
      audioTrack = stream?.getAudioTracks?.()[0] ?? null;
    }

    const started = await nodeRecorder.start(nodeId, {
      engine: ve,
      width: ew,
      height: eh,
      options: {
        nodeId,
        audioCapture, // PREFERRED — sample-accurate worklet tap (lossless).
        audioTrack, // FALLBACK — legacy MediaStreamAudioTrackSource path.
        filename,
        // FOLDER model: chunks auto-write into the picked folder under their
        // FILENAME-CHUNK#-DATETIME names; null → per-chunk <a download>.
        dirHandle,
        videoCodec: profile.videoCodec,
        videoBitrate: profile.videoBitrate,
        keyFrameInterval: profile.keyFrameInterval,
        audioBitrate: profile.audioBitrate,
        hardwareAcceleration: profile.hardwareAcceleration,
        width: ew,
        height: eh,
        saveBytes: saveBytesViaDownload,
      },
    });
    if (!started) setRecorderboxData(nodeId, 'recording', false);
    return started;
  } finally {
    STARTING.delete(nodeId);
  }
}

/** End the current take. The registry finalizes and writes the file; the entry
 *  disappears, so `view()` falls back to `idle` on its own. */
export async function stopRecorderboxTake(nodeId: string): Promise<void> {
  await nodeRecorder.stop(nodeId);
}

// ── The reconciler — THE PORTED `$effect` BODY ──────────────────────────────

/** What a surface supplies so the reconciler reads through ITS reactive source.
 *  Everything is a getter for exactly that reason (see the file header). */
export interface RecorderboxTransportHost extends StartTakeHost {
  /** `node.data.recording` — the Y.Doc-synced arm bit. */
  recording(): boolean;
  /** Whether this runtime can encode at all. A probe that has not answered yet
   *  reports false, so nothing is armed against an unknown encoder. */
  canRecord(): boolean;
}

/**
 * THE DECISION, as a pure function of the three observed facts — extracted so
 * it can be enumerated in the unit lane rather than argued in a comment.
 *
 * ⚠ THE ASYMMETRY IS DELIBERATE AND IS THE PART WORTH PINNING. `canRecord`
 * gates START and must NOT gate STOP: a probe that has not answered yet (or has
 * answered "no" on a machine whose encoder just went away) must still be able to
 * END a take that is already running. Folding it into one condition would make
 * an un-stoppable recording out of a capability answer, and the registry
 * deliberately offers no other way out.
 */
export type TransportAction = 'start' | 'stop' | null;

export function transportAction(
  want: boolean,
  isLive: boolean,
  canRecord: boolean,
): TransportAction {
  if (want && !isLive && canRecord) return 'start';
  if (!want && isLive) return 'stop';
  return null;
}

/**
 * Bring the node-owned recorder into agreement with `node.data.recording`.
 *
 * CALL THIS FROM A ONE-LINE `$effect` AND NOTHING ELSE:
 *
 *     $effect(() => { reconcileRecorderboxTransport(host); });
 *
 * The reactive reads — `host.recording()`, `host.canRecord()` and the
 * registry's own `isRecording` (which touches its version counter) — happen
 * inside this function, so every surface tracks the same three things and no
 * call site can accidentally track fewer.
 */
export function reconcileRecorderboxTransport(host: RecorderboxTransportHost): void {
  // ⚠ ALL THREE READS ARE ARGUMENT POSITIONS, so every one of them runs on
  // every pass. A short-circuiting `if (want && … && canRecord())` would skip
  // the `canRecord` read whenever `want` is false, and an effect does not track
  // a source it did not read — so arming would go unnoticed until something
  // ELSE re-ran the effect. Keep them as arguments.
  const action = transportAction(
    host.recording(),
    nodeRecorder.isRecording(host.nodeId),
    host.canRecord(),
  );
  if (action === 'start') void startRecorderboxTake(host);
  else if (action === 'stop') void stopRecorderboxTake(host.nodeId);
}
