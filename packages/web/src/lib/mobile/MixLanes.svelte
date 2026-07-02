<script lang="ts">
  // MIX tab — MIXMSTRS as horizontal full-width lanes (spec §3 MIX).
  //
  // DECISION: horizontal lanes, not 7 vertical faders — 390/7 ≈ 55px columns
  // can't hold fader+VU+mute+label at touch size. Six 88px lanes (label |
  // fader strip with the VU as a fill bar behind | 56×56 MUTE) + the MASTER
  // lane pinned at the bottom (best thumb position).
  //
  // Meters: ONE onMeterFrame subscription reading engine.read(mx,'levels')
  // → number[6] post-fader RMS (private rAF loops caused the underrun
  // regression). All 6 channels read directly — no ch>4 clamp (the Electra
  // host bug the spec warns about). Master VU reads audioOut's
  // outputSnapshot analyser (first cut if time-pressed — it was cheap).
  import { onDestroy, onMount } from 'svelte';
  import LaneFader from '$lib/mobile/LaneFader.svelte';
  import ChannelDetail from '$lib/mobile/ChannelDetail.svelte';
  import { onMeterFrame, type MeterFrameHandle } from '$lib/ui/meter-frame';
  import { getMobileEngine, readParamValue, spawnModule } from '$lib/mobile/mobile-host';
  import { isChannelMuted, toggleChannelMute, volumeParamId } from '$lib/mobile/mute-stash';
  import { setNodeParam } from '$lib/graph/mutate';
  import { MIXMSTRS_CHANNELS, rmsLevel } from '$lib/audio/modules/mixmstrs';
  import type { ModuleNode } from '$lib/graph/types';

  interface Props {
    nodes: ModuleNode[];
    undoPill: (msg: string) => void;
  }
  let { nodes, undoPill }: Props = $props();

  let mixNode = $derived(nodes.find((n) => n.type === 'mixmstrs'));
  let audioOutNode = $derived(nodes.find((n) => n.type === 'audioOut'));

  // ── The ONE meter subscription ──
  let lanesEl: HTMLDivElement | null = $state(null);
  let levels = $state<number[]>([0, 0, 0, 0, 0, 0]);
  let masterVu = $state(0);
  let meter: MeterFrameHandle | null = null;

  onMount(() => {
    meter = onMeterFrame(lanesEl, () => {
      const eng = getMobileEngine();
      if (!eng) return;
      const mx = mixNode;
      if (mx) {
        try {
          const l = eng.read(mx, 'levels');
          if (Array.isArray(l)) levels = l as number[];
        } catch {
          /* engine node not materialized yet */
        }
      }
      const ao = audioOutNode;
      if (ao) {
        try {
          const snap = eng.read(ao, 'outputSnapshot') as { samples: Float32Array } | undefined;
          if (snap?.samples) masterVu = rmsLevel(snap.samples);
        } catch {
          /* not materialized yet */
        }
      }
    });
  });
  onDestroy(() => meter?.stop());

  // ── Channel detail sheet ──
  let detailCh = $state<number | null>(null);
  function stepDetail(delta: number) {
    if (detailCh === null) return;
    detailCh = ((detailCh - 1 + delta + 6) % 6) + 1;
  }

  function onMute(ch: number) {
    if (!mixNode) return;
    toggleChannelMute(mixNode.id, ch);
    undoPill(isChannelMuted(mixNode, ch) ? `ch${ch} muted` : `ch${ch} unmuted`);
  }
</script>

<div class="mix-tab" data-testid="m-mix-tab">
  {#if !mixNode}
    <div class="empty">
      <p>no mixer in this rack.</p>
      <button class="add-btn" onclick={() => spawnModule('mixmstrs')} data-testid="m-mix-add">
        ADD MIXMSTRS
      </button>
    </div>
  {:else}
    <div class="lanes" bind:this={lanesEl}>
      {#each MIXMSTRS_CHANNELS as ch (ch)}
        {@const muted = isChannelMuted(mixNode, ch)}
        <div class="lane" data-testid={`m-mix-lane-${ch}`}>
          <button class="lane-label" onclick={() => (detailCh = ch)} data-testid={`m-mix-label-${ch}`}>
            <span class="lane-name">CH{ch}</span>
            <span class="lane-sub">tap for EQ · comp · sends</span>
          </button>
          <div class="lane-fader-wrap">
            <LaneFader
              value={readParamValue(mixNode, volumeParamId(ch))}
              vu={levels[ch - 1] ?? 0}
              {muted}
              defaultValue={0.8}
              label={`channel ${ch}`}
              onchange={(v) => mixNode && setNodeParam(mixNode.id, volumeParamId(ch), v)}
              testid={`m-mix-fader-${ch}`}
            />
          </div>
          <button
            class="mute"
            class:on={muted}
            onclick={() => onMute(ch)}
            data-testid={`m-mix-mute-${ch}`}
            data-muted={muted}
            aria-label={`mute channel ${ch}`}
          >
            M
          </button>
        </div>
      {/each}
    </div>

    <!-- MASTER pinned bottom, above the tab bar. -->
    <div class="master" data-testid="m-mix-master">
      <span class="lane-name">MASTER</span>
      <div class="lane-fader-wrap">
        <LaneFader
          value={readParamValue(mixNode, 'master_volume')}
          vu={masterVu}
          defaultValue={0.8}
          label="master"
          onchange={(v) => mixNode && setNodeParam(mixNode.id, 'master_volume', v)}
          testid="m-mix-fader-master"
        />
      </div>
    </div>

    {#if detailCh !== null}
      <ChannelDetail
        node={mixNode}
        ch={detailCh}
        vu={levels[detailCh - 1] ?? 0}
        onclose={() => (detailCh = null)}
        onstep={stepDetail}
      />
    {/if}
  {/if}
</div>

<style>
  .mix-tab {
    display: flex;
    flex-direction: column;
    min-height: 100%;
  }
  .empty {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    color: #8b93a3;
  }
  .add-btn {
    min-height: 56px;
    padding: 0 24px;
    border-radius: 14px;
    border: 1px solid rgba(79, 140, 255, 0.6);
    background: rgba(79, 140, 255, 0.22);
    color: #dbe2ee;
    font-size: 15px;
    font-weight: 700;
  }
  .lanes {
    flex: 1;
    overflow-y: auto;
    padding: 8px 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .lane {
    display: grid;
    grid-template-columns: 84px 1fr 56px;
    align-items: center;
    gap: 8px;
    min-height: 88px;
  }
  .lane-label {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 3px;
    background: none;
    border: none;
    padding: 4px;
    text-align: left;
  }
  .lane-name {
    font-size: 14px;
    font-weight: 800;
    color: #dbe2ee;
    letter-spacing: 0.04em;
  }
  .lane-sub {
    font-size: 9.5px;
    color: #667085;
  }
  .lane-fader-wrap {
    min-width: 0;
  }
  .mute {
    width: 56px;
    height: 56px;
    border-radius: 12px;
    border: 1px solid #2a2f3a;
    background: rgba(255, 255, 255, 0.04);
    color: #8b93a3;
    font-size: 16px;
    font-weight: 800;
  }
  .mute.on {
    background: rgba(226, 68, 92, 0.3);
    border-color: rgba(226, 68, 92, 0.7);
    color: #ff8b9b;
  }
  .master {
    flex: none;
    display: grid;
    grid-template-columns: 84px 1fr;
    align-items: center;
    gap: 8px;
    padding: 10px;
    border-top: 1px solid #1c212b;
    background: #10141b;
  }
</style>
