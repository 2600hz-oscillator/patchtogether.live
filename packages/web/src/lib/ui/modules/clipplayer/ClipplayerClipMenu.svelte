<script lang="ts">
  // ClipplayerClipMenu — the clip player's right-click menu. ONE definition,
  // now THREE mounts: the legacy card, the face's launch panel and the face's
  // note panel.
  //
  // ⚠ IT IS EXTRACTED RATHER THAN COPIED, AND THE CARD'S OWN COMMENT IS THE
  // REASON. There used to be two menus in this module — a NOTE menu on the
  // piano-roll cell and a separate CLIP menu on the launcher pad — and when the
  // owner asked for sub-lists the restructure landed on ONE of them. Every test
  // stayed green: they drove the real card through its real mount, they just
  // drove the other surface. The card fixed that by folding both entry points
  // into one markup block; promoting the module would have re-created the
  // identical defect one level up, because the face's panels are a third and
  // fourth surface that would each have needed their own. So the block moved
  // here, whole, and the card renders THIS.
  //
  // ⚠ NOTHING IN THE MARKUP CHANGED IN THE MOVE. Every class, every testid,
  // every title string and every aria attribute is the card's, byte for byte —
  // eighteen clipplayer e2e specs locate through them, and a rename here is a
  // rename on the surface they drive.
  //
  // ⚠ NO `control-<paramId>` TESTID (shell-cells panel rule 1): this menu edits
  // clip CONTENT in `node.data`, never a ParamDef, so a `control-` testid here
  // would read to faces-parity as an extra control with no def backing.

  import { clampMenu, cascadeMenu, portal } from '$lib/ui/menu-viewport-action';
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
  import {
    PLAY_EVERY_MAX,
    copyClip,
    noteCovering,
    pasteApplies,
    plainCloneAutoClip,
    playEveryEff,
    probLevelToValue,
    readAutoClip,
    setNotePlayEvery,
    type NoteClipRecord,
  } from '$lib/audio/modules/clip-types';
  import {
    clipboardClip,
    clipboardClipAuto,
    clipboardKind,
    setClipboardBuffer,
  } from '$lib/audio/modules/clip-clipboard';
  import { reconcileClipRemoval } from '$lib/audio/modules/clip-reconcile';
  import {
    applyClipPitchProbPick,
    applyClipPlayEveryPick,
    applyClipProbMenuPick,
    applyPitchProbMenuPick,
    applyProbMenuPick,
    clipPitchProbMenuCheckedLevel,
    clipPlayEveryMenuCheckedLevel,
    clipProbMenuCheckedLevel,
    pitchProbMenuCheckedLevel,
    pitchProbMenuLevels,
    probMenuCheckedLevel,
    probMenuLevels,
    probPctLabel,
  } from '../clipplayer-prob-menu';
  import { pitchProbLabel, pitchProbLevelToValue } from '$lib/audio/pitch-probability';
  import {
    clipplayerClipAt,
    clipplayerData,
    deleteClipplayerClip,
    pasteClipplayerClip,
    writeClipplayerClip,
  } from './clipplayer-face-actions';
  import type { ClipplayerMenuAt } from './clipplayer-face-model';

  interface Props {
    nodeId: string;
    /** null = closed. */
    at: ClipplayerMenuAt | null;
    onclose: () => void;
    /** Fired after CLEAR deletes a clip, with whether the menu was opened from
     *  a NOTE cell — the editor has nothing left to show and its host decides
     *  where to go. */
    ondeleted?: (fromNote: boolean) => void;
  }
  let { nodeId, at, onclose, ondeleted }: Props = $props();

  /** Node-scoped re-derive: the checked rows read live clip content, so the
   *  menu must recompute when a peer (or an undo) edits it while it is open. */
  let version = $derived(nodeVersion(nodeId));

  type ProbSubKind = 'note' | 'pitch' | 'skip';
  type RowRect = {
    left: number;
    top: number;
    right: number;
    bottom: number;
    width: number;
    height: number;
  };
  let probSub = $state<{ which: ProbSubKind; rect: RowRect } | null>(null);

  // A fresh open closes any flyout the previous open left behind.
  $effect(() => {
    void at;
    probSub = null;
  });

  let isClip = $derived(at?.kind === 'clip');

  /** The clip the OPEN menu acts on — the right-clicked pad, or the clip whose
   *  note was right-clicked. Never a "selected" clip: a pad menu is routinely
   *  opened on a pad that is not the one loaded in the editor. */
  function menuClip(): NoteClipRecord | null {
    void version;
    return at ? clipplayerClipAt(nodeId, at.idx) : null;
  }
  function menuHasClip(): boolean {
    return menuClip() !== null;
  }

  function closeMenu() {
    probSub = null;
    onclose();
  }

  /** Write the clip the OPEN menu targets. */
  function writeMenuClip(next: NoteClipRecord) {
    if (!at) return;
    writeClipplayerClip(nodeId, at.idx, next);
  }

  /** NOTE PROBABILITY's checked level. On a note: that note's EFFECTIVE level.
   *  On a clip pad: the clip's DEFAULT, which every note without its own uses. */
  function probMenuCurrentLevel(): number {
    void version;
    if (!at) return 0;
    const clip = menuClip();
    return at.kind === 'note'
      ? probMenuCheckedLevel(clip, at.step, at.midi)
      : clipProbMenuCheckedLevel(clip);
  }
  function pitchProbMenuCurrent(): number | null {
    void version;
    if (!at) return 0;
    const clip = menuClip();
    return at.kind === 'note'
      ? pitchProbMenuCheckedLevel(clip, at.step, at.midi)
      : clipPitchProbMenuCheckedLevel(clip);
  }
  const playEveryLevels = Array.from({ length: PLAY_EVERY_MAX }, (_, i) => i + 1);
  /** The checked count. On a clip pad: the count every note AGREES on, or null
   *  when they differ — a mixed clip shows nothing checked rather than claiming
   *  the first note's value for all. */
  function playEveryMenuCurrent(): number | null {
    void version;
    if (!at) return 1;
    const clip = menuClip();
    if (at.kind === 'clip') return clipPlayEveryMenuCheckedLevel(clip);
    return clip ? playEveryEff(noteCovering(clip, at.step, at.midi) ?? undefined) : 1;
  }

  /** Open (or switch to) a parent row's flyout, placed beside that row. */
  function openProbSub(e: Event, which: ProbSubKind) {
    // ⚠ A DISABLED row must not open its flyout on HOVER either. `disabled`
    // suppresses `click` but NOT `pointerenter`, so without this an empty pad's
    // greyed-out row still cascaded a live option list that wrote nothing.
    if (!menuHasClip()) return;
    const row = e.currentTarget as HTMLElement | null;
    if (!row) return;
    const r = row.getBoundingClientRect();
    // HORIZONTALLY the flyout clears the whole PARENT MENU, not just the row
    // (the row is inset by the menu's padding + border — measured 2 px of
    // overlap when it flips left). VERTICALLY it aligns to the ROW.
    const menuEl = row.closest('.prob-menu');
    const m = menuEl ? menuEl.getBoundingClientRect() : r;
    probSub = {
      which,
      rect: {
        left: m.left,
        top: r.top,
        right: m.right,
        bottom: r.bottom,
        width: m.right - m.left,
        height: r.bottom - r.top,
      },
    };
  }

  function pickProbLevel(level: number) {
    if (!at) return;
    const clip = menuClip();
    if (clip) {
      writeMenuClip(
        at.kind === 'note'
          ? applyProbMenuPick(clip, at.step, at.midi, level)
          : applyClipProbMenuPick(clip, level),
      );
    }
    closeMenu();
  }
  function pickPitchProb(level: number) {
    if (!at) return;
    const clip = menuClip();
    if (clip) {
      writeMenuClip(
        at.kind === 'note'
          ? applyPitchProbMenuPick(clip, at.step, at.midi, level)
          : applyClipPitchProbPick(clip, level),
      );
    }
    closeMenu();
  }
  function pickPlayEvery(n: number) {
    if (!at) return;
    const clip = menuClip();
    if (clip) {
      writeMenuClip(
        at.kind === 'note'
          ? setNotePlayEvery(clip, at.step, at.midi, n)
          : applyClipPlayEveryPick(clip, n),
      );
    }
    closeMenu();
  }

  /** COPY the menu's clip (+ its sibling automation) onto the SHARED typed
   *  clipboard — the same buffer the Launchpad and Push 2 use. */
  function copyEditClip() {
    if (!at) return;
    const clip = clipplayerClipAt(nodeId, at.idx);
    if (!clip) return;
    setClipboardBuffer(
      { kind: 'clip', clip: copyClip(clip), auto: readAutoClip(clipplayerData(nodeId), at.idx) },
      at.idx,
    );
    closeMenu();
  }
  /** True when the clipboard holds something this menu can paste. A SCENE
   *  buffer leaves PASTE disabled rather than offering a silent no-op. */
  function canPasteClip(): boolean {
    const kind = clipboardKind();
    return kind !== null && pasteApplies(kind, 'clip') && clipboardClip() !== null;
  }
  function pasteEditClip() {
    const bc = clipboardClip();
    if (!at || !bc || !canPasteClip()) {
      closeMenu();
      return;
    }
    const idx = at.idx;
    const before = clipplayerClipAt(nodeId, idx);
    const next = copyClip(bc);
    pasteClipplayerClip(nodeId, idx, next, plainCloneAutoClip(clipboardClipAuto()));
    // A paste REPLACES every note, so it is a note REMOVAL for anything the old
    // clip left sounding — cut those voices NOW rather than next loop.
    if (before) reconcileClipRemoval(nodeId, before, next, idx, clipplayerData(nodeId));
    closeMenu();
  }
  /** CLEAR — the owner's word: it DELETES the clip, not the note and not merely
   *  the notes. The same operation the grid pad's Delete performs. */
  function clearEditClip() {
    if (!at) return;
    const fromNote = at.kind === 'note';
    const idx = at.idx;
    closeMenu();
    deleteClipplayerClip(nodeId, idx);
    ondeleted?.(fromNote);
  }
</script>

<!-- ══ THE RIGHT-CLICK MENU ═══════════════════════════════════════════════════
     TOP LEVEL, in the owner's order and wording: note probability ▸ / pitch
     probability ▸ / skip every ▸ / copy / paste / clear. Portaled to <body> +
     viewport-clamped so the whole menu stays in view at the window's edges. -->
{#if at}
  {@const hasClip = menuHasClip()}
  {@const current = probMenuCurrentLevel()}
  {@const curEvery = playEveryMenuCurrent()}
  {@const curPitch = pitchProbMenuCurrent()}
  <div use:portal>
    <button
      type="button"
      class="prob-menu-backdrop"
      aria-label="close clip menu"
      onclick={closeMenu}
      oncontextmenu={(e) => {
        e.preventDefault();
        closeMenu();
      }}
    ></button>
    <div
      class="prob-menu"
      role="menu"
      aria-label={isClip ? 'Clip actions' : 'Note'}
      use:clampMenu={{ x: at.x, y: at.y }}
      data-menu-kind={at.kind}
      data-testid={isClip ? `clipplayer-clip-prob-menu-${nodeId}` : `clipplayer-prob-menu-${nodeId}`}
    >
      <div class="prob-menu-list">
        <!-- NOTE PROBABILITY. Per note it is that note's own firing chance; per
             clip it is the DEFAULT every note without its own inherits — the
             same category at the two scopes, not two features. -->
        <button
          class="prob-menu-item sub"
          class:open={probSub?.which === 'note'}
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={probSub?.which === 'note'}
          disabled={!hasClip}
          title={isClip
            ? "This clip's DEFAULT firing chance — used by every note that has no probability of its own"
            : 'How likely this note is to FIRE at all'}
          data-testid={`clipplayer-sub-note-${nodeId}`}
          onpointerenter={(e) => openProbSub(e, 'note')}
          onclick={(e) => openProbSub(e, 'note')}>note probability</button
        >
        <button
          class="prob-menu-item sub"
          class:open={probSub?.which === 'pitch'}
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={probSub?.which === 'pitch'}
          disabled={!hasClip}
          title={isClip
            ? 'How far EVERY note in this clip may wander in pitch when it fires'
            : "How far this note's PITCH may wander when it fires"}
          data-testid={`clipplayer-sub-pitch-${nodeId}`}
          onpointerenter={(e) => openProbSub(e, 'pitch')}
          onclick={(e) => openProbSub(e, 'pitch')}>pitch probability</button
        >
        <button
          class="prob-menu-item sub"
          class:open={probSub?.which === 'skip'}
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={probSub?.which === 'skip'}
          disabled={!hasClip}
          title={isClip
            ? 'Play EVERY note in this clip only on every Nth loop'
            : 'Play this note only on every Nth loop of the clip'}
          data-testid={`clipplayer-sub-skip-${nodeId}`}
          onpointerenter={(e) => openProbSub(e, 'skip')}
          onclick={(e) => openProbSub(e, 'skip')}>skip every</button
        >
      </div>
      <!-- CLIP actions. COPY/PASTE run on the SHARED typed clipboard — the same
           buffer the Launchpad and Push 2 use. PASTE is DISABLED (not a silent
           no-op) when the buffer is empty or holds a SCENE. On an EMPTY pad only
           PASTE is live: that is how a clip is duplicated onto a free slot. -->
      <div class="prob-menu-sep" role="separator"></div>
      <div class="prob-menu-list">
        <button
          class="prob-menu-item"
          role="menuitem"
          disabled={!hasClip}
          title={hasClip
            ? 'Copy this clip (and its recorded automation) — pastes here, on a Launchpad or on Push 2'
            : 'Nothing to copy — this slot is empty'}
          data-testid={`clipplayer-menu-copy-${nodeId}`}
          onpointerenter={() => (probSub = null)}
          onclick={copyEditClip}>copy</button
        >
        <button
          class="prob-menu-item"
          role="menuitem"
          disabled={!canPasteClip()}
          title={canPasteClip()
            ? 'Paste the copied clip over this one (replaces its notes AND its automation). Undo with ↶.'
            : 'Nothing to paste — copy a clip first (a whole SCENE can only be pasted onto a scene)'}
          data-testid={`clipplayer-menu-paste-${nodeId}`}
          onpointerenter={() => (probSub = null)}
          onclick={pasteEditClip}>paste</button
        >
      </div>
      <!-- CLEAR deletes the CLIP — destructive, so it is separated and tinted
           red. No confirm: the write is undoable through ↶. The index is exposed
           as `data-clip-idx`, NOT `data-clip`: the latter is the grid PAD
           selector, and a second match for it while the menu is open would make
           every existing `[data-clip="n"]` locator ambiguous. -->
      <div class="prob-menu-sep" role="separator"></div>
      <button
        class="prob-menu-item danger"
        role="menuitem"
        disabled={!hasClip}
        title={hasClip
          ? 'Delete this clip (and its recorded automation). Undo with ↶.'
          : 'Nothing to clear — this slot is empty'}
        data-clip-idx={at.idx}
        data-testid={`clipplayer-menu-clear-${nodeId}`}
        onpointerenter={() => (probSub = null)}
        onclick={clearEditClip}>clear</button
      >
    </div>
    {#if probSub}
      <!-- The FLYOUT: one option list, placed BESIDE its parent row — to its
           right, or to its LEFT when the right side has no room, so it never
           covers the menu it came from. -->
      <div
        class="prob-menu prob-submenu"
        role="menu"
        aria-label={probSub.which === 'note'
          ? 'note probability'
          : probSub.which === 'pitch'
            ? 'pitch probability'
            : 'skip every'}
        use:cascadeMenu={{ rect: probSub.rect }}
        data-testid={`clipplayer-submenu-${probSub.which}-${nodeId}`}
      >
        {#if probSub.which === 'note'}
          <div class="prob-menu-list">
            {#each probMenuLevels() as level (level)}
              <button
                class="prob-menu-item"
                class:clip={isClip}
                class:checked={current === level}
                role="menuitemcheckbox"
                aria-checked={current === level}
                data-testid={isClip
                  ? `clipplayer-clip-prob-item-${level}`
                  : `clipplayer-prob-item-${level}`}
                onclick={() => pickProbLevel(level)}
                >{probPctLabel(probLevelToValue(level))}</button
              >
            {/each}
          </div>
        {:else if probSub.which === 'pitch'}
          <!-- PITCH PROBABILITY: how far the pitch may wander when the note
               fires (off = the authored pitch, exactly). 40 increments, the same
               grid as note probability. -->
          <div class="prob-menu-list">
            {#each pitchProbMenuLevels() as level (level)}
              <button
                class="prob-menu-item pitch"
                class:checked={curPitch === level}
                role="menuitemcheckbox"
                aria-checked={curPitch === level}
                data-testid={`clipplayer-pitch-prob-item-${level}`}
                title={level === 0
                  ? 'Fixed pitch — play exactly the note you drew (default)'
                  : `Pitch instability ${pitchProbLabel(pitchProbLevelToValue(level))} — the note may land on a nearby scale degree instead`}
                onclick={() => pickPitchProb(level)}
                >{level === 0 ? 'off (fixed)' : pitchProbLabel(pitchProbLevelToValue(level))}</button
              >
            {/each}
          </div>
        {:else}
          <div class="prob-menu-list">
            {#each playEveryLevels as n (n)}
              <button
                class="prob-menu-item"
                class:checked={curEvery === n}
                role="menuitemcheckbox"
                aria-checked={curEvery === n}
                data-testid={`clipplayer-play-every-item-${n}`}
                title={n === 1 ? 'Every loop (default)' : `Every ${n}th loop`}
                onclick={() => pickPlayEvery(n)}>{n === 1 ? '1 (every)' : n}</button
              >
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  /* The clip player's right-click menu. Moved here WHOLE from
     ClipplayerCard.svelte's <style> — same selectors, same values. */
  .prob-menu-backdrop {
    position: fixed;
    inset: 0;
    /* Portaled to <body>: sit above the dock drawer + patch-panel chrome
       (1001) + pickup cable (1002), below global modals/toasts (9000+) —
       same band as ControlContextMenu. */
    z-index: 2000;
    background: transparent;
    border: none;
    padding: 0;
    cursor: default;
  }
  .prob-menu {
    position: fixed;
    z-index: 2001; /* above its own backdrop (2000) — see .prob-menu-backdrop */
    min-width: 84px;
    max-height: 260px;
    overflow-y: auto;
    background: #1b1b1b;
    border: 1px solid var(--border, #333);
    border-radius: 4px;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.5);
    padding: 3px;
    font-size: 11px;
  }
  /* NOTE: there is no `.prob-menu-head` any more. The flat clip menu carried an
     INERT "Clip probability ▸" heading whose ▸ promised a flyout it did not
     have — the owner read it as a broken submenu, which is what it looked like.
     Every ▸ in this menu is now on a row that actually expands. */
  .prob-menu-list {
    display: flex;
    flex-direction: column;
  }
  .prob-menu-item {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    padding: 3px 8px;
    background: none;
    border: none;
    color: #ddd;
    text-align: left;
    cursor: pointer;
    border-radius: 3px;
  }
  .prob-menu-item:hover {
    background: hsl(280 45% 32%);
  }
  .prob-menu-item.checked {
    background: hsl(280 55% 40%);
    color: #fff;
  }
  .prob-menu-item.checked::after {
    content: '✓';
  }
  /* A DISABLED row (PASTE with an empty or scene-kind clipboard) stays VISIBLE
     and un-hoverable rather than vanishing: the type gate is a fact about the
     clipboard, and a row that disappears reads as a missing feature. */
  .prob-menu-item:disabled {
    color: #666;
    cursor: default;
  }
  .prob-menu-item:disabled:hover {
    background: none;
  }
  /* A SUBMENU parent row. The ▸ is the affordance the owner's screenshot already
     used on the (inert) headers — here it marks a row that actually expands. */
  .prob-menu-item.sub::after {
    content: '▸';
    color: #9a8fb0;
  }
  .prob-menu-item.sub.open {
    background: hsl(280 45% 32%);
  }
  /* The flyout is a sibling fixed box, not a nested one: `cascadeMenu` positions
     it against the real viewport, so it must not be inside a clipped/scrolling
     parent. It shares .prob-menu's chrome and adds only the taller scroll cap
     the long option lists need. */
  .prob-submenu {
    max-height: 300px;
  }
  /* The CLIP-DEFAULT probability list tints ORANGE (matching the clip-default
     note colour + the Launchpad clip-PROB page's orange bar), distinct from the
     purple per-note list — so the same row opened from a PAD and from a NOTE is
     visibly a different scope. */
  .prob-menu-item.clip:hover {
    background: hsl(30 60% 32%);
  }
  .prob-menu-item.clip.checked {
    background: hsl(30 75% 42%);
    color: #fff;
  }
  /* The PITCH-PROBABILITY row tints TEAL — a third menu hue, which is safe here
     (a menu row is 84 px wide with a text label beside it) even though a third
     hue on a 15×13 px note cell is not. */
  .prob-menu-item.pitch:hover {
    background: hsl(180 45% 28%);
  }
  .prob-menu-item.pitch.checked {
    background: hsl(180 55% 34%);
    color: #fff;
  }
  /* CLEAR — the one destructive row in the clip menu: ruled off from the
     probability list and tinted red so it can't be mistaken for a level. */
  .prob-menu-sep {
    height: 1px;
    margin: 3px 4px;
    background: var(--border, #333);
  }
  .prob-menu-item.danger {
    color: #e88;
  }
  .prob-menu-item.danger:hover {
    background: hsl(0 55% 32%);
    color: #fff;
  }
</style>
