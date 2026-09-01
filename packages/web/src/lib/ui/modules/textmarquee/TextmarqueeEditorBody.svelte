<script lang="ts">
  // packages/web/src/lib/ui/modules/textmarquee/TextmarqueeEditorBody.svelte
  //
  // The TEXTMARQUEE dock full-view body — the module's rich-text EDITOR, its
  // live OUT preview, and the SCREEN ON/OFF switch the 2026-08-18 owner ruling
  // requires of every video module.
  //
  // ── WHY THIS FILE EXISTS ────────────────────────────────────────────────
  //
  // TEXTMARQUEE's four params are ScrlX / ScrlY / PosX / PosY, and all four of
  // them only MOVE the ribbon. What the ribbon SAYS — the text, its per-run
  // colour, bold/italic/underline, the paragraph alignment, the font family,
  // the size and the layer background — is `node.data.richText`, and the only
  // affordance in the tree that could write it was `TextmarqueeCard.svelte`.
  // Promotion makes `migrated()` true and stops the shipping shell rendering
  // that card, so a face without this body would ship a module whose four
  // knobs work perfectly and whose text can never be changed again.
  //
  // Enumerated rather than asserted (the PR body carries the table): of the
  // fifteen `data-testid`s on the card, exactly TWO are shell chrome
  // (`textmarquee-card`, and the preview well `textmarquee-screen` which
  // becomes `textmarquee-face-canvas` here). ZERO of the remaining thirteen are
  // expressible as a face cell — they are a live DOM Selection, three colour
  // inputs, a twelve-entry `<select>` and a `contenteditable`. That whole
  // remainder is this component.
  //
  // ── ⚠ THE SERIALIZER IS SHARED, AND THAT IS A CORRECTNESS FIX ───────────
  //
  // `serializeEditor` reads `getComputedStyle`, so the editor's CASCADE is part
  // of the persisted document's semantics. The card's `.editor` rule set
  // `color:#ffffff` and `white-space:pre-wrap`; `.dock-ext-body` sets neither
  // and inherits the faceplate's `var(--text, #eef1f5)`. Re-hosting the same
  // `contenteditable` here on inherited style would have written `#eef1f5` into
  // every untouched run of every rack anyone opened this dock on — and the
  // still-live legacy card would then read that corruption back. Both surfaces
  // now call `applyEditorBaseStyle` from `$lib/graph/textmarquee-editor`, which
  // sets the serialized-in properties EXPLICITLY on the element. See that
  // module's header.
  //
  // ── ⚠ WHAT THIS BODY DELIBERATELY DOES NOT DO ──────────────────────────
  //
  // It does not rasterize. The model → canvas → `setTextCanvas` half moved to
  // `$lib/ui/media/extras-producers` on NODE lifetime in #1720, precisely so a
  // saved rack shows your text with no UI mounted. This component writes the
  // MODEL and blits a preview; it is not a producer, and enrolling textmarquee
  // in `CARD_PRODUCER_LANE_TYPES` would be re-creating the bug #1720 fixed.
  //
  // ⚠ IT MUST STAY 2-D. `textmarquee.ts` is inside the WebGL attest basis and
  // this file is deliberately outside it — but `resolveWebglBasis()` step (2)
  // sweeps `lib/ui/modules/**/*.svelte` by CONTENT, so a `getContext('webgl')`
  // here would enrol it permanently and put every future face edit on the
  // real-GPU attest critical path. The preview is a 2-D blit of the engine's
  // already-rendered canvas.

  import { onMount, onDestroy } from 'svelte';
  import { patch } from '$lib/graph/store';
  import { mutateNode } from '$lib/graph/mutate';
  import { useEngine } from '$lib/audio/engine-context';
  import type { VideoEngine } from '$lib/video/engine';
  import { VIDEO_RES } from '$lib/video/engine';
  import { drawPreviewDownscaled } from '../preview-downscale';
  import {
    applyEditorBaseStyle,
    applyModelToDom,
    serializeEditor,
  } from '$lib/graph/textmarquee-editor';
  import {
    type RichTextModel,
    type RichAlign,
    coerceRichTextModel,
    modelPlainText,
    clampFontPx,
    normalizeFontFamily,
    FONT_FAMILIES,
    DEFAULT_FONT_FAMILY,
    MIN_FONT_PX,
    MAX_FONT_PX,
    DEFAULT_FONT_PX,
  } from '$lib/video/modules/textmarquee-layout';

  interface Props {
    /** The graph node this faceplate is showing — the ONLY prop the slot gets
     *  (`ShellExtensionFullViewBodyProps`). */
    nodeId: string;
  }
  let { nodeId }: Props = $props();

  const engineCtx = useEngine();
  const ENGINE_W = VIDEO_RES.width;
  const ENGINE_H = VIDEO_RES.height;

  // ⚠ LEAF READS, NOT `$derived(f(node))`. A Yjs node proxy's identity never
  // changes, so a derived over the NODE object never recomputes — the graph is
  // correct and the UI is frozen. Reading `.data.richText` / `.data
  // .previewCollapsed` subscribes to the key that actually moves.
  let model = $derived<RichTextModel>(
    coerceRichTextModel(
      (patch.nodes[nodeId]?.data as { richText?: unknown } | undefined)?.richText,
    ),
  );
  let isEmpty = $derived(modelPlainText(model).trim().length === 0);

  // ── The persisted layer settings the editor DOM cannot carry ─────────────
  // BG / SIZE / FONT are whole-layer values, not run styles, so they live in
  // local state seeded from the model on mount and are written back through
  // every `serializeEditor` call. Seeding them is load-bearing: without it the
  // first keystroke would serialize the DEFAULTS over whatever the player had
  // chosen, silently resetting the background, the size and the font.
  let layerBg = $state('#000000');
  let fontPx = $state(DEFAULT_FONT_PX);
  let fontFamily = $state(DEFAULT_FONT_FAMILY);
  let runColor = $state('#ffff00');

  let editorEl: HTMLDivElement | null = $state(null);

  function currentModel(): RichTextModel {
    if (!editorEl) return model;
    return serializeEditor(editorEl, {
      fg: model.fg,
      bg: layerBg,
      fontPx,
      fontFamily,
    });
  }

  function persistModel(next: RichTextModel) {
    mutateNode(nodeId, (live) => {
      if (!live.data) live.data = {};
      // Set a single key IN PLACE — never reassign the live data map
      // ([[yjs-save-load-real-ydoc]]).
      (live.data as Record<string, unknown>).richText = next;
    });
  }

  // ⚠ THE DEBOUNCE IS CARRIED, INCLUDING ITS UNMOUNT FLUSH. Writing the Y.Doc
  // on every keystroke re-derives `model`, re-renders, resets the caret to the
  // start and interleaves fast-typed characters — and it is a per-keystroke
  // Y.Doc write storm ([[cv-modulation-live-store-write-storm]]). Coalescing to
  // ~250 ms after the last keystroke makes a typing burst ONE write.
  //
  // ⚠ AND THE FLUSH MATTERS MORE HERE THAN IT DID ON THE CARD. The dock LRU-
  // evicts a pane at the third expand, so this component unmounts under the
  // player's hands far more readily than a card ever did; without the
  // `onDestroy` flush the last ~250 ms of typing is simply lost.
  const PERSIST_DEBOUNCE_MS = 250;
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  function persistModelDebounced(next: RichTextModel) {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      persistModel(next);
    }, PERSIST_DEBOUNCE_MS);
  }
  /** Flush a pending debounced write immediately (toolbar actions / blur). */
  function flushPersist() {
    if (!editorEl) return;
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
    persistModel(currentModel());
  }

  function onEditorInput() {
    persistModelDebounced(currentModel());
  }
  function onEditorBlur() {
    flushPersist();
  }

  // ── Toolbar actions (execCommand — the minimal, dependency-free path) ────
  // A mousedown on a button would blur the contenteditable and collapse the
  // selection, so `execCommand('bold')` would have nothing to format. Every
  // formatting control preventDefaults its mousedown to keep the selection.
  function keepSelection(e: Event) {
    e.preventDefault();
  }
  function exec(command: string, value?: string) {
    editorEl?.focus();
    document.execCommand(command, false, value);
    // A toolbar action is a discrete intent — persist it now, not debounced.
    flushPersist();
  }
  const setAlign = (a: RichAlign) =>
    exec(a === 'left' ? 'justifyLeft' : a === 'center' ? 'justifyCenter' : 'justifyRight');
  const toggleBold = () => exec('bold');
  const toggleItalic = () => exec('italic');
  const toggleUnderline = () => exec('underline');

  function applyRunColor(hex: string) {
    runColor = hex;
    exec('foreColor', hex);
  }
  function setFontPx(v: number) {
    fontPx = clampFontPx(v);
    persistModel(currentModel());
  }
  function setFontFamily(name: string) {
    fontFamily = normalizeFontFamily(name);
    if (editorEl) editorEl.style.fontFamily = fontFamily;
    persistModel(currentModel());
  }
  function setLayerBg(hex: string) {
    layerBg = hex;
    persistModel(currentModel());
  }

  // ── SCREEN ON / OFF ─────────────────────────────────────────────────────
  // ⚠ STATE ON THE NODE, NOT IN THE COMPONENT — this body unmounts on dock
  // collapse / LRU eviction (the #1531 / #1574 / #1583 class), and `node.data`
  // survives a tab switch, a remount, a reload and collab sync. It is the SAME
  // `previewCollapsed` key every other video surface uses, so a rack saved
  // before this promotion opens exactly as it did. Absent ⇒ false ⇒ ON.
  let previewCollapsed = $derived<boolean>(
    (patch.nodes[nodeId]?.data?.previewCollapsed as boolean | undefined) ?? false,
  );
  function toggleScreen(): void {
    const next = !previewCollapsed;
    mutateNode(nodeId, (live) => {
      if (!live.data) live.data = {};
      live.data.previewCollapsed = next;
    });
  }

  let canvasEl: HTMLCanvasElement | null = $state(null);
  let rafId: number | null = null;

  function draw(): void {
    rafId = null;
    const e = engineCtx.get();
    if (!e) { rafId = requestAnimationFrame(draw); return; }
    let videoEngine: VideoEngine | undefined;
    try { videoEngine = e.getDomain<VideoEngine>('video'); }
    catch { videoEngine = undefined; }
    if (!videoEngine) { rafId = requestAnimationFrame(draw); return; }

    if (previewCollapsed) {
      // ⚠ SCREEN OFF STOPS THE COPY AND KEEPS THE WATCH MARK (#1937 / #2015).
      // `blitOutputForPreview` IS the engine's "someone is watching" signal (it
      // calls `markWatched` itself), and a node is a pull root only while that
      // mark is fresh. A collapsed state that merely stopped blitting would drop
      // this node out of the pull set, and the switch would become a PRODUCER
      // KILL SWITCH for everything downstream of `out`.
      //
      // ⚠ AND TEXTMARQUEE IS A SOURCE, which is acidwarp's argument and the
      // stronger half of the rule: it has no video input, so a lapsed mark does
      // not stall a preview of somebody else's picture — it MUTES the generator
      // every downstream node is sampling. A mid-chain filter at least passes
      // something through; this passes nothing.
      try { videoEngine.markWatched(nodeId); } catch { /* never nuke the loop */ }
      rafId = requestAnimationFrame(draw);
      return;
    }

    if (!canvasEl) { rafId = requestAnimationFrame(draw); return; }
    const ctx2d = canvasEl.getContext('2d', { alpha: false });
    if (ctx2d) {
      // #1802 — gated preview blit (see VideoEngine.blitOutputForPreview).
      let blitted = false;
      try { blitted = videoEngine.blitOutputForPreview(nodeId); }
      catch { /* never nuke the rAF loop */ }
      if (!blitted) { rafId = requestAnimationFrame(draw); return; }
      const src = videoEngine.canvas as CanvasImageSource;
      const cw = canvasEl.width;
      const ch = canvasEl.height;
      ctx2d.fillStyle = '#050608';
      ctx2d.fillRect(0, 0, cw, ch);
      const srcAspect = ENGINE_W / ENGINE_H;
      const dstAspect = cw / ch;
      let w = cw, h = ch, x = 0, y = 0;
      if (dstAspect > srcAspect) { h = ch; w = Math.round(h * srcAspect); x = Math.round((cw - w) / 2); }
      else { w = cw; h = Math.round(w / srcAspect); y = Math.round((ch - h) / 2); }
      drawPreviewDownscaled(ctx2d, src, x, y, w, h);
    }
    rafId = requestAnimationFrame(draw);
  }

  // ONE owner for the loop, and it runs for the component's whole lifetime —
  // `draw` branches on the SCREEN state internally rather than the effect
  // stopping and restarting it. That is acidwarp's shape and it is the safe
  // one: a loop torn down on collapse is a loop that has to be correctly
  // restarted on expand, and the watch mark has to keep being renewed while
  // collapsed anyway.
  $effect(() => {
    if (rafId === null) rafId = requestAnimationFrame(draw);
    return () => {
      if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
    };
  });

  onMount(() => {
    // Seed the whole-layer settings from the persisted model, stamp the
    // explicit style contract onto the editor, then paint the model into it.
    layerBg = model.bg;
    fontPx = clampFontPx(model.fontPx);
    fontFamily = normalizeFontFamily(model.fontFamily);
    if (editorEl) {
      applyEditorBaseStyle(editorEl);
      editorEl.style.fontFamily = fontFamily;
      applyModelToDom(editorEl, model);
    }
  });

  onDestroy(() => {
    // Flush any pending debounced edit before this pane is evicted.
    if (persistTimer) flushPersist();
    if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
  });
</script>

<div class="tm-body" data-testid="textmarquee-editor-body">
  <div class="toolbar nodrag" data-testid="textmarquee-toolbar">
    <button type="button" class="tb" title="Align left" data-testid="textmarquee-align-left" onmousedown={keepSelection} onclick={() => setAlign('left')}>⯇</button>
    <button type="button" class="tb" title="Align center" data-testid="textmarquee-align-center" onmousedown={keepSelection} onclick={() => setAlign('center')}>≡</button>
    <button type="button" class="tb" title="Align right" data-testid="textmarquee-align-right" onmousedown={keepSelection} onclick={() => setAlign('right')}>⯈</button>
    <span class="sep"></span>
    <button type="button" class="tb b" title="Bold" data-testid="textmarquee-bold" onmousedown={keepSelection} onclick={toggleBold}>B</button>
    <button type="button" class="tb i" title="Italic" data-testid="textmarquee-italic" onmousedown={keepSelection} onclick={toggleItalic}>I</button>
    <button type="button" class="tb u" title="Underline" data-testid="textmarquee-underline" onmousedown={keepSelection} onclick={toggleUnderline}>U</button>
    <span class="sep"></span>
    <label class="swatch" title="Text colour (applies to the selected text)">
      <span class="lbl">TEXT</span>
      <input type="color" class="nodrag" value={runColor} data-testid="textmarquee-run-color"
        onmousedown={keepSelection}
        oninput={(e) => applyRunColor((e.currentTarget as HTMLInputElement).value)} />
    </label>
    <span class="sep"></span>
    <label class="swatch" title="Font">
      <span class="lbl">FONT</span>
      <select class="nodrag font-select" value={fontFamily} data-testid="textmarquee-font"
        onmousedown={keepSelection}
        onchange={(e) => setFontFamily((e.currentTarget as HTMLSelectElement).value)}>
        {#each FONT_FAMILIES as f (f.value)}
          <option value={f.value}>{f.label}</option>
        {/each}
      </select>
    </label>
    <span class="sep"></span>
    <label class="swatch" title="Font size (max = a short word fills the screen)">
      <span class="lbl">SIZE</span>
      <input type="range" class="nodrag" min={MIN_FONT_PX} max={MAX_FONT_PX} step="2" value={fontPx}
        data-testid="textmarquee-size"
        oninput={(e) => setFontPx(Number((e.currentTarget as HTMLInputElement).value))} />
    </label>
    <span class="sep"></span>
    <label class="swatch" title="Background — fills the whole layer behind the text">
      <span class="lbl">BG</span>
      <input type="color" class="nodrag" value={layerBg} data-testid="textmarquee-bg"
        oninput={(e) => setLayerBg((e.currentTarget as HTMLInputElement).value)} />
    </label>
  </div>

  <!-- The editor. Its serialized-in style properties are stamped on the
       ELEMENT by applyEditorBaseStyle (see the header) rather than set here,
       so the contract lives in one place both surfaces read. -->
  <div
    bind:this={editorEl}
    class="editor nodrag"
    contenteditable="true"
    role="textbox"
    tabindex="0"
    aria-multiline="true"
    aria-label="marquee text"
    data-testid="textmarquee-editor"
    oninput={onEditorInput}
    onblur={onEditorBlur}
  ></div>

  <div class="preview-wrap" data-preview-collapsed={previewCollapsed ? 'true' : 'false'}>
    {#if !previewCollapsed}
      {#if isEmpty}
        <span class="empty-badge" data-testid="textmarquee-empty">TYPE TEXT…</span>
      {/if}
      <canvas
        bind:this={canvasEl}
        width={480}
        height={360}
        data-testid="textmarquee-face-canvas"
      ></canvas>
    {/if}
    <button
      type="button"
      class="screen-btn nodrag"
      class:on={!previewCollapsed}
      onclick={toggleScreen}
      data-testid="textmarquee-face-screen-toggle"
      aria-pressed={!previewCollapsed}
      title="SCREEN: turn the preview off to reclaim its space. The module keeps rendering."
    >SCREEN {previewCollapsed ? 'OFF' : 'ON'}</button>
  </div>
</div>

<style>
  .tm-body {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 2px 0 4px;
  }

  .toolbar {
    display: flex;
    align-items: center;
    gap: 3px;
    flex-wrap: wrap;
  }
  .tb {
    min-width: 22px;
    height: 22px;
    font-size: 0.72rem;
    line-height: 1;
    color: var(--text);
    background: var(--control-bg, #1c1c22);
    border: 1px solid var(--border);
    border-radius: 3px;
    cursor: pointer;
    padding: 0 4px;
  }
  .tb:hover { border-color: var(--accent-dim); }
  .tb.b { font-weight: 800; }
  .tb.i { font-style: italic; }
  .tb.u { text-decoration: underline; }
  .sep { width: 1px; height: 16px; background: var(--border); margin: 0 2px; }
  .swatch { display: inline-flex; align-items: center; gap: 3px; }
  .swatch .lbl { font-size: 0.5rem; color: var(--text-dim); letter-spacing: 0.06em; }
  .swatch input[type='color'] {
    width: 20px; height: 20px; padding: 0; border: 1px solid var(--border);
    border-radius: 3px; background: none; cursor: pointer;
  }
  .font-select {
    height: 22px;
    max-width: 86px;
    font-size: 0.62rem;
    color: var(--text);
    background: var(--control-bg, #1c1c22);
    border: 1px solid var(--border);
    border-radius: 3px;
    cursor: pointer;
  }

  /* ⚠ NO `color`, NO `white-space`, NO `font-*` HERE, DELIBERATELY. Those are
     the properties `serializeEditor` reads back out of the DOM, so they are
     DATA and belong in the one shared contract both surfaces stamp on the
     element (`applyEditorBaseStyle`). Setting them in this stylesheet too
     would give the face a second, silently-diverging source of truth for what
     an untouched run means. */
  .editor {
    min-height: 52px;
    max-height: 128px;
    overflow: auto;
    padding: 6px 8px;
    background: #0c0c10;
    border: 1px solid var(--border);
    border-radius: 3px;
    font-size: 0.85rem;
    line-height: 1.3;
    outline: none;
    word-break: break-word;
  }
  .editor:focus { border-color: var(--accent-dim); }

  /* ⚠ THE SWITCH COSTS ZERO LAYOUT HEIGHT — it overlays the picture's
     bottom-right corner, so the body is exactly the height the picture is
     (the fleet shape; see module-faceplates.md's OVERLAY paragraph). */
  .preview-wrap {
    position: relative;
    display: flex;
    justify-content: center;
    /* Only load-bearing with SCREEN OFF: the canvas is gone, and without a
       floor the wrap would collapse to zero and take the absolutely-positioned
       button with it. */
    min-height: 18px;
  }
  /* ⚠ `width: 100%`, NOT THE ELEMENT'S 480 px INTRINSIC WIDTH, and it is the
     owner's compactness ruling rather than a preference. The plate's width is
     set by the TOOLBAR — `.faceplate-body` is `width: max-content` and the
     toolbar is the widest row — so a fixed-width picture centred inside it left
     ~23 px of grey gutter down each side, which is exactly the "useless gray
     horizontal space" the 2026-08-17 ruling is about. MEASURED by
     `workflow-shell-faces.spec.ts`'s slack clause at 46 px against its 40 px
     ceiling; filling closes it.
     ⚠ AND FILLING IS THE HONEST FIX RATHER THAN A `FACE_WIDTH_EXEMPTIONS` ROW.
     An exemption would have been ARGUABLE — that clause measures content as
     BOXY elements plus text nodes, and a native `<input type="color">`,
     `<input type="range">` and `<select>` are none of those, so the toolbar
     genuinely earns width the instrument is structurally blind to. But the
     gutters were real and visible; an exemption would have made the gate agree
     with a picture that was too small.
     The backing store stays 480x360 — CSS scales the presentation only, and
     `drawPreviewDownscaled` still shrinks the 1024-wide engine frame in <=2x
     steps into that store. */
  .preview-wrap canvas {
    display: block;
    border-radius: 3px;
    background: #050608;
    width: 100%;
    max-width: 100%;
    height: auto;
  }
  .empty-badge {
    position: absolute;
    top: 4px; left: 4px;
    font-size: 0.5rem;
    letter-spacing: 0.08em;
    color: #87c8ff;
    background: rgba(0, 0, 0, 0.55);
    border: 1px solid #87c8ff;
    border-radius: 2px;
    padding: 1px 4px;
    font-family: ui-monospace, monospace;
    pointer-events: none;
    z-index: 2;
  }
  .screen-btn {
    position: absolute;
    right: 4px;
    bottom: 4px;
    font-size: 0.55rem;
    letter-spacing: 0.06em;
    padding: 2px 8px;
    border: 1px solid var(--border);
    border-radius: 2px;
    /* Legible over a live picture — a transparent button was not. */
    background: rgba(5, 6, 8, 0.72);
    color: var(--text-dim);
    cursor: pointer;
  }
  .screen-btn.on { color: var(--text); border-color: var(--accent-dim); }
  .screen-btn:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px; }
</style>
