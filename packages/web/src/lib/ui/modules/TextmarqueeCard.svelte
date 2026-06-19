<script lang="ts">
  // TextmarqueeCard — the card face for TEXTMARQUEE.
  //
  // An EXTREMELY BASIC rich-text editor: a `contenteditable` region + a small
  // toolbar (align left/center/right, bold, italic, underline, per-selection
  // TEXT colour, a FONT-family picker, a SIZE slider) + a single layer
  // BACKGROUND colour. (No per-character background, no separate layer
  // foreground — the TEXT colour is the only foreground.) The DOM is serialized into a
  // small RICH-TEXT MODEL (paragraphs → styled runs) persisted in
  // node.data.richText (Y.Doc-synced, in place — never reassign the live data
  // map, the [[yjs-save-load-real-ydoc]] trap). That SAME model is rendered to
  // an offscreen 2D canvas (system-font glyphs) and pushed to the engine module
  // via read('extras').setTextCanvas — so editor DOM + video texture come from
  // one serializable source of truth.
  //
  // Plus four knobs (ScrlX/ScrlY scroll speed, PosX/PosY position) each with a
  // matching CV input, and a live preview of the OUT layer.

  import { onMount, onDestroy, untrack } from 'svelte';
  import { type NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { useEngine } from '$lib/audio/engine-context';
  import { setNodeParam, mutateNode } from '$lib/graph/mutate';
  import {
    textmarqueeDef,
    type TextmarqueeHandleExtras,
  } from '$lib/video/modules/textmarquee';
  import {
    type RichTextModel,
    type RichParagraph,
    type RichRun,
    type RichAlign,
    emptyRichTextModel,
    coerceRichTextModel,
    layoutModel,
    lineAlignOffset,
    modelPlainText,
    clampFontPx,
    truncateModelChars,
    normalizeFontFamily,
    FONT_FAMILIES,
    DEFAULT_FONT_FAMILY,
    MIN_FONT_PX,
    MAX_FONT_PX,
    DEFAULT_FONT_PX,
    MAX_CHARS,
  } from '$lib/video/modules/textmarquee-layout';
  import type { VideoEngine } from '$lib/video/engine';
  import { VIDEO_RES } from '$lib/video/engine';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  function pdef(name: string): number {
    return textmarqueeDef.params.find((d) => d.id === name)!.defaultValue;
  }
  function p(name: string): number {
    return node?.params[name] ?? pdef(name);
  }
  function setParam(paramId: string) {
    return (v: number) => setNodeParam(id, paramId, v);
  }

  // ── The live rich-text model (from node.data.richText, coerced) ──────────
  let model = $derived<RichTextModel>(
    coerceRichTextModel((node?.data as { richText?: unknown } | undefined)?.richText),
  );

  // ── Persist a model into node.data.richText IN PLACE (Yjs-safe) ──────────
  function persistModel(next: RichTextModel) {
    mutateNode(id, (live) => {
      const d = live.data as Record<string, unknown>;
      // Set a single key in place — never reassign live.data.
      d.richText = next;
    });
  }

  // DEBOUNCED persist for live typing. Writing the Y.Doc on EVERY keystroke
  // re-derives `model` → re-renders the SvelteFlow node mid-burst, which resets
  // the contenteditable caret to the start and INTERLEAVES fast-typed chars.
  // Coalescing the writes to ~250 ms after the last keystroke means a typing
  // burst produces ONE write (no re-render storm, no caret reset) — and it also
  // avoids a per-keystroke Y.Doc write storm ([[cv-modulation-live-store-write-storm]]).
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  function persistModelDebounced(next: RichTextModel) {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      persistModel(next);
    }, 250);
  }
  /** Flush a pending debounced write immediately (toolbar actions / blur). */
  function flushPersist() {
    if (!editorEl) return;
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
    persistModel(serializeEditor());
  }

  // ── contenteditable ⇄ model serialization ────────────────────────────────
  // The editor is genuinely minimal: each block-level element (div / p) is a
  // paragraph; inline styled spans become runs. We read computed inline styles
  // to derive bold/italic/underline/color, and the block's text-align for the
  // paragraph alignment.
  let editorEl: HTMLDivElement | null = $state(null);
  // Guard so applying the model → DOM doesn't immediately re-serialize back.
  let applyingToDom = false;

  function styleOfNode(el: HTMLElement): Omit<RichRun, 'text'> {
    const cs = getComputedStyle(el);
    const weight = cs.fontWeight;
    const bold = weight === 'bold' || Number(weight) >= 600;
    const italic = cs.fontStyle === 'italic';
    const underline = cs.textDecorationLine.includes('underline');
    const color = rgbToHex(cs.color);
    const out: Omit<RichRun, 'text'> = {};
    if (bold) out.bold = true;
    if (italic) out.italic = true;
    if (underline) out.underline = true;
    if (color) out.color = color;
    return out;
  }

  function rgbToHex(rgb: string): string | undefined {
    const m = rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!m) return undefined;
    const hex = (n: string) => Number(n).toString(16).padStart(2, '0');
    return `#${hex(m[1]!)}${hex(m[2]!)}${hex(m[3]!)}`;
  }

  function alignOf(el: HTMLElement): RichAlign {
    const a = getComputedStyle(el).textAlign;
    if (a === 'center') return 'center';
    if (a === 'right' || a === 'end') return 'right';
    return 'left';
  }

  /** Collect styled runs from a list of LIVE DOM nodes (text nodes + inline
   *  elements). `parentStyleEl` is the live element whose computed style applies
   *  to a bare text node (so getComputedStyle reads real inherited formatting).
   *  Operates on live nodes only, so bold/italic/underline/colour resolve. */
  function runsFromNodes(nodes: Node[], parentStyleEl: HTMLElement): RichRun[] {
    const runs: RichRun[] = [];
    const visit = (node: Node, styleEl: HTMLElement) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent ?? '';
        if (text.length === 0) return;
        runs.push({ text, ...styleOfNode(styleEl) });
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const ce = node as HTMLElement;
        if (ce.tagName === 'BR') {
          const last = runs[runs.length - 1];
          if (last) last.text += '\n';
          else runs.push({ text: '\n' });
        } else {
          for (const c of Array.from(ce.childNodes)) visit(c, ce);
        }
      }
    };
    for (const n of nodes) visit(n, parentStyleEl);
    if (runs.length === 0) runs.push({ text: '' });
    return runs;
  }

  /** Walk a block element collecting styled runs from its inline descendants. */
  function runsFromBlock(block: HTMLElement): RichRun[] {
    return runsFromNodes(Array.from(block.childNodes), block);
  }

  /** Is an element a block-level paragraph container (DIV / P)? Inline styled
   *  spans + text are gathered into the surrounding paragraph instead. */
  function isBlock(el: HTMLElement): boolean {
    return el.tagName === 'DIV' || el.tagName === 'P';
  }

  /** Serialize the editor DOM into a RichTextModel (keeping the layer fg/bg).
   *  Browsers freely mix DIRECT text nodes / inline spans (the first line) with
   *  block DIVs (later lines), so we group consecutive inline/text content into
   *  an implicit paragraph and emit each block DIV/P as its own paragraph. */
  function serializeEditor(): RichTextModel {
    if (!editorEl) return model;
    const paragraphs: RichParagraph[] = [];
    let loose: Node[] = []; // consecutive LIVE inline/text nodes → one paragraph

    const flushLoose = () => {
      if (loose.length > 0) {
        paragraphs.push({ runs: runsFromNodes(loose, editorEl!), align: alignOf(editorEl!) });
        loose = [];
      }
    };

    for (const child of Array.from(editorEl.childNodes)) {
      if (child.nodeType === Node.ELEMENT_NODE && isBlock(child as HTMLElement)) {
        flushLoose();
        const b = child as HTMLElement;
        paragraphs.push({ runs: runsFromBlock(b), align: alignOf(b) });
      } else {
        // Loose live text node / inline element (SPAN / B / I / U / BR) — the
        // first typed line often lands here before browsers wrap it in a DIV.
        loose.push(child);
      }
    }
    flushLoose();

    if (paragraphs.length === 0) {
      paragraphs.push({ runs: [{ text: '' }], align: alignOf(editorEl) });
    }
    // Cap total chars (a pasted wall of text can't blow up the texture).
    return truncateModelChars(
      { paragraphs, fg: model.fg, bg: layerBg, fontPx, fontFamily },
      MAX_CHARS,
    );
  }

  function onEditorInput() {
    if (applyingToDom) return;
    persistModelDebounced(serializeEditor());
  }
  function onEditorBlur() {
    if (applyingToDom) return;
    flushPersist();
  }

  /** Render a model into the editor DOM (used on mount + remote updates). */
  function applyModelToDom(m: RichTextModel) {
    if (!editorEl) return;
    applyingToDom = true;
    editorEl.innerHTML = '';
    // EMPTY model → leave the contenteditable truly empty. A pre-seeded
    // `<div><br></div>` placeholder makes the browser interleave the first
    // typed characters around the <br> (caret-vs-<br> ordering bug), so an
    // empty editor must start with NO children — the browser then handles the
    // first keystroke cleanly.
    if (modelPlainText(m).length === 0) {
      applyingToDom = false;
      return;
    }
    for (const para of m.paragraphs) {
      const div = document.createElement('div');
      div.style.textAlign = para.align;
      for (const run of para.runs) {
        const segments = run.text.split('\n');
        segments.forEach((seg, i) => {
          if (seg.length > 0) {
            const span = document.createElement('span');
            if (run.bold) span.style.fontWeight = 'bold';
            if (run.italic) span.style.fontStyle = 'italic';
            if (run.underline) span.style.textDecoration = 'underline';
            if (run.color) span.style.color = run.color;
            span.textContent = seg;
            div.appendChild(span);
          }
          if (i < segments.length - 1) div.appendChild(document.createElement('br'));
        });
      }
      if (div.childNodes.length === 0) div.appendChild(document.createElement('br'));
      editorEl.appendChild(div);
    }
    applyingToDom = false;
  }

  // ── Toolbar actions (execCommand — the minimal, dependency-free path) ─────
  // Keep the editor's text selection when a toolbar control is pressed: a
  // mousedown on a button would otherwise blur the contenteditable + collapse
  // the selection, so execCommand('bold'/…) would have nothing to format.
  function keepSelection(e: Event) {
    e.preventDefault();
  }
  function exec(command: string, value?: string) {
    editorEl?.focus();
    document.execCommand(command, false, value);
    // A toolbar action is a discrete intent — persist it now (not debounced).
    flushPersist();
  }
  const setAlign = (a: RichAlign) =>
    exec(a === 'left' ? 'justifyLeft' : a === 'center' ? 'justifyCenter' : 'justifyRight');
  const toggleBold = () => exec('bold');
  const toggleItalic = () => exec('italic');
  const toggleUnderline = () => exec('underline');

  // Per-character text colour (applies to the current selection).
  let runColor = $state('#ffff00');
  function applyRunColor(hex: string) {
    runColor = hex;
    exec('foreColor', hex);
  }

  // Layer BACKGROUND — a single fill behind the WHOLE text block. There is no
  // separate layer-foreground control: the per-selection TEXT colour in the
  // toolbar is the one and only foreground, and there is no per-character
  // background. (model.fg stays as the white fallback for un-coloured glyphs.)
  let layerBg = $state('#000000');
  // Render font size in VIDEO PX (drives on-screen size; MAX = a short word
  // fills the screen). FONT is a whole-layer family choice.
  let fontPx = $state(DEFAULT_FONT_PX);
  let fontFamily = $state(DEFAULT_FONT_FAMILY);
  function setFontPx(v: number) {
    fontPx = clampFontPx(v);
    persistModel(serializeEditor());
    queueRender();
  }
  function setFontFamily(name: string) {
    fontFamily = normalizeFontFamily(name);
    if (editorEl) editorEl.style.fontFamily = fontFamily;
    persistModel(serializeEditor());
    queueRender();
  }
  function setLayerBg(hex: string) {
    layerBg = hex;
    persistModel(serializeEditor());
  }

  // ── Offscreen text canvas → engine texture ───────────────────────────────
  const PAD = 16;

  let textCanvas: HTMLCanvasElement | null = null;
  let measureCtx: CanvasRenderingContext2D | null = null;

  function runFont(run: RichRun, fpx: number): string {
    const style = run.italic ? 'italic ' : '';
    const weight = run.bold ? '700 ' : '400 ';
    const family = normalizeFontFamily(model.fontFamily);
    return `${style}${weight}${fpx}px ${family}`;
  }

  /** Render the current model to the offscreen canvas + push it to the engine. */
  function renderTextCanvasToEngine() {
    // EMPTY model → clear the engine canvas so its built-in "textmarquee"
    // placeholder shows through (an empty editor must not push a black layer).
    if (modelPlainText(model).length === 0) {
      pushClearToEngine();
      return;
    }
    if (!textCanvas) {
      textCanvas = document.createElement('canvas');
    }
    if (!measureCtx) {
      const mc = document.createElement('canvas').getContext('2d');
      measureCtx = mc;
    }
    const mctx = measureCtx;
    if (!mctx) return;

    // Font size (video px) from the model — slider-driven; MAX makes a short word
    // span the frame. LINE_HEIGHT scales with it.
    const fpx = clampFontPx(model.fontPx);
    const LINE_HEIGHT = Math.round(fpx * 1.3);

    const measure = (text: string, run: RichRun): number => {
      mctx.font = runFont(run, fpx);
      return mctx.measureText(text).width;
    };
    const layout = layoutModel(model, measure, LINE_HEIGHT);

    const contentW = Math.max(1, Math.ceil(layout.width));
    const contentH = Math.max(LINE_HEIGHT, Math.ceil(layout.height));
    const canvasW = contentW + PAD * 2;
    const canvasH = contentH + PAD * 2;
    textCanvas.width = canvasW;
    textCanvas.height = canvasH;
    const ctx2d = textCanvas.getContext('2d');
    if (!ctx2d) return;

    // bg fill the whole canvas (the block + its padding).
    ctx2d.fillStyle = model.bg;
    ctx2d.fillRect(0, 0, canvasW, canvasH);
    ctx2d.textBaseline = 'top';

    layout.lines.forEach((line, li) => {
      const ax = lineAlignOffset(line.width, layout.width, line.align);
      const y = PAD + li * LINE_HEIGHT;
      for (const pr of line.runs) {
        ctx2d.font = runFont(pr.run, fpx);
        ctx2d.fillStyle = pr.run.color ?? model.fg;
        const x = PAD + ax + pr.x;
        ctx2d.fillText(pr.text, x, y);
        if (pr.run.underline) {
          const uy = y + fpx * 0.92;
          ctx2d.strokeStyle = pr.run.color ?? model.fg;
          ctx2d.lineWidth = Math.max(1, fpx * 0.06);
          ctx2d.beginPath();
          ctx2d.moveTo(x, uy);
          ctx2d.lineTo(x + pr.width, uy);
          ctx2d.stroke();
        }
      }
    });

    pushCanvasToEngine(textCanvas, canvasW, canvasH);
  }

  function getExtras(): TextmarqueeHandleExtras | null {
    const e = engineCtx.get();
    if (!e) return null;
    try {
      const ve = e.getDomain<VideoEngine>('video');
      const extras = ve.read(id, 'extras') as TextmarqueeHandleExtras | undefined;
      return extras ?? null;
    } catch {
      return null;
    }
  }

  // Retry pushing until the engine has materialized this node (patch-load race,
  // mirrors PictureboxCard.applyBytesToEngine).
  let pushRetryTimer: ReturnType<typeof setTimeout> | null = null;
  function pushCanvasToEngine(canvas: HTMLCanvasElement, w: number, h: number, attempt = 0) {
    const extras = getExtras();
    if (!extras) {
      if (attempt >= 50) return;
      if (pushRetryTimer) clearTimeout(pushRetryTimer);
      pushRetryTimer = setTimeout(() => {
        pushRetryTimer = null;
        pushCanvasToEngine(canvas, w, h, attempt + 1);
      }, 100);
      return;
    }
    extras.setTextCanvas(canvas, w, h);
  }

  // Clear the engine canvas (revert to the built-in placeholder) — for an
  // empty model. Retries until the engine has materialized this node.
  let clearRetryTimer: ReturnType<typeof setTimeout> | null = null;
  function pushClearToEngine(attempt = 0) {
    const extras = getExtras();
    if (!extras) {
      if (attempt >= 50) return;
      if (clearRetryTimer) clearTimeout(clearRetryTimer);
      clearRetryTimer = setTimeout(() => {
        clearRetryTimer = null;
        pushClearToEngine(attempt + 1);
      }, 100);
      return;
    }
    extras.setTextCanvas(null, 0, 0);
  }

  // Re-render the text canvas whenever the model changes (local OR remote).
  // DEFERRED to a rAF so the (canvas alloc + GL upload) work never runs
  // synchronously inside a contenteditable `input` event's reactive flush —
  // doing heavy DOM work there can disturb the caret / reorder typed chars.
  let renderQueued = false;
  function queueRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      renderTextCanvasToEngine();
    });
  }
  $effect(() => {
    // Read the model so the effect tracks it.
    const m = model;
    void m;
    untrack(() => queueRender());
  });

  // ── Live preview of OUT ───────────────────────────────────────────────────
  const ENGINE_W = VIDEO_RES.width;
  const ENGINE_H = VIDEO_RES.height;
  let previewEl: HTMLCanvasElement | null = $state(null);
  let rafId: number | null = null;

  function pump() {
    rafId = requestAnimationFrame(pump);
    const e = engineCtx.get();
    if (!e || !node || !previewEl) return;
    try {
      const ve = e.getDomain<VideoEngine>('video');
      ve.blitOutputToDrawingBuffer(id);
      const src = ve.canvas as unknown as CanvasImageSource;
      const c2d = previewEl.getContext('2d');
      if (c2d) c2d.drawImage(src, 0, 0, ENGINE_W, ENGINE_H, 0, 0, previewEl.width, previewEl.height);
    } catch {
      /* engine not ready */
    }
  }

  onMount(() => {
    // Seed local bg/size/font from the persisted model, paint editor + canvas.
    layerBg = model.bg;
    fontPx = clampFontPx(model.fontPx);
    fontFamily = normalizeFontFamily(model.fontFamily);
    if (editorEl) editorEl.style.fontFamily = fontFamily;
    applyModelToDom(model);
    renderTextCanvasToEngine();
    if (previewEl) {
      previewEl.width = 168;
      previewEl.height = Math.round((168 * ENGINE_H) / ENGINE_W);
    }
    rafId = requestAnimationFrame(pump);
  });
  onDestroy(() => {
    // Flush any pending debounced text edit before the card tears down.
    if (persistTimer) flushPersist();
    if (rafId) cancelAnimationFrame(rafId);
    if (pushRetryTimer) clearTimeout(pushRetryTimer);
    if (clearRetryTimer) clearTimeout(clearRetryTimer);
  });

  let isEmpty = $derived(modelPlainText(model).trim().length === 0);

  // ── Ports — all via the yellow drill-down PatchPanel (no raw side jacks) ──
  const inputs: PortDescriptor[] = [
    { id: 'scrollX', label: 'SCRLX', cable: 'cv' },
    { id: 'scrollY', label: 'SCRLY', cable: 'cv' },
    { id: 'posX',    label: 'POSX',  cable: 'cv' },
    { id: 'posY',    label: 'POSY',  cable: 'cv' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'out', label: 'OUT', cable: 'video' },
  ];
</script>

<div class="mod-card textmarquee-card" data-testid="textmarquee-card">
  <div class="stripe" style="background: var(--cable-video);"></div>
  <ModuleTitle {id} {data} defaultLabel="textmarquee" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <!-- Toolbar. onmousedown preventDefault on every formatting control keeps
         the editor's SELECTION alive when the button is pressed — otherwise the
         click moves focus out of the contenteditable + collapses the selection,
         so document.execCommand has nothing to format. -->
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
    </div>

    <!-- Editor -->
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

    <!-- Layer background (single fill behind the whole text) -->
    <div class="layer-row nodrag">
      <label class="swatch" title="Background — fills the whole layer behind the text">
        <span class="lbl">BG</span>
        <input type="color" class="nodrag" value={layerBg} data-testid="textmarquee-bg"
          oninput={(e) => setLayerBg((e.currentTarget as HTMLInputElement).value)} />
      </label>
    </div>

    <!-- Live preview -->
    <div class="screen-wrap">
      {#if isEmpty}
        <span class="empty-badge" data-testid="textmarquee-empty">TYPE TEXT…</span>
      {/if}
      <canvas bind:this={previewEl} class="screen" data-testid="textmarquee-screen"></canvas>
    </div>

    <!-- Knobs -->
    <div class="row">
      <Knob value={p('scrollX')} min={0} max={1} defaultValue={pdef('scrollX')} label="SCRLX" curve="linear" onchange={setParam('scrollX')} moduleId={id} paramId="scrollX" />
      <Knob value={p('scrollY')} min={0} max={1} defaultValue={pdef('scrollY')} label="SCRLY" curve="linear" onchange={setParam('scrollY')} moduleId={id} paramId="scrollY" />
      <Knob value={p('posX')}    min={0} max={1} defaultValue={pdef('posX')}    label="POSX"  curve="linear" onchange={setParam('posX')}    moduleId={id} paramId="posX" />
      <Knob value={p('posY')}    min={0} max={1} defaultValue={pdef('posY')}    label="POSY"  curve="linear" onchange={setParam('posY')}    moduleId={id} paramId="posY" />
    </div>
  </PatchPanel>
</div>

<style>
  .mod-card {
    width: 280px;
    min-height: 380px;
    background: var(--module-bg);
    border: 1px solid var(--border);
    border-radius: 2px;
    color: var(--text);
    padding-top: 18px;
    padding-bottom: 14px;
    position: relative;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  :global(.svelte-flow__node:hover) .mod-card { border-color: var(--accent-dim); }
  :global(.svelte-flow__node.selected) .mod-card {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent-glow), 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  .stripe { position: absolute; top: 0; left: 0; right: 0; height: 2px; border-radius: 2px 2px 0 0; }

  .toolbar {
    display: flex;
    align-items: center;
    gap: 3px;
    padding: 8px 8px 4px;
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

  .editor {
    margin: 4px 8px 6px;
    min-height: 44px;
    max-height: 110px;
    overflow: auto;
    padding: 6px 8px;
    background: #0c0c10;
    border: 1px solid var(--border);
    border-radius: 3px;
    font-size: 0.85rem;
    line-height: 1.3;
    /* White by default so untouched glyphs render white (the TEXT colour picker
       overrides per selection); getComputedStyle reads this into each run. */
    color: #ffffff;
    outline: none;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .editor:focus { border-color: var(--accent-dim); }

  .layer-row { display: flex; gap: 12px; padding: 0 10px 6px; }

  .screen-wrap {
    margin: 4px auto 10px;
    width: 168px;
    border: 1px solid #000;
    box-shadow: inset 0 0 8px rgba(0, 0, 0, 0.6), 0 0 4px rgba(0, 0, 0, 0.3);
    background: #000;
    border-radius: 3px;
    overflow: hidden;
    position: relative;
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
  .screen { width: 168px; display: block; }

  .row {
    display: flex;
    align-items: flex-start;
    justify-content: center;
    gap: 6px;
    padding: 0 8px;
  }
</style>
