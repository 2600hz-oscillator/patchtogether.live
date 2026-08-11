<script lang="ts">
  // WavesculptWavetableBay — the `wavesculpt-osc` control family, as ONE cell.
  //
  // ⚠ ONE CELL FOR FOUR VOICES, AND THAT IS NOT A COMPROMISE — IT IS THE
  // CONTRACT. `faces-parity` asserts the dock renders EXACTLY
  // `controlFamilies.length` cells with `data-cell-kind="family"`, and
  // `module-face-lint`'s dock render-plan parity asserts each declared family
  // renders exactly ONCE. The def declares `wavesculpt-osc` once, so the four
  // per-voice strips the legacy card draws as four separate columns are one
  // four-row bay here. The face spec's "put the family at the head of each
  // VOICE tab" is structurally impossible; this is the shape that is legal.
  //
  // It carries exactly what the card's strip carries MINUS the colour swatch:
  // `red_color`/`grn_color`/`blu_color` are real ParamDefs, and the faceplate
  // paints them through `face.paramCells: 'color'` inside their own voice
  // bands. Duplicating the picker here would emit a second writer for a param
  // that already has a cell — the "unbacked extra" that fails parity if it
  // carried a `control-` testid, and a silent second source of truth if it did
  // not. The bay shows each voice's TINT as a read-only dot so the row is still
  // identifiable at a glance.
  //
  // ⚠ THE TABLE STEPPER IS THE OPERABILITY PROBE, deliberately rather than a
  // view toggle. Every other hero panel in the repo probes a private caption
  // mode with a `text` witness (macro-hero-scale, bluebox-bank-label) because
  // it has no durable state to watch. This one does: stepping a voice's factory
  // table writes `node.data.osc{n}.wavetableSource`, which the factory's poll
  // loop turns into a real `loadWavetable` — so the probe proves the seam a
  // player actually uses, not that a label can relabel itself.
  //
  // Every write below mirrors `WavesculptCard`'s own paths byte for byte
  // (`node.data.osc{n}.{wavetableSource,wavetableFrames,wavetableLabel}`),
  // in place, never reassigning a live Y map.

  import { patch } from '$lib/graph/store';
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
  import type { ModuleNode } from '$lib/graph/types';
  import {
    unpackColor01,
    wavesculptDef,
    type WavesculptData,
    type WavesculptOscData,
  } from '$lib/audio/modules/wavesculpt';
  import {
    DEFAULT_FACTORY_TABLE_ID,
    framesToPlain,
    getFactoryTables,
  } from '$lib/audio/wavetable-factory-tables';
  import { parseE352Wav } from '$lib/audio/wavetable-parser';
  import { WAVETABLE_PRESETS, loadWavetablePreset } from '$lib/audio/wavetable-presets';
  import { WAVESCULPT_VOICES } from './wavesculpt-face-model';

  interface Props {
    nodeId: string;
  }
  let { nodeId }: Props = $props();

  let live = $derived.by(() => ({
    v: nodeVersion(nodeId),
    n: patch.nodes[nodeId] as ModuleNode | undefined,
  }));

  const tables = getFactoryTables();

  function oscData(i: number): WavesculptOscData {
    const d = (live.n?.data ?? {}) as WavesculptData;
    return (d[`osc${i + 1}` as keyof WavesculptData] as WavesculptOscData | undefined) ?? {};
  }

  function sourceOf(i: number): string {
    return oscData(i).wavetableSource ?? `factory:${DEFAULT_FACTORY_TABLE_ID}`;
  }

  /** The table name a voice is playing — a USER upload keeps its own label. */
  function tableLabel(i: number): string {
    const od = oscData(i);
    if (od.wavetableSource === 'user' && od.wavetableLabel) return od.wavetableLabel;
    const id = sourceOf(i).slice('factory:'.length);
    return tables.find((t) => t.id === id)?.label ?? tables[0]!.label;
  }

  /** Mutate one voice's data bag IN PLACE — never reassign `node.data`, which
   *  would drop a live Y map (the "Type already integrated" trap). */
  function withOsc(i: number, fn: (od: WavesculptOscData) => void): void {
    const t = patch.nodes[nodeId];
    if (!t) return;
    if (!t.data) t.data = {};
    const d = t.data as WavesculptData;
    const key = `osc${i + 1}` as keyof WavesculptData;
    if (!d[key]) (d as Record<string, unknown>)[key as string] = {};
    fn(d[key] as WavesculptOscData);
  }

  /** Step to the next/previous FACTORY table, wrapping. Stepping off a USER
   *  upload lands on the first factory table, which is the only honest
   *  interpretation of "next" from a table that is not in the list. */
  function stepTable(i: number, dir: 1 | -1): void {
    const cur = sourceOf(i);
    const at = cur.startsWith('factory:')
      ? tables.findIndex((t) => t.id === cur.slice('factory:'.length))
      : -1;
    const next = tables[(((at + dir) % tables.length) + tables.length) % tables.length]!;
    withOsc(i, (od) => {
      od.wavetableSource = `factory:${next.id}`;
      delete od.wavetableFrames;
      delete od.wavetableLabel;
    });
  }

  /** Jump straight to a factory table — the card's `<select>`, restored. The
   *  `user` option is a LABEL for the current upload, never a destination, so
   *  choosing it is a no-op rather than a write that would clear the frames. */
  function pickTable(i: number, value: string): void {
    if (!value.startsWith('factory:')) return;
    withOsc(i, (od) => {
      od.wavetableSource = value;
      delete od.wavetableFrames;
      delete od.wavetableLabel;
    });
  }

  let status = $state<Record<number, string | null>>({});
  let error = $state<Record<number, string | null>>({});
  let presetSel = $state<Record<number, string>>({});

  async function onPreset(i: number, ev: Event): Promise<void> {
    const id = (ev.target as HTMLSelectElement).value;
    if (!id) return;
    const preset = WAVETABLE_PRESETS.find((p) => p.id === id);
    if (!preset) return;
    error[i] = null;
    status[i] = `loading ${preset.label}…`;
    try {
      const parsed = await loadWavetablePreset(preset.url);
      withOsc(i, (od) => {
        od.wavetableSource = 'user';
        od.wavetableFrames = parsed.frames;
        od.wavetableLabel = preset.label;
      });
      status[i] = `${parsed.frames.length} frames`;
    } catch (err) {
      error[i] = err instanceof Error ? err.message : String(err);
      status[i] = null;
    } finally {
      presetSel[i] = '';
    }
  }

  async function onWav(i: number, ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    error[i] = null;
    status[i] = 'parsing…';
    try {
      const parsed = parseE352Wav(await file.arrayBuffer());
      withOsc(i, (od) => {
        od.wavetableSource = 'user';
        od.wavetableFrames = framesToPlain(parsed.frames);
        od.wavetableLabel = file.name.replace(/\.wav$/i, '').toUpperCase().slice(0, 24);
      });
      status[i] = `${parsed.frames.length} frames`;
    } catch (err) {
      error[i] = err instanceof Error ? err.message : String(err);
      status[i] = null;
    } finally {
      try {
        input.value = '';
      } catch {
        /* a detached input; nothing to clear */
      }
    }
  }

  /** The voice's tint, read-only — the writable picker is the `color` param
   *  cell in that voice's own band. */
  function voiceHex(i: number): string {
    const pid = WAVESCULPT_VOICES[i]?.colorParam;
    if (!pid) return '#e8ecf2';
    const raw = live.n?.params?.[pid];
    const packed =
      typeof raw === 'number' && Number.isFinite(raw)
        ? raw
        : (wavesculptDef.params.find((p) => p.id === pid)?.defaultValue ?? 0);
    const [r, g, b] = unpackColor01(packed);
    const ch = (v: number): string =>
      Math.max(0, Math.min(255, Math.round(v * 255)))
        .toString(16)
        .padStart(2, '0');
    return `#${ch(r)}${ch(g)}${ch(b)}`;
  }
</script>

<div class="ws-bay" data-testid="wavesculpt-bay">
  {#each WAVESCULPT_VOICES as v (v.idx)}
    <div class="row">
      <span class="dot" style="background: {voiceHex(v.idx)};" aria-hidden="true"></span>
      <span class="who">{v.label}</span>

      <span class="stepper">
        <button
          type="button"
          class="step"
          data-testid={`wavesculpt-bay-prev-${v.idx + 1}`}
          title={`Previous factory wavetable for ${v.label}`}
          aria-label={`Previous factory wavetable for ${v.label}`}
          onclick={() => stepTable(v.idx, -1)}>◀</button
        >
        <!-- ⚠ A SELECT, NOT A CAPTION. The legacy card gave every oscillator a
             full `<select>` over `getFactoryTables()` plus a `USER · <label>`
             entry, i.e. RANDOM ACCESS to any table; the first bay shipped a
             read-only name between two steppers, which is sequential-only and
             the one measured per-voice capability the face had lost against
             the card. The steppers stay — browsing a table set one at a time is
             the better gesture and the panel's `probe` presses `next-1` — but
             the name itself is now the jump. -->
        <select
          class="table"
          data-testid={`wavesculpt-bay-table-${v.idx + 1}`}
          value={sourceOf(v.idx)}
          aria-label={`Factory wavetable for ${v.label}`}
          onchange={(ev) => pickTable(v.idx, (ev.target as HTMLSelectElement).value)}
        >
          {#if sourceOf(v.idx) === 'user'}
            <!-- A user upload is not IN the factory roster, so it needs its own
                 entry or the select would silently read as the first table. -->
            <option value="user">USER · {tableLabel(v.idx)}</option>
          {/if}
          {#each tables as t (t.id)}
            <option value={`factory:${t.id}`}>{t.label}</option>
          {/each}
        </select>
        <button
          type="button"
          class="step"
          data-testid={`wavesculpt-bay-next-${v.idx + 1}`}
          title={`Next factory wavetable for ${v.label}`}
          aria-label={`Next factory wavetable for ${v.label}`}
          onclick={() => stepTable(v.idx, 1)}>▶</button
        >
      </span>

      <select
        class="preset"
        value={presetSel[v.idx] ?? ''}
        aria-label={`Wavetable preset for ${v.label}`}
        data-testid={`wavesculpt-bay-preset-${v.idx + 1}`}
        onchange={(ev) => onPreset(v.idx, ev)}
      >
        <option value="">preset…</option>
        {#each WAVETABLE_PRESETS as p (p.id)}
          <option value={p.id}>{p.label}</option>
        {/each}
      </select>

      <label class="load" data-testid={`wavesculpt-bay-load-${v.idx + 1}`}>
        <input type="file" accept=".wav,audio/wav" onchange={(ev) => onWav(v.idx, ev)} />
        <span>.WAV</span>
      </label>

      <span class="note" data-testid={`wavesculpt-bay-note-${v.idx + 1}`}>
        {#if error[v.idx]}<em class="err">{error[v.idx]}</em>{:else if status[v.idx]}{status[
            v.idx
          ]}{/if}
      </span>
    </div>
  {/each}
</div>

<style>
  .ws-bay {
    width: 100%;
    display: grid;
    gap: 3px;
  }

  .row {
    display: grid;
    grid-template-columns: 8px 42px minmax(96px, 1fr) 66px 40px minmax(0, 60px);
    align-items: center;
    gap: 4px;
  }

  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    box-shadow: 0 0 0 1px rgb(0 0 0 / 0.5);
  }

  .who,
  .table,
  .note {
    font: 600 9px/1 var(--font-mono, ui-monospace, monospace);
    letter-spacing: 0.04em;
    color: rgb(255 255 255 / 0.72);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .note {
    font-weight: 500;
    color: rgb(255 255 255 / 0.45);
  }
  .err {
    color: rgb(255 140 140 / 0.9);
    font-style: normal;
  }

  .stepper {
    display: grid;
    grid-template-columns: 14px 1fr 14px;
    align-items: center;
    gap: 2px;
    background: rgb(255 255 255 / 0.04);
    border: 1px solid rgb(255 255 255 / 0.1);
    border-radius: 2px;
    padding: 2px 3px;
  }
  .table {
    text-align: center;
    background: none;
    border: 0;
    padding: 0;
    min-width: 0;
    cursor: pointer;
  }
  .table:hover {
    color: rgb(255 255 255 / 0.95);
  }

  .step {
    font: 600 8px/1 var(--font-mono, ui-monospace, monospace);
    color: rgb(255 255 255 / 0.6);
    background: none;
    border: 0;
    padding: 2px 0;
    cursor: pointer;
  }
  .step:hover {
    color: rgb(255 255 255 / 0.95);
  }

  .preset {
    font: 500 9px/1 var(--font-mono, ui-monospace, monospace);
    color: rgb(255 255 255 / 0.7);
    background: rgb(255 255 255 / 0.05);
    border: 1px solid rgb(255 255 255 / 0.12);
    border-radius: 2px;
    padding: 2px 3px;
    min-width: 0;
  }

  .load {
    font: 600 8.5px/1 var(--font-mono, ui-monospace, monospace);
    letter-spacing: 0.04em;
    color: rgb(255 255 255 / 0.62);
    background: rgb(255 255 255 / 0.05);
    border: 1px solid rgb(255 255 255 / 0.12);
    border-radius: 2px;
    padding: 3px 0;
    text-align: center;
    cursor: pointer;
  }
  .load:hover {
    color: rgb(255 255 255 / 0.92);
  }
  .load input {
    display: none;
  }
</style>
