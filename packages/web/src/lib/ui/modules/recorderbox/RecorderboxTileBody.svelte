<script lang="ts">
  // packages/web/src/lib/ui/modules/recorderbox/RecorderboxTileBody.svelte
  //
  // THE RECORDERBOX LANE TILE's own transport: arm a take, end a take, and see
  // that one is running — without expanding the module.
  //
  // ⚠ WITHOUT THIS THE TILE IS A DEAD END, and worse than cameraInput's was.
  // `recorderboxDef` declares `params: []`, so the face ranks NOTHING and the
  // tile's whole control surface would be the jack rail: a recorder you cannot
  // start, under a live thumbnail of the picture it is not recording. And
  // `Canvas.svelte`'s workflow seed auto-spawns a recorderbox into the video
  // zone of every fresh rack, wired to the master buses — so that tile is the
  // one every new rack meets first.
  //
  // ⚠ IT IS NOT A `ShellToggleCell`, AND THAT IS THE REASON THIS FILE EXISTS
  // RATHER THAN A `face.order: ['recording']`. Two independent blockers:
  //   1. NEITHER CELL KIND CAN EXPRESS `disabled`. `ShellToggleCell` declares
  //      only label/value/onchange and `Toggle.svelte`'s Props has no `disabled`
  //      at all — so a cell would paint a live-looking RECORD switch on a
  //      machine with no H.264 encoder, which the module's own e2e records as a
  //      real CI condition rather than a hypothetical.
  //   2. `faces-parity` CLICKS EVERY TOGGLE CELL. Enrolling RECORD would make
  //      CI press it on a real recorderbox — folder prompt, encoder probe,
  //      `nodeRecorder.start`, `acquireRenderLease`, and a full-canvas capture
  //      pump every frame on SwiftShader — and nothing would ever call `stop()`,
  //      because the registry deliberately exposes no teardown. This body owns
  //      its own markup and its own disabled state, and faces-parity does not
  //      press it.
  //
  // ⚠ WHAT IS DELIBERATELY *NOT* HERE:
  //   * THE PICTURE. The shell's glyph slot already paints a live thumbnail for
  //     any video face (`VideoTileThumb`, gated on `hasVideoSurface`). A second
  //     preview here would derive the same frame twice.
  //   * THE CRASH-RECOVERY BLOCK. It is a blocking question with unsaved user
  //     data behind it and it needs room to answer, so it lives in the dock
  //     full-view body — which is exactly as reachable as it is TODAY: under
  //     the default shell recorderbox has no lane card at all, so the card that
  //     scans OPFS only mounts when the dock full view is opened. Keeping the
  //     scan off the lane also keeps an IndexedDB read off every rack boot.
  //   * THE FILE NAME, THE FOLDER AND THE SIZE TIER. All three are dock-side.
  //     A 192 px tile cannot hold a text field, an ellipsised path and a
  //     three-option select without becoming the card again, and none of the
  //     three is needed to START: the filename defaults, the folder is prompted
  //     on the first press, and the size tier defaults to BALANCED.
  //
  // ⚠ AND IT MOUNTS THE SAME TRANSPORT SEAM AS THE DOCK BODY, which is what
  // makes "press RECORD on the lane tile and a take actually starts" true with
  // no card mounted anywhere. See ../recorderbox-transport.
  import { patch } from '$lib/graph/store';
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
  import { useEngine } from '$lib/audio/engine-context';
  import { VIDEO_RES } from '$lib/video/engine';
  import StatusLed from '$lib/ui/controls/StatusLed.svelte';
  import { nodeRecorder } from '../node-recorder-registry.svelte';
  import {
    UNCHECKED_SUPPORT,
    cachedRecorderboxSupport,
    formatElapsed,
    probeRecorderboxSupport,
    reconcileRecorderboxTransport,
    recorderboxNode,
    recorderboxRecording,
    setRecorderboxData,
    type RecorderboxSupport,
  } from '../recorderbox-transport';

  interface Props {
    nodeId: string;
  }
  let { nodeId }: Props = $props();

  const engineCtx = useEngine();

  // ⚠ TWO THINGS ARE WRONG WITH THE OBVIOUS `$derived(patch.nodes[id]...)`, AND
  // BOTH WERE MEASURED HERE RATHER THAN INHERITED:
  //
  //   1. `patch.nodes[id]` IS NOT REACTIVE ON ITS OWN. `node-versions.svelte.ts`
  //      maintains a per-node signal from ONE `nodes.observeDeep`, and
  //      `nodeVersion(id)` is how a surface subscribes to it — which is exactly
  //      what `ModuleShell` does before every live-node read.
  //   2. ⚠ TOUCHING THE SIGNAL IS NOT ENOUGH IF THE DERIVED RETURNS THE NODE.
  //      The SyncedStore node proxy has a STABLE IDENTITY, so a derived that
  //      recomputes to "the same proxy" is value-equal and Svelte does not
  //      notify its dependents at all
  //      ([[yjs-proxy-stable-identity-defeats-derived]]). So each derivation
  //      below returns the LEAF — a boolean, a string, an enum — whose value
  //      really does change, which is the same shape `ModuleShell.displayName`
  //      uses.
  //
  // MEASURED, in that order: with neither, a RECORD press wrote
  // `data.recording = true` to the doc and nothing reacted. With (1) alone the
  // effect STILL never re-ran — the reconcile logged exactly twice, both with
  // `recording === false`, while `__patch.nodes.d1.data.recording` was true.
  // A unit test over `node.data` passes on both states, which is why this is a
  // comment and an e2e leg rather than a hope.
  let recording = $derived.by(() => {
    void nodeVersion(nodeId);
    return recorderboxRecording(patch.nodes[nodeId] ?? null);
  });
  let live = $derived(nodeRecorder.view(nodeId));
  let recState = $derived(live?.state ?? 'idle');
  let elapsed = $derived(live?.elapsed ?? 0);
  let lastSavedChunk = $derived<string | null>(live?.lastSavedChunk ?? null);

  // ⚠ THE TILE STARTS NO PROBE, AND THAT IS A FIX WITH A MEASUREMENT BEHIND IT.
  // `probeEncoders` is a REAL four-frame encode-and-flush, and `Canvas`
  // auto-spawns a recorderbox into every workflow rack — so probing here ran
  // codec work on EVERY rack boot, while every other video tile's thumb was
  // establishing its first frames. CI ran the experiment: the first strict run
  // after this promotion reddened ~60 scenes (every video face's compact tile
  // plus timing-sensitive dock scenes), and the only video face scenes that
  // PASSED were recorderbox's own two — the two where `__recorderboxTestEncoder`
  // skips the probe. videoOut's promotion put an equally live thumb in the same
  // zone and moved exactly two baselines, so the extra tile is not the cause.
  //
  // So this reads the answer only if something ELSE has already asked (a press,
  // or the dock body opening), and otherwise renders RECORD live — the honest
  // painting of "nobody has asked yet". The authoritative refusal is in
  // `startRecorderboxTake`, on intent, which also covers the PEER FLIP path a
  // mount-time flag never could.
  let support = $state<RecorderboxSupport>(cachedRecorderboxSupport() ?? UNCHECKED_SUPPORT);
  // A hint raised here has no room to be painted; the fallback it reports is
  // spoken through the REC lamp's own detail instead (see `recDetail`).
  let folderHint = $state<string | null>(null);

  // THE TRANSPORT — the same one line the dock body runs, so a lane press and a
  // dock press cannot behave differently, and a rack-mate's flip or a patch
  // loaded with `recording: true` reaches both.
  $effect(() => {
    reconcileRecorderboxTransport({
      nodeId,
      recording: () => recording,
      // "No KNOWN reason to refuse" — see the seam's RecorderboxTransportHost.
      canRecord: () => !support.checked || support.canRecord,
      engine: () => engineCtx.get(),
      stillArmed: () => recorderboxRecording(recorderboxNode(nodeId)),
      setFolderHint: (h) => { folderHint = h; },
    });
  });

  async function toggleRecord(): Promise<void> {
    // ⚠ STOP IS NEVER GATED ON A CAPABILITY ANSWER. A take already running must
    // be endable whatever the probe says (or has not yet said) — the registry
    // deliberately offers no other exit.
    if (recording) {
      setRecorderboxData(nodeId, 'recording', false);
      return;
    }
    if (support.checked && !support.canRecord) return;
    setRecorderboxData(nodeId, 'recording', true);
    // Resolve the capability on INTENT rather than on mount, and adopt the
    // answer so the switch paints its refusal. `startRecorderboxTake` performs
    // the same (memoised) check and reverts `data.recording` itself, so this is
    // only about what the tile SHOWS.
    support = await probeRecorderboxSupport(VIDEO_RES.width, VIDEO_RES.height);
  }

  let recDetail = $derived(
    recState === 'recording'
      ? `recording for ${formatElapsed(elapsed)}`
        + (lastSavedChunk ? `, last chunk saved as ${lastSavedChunk}` : '')
        + (folderHint ? ` — ${folderHint}` : '')
      : recState === 'finalizing'
        ? 'finalizing the take — remuxing and writing it out'
        : support.checked && !support.canRecord
          ? 'not recording — this runtime has no H.264 encoder, so RECORD is disabled'
          : 'not recording',
  );
</script>

<div class="tile-recorderbox" data-testid="recorderbox-tile-body">
  <StatusLed
    caption="REC"
    lit={recState === 'recording' || recState === 'finalizing'}
    detail={recDetail}
    testid="recorderbox-tile-rec-led"
  />
  <button
    type="button"
    class="rec-btn nodrag"
    class:on={recording}
    disabled={support.checked && !support.canRecord}
    onclick={toggleRecord}
    data-testid="recorderbox-tile-record"
    data-recording={recording}
    aria-pressed={recording}
    title={recording ? 'STOP — finalize the take and write it out' : 'RECORD — start a take'}
  >{recording ? '■ STOP' : '● REC'}</button>
</div>

<style>
  .tile-recorderbox {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    width: 100%;
    padding: 2px 4px 4px;
    box-sizing: border-box;
  }
  .rec-btn {
    flex: 0 0 auto;
    padding: 3px 8px;
    background: var(--input-bg, #111);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 3px;
    font-size: 0.58rem;
    font-weight: 600;
    letter-spacing: 0.05em;
    cursor: pointer;
  }
  .rec-btn:hover:not(:disabled) { border-color: var(--accent-dim); }
  .rec-btn.on { background: #c1121f; border-color: #ff3b30; color: #fff; }
  .rec-btn:disabled { opacity: 0.45; cursor: not-allowed; }
</style>
