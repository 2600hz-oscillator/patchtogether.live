<script lang="ts">
  // WarrensspectrumBankPanel — the 8-band FILTERBANK, as a PF-14 panel cell.
  //
  // ⚠ THIS PANEL IS WHY THE MODULE CAN BE PROMOTED AT ALL. The bank's five
  // per-band values live in `node.data.wsBands`, NOT in ParamDefs (8 × 5 would
  // be 40 params, 40 doc blobs and 40 face cells — the module's own plan §5.3
  // calls one addressable strip "the only honest way to fit this module"). So
  // the bank has exactly one editor, and before this file that editor was
  // `WarrensspectrumCard.svelte`. Promotion REMOVES the card from both
  // surfaces (`migrated(type)` swaps the dock full-view for <ModuleShell>), so
  // shipping the face without this panel would have made the filterbank
  // unreachable — the samsloop failure, on a module that has a live bank.
  //
  // ⚠ IT EMITS NO `control-<paramId>` TESTID (shell-cells PANEL rule 1).
  // faces-parity asserts EXACT MULTISET EQUALITY between the dock's `control-*`
  // testids and the def's param ids, and `Fader` emits `control-${paramId}`
  // whenever `paramId` is set — so the band faders here deliberately pass NO
  // `moduleId`/`paramId`. The cost is real and is the right trade: these five
  // controls lose MIDI-learn and the right-click control menu, which they could
  // never have had honestly anyway — MIDI-learn binds a (nodeId, paramId) pair
  // and `wsBand0-cutoffHz` is not a param, so the card's binding pointed at a
  // key no automation, CV or clip lane can reach.
  //
  // EVERY range, curve, unit and label comes from `WARRENSSPECTRUM_BAND_SPEC`
  // on the DEF — the same one-place-only source the card reads, so the panel
  // and the card cannot drift apart or away from the engine's clamps
  // (`card-range-source.test.ts` is about exactly this and does not exempt a
  // control for lacking a ParamDef).
  //
  // SELECTION IS LOCAL `$state`, deliberately NOT in `node.data` — the dx7
  // operator-map rule. A rack-mate clicking band 6 must not yank your panel.

  import { patch } from '$lib/graph/store';
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
  import { mutateNode } from '$lib/graph/mutate';
  import NeonFader from '$lib/ui/controls/NeonFader.svelte';
  import {
    WARRENSSPECTRUM_BAND_SPEC,
    WARRENSSPECTRUM_BANDS_KEY,
    WARRENSSPECTRUM_BANDS_REV_KEY,
    warrensspectrumBands,
    wsDefaultBands,
    type WsBandSettings,
  } from '$lib/audio/modules/warrensspectrum';

  interface Props {
    nodeId: string;
  }
  let { nodeId }: Props = $props();

  /** ⚠ THE VERSION IS CARRIED IN THE RESULT (the ModuleShell `liveCell`
   *  pattern, as RingsCombPanel documents). `patch.nodes[id]` is a stable
   *  SyncedStore proxy, so a `$derived` that bumps on `nodeVersion(id)` and
   *  returns it BARE is `===` to its previous value and the picture freezes at
   *  first render. */
  let live = $derived.by(() => ({ v: nodeVersion(nodeId), n: patch.nodes[nodeId] }));

  let bands = $derived(warrensspectrumBands(live.n));
  let selected = $state(0);
  let sel = $derived(bands[selected] ?? bands[0]!);

  /** BANK WET is a PARAM, so it is read the param way. At 0 the whole bank is
   *  out of circuit — `finishSample` takes an early return that never touches
   *  the eight SVFs — which is the module's one divergence from the VST that is
   *  about OUR history (a rack saved before the bank existed must not be
   *  re-voiced). The panel says so rather than letting a player move eight
   *  bands against silence. */
  let wet = $derived.by(() => {
    const v = live.n?.params?.resynthLevel;
    return typeof v === 'number' ? v : 0;
  });
  let inCircuit = $derived(wet > 0);

  /** Write one band field and bump the revision the factory polls. The whole
   *  table goes through `warrensspectrumBands` on the way out, so what lands in
   *  the Y.Doc is always a complete normalized 8 rather than a sparse patch —
   *  the same seam the card uses, so there is one write path and not two. */
  function setBand(i: number, patchIn: Partial<WsBandSettings>): void {
    const next = warrensspectrumBands(patch.nodes[nodeId]).map((b, k) =>
      k === i ? { ...b, ...patchIn } : { ...b },
    );
    mutateNode(nodeId, (liveNode) => {
      if (!liveNode.data) liveNode.data = {};
      liveNode.data[WARRENSSPECTRUM_BANDS_KEY] = next;
      // The counter is what the factory watches: a deep mutation inside the
      // array is invisible to a poll on the array identity, and a REMOTE peer's
      // edit fires no local callback at all.
      liveNode.data[WARRENSSPECTRUM_BANDS_REV_KEY] =
        Number(liveNode.data[WARRENSSPECTRUM_BANDS_REV_KEY] ?? 0) + 1;
    });
  }

  const spec = WARRENSSPECTRUM_BAND_SPEC;
  const FIELDS = ['cutoffHz', 'q', 'type', 'pan', 'send'] as const;
  /** Per-band DEFAULTS differ (cutoffs log-spaced, type HP/BP/LP by position),
   *  so a double-click reset must restore THIS band's default. */
  const defaults = wsDefaultBands();

  const hz = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(Math.round(v)));
  /** LP → BP → HP is a continuous morph, so the word is the nearest landmark. */
  const typeWord = (v: number) => (v < 0.25 ? 'LP' : v < 0.75 ? 'BP' : 'HP');
  const panWord = (v: number) =>
    Math.abs(v) < 0.02 ? 'C' : `${v < 0 ? 'L' : 'R'}${Math.round(Math.abs(v) * 100)}`;
</script>

<div class="ws-bank" class:live={inCircuit} data-testid="ws-bank-panel">
  <!-- THE CAPTION is the panel's state witness: which band the faders below are
       addressing, and whether the bank is audible at all. Plain labels and
       values — no prose (owner ruling 2026-08-11). -->
  <div class="cap" data-testid="ws-bank-caption">
    <span class="band-n">band {selected + 1}</span>
    <span class="sep">·</span>
    <span>{hz(sel.cutoffHz)} Hz</span>
    <span class="sep">·</span>
    <span>{typeWord(sel.type)}</span>
    <span class="sep">·</span>
    <span>{panWord(sel.pan)}</span>
    <span class="state" data-testid="ws-bank-state">{inCircuit ? 'in circuit' : 'bypassed'}</span>
  </div>

  <div class="strip" role="group" aria-label="filterbank bands">
    {#each bands as b, i (i)}
      <button
        type="button"
        class="cell"
        class:sel={i === selected}
        class:muted={b.send <= 0}
        data-testid={`ws-bank-cell-${i + 1}`}
        aria-pressed={i === selected}
        aria-label={`band ${i + 1}, ${Math.round(b.cutoffHz)} Hz, ${typeWord(b.type)}`}
        onclick={() => (selected = i)}
      >
        <!-- Bar height = SEND (the band's level into the main bus, and its
             on/off: at 0 the band is SKIPPED entirely). Pure geometry off the
             saved table — no analyser, no clock, so the picture is
             deterministic on a silent rack and on a running one alike. -->
        <span class="bar" style={`height:${(3 + b.send * 22).toFixed(2)}px`}></span>
        <span class="hz">{hz(b.cutoffHz)}</span>
      </button>
    {/each}
  </div>

  <div class="faders">
    {#each FIELDS as f (f)}
      <!-- The wrapper carries the testid; the Fader itself carries NONE (see
           the header). `ws-bank-fader-send` is the declared operability probe. -->
      <div class="fader" data-testid={`ws-bank-fader-${f}`}>
        <NeonFader
          value={sel[f]}
          min={spec[f].min}
          max={spec[f].max}
          defaultValue={defaults[selected]![f]}
          label={spec[f].label}
          units={spec[f].units}
          curve={spec[f].curve}
          onchange={(v: number) => setBand(selected, { [f]: v })}
        />
      </div>
    {/each}
  </div>
</div>

<style>
  .ws-bank {
    display: flex;
    flex-direction: column;
    gap: 4px;
    width: 100%;
    /* Out of circuit the bank is not merely quiet — `finishSample` returns
       before it — so the panel is dimmed rather than pretending. */
    opacity: 0.5;
  }
  .ws-bank.live { opacity: 1; }
  .cap {
    display: flex;
    align-items: baseline;
    gap: 4px;
    font-size: 0.58rem;
    letter-spacing: 0.06em;
    color: var(--text-muted, #999);
    white-space: nowrap;
  }
  .cap .band-n { color: var(--cable-audio, #d97); }
  .cap .sep { opacity: 0.4; }
  .cap .state { margin-left: auto; font-size: 0.52rem; }
  .ws-bank.live .cap .state { color: var(--cable-audio, #d97); }
  .strip {
    display: flex;
    gap: 3px;
  }
  .cell {
    flex: 1 1 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: flex-end;
    gap: 2px;
    height: 38px;
    padding: 2px 0 1px;
    background: var(--surface-sunken, #1a1a1a);
    border: 1px solid var(--border-subtle, #333);
    border-radius: 3px;
    cursor: pointer;
  }
  .cell.sel { border-color: var(--cable-audio, #d97); }
  .cell.muted .bar { background: var(--border-subtle, #333); }
  .bar {
    width: 55%;
    background: var(--cable-audio, #d97);
    border-radius: 1px;
  }
  .hz {
    font-size: 0.5rem;
    line-height: 1;
    color: var(--text-muted, #999);
  }
  .faders {
    display: flex;
    justify-content: space-between;
    gap: 6px;
  }
  .fader { display: flex; }
</style>
