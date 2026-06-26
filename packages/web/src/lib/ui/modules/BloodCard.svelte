<script lang="ts">
  // BloodCard — UI for the single-instance, owner-only interactive BLOOD video
  // module (the NBlood/Build-engine port). A LEAN single-player card modelled on
  // DoomCard's load + keyboard-capture pattern (DoomCard's heavy MP lockstep/
  // roster/netcode is NOT cloned — Phase 1 is single-player).
  //
  // KEYBOARD CAPTURE (the load-bearing special case, same as DOOM): while this
  // card is focused/selected, a window-level CAPTURE-phase keydown/keyup listener
  // fires BEFORE SvelteFlow's node-keyboard-move + canvas shortcuts, so arrow
  // keys drive the marine instead of sliding the card. We route the key to the
  // runtime via the engine extras.
  //
  // DATA: Blood files are user-supplied + NOT redistributable. With them missing
  // the card shows a "Blood data missing — run `task setup:blood`" overlay
  // (no out-of-box play, unlike DOOM). See native/nblood/PHASE0-STATUS.md §3.

  import { onMount, onDestroy } from 'svelte';
  import { type NodeProps } from '@xyflow/svelte';
  import { useEngine } from '$lib/audio/engine-context';
  import { patch } from '$lib/graph/store';
  import { setNodeParam } from '$lib/graph/mutate';
  import type { VideoEngine } from '$lib/video/engine';
  import type { ModuleNode } from '$lib/graph/types';
  import { bloodDef, type BloodHandleExtras } from '$lib/video/modules/blood';
  import { SCANCODE_FOR_KEYBOARD_CODE } from '$lib/blood/blood-keys';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import ModuleTitle from './ModuleTitle.svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';

  let { id, data, selected }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  let cardEl: HTMLDivElement | null = $state(null);
  let loadStatus = $state<'idle' | 'loading' | 'ready' | 'error'>('idle');
  let loadError = $state<string | null>(null);
  let missing = $state<string[]>([]);

  // PatchPanel descriptors derived straight from the def ports.
  const inputs: PortDescriptor[] = bloodDef.inputs.map((p) => ({
    id: p.id,
    cable: p.type,
    label: p.id.toUpperCase(),
  }));
  const outputs: PortDescriptor[] = bloodDef.outputs.map((p) => ({
    id: p.id,
    cable: p.type,
    label: p.id.toUpperCase(),
  }));

  let audioGain = $derived<number>((node?.params?.audioGain as number | undefined) ?? 1);
  function setAudioGain(v: number): void {
    setNodeParam(id, 'audioGain', v);
  }

  function getExtras(): BloodHandleExtras | null {
    const e = engineCtx.get();
    if (!e) return null;
    try {
      const videoEngine = e.getDomain<VideoEngine>('video');
      const extras = videoEngine.read(id, 'extras') as BloodHandleExtras | undefined;
      return extras ?? null;
    } catch {
      return null;
    }
  }

  async function tryLoad(): Promise<void> {
    const extras = getExtras();
    if (!extras) return;
    loadStatus = 'loading';
    const err = await extras.ensureLoaded();
    missing = extras.missingDataFiles();
    if (err) {
      loadStatus = 'error';
      loadError = err;
    } else {
      loadStatus = 'ready';
      loadError = null;
    }
  }

  // ---- Capture-phase keyboard routing (focused card only) ----
  function shouldClaimKey(): boolean {
    return selected === true && loadStatus === 'ready';
  }
  function onKeyDown(e: KeyboardEvent): void {
    if (!shouldClaimKey()) return;
    const sc = SCANCODE_FOR_KEYBOARD_CODE[e.code];
    if (sc === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    getExtras()?.pushKeyboardKey(e.code, true);
  }
  function onKeyUp(e: KeyboardEvent): void {
    if (!shouldClaimKey()) return;
    const sc = SCANCODE_FOR_KEYBOARD_CODE[e.code];
    if (sc === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    getExtras()?.pushKeyboardKey(e.code, false);
  }

  onMount(() => {
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
  });
  onDestroy(() => {
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('keyup', onKeyUp, true);
  });
</script>

<div class="blood-card" bind:this={cardEl} data-testid="blood-card" data-card-type="blood">
  <div class="stripe"></div>
  <ModuleTitle {id} {data} defaultLabel="BLOOD" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="body">
      {#if loadStatus === 'idle'}
        <button class="load" data-testid="blood-load" onclick={tryLoad}>Load BLOOD</button>
      {:else if loadStatus === 'loading'}
        <div class="status" data-testid="blood-loading">Loading…</div>
      {:else if loadStatus === 'ready'}
        <div class="status ok" data-testid="blood-ready">Running — click + use arrows/Ctrl/Space</div>
      {:else if loadStatus === 'error'}
        <div class="status err" data-testid="blood-error">
          {#if missing.length > 0}
            Blood data missing ({missing.join(', ')}).<br />
            Run <code>task setup:blood</code> with a copy you own.
          {:else}
            {loadError}
          {/if}
        </div>
      {/if}

      <div class="knob-row">
        <Knob value={audioGain} min={0} max={2} defaultValue={1} onchange={setAudioGain} label="Gain" />
      </div>
    </div>
  </PatchPanel>
</div>

<style>
  .blood-card {
    position: relative;
    min-width: 180px;
    background: #1a0606;
    border: 1px solid #401010;
    border-radius: 6px;
    color: #e8d0d0;
    font-size: 11px;
  }
  .stripe {
    height: 3px;
    background: var(--cable-video, #c33);
    border-radius: 6px 6px 0 0;
  }
  .body {
    padding: 6px 8px 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .load {
    cursor: pointer;
    background: #401010;
    color: #f0d0d0;
    border: 1px solid #602020;
    border-radius: 4px;
    padding: 4px 8px;
  }
  .status {
    font-size: 10px;
    line-height: 1.4;
  }
  .status.ok {
    color: #9fd;
  }
  .status.err {
    color: #f99;
  }
  .knob-row {
    display: flex;
    justify-content: center;
  }
  code {
    background: #2a0a0a;
    padding: 0 3px;
    border-radius: 3px;
  }
</style>
