<script lang="ts">
  // LivecodeEditorBody — the SCRIPT BUFFER and its output at the head of the
  // LIVECODE dock faceplate.
  //
  // ── WHY A BODY ──────────────────────────────────────────────────────────────
  //
  // `resolveFaceControl` resolves a face key to a PARAM id, a `-{n}` family
  // TEMPLATE or a legend STATIC. A text document is none of them: there is no
  // cell kind whose value is a buffer, and there is no cell kind whose value is a
  // console. electraControl met the same wall with thirty-six in-place rename
  // fields and landed here for the same mechanical reason — `fullViewBody` hosts
  // arbitrary markup, so the surface a module is OPERATED from does not have to
  // be expressible as a rank.
  //
  // ⚠ THE RUN GESTURE IS NOT HERE. It is the ranked `action` cell in the band
  // below, which is what puts it on the LANE TILE — and that is a real gain
  // rather than bookkeeping: before promotion, running a script required first
  // discovering that the dock full view exists. A second Run button on this plate
  // would be one gesture with two affordances (the es9 rule), and worse, two
  // answers to "what does Run do". Both surfaces call
  // `runLivecodeNode(nodeId)` in `$lib/ui/modules/livecode-cell-actions.ts`.
  //
  // ── WHAT IT PAINTS, AND WHY EACH PART IS ALLOWED TO ─────────────────────────
  //
  //   * THE BUFFER — the user's own text. Not derived state: it is the document
  //     the module runs, the way a fader's position is the value it sets.
  //   * THE OUTPUT LOG — what the SCRIPT printed through `log()`. This module has
  //     no ports at all, so the log is literally its only output; deleting it
  //     would delete a documented API function's destination. It is not derived
  //     state ABOUT a control, it is the product of a gesture the player just
  //     performed. ⚠ AND IT IS ABSENT AT REST — `lastRun` is unset on a node that
  //     has never been run, so the resting plate paints no log and no
  //     empty-state placeholder. The card's italic placeholder line is GONE
  //     rather than relocated: the plate has other content, so the
  //     empty-state-instruction licence (midiclock, es9) does not reach it.
  //   * ONE LAMP, through `StatusLed`: a static literal caption, a boolean that IS
  //     the picture, and the sentence in `aria-label` / `title`.
  //
  // ⚠ WHAT THE PROMOTION DELETED. `LivecodeCard.svelte` paints a status line: an
  // instruction to type and press the button, then either an OK line carrying how
  // many rack changes landed or a line:col error. An instruction, a COUNT and
  // an error sentence, all painted at rest outside any control — the
  // deleted-readout shape. The instruction is gone outright (the RUN cell's own
  // caption says what to do); the other two are the RUN lamp's sentence. See
  // `livecodeRunDetail`.
  //
  // ⚠ AND THIS COMMENT DOES NOT SPELL ANY OF THOSE STRINGS OUT, deliberately.
  // The inverse assertions in `codebuffer-face-model.test.ts` GREP RAW SOURCE and
  // cannot tell code from a comment (the electraControl / backdraft trap), so
  // quoting a deleted line here to say it is deleted would redden the gate that
  // proves it. Verified: it did, on the first run.
  //
  // ⚠ AND THE OUTCOME MOVED FROM COMPONENT STATE TO `node.data`, WHICH FIXES A
  // LIVE DEFECT RATHER THAN JUST RELOCATING ONE. The card kept `lastResult` in
  // `$state`, so collapsing the pane — or being LRU-evicted when a third module
  // is expanded — silently discarded the log and the error you were reading, with
  // no user action against them. That is the #1531 / #1574 / #1583 class. The
  // record now lives on the node, so it survives a remount, a reload and a tab
  // switch, and it syncs to whoever else is in the rackspace.
  //
  // ⚠ NO RESIZE GRIP, DELIBERATELY. The card's corner grip writes
  // `node.data.width/height`, which size THE CARD; a dock faceplate is sized by
  // the dock pane and a lane tile is a fixed 192 px, so a grip here would move
  // numbers nothing reads. videoOut settled the same question the same way on the
  // owner's instruction. The card keeps its grip (`?shell=legacy` still renders
  // it) and `node.data.width` is still READ — by the spawn geometry in
  // `livecode-cell-actions`, so a saved rack's new modules land where they did.

  import { onDestroy, onMount } from 'svelte';
  import { patch } from '$lib/graph/store';
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
  import { StatusLed } from '$lib/ui/controls';
  import { createDebouncedCommit } from '$lib/ui/modules/debounced-commit';
  import { makeEditor, type EditorHandle } from '$lib/livecode/editor';
  import { makeCompletionSource } from '$lib/livecode/completions';
  import { makeLinter } from '$lib/livecode/diagnostics';
  import { testHooksEnabled } from '$lib/dev/test-hooks';
  import type { ModuleNode } from '$lib/graph/types';
  import {
    CODE_BUFFER_FACE_H,
    CODE_BUFFER_FACE_MIN_W,
    CODE_BUFFER_LOG_MAX_H,
  } from '$lib/ui/modules/code-buffer-face';
  import {
    commitLivecodeText,
    livecodeRunDetail,
    livecodeRunRecord,
    livecodeStoredText,
    registerLivecodeEditor,
    runLivecodeNode,
  } from '$lib/ui/modules/livecode-cell-actions';

  let { nodeId }: { nodeId: string } = $props();

  // ⚠ EVERY DERIVATION BELOW READS `v` DIRECTLY, NOT THROUGH `node`, and the
  // difference is the whole reason any of this repaints. `patch.nodes[id]` is a
  // Yjs proxy whose IDENTITY never changes, so a derived chained off `node`
  // re-evaluates to the SAME object and never marks its dependants dirty — the
  // graph updates and the view silently shows what it had at mount. Nothing
  // throws, and a test that reads `node.data` PASSES on it. `nodeVersion(id)` is
  // the node's own Y.Doc revision, which is a value that actually moves.
  let v = $derived(nodeVersion(nodeId));
  let node = $derived.by<ModuleNode | undefined>(() => {
    void v;
    return patch.nodes[nodeId] as ModuleNode | undefined;
  });
  let storedText = $derived.by<string>(() => {
    void v;
    return livecodeStoredText(patch.nodes[nodeId] as ModuleNode | undefined);
  });
  let record = $derived.by(() => {
    void v;
    return livecodeRunRecord(patch.nodes[nodeId] as ModuleNode | undefined);
  });
  let logLines = $derived<string[]>(record?.log ?? []);
  let runDetail = $derived(livecodeRunDetail(record));

  // ── The editor ───────────────────────────────────────────────────────────
  let editorEl: HTMLDivElement | null = $state(null);
  let editor: EditorHandle | null = null;
  const COMMIT_DEBOUNCE_MS = 250;

  // #1583: the debounce FLUSHES on unmount instead of dropping its pending value.
  // `createDebouncedCommit` exposes no `cancel`, so the original defect —
  // `clearTimeout(commitTimer)` in onDestroy — is unwritable here.
  const draft = createDebouncedCommit<string>(
    (value) => commitLivecodeText(nodeId, value),
    COMMIT_DEBOUNCE_MS,
  );

  /** What the RUN action reads: flush anything pending, then hand back the live
   *  buffer. Registered node-keyed so a press on the LANE TILE — where this body
   *  is not mounted — falls back to the committed text with nothing pending. */
  function flushToText(): string {
    draft.flush();
    return editor ? editor.view.state.doc.toString() : storedText;
  }

  let releaseEditor: (() => void) | null = null;

  onMount(() => {
    if (!editorEl) return;
    editor = makeEditor({
      parent: editorEl,
      doc: storedText,
      onChange: (value) => draft.schedule(value),
      completionSource: makeCompletionSource(() => ({
        liveNodes: patch.nodes,
        liveEdges: patch.edges,
      })),
      lintSource: makeLinter(() => ({
        liveNodes: patch.nodes,
        liveEdges: patch.edges,
      })),
    });
    releaseEditor = registerLivecodeEditor(nodeId, flushToText);
  });

  // Remote → editor (a collaborator's edit arriving over the shared document).
  $effect(() => {
    const t = storedText;
    if (!editor) return;
    editor.setDoc(t);
  });

  onDestroy(() => {
    // FLUSH, never cancel: a collapse or an LRU eviction is a VIEW event, not a
    // signal that the edit was abandoned (#1583).
    draft.flush();
    releaseEditor?.();
    releaseEditor = null;
    editor?.destroy();
    editor = null;
  });

  // ── The dev-only test hook ───────────────────────────────────────────────
  //
  // ⚠ THE SAME SHAPE AND THE SAME KEY AS THE CARD'S, deliberately.
  // `editor-edit-survives-collapse.spec.ts` drives `__livecode[id].type()` from
  // the DOCK FULL VIEW on the DEFAULT shell — the surface this body now IS — so
  // without it that spec would time out waiting for a hook the promotion
  // removed. Only one of the two surfaces is ever mounted for a given node (the
  // card renders under `?shell=legacy`, this body under the faceplate shell), so
  // the shared key cannot collide.
  if (testHooksEnabled()) {
    $effect(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const w = globalThis as any;
      if (!w.__livecode) w.__livecode = {};
      w.__livecode[nodeId] = {
        run: (script?: string) => {
          if (typeof script === 'string' && editor) editor.setDoc(script);
          runLivecodeNode(nodeId);
        },
        getStatus: () => runDetail,
        getLastResult: () => livecodeRunRecord(patch.nodes[nodeId] as ModuleNode | undefined),
        // Simulate a KEYSTROKE — the same seam the editor's onChange calls, so
        // the debounce is EXERCISED rather than bypassed. `run()` above commits
        // immediately and therefore cannot see the pending-edit bug at all.
        type: (text: string) => {
          editor?.setDoc(text);
          draft.schedule(text);
        },
      };
      return () => {
        if (w.__livecode) delete w.__livecode[nodeId];
      };
    });
  }

  let bufferName = $derived(
    'LIVECODE script — JavaScript, evaluated by the RUN control and applied to the rack',
  );
  let logName = $derived(
    `Output of the last run — ${logLines.length} printed ${logLines.length === 1 ? 'line' : 'lines'}`,
  );
</script>

<div
  class="livecode-body"
  data-testid="livecode-body-{nodeId}"
  style={`--buf-min-w:${CODE_BUFFER_FACE_MIN_W}px;--buf-h:${CODE_BUFFER_FACE_H}px;--log-max-h:${CODE_BUFFER_LOG_MAX_H}px`}
>
  <div
    bind:this={editorEl}
    class="editor nodrag"
    data-testid="livecode-editor-{nodeId}"
    role="group"
    aria-label={bufferName}
  ></div>

  {#if logLines.length > 0}
    <div class="output nodrag" data-testid="livecode-output-{nodeId}" aria-label={logName}>
      {#each logLines as line, i (i)}
        <div class="output-line">{line}</div>
      {/each}
    </div>
  {/if}

  <span class="lamps">
    <StatusLed
      caption="RUN"
      lit={!!record && !record.ok}
      tone="warn"
      detail={runDetail}
      testid="livecode-led-run-{nodeId}"
    />
  </span>
</div>

<style>
  .livecode-body {
    display: flex;
    flex-direction: column;
    gap: 6px;
    width: 100%;
    min-width: 0;
  }
  /* Both numbers come from `code-buffer-face.ts` through custom properties —
     ONE place, shared with the CLOCKED RUNNER's body and read back by both
     face-model tests, rather than a literal re-typed per surface. */
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
  .output {
    max-height: var(--log-max-h);
    overflow-y: auto;
    background: rgba(10, 12, 16, 0.5);
    border: 1px solid var(--border, #333);
    border-radius: 2px;
    padding: 6px 8px;
    font-family: ui-monospace, monospace;
    font-size: 0.65rem;
    color: var(--text-dim, #888);
  }
  .output-line {
    line-height: 1.45;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .output-line + .output-line {
    border-top: 1px dashed rgba(255, 255, 255, 0.04);
    margin-top: 2px;
    padding-top: 2px;
  }
  .lamps {
    display: inline-flex;
    align-items: center;
    gap: 12px;
  }
</style>
