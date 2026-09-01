// packages/web/src/lib/graph/textmarquee-editor.ts
//
// TEXTMARQUEE's DOM ⇄ RICH-TEXT-MODEL SERIALIZER — shared by the legacy card
// and by the face's `fullViewBody`, so the two cannot disagree about what a
// typed paragraph MEANS.
//
// ── WHY IT IS HERE AND NOT IN `textmarquee-layout.ts` ──────────────────────
//
// ⚠ `packages/web/src/lib/video/**` IS THE WebGL ATTEST BASIS, WHOLE-DIRECTORY
// AND FAIL-CLOSED (`scripts/webgl-attest-lib.ts` → `resolveWebglBasis()` step 1).
// Adding ~150 lines of exported serializer to `textmarquee-layout.ts` would move
// the content hash and put an owner-machine real-GPU re-attest on the critical
// path of a change that touches no shader, no uniform and no pixel. IMPORTING
// from that directory is free — only files INSIDE it are hashed — so this module
// takes its types and its `truncateModelChars` cap from there and lives out
// here, on the `$lib/graph/picturebox-data` precedent.
//
// ── ⚠ THE THING THIS EXTRACTION ACTUALLY FIXES: INHERITED CSS IS DATA ───────
//
// `styleOfNode` reads `getComputedStyle`. That is not an implementation detail
// of the editor's look — it is the PERSISTED DOCUMENT'S SEMANTICS. Every run
// with no inline style of its own serializes whatever the editor element's
// CASCADE resolved to, and the result is written into `node.data.richText`,
// synced to collaborators and rasterized into the video texture.
//
// `TextmarqueeCard.svelte`'s `.editor` rule set `color:#ffffff` and
// `white-space:pre-wrap` and inherited nothing else that mattered, because a
// card is a leaf in its own subtree. The face's body mounts under
// `.dock-ext-body`, which sets NONE of them and sits inside a faceplate whose
// text colour is `var(--text, #eef1f5)`. Re-hosting the same `contenteditable`
// there without this module would have:
//
//   * stamped `color:'#eef1f5'` on every untouched run (silently recolouring
//     the video output of every rack anyone opened the dock on),
//   * stamped `bold:true` on every run under any ancestor with
//     `font-weight >= 600`,
//   * stamped `align:'center'` on every paragraph under a centred ancestor,
//
// and the STILL-LIVE legacy card would then read that corruption back. So both
// surfaces call `applyEditorBaseStyle` on the element before anything is read
// out of it: the editor's serialized-in style contract is set EXPLICITLY, on
// the element, not inherited from wherever it happens to be mounted.
//
// ⚠ THE DECISION LOGIC IS PURE AND THE DOM READ IS ONE LINE, deliberately. The
// web unit suite runs in `environment: 'node'` — there is no `getComputedStyle`
// — so `runStyleFrom` / `alignFrom` / `rgbToHex` take plain strings and are
// covered by `textmarquee-editor.test.ts`. What NO unit test can see is which
// values the cascade actually hands over on a real page; that is what the
// default-shell leg of `textmarquee-face-editor.spec.ts` is for.

import type {
  RichAlign,
  RichParagraph,
  RichRun,
  RichTextModel,
} from '$lib/video/modules/textmarquee-layout';
import { truncateModelChars, MAX_CHARS } from '$lib/video/modules/textmarquee-layout';

/**
 * The style contract the editor element must carry EXPLICITLY on itself, in
 * every surface that hosts it.
 *
 * ⚠ EACH ENTRY IS HERE BECAUSE `serializeEditor` READS IT BACK, not because it
 * looks nice. `color` becomes `run.color`; `fontWeight` / `fontStyle` /
 * `textDecorationLine` become `bold` / `italic` / `underline`; `textAlign`
 * becomes `paragraph.align`. `whiteSpace: pre-wrap` is the one that is about
 * TEXT rather than style, and it is just as load-bearing: without it the
 * browser collapses runs of spaces before the text node is ever read, so
 * "A    B" serializes as "A B" and the marquee loses the spacing the player
 * typed.
 *
 * `#ffffff` is the value the card has always used, so a rack saved before the
 * face existed round-trips byte-identically.
 */
export const EDITOR_BASE_STYLE: Readonly<Record<string, string>> = {
  color: '#ffffff',
  fontWeight: 'normal',
  fontStyle: 'normal',
  textDecoration: 'none',
  textAlign: 'left',
  whiteSpace: 'pre-wrap',
};

/** Stamp `EDITOR_BASE_STYLE` onto a live editor element. Call it on mount, in
 *  EVERY surface, before the first serialize — see the header. */
export function applyEditorBaseStyle(el: HTMLElement): void {
  for (const [prop, value] of Object.entries(EDITOR_BASE_STYLE)) {
    el.style.setProperty(
      // `fontWeight` → `font-weight`; setProperty wants the CSS spelling.
      prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`),
      value,
    );
  }
}

/** The four computed-style fields a run's style is derived from. A plain
 *  object so the decision logic is testable without a DOM. */
export interface RunStyleSource {
  fontWeight: string;
  fontStyle: string;
  textDecorationLine: string;
  color: string;
}

/** `rgb(r, g, b)` / `rgba(...)` → `#rrggbb`, or undefined when it is neither.
 *  PURE. */
export function rgbToHex(rgb: string): string | undefined {
  const m = rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return undefined;
  const hex = (n: string) => Number(n).toString(16).padStart(2, '0');
  return `#${hex(m[1]!)}${hex(m[2]!)}${hex(m[3]!)}`;
}

/** Resolved computed style → the run's style flags. PURE. */
export function runStyleFrom(cs: RunStyleSource): Omit<RichRun, 'text'> {
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

/** A computed `text-align` → the model's alignment. PURE. `start`/`justify`
 *  and anything unknown fall back to `left`, matching the card. */
export function alignFrom(textAlign: string): RichAlign {
  if (textAlign === 'center') return 'center';
  if (textAlign === 'right' || textAlign === 'end') return 'right';
  return 'left';
}

/** The live-DOM read. One line each, so everything above stays testable. */
function styleOfNode(el: HTMLElement): Omit<RichRun, 'text'> {
  return runStyleFrom(getComputedStyle(el) as unknown as RunStyleSource);
}
function alignOf(el: HTMLElement): RichAlign {
  return alignFrom(getComputedStyle(el).textAlign);
}

/** Is an element a block-level paragraph container (DIV / P)? Inline styled
 *  spans + text are gathered into the surrounding paragraph instead. */
export function isBlock(el: HTMLElement): boolean {
  return el.tagName === 'DIV' || el.tagName === 'P';
}

/** Collect styled runs from a list of LIVE DOM nodes (text nodes + inline
 *  elements). `parentStyleEl` is the live element whose computed style applies
 *  to a bare text node, so bold/italic/underline/colour resolve against the
 *  real cascade rather than a detached clone. */
export function runsFromNodes(nodes: Node[], parentStyleEl: HTMLElement): RichRun[] {
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
export function runsFromBlock(block: HTMLElement): RichRun[] {
  return runsFromNodes(Array.from(block.childNodes), block);
}

/** The whole-layer settings a surface owns outside the editor DOM: the
 *  background swatch, the size slider, the font picker, plus the model's
 *  inherited foreground fallback. */
export interface EditorLayerState {
  fg: string;
  bg: string;
  fontPx: number;
  fontFamily: string;
}

/**
 * Serialize a live editor element into a `RichTextModel`.
 *
 * Browsers freely mix DIRECT text nodes / inline spans (the first typed line)
 * with block DIVs (later lines), so consecutive inline/text content is grouped
 * into an implicit paragraph and each block DIV/P is emitted as its own.
 *
 * The total character count is capped at `MAX_CHARS` — a pasted wall of text
 * must not blow up the rasterized texture.
 */
export function serializeEditor(
  editorEl: HTMLElement,
  layer: EditorLayerState,
): RichTextModel {
  const paragraphs: RichParagraph[] = [];
  let loose: Node[] = []; // consecutive LIVE inline/text nodes → one paragraph

  const flushLoose = () => {
    if (loose.length > 0) {
      paragraphs.push({ runs: runsFromNodes(loose, editorEl), align: alignOf(editorEl) });
      loose = [];
    }
  };

  for (const child of Array.from(editorEl.childNodes)) {
    if (child.nodeType === Node.ELEMENT_NODE && isBlock(child as HTMLElement)) {
      flushLoose();
      const b = child as HTMLElement;
      paragraphs.push({ runs: runsFromBlock(b), align: alignOf(b) });
    } else {
      loose.push(child);
    }
  }
  flushLoose();

  if (paragraphs.length === 0) {
    paragraphs.push({ runs: [{ text: '' }], align: alignOf(editorEl) });
  }
  return truncateModelChars(
    {
      paragraphs,
      fg: layer.fg,
      bg: layer.bg,
      fontPx: layer.fontPx,
      fontFamily: layer.fontFamily,
    },
    MAX_CHARS,
  );
}

/**
 * Render a model into an editor element (mount + remote update).
 *
 * ⚠ AN EMPTY MODEL LEAVES THE ELEMENT TRULY EMPTY. A pre-seeded
 * `<div><br></div>` placeholder makes the browser interleave the first typed
 * characters around the `<br>` (the caret-vs-`<br>` ordering bug), so an empty
 * editor must start with NO children and let the browser handle the first
 * keystroke.
 */
export function applyModelToDom(editorEl: HTMLElement, m: RichTextModel): void {
  editorEl.innerHTML = '';
  const plain = m.paragraphs.map((p) => p.runs.map((r) => r.text).join('')).join('\n');
  if (plain.length === 0) return;
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
}
