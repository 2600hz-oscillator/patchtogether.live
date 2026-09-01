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
  // map, the [[yjs-save-load-real-ydoc]] trap). ⚠ The RENDER-AND-PUSH half does
  // NOT live here: it is node-lifetime, in $lib/ui/media/extras-producers, so
  // the node shows your text with no card mounted (#1720). This card writes the
  // MODEL and nothing else. See the note further down.
  //
  // Plus four knobs (ScrlX/ScrlY scroll speed, PosX/PosY position) each with a
  // matching CV input, and a live preview of the OUT layer.
  //
  // ⚠ THIS IS THE LEGACY SURFACE NOW (2026-08-31). textmarquee is in
  // STRICT_FACES, so the shipping shell renders `ModuleShell` plus the face's
  // `fullViewBody` ($lib/ui/modules/textmarquee/TextmarqueeEditorBody.svelte);
  // this card is reached only under `?shell=legacy`. The two share ONE
  // serializer ($lib/graph/textmarquee-editor) and ONE `previewCollapsed` key,
  // deliberately — they must not be able to disagree about a document or about
  // whether the screen is on.

  import { onMount, onDestroy } from 'svelte';
  import { type NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { useEngine } from '$lib/audio/engine-context';
  import { setNodeParam, mutateNode } from '$lib/graph/mutate';
  import {
    textmarqueeDef,
  } from '$lib/video/modules/textmarquee';
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
  // ⚠ THE SERIALIZER IS SHARED WITH THE FACE BODY (2026-08-31). It used to be
  // ~150 lines private to this file; both surfaces now call one copy, and both
  // stamp `EDITOR_BASE_STYLE` on the editor element so the styles the
  // serializer READS BACK are set explicitly rather than inherited from
  // whatever mounts them. See $lib/graph/textmarquee-editor's header — the
  // inherited-cascade hole it closes was a data corruption, not a look.
  import {
    applyEditorBaseStyle,
    applyModelToDom as applyModelToEditor,
    serializeEditor as serializeEditorDom,
  } from '$lib/graph/textmarquee-editor';
  import type { VideoEngine } from '$lib/video/engine';
  import { VIDEO_RES } from '$lib/video/engine';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { portsFromDef, paramSpec } from './card-kit';
  import { drawPreviewDownscaled } from './preview-downscale';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  // ⚠ RANGES COME FROM THE DEF, NEVER RE-TYPED HERE. This card used to spell
  // `min={0} max={1}` on all four knobs — four hand-copied bounds a def-reading
  // gate cannot see disagreeing with the contract. `paramSpec` is the accessor
  // form deliberately: exporting a `*_RANGE` constant from `textmarquee.ts`
  // would move the WebGL attest hash, and an accessor does not.
  const SPEC = {
    scrollX: paramSpec(textmarqueeDef, 'scrollX'),
    scrollY: paramSpec(textmarqueeDef, 'scrollY'),
    posX: paramSpec(textmarqueeDef, 'posX'),
    posY: paramSpec(textmarqueeDef, 'posY'),
  } as const;

  function p(name: keyof typeof SPEC): number {
    return node?.params[name] ?? SPEC[name].defaultValue;
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
  // ⚠ EXTRACTED (2026-08-31). The ~110 lines that used to live here —
  // styleOfNode, rgbToHex, alignOf, runsFromNodes, runsFromBlock, isBlock,
  // serializeEditor — are now `$lib/graph/textmarquee-editor`, called by this
  // card AND by the face's TextmarqueeEditorBody. One copy, so the two surfaces
  // cannot disagree about what a typed paragraph MEANS, and it lives OUTSIDE
  // `lib/video/**` so it costs no WebGL attest.
  let editorEl: HTMLDivElement | null = $state(null);
  // Guard so applying the model → DOM doesn't immediately re-serialize back.
  let applyingToDom = false;

  /** Serialize the editor DOM into a RichTextModel (keeping the layer fg/bg). */
  function serializeEditor(): RichTextModel {
    if (!editorEl) return model;
    return serializeEditorDom(editorEl, {
      fg: model.fg,
      bg: layerBg,
      fontPx,
      fontFamily,
    });
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
    applyModelToEditor(editorEl, m);
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
    // persistModel writes node.data.richText; the node-lifetime producer
    // re-rasterizes off that. No card-side render call to make (#1720).
    persistModel(serializeEditor());
  }
  function setFontFamily(name: string) {
    fontFamily = normalizeFontFamily(name);
    if (editorEl) editorEl.style.fontFamily = fontFamily;
    persistModel(serializeEditor());
  }
  function setLayerBg(hex: string) {
    layerBg = hex;
    persistModel(serializeEditor());
  }

  // ── THE TEXT TEXTURE IS NODE-OWNED, NOT CARD-OWNED (#1720) ────────────────
  //
  // This card used to rasterize `node.data.richText` to an offscreen canvas and
  // push it with `read('extras').setTextCanvas(...)`, retrying until the engine
  // had materialized the node. It was the ONLY writer of that texture — so under
  // the faceplate shell, where an un-migrated module's card exists only inside
  // the dock full-view, a SAVED rack rendered the module's built-in
  // "textmarquee" placeholder instead of your text, on LOAD, before anything was
  // touched. Measured on the default /rack, reading the node's own output
  // texture: nonBlack 446/49152 with the card never mounted vs 36992/49152 with
  // it open.
  //
  // The rasterizer MOVED, verbatim, to $lib/ui/media/extras-producers
  // (`rasterizeRichText`), driven by $lib/ui/media/node-extras-registry, which
  // is keyed to GRAPH lifetime and swept from Canvas. It is now the ONLY writer,
  // so the two cannot disagree — this card was NOT left pushing in parallel.
  //
  // Nothing was lost by the move. The card's render was ALREADY driven off the
  // persisted model (`model` is `coerceRichTextModel(node.data.richText)`, and
  // the effect that queued a render tracked exactly that), so a keystroke
  // reached the texture through the Y.Doc either way. And the CRAWL is animated
  // ENGINE-side from `frame.time` (textmarquee.ts `computeDrawOffset`) — the
  // `pump()` below is a PREVIEW blit of the engine output into this card's
  // little canvas and writes nothing to the engine, which is why enrolling this
  // module in CARD_PRODUCER_LANE_TYPES would have been the wrong fix.

  // ── Live preview of OUT ───────────────────────────────────────────────────
  const ENGINE_W = VIDEO_RES.width;
  const ENGINE_H = VIDEO_RES.height;
  let previewEl: HTMLCanvasElement | null = $state(null);
  let rafId: number | null = null;

  // ⚠ THE CARD NOW HONOURS `previewCollapsed` (2026-08-31, with the face). It
  // used to blit unconditionally, against the fleet rule — so a player who
  // switched SCREEN off on the faceplate and then opened `?shell=legacy` got
  // the picture back, and the two surfaces disagreed about a key they share.
  //
  // ⚠ AND THE COLLAPSED BRANCH STILL MARKS THE NODE WATCHED, for the reason
  // acidwarp's body states: `blitOutputForPreview` IS the engine's "someone is
  // watching" signal, and textmarquee is a SOURCE, so a collapsed state that
  // merely stopped blitting would drop it out of the pull set and turn SCREEN
  // into a producer kill switch for everything downstream of `out`.
  //
  // Default absent ⇒ false ⇒ ON, so no existing rack changes.
  //
  // ⚠ READ FRESH INSIDE THE LOOP, NOT THROUGH A `$derived`. `patch`/`node.data`
  // reads are not reliably reactive in the legacy card subtree
  // ([[patch-reads-are-not-reactive-in-the-legacy-card-subtree]]), and the Yjs
  // node proxy's identity never changes, so a derived over it can never
  // recompute ([[yjs-proxy-stable-identity-defeats-derived]]). The rAF already
  // runs every frame; a direct read is both simpler and correct.
  function isPreviewCollapsed(): boolean {
    return (node?.data as { previewCollapsed?: boolean } | undefined)?.previewCollapsed ?? false;
  }

  function pump() {
    rafId = requestAnimationFrame(pump);
    const e = engineCtx.get();
    if (!e || !node) return;
    try {
      const ve = e.getDomain<VideoEngine>('video');
      if (isPreviewCollapsed()) {
        ve.markWatched(id);
        return;
      }
      if (!previewEl) return;
      // #1802 — gated preview blit (see VideoEngine.blitOutputForPreview).
      // The rAF is re-armed at the TOP of pump(), so a bare return is safe.
      if (!ve.blitOutputForPreview(id)) return;
      const src = ve.canvas as unknown as CanvasImageSource;
      const c2d = previewEl.getContext('2d');
      if (c2d)
        drawPreviewDownscaled(c2d, src, 0, 0, previewEl.width, previewEl.height, {
          x: 0,
          y: 0,
          w: ENGINE_W,
          h: ENGINE_H,
        });
    } catch {
      /* engine not ready */
    }
  }

  onMount(() => {
    // Seed local bg/size/font from the persisted model, paint editor + canvas.
    layerBg = model.bg;
    fontPx = clampFontPx(model.fontPx);
    fontFamily = normalizeFontFamily(model.fontFamily);
    if (editorEl) {
      // ⚠ THE SERIALIZED-IN STYLE CONTRACT, STAMPED ON THE ELEMENT. It used to
      // come from this card's `.editor` CSS rule, which meant the editor's
      // MEANING depended on where it was mounted — the exact hole the face body
      // would have fallen through. Both surfaces set it explicitly now, from
      // the one shared constant.
      applyEditorBaseStyle(editorEl);
      editorEl.style.fontFamily = fontFamily;
    }
    applyModelToDom(model);
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
  });

  let isEmpty = $derived(modelPlainText(model).trim().length === 0);

  // ── Ports — all via the yellow drill-down PatchPanel (no raw side jacks) ──
  const inputs = portsFromDef(textmarqueeDef.inputs, {
    scrollX: 'SCRLX', scrollY: 'SCRLY', posX: 'POSX', posY: 'POSY',
  });
  const outputs = portsFromDef(textmarqueeDef.outputs);
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
      <Knob value={p('scrollX')} min={SPEC.scrollX.min} max={SPEC.scrollX.max} defaultValue={SPEC.scrollX.defaultValue} label="SCRLX" curve={SPEC.scrollX.curve} onchange={setParam('scrollX')} moduleId={id} paramId="scrollX" />
      <Knob value={p('scrollY')} min={SPEC.scrollY.min} max={SPEC.scrollY.max} defaultValue={SPEC.scrollY.defaultValue} label="SCRLY" curve={SPEC.scrollY.curve} onchange={setParam('scrollY')} moduleId={id} paramId="scrollY" />
      <Knob value={p('posX')}    min={SPEC.posX.min}    max={SPEC.posX.max}    defaultValue={SPEC.posX.defaultValue}    label="POSX"  curve={SPEC.posX.curve}    onchange={setParam('posX')}    moduleId={id} paramId="posX" />
      <Knob value={p('posY')}    min={SPEC.posY.min}    max={SPEC.posY.max}    defaultValue={SPEC.posY.defaultValue}    label="POSY"  curve={SPEC.posY.curve}    onchange={setParam('posY')}    moduleId={id} paramId="posY" />
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
    /* ⚠ `color` AND `white-space` MOVED OUT OF THIS RULE (2026-08-31). They are
       what `serializeEditor` reads back out of the DOM, so they are DATA, and
       leaving them in a per-surface stylesheet is what would have let the face
       body inherit `--text` and stamp #eef1f5 onto every untouched run. Both
       surfaces now stamp `EDITOR_BASE_STYLE` on the ELEMENT (onMount →
       applyEditorBaseStyle), which wins over this rule anyway. The values are
       unchanged: white on dark, pre-wrap. */
    outline: none;
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
