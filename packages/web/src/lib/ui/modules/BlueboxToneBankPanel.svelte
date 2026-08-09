<script lang="ts">
  // BlueboxToneBankPanel — the faceplate's HERO: the ten-slot TONE BANK, and
  // the five numbers about it.
  //
  // ⚠ NOT A TRACE, and not a spectrum analyser. Every bar and every number is
  // computed from the LIVE KEY STATE through the worklet's OWN frequency table
  // (`bluebox-face-model`), so it is the TARGET the bank is heading for rather
  // than a reading of what came out. That is the whole point: this module has no
  // oscillator per key. It has ONE fixed bank of ten sines, and a held key
  // RAISES the target amplitude of each frequency it lights
  // (`ampTarget[f] += BUTTON_VOICE_AMP`, packages/dsp/src/bluebox.ts). Two keys
  // that share a tone drive ONE bar twice as hard instead of running two
  // independent voices, which is why {1,4} is 1.76 dB louder than {1,5}. There
  // is no other surface anywhere on which that is visible.
  //
  // ── ⚠ IT READS THE LIVE ENGINE, AND FOR THIS MODULE THAT IS THE ONLY HONEST
  //      SOURCE THERE IS ────────────────────────────────────────────────────
  //
  // Every faceplate panel in the repo before this one reads `node.params` (the
  // DURABLE value) — clap, kickdrum, analogVco all do, and `ModuleShell`'s
  // readouts are hard-wired to it. On bluebox that reader is not merely
  // incomplete, it is CONSTANT ZERO FOREVER, and it took a measurement to find
  // out. All twelve params are `face.momentary`, and:
  //
  //   * a faceplate press writes the ENGINE ONLY, never the Y.Doc
  //     ($lib/audio/momentary-params — a rack must not be saveable with a pad
  //     held down); and
  //   * a durable write from ANY other route — the group/instrument bar, a
  //     MIDI-learned CC, an automation lane, a preset recall, the legacy card —
  //     is SCRUBBED BACK TO REST within a frame, because ModuleShell runs
  //     `clearStuckMomentaryParams` in an `$effect` that reads `node.params`
  //     and therefore re-fires on every write. MEASURED: writing `btn_1 = 1`
  //     through `__ydoc.transact` reads back 0.
  //
  // So a durable-param reader on this module can only ever print `silent`. The
  // engine handle CAN see it — MEASURED through the real dock faceplate:
  // `readParam(node,'btn_1')` reads 0 before, **1 while the key is held**, and 0
  // after release. So the panel polls the engine, and the three derived numbers
  // live HERE rather than in `face.hero.readouts`: one source, one component,
  // never two readers disagreeing beside each other.
  //
  // ⚠ WHAT IT STILL CANNOT SEE, stated rather than hidden: a GATE CABLE. Those
  // twelve inputs are worklet NODE inputs, not AudioParam connections, so no
  // host-side reader reaches them — the bank stays dark while a patched gate
  // sounds the tone. That is irreducible without a worklet-side report.
  //
  // ⚠ THE PICTURE IS LEGIBLE ON A SILENT RACK, deliberately. Every bar carries
  // its frequency, its band tint and its CAPACITY outline — how many keys could
  // ever light it — so column 1336 reads as the tall one (2, 5, 8 and 0 all pull
  // it) before anything is held. A hero that is blank at rest teaches nothing.
  //
  // ⚠ THIS PANEL EMITS NO `control-<paramId>` TESTID (shell-cells rule 1). Its
  // one writable affordance is the CAPTION MODE, which is PRIVATE VIEW STATE
  // (component state, never `node.data`: relabelling your own picture must not
  // relabel every collaborator's screen or dirty the patch).

  import { patch } from '$lib/graph/store';
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import { fmtDb } from '$lib/audio/modules/kickdrum-format';
  import {
    BLUEBOX_MAX_SLOT_KEYS,
    blueboxBankBars,
    blueboxBarCaption,
    blueboxDecodeText,
    blueboxHeadroomDb,
    blueboxHeld,
    blueboxKeyCount,
    blueboxLevelDb,
    blueboxSlotCounts,
  } from './bluebox-face-model';
  import { BLUEBOX_BUTTON_NAMES, buttonParamId } from '$lib/audio/modules/bluebox';

  interface Props {
    nodeId: string;
  }
  let { nodeId }: Props = $props();

  const engineCtx = useEngine();

  /** ⚠ THE VERSION IS CARRIED IN THE RESULT (the ModuleShell `liveCell`
   *  pattern). `patch.nodes[id]` is a stable SyncedStore proxy, so a derived
   *  that bumps on `nodeVersion(id)` and returns it BARE is `===` to its
   *  previous value and the picture freezes at first render. */
  let live = $derived.by(() => ({ v: nodeVersion(nodeId), n: patch.nodes[nodeId] as ModuleNode | undefined }));

  /**
   * The twelve keys as a BITMASK, polled on rAF.
   *
   * A mask rather than a Set because the poll runs every frame and Svelte
   * re-renders on `!==`: an integer that only changes when a key actually
   * changes state means idle frames repaint nothing, which is the same
   * memoize-on-the-tuple discipline `createLiveWaveSource` uses for the glyph.
   */
  let heldMask = $state(0);

  function readMask(): number {
    const node = live.n;
    let mask = 0;
    BLUEBOX_BUTTON_NAMES.forEach((name, i) => {
      const pid = buttonParamId(name);
      // ENGINE FIRST, durable SECOND. With no engine booted (a dev render, an
      // ungated VRT scene) the durable value is the only thing there — and for
      // this module it is always rest, which is exactly the deterministic
      // picture those scenes want.
      //
      // TOTAL: this runs once per key per FRAME, so a throw here would take the
      // faceplate down and keep it down. `PatchEngine.readParam` resolves a
      // per-domain sub-engine off `node.domain` and throws if there is none —
      // reachable while a node is mid-spawn — so it is caught rather than
      // guarded against one known shape.
      let v: number | undefined;
      try {
        v = node ? (engineCtx.get()?.readParam(node, pid) ?? undefined) : undefined;
      } catch {
        v = undefined;
      }
      v ??= node?.params?.[pid];
      if (typeof v === 'number' && v >= 0.5) mask |= 1 << i;
    });
    return mask;
  }

  $effect(() => {
    let raf = 0;
    const tick = () => {
      const m = readMask();
      if (m !== heldMask) heldMask = m;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  });

  let held = $derived(
    new Set(BLUEBOX_BUTTON_NAMES.filter((_, i) => (heldMask & (1 << i)) !== 0)),
  );

  let bars = $derived(blueboxBankBars(held));
  let counts = $derived(blueboxSlotCounts(held));
  let levelText = $derived.by(() => {
    const db = blueboxLevelDb(held);
    return Number.isFinite(db) ? fmtDb(db) : 'silent';
  });
  let headroomText = $derived.by(() => {
    const db = blueboxHeadroomDb(held);
    if (!Number.isFinite(db)) return 'silent';
    // Negative headroom is not a smaller number, it is a DIFFERENT STATE — the
    // module is over full scale (all twelve keys reach +2.5 dBFS), and a
    // `-2.5 dB` that reads like quiet is the wrong thing to print.
    return db < 0 ? `CLIPS ${fmtDb(-db)}` : fmtDb(db);
  });

  /** COMPONENT STATE — see the header. `hz` names each oscillator; `keys` reads
   *  the Bell grid BACKWARDS and is the direct answer to "why did those two
   *  stack". The flip is also this panel's declared operability probe: it drives
   *  the caption row's text, which a dead button cannot change. */
  let labelMode = $state<'hz' | 'keys'>('hz');
</script>

<div class="bank" data-testid="bluebox-tonebank">
  <div
    class="bars"
    role="img"
    aria-label="the ten-oscillator tone bank, {labelMode === 'hz'
      ? 'labelled by frequency'
      : 'labelled by the keys that light each slot'}"
  >
    {#each bars as bar (bar.hz)}
      <div class="slot" data-band={bar.band} data-count={bar.count}>
        <!-- The CAPACITY outline: how tall this slot could ever get. Drawn
             always, so the bank's shape is readable before anything is held. -->
        <div class="track" style={`--cap:${bar.capacity / BLUEBOX_MAX_SLOT_KEYS}`}>
          <div class="cap"></div>
          <div class="fill" style={`--h:${bar.height}`}></div>
          {#if bar.count > 1}
            <!-- STACKING IS LABELLED, NOT INFERRED: a bar at two keys is the
                 whole architectural claim, so it says "×2" rather than leaving
                 the player to compare heights. -->
            <span class="mult" style={`--h:${bar.height}`}>×{bar.count}</span>
          {/if}
        </div>
      </div>
    {/each}
  </div>

  <!-- ⚠ THE CAPTION ROW IS THE PANEL'S OPERABILITY PROBE TARGET. Its text is
       computed from the label mode, so a MODE button that did nothing cannot
       change it — which is what makes the `text` probe on this element a real
       liveness assertion rather than a button relabelling itself.
       `bluebox-face-model.test.ts` asserts the two modes can never render the
       same string for any slot.

       ⚠ IT IS ITS OWN FULL-WIDTH ROW, and that is load-bearing rather than
       cosmetic: it mirrors `.bars` column-for-column (same 10-track grid, same
       gap, same padding), so a caption sits under ITS OWN bar. The first draft
       put the mode button inside this row, which stole ~24 px off the right and
       walked every caption progressively out from under its slot — a picture
       whose labels point at the wrong oscillator is worse than no labels. -->
  <div class="axis-ticks" data-testid="bluebox-bank-axis">
    {#each bars as bar (bar.hz)}<span>{blueboxBarCaption(bar, labelMode)}</span>{/each}
  </div>

  <!-- THE FIVE NUMBERS, and they live here rather than in `face.hero.readouts`
       because the platform's readout reader is durable-params-only and this
       module's durable params are scrubbed to rest within a frame (see header).
       Each is BLIND to something another one sees:
         level    the only one that moves between {1,4} and {1,5};
         headroom identical for those two — level's negative control, and 6 dB
                  apart for {1} and {BLUEBOX} where `keys` is identical;
         decodes  not a function of counts at all;
         keys / lit  THE FOILS, published so you can watch which number moved.
       Full argument + the permanent negative controls: bluebox-face-model. -->
  <dl class="nums" data-testid="bluebox-bank-nums">
    <div><dt>level</dt><dd data-testid="bluebox-num-level">{levelText}</dd></div>
    <div><dt>headroom</dt><dd data-testid="bluebox-num-headroom">{headroomText}</dd></div>
    <div><dt>decodes</dt><dd data-testid="bluebox-num-decode">{blueboxDecodeText(held)}</dd></div>
    <div><dt>keys held</dt><dd data-testid="bluebox-num-keys">{blueboxKeyCount(held)}</dd></div>
    <div>
      <dt>tones lit</dt>
      <dd data-testid="bluebox-num-tones">{counts.lit} of {counts.activations}</dd>
    </div>
  </dl>

  <div class="key">
    <span class="k-row">rows</span>
    <span class="k-col">columns</span>
    <span class="k-inband">in-band · no digit</span>
    <button
      type="button"
      class="mode"
      data-testid="bluebox-bank-label"
      title="Label the ten oscillators by FREQUENCY or by the KEYS that light each one (the Bell grid read backwards). Your screen only: this is not shared or saved."
      onclick={() => (labelMode = labelMode === 'hz' ? 'keys' : 'hz')}
    >{labelMode === 'hz' ? 'Hz' : 'keys'}</button>
  </div>
</div>

<style>
  .bank {
    width: 100%;
    display: grid;
    grid-template-rows: 1fr auto auto auto;
    gap: 3px;
  }

  .bars {
    display: grid;
    grid-template-columns: repeat(10, 1fr);
    gap: 3px;
    height: 104px;
    padding: 4px;
    background: rgb(0 0 0 / 0.35);
    border: 1px solid rgb(255 255 255 / 0.08);
    border-radius: 3px;
  }

  .slot {
    display: flex;
    align-items: flex-end;
    min-width: 0;
  }

  /* The track is the FIXED axis (four keys, the most any one slot can stack).
     `--cap` is this slot's own ceiling inside it. */
  .track {
    position: relative;
    width: 100%;
    height: 100%;
  }
  .cap {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: calc(var(--cap) * 100%);
    border: 1px dashed rgb(255 255 255 / 0.16);
    border-radius: 2px 2px 0 0;
  }
  .fill {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: calc(var(--h) * 100%);
    border-radius: 2px 2px 0 0;
    background: var(--band-hue);
  }
  .mult {
    position: absolute;
    left: 0;
    right: 0;
    bottom: calc(var(--h) * 100%);
    text-align: center;
    font-size: 8px;
    line-height: 1.4;
    color: var(--band-hue);
    font-variant-numeric: tabular-nums;
  }

  /* Three BANDS, three hues — rows and columns are the Bell grid, and the
     in-band tones belong to no digit at all, which is the module's name. */
  .slot[data-band='row'] {
    --band-hue: var(--domain, #4dd6c1);
  }
  .slot[data-band='col'] {
    --band-hue: #7fb2ff;
  }
  .slot[data-band='inband'] {
    --band-hue: #f0a44a;
  }

  /* MIRRORS `.bars` EXACTLY — same tracks, same gap, same horizontal padding —
     so caption N sits under bar N. Nothing else may share this row. */
  .axis-ticks {
    display: grid;
    grid-template-columns: repeat(10, 1fr);
    gap: 3px;
    padding: 0 4px;
    font-size: 9px;
    color: rgb(255 255 255 / 0.42);
    font-variant-numeric: tabular-nums;
  }
  /* ⚠ NO `text-overflow: ellipsis`, DELIBERATELY, and the first draft had one.
     A CSS ellipsis leaves NO TRACE IN `textContent`, and this row is precisely
     what faces-parity's probe reads with `toHaveText` — so a caption clipped to
     `2 5…` would pass every gate in the repo while the picture's labels stopped
     naming their oscillators. `overflow: visible` cannot truncate silently: an
     over-long caption collides with its neighbour, which is ugly and therefore
     reportable. MEASURED (dock, keys mode): the longest caption `2 5 8 0`
     renders at 30.92 px, and the cell FLOORS at 51 px — the panel hits its
     380 px `minWidth` and the dock scrolls rather than shrinking further — so
     there is 20.1 px (65 %) of margin at the narrowest width reachable at all.
     Guarded on rendered pixels, in both modes, by bluebox.spec.ts. */
  .axis-ticks > span {
    text-align: center;
    overflow: visible;
    white-space: nowrap;
  }

  .nums {
    display: flex;
    flex-wrap: wrap;
    gap: 2px 16px;
    margin: 2px 0 0;
    padding: 0;
  }
  .nums > div {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
  }
  .nums dt {
    font-size: 9px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: rgb(255 255 255 / 0.42);
  }
  .nums dd {
    margin: 0;
    font-size: 13px;
    line-height: 1.15;
    color: var(--domain, #4dd6c1);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .key {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 9px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .k-row {
    color: var(--domain, #4dd6c1);
  }
  .k-col {
    color: #7fb2ff;
  }
  .k-inband {
    color: #f0a44a;
  }
  /* The mode button rides the LEGEND row, pushed right — off the caption grid,
     which has to stay a clean 10-track mirror of the bars. */
  .key .mode {
    margin-left: auto;
    appearance: none;
    background: rgb(255 255 255 / 0.06);
    border: 1px solid rgb(255 255 255 / 0.12);
    border-radius: 3px;
    color: rgb(255 255 255 / 0.42);
    font: inherit;
    letter-spacing: normal;
    text-transform: none;
    padding: 1px 5px;
    cursor: pointer;
  }
  .key .mode:hover {
    background: rgb(255 255 255 / 0.12);
  }
</style>
