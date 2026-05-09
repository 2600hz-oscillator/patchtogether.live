<script lang="ts">
  // LivecodeCard — text-DSL module that spawns + patches modules from a
  // small scripting language. Card chrome:
  //   - Editable name label (top center)
  //   - Resize handle (bottom-right; mirrors VideoOutCard's pattern)
  //   - Multi-line <textarea> editor (monospace, generous height)
  //   - "Run" button that evaluates + applies the script transactionally
  //   - Status area: parse/eval errors with line:col, or last-run summary
  //   - Output log: per-statement messages (spawned X / patched Y → Z)
  //
  // The card stores its source text on `node.data.text` so it syncs to
  // every collaborator via Y.Doc — two users on the same rack see the
  // SAME script in the SAME LIVECODE instance. v1 doesn't do collaborative
  // editing (cursor-merge, multi-caret), so concurrent typing is
  // last-write-wins per character.

  import { useStore, type NodeProps } from '@xyflow/svelte';
  import { patch, ydoc, LOCAL_ORIGIN } from '$lib/graph/store';
  import { evaluate, type EvaluateResult, type Mutation } from '$lib/livecode/evaluator';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import ModuleNameLabel from '$lib/ui/ModuleNameLabel.svelte';
  import type { ModuleNode } from '$lib/graph/types';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);

  // Read viewport reactively so resize math always uses the live zoom.
  const flowStore = useStore();

  // ---------- Resize state ----------
  // Mirrors VideoOutCard's resize pattern (PR #65 polish): width / height
  // stored on `node.data` so they sync via Y.Doc. The handle's pointer
  // delta is divided by the current viewport zoom so a 1px screen-drag
  // == 1px of card growth regardless of canvas zoom level.
  const DEFAULT_WIDTH = 420;
  const DEFAULT_HEIGHT = 360;
  const MIN_WIDTH = 320;
  const MIN_HEIGHT = 240;

  let cardWidth = $derived<number>(
    (node?.data?.width as number | undefined) ?? DEFAULT_WIDTH,
  );
  let cardHeight = $derived<number>(
    (node?.data?.height as number | undefined) ?? DEFAULT_HEIGHT,
  );

  let resizing = $state(false);
  let resizeAbort: AbortController | null = null;

  function onResizeStart(ev: PointerEvent) {
    ev.preventDefault();
    ev.stopPropagation();
    resizing = true;
    const startX = ev.clientX;
    const startY = ev.clientY;
    const startW = cardWidth;
    const startH = cardHeight;
    resizeAbort = new AbortController();
    const sig = resizeAbort.signal;

    const onMove = (mev: PointerEvent) => {
      const zoom = flowStore.viewport.zoom || 1;
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

  // ---------- Editor state ----------
  // Source text lives on node.data.text — Y.Doc syncs it to other clients.
  // The textarea is a controlled-on-blur control: we mirror the live
  // store value into a local $state so typing doesn't churn Yjs ops on
  // every keystroke. On blur (or Run-click), we commit the local draft
  // back into the store. Simpler than CodeMirror's CRDT integration and
  // sufficient for v1 where the user stops to read the output anyway.

  let storedText = $derived<string>(
    (node?.data?.text as string | undefined) ?? '',
  );
  let draft = $state<string>('');
  let dirty = $state(false);

  // Sync stored → draft when stored changes from outside (initial load,
  // Y.Doc remote update). Only when we're not actively dirty.
  $effect(() => {
    if (!dirty) draft = storedText;
  });

  function commitText() {
    const target = patch.nodes[id];
    if (!target) return;
    if ((target.data?.text as string | undefined) === draft) {
      dirty = false;
      return;
    }
    ydoc.transact(() => {
      const t = patch.nodes[id];
      if (!t) return;
      if (!t.data) t.data = {};
      t.data.text = draft;
    }, LOCAL_ORIGIN);
    dirty = false;
  }

  function onTextInput() {
    dirty = true;
  }

  // ---------- Run state ----------
  let lastResult = $state<EvaluateResult | null>(null);

  function runScript() {
    // Always commit the in-flight draft text so a subsequent reload
    // picks up the most recent script even if the user only ran once.
    commitText();
    const result = evaluate({
      src: draft,
      liveNodes: patch.nodes,
      liveEdges: patch.edges,
      // Anchor spawns ~40px down-right of THIS card so users can see
      // the new modules without panning. Each spawn nudges by 24px (the
      // evaluator's STACK constant) so they don't pile up.
      spawnOrigin: {
        x: (node?.position?.x ?? 0) + cardWidth + 60,
        y: node?.position?.y ?? 0,
      },
    });
    lastResult = result;
    if (!result.ok) return;
    // Apply mutations transactionally — one Y.Doc transact for the whole
    // batch so a reconciler pass sees the rack update atomically and
    // remote collaborators get one Yjs update covering everything.
    ydoc.transact(() => {
      for (const m of result.mutations) applyMutation(m);
    }, LOCAL_ORIGIN);
  }

  function applyMutation(m: Mutation): void {
    if (m.kind === 'spawnNode') {
      patch.nodes[m.node.id] = m.node;
      return;
    }
    if (m.kind === 'addEdge') {
      patch.edges[m.edge.id] = m.edge;
      return;
    }
    if (m.kind === 'setParam') {
      const target = patch.nodes[m.nodeId];
      if (!target) return;
      target.params[m.paramId] = m.value;
      return;
    }
    if (m.kind === 'setData') {
      const target = patch.nodes[m.nodeId];
      if (!target) return;
      if (!target.data) target.data = {};
      target.data[m.key] = m.value;
      return;
    }
  }

  // ---------- Sizing ----------
  // Editor area = card height minus header (title + name + button row)
  // and minus the bottom output area. The output area uses up to 1/3 of
  // remaining height; the editor takes the rest.
  const HEADER_PX = 92;
  const FOOTER_PX = 16;
  let bodyHeight = $derived(Math.max(160, cardHeight - HEADER_PX - FOOTER_PX));
  let outputHeight = $derived(Math.round(Math.max(80, bodyHeight * 0.32)));
  let editorHeight = $derived(Math.max(80, bodyHeight - outputHeight - 8));

  // Status text — derived from lastResult so it auto-updates when run.
  let statusText = $derived.by(() => {
    if (!lastResult) return draft.trim() ? 'Press Run to evaluate' : 'Type a script and press Run';
    if (lastResult.ok) {
      const counts = countMutations(lastResult.mutations);
      return `OK — ${counts}`;
    }
    return `${lastResult.error.line}:${lastResult.error.col}: ${lastResult.error.message}`;
  });

  function countMutations(mutations: Mutation[]): string {
    let spawn = 0, edge = 0, param = 0, data = 0;
    for (const m of mutations) {
      if (m.kind === 'spawnNode') spawn++;
      else if (m.kind === 'addEdge') edge++;
      else if (m.kind === 'setParam') param++;
      else if (m.kind === 'setData') data++;
    }
    return `${spawn} spawn / ${edge} patch / ${param} param / ${data} data`;
  }

  let logLines = $derived.by<string[]>(() => {
    if (!lastResult) return [];
    if (lastResult.ok) return lastResult.log.map((l) => l.message);
    return lastResult.partialLog.map((l) => l.message);
  });
</script>

<div
  class="card livecode"
  class:resizing
  style="width: {cardWidth}px; height: {cardHeight}px;"
  data-testid="livecode-card"
  data-node-id={id}
>
  <div class="stripe"></div>
  <header class="title">
    <span class="kind">LIVECODE</span>
    <ModuleNameLabel {node} />
  </header>

  <PatchPanel nodeId={id} inputs={[]} outputs={[]}>
    <div class="body" style="height: {bodyHeight}px;">
      <div class="toolbar">
        <button
          type="button"
          class="run-btn nodrag"
          data-testid="livecode-run"
          onclick={runScript}
        >
          Run
        </button>
        <span
          class="status"
          class:err={!!(lastResult && !lastResult.ok)}
          data-testid="livecode-status"
        >{statusText}</span>
      </div>
      <textarea
        class="editor nodrag"
        data-testid="livecode-editor"
        bind:value={draft}
        oninput={onTextInput}
        onblur={commitText}
        spellcheck="false"
        autocomplete="off"
        autocapitalize="off"
        wrap="off"
        placeholder={'// Live-code your rack:\n\nv = analogVco.new()\no = audioOut.new()\nv.sine -> o.L\nv.sine -> o.R\nv.tune = 0\n\n// Press Run to apply.'}
        style="height: {editorHeight}px;"
      ></textarea>
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
  </PatchPanel>

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
    background: var(--module-bg);
    border: 1px solid var(--border);
    border-radius: 2px;
    color: var(--text);
    padding-top: 18px;
    padding-bottom: 14px;
    position: relative;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    transition: border-color 80ms ease-out, box-shadow 80ms ease-out;
    overflow: hidden;
  }
  :global(.svelte-flow__node:hover) .card {
    border-color: var(--accent-dim);
  }
  :global(.svelte-flow__node.selected) .card {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent-glow), 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  .card.resizing { transition: none; }
  .stripe {
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    border-radius: 2px 2px 0 0;
    background: var(--cable-cv);
  }
  .title {
    display: flex;
    flex-direction: column;
    align-items: center;
    margin: 0 0 8px;
    gap: 2px;
    /* Push content a bit so the patch-trigger affordances clear it. */
    padding: 0 28px;
  }
  .title .kind {
    font-size: 0.7rem;
    font-weight: 500;
    letter-spacing: 0.06em;
    color: var(--text-dim);
  }
  .body {
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
  .run-btn:hover {
    filter: brightness(1.08);
  }
  .status {
    font-size: 0.65rem;
    font-family: ui-monospace, monospace;
    color: var(--text-dim);
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .status.err {
    color: #fca5a5;
  }
  .editor {
    width: 100%;
    font-family: ui-monospace, 'JetBrains Mono', monospace;
    font-size: 0.78rem;
    line-height: 1.5;
    color: var(--text);
    background: rgba(10, 12, 16, 0.7);
    border: 1px solid var(--border);
    border-radius: 2px;
    padding: 8px 10px;
    resize: none;
    outline: none;
    overflow: auto;
    /* Tab inserts spaces feel for this read-many-times-write-once tool. */
    tab-size: 2;
    -moz-tab-size: 2;
  }
  .editor:focus {
    border-color: var(--accent-dim);
  }
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
  .output-empty {
    font-style: italic;
    opacity: 0.6;
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
  .resize-handle {
    position: absolute;
    right: 0;
    bottom: 0;
    width: 16px;
    height: 16px;
    cursor: nwse-resize;
    background: linear-gradient(
      135deg,
      transparent 50%,
      var(--cable-cv) 50%,
      var(--cable-cv) 60%,
      transparent 60%,
      transparent 70%,
      var(--cable-cv) 70%,
      var(--cable-cv) 80%,
      transparent 80%
    );
    opacity: 0.7;
    z-index: 5;
  }
  .resize-handle:hover { opacity: 1; }
</style>
