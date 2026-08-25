<script lang="ts">
  // CartesianPadGrid — the 4×4 pad grid as a PF-14 panel cell.
  //
  // ⚠ WHY A PANEL AND NOT SIXTEEN GENERIC CELLS, because the first attempt was
  // the other thing and it is worth recording why it cannot be built. A face
  // key resolves to exactly one of three shapes (`resolveFaceControl`): a PARAM
  // id, a control-family TEMPLATE, or a legend STATIC. A family renders ONE
  // cell — `FAMILY_TEMPLATE` is `/^(.+)-\{n\}$/`, so the key must end in a
  // literal `-{n}` and there is no per-member index — and a static key is legal
  // only if a committed `e2e/vrt/__annotated__/<type>.legend.json` names it,
  // which cartesian has none of. Sixteen individually-ranked pads therefore
  // needs sixteen (here forty-eight) FAMILY IDS, and `module-docs-lint`'s
  // card-drift leg requires every declared `testidPrefix` to appear in real UI
  // source. MEASURED: twelve face-only families fail it; forty-eight would too.
  // The two escapes are both refused by standing rules — adding dead testids to
  // `CartesianCard` to satisfy the gate is *fixing a declaration to satisfy a
  // gate*, and widening the gate is new machinery.
  //
  // So the platform's answer for a per-member roster is rung 2 of the bespoke
  // ladder: ONE picture-you-edit. `kria` — the only other faced sequencer — is
  // the precedent, and cartesian's own migration `why` already said it: *"the
  // grid is the module."*
  //
  // ⚠ AND WHY IT IS `face.hero.cell`. A panel declares its own `minWidth` and a
  // lane knob column is 46 px, so `module-face-lint` refuses a panel SELECTED
  // at a lane tier. PF-22 drops `face.hero.cell` from `laneOrder` only, so the
  // grid costs NO lane rank and may rank first at the dock while `octave` /
  // `gateLength` / `snh` still fill the lane tile. That is `order` and the lane
  // ladder disagreeing BY MECHANISM rather than by hand-ranking — do not
  // "fix" it by demoting the grid.
  //
  // ⚠ THIS PANEL IS THE `TextEntry` PRIMITIVE'S FIRST ADOPTER (#1509). The
  // pitch boxes are the shared typed-entry control, and every write goes
  // through `cartesian-cell-actions`, which `CartesianCard.svelte` calls too —
  // a pad is a read-modify-write over `{ on, midi, chord }` and two surfaces
  // disagreeing about the fields they do not own is how a retyped note silently
  // un-voices a chord pad.
  //
  // ⚠ NO `control-<paramId>` TESTID (shell-cells rule 1) — everything here is
  // `node.data`, which is precisely why it is a panel.
  //
  // ⚠ NO RESTING DERIVED TEXT, with ONE licensed exception. The chord badge and
  // the pad index are option NAMES and control CAPTIONS; the pitch box's
  // content is the `'authored-entry'` role — the string the player typed, in a
  // writable form control's `value`, never a text node. Nothing here paints a
  // measurement or a state word.
  //
  // ⚠ DOM, NOT CANVAS — accessible names, hit-testing and focus for free, and a
  // WebGL surface would enrol cartesian in the attest basis (rule 2 is derived
  // from CONTENT), making every later edit cost a real-GPU re-attest window.

  import { patch } from '$lib/graph/store';
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
  import { onMeterFrame } from '$lib/ui/meter-frame';
  import { useEngine } from '$lib/audio/engine-context';
  import TextEntry from '$lib/ui/controls/TextEntry.svelte';
  import type { ModuleNode } from '$lib/graph/types';
  import { CELL_COUNT, GRID_DIM } from '$lib/audio/modules/cartesian';
  import {
    cartesianCellsOf,
    cartesianPitchText,
    commitCartesianPitch,
    cycleCartesianChord,
    cartesianGateValue,
    parseCartesianPitch,
    setCartesianGate,
    cartesianChordValue,
  } from '$lib/ui/modules/cartesian-cell-actions';

  interface Props {
    nodeId: string;
  }
  let { nodeId }: Props = $props();

  let version = $derived(nodeVersion(nodeId));
  let node = $derived.by<ModuleNode | undefined>(() => {
    void version;
    return patch?.nodes?.[nodeId];
  });
  let cells = $derived(cartesianCellsOf(node));

  // ── THE PLAYHEAD ──────────────────────────────────────────────────────────
  // The card shows which pad the cursor is on and it is the module's identity
  // (a cursor walking a grid), so dropping it would be a parity loss. It rides
  // the SHARED frame pump rather than a bespoke rAF — one pump for the whole
  // app, and it stops when this element is off-screen.
  //
  // ⚠ It is LIVE, so it is a VRT hazard by construction. It is safe in the dock
  // scene only because `bootWithFace` suspends the audio graph before capture
  // (`freezeFaceAudio`), which pins `currentStep`. A scene that did not freeze
  // would see this move — the analogVco lesson, one module over.
  const engineCtx = useEngine();
  let gridEl: HTMLElement | undefined = $state();
  let currentStep = $state(-1);
  $effect(() => {
    const h = onMeterFrame(gridEl ?? null, () => {
      const e = engineCtx.get();
      const n = patch?.nodes?.[nodeId];
      if (!e || !n) return;
      const cs = e.read(n, 'currentStep');
      if (typeof cs === 'number' && cs !== currentStep) currentStep = cs;
    });
    return () => h.stop();
  });

  function chordGlyph(q: string): string {
    if (q === 'maj') return 'M';
    if (q === 'min') return 'm';
    return '—';
  }
  /** The pad's grid position, for the accessible name. Row-major, like the
   *  engine's own cursor arithmetic. */
  function padWhere(i: number): string {
    return `row ${Math.floor(i / GRID_DIM)}, column ${i % GRID_DIM}`;
  }
</script>

<div
  class="pad-grid"
  bind:this={gridEl}
  data-testid="cart-face-grid"
  style={`--cart-cols:${GRID_DIM}`}
>
  {#each Array.from({ length: CELL_COUNT }, (_, i) => i) as i (i)}
    {@const on = cartesianGateValue(node, i)}
    {@const chord = cartesianChordValue(node, i)}
    <div class="pad" class:active={i === currentStep}>
      <button
        class="gate"
        class:on
        type="button"
        aria-pressed={on}
        aria-label={`Pad ${i} (${padWhere(i)}) gate`}
        data-testid={`cart-face-gate-${i}`}
        onclick={() => setCartesianGate(nodeId, i, !on)}
      ></button>
      <TextEntry
        stored={cartesianPitchText(node, i)}
        parse={parseCartesianPitch}
        onCommit={(midi) => commitCartesianPitch(nodeId, i, midi)}
        ariaLabel={`Pad ${i} (${padWhere(i)}) note`}
        placeholder="—"
        maxLength={12}
        testid={`cart-face-pitch-${i}`}
      />
      <button
        class="chord"
        class:mono={chord === 'mono'}
        type="button"
        aria-label={`Pad ${i} (${padWhere(i)}) chord: ${chord}`}
        data-testid={`cart-face-chord-${i}`}
        onclick={() => cycleCartesianChord(nodeId, i)}
      >{chordGlyph(chord)}</button>
    </div>
  {/each}
</div>

<style>
  .pad-grid {
    display: grid;
    grid-template-columns: repeat(var(--cart-cols, 4), minmax(0, 1fr));
    gap: 4px;
    width: 100%;
  }
  .pad {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 2px;
    min-width: 0;
    padding: 2px;
    border-radius: 3px;
    border: 1px solid transparent;
  }
  .pad.active {
    border-color: var(--accent);
  }
  .gate {
    height: 12px;
    background: #14171c;
    border: 1px solid #2a2f3a;
    border-radius: 2px;
    padding: 0;
    cursor: pointer;
  }
  .gate.on {
    background: var(--cable-gate);
    border-color: var(--cable-gate);
  }
  .gate:focus-visible,
  .chord:focus-visible {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px var(--accent);
    outline: none;
  }
  .chord {
    height: 14px;
    background: #14171c;
    border: 1px solid #2a2f3a;
    border-radius: 2px;
    color: var(--text-dim, #9aa3ad);
    font-size: 0.55rem;
    line-height: 1;
    padding: 0;
    cursor: pointer;
  }
  .chord.mono {
    color: #55606c;
  }
</style>
