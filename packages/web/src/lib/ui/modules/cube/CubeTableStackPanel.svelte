<script lang="ts">
  // CubeTableStackPanel — the THREE wavetable slots as one panel.
  //
  // ⚠ WHY IT EXISTS AT ALL. The legacy card spends NINE controls on THREE
  // decisions: per slot a factory `<select>`, a preset `<select>` and a file
  // LOAD. The second dropdown is not a second decision — it is a workaround for
  // a Svelte binding (a controlled `<select>` whose bound value never changes
  // will not re-fire `change`), and it leaks into the UI as a permanently blank
  // `— preset —` box per slot. One roster per slot plus one LOAD is the same
  // reach in a third of the widgets.
  //
  // ⚠ AND WHY IT IS A PICTURE. The three tables are the only place cube can
  // still hurt itself by arithmetic: the field is
  // `(1−m)·occ(z, floorH, wallH) + m·occ(z, ceilH, wallH)`, so floor ≡ ceiling
  // kills MORPH, and either connector's slot coinciding with WALL sends `occ`
  // into its degenerate hard-step branch and kills CONNECT + CONNECT STRENGTH
  // outright (bit-exactly — `maxAbsDiff` 0.000e+0). The shipped defaults are
  // three DISTINCT tables and nothing is dead, but a player is one dropdown
  // away from re-creating it, and a warning that only appears once it has
  // happened is worth more than a sentence in the docs. So the panel draws each
  // slot's heightfield AND says which control the current assignment has
  // silenced, if any.
  //
  // ⚠ NO `control-<paramId>` TESTID (shell-cells rule 1) — the slots are
  // `node.data`, not params, which is exactly why they need a panel rather than
  // a cell.

  import { patch } from '$lib/graph/store';
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
  import { getFactoryTables } from '$lib/audio/wavetable-factory-tables';
  import { WAVETABLE_PRESETS } from '$lib/audio/wavetable-presets';
  import { type CubeSlot } from '$lib/audio/modules/cube';
  import {
    CUBE_WAV_ACCEPT,
    cubeSlotFrames,
    cubeSlotLabel,
    cubeSlotSource,
    loadCubeWavFile,
    selectCubeFactoryTable,
    selectCubePreset,
  } from './cube-table-actions';

  interface Props {
    nodeId: string;
  }
  let { nodeId }: Props = $props();

  let live = $derived.by(() => ({ v: nodeVersion(nodeId), n: patch.nodes[nodeId] }));

  const SLOT_LABEL: Record<CubeSlot, string> = { floor: 'FLOOR', wall: 'WALL', ceiling: 'CEILING' };
  const factoryTables = getFactoryTables();

  let slotStatus = $state<Record<CubeSlot, string | null>>({ floor: null, wall: null, ceiling: null });
  let presetSelection = $state<Record<CubeSlot, string>>({ floor: '', wall: '', ceiling: '' });

  /** ⚠ CEILING is drawn FIRST — the panel is a picture of a STACK, and the
   *  ceiling is at the top of it. Reading order matches the geometry. */
  const DRAW_ORDER: CubeSlot[] = ['ceiling', 'wall', 'floor'];

  let sources = $derived.by<Record<CubeSlot, string>>(() => {
    void live.v;
    return {
      floor: cubeSlotSource(live.n, 'floor'),
      wall: cubeSlotSource(live.n, 'wall'),
      ceiling: cubeSlotSource(live.n, 'ceiling'),
    };
  });

  /**
   * WHICH CONTROL THE CURRENT ASSIGNMENT HAS SILENCED, named.
   *
   * A coincidence is a source-string equality, so it is exact — no threshold,
   * no measurement. The three consequences are the three branches of the field
   * expression, not a heuristic.
   */
  let collision = $derived.by<string | null>(() => {
    const s = sources;
    if (s.floor === s.ceiling) return 'FLOOR = CEILING → MORPH is inert';
    if (s.floor === s.wall && s.ceiling === s.wall) return 'ALL THREE MATCH → CONNECT is dead';
    if (s.floor === s.wall) return 'FLOOR = WALL → CONNECT is dead at MORPH 0';
    if (s.ceiling === s.wall) return 'CEILING = WALL → CONNECT is dead at MORPH 1';
    return null;
  });

  /** A slot's first frame as an SVG polyline — the heightfield the field stacks.
   *  SVG rather than a canvas so the dock VRT scene stays deterministic with no
   *  mask (the MacrooscillatorHeroPanel precedent). */
  const STRIP_W = 108;
  const STRIP_H = 20;
  const STRIP_COLS = 54;
  function stripPoints(slot: CubeSlot): string {
    void live.v;
    // ⚠ THROUGH THE MEMO — `resolveSlotFrames` copies every frame, and this
    // runs per slot on every re-render, i.e. on every tick of any knob.
    const f = cubeSlotFrames(live.n, slot)[0];
    if (!f || f.length === 0) return '';
    const pts: string[] = [];
    for (let i = 0; i < STRIP_COLS; i++) {
      const v = f[Math.min(f.length - 1, Math.round((i / (STRIP_COLS - 1)) * (f.length - 1)))] ?? 0;
      const x = (i / (STRIP_COLS - 1)) * STRIP_W;
      const y = STRIP_H / 2 - v * (STRIP_H / 2) * 0.9;
      pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
    }
    return pts.join(' ');
  }

  function pick(slot: CubeSlot, factoryId: string): void {
    selectCubeFactoryTable(nodeId, slot, factoryId);
    slotStatus[slot] = null;
  }
  async function onPreset(slot: CubeSlot, ev: Event): Promise<void> {
    const v = (ev.target as HTMLSelectElement).value;
    if (!v) return;
    slotStatus[slot] = 'loading…';
    const r = await selectCubePreset(nodeId, slot, v);
    slotStatus[slot] = r.error ?? r.status;
    // Reset so the SAME preset can be picked again (re-fires `change`).
    presetSelection[slot] = '';
  }
  async function onFile(slot: CubeSlot, ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    slotStatus[slot] = 'parsing…';
    const r = await loadCubeWavFile(nodeId, slot, file);
    slotStatus[slot] = r.error ?? r.status;
    try { input.value = ''; } catch { /* */ }
  }
</script>

<div class="cube-table-stack" data-testid="cube-table-stack">
  {#each DRAW_ORDER as slot (slot)}
    <div class="slot">
      <div class="head">
        <span class="name">{SLOT_LABEL[slot]}</span>
        <span class="loaded" data-testid={`cube-stack-${slot}-label`}>{cubeSlotLabel(live.n, slot)}</span>
      </div>
      <div class="body">
        <svg class="strip" viewBox={`0 0 ${STRIP_W} ${STRIP_H}`} width={STRIP_W} height={STRIP_H} aria-hidden="true">
          <line x1="0" y1={STRIP_H / 2} x2={STRIP_W} y2={STRIP_H / 2} class="mid" />
          <polyline points={stripPoints(slot)} class="trace" />
        </svg>
        <div class="picks">
          {#each factoryTables as t, i (t.id)}
            <button
              type="button"
              class="pick"
              class:on={sources[slot] === `factory:${t.id}`}
              aria-pressed={sources[slot] === `factory:${t.id}`}
              data-testid={`cube-stack-${slot}-${i}`}
              title={`${SLOT_LABEL[slot]} → ${t.label}`}
              onclick={() => pick(slot, t.id)}
            >{t.label}</button>
          {/each}
        </div>
        <select
          class="preset"
          value={presetSelection[slot]}
          onchange={(ev) => onPreset(slot, ev)}
          data-testid={`cube-stack-${slot}-preset`}
          aria-label={`${SLOT_LABEL[slot]} preset wavetable`}
        >
          <option value="">— preset —</option>
          {#each WAVETABLE_PRESETS as p (p.id)}
            <option value={p.id}>{p.label}</option>
          {/each}
        </select>
        <label class="load" data-testid={`cube-stack-${slot}-load`}>
          <input type="file" accept={CUBE_WAV_ACCEPT} onchange={(ev) => onFile(slot, ev)} />
          <span>.WAV</span>
        </label>
      </div>
      {#if slotStatus[slot]}
        <span class="status">{slotStatus[slot]}</span>
      {/if}
    </div>
  {/each}
  <div class="verdict" class:bad={!!collision} data-testid="cube-stack-collision">
    {collision ?? 'three distinct tables — MORPH and both connectors are live'}
  </div>
</div>

<style>
  .cube-table-stack {
    display: flex; flex-direction: column; gap: 5px;
    font-family: var(--font-mono, monospace);
  }
  .slot { display: flex; flex-direction: column; gap: 2px; }
  .head { display: flex; gap: 6px; align-items: baseline; }
  .name { font-size: 0.55rem; letter-spacing: 0.06em; color: var(--text-dim, #9fb6c9); width: 54px; flex: none; }
  .loaded { font-size: 0.55rem; color: var(--text-faint, #7f93a6); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .body { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .strip { flex: none; background: #0a0c12; border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 3px; }
  .mid { stroke: rgba(255, 255, 255, 0.09); stroke-width: 1; }
  .trace { fill: none; stroke: #5ad1ff; stroke-width: 1.2; }
  .picks { display: flex; gap: 3px; flex-wrap: wrap; }
  .pick {
    font-family: inherit; font-size: 0.52rem; letter-spacing: 0.02em;
    padding: 2px 5px; border-radius: 3px; cursor: pointer;
    background: #1b1f29; color: #9fb6c9; border: 1px solid rgba(255, 255, 255, 0.14);
  }
  .pick.on { background: #1f5e74; color: #d9f4ff; border-color: #3a9cc0; }
  .preset {
    font-family: inherit; font-size: 0.55rem; min-width: 84px; max-width: 110px;
    background: #1b1f29; color: #ece8e2;
    border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 3px; padding: 1px 3px;
  }
  .load {
    display: inline-flex; align-items: center; cursor: pointer;
    font-size: 0.52rem; color: #9fb6c9;
    background: #1b1f29; border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: 3px; padding: 2px 5px;
  }
  .load input[type='file'] { display: none; }
  .load:hover { background: #232838; color: #d9f4ff; }
  .status { font-size: 0.5rem; color: #7fd6a0; }
  .verdict {
    font-size: 0.53rem; color: var(--text-faint, #7f93a6);
    border-top: 1px solid rgba(255, 255, 255, 0.08); padding-top: 4px;
  }
  .verdict.bad { color: #e0a13c; }
</style>
