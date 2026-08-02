<script lang="ts">
  // Dx7OpDetail — the operator detail panel (dx7 PR 6).
  //
  // Three rows (A PITCH / B ENVELOPE / C OUTPUT LEVEL) plus the PATCH-SAFETY
  // cluster in the header.
  //
  // ⚠ The safety cluster is NOT optional garnish. The edit buffer is the ONLY
  // copy of an edited voice: without STORE + a name, an edited voice can never
  // be saved or exported, and the next preset pick destroys it silently.
  //
  // Every write goes through `dx7-panel-actions`, which routes field edits via
  // `setOpField` so the DERIVED values (`ratio`, `fixedHz`, `detuneFactor`) are
  // recomputed. Writing `op.coarse` straight into the store would move the
  // pitch row and leave the engine playing the old ratio.

  import { patch } from '$lib/graph/store';
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
  import { dx7OpRole } from '$lib/audio/dx7-op-role';
  import { dx7LevelToDb, type DX7OpData } from '$lib/audio/dx7-syx';
  import Dx7EgEditor from './Dx7EgEditor.svelte';
  import { dx7FreqLabel } from './dx7-op-map-model';
  import {
    DX7_OP_COUNT,
    dx7CopyEgTo,
    dx7InitVoice,
    dx7PanelVoice,
    dx7RevertVoice,
    dx7SetOpField,
    dx7StoreVoice,
  } from './dx7-panel-actions';
  import { dx7IsDirty, dx7PresetName } from '$lib/ui/modules/dx7-patch-actions';
  import { dx7Selected } from './dx7-selection.svelte';

  interface Props {
    nodeId: string;
  }

  let { nodeId }: Props = $props();

  /** Shared with Dx7OperatorMap — see dx7-selection.svelte.ts for why this is
   *  NOT in `node.data` (a rack-mate's click must not yank your panel). */
  let selected = $derived(dx7Selected(nodeId));

  let storeName = $state('');
  let storeError = $state('');

  let node = $derived.by(() => {
    void nodeVersion(nodeId);
    return patch.nodes[nodeId];
  });
  let voice = $derived(dx7PanelVoice(node));
  let algo = $derived(Math.round(Number(node?.params?.algorithm ?? voice?.algorithm ?? 5)));
  // Typed as the REAL operator shape, not an index signature: every field
  // here is optional on purpose (a rack saved before PR 3 has no coarse/fine).
  let op = $derived((voice?.operators?.[selected] ?? {}) as Partial<DX7OpData>);
  let role = $derived(dx7OpRole(algo, selected)?.role ?? 'modulator');
  let dirty = $derived(dx7IsDirty(node));
  let presetName = $derived(dx7PresetName(node));

  let rates = $derived(op.r ?? [0, 0, 0, 0]);
  let levels = $derived(op.l ?? [0, 0, 0, 0]);
  let outLevel = $derived(Number(op.level ?? 99));

  // The other five operators, for the ghost curves.
  let ghosts = $derived(
    (voice?.operators ?? [])
      .map((o, i) => ({ o: o as Partial<DX7OpData>, i }))
      .filter(({ i }) => i !== selected)
      .map(({ o }) => ({ r: o?.r ?? [], l: o?.l ?? [], level: 99 })),
  );

  const set = (field: Parameters<typeof dx7SetOpField>[2]) => (v: number) =>
    dx7SetOpField(nodeId, selected, field, v);

  function commitEg(index: number, rate: number, level: number) {
    dx7SetOpField(nodeId, selected, `r${index}` as never, rate);
    dx7SetOpField(nodeId, selected, `l${index}` as never, level);
  }

  function doStore() {
    storeError = '';
    if (!dx7StoreVoice(nodeId, storeName)) {
      storeError = storeName.trim() ? 'name already used' : 'name required';
      return;
    }
    storeName = '';
  }

  /** DETUNE is stored 0..14 and DISPLAYED signed -7..+7 — the DX7's own
   *  convention. Showing the raw byte would read as "detune 7" for centred. */
  let detuneDisplay = $derived(Number(op.detune ?? 7) - 7);
</script>

<div class="op-detail" data-testid="dx7-op-detail">
  <header class="hdr">
    <span class="op-name">OP {selected + 1}</span>
    <span class="role" data-role={role}>{role}</span>

    <span class="spacer"></span>

    <!-- PATCH SAFETY. `dx7PresetChipLabel` is deliberately NOT `dx7PresetName`
         — the selector binds that same reader and appending ✱ would make it
         match no <option>. -->
    <span class="chip" class:dirty data-testid="dx7-dirty-chip">
      {presetName}{dirty ? ' ✱' : ''}
    </span>
    <button type="button" data-testid="dx7-revert" disabled={!dirty} onclick={() => dx7RevertVoice(nodeId)}>
      REVERT
    </button>
    <input
      class="store-name"
      type="text"
      maxlength="10"
      placeholder="name"
      aria-label="new patch name"
      data-testid="dx7-store-name"
      bind:value={storeName}
    />
    <button type="button" data-testid="dx7-store" onclick={doStore}>STORE</button>
    <button type="button" data-testid="dx7-init" onclick={() => dx7InitVoice(nodeId)}>INIT</button>
  </header>

  {#if storeError}
    <p class="err" role="alert" data-testid="dx7-store-error">{storeError}</p>
  {/if}

  <!-- A · PITCH -->
  <section class="row">
    <h4>A · PITCH</h4>
    <div class="fields">
      <label>COARSE
        <input type="number" min="0" max="31" data-testid="dx7-op-coarse"
          value={Number(op.coarse ?? 1)}
          oninput={(e) => set('coarse')(Number(e.currentTarget.value))} />
      </label>
      <label>FINE
        <input type="number" min="0" max="99" data-testid="dx7-op-fine"
          value={Number(op.fine ?? 0)}
          oninput={(e) => set('fine')(Number(e.currentTarget.value))} />
      </label>
      <label>DETUNE
        <input type="number" min="-7" max="7" data-testid="dx7-op-detune"
          value={detuneDisplay}
          oninput={(e) => set('detune')(Number(e.currentTarget.value) + 7)} />
      </label>
      <!-- The RESOLVED readout. Raw coarse/fine is never shown alone — on this
           synth those bytes mean nothing without the ratio they produce. -->
      <span class="resolved" data-testid="dx7-op-resolved">{dx7FreqLabel(op)}</span>
    </div>
  </section>

  <!-- B · ENVELOPE -->
  <section class="row">
    <h4>B · ENVELOPE</h4>
    <Dx7EgEditor r={rates} l={levels} {ghosts} oncommit={commitEg} />
    <div class="eg-nums">
      {#each [0, 1, 2, 3] as i (i)}
        <span class="pair">
          <em>R{i + 1}</em><b data-testid="dx7-eg-r{i + 1}">{rates[i] ?? 0}</b>
          <em>L{i + 1}</em><b data-testid="dx7-eg-l{i + 1}">{levels[i] ?? 0}</b>
        </span>
      {/each}
      <label class="copy">COPY EG →
        <select
          data-testid="dx7-copy-eg"
          onchange={(e) => {
            const to = Number(e.currentTarget.value);
            if (Number.isInteger(to)) dx7CopyEgTo(nodeId, selected, to);
            e.currentTarget.selectedIndex = 0;
          }}
        >
          <option value="">op…</option>
          {#each Array.from({ length: DX7_OP_COUNT }, (_, i) => i).filter((i) => i !== selected) as i (i)}
            <option value={i}>OP {i + 1}</option>
          {/each}
        </select>
      </label>
    </div>
  </section>

  <!-- C · OUTPUT LEVEL -->
  <section class="row">
    <h4>C · OUTPUT LEVEL</h4>
    <div class="fields">
      <input class="lvl" type="range" min="0" max="99" data-testid="dx7-op-level"
        aria-label="output level"
        value={outLevel}
        oninput={(e) => set('level')(Number(e.currentTarget.value))} />
      <span class="resolved" data-testid="dx7-op-level-db">
        {outLevel} · {dx7LevelToDb(outLevel).toFixed(1)} dB
      </span>
    </div>
  </section>
</div>

<style>
  .op-detail {
    width: 100%;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 11px;
  }
  .hdr {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .op-name {
    font-weight: 700;
    letter-spacing: 0.06em;
  }
  .role {
    font-size: 9px;
    text-transform: uppercase;
    padding: 1px 5px;
    border-radius: 8px;
    border: 1px solid currentColor;
  }
  .role[data-role='carrier'] { color: var(--dx7-carrier, #f0a35e); }
  .role[data-role='modulator'] { color: var(--dx7-modulator, #5ec8f0); }
  .role[data-role='both'] { color: var(--dx7-both, #b98ef0); }
  .spacer { flex: 1 1 auto; }

  .chip {
    font-family: var(--mono, ui-monospace, monospace);
    font-size: 10px;
    color: var(--text-dim, #8a9099);
  }
  .chip.dirty { color: var(--accent, #6cf); }

  button,
  .store-name,
  select {
    font: inherit;
    font-size: 10px;
    background: var(--module-bg-raised, #1b2027);
    color: var(--text, #e6e9ee);
    border: 1px solid var(--border, #2c3037);
    border-radius: 3px;
    padding: 2px 6px;
  }
  button:disabled { opacity: 0.4; cursor: not-allowed; }
  .store-name { width: 72px; }
  .err { margin: 0; color: var(--danger, #f0685e); font-size: 10px; }

  .row { display: flex; flex-direction: column; gap: 4px; }
  h4 {
    margin: 0;
    font-size: 9px;
    letter-spacing: 0.08em;
    color: var(--text-dim, #8a9099);
    text-transform: uppercase;
  }
  .fields { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  label { display: inline-flex; align-items: center; gap: 4px; font-size: 9px; letter-spacing: 0.06em; }
  input[type='number'] {
    width: 48px;
    font: inherit;
    font-size: 10px;
    background: var(--module-bg-deep, #0a0c0f);
    color: var(--text, #e6e9ee);
    border: 1px solid var(--border, #2c3037);
    border-radius: 3px;
    padding: 1px 4px;
  }
  .resolved {
    font-family: var(--mono, ui-monospace, monospace);
    font-size: 12px;
    color: var(--accent, #6cf);
  }
  .lvl { flex: 1 1 160px; }

  .eg-nums { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .pair { display: inline-flex; gap: 3px; align-items: baseline; }
  .pair em {
    font-style: normal;
    font-size: 8px;
    color: var(--text-dim, #8a9099);
  }
  .pair b {
    font-family: var(--mono, ui-monospace, monospace);
    font-size: 10px;
    font-weight: 500;
  }
  .copy { margin-left: auto; font-size: 9px; }
</style>
