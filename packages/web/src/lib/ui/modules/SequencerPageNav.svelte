<script lang="ts">
  // SequencerPageNav — shared page-navigation + HOLD-view-lock control used by
  // every step-based sequencer card (DRUMSEQZ, POLYSEQZ, MACSEQ, Sequencer).
  //
  // UI shape:
  //   [ < ]  page X / N  [ > ]  [ HOLD ]
  // HOLD on → the visible page is user-controlled (auto-page-during-playback
  // is suppressed). When the playhead is on a non-visible page, a small
  // indicator on the < or > arrow shows which page the playhead is on
  // ("▶ pN"), nudging the user to navigate back.
  //
  // Per-user view state: hold + userPage are local Svelte state in each
  // card; they are NOT persisted via Y.Doc. Two peers viewing the same rack
  // can be on different pages with different HOLD states.

  export const PAGE_SIZE = 16;

  interface Props {
    /** Live length (sequencer's `length` param). Determines page count. */
    length: number;
    /** Sequencer's current step (audio-thread playhead). */
    currentStep: number;
    /** User-selected visible page (state owned by the card). */
    userPage: number;
    /** HOLD toggle state (true = freeze the visible page). */
    hold: boolean;
    /** Cap on number of pages (128 / 16 = 8). */
    maxPages?: number;
    /** Optional test-id suffix so multiple cards have stable selectors. */
    testIdPrefix?: string;
    /** Setter for userPage (the card owns the state). */
    onUserPageChange: (p: number) => void;
    /** Setter for hold (the card owns the state). */
    onHoldChange: (hold: boolean) => void;
  }

  let {
    length,
    currentStep,
    userPage,
    hold,
    maxPages = 8,
    testIdPrefix = 'seq-page',
    onUserPageChange,
    onHoldChange,
  }: Props = $props();

  // Number of pages = ceil(length / PAGE_SIZE), clamped to maxPages.
  let pageCount = $derived(
    Math.max(1, Math.min(maxPages, Math.ceil(Math.max(1, length) / PAGE_SIZE))),
  );

  // Page the playhead is currently on (derived from currentStep).
  let playheadPage = $derived(Math.min(pageCount - 1, Math.floor(currentStep / PAGE_SIZE)));

  // Visible page = HOLD on → userPage; else → playheadPage.
  // (Computed here for the label only; the card derives the same value to
  // slice its grid.)
  let visiblePage = $derived(hold ? Math.min(pageCount - 1, userPage) : playheadPage);

  // Indicator for "playhead is on a different page" cue.
  let playheadElsewhere = $derived(hold && playheadPage !== visiblePage);
  let playheadDirection = $derived(
    !playheadElsewhere ? null : playheadPage > visiblePage ? 'right' : 'left',
  );

  function goPrev() {
    if (!hold) onHoldChange(true);
    const next = Math.max(0, Math.min(pageCount - 1, userPage) - 1);
    onUserPageChange(next);
  }
  function goNext() {
    if (!hold) onHoldChange(true);
    const next = Math.min(pageCount - 1, Math.min(pageCount - 1, userPage) + 1);
    onUserPageChange(next);
  }
  function toggleHold() {
    onHoldChange(!hold);
  }
</script>

<div class="page-nav" data-testid={`${testIdPrefix}-nav`}>
  <button
    type="button"
    class="page-btn"
    class:cue={playheadDirection === 'left'}
    disabled={visiblePage === 0 && !playheadElsewhere}
    title={playheadDirection === 'left' ? `Playhead on page ${playheadPage + 1}` : 'Previous page'}
    data-testid={`${testIdPrefix}-prev`}
    onclick={goPrev}
  >
    &lt;{#if playheadDirection === 'left'}<span class="cue-dot">&#9654; p{playheadPage + 1}</span>{/if}
  </button>

  <span class="page-label" data-testid={`${testIdPrefix}-label`}>
    p{visiblePage + 1}/{pageCount}
  </span>

  <button
    type="button"
    class="page-btn"
    class:cue={playheadDirection === 'right'}
    disabled={visiblePage === pageCount - 1 && !playheadElsewhere}
    title={playheadDirection === 'right' ? `Playhead on page ${playheadPage + 1}` : 'Next page'}
    data-testid={`${testIdPrefix}-next`}
    onclick={goNext}
  >
    {#if playheadDirection === 'right'}<span class="cue-dot">&#9654; p{playheadPage + 1}</span>{/if}&gt;
  </button>

  <button
    type="button"
    class="hold-btn"
    class:on={hold}
    title={hold ? 'HOLD on — visible page is frozen' : 'HOLD off — page follows playhead'}
    data-testid={`${testIdPrefix}-hold`}
    onclick={toggleHold}
  >HOLD</button>
</div>

<style>
  .page-nav {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-family: ui-monospace, monospace;
    font-size: 0.6rem;
  }
  .page-btn {
    background: #2a2f3a;
    border: 1px solid #404652;
    color: var(--text);
    border-radius: 3px;
    height: 18px;
    padding: 0 6px;
    line-height: 1;
    cursor: pointer;
    font-family: ui-monospace, monospace;
    font-size: 0.65rem;
    display: inline-flex;
    align-items: center;
    gap: 3px;
  }
  .page-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .page-btn.cue {
    border-color: var(--accent, #c084fc);
    color: var(--accent, #c084fc);
  }
  .cue-dot {
    font-size: 0.5rem;
    opacity: 0.9;
  }
  .page-label {
    min-width: 50px;
    text-align: center;
    color: var(--text-dim);
  }
  .hold-btn {
    background: #2a2f3a;
    border: 1px solid #404652;
    color: var(--text-dim);
    border-radius: 3px;
    height: 18px;
    padding: 0 8px;
    line-height: 1;
    cursor: pointer;
    font-family: ui-monospace, monospace;
    font-size: 0.6rem;
    margin-left: 6px;
  }
  .hold-btn.on {
    background: var(--accent, #c084fc);
    border-color: var(--accent, #c084fc);
    color: #1a1d23;
  }
</style>
