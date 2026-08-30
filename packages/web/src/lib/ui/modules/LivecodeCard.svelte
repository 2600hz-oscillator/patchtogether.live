<script lang="ts">
  // LivecodeCard — programmable rack scripter. v2 runtime: a JS sandbox
  // (new Function with curated globals) replaces the v1 custom DSL.
  // Editor: CodeMirror 6 with JS syntax highlighting, port-aware
  // autocomplete, and red-underline diagnostics for invalid patch()
  // pairs.
  //
  // Card chrome:
  //   - LIVECODE title
  //   - Run button + status line
  //   - CodeMirror editor (resizable; vertical-fill)
  //   - Output log
  //   - Bottom-right resize handle
  //
  // Per-rack Y.Doc sync: `node.data.text` mirrors the editor content.
  // Remote edits update the editor view via setDoc(). Local typing
  // commits debounced to keep Yjs traffic bounded.

  import { onDestroy, onMount } from 'svelte';
  import { type NodeProps } from '@xyflow/svelte';
  import { captureFlowStore } from './card-kit';
  import { createDebouncedCommit } from './debounced-commit';
  import { patch } from '$lib/graph/store';
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
  // ⚠ THE EVALUATION IS NOT IN THIS FILE ANY MORE, and that is what made the
  // faceplate promotion possible at all. `livecodeDef.factory` is a no-op handle,
  // so `runScript()` here used to be everything the module did — and
  // `migrated(type)` stops BOTH surfaces rendering a promoted module's card. The
  // run now lives in `./livecode-cell-actions`, which the ranked RUN cell, the
  // faceplate body and this card all call: three callers, one implementation, so
  // the two surfaces cannot disagree about what Run does.
  import {
    LIVECODE_DEFAULT_WIDTH,
    commitLivecodeText,
    livecodeRunDetail,
    livecodeRunRecord,
    livecodeStoredText,
    registerLivecodeEditor,
    runLivecodeNode,
    type LivecodeRunRecord,
  } from './livecode-cell-actions';
  import { makeEditor, type EditorHandle } from '$lib/livecode/editor';
  import { makeCompletionSource } from '$lib/livecode/completions';
  import { makeLinter } from '$lib/livecode/diagnostics';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { testHooksEnabled } from '$lib/dev/test-hooks';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);

  // ⚠ EVERY `node.data` DERIVATION BELOW IS KEYED ON THIS, and it is a fix
  // rather than ceremony. `patch.nodes[id]` is a Yjs proxy whose IDENTITY never
  // changes, so a `$derived` that reads through it recomputes NEVER: the graph
  // updates and the view silently shows the value it had at mount. Nothing
  // throws and nothing logs — and a test that reads `node.data` PASSES on it,
  // because the write really did land. `nodeVersion(id)` is the node's own Y.Doc
  // revision, which is a value that actually changes.
  let dataVersion = $derived(nodeVersion(id));

  // Guarded: the dock full-view plain-mounts this card OUTSIDE the
  // SvelteFlow provider, where a bare useStore() throws and killed the
  // card at init (no video in the expanded faceplate). Inside the
  // provider this is byte-identical; outside it's null -> zoom 1.
  const flowStore = captureFlowStore();

  // ───── Resize state (unchanged from v1) ─────────────────────────
  // Rounded to whole-u (180px) rack tiles (#759) so default + min land on the
  // grid; this card is user-resizable so the rack CSS doesn't clamp it. Body is
  // responsive (bodyHeight = cardHeight − header − footer) so it stays usable.
  // ⚠ THE DEFAULT WIDTH IS IMPORTED, NEVER RE-TYPED. It is also the SPAWN
  // GEOMETRY — a script's new modules are laid out `width + 60` to the right of
  // this one — and that arithmetic now lives beside the run in
  // `./livecode-cell-actions`. Two copies would mean a saved rack's spawns
  // landing in different places depending on which surface pressed Run.
  const DEFAULT_WIDTH = LIVECODE_DEFAULT_WIDTH;
  const DEFAULT_HEIGHT = 360;
  const MIN_WIDTH = 360;
  const MIN_HEIGHT = 360;

  let cardWidth = $derived.by<number>(() => {
    void dataVersion;
    return (node?.data?.width as number | undefined) ?? DEFAULT_WIDTH;
  });
  let cardHeight = $derived.by<number>(() => {
    void dataVersion;
    return (node?.data?.height as number | undefined) ?? DEFAULT_HEIGHT;
  });
  let resizing = $state(false);
  let resizeAbort: AbortController | null = null;

  function onResizeStart(ev: PointerEvent) {
    ev.preventDefault();
    ev.stopPropagation();
    resizing = true;
    const startX = ev.clientX, startY = ev.clientY;
    const startW = cardWidth, startH = cardHeight;
    resizeAbort = new AbortController();
    const sig = resizeAbort.signal;
    const onMove = (mev: PointerEvent) => {
      const zoom = flowStore?.viewport.zoom || 1;
      const dx = (mev.clientX - startX) / zoom;
      const dy = (mev.clientY - startY) / zoom;
      const w = Math.max(MIN_WIDTH, Math.round(startW + dx));
      const h = Math.max(MIN_HEIGHT, Math.round(startH + dy));
      const target = patch.nodes[id];
      if (target) {
        if (!target.data) target.data = {};
        target.data.width = w;
        target.data.height = h;
      }
    };
    const stop = () => {
      resizing = false;
      resizeAbort?.abort();
      resizeAbort = null;
    };
    window.addEventListener('pointermove', onMove, { signal: sig });
    window.addEventListener('pointerup', stop, { signal: sig });
    window.addEventListener('pointercancel', stop, { signal: sig });
  }

  // ───── Editor state ──────────────────────────────────────────────
  let storedText = $derived.by<string>(() => {
    void dataVersion;
    return livecodeStoredText(node);
  });
  let editorEl: HTMLDivElement | null = $state(null);
  let editor: EditorHandle | null = null;
  const COMMIT_DEBOUNCE_MS = 250;

  // #1583: the debounce FLUSHES on unmount instead of dropping its pending value.
  // `commitLivecodeText` is the only writer of node.data.text, and onDestroy used
  // to `clearTimeout` the pending commit — so typing and then collapsing (or being
  // LRU-evicted when a third module is expanded) within COMMIT_DEBOUNCE_ms silently discarded
  // the edit. createDebouncedCommit exposes no `cancel`, so that is now unwritable.
  const draft = createDebouncedCommit<string>(
    (value) => commitLivecodeText(id, value),
    COMMIT_DEBOUNCE_MS,
  );
  function scheduleCommit(value: string) {
    draft.schedule(value);
  }

  /** What RUN reads — flush anything pending, then hand back the live buffer.
   *  Published node-keyed so the shared action gets the text the player can SEE
   *  rather than one up to 250 ms old. */
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
      onChange: (value) => scheduleCommit(value),
      completionSource: makeCompletionSource(() => ({
        liveNodes: patch.nodes,
        liveEdges: patch.edges,
      })),
      lintSource: makeLinter(() => ({
        liveNodes: patch.nodes,
        liveEdges: patch.edges,
      })),
    });
    releaseEditor = registerLivecodeEditor(id, flushToText);
  });

  // Sync remote → editor (Yjs update from a collaborator).
  $effect(() => {
    const t = storedText;
    if (!editor) return;
    editor.setDoc(t);
  });

  onDestroy(() => {
    // FLUSH, never clearTimeout: a card unmount is a VIEW event (collapse / LRU
    // evict), not a signal that the user abandoned the edit (#1583).
    draft.flush();
    releaseEditor?.();
    releaseEditor = null;
    editor?.destroy();
    editor = null;
  });

  // ───── Run state ─────────────────────────────────────────────────
  //
  // ⚠ IT LIVES ON THE NODE NOW, NOT IN `$state`. The card kept `lastResult` in
  // component state, so collapsing this card — or being LRU-evicted when a third
  // module is expanded — silently discarded the log and the error you were
  // reading, with no user action against them (the #1531 / #1574 / #1583 class).
  // `runLivecodeNode` writes the outcome to `node.data.lastRun`, so it survives a
  // remount and a reload, and it is what the ranked RUN cell's `data` probe
  // watches.
  let lastResult = $derived.by<LivecodeRunRecord | null>(() => {
    void dataVersion;
    return livecodeRunRecord(node);
  });

  function runScript() {
    runLivecodeNode(id);
  }

  // ───── Sizing ────────────────────────────────────────────────────
  const HEADER_PX = 56;
  const FOOTER_PX = 20;
  let bodyHeight = $derived(Math.max(160, cardHeight - HEADER_PX - FOOTER_PX));
  let outputHeight = $derived(Math.round(Math.max(80, bodyHeight * 0.28)));
  let editorHeight = $derived(Math.max(80, bodyHeight - outputHeight - 44));

  // The card's own status line. It keeps its resting instruction: the 2026-08-19
  // resting-text rulings are about FACEPLATES, and the legacy cards are untouched.
  // The FACE says the same things through `StatusLed.detail` instead.
  let statusText = $derived(
    lastResult ? livecodeRunDetail(lastResult) : 'Type a script and press Run',
  );

  let logLines = $derived<string[]>(lastResult?.log ?? []);

  // Dev-only test hook — same shape as the v1 card so existing E2E
  // tests that drive runScript via __livecode.<id>.run() keep working.
  // Gated on testHooksEnabled() so it's also present in the prebuilt
  // `vite preview` bundle (VITE_E2E_HOOKS=1) the e2e shards run against —
  // a prod build where import.meta.env.DEV is false would otherwise strip
  // __livecode and time out all livecode.spec tests.
  if (testHooksEnabled()) {
    $effect(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const w = globalThis as any;
      if (!w.__livecode) w.__livecode = {};
      w.__livecode[id] = {
        run: (script?: string) => {
          if (typeof script === 'string' && editor) editor.setDoc(script);
          runScript();
        },
        getStatus: () => statusText,
        getLastResult: () => lastResult,
        // #1583: simulate a KEYSTROKE — the same seam the editor's onChange calls,
        // so the debounce is exercised rather than bypassed. `run()` above commits
        // immediately and therefore cannot see the pending-edit bug at all.
        type: (text: string) => {
          editor?.setDoc(text);
          scheduleCommit(text);
        },
      };
      return () => {
        if (w.__livecode) delete w.__livecode[id];
      };
    });
  }
</script>

<div
  class="vcard card livecode"
  class:resizing
  style="width: {cardWidth}px; height: {cardHeight}px;"
  data-testid="livecode-card"
  data-node-id={id}
>
  <div class="stripe"></div>
  <ModuleTitle {id} {data} defaultLabel="LIVECODE" />

  <div class="body" style="height: {bodyHeight}px;">
    <div class="toolbar">
      <button
        type="button"
        class="run-btn nodrag"
        data-testid="livecode-run"
        onclick={(e) => { e.preventDefault(); e.stopPropagation(); runScript(); }}
      >Run</button>
      <span
        class="status"
        class:err={!!(lastResult && !lastResult.ok)}
        data-testid="livecode-status"
      >{statusText}</span>
    </div>
    <div
      bind:this={editorEl}
      class="editor nodrag"
      data-testid="livecode-editor"
      style="height: {editorHeight}px;"
    ></div>
    <div class="output" data-testid="livecode-output" style="height: {outputHeight}px;">
      {#if logLines.length === 0}
        <div class="output-empty">output log appears here after Run</div>
      {:else}
        {#each logLines as line, i (i)}
          <div class="output-line">{line}</div>
        {/each}
      {/if}
    </div>
  </div>

  <div
    class="resize-handle nodrag"
    role="separator"
    aria-label="Resize LIVECODE"
    data-testid="livecode-resize-handle"
    onpointerdown={onResizeStart}
  ></div>
</div>

<style>
  .card {
    overflow: hidden;
  }
  .card.resizing { transition: none; }
  .stripe {
    background: var(--cable-cv);
  }  .body {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 0 12px;
  }
  .toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .run-btn {
    background: var(--cable-audio);
    color: #1a1d23;
    border: 1px solid var(--cable-audio);
    border-radius: 3px;
    padding: 4px 12px;
    font-size: 0.75rem;
    font-weight: 500;
    cursor: pointer;
    font-family: inherit;
  }
  .run-btn:hover { filter: brightness(1.08); }
  .status {
    font-size: 0.65rem;
    font-family: ui-monospace, monospace;
    color: var(--text-dim);
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .status.err { color: #fca5a5; }
  .editor {
    width: 100%;
    border: 1px solid var(--border);
    border-radius: 2px;
    overflow: hidden;
  }
  .editor :global(.cm-editor) { height: 100%; }
  .editor :global(.cm-editor.cm-focused) { outline: 1px solid var(--accent-dim); outline-offset: -1px; }
  .output {
    background: rgba(10, 12, 16, 0.5);
    border: 1px solid var(--border);
    border-radius: 2px;
    padding: 6px 8px;
    overflow-y: auto;
    font-family: ui-monospace, monospace;
    font-size: 0.65rem;
    color: var(--text-dim);
  }
  .output-empty { font-style: italic; opacity: 0.6; }
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
  .resize-handle {
    position: absolute; right: 0; bottom: 0;
    width: 16px; height: 16px;
    cursor: nwse-resize;
    background: linear-gradient(
      135deg,
      transparent 50%, var(--cable-cv) 50%, var(--cable-cv) 60%,
      transparent 60%, transparent 70%, var(--cable-cv) 70%,
      var(--cable-cv) 80%, transparent 80%
    );
    opacity: 0.7;
    z-index: 5;
  }
  .resize-handle:hover { opacity: 1; }
</style>
