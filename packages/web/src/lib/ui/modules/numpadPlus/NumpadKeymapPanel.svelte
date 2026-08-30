<script lang="ts">
  // NumpadKeymapPanel — the fourteen remappable key caps as a PF-14 panel cell.
  //
  // ⚠ ONE FAMILY, FOURTEEN MEMBERS. The legacy card emitted two testid prefixes
  // for one control kind (`numpad-key-*` for the notes, `numpad-octkey-*` for
  // the two octave actions) and the DEF never agreed with that split —
  // `DEFAULT_KEYMAP` is ONE fourteen-entry map and the card's own handlers treat
  // all fourteen identically. The prefix is unified here and on the card.
  //
  // ⚠ RESTING TEXT, RULED ON EXPLICITLY, because this is the hard case and the
  // resting-text gate is structurally blind to a bespoke component. A cap is ONE
  // control with a caption and a value:
  //   * the NOTE (`c#`, or `oct↑`/`oct↓`) is the cap's CAPTION — the name of the
  //     control, not its value. Twelve caps are otherwise identical.
  //   * the BOUND KEY (`1`, `Q`, `↑`, `␣`, `F5`) is the cap's OPTION NAME — the
  //     member of the physical-key roster currently selected. It is not a
  //     quantity (an engraving cannot be more or less), it restates no dial
  //     position (there is no dial, no travel, and the roster is ~100 unordered
  //     members), and it is the ONLY feedback the remapping feature has —
  //     delete it and remapping becomes write-only.
  //   ⚠ The uncomfortable half, stated rather than glossed: for the ten default
  //     numpad bindings the engraving IS a digit, so a cap paints `7`. That is
  //     permitted because the IDENTITY of the text is what matters, not its
  //     glyph shape — `7` here is the proper noun of a key, exactly as `24` is
  //     the proper noun of a clock division in `cvBuddy.ppqn`'s exemption
  //     ("there is no name for the state that is not the integer"). It is drawn
  //     small, monospaced and inside a key-shaped box so it reads as a legend.
  //
  // ⚠ THE HINT LINE IS PRESENT AT REST AND EMPTY. It is the panel's declared
  // probe WITNESS, and `expect: 'changed'` over an absent→present element is not
  // a comparison the sweep can make — so it holds its height and paints nothing
  // until a remap is actually listening. Its content is instructional copy in a
  // transient MODE, not resting text.
  //
  // ⚠ NO `control-<paramId>` TESTID (shell-cells rule 1) — this panel edits
  // `node.data.keymap`, which is why it is a panel at all.

  import { patch } from '$lib/graph/store';
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
  import type { ModuleNode } from '$lib/graph/types';
  import { clampMenu, portal } from '$lib/ui/menu-viewport-action';
  import {
    DEFAULT_KEYMAP,
    SEMITONE_NAMES,
    OCTAVE_UP_ACTION,
    OCTAVE_DOWN_ACTION,
    codeForSemitone,
    keyCodeLabel,
    remapKeymap,
  } from '$lib/audio/modules/numpad-plus';
  import { setNumpadKeymap } from '$lib/audio/modules/numpad-plus-writes';

  interface Props {
    nodeId: string;
  }
  let { nodeId }: Props = $props();

  /** Every remap target, in cap order: the twelve notes then the two octave
   *  actions. DERIVED from the module's own constants, never typed out. */
  const TARGETS: readonly number[] = [
    ...SEMITONE_NAMES.map((_n, i) => i),
    OCTAVE_UP_ACTION,
    OCTAVE_DOWN_ACTION,
  ];

  // ⚠ KEYED ON `nodeVersion` — the live Yjs node proxy's identity never changes,
  // so a `$derived` reading straight off it would recompute never.
  let live = $derived.by(() => ({ v: nodeVersion(nodeId), n: patch.nodes[nodeId] as ModuleNode | undefined }));
  let keymap = $derived.by<Record<string, number>>(() => {
    const raw = (live.n?.data as { keymap?: unknown } | undefined)?.keymap;
    return raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, number>)
      : { ...DEFAULT_KEYMAP };
  });

  let listening = $state<number | null>(null);
  let menuTarget = $state<number | null>(null);
  let menuX = $state(0);
  let menuY = $state(0);
  let panelEl = $state<HTMLElement | null>(null);

  function targetLabel(t: number): string {
    if (t === OCTAVE_UP_ACTION) return 'oct↑';
    if (t === OCTAVE_DOWN_ACTION) return 'oct↓';
    return (SEMITONE_NAMES[t] ?? '?').toLowerCase();
  }
  function physLabel(t: number): string {
    if (listening === t) return '…';
    const code = codeForSemitone(keymap, t);
    return code ? keyCodeLabel(code) : '—';
  }
  function capName(t: number): string {
    const code = codeForSemitone(keymap, t);
    return `${targetLabel(t)} — ${code ? `key ${keyCodeLabel(code)}` : 'unbound'}`;
  }

  /** LEFT-CLICK BEGINS THE REMAP. This is the one place the face deliberately
   *  CHANGES the legacy interaction, and it is a UX improvement rather than a
   *  workaround: it is exactly what the right-click menu's first item already
   *  did, in one click instead of two. It also makes the cap PROBE-ABLE — a
   *  `ShellPanelProbe.action` is `'click' | 'drag'` and there is no right-click
   *  action, so an inert cap could not be declared as a cell at all. The
   *  right-click menu is unchanged and still offers Remap… and Reset. */
  function beginRemap(t: number) {
    menuTarget = null;
    listening = t;
  }
  function openMenu(ev: MouseEvent, t: number) {
    ev.preventDefault();
    ev.stopPropagation();
    menuTarget = t;
    menuX = ev.clientX;
    menuY = ev.clientY;
  }
  function resetKey(t: number) {
    menuTarget = null;
    const defCode = codeForSemitone(DEFAULT_KEYMAP, t);
    if (defCode) setNumpadKeymap(nodeId, remapKeymap(keymap, defCode, t));
  }

  // While listening, capture the next physical keydown (ANY key) and bind it.
  // Capture-phase + stopImmediatePropagation so the keystroke BINDS instead of
  // (also) playing a note through the factory's own document listener.
  //
  // ⚠ AND THE PANEL MUST NOT BE LEFT ARMED. `faces-parity` clicks a probe and
  // moves on; a panel left listening would capture the sweep's NEXT keystroke
  // and silently rebind a key — a test that mutates the fixture it is measuring.
  // So listening ends on Esc, on a pointerdown anywhere outside this panel, and
  // on unmount. `numpadPlus-face-model.test.ts` keeps the permanent negative
  // control that arming writes NOTHING.
  $effect(() => {
    if (listening === null) return;
    const target = listening;
    const onKey = (ev: KeyboardEvent) => {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      if (ev.code === 'Escape') { listening = null; return; }
      setNumpadKeymap(nodeId, remapKeymap(keymap, ev.code, target));
      listening = null;
    };
    const onOutside = (ev: PointerEvent) => {
      const t = ev.target as Node | null;
      if (panelEl && t && panelEl.contains(t)) return;
      listening = null;
    };
    document.addEventListener('keydown', onKey, { capture: true });
    window.addEventListener('pointerdown', onOutside, { capture: true });
    return () => {
      document.removeEventListener('keydown', onKey, { capture: true });
      window.removeEventListener('pointerdown', onOutside, { capture: true });
    };
  });
</script>

<div class="np-keymap-panel" bind:this={panelEl} data-testid="numpad-keymap-panel">
  <div class="caps" role="group" aria-label="keypad key bindings">
    {#each TARGETS as t (t)}
      <button
        type="button"
        class="cap nodrag"
        class:oct={t === OCTAVE_UP_ACTION || t === OCTAVE_DOWN_ACTION}
        class:listening={listening === t}
        data-testid={`numpad-key-${t}`}
        aria-label={capName(t)}
        onclick={() => beginRemap(t)}
        oncontextmenu={(e) => openMenu(e, t)}
      >
        <span class="phys">{physLabel(t)}</span>
        <span class="note">{targetLabel(t)}</span>
      </button>
    {/each}
  </div>
  <!-- The probe WITNESS: present at rest, empty at rest. -->
  <div class="hintline" data-testid="numpad-key-hint" aria-live="polite">
    {#if listening !== null}press any key to bind {targetLabel(listening)} · esc cancels{/if}
  </div>
</div>

{#if menuTarget !== null}
  <!-- Portaled to <body> so `position: fixed` resolves against the VIEWPORT.
       Inside SvelteFlow's transformed/zoomed node a fixed element anchors to
       that transformed ancestor instead, which spawns the menu off-cursor and
       drifts it on pan/zoom. `clampMenu` flips/clamps it at window edges. -->
  <div use:portal>
    <div
      class="kmap-menu-backdrop"
      role="presentation"
      onpointerdown={() => (menuTarget = null)}
      oncontextmenu={(e) => { e.preventDefault(); menuTarget = null; }}
    ></div>
    <div
      class="kmap-menu nodrag"
      role="menu"
      use:clampMenu={{ x: menuX, y: menuY }}
      data-testid="numpad-key-menu"
    >
      <button type="button" role="menuitem" class="kmap-menu-item"
        onclick={() => beginRemap(menuTarget!)} data-testid="numpad-remap-item">Remap…</button>
      <button type="button" role="menuitem" class="kmap-menu-item"
        onclick={() => resetKey(menuTarget!)} data-testid="numpad-reset-item">Reset to default</button>
    </div>
  </div>
{/if}

<style>
  .np-keymap-panel { display: flex; flex-direction: column; gap: 3px; width: max-content; }
  .caps {
    display: grid;
    grid-template-columns: repeat(7, 26px);
    gap: 3px;
    border: 1px solid var(--border, #3a4048);
    border-radius: 6px;
    background: var(--control-bg, #151a21);
    padding: 4px;
    width: max-content;
  }
  .cap {
    appearance: none;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1px;
    height: 28px;
    padding: 0;
    border-radius: 2px;
    background: #0a0d11;
    border: 1px solid #262c34;
    cursor: pointer;
  }
  .cap:hover { border-color: var(--accent, #6cf); }
  .cap .phys {
    font-family: ui-monospace, monospace;
    font-size: 9.6px;
    font-weight: 700;
    color: var(--accent, #6cf);
    line-height: 1;
  }
  .cap.oct .phys { color: var(--cable-gate, #ffd000); }
  .cap .note {
    font-family: ui-monospace, monospace;
    font-size: 6.4px;
    color: var(--text-dim, #6b7480);
    line-height: 1;
  }
  .cap.listening { border-color: #f5c248; box-shadow: 0 0 0 2px rgba(245, 194, 72, 0.5); }
  .hintline {
    min-height: 12px;
    font-family: ui-monospace, monospace;
    font-size: 7.6px;
    color: var(--text-dim, #6b7480);
    padding-top: 3px;
  }
  .kmap-menu-backdrop { position: fixed; inset: 0; z-index: 999; }
  .kmap-menu {
    position: fixed; z-index: 1000;
    background: #14171c;
    border: 1px solid var(--border);
    border-radius: 3px;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.5);
    padding: 3px;
    display: flex; flex-direction: column;
    min-width: 130px;
  }
  .kmap-menu-item {
    appearance: none;
    background: transparent;
    border: none;
    color: var(--text);
    text-align: left;
    padding: 5px 8px;
    font-size: 0.72rem;
    border-radius: 2px;
    cursor: pointer;
  }
  .kmap-menu-item:hover { background: rgba(255, 255, 255, 0.08); color: var(--accent, #00f0ff); }
</style>
