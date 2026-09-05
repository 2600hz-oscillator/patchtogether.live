<script lang="ts">
  // ClockedRunnerEditorBody — the CODE BUFFER at the head of the CLOCKED RUNNER
  // dock faceplate, and the whole reason this module needs a body rather than a
  // ranking.
  //
  // ── WHY A BODY ──────────────────────────────────────────────────────────────
  //
  // `resolveFaceControl` resolves a face key to exactly three things: a PARAM id,
  // a family TEMPLATE (`<id>-{n}`), or a legend STATIC. A text buffer is none of
  // them — there is no cell kind for editing text, and inventing one would mean a
  // primitive whose "value" is a document. electraControl met the same wall with
  // thirty-six in-place rename fields and landed here for the same mechanical
  // reason: `fullViewBody` hosts arbitrary markup, so the surface a module is
  // OPERATED from does not have to be expressible as a rank.
  //
  // ⚠ THAT IS NOT A REASON TO REFUSE THE PROMOTION, WHICH IS WHAT THE MIGRATION
  // INVENTORY CONCLUDED FROM THE SAME PREMISE ("text editing has no cell kind and
  // no glyph"). Both halves of that sentence are TRUE and neither is a blocker:
  // the buffer is this slot's business, and `glyph: 'none'` is the correct
  // declaration for a def with no audio output rather than a missing feature.
  //
  // ── WHAT IT PAINTS, AND WHY EACH PART IS ALLOWED TO ─────────────────────────
  //
  //   * THE BUFFER — the user's own text. Not derived state: it is the document
  //     the module runs, the way a fader's position is the value it sets.
  //   * TWO LAMPS, through `StatusLed`: a static literal caption, a boolean that
  //     IS the picture, and the measurement in `aria-label` / `title`. Nothing
  //     about their state reaches a text node.
  //
  // ⚠ WHAT THE PROMOTION DELETED. `ClockedRunnerCard.svelte` paints a status line
  // giving the number of evaluations so far, the division in brackets, or else
  // the last error. That is a COUNT and a state sentence — the deleted-readout
  // shape, three mechanisms after the owner first refused it. It is gone as TEXT
  // and intact as INFORMATION: the count, the tempo the period was derived from
  // and the earlier-failure total are the FIRING lamp's sentence, and the error
  // is the ERROR lamp's. See `clocked-runner-cell-actions.ts` for both.
  //
  // ⚠ AND THIS COMMENT DOES NOT SPELL EITHER STRING OUT, deliberately. The
  // inverse assertion in `codebuffer-face-model.test.ts` GREPS RAW SOURCE and
  // cannot tell code from a comment (the electraControl / backdraft trap), so
  // quoting the deleted line here to say it is deleted would redden the gate that
  // proves it. Verified: it did, on the first run.
  //
  // ⚠ NO RESIZE GRIP, DELIBERATELY. The card's corner grip writes
  // `node.data.width/height`, which size THE CARD; a dock faceplate is sized by
  // the dock pane (`DockFullView`'s own `max-height` + scroll region) and a lane
  // tile is a fixed 192 px, so a grip here would be a control that moves numbers
  // nothing reads. videoOut settled the same question the same way on the owner's
  // instruction ("it does not need the arbitrary resizing"). ⚠ `node.data.width`
  // IS STILL READ, by the spawn geometry in `livecode-cell-actions`, so a saved
  // rack's new modules land exactly where they always did — dropping the grip
  // does not make the key dead.
  //
  // ⚠ THE DIVISION IS NOT HERE. It is the ranked `selector` cell in the band
  // below, which is what puts it on the LANE TILE too — the whole point of making
  // it a cell. A second picker on the same plate would be one setting with two
  // affordances (the es9 rule).
  //
  // ⚠ THE POLL IS THE CARD'S, AND IT IS A READ. The tick loop that actually runs
  // this body lives in the FACTORY's closure (`$lib/audio/modules/clocked-runner`,
  // `clock.subscribe(tick)`), so it is graph-driven and keeps running with no card
  // and no faceplate mounted anywhere. This component only looks at it.

  import { onDestroy, onMount } from 'svelte';
  import { patch } from '$lib/graph/store';
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
  import { StatusLed } from '$lib/ui/controls';
  import { createDebouncedCommit } from '$lib/ui/modules/debounced-commit';
  import { makeEditor, type EditorHandle } from '$lib/livecode/editor';
  import { makeCompletionSource } from '$lib/livecode/completions';
  import { makeLinter } from '$lib/livecode/diagnostics';
  import { mutateNode } from '$lib/graph/mutate';
  import type { ModuleNode } from '$lib/graph/types';
  import { CODE_BUFFER_FACE_H, CODE_BUFFER_FACE_MIN_W } from '$lib/ui/modules/code-buffer-face';
  import {
    clockedRunnerDivisionValue,
    clockedRunnerErrorDetail,
    clockedRunnerFiringDetail,
    clockedRunnerTelemetry,
    type ClockedRunnerTelemetry,
  } from '$lib/ui/modules/clocked-runner-cell-actions';

  let { nodeId }: { nodeId: string } = $props();

  // ⚠ EVERY DERIVATION BELOW READS `v` DIRECTLY, NOT THROUGH A NODE OBJECT, and
  // the difference is the whole reason this repaints. `patch.nodes[id]` is a Yjs
  // proxy whose IDENTITY never changes, so a derived chained off it re-evaluates
  // to the SAME object and never marks its dependants dirty — the graph updates
  // and the view silently shows what it had at mount. On THIS surface that would
  // mean a `clocked()` call rewriting the body never appearing in the buffer.
  // `nodeVersion(id)` is the node's own Y.Doc revision, a value that moves.
  let v = $derived(nodeVersion(nodeId));
  let division = $derived.by<string>(() => {
    void v;
    return clockedRunnerDivisionValue(patch.nodes[nodeId] as ModuleNode | undefined);
  });
  let storedSource = $derived.by<string>(() => {
    void v;
    const node = patch.nodes[nodeId] as ModuleNode | undefined;
    const s = (node?.data as Record<string, unknown> | undefined)?.source;
    return typeof s === 'string' ? s : '';
  });

  // ── The editor ───────────────────────────────────────────────────────────
  //
  // #1583: the debounce FLUSHES on unmount instead of dropping its pending value.
  // A faceplate collapse and an LRU eviction are VIEW events, not "the user
  // abandoned the edit" — and on this surface they are the common case, because
  // the dock evicts a pane the moment a third module is expanded.
  let editorEl: HTMLDivElement | null = $state(null);
  let editor: EditorHandle | null = null;
  const COMMIT_DEBOUNCE_MS = 250;

  function commitSource(value: string) {
    const target = patch.nodes[nodeId] as ModuleNode | undefined;
    if (!target) return;
    if ((target.data as Record<string, unknown> | undefined)?.source === value) return;
    mutateNode(nodeId, (live) => {
      if (!live.data) live.data = {};
      (live.data as Record<string, unknown>).source = value;
    });
  }

  const draft = createDebouncedCommit<string>(commitSource, COMMIT_DEBOUNCE_MS);

  onMount(() => {
    if (!editorEl) return;
    editor = makeEditor({
      parent: editorEl,
      doc: storedSource,
      onChange: (value) => draft.schedule(value),
      completionSource: makeCompletionSource(() => ({
        liveNodes: patch.nodes,
        liveEdges: patch.edges,
      })),
      lintSource: makeLinter(() => ({
        liveNodes: patch.nodes,
        liveEdges: patch.edges,
      })),
      showGutter: false,
    });
  });

  // Remote → editor (a collaborator's edit, or a fresh `clocked()` call from the
  // parent LIVECODE rewriting this runner's body).
  $effect(() => {
    const s = storedSource;
    if (!editor) return;
    editor.setDoc(s);
  });

  onDestroy(() => {
    draft.flush();
    editor?.destroy();
    editor = null;
  });

  // ── Telemetry ────────────────────────────────────────────────────────────
  //
  // Polled rather than subscribed: the handle exposes plain `read(key)` keys and
  // owns no listener seam. 200 ms is the card's own cadence.
  let telemetry = $state<ClockedRunnerTelemetry>({ lastError: null, fires: 0, errors: 0, bpm: 0 });
  const POLL_MS = 200;
  let pollId: ReturnType<typeof setInterval> | null = setInterval(() => {
    telemetry = clockedRunnerTelemetry(nodeId);
  }, POLL_MS);
  onDestroy(() => {
    if (pollId !== null) clearInterval(pollId);
    pollId = null;
  });

  let firingDetail = $derived(clockedRunnerFiringDetail(telemetry, division));
  let errorDetail = $derived(clockedRunnerErrorDetail(telemetry));
  let bufferName = $derived(
    `Clocked callback body — JavaScript, re-evaluated every ${division} of the rack tempo`,
  );
</script>

<div
  class="clocked-body"
  data-testid="clocked-runner-body-{nodeId}"
  style={`--buf-min-w:${CODE_BUFFER_FACE_MIN_W}px;--buf-h:${CODE_BUFFER_FACE_H}px`}
>
  <div
    bind:this={editorEl}
    class="editor nodrag"
    data-testid="clocked-runner-editor-{nodeId}"
    role="group"
    aria-label={bufferName}
  ></div>

  <span class="lamps">
    <StatusLed
      caption="FIRING"
      lit={telemetry.fires > 0}
      detail={firingDetail}
      testid="clocked-runner-led-firing-{nodeId}"
    />
    <StatusLed
      caption="ERROR"
      lit={!!telemetry.lastError}
      tone="warn"
      detail={errorDetail}
      testid="clocked-runner-led-error-{nodeId}"
    />
  </span>
</div>

<style>
  .clocked-body {
    display: flex;
    flex-direction: column;
    gap: 6px;
    width: 100%;
    min-width: 0;
  }
  /* Both numbers come from `code-buffer-face.ts` through custom properties —
     ONE place, shared with LIVECODE's body and read back by both face-model
     tests, rather than a literal re-typed per surface. */
  .editor {
    width: 100%;
    min-width: var(--buf-min-w);
    height: var(--buf-h);
    border: 1px solid var(--border, #333);
    border-radius: 2px;
    overflow: hidden;
  }
  .editor :global(.cm-editor) { height: 100%; }
  .editor :global(.cm-editor.cm-focused) {
    outline: 1px solid var(--accent-dim, #456);
    outline-offset: -1px;
  }
  .lamps {
    display: inline-flex;
    align-items: center;
    gap: 12px;
  }
</style>
