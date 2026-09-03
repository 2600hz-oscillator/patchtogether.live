<script lang="ts">
  // ClipplayerDeckBody — the clip player's `fullViewBody`: everything on the
  // legacy card that is a GESTURE rather than a cell-shaped control.
  //
  // WHAT LIVES HERE AND WHY IT CANNOT BE A CELL: the TRANSPORT (it writes
  // TIMELORDE's params, another node's, which no `face.order` key can address —
  // the electraControl addressability argument), the clip-undo stack, the
  // per-lane MUTE/STOP deck, the tempo nudge, the monome GRID bind, the two
  // independent RECORDERS (arranger launches, song print) and the AUTOMATION
  // status block. None of them is a ParamDef and none is a family that could
  // carry an honest operability probe.
  //
  // ⚠ THE FOUR VIEW BUTTONS OF THE CARD'S CONTROL STRIP ARE NOT REPRODUCED, AND
  // NOTHING IS LOST WITH THEM. On the card, keys/buttons 2–5 SWITCH which of
  // grid / clip / arranger / control you are looking at, because a 336 px tile
  // can only hold one at a time. The faceplate holds the launch grid (the
  // hero), the note editor (a band) and this deck AT ONCE, so there is no
  // selection left to make. Buttons 1 (transport), 6 (undo), 7 (redo) and the
  // shift-equivalent all survive, and so does the keyboard claim on those.
  //
  // ⚠ THREE READOUTS BECOME LAMPS, per the 2026-08-17/19 rulings. The per-lane
  // ASSIGNED-MODULE count chips, the MAX track-cap badge and the automation
  // OVERRIDE dot all painted a derived value at rest; each is now a
  // `StatusLed` whose caption is static and whose measurement reaches
  // `aria-label`/`title`. The OVERRIDE lamp keeps its click (re-enable all) —
  // it was always a button, and a lamp that is also a button is still a lamp.
  //
  // ⚠ ONE rAF LOOP FOR THE WHOLE SURFACE, and it is the card's, moved. It reads
  // transport state, the automation countdown, the override set and the
  // track-cap flag once per frame and reassigns only on a real change. It runs
  // in the DOCK BODY — a surface that exists only while the full view is open —
  // never in the lane tile, which is the #2314 rule: nothing expensive on a
  // surface that mounts with every rack boot.
  //
  // ── ⚠ AND THE CRASH-RECOVERY PROMPT, WHICH HAD NO FACE HOME AT ALL ─────────
  //
  // `clip-media-recovery.ts` was imported by `ClipplayerCard.svelte` AND BY
  // NOTHING ELSE, and clipplayer is not in `HEADLESS_MOUNT_LANE_TYPES`, so on
  // the default shell the scan for interrupted takes ran NOWHERE. The failure
  // that leaves is silent in both directions: an Arm-Endless take whose tab died
  // is permanently unrecoverable, while its manifest keeps `status: 'recording'`
  // so the media GC SPARES its bytes — a file nobody can reach and nothing will
  // ever collect. Every registry test stayed green, because this is exactly the
  // component-only behaviour the module-surfaces skill warns promotion deletes.
  //
  // ⚠ WHY THE DOCK BODY AND NOT THE TILE — recorderbox's answer, verbatim and
  // for the same two reasons. `RecorderboxCaptureBody` carries its recovery
  // prompt in the `fullViewBody` and `recorderbox-face-model.test.ts` states the
  // cost half outright ("the recovery scan is deliberately dock-only too, which
  // also keeps an IndexedDB read off every rack boot"). A clip player's scan is
  // strictly worse than recorderbox's on that axis: `scanClipRecoveries` walks
  // the manifests AND opens each candidate's OPFS file to measure it, and
  // `ClipplayerTileBody` mounts for EVERY clip player in EVERY rack boot — the
  // #2314 shape, which shipped a 60-scene VRT regression from one probe per
  // mount. The gesture half is the same too: a recovery question can wait for
  // the one Expand a player makes before doing anything else with the module.
  //
  // ⚠ NOT AN OVERLAY HERE, and the card's own note says why it had to be one
  // there: `.card` is `overflow: hidden` under a rack-tier-pinned height, so
  // appended flow content had its buttons clipped away — visible and
  // unanswerable. A dock pane carries no such pin, so this is ordinary flow
  // content at the TOP, where a blocking question belongs.

  import { untrack } from 'svelte';
  import { patch } from '$lib/graph/store';
  import { nodeVersion, nodesStructuralVersion } from '$lib/graph/node-versions.svelte';
  import { setNodeParam } from '$lib/graph/mutate';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import StatusLed from '$lib/ui/controls/StatusLed.svelte';
  import MidiAssignButton from '$lib/ui/controls/MidiAssignButton.svelte';
  import {
    CLIP_LANES,
    autoAssignCounts,
    coerceAutoAssign,
    type ClipPlayerData,
  } from '$lib/audio/modules/clip-types';
  import {
    coerceSongRecState,
    songHasContent,
    songLengthBeats,
    songNoteCount,
    type SongData,
  } from '$lib/audio/modules/clip-song';
  import {
    automationCountdownColor,
    automationCountdownOn,
    getAutomationRender,
  } from '$lib/audio/modules/clip-automation-render';
  import {
    consumeTrackCapHitFor,
    overriddenKeysFor,
    reEnableAllFor,
  } from '$lib/audio/automation-touch';
  import {
    clipCanRedo,
    clipCanUndo,
    clipRedo,
    clipUndo,
  } from '$lib/control/clip-undo';
  import {
    serialAvailable as gridSerialAvailable,
    connect as gridConnect,
    isConnected as gridIsConnected,
    connectedRune as gridConnectedRune,
  } from '$lib/control/monome/monome-device.svelte';
  import {
    bindGridToClip,
    unbindGrid,
    boundClipNode,
    bindingRune,
  } from '$lib/control/monome/monome-control.svelte';
  import {
    clipRecoveryLabel,
    discardClipTake,
    recoverClipTake,
    scanClipRecoveries,
    type ClipRecoveryCandidate,
  } from '../clip-media-recovery';
  import ClipArrangeEditor from '../ClipArrangeEditor.svelte';
  import { clipplayerLaneViews } from './clipplayer-face-model';
  import {
    resetClipplayerLanes,
    stopAllClipplayerLanes,
    stopClipplayerLane,
    toggleClipplayerLaneMute,
    toggleClipplayerSongRec,
    toggleClipplayerSongRecMode,
    writeClipplayerData,
  } from './clipplayer-face-actions';

  interface Props {
    nodeId: string;
  }
  let { nodeId }: Props = $props();

  const engineCtx = useEngine();

  let live = $derived.by(() => ({
    v: nodeVersion(nodeId),
    n: patch.nodes[nodeId] as ModuleNode | undefined,
  }));
  let data = $derived(live.n?.data as ClipPlayerData | undefined);
  let lanes = $derived(clipplayerLaneViews(data, (mid) => !!patch.nodes[mid]));

  // ── TRANSPORT (TIMELORDE's, not this module's) ───────────────────────────
  function timelordeId(): string | null {
    for (const [nid, n] of Object.entries(patch.nodes)) {
      if ((n as { type?: string } | undefined)?.type === 'timelorde') return nid;
    }
    return null;
  }
  let hasTimelorde = $derived((live.v, nodesStructuralVersion(), timelordeId() !== null));
  let tempoBpm = $derived.by(() => {
    void live.v;
    void nodesStructuralVersion();
    const tid = timelordeId();
    const n = tid ? patch.nodes[tid] : null;
    return typeof n?.params?.bpm === 'number' ? Math.round(n.params.bpm) : null;
  });
  function toggleTransport() {
    const tid = timelordeId();
    if (!tid) return;
    setNodeParam(tid, 'running', transportRunning ? 0 : 1);
  }
  /** Nudge TIMELORDE bpm by ±delta, clamped 10..300 — the same reach + clamp
   *  the Launchpad's control view uses. No-op with no TIMELORDE. */
  function nudgeTempo(delta: number) {
    const tid = timelordeId();
    if (!tid) return;
    const n = patch.nodes[tid];
    const cur = typeof n?.params?.bpm === 'number' ? n.params.bpm : 120;
    setNodeParam(tid, 'bpm', Math.max(10, Math.min(300, cur + delta)));
  }

  // ── THE ONE POLL ─────────────────────────────────────────────────────────
  let transportRunning = $state(false);
  let externallyClocked = $state(false);
  let autoOverridden = $state(false);
  let capBadge = $state(false);
  let recordingLanes = $state(0);
  let countdownLit = $state(false);
  let capHitUntil = 0;
  let cdSig = '';

  let autoTrackKeys = $derived.by<Set<string>>(() => {
    void live.v;
    const keys = new Set<string>();
    const auto = (data as { auto?: Record<string, unknown> } | undefined)?.auto;
    if (auto && typeof auto === 'object') {
      for (const rec of Object.values(auto)) {
        const tracks = (rec as { tracks?: Record<string, unknown> } | null)?.tracks;
        if (tracks && typeof tracks === 'object') for (const k of Object.keys(tracks)) keys.add(k);
      }
    }
    return keys;
  });
  let assignedModuleIds = $derived.by<Set<string>>(() => {
    void live.v;
    return new Set(Object.keys(coerceAutoAssign(data?.autoAssign)));
  });

  $effect(() => {
    const node = live.n;
    let raf = 0;
    const frame = () => {
      const e = engineCtx.get();
      if (e && node) {
        const tr = e.read(node, 'transportRunning');
        if (typeof tr === 'number') transportRunning = tr >= 0.5;
        const ec = e.read(node, 'externallyClocked');
        if (typeof ec === 'number') externallyClocked = ec >= 0.5;
      }
      // Override: lit when a param THIS player automates is suspended by a live
      // grab. Client-local touch state, so it is polled, never derived.
      const keys = overriddenKeysFor(nodeId);
      autoOverridden =
        keys.length > 0 &&
        keys.some((k) => autoTrackKeys.has(k) || assignedModuleIds.has(k.split('::')[0] ?? ''));
      // The 🟡🟡🔴🔴 countdown, collapsed to ONE lamp for the surface: which
      // lane is counting is already shown by its armed ◉, and eight per-lane
      // lamps would be eight readouts of one fact.
      const rs = getAutomationRender(nodeId);
      let sig = '';
      let recCount = 0;
      let lit = false;
      for (const l of rs?.lanes ?? []) {
        if (!l.recording) continue;
        recCount++;
        const color = automationCountdownColor(l.beatsToLoopEnd);
        if (color && automationCountdownOn(l.beatPhase)) lit = true;
        sig += `${l.lane}:${color ?? ''}:${lit ? 1 : 0};`;
      }
      if (sig !== cdSig) {
        cdSig = sig;
        recordingLanes = recCount;
        countdownLit = lit;
      }
      if (consumeTrackCapHitFor(nodeId)) capHitUntil = performance.now() + 4000;
      const capNow = performance.now() < capHitUntil;
      if (capNow !== capBadge) capBadge = capNow;
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  });

  let showTransport = $derived(hasTimelorde && !externallyClocked);

  // ⚠ NO AUTO-PRUNE EFFECT HERE, AND THAT IS THE MEASURED ANSWER RATHER THAN AN
  // OMISSION. The card runs `pruneAutoAssignDangling(id)` in a `$effect`, which
  // is exactly the shape of component-only behaviour promotion deletes — but
  // this one is already redundant: `pruneAllAutoAssignDangling()` sweeps EVERY
  // clip player from the Canvas graph-change seam (`Canvas.svelte`), which its
  // own comment says exists so an assignment is dropped "even when no
  // clipplayer CARD is mounted (docked, off-screen, collapsed group)". The
  // ongoing behaviour already lives where the module-surfaces skill says it
  // must — outside the UI — so re-mounting it on a face surface would add a
  // second janitor for a job the platform finished.

  let assignedTotal = $derived(autoAssignCounts(data, (mid) => !!patch.nodes[mid]).reduce((a, b) => a + b, 0));

  // ── UNDO / REDO ──────────────────────────────────────────────────────────
  let canUndo = $derived((live.v, clipCanUndo(nodeId)));
  let canRedo = $derived((live.v, clipCanRedo(nodeId)));

  // ── monome GRID bind ─────────────────────────────────────────────────────
  const gridSupported = gridSerialAvailable();
  let gridBoundHere = $derived((bindingRune(), gridConnectedRune(), boundClipNode() === nodeId));
  async function toggleGrid() {
    if (boundClipNode() === nodeId) {
      unbindGrid();
      return;
    }
    const ok = await gridConnect();
    if (ok || gridIsConnected()) bindGridToClip(nodeId);
  }

  // ── the two recorders ────────────────────────────────────────────────────
  let arrangeMode = $derived((live.v, data?.clipMode === 'arrangement'));
  let recording = $derived((live.v, data?.recording === true));
  let recordMode = $derived((live.v, data?.recordMode === 'overdub' ? 'overdub' : 'replace'));
  let songMode = $derived((live.v, data?.clipMode === 'song'));
  let songRecArmed = $derived((live.v, coerceSongRecState(data?.songRec)?.armed === true));
  let songRecMode = $derived(
    (live.v, coerceSongRecState(data?.songRec)?.mode === 'overdub' ? 'overdub' : 'replace'),
  );
  let songNotes = $derived((live.v, songNoteCount(data?.song as SongData | undefined)));
  let songBars = $derived(
    (live.v, Math.max(1, Math.round(songLengthBeats(data?.song as SongData | undefined, 4) / 4))),
  );
  let songHasAny = $derived((live.v, songHasContent(data?.song as SongData | undefined)));

  const toggleArrangeMode = () =>
    writeClipplayerData(nodeId, (d) => {
      d.clipMode = d.clipMode === 'arrangement' ? 'session' : 'arrangement';
    });
  const toggleRecord = () =>
    writeClipplayerData(nodeId, (d) => {
      d.recording = !d.recording;
    });
  const toggleRecordMode = () =>
    writeClipplayerData(nodeId, (d) => {
      d.recordMode = d.recordMode === 'overdub' ? 'replace' : 'overdub';
    });
  const toggleSongMode = () =>
    writeClipplayerData(nodeId, (d) => {
      d.clipMode = d.clipMode === 'song' ? 'session' : 'song';
    });
  const toggleSongRec = () => toggleClipplayerSongRec(nodeId);
  const toggleSongRecMode = () => toggleClipplayerSongRecMode(nodeId);

  let arrangeEditorOpen = $state(false);

  // ── CRASH RECOVERY: takes this node was still recording when its tab died ──
  //
  // Scanned ONCE per mount of this body, which is once per Expand — the card
  // scanned once per card mount and there is no other trigger on either
  // surface, so a manifest written after the pane opened is not read until the
  // next one. That is the recorderbox contract too, and it is stated rather than
  // hidden because it is what the e2e has to seed AROUND.
  //
  // ⚠ `untrack` IS LOAD-BEARING. `rescanRecoveries` writes `recoveries`, and
  // without it the write re-runs the effect that made it — a self-feeding loop
  // that would put an OPFS read on a permanent cycle. The sibling
  // `RecorderboxCaptureBody` mount effect is untracked for exactly this reason.
  let recoveries = $state<ClipRecoveryCandidate[]>([]);
  async function rescanRecoveries(): Promise<void> {
    try {
      recoveries = await scanClipRecoveries(nodeId);
    } catch {
      // Storage unavailable (a private window, a browser with no OPFS): offer
      // nothing, break nothing. The prompt is additive by construction.
      recoveries = [];
    }
  }
  $effect(() => {
    void nodeId;
    untrack(() => {
      void rescanRecoveries();
    });
  });
  async function onRecoverTake(c: ClipRecoveryCandidate): Promise<void> {
    await recoverClipTake(nodeId, c);
    await rescanRecoveries();
  }
  async function onDiscardTake(c: ClipRecoveryCandidate): Promise<void> {
    await discardClipTake(c);
    await rescanRecoveries();
  }
</script>

<div class="deck" data-testid="clipplayer-face-deck">
  <!-- THE BLOCKING QUESTION, FIRST — and ABSENT AT REST, which is what keeps
       every dock baseline unmoved: no scene seeds a clip-media manifest, so
       nothing here renders in a VRT capture.

       The label is a count of LOOPS (`clipRecoveryLabel`), never a byte size:
       recovery truncates to the last WHOLE loop, and loops are the unit the
       take was recorded in and the only one that says what is coming back.
       ⚠ NO `aria-label` REPEATS IT — the sentence is painted once, which is
       also what keeps the `control-grid` speakable-not-painted leg green. -->
  {#if recoveries.length > 0}
    <div class="recover" data-testid="clipplayer-face-recover">
      <p class="recover-title">Recover interrupted take?</p>
      {#each recoveries as c (c.manifest.mediaId)}
        <div class="recover-row">
          <span class="recover-name">{clipRecoveryLabel(c)}</span>
          <button
            type="button"
            class="recover-save nodrag"
            title="Restore this take into its slot, truncated to the last whole loop"
            data-testid="clipplayer-face-recover-save"
            onclick={() => onRecoverTake(c)}>Recover</button
          >
          <button
            type="button"
            class="recover-discard nodrag"
            title="Delete this take and free its storage"
            data-testid="clipplayer-face-recover-discard"
            onclick={() => onDiscardTake(c)}>Discard</button
          >
        </div>
      {/each}
    </div>
  {/if}

  <!-- TRANSPORT + the clip-undo stack: the surviving half of the card's control
       strip. `disabled` rather than hidden when there is no TIMELORDE to drive,
       so the gesture's absence reads as a fact about the rack. -->
  <div class="row" role="toolbar" aria-label="clip player transport">
    {#if showTransport}
      <button
        class="btn"
        class:on={transportRunning}
        title={transportRunning ? 'Stop transport (TIMELORDE)' : 'Start transport (TIMELORDE)'}
        aria-label="transport"
        data-testid={`clipplayer-transport-${nodeId}`}
        onclick={toggleTransport}>{transportRunning ? '■' : '▶'}</button
      >
    {/if}
    <button
      class="btn"
      disabled={!canUndo}
      title="Undo the last clip edit"
      aria-label="undo"
      data-testid={`clipplayer-strip-6-${nodeId}`}
      onclick={() => clipUndo(nodeId)}>↶</button
    >
    <button
      class="btn"
      disabled={!canRedo}
      title="Redo the last undone clip edit"
      aria-label="redo"
      data-testid={`clipplayer-strip-7-${nodeId}`}
      onclick={() => clipRedo(nodeId)}>↷</button
    >
    <MidiAssignButton moduleId={nodeId} paramId="reset" label="RESET" momentary={false} onToggle={() => resetClipplayerLanes(nodeId)}>
      <button
        class="btn"
        title="Reset all active clips to step 1 (re-anchors lane clock phase; queued launches keep). Right-click to MIDI-assign."
        data-testid="clipplayer-reset"
        onclick={() => resetClipplayerLanes(nodeId)}>RST</button
      >
    </MidiAssignButton>
    <button
      class="btn stopall"
      title="Stop all lanes"
      data-testid={`clipplayer-stopall-${nodeId}`}
      onclick={() => stopAllClipplayerLanes(nodeId)}>■ ALL</button
    >
    <span class="tempo" title="TIMELORDE tempo (±2 bpm)">
      <button
        class="btn"
        aria-label="tempo down"
        data-testid={`clipplayer-tempo-down-${nodeId}`}
        onclick={() => nudgeTempo(-2)}>−</button
      >
      <!-- The BPM is the rack transport's own number and the module does not
           own it; it is announced, not painted. -->
      <StatusLed
        caption="BPM"
        lit={tempoBpm !== null}
        detail={tempoBpm !== null ? `TIMELORDE is at ${tempoBpm} bpm` : 'no TIMELORDE in this rack'}
        testid={`clipplayer-tempo-${nodeId}`}
      />
      <button
        class="btn"
        aria-label="tempo up"
        data-testid={`clipplayer-tempo-up-${nodeId}`}
        onclick={() => nudgeTempo(2)}>+</button
      >
    </span>
    <button
      class="btn"
      class:on={gridBoundHere}
      disabled={!gridSupported}
      title={!gridSupported
        ? 'monome grid needs WebSerial (Chromium only)'
        : gridBoundHere
          ? 'Disconnect monome grid'
          : 'Connect a monome grid to launch clips'}
      data-testid={`clipplayer-grid-${nodeId}`}
      onclick={toggleGrid}>GRID</button
    >
  </div>

  <!-- PER-LANE PERFORMANCE DECK — mute and stop, the card's CONTROL view. -->
  <div class="deck-lanes" role="group" aria-label="per-lane mute and stop">
    {#each lanes as l (l.lane)}
      <div class="deck-lane" style={`--lane-color:${l.color}`}>
        <span class="deck-lane-lbl" aria-hidden="true">{l.lane + 1}</span>
        <button
          class="deck-mute"
          class:on={l.muted}
          title={l.muted
            ? `Ch ${l.lane + 1} MUTED — click to unmute`
            : `Ch ${l.lane + 1} MUTE — the lane keeps advancing but emits no audio`}
          aria-label={`channel ${l.lane + 1} mute`}
          aria-pressed={l.muted}
          data-lane={l.lane}
          data-testid={`clipplayer-mute-${l.lane}`}
          onclick={() => toggleClipplayerLaneMute(nodeId, l.lane)}>M</button
        >
        <button
          class="deck-stop"
          title={`Stop Ch ${l.lane + 1} (queue stop)`}
          aria-label={`channel ${l.lane + 1} stop`}
          data-lane={l.lane}
          data-testid={`clipplayer-stop-${l.lane}`}
          onclick={() => stopClipplayerLane(nodeId, l.lane)}>■</button
        >
      </div>
    {/each}
  </div>

  <!-- THE TWO RECORDERS, kept visibly apart exactly as the card keeps them: the
       ARRANGER record captures clip LAUNCHES onto a timeline; SONG-REC prints a
       concrete performance. Neither is the per-lane automation arm, which
       records knob moves and lives on its own cell. -->
  <div class="row" role="group" aria-label="arranger record">
    <button
      class="btn"
      class:on={arrangeMode}
      title={arrangeMode
        ? 'ARRANGEMENT (experimental) — playing the recorded song. Click for SESSION.'
        : 'SESSION — launch clips live. Click for ARRANGEMENT (experimental — play the recorded song).'}
      data-testid={`clipplayer-mode-${nodeId}`}
      onclick={toggleArrangeMode}>{arrangeMode ? 'ARR' : 'SES'}</button
    >
    <button
      class="btn rec"
      class:on={recording}
      aria-pressed={recording}
      title={recording
        ? 'ARRANGER RECORD (experimental): recording clip LAUNCHES to the song timeline — click to stop. (This is NOT clip record — the per-lane ◉ arms record knob moves.)'
        : `ARRANGER RECORD (experimental): record clip LAUNCHES into the arrangement (${recordMode === 'overdub' ? 'OVERDUB' : 'REPLACE'}). NOT clip record.`}
      data-testid={`clipplayer-record-${nodeId}`}
      onclick={toggleRecord}>●</button
    >
    <button
      class="btn"
      class:on={recordMode === 'overdub'}
      aria-pressed={recordMode === 'overdub'}
      title={recordMode === 'overdub'
        ? 'OVERDUB — arranger record keeps the take + merges new launches. Click for REPLACE.'
        : 'REPLACE — arranger record clears + records fresh. Click for OVERDUB.'}
      data-testid={`clipplayer-recmode-${nodeId}`}
      onclick={toggleRecordMode}>{recordMode === 'overdub' ? 'OVR' : 'RPL'}</button
    >
    <button
      class="btn"
      title="Open the full-window arranger editor"
      data-testid={`clipplayer-arrange-open-${nodeId}`}
      onclick={() => (arrangeEditorOpen = true)}>ARR ⤢</button
    >
  </div>

  <div class="row" role="group" aria-label="song record">
    <button
      class="btn"
      class:on={songMode}
      aria-pressed={songMode}
      title={songMode
        ? 'SONG playback (authoritative) — song time drives the printed channels out the lane outputs; clips do not launch live. Click for SESSION.'
        : 'SESSION — launch clips live (perform + PRINT here under SONG-REC). Click to PLAY the recorded SONG.'}
      data-testid={`clipplayer-song2-mode-${nodeId}`}
      onclick={toggleSongMode}>{songMode ? 'SONG' : 'SES'}</button
    >
    <button
      class="btn rec"
      class:on={songRecArmed}
      aria-pressed={songRecArmed}
      title={songRecArmed
        ? 'SONG-REC armed — perform in SESSION and the concrete result PRINTS to the song channels. Click to disarm (punch out).'
        : `SONG-REC (${songRecMode === 'overdub' ? 'OVERDUB' : 'REPLACE'}): arm, then perform in SESSION to PRINT into the song.`}
      data-testid={`clipplayer-song2-rec-${nodeId}`}
      onclick={toggleSongRec}>● SONG</button
    >
    <button
      class="btn"
      class:on={songRecMode === 'overdub'}
      aria-pressed={songRecMode === 'overdub'}
      title={songRecMode === 'overdub'
        ? 'OVERDUB — SONG-REC keeps the take + merges new performance. Click for REPLACE.'
        : 'REPLACE — SONG-REC clears + prints fresh. Click for OVERDUB.'}
      data-testid={`clipplayer-song2-recmode-${nodeId}`}
      onclick={toggleSongRecMode}>{songRecMode === 'overdub' ? 'OVR' : 'RPL'}</button
    >
    <StatusLed
      caption="SONG"
      lit={songHasAny}
      detail={songHasAny
        ? `${songNotes} printed notes over ${songBars} bars`
        : 'nothing printed to the song yet'}
      testid={`clipplayer-song2-info-${nodeId}`}
    />
  </div>

  <!-- AUTOMATION STATUS. Three former readouts, three lamps. The OVERRIDE lamp
       is still the click that re-enables every suspended param at once. -->
  <div class="row" role="group" aria-label="automation status">
    <StatusLed
      caption="ASSIGNED"
      lit={assignedTotal > 0}
      detail={assignedTotal > 0
        ? `${assignedTotal} module${assignedTotal === 1 ? '' : 's'} assigned across the eight automation lanes (${lanes
            .filter((l) => l.assigned > 0)
            .map((l) => `lane ${l.lane + 1}: ${l.assigned}`)
            .join(', ')})`
        : 'no modules assigned — right-click a module card and choose Assign to automation lane'}
      testid={`clipplayer-auto-assigned-${nodeId}`}
    />
    <StatusLed
      caption="REC"
      lit={recordingLanes > 0 && countdownLit}
      detail={recordingLanes > 0
        ? `${recordingLanes} lane${recordingLanes === 1 ? '' : 's'} overdubbing; the lamp pulses on the last four beats before each clip wraps`
        : 'no lane is recording automation'}
      testid={`clipplayer-auto-countdown-${nodeId}`}
    />
    <StatusLed
      caption="MAX"
      lit={capBadge}
      tone="warn"
      detail={capBadge
        ? 'track cap reached — this clip already automates the maximum number of controls; the existing tracks keep recording, the over-cap control is not captured'
        : 'the recording clip is under its automation track cap'}
      testid={`clipplayer-auto-cap-${nodeId}`}
    />
    <button
      class="btn override"
      class:on={autoOverridden}
      disabled={!autoOverridden}
      aria-label="re-enable automation"
      title={autoOverridden
        ? 'A grabbed control is overriding automation playback (live wins) — click to re-enable all'
        : 'Nothing is overriding automation playback'}
      data-testid={`clipplayer-auto-override-${nodeId}`}
      onclick={() => reEnableAllFor(nodeId)}>●</button
    >
  </div>
</div>

{#if arrangeEditorOpen}
  <ClipArrangeEditor
    id={nodeId}
    node={live.n}
    onClose={() => (arrangeEditorOpen = false)}
  />
{/if}

<style>
  .deck {
    display: grid;
    gap: 5px;
    width: 100%;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
  }
  .btn {
    height: 16px;
    min-width: 16px;
    padding: 0 5px;
    font-size: 9px;
    line-height: 1;
    letter-spacing: 0.05em;
    color: rgb(255 255 255 / 0.42);
    background: rgb(255 255 255 / 0.05);
    border: 1px solid rgb(255 255 255 / 0.1);
    border-radius: 2px;
    cursor: pointer;
  }
  .btn:hover:not(:disabled) {
    color: #fff;
  }
  .btn:disabled {
    color: rgb(255 255 255 / 0.18);
    cursor: default;
  }
  .btn.on {
    color: #fff;
    border-color: var(--domain, #4dd6c1);
    background: color-mix(in srgb, var(--domain, #4dd6c1) 24%, transparent);
  }
  /* Both RECORD buttons are red when armed, and neither is the automation arm:
     the card keeps the two recorders visually apart and so does this. */
  .btn.rec.on,
  .btn.override.on {
    color: #fff;
    background: hsl(0 62% 38%);
    border-color: hsl(0 70% 58%);
  }
  .btn.stopall {
    letter-spacing: 0.08em;
  }
  .tempo {
    display: inline-flex;
    align-items: center;
    gap: 3px;
  }

  .deck-lanes {
    display: grid;
    grid-template-columns: repeat(8, auto);
    gap: 3px;
    justify-content: start;
  }
  .deck-lane {
    display: grid;
    grid-template-rows: auto auto auto;
    gap: 2px;
    justify-items: center;
  }
  .deck-lane-lbl {
    font-size: 8px;
    color: rgb(255 255 255 / 0.3);
    font-variant-numeric: tabular-nums;
  }
  .deck-mute,
  .deck-stop {
    width: 28px;
    height: 14px;
    padding: 0;
    font-size: 9px;
    line-height: 1;
    color: rgb(255 255 255 / 0.42);
    background: rgb(255 255 255 / 0.05);
    border: 1px solid rgb(255 255 255 / 0.1);
    border-radius: 2px;
    cursor: pointer;
  }
  .deck-mute.on {
    color: #fff;
    background: hsl(38 70% 40%);
    border-color: hsl(38 80% 58%);
  }
  .deck-mute:hover,
  .deck-stop:hover {
    color: #fff;
  }

  /* THE RECOVERY PROMPT. Ordinary flow content, not an overlay: the card had to
     float this over its grid because `.card` is `overflow: hidden` under a
     rack-pinned height and its buttons were clipped away unreachable. A dock
     pane has no pin, so it sits at the top of the deck where a blocking
     question belongs. The dashed accent border is recorderbox's — the two
     prompts ask the same question about the same kind of loss, and a player who
     has answered one should recognise the other. */
  .recover {
    padding: 8px;
    border: 1px dashed var(--accent-dim);
    border-radius: 4px;
    background: var(--module-bg);
  }
  .recover-title {
    margin: 0 0 6px;
    font-size: 0.66rem;
    color: var(--accent);
  }
  .recover-row {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 4px;
  }
  .recover-name {
    flex: 1;
    min-width: 0;
    font-size: 0.64rem;
    font-family: ui-monospace, monospace;
    color: var(--text-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .recover-save,
  .recover-discard {
    font-size: 0.6rem;
    padding: 3px 7px;
    border-radius: 3px;
    cursor: pointer;
    border: 1px solid var(--border);
    background: var(--input-bg, #111);
    color: var(--text);
  }
  .recover-save:hover {
    border-color: var(--accent);
  }
  .recover-discard:hover {
    border-color: #ff3b30;
  }
</style>
