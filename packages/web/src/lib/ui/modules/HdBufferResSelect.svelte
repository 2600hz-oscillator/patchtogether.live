<script lang="ts">
  // HdBufferResSelect — the per-module heavy-buffer RES dropdown for the four
  // hungry video modules (TOYBOX history ring, b3ntb0x oversample, VDELAY ring,
  // BACKDRAFT ring). SD / 720p / 1080p; 720p+1080p are DISABLED unless the
  // global HD toggle (hdStore) is ON locally ("system in SD mode"), matching
  // hd-toggle plan §4.5.
  //
  // The value is a normal module param (bufferRes: 0=SD/1=720/2=1080) so it
  // travels with the patch + is e2e-addressable. It's read at engine
  // construction, so a change takes effect on the next engine rebuild (toggle HD
  // or re-add the node) — we surface that with a hint title.
  import { hdStore } from '$lib/ui/hd-store.svelte';
  import {
    BUFFER_RES_SD,
    BUFFER_RES_720,
    BUFFER_RES_1080,
  } from '$lib/video/buffer-res';

  let {
    value,
    onchange,
    moduleId,
  }: {
    value: number;
    onchange: (v: number) => void;
    moduleId: string;
  } = $props();

  let hdOn = $derived(hdStore.on);

  function onSelect(e: Event) {
    const v = Number((e.currentTarget as HTMLSelectElement).value);
    onchange(v);
  }
</script>

<label class="hd-res" title={hdOn
  ? 'Internal heavy-buffer resolution for this module. Takes effect on the next engine rebuild (toggle HD or re-add the node).'
  : 'Heavy-buffer resolution. 720p/1080p require global HD ON (the HD pill in the topbar).'}>
  <span class="hd-res-label">RES</span>
  <select
    class="hd-res-select"
    data-testid="hd-buffer-res-{moduleId}"
    value={String(value)}
    onchange={onSelect}
  >
    <option value={String(BUFFER_RES_SD)}>SD</option>
    <option value={String(BUFFER_RES_720)} disabled={!hdOn}>720p</option>
    <option value={String(BUFFER_RES_1080)} disabled={!hdOn}>1080p</option>
  </select>
</label>

<style>
  .hd-res {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    font-size: 0.65rem;
    color: var(--text-dim);
    letter-spacing: 0.04em;
  }
  .hd-res-label {
    font-weight: 700;
  }
  .hd-res-select {
    background: var(--surface-2);
    color: var(--text);
    border: 1px solid var(--border-strong);
    border-radius: 3px;
    font-size: 0.65rem;
    padding: 1px 3px;
    font-family: inherit;
  }
  .hd-res-select:focus-visible {
    outline: 1px solid var(--accent);
  }
</style>
