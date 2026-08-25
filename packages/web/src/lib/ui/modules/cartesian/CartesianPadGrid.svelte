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
  import { noteNameForMidi } from '$lib/audio/note-entry';
  import { resolveArrowNav, type ArrowKey } from '$lib/audio/grid-nav';
  import { CELL_COUNT, GRID_DIM, type Cell } from '$lib/audio/modules/cartesian';
  import {
    cartesianCellsOf,
    commitCartesianPitch,
    cycleCartesianChord,
    parseCartesianPitch,
    setCartesianGate,
  } from '$lib/ui/modules/cartesian-cell-actions';

  interface Props {
    nodeId: string;
  }
  let { nodeId }: Props = $props();

  // ⚠ THE VERSION MUST BE READ INSIDE THE DERIVE THAT PROJECTS THE DATA, NOT IN
  // ONE THAT RETURNS THE NODE. The first draft did
  // `node = $derived.by(() => { void version; return patch.nodes[nodeId]; })`
  // and then `cells = $derived(cartesianCellsOf(node))` — which LOOKS correct
  // and is not: `patch.nodes[nodeId]` is a Yjs proxy whose IDENTITY is stable
  // across mutations, so `node` never changes reference, the downstream derive
  // never re-runs, and every pad paints its spawn value forever. Typing a note
  // committed MIDI 49 to the graph while the box still read `c3`.
  //
  // `cartesian-face.spec.ts` caught it because it asserts the DISPLAY as well
  // as the graph; a test that only read `node.data` would have passed on a
  // face that shows nothing the player does. Same shape as CartesianCard's own
  // `cells` derive, which reads `.cells` inside the version-dependent block for
  // exactly this reason.
  let version = $derived(nodeVersion(nodeId));
  let cells = $derived.by<Cell[]>(() => {
    void version;
    return cartesianCellsOf(patch?.nodes?.[nodeId]);
  });

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

  // ── KEYBOARD NAVIGATION ───────────────────────────────────────────────────
  //
  // ⚠ THIS IS PARITY, NOT AN ACCESSIBILITY ADDITION, and the difference is why
  // it is here at all under the standing no-keyboard-a11y ruling. Arrow-walking
  // the pads and Enter-stepping to the next one is how this module is PLAYED —
  // `CartesianCard` has had it since D5, and promotion deletes that card from
  // both surfaces, so a face without it drops a gesture the player has today.
  //
  // ⚠ AND THE GATE BUTTON CARRIES #1790's GUARD. Bare Tab is also the rack-flip
  // gesture, claimed by two plain `window` listeners in Canvas.svelte. Both bail
  // on `isTypingTarget`, so the PITCH side — an <input> — was never affected;
  // a gate <button> is not a typing target, so without `stopPropagation` the
  // flip owner acts on the very keystroke this grid just consumed (Tab advances
  // a pad AND turns the rack around). `preventDefault` does not reach a sibling
  // window listener; only `stopPropagation` does. ONLY when we handled it — at
  // the grid bound `resolveArrowNav` declines, the event propagates ON PURPOSE,
  // and the rack flips, which is the global gesture doing its job.
  const NAV_SPEC = { cols: GRID_DIM, cellRows: GRID_DIM };

  function focusPad(idx: number, role: 'pitch' | 'gate'): boolean {
    // The pitch side is addressed by the PRIMITIVE's own `data-role="entry"`
    // rather than by a nav attribute TextEntry would have to grow a prop for:
    // the shared primitive already marks itself, and one selector fewer is one
    // fewer thing to keep in step.
    const sel = role === 'gate' ? '[data-nav="gate"]' : 'input[data-role="entry"]';
    const t = gridEl?.querySelector<HTMLElement>(`[data-pad="${idx}"] ${sel}`);
    if (!t) return false;
    t.focus();
    if (t.tagName === 'INPUT') (t as HTMLInputElement).select();
    return true;
  }

  function handleNav(e: KeyboardEvent, idx: number, role: 'pitch' | 'gate'): boolean {
    const max = CELL_COUNT - 1;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const next = resolveArrowNav({ index: idx, role }, e.key as ArrowKey, NAV_SPEC);
      if (!next) return false;
      return focusPad(next.index, next.role);
    }
    if (e.key === 'Enter' && role === 'pitch') {
      const next = idx === max ? max : idx + 1;
      Promise.resolve().then(() => focusPad(next, 'pitch'));
      return true;
    }
    if (e.key === 'Tab') {
      const next = idx + (e.shiftKey ? -1 : 1);
      if (next < 0 || next > max) return false; // decline: the rack flips
      return focusPad(next, role);
    }
    return false;
  }

  function onGateKeydown(e: KeyboardEvent, i: number) {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      setCartesianGate(nodeId, i, !(cells[i]?.on ?? false));
      return;
    }
    if (
      e.key === 'ArrowLeft' || e.key === 'ArrowRight' ||
      e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'Tab'
    ) {
      if (!handleNav(e, i, 'gate')) return; // declined — let the flip owner have it
      e.preventDefault();
      if (e.key === 'Tab') e.stopPropagation(); // #1790, and ONLY for Tab
    }
  }

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
    {@const pad = cells[i]}
    {@const on = pad?.on ?? false}
    {@const chord = pad?.chord ?? 'mono'}
    <div class="pad" class:active={i === currentStep} data-pad={i}>
      <button
        class="gate"
        class:on
        type="button"
        aria-pressed={on}
        aria-label={`Pad ${i} (${padWhere(i)}) gate`}
        data-testid={`cart-face-gate-${i}`}
        data-nav="gate"
        onclick={() => setCartesianGate(nodeId, i, !on)}
        onkeydown={(e) => onGateKeydown(e, i)}
      ></button>
      <TextEntry
        stored={pad?.midi == null ? '' : noteNameForMidi(pad.midi)}
        parse={parseCartesianPitch}
        onCommit={(midi) => commitCartesianPitch(nodeId, i, midi)}
        ariaLabel={`Pad ${i} (${padWhere(i)}) note`}
        placeholder="—"
        maxLength={12}
        testid={`cart-face-pitch-${i}`}
        onNavKey={(e) => handleNav(e, i, 'pitch')}
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
