<script lang="ts">
  // packages/web/src/lib/ui/modules/seqtris/SeqtrisWellBody.svelte
  //
  // THE SEQTRIS DOCK FULL-VIEW BODY — the well, the LAUNCHPAD'S OWN SCENE
  // COLUMN, and the CONNECT gesture. Everything on the legacy card that is not
  // a param, a jack or the title.
  //
  // ⚠ THE EIGHT-BUTTON COLUMN IS NOT A CONTROL LIST, AND THAT IS WHY IT CANNOT
  // BE FACE CELLS. It is the hardware's scene-launch column, laid out in
  // hardware order — top to bottom, INCLUDING THE TWO DEAD BUTTONS — precisely
  // so the mapping is learnable from the screen without a Launchpad plugged in.
  // `face.order` is a PRIORITY RANKING, so ranking these would reorder them,
  // which is the one thing they must not do; and the two dead rows have no
  // `ParamDef` to rank at all. The column is unrankable by construction, and a
  // PF-14 `panel` cell's first legal rank is 7 against a two-param module, so
  // this slot is the only route rather than a preference.
  //
  // ⚠ THE ROSTER IS IMPORTED, NEVER RE-DERIVED. `SEQTRIS_SCENE_ACTIONS` is the
  // binder's own eight-entry list and a second copy is how the screen and the
  // hardware drift. It is TOP-ORIGIN, and the codebase has two disagreeing row
  // conventions: `decodeMidiMessage` hands back `ev.row` measured from the
  // BOTTOM while `SCENE_CCS` is written TOP-first, and the binder's header
  // records that "reading `ev.row` instead would invert the whole controller and
  // every button would still 'work'". Indexing the exported roster inherits the
  // correct convention; tidying the `null`s out, sorting by label, or dropping
  // the `aria-hidden` spacers would break the learnability this surface exists
  // to provide and NOTHING IN CI WOULD NOTICE.
  //
  // ⚠ NEVER CALL `launchpad.release()`. That is the node's death, called from
  // the factory's `dispose` — a component lifecycle hook releasing the hardware
  // is #1728 and the binder's header refuses it by name. `unbind()` below is a
  // USER GESTURE, which is a different thing.
  //
  // ⚠ NO COUNTERS, NO LINES PILL, NO GAME OVER BANNER. `snapshot()` exposes
  // `lines`, `totalLines`, `gameOvers`, `notesFired`, `spawns`, `lineFires`,
  // `tiedDrops` and `clockPulses`, and the card shows NONE of them — its own
  // header says "No timers, no counters, no live numbers on the plate." That is
  // the owner's density ruling satisfied before it was made, and the face adds
  // nothing back.
  import { patch } from '$lib/graph/store';
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
  import { useEngine } from '$lib/audio/engine-context';
  import { StatusLed } from '$lib/ui/controls';
  import type { ModuleNode } from '$lib/graph/types';
  import type { SeqtrisCardApi } from '$lib/audio/modules/seqtris';
  import {
    SEQTRIS_SCENE_ACTIONS,
    type SeqtrisLaunchpadStatus,
  } from '$lib/audio/seqtris-launchpad';
  // ⚠ `import type` ONLY. `launchpad-device.svelte.ts` declares `$state` at
  // module scope and the ART harness runs the audio registry under plain vitest
  // with no Svelte plugin; a VALUE import anywhere in this closure re-opens the
  // measured `ReferenceError: $state is not defined`. Type imports are erased.
  // `seqtris.test.ts`'s lazy-import guard covers this file.
  import type { LaunchpadPort } from '$lib/control/launchpad/launchpad-device.svelte';
  import SeqtrisWell from './SeqtrisWell.svelte';
  import { bumpSeqtrisRevision, seqtrisRevision } from './seqtris-surface.svelte';

  interface Props {
    /** The graph node this faceplate is showing — the ONLY prop the slot gets
     *  (`ShellExtensionFullViewBodyProps`). */
    nodeId: string;
  }
  let { nodeId }: Props = $props();

  /** The dock's well. ⚠ NOT INFLATED TO FILL A WIDE PLATE — "we do not want
   *  useless gray horizontal space on cards, ever. prefer compact." The column
   *  beside it is the card's own 52 px. */
  const DOCK_WELL_PX = 176;

  /** Button captions, top to bottom, matching SEQTRIS_SCENE_ACTIONS. Carried
   *  over verbatim: already lowercase, already compact, already decimal-free. */
  const CONTROL_LABELS: Record<string, string> = {
    reset: 'reset',
    drop: 'drop',
    rotateLeft: 'rot ←',
    rotateRight: 'rot →',
    moveLeft: 'move ←',
    moveRight: 'move →',
  };

  /**
   * THE HARDWARE MAPPING, as one sentence per live button — the card's own
   * `title` text, now also the accessible name.
   *
   * ⚠ IT IS A FUNCTION SO THE SPEAKABLE AND PAINTED EXPRESSIONS ARE
   * STRUCTURALLY DIFFERENT, which is the `control-grid` role's own leg: a body
   * that binds `aria-label={x}` and ALSO renders `{x}` as a text node is the
   * resting-text violation wearing the ruling's mechanism as a disguise. Here
   * the button PAINTS `CONTROL_LABELS[action]` (a control caption, which the
   * ruling permits) and SPEAKS this — the row number plus the caption, which is
   * the thing a caption alone cannot say and the whole reason the column exists
   * on screen at all.
   */
  function sceneName(index: number, action: string): string {
    return `Scene button ${index + 1} — ${CONTROL_LABELS[action]}`;
  }

  const engineCtx = useEngine();

  function api(): SeqtrisCardApi | null {
    const engine = engineCtx.get();
    const node = patch.nodes[nodeId] as ModuleNode | undefined;
    if (!engine || !node) return null;
    return (engine.read(node, 'card-api') as SeqtrisCardApi | undefined) ?? null;
  }

  // ⚠ THE `revision` SEAM, AND OMITTING IT IS A SILENT FREEZE. `launchpadStatus()`
  // reads a per-binding closure that nothing invalidates, so without a tick the
  // status line, the LED and the CONNECT/Unbind swap never update after the
  // first paint — and no gate in the tree reads any of the three. It is shared
  // rather than component-local so the LANE TILE's lamp, mounted at the same
  // time on the same node, cannot disagree with this pane.
  let status = $derived.by<SeqtrisLaunchpadStatus | null>(() => {
    void seqtrisRevision();
    void nodeVersion(nodeId);
    return api()?.launchpadStatus() ?? null;
  });
  let ports = $derived<readonly LaunchpadPort[]>(status?.ports ?? []);
  let bound = $derived(status?.kind === 'bound');
  let problem = $derived(
    status !== null
      && (status.kind === 'no-device' || status.kind === 'claimed' || status.kind === 'unsupported'),
  );

  function onConnect(): void {
    // ⚠ STRAIGHT FROM THE CLICK HANDLER. An `await` above `requestMIDIAccess`
    // spends the transient user activation and Chromium refuses to prompt —
    // carried over verbatim from the card, including the shape.
    void api()?.connect().then(() => {
      bumpSeqtrisRevision();
    });
    bumpSeqtrisRevision();
  }
  function onPick(port: LaunchpadPort): void {
    api()?.bindPort(port);
    bumpSeqtrisRevision();
  }
  function onUnbind(): void {
    api()?.unbindPort();
    bumpSeqtrisRevision();
  }
  function onControl(index: number): void {
    // ⚠ INDEXES the roster, never re-derives it.
    const action = SEQTRIS_SCENE_ACTIONS[index];
    if (!action) return;
    api()?.press(action);
    bumpSeqtrisRevision();
  }
</script>

<div class="seqtris-face-body" data-testid="seqtris-face-body">
  <div class="bind-row">
    <!-- ⚠ A LAMP WITH A `detail`, NOT A LAMP PLUS A REPEATED SENTENCE. The
         status prose below is the card's, kept for parity; this carries the
         same state to the a11y tree in the primitive's own form. -->
    <StatusLed
      caption="PAD"
      lit={bound}
      tone={problem ? 'warn' : 'accent'}
      detail={status?.message ?? 'No SEQTRIS engine on this node yet.'}
      testid="seqtris-face-led"
    />
    {#if bound}
      <button type="button" class="mini nodrag" onclick={onUnbind} data-testid="seqtris-face-unbind">
        Unbind
      </button>
    {:else}
      <button type="button" class="mini nodrag" onclick={onConnect} data-testid="seqtris-face-connect">
        Connect Launchpad
      </button>
    {/if}
  </div>

  {#if !bound && ports.length > 0}
    <div class="picker" data-testid="seqtris-face-picker">
      {#each ports as port, i (port.outputId + i)}
        <!-- ⚠ KEYED BY INDEX, NOT NAME, and the keying is load-bearing: Windows
             reports IDENTICAL port names for a Launchpad's two ports (the
             dual-port finding), so a name-keyed testid would collide. -->
        <button
          type="button"
          class="mini nodrag"
          onclick={() => onPick(port)}
          data-testid={`seqtris-face-port-${i}`}
        >
          {port.name}
        </button>
      {/each}
    </div>
  {/if}

  <!-- ⚠ THE CARD'S `<p class="status">` IS DELETED, NOT HIDDEN — AND ALL SIX
       STRINGS SURVIVE VERBATIM. `seqtrisStatusMessage()` is untouched (still
       six strings, still unit-tested at the source, still not re-typed here);
       what changed is where they land. On the card they were a SENTENCE OF
       DERIVED SERVICE STATE painted as a resting text node, which is neither a
       module name, a section label, a control caption nor an option name — the
       four things a resting faceplate may paint. They now reach `aria-label`
       and `title` through `StatusLed`'s `detail` above: speakable, assertable,
       hoverable, unpainted. That is the recorderbox promotion's exact move
       (three resting readouts, same disposal) and it is what makes this body's
       declared `control-grid` role true rather than asserted.
       ⚠ ONE NAMED DELTA: the card put `role="alert"` on that paragraph in the
       `problem` states, so a screen reader announced a lost device without being
       asked. The lamp's `tone="warn"` carries the same condition visually and
       its `aria-label` carries the same sentence, but the LIVE announcement is
       gone. Reported rather than glossed. -->

  <!-- The column's height tracks the well's from ONE constant, so the two
       cannot drift apart in a later edit to either. -->
  <div class="play" style={`--dock-well-px: ${DOCK_WELL_PX}px;`}>
    <SeqtrisWell {nodeId} size={DOCK_WELL_PX} testidPrefix="seqtris-face" screenToggle />

    <div class="controls" data-testid="seqtris-face-controls">
      {#each SEQTRIS_SCENE_ACTIONS as action, i (i)}
        {#if action === null}
          <!-- ⚠ RENDERED, IN POSITION. A dead button is left DARK on the
               hardware so the player can see it is dead; deleting the spacer
               here would slide the six live captions up two rows and the screen
               would teach the wrong mapping. -->
          <span class="scene dead" aria-hidden="true"></span>
        {:else}
          <!-- ⚠ THE CAPTION IS PAINTED, THE MAPPING IS SPOKEN. `title` is the
               card's own tooltip, carried over; `aria-label` is the same
               sentence reaching the a11y tree, which is how the hardware
               mapping is learnable WITHOUT a Launchpad — the inventory's
               stated purpose for this column. -->
          <button
            type="button"
            class="scene nodrag"
            onclick={() => onControl(i)}
            title={sceneName(i, action)}
            aria-label={sceneName(i, action)}
            data-testid={`seqtris-face-control-${action}`}
          >
            {CONTROL_LABELS[action]}
          </button>
        {/if}
      {/each}
    </div>
  </div>
</div>

<style>
  .seqtris-face-body {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 4px 0 2px;
  }
  .bind-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .mini {
    font-size: 10px;
  }
  .picker {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .play {
    display: flex;
    gap: 6px;
    align-items: flex-start;
  }
  .controls {
    display: grid;
    grid-template-rows: repeat(8, 1fr);
    gap: 1px;
    width: 52px;
    height: var(--dock-well-px, 176px);
    flex: none;
  }
  .scene {
    font-size: 8px;
    line-height: 1;
    padding: 0;
    border-radius: 2px;
    white-space: nowrap;
    overflow: hidden;
  }
  .scene.dead {
    opacity: 0.15;
    border-radius: 2px;
    background: #14161c;
  }
</style>
