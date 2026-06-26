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
  import {
    setInjectedBloodData,
    BLOOD_REQUIRED_FILES,
    type BloodDataFile,
  } from '$lib/blood/blood-runtime';
  import {
    getBloodFiles,
    putBloodFiles,
    canonicalBloodName,
  } from '$lib/blood/blood-data-store';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import ModuleTitle from './ModuleTitle.svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';

  let { id, data, selected }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  let cardEl: HTMLDivElement | null = $state(null);
  let fileInputEl: HTMLInputElement | null = $state(null);
  let loadStatus = $state<'idle' | 'loading' | 'ready' | 'error'>('idle');
  let loadError = $state<string | null>(null);
  let missing = $state<string[]>([]);
  // Names of in-browser data files currently injected (picked or IDB-restored).
  let loadedDataNames = $state<string[]>([]);
  let importing = $state(false);

  const REQUIRED = [...BLOOD_REQUIRED_FILES];

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

  // ---- In-browser Blood data loading (the HOSTED-preview path) ----
  // The owner can't drop proprietary Blood data on the hosted server, so they
  // pick their own files here; we register the bytes with the runtime + cache
  // them in IndexedDB so they only pick ONCE.

  function registerInjected(files: BloodDataFile[]): void {
    setInjectedBloodData(files);
    loadedDataNames = files.map((f) => f.name.toUpperCase());
  }

  /** Auto-restore previously-picked data from IndexedDB (so a reload boots
   *  straight in). Returns true if any data was restored. */
  async function restoreFromIndexedDb(): Promise<boolean> {
    try {
      const stored = await getBloodFiles();
      if (stored.length === 0) return false;
      registerInjected(stored.map((f) => ({ name: f.name, bytes: f.bytes })));
      return true;
    } catch {
      return false;
    }
  }

  /** Handle the file picker selection: read each file → register + persist. */
  async function onFilesPicked(e: Event): Promise<void> {
    const input = e.target as HTMLInputElement;
    const fileList = input.files;
    if (!fileList || fileList.length === 0) return;
    importing = true;
    try {
      const picked: BloodDataFile[] = [];
      for (const file of Array.from(fileList)) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        picked.push({ name: canonicalBloodName(file.name), bytes });
      }
      // Persist for next reload, register with the runtime, then boot.
      await putBloodFiles(picked.map((f) => ({ name: f.name, bytes: f.bytes })));
      registerInjected(picked);
      // A prior attempt may have latched the data-missing result — reset so the
      // fresh data is actually used.
      getExtras()?.resetLoad();
      await tryLoad();
    } finally {
      importing = false;
      // Allow re-picking the same file/folder later.
      if (input) input.value = '';
    }
  }

  function openPicker(): void {
    fileInputEl?.click();
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
    // Boot OUT-OF-BOX: first try any previously-picked FULL-game data from
    // IndexedDB (so a reload doesn't make the owner re-pick), otherwise fall
    // straight through to the BUNDLED 1997 shareware data committed under
    // static/blood/ — either way tryLoad() boots the engine without a picker.
    // The "Load full Blood data…" picker stays as an optional OVERRIDE.
    void (async () => {
      await restoreFromIndexedDb();
      await tryLoad();
    })();
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
      <!-- Hidden picker: `multiple` for file-by-file, `webkitdirectory` so the
           owner can point at a whole Blood folder in one go. -->
      <input
        bind:this={fileInputEl}
        class="file-input"
        type="file"
        multiple
        webkitdirectory
        data-testid="blood-data-input"
        onchange={onFilesPicked}
      />

      {#if loadStatus === 'idle'}
        <!-- Boots out-of-box from the bundled shareware; this is just a manual
             kick if auto-boot hasn't fired yet. -->
        <button class="load" data-testid="blood-load" onclick={tryLoad}>Boot BLOOD</button>
        <button class="load alt" data-testid="blood-pick-data" onclick={openPicker}>
          Load full Blood data (optional)…
        </button>
      {:else if loadStatus === 'loading'}
        <div class="status" data-testid="blood-loading">{importing ? 'Reading data…' : 'Loading…'}</div>
      {:else if loadStatus === 'ready'}
        <div class="status ok" data-testid="blood-ready">Running — click + use arrows/Ctrl/Space</div>
      {:else if loadStatus === 'error'}
        {#if loadError && loadError.includes('WASM not built')}
          <!-- (1) engine/wasm missing — a clear, actionable message. -->
          <div class="status err" data-testid="blood-error">
            BLOOD engine not built. The hosted build ships <code>blood.js</code> +
            <code>blood.wasm</code>; if you see this locally, run
            <code>BLOOD_LINK=1 bash packages/web/native/build-blood-wasm.sh</code>.
          </div>
        {:else if missing.length > 0}
          <!-- (2) bundled shareware unexpectedly absent (should not happen on a
               normal deploy) — friendly picker prompt, not a raw error. -->
          <div class="status err" data-testid="blood-error">
            <div class="data-prompt" data-testid="blood-data-missing">
              Couldn't load the bundled Blood data ({REQUIRED.join(', ')}). You can
              load your own copy ({REQUIRED.join(', ')}, plus <code>*.ART</code>/<code>*.DAT</code>) —
              pick the files, or your whole Blood folder, from a copy you own.
            </div>
            <button class="load" data-testid="blood-pick-data" onclick={openPicker} disabled={importing}>
              {importing ? 'Reading…' : 'Load full Blood data…'}
            </button>
          </div>
        {:else}
          <div class="status err" data-testid="blood-error">
            {loadError}
            <button class="load alt" data-testid="blood-pick-data" onclick={openPicker}>
              Load full Blood data…
            </button>
          </div>
        {/if}
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
  .load.alt {
    background: #2a0c0c;
  }
  .load:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .file-input {
    display: none;
  }
  .data-prompt {
    margin-bottom: 4px;
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
