<script lang="ts">
  import { untrack } from 'svelte';
  import { patch } from '$lib/graph/store';
  import { nodeVersion, nodesStructuralVersion } from '$lib/graph/node-versions.svelte';
  import { useEngine } from '$lib/audio/engine-context';
  import type { AudioEngine } from '$lib/audio/engine';
  import { getClipAudioBuffer } from '$lib/audio/clip-audio-cache';
  import { CLIP_LANES, SCENE_STRIDE, audioRecState, clipIndex, laneOf, slotOf, laneRecArm, laneRecMode, readClip, type ClipPlayerData } from '$lib/audio/modules/clip-types';
  import { requestFaceTab } from '$lib/ui/workflow/face-tab-request.svelte';
  import { nodeClipRecorder } from '../node-clip-recorder-registry.svelte';
  import { clipplayerAudioFeedback, setClipplayerAudioFeedback } from './clipplayer-audio-feedback.svelte';
  import { clipplayerInspectClip, clipplayerSelectedClip, clipplayerSelectedSlotForLane } from './clipplayer-face-selection.svelte';
  import { queueClipplayerLane, setClipplayerAudioTarget, setClipplayerClipLive, toggleClipplayerLaneRecArm } from './clipplayer-face-actions';

  let { nodeId, waveform = false }: { nodeId: string; waveform?: boolean } = $props();
  const engine = useEngine();
  let live = $derived.by(() => ({ v: nodeVersion(nodeId), data: patch.nodes[nodeId]?.data as ClipPlayerData | undefined }));
  let index = $derived(clipplayerSelectedClip(nodeId));
  let lane = $derived(laneOf(index));
  let slot = $derived(slotOf(index));
  let clip = $derived((live.v, readClip(live.data, index)));
  let rec = $derived((live.v, audioRecState(live.data, lane)));
  let armed = $derived((live.v, laneRecArm(live.data, lane)));
  let target = $derived(rec?.slot ?? (armed ? live.data?.recRequest?.[String(lane)]?.slot : undefined) ?? clipplayerSelectedSlotForLane(nodeId, lane));
  let refusals = $derived(nodeClipRecorder.laneRefusals(nodeId));
  let message = $derived(clipplayerAudioFeedback(nodeId));
  let replacement = $state<{ index: number; mediaId: string } | null>(null);
  let peaks = $state<number[]>([]);
  let mediaState = $state<'loading' | 'ready' | 'unavailable' | 'stopped'>('stopped');
  let mediaKey = $derived(clip?.kind === 'audio' ? `${clip.mediaId}:${clip.takeAt}` : '');
  let mixer = $derived.by(() => {
    void nodesStructuralVersion();
    return Object.values(patch.nodes).find(n => n?.type === 'mixmstrs');
  });
  function inspect(next: number) {
    clipplayerInspectClip(nodeId, next);
    replacement = null;
    setClipplayerAudioFeedback(nodeId, '');
  }
  function setTarget() {
    setClipplayerAudioFeedback(nodeId, setClipplayerAudioTarget(nodeId, lane, slot) ?? `Record target: lane ${lane + 1}, slot ${slot + 1}. Playback unchanged.`);
  }
  function arm(replaceMediaId?: string) {
    setClipplayerAudioFeedback(nodeId, toggleClipplayerLaneRecArm(nodeId, lane, replaceMediaId) ?? '');
    replacement = null;
  }
  function confirmReplace() {
    if (!replacement || replacement.index !== index || clip?.kind !== 'audio' || replacement.mediaId !== clip.mediaId) {
      replacement = null;
      setClipplayerAudioFeedback(nodeId, 'The selected take changed. Choose Replace take again.');
      return;
    }
    const error = setClipplayerAudioTarget(nodeId, lane, slot);
    if (error) { setClipplayerAudioFeedback(nodeId, error); replacement = null; return; }
    arm(replacement.mediaId);
  }
  $effect(() => {
    void mediaKey;
    const selected = untrack(() => clip);
    const e = engine.get();
    peaks = [];
    if (!waveform || selected?.kind !== 'audio') return;
    if (!e?.hasDomain('audio')) { mediaState = 'stopped'; return; }
    mediaState = 'loading';
    let cancelled = false;
    void getClipAudioBuffer(e.getDomain<AudioEngine>('audio').ctx, selected).then(buffer => {
      if (cancelled) return;
      if (!buffer) { mediaState = 'unavailable'; return; }
      const left = buffer.getChannelData(0), right = buffer.getChannelData(1);
      const bins = 96;
      peaks = Array.from({ length: bins }, (_, i) => {
        let peak = 0;
        const end = Math.floor((i + 1) * left.length / bins);
        for (let j = Math.floor(i * left.length / bins); j < end; j++) peak = Math.max(peak, Math.abs(left[j]!), Math.abs(right[j]!));
        return Math.min(1, peak);
      });
      mediaState = 'ready';
    }).catch(() => { if (!cancelled) mediaState = 'unavailable'; });
    return () => { cancelled = true; };
  });
</script>

<div class="clip-strip" data-testid="clipplayer-audio-panel" data-clip-kind={clip?.kind ?? 'empty'}>
  <div class="strip-row">
    <label>LANE <select aria-label="Inspect lane" value={lane} onchange={e => inspect(clipIndex(slot, Number(e.currentTarget.value)))}>
      {#each Array(CLIP_LANES) as _, i}<option value={i}>{i + 1}</option>{/each}
    </select></label>
    <label>SLOT <select aria-label="Inspect slot" value={slot} onchange={e => inspect(clipIndex(Number(e.currentTarget.value), lane))}>
      {#each Array(SCENE_STRIDE) as _, i}<option value={i}>{i + 1}</option>{/each}
    </select></label>
    <span class:audio={clip?.kind === 'audio'}>{clip?.kind === 'audio' ? 'AUDIO CLIP' : clip?.kind === 'note' ? 'NOTE CLIP' : 'EMPTY'}</span>
    <button onclick={() => requestFaceTab(nodeId, waveform ? 'session' : 'editor')}>{waveform ? 'SESSION' : 'EDIT'}</button>
  </div>
  {#if clip?.kind === 'audio'}
    <div class="strip-row" role="group" aria-label="Audio clip playback">
      <span>PLAYBACK</span>
      <button class="source" aria-pressed={!clip.live} data-testid="clipplayer-source-recorded" onclick={() => setClipplayerClipLive(nodeId, index, false)}>RECORDED</button>
      <button class="source" aria-pressed={!!clip.live} data-testid="clipplayer-source-live" onclick={() => setClipplayerClipLive(nodeId, index, true)}>LIVE INPUT</button>
      <button data-testid="clipplayer-replace-take" disabled={armed || !!rec} onclick={() => { if (clip?.kind === 'audio') replacement = { index, mediaId: clip.mediaId }; }}>REPLACE TAKE…</button>
    </div>
    {#if waveform}
      <div class="waveform" role="img" aria-label={mediaState === 'ready' ? 'Recorded stereo waveform' : `Audio preview ${mediaState}`} data-media-state={mediaState}>
        {#if mediaState === 'ready'}
          {#each peaks as peak}<span style:height={`${Math.max(1, peak * 100)}%`}></span>{/each}
        {:else}<span class="media-message">{mediaState === 'loading' ? 'Loading take…' : mediaState === 'unavailable' ? 'Audio unavailable on this device' : 'Enable audio to preview this take'}</span>{/if}
      </div>
    {/if}
    <div class="strip-row">
      <button data-testid="clipplayer-audio-now" onclick={() => queueClipplayerLane(nodeId, lane, slot, true)}>NOW</button>
      <button data-testid="clipplayer-audio-queue" onclick={() => queueClipplayerLane(nodeId, lane, slot)}>QUEUE</button>
      <span>{clip.live ? 'Take bypassed; launch the original note slot to return to notes.' : `Recorded take → audio${lane + 1} L/R`}</span>
    </div>
  {:else}
    <div class="strip-row">
      <button data-testid="clipplayer-set-record-target" disabled={armed || !!rec} onclick={setTarget}>SET REC TARGET</button>
      <button data-testid="clipplayer-selected-record" onclick={() => arm()}>{rec?.phase === 'recording' ? laneRecMode(live.data, lane) === 'endless' ? 'FINISH TAKE' : 'CANCEL TAKE' : armed ? 'CANCEL ARM' : 'ARM AUDIO'}</button>
    </div>
  {/if}
  {#if clip?.kind === 'audio' && (armed || rec)}
    <button data-testid="clipplayer-selected-record" disabled={rec?.phase === 'stopping'} onclick={() => arm()}>{rec?.phase === 'recording' ? laneRecMode(live.data, lane) === 'endless' ? 'FINISH TAKE' : 'CANCEL TAKE' : 'CANCEL ARM'}</button>
  {/if}
  {#if replacement}
    <div class="replace" role="group" aria-label="Confirm audio replacement">
      <span>Replace lane {lane + 1}, slot {slot + 1}? The current take stays until a new take is saved.</span>
      <button data-testid="clipplayer-confirm-replace" onclick={confirmReplace}>REPLACE AND ARM</button>
      <button onclick={() => replacement = null}>CANCEL</button>
    </div>
  {/if}
  <div class="status" role="status" aria-live="polite" data-testid="clipplayer-record-status">
    {refusals[lane] || (rec ? `AUDIO ${rec.phase.toUpperCase()} · lane ${lane + 1}, slot ${rec.slot + 1}` : armed ? `AUDIO ARMED · lane ${lane + 1}, slot ${target + 1} · waiting for transport / boundary` : message || `REC target: lane ${lane + 1}, slot ${target + 1}`)}
  </div>
  <div class="routing">{mixer ? `Capture: MIXMSTRS input ${lane + 1}. Patched mixer inputs override the automatic take return; use audio${lane + 1} L/R when patched.` : 'Add MIXMSTRS to record audio. Recorded clips remain available at their audio L/R outputs.'}</div>
</div>

<style>
  .clip-strip { display:grid; gap:7px; border-top:1px solid var(--line,#41474d); padding-top:9px; width:100%; max-width:540px; color:var(--text,#e7edf4); font-size:11px; }
  .strip-row,.replace { display:flex; align-items:center; flex-wrap:wrap; gap:6px; }
  label { display:flex; align-items:center; gap:4px; }
  button,select { font:inherit; color:inherit; background:rgb(255 255 255 / .05); border:1px solid var(--line,#41474d); border-radius:3px; padding:4px 6px; min-height:24px; cursor:pointer; }
  select { background:#232930; }
  button:disabled { opacity:.45; cursor:default; }
  button[aria-pressed='true'] { border-color:#c59af5; background:#573973; }
  .audio { color:#c59af5; }
  .status,.routing { color:var(--dim,#b3becb); }
  .replace { padding:8px; border:1px solid #ba6a7d; }
  .waveform { height:100px; display:flex; align-items:center; gap:2px; padding:8px; background:rgb(255 255 255 / .03); }
  .waveform>span { flex:1; background:#bb94ed; min-width:1px; }
  .waveform>.media-message { background:none; text-align:center; }
</style>
