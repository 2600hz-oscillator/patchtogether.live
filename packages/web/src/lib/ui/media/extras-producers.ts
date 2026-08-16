// packages/web/src/lib/ui/media/extras-producers.ts
//
// THE NODE-LIFETIME EXTRAS PRODUCERS (#1720). See ./node-extras-registry for the
// mechanism, the measurement, and why this is a registry rather than a permanent
// off-screen card mount.
//
// Each producer is a pure function of `node.data` plus the module's own already
// pure helpers, which is the whole reason a node-lifetime owner is possible:
//   painter      $lib/video/modules/painter-draw  (coerceOps / applyVectorOp /
//                floodFill / hexToRgba — the deterministic op replay the CARD
//                already ran on mount, moved to an owner that outlives it)
//   textmarquee  $lib/video/modules/textmarquee-layout (coerceRichTextModel /
//                layoutModel / lineAlignOffset — the same rasterizer the card
//                ran, verbatim)
//   picturebox   $lib/video/modules/picturebox-encode (base64ToImageBitmap /
//                decodeAnimatedGif) + $lib/video/asset-select (slotForVOct)
//   toybox       the SAME picturebox decode, per image LAYER — found while
//                writing the deny-by-default verdict for ToyboxCard, not
//                reported by the issue
//
// ⚠ EVERY import here is READ-ONLY on `lib/video/**`. That directory is hashed
// WHOLESALE for the WebGL attest, so importing is free and editing is not. If a
// producer ever needs a new helper, add it OUTSIDE `lib/video/**`.

import {
  coerceOps,
  applyVectorOp,
  floodFill,
  hexToRgba,
  PAINT_BG,
  type PaintOp,
} from '$lib/video/modules/painter-draw';
import {
  coerceRichTextModel,
  layoutModel,
  lineAlignOffset,
  modelPlainText,
  clampFontPx,
  normalizeFontFamily,
  type RichRun,
  type RichTextModel,
} from '$lib/video/modules/textmarquee-layout';
import {
  base64ToImageBitmap,
  decodeAnimatedGif,
  GIF_MIME,
} from '$lib/video/modules/picturebox-encode';
import { ASSET_SLOTS, slotForVOct } from '$lib/video/asset-select';
import { LAYER_COUNT, type ToyboxLayer } from '$lib/video/toybox-content';
import { VIDEO_RES } from '$lib/video/engine';
import type { PainterHandleExtras } from '$lib/video/modules/painter';
import type { TextmarqueeHandleExtras } from '$lib/video/modules/textmarquee';
import type { PictureboxHandleExtras } from '$lib/video/modules/picturebox';
import type { ToyboxHandleExtras } from '$lib/video/modules/toybox';
import type { ExtrasProducer, ExtrasSurface, ProduceCtx, PumpCtx } from './node-extras-registry';

/** Padding around the rasterized text block, in video px. Verbatim from
 *  TextmarqueeCard — the block's bounding box is what the module scrolls, so a
 *  different pad here would move the picture. */
const TEXT_PAD = 16;

/** Line height as a multiple of the font size. Verbatim from TextmarqueeCard. */
const LINE_HEIGHT_RATIO = 1.3;

type Ctx2D = CanvasRenderingContext2D;

function ctx2dOf(surface: ExtrasSurface): Ctx2D | null {
  return (surface.getContext('2d') as Ctx2D | null) ?? null;
}

// ── PAINTER ──────────────────────────────────────────────────────────────────

/** Replay the committed op log onto `ctx`, from a blank MS-Paint page. The
 *  deterministic replay PainterCard.syncFromOps runs, moved to node lifetime. */
export function replayPaintOps(ctx: Ctx2D, ops: readonly PaintOp[], w: number, h: number): void {
  ctx.fillStyle = PAINT_BG;
  ctx.fillRect(0, 0, w, h);
  for (const op of ops) {
    if (op.kind === 'fill') {
      try {
        const img = ctx.getImageData(0, 0, w, h);
        floodFill(img, op.x, op.y, hexToRgba(op.color));
        ctx.putImageData(img, 0, 0);
      } catch {
        /* getImageData can throw on a tainted context — skip that op */
      }
      continue;
    }
    if (op.kind === 'snapshot') continue; // raster checkpoints are not generated yet
    applyVectorOp(ctx, op);
  }
}

const painterProducer: ExtrasProducer = {
  type: 'painter',
  why:
    "PAINTER's picture is the deterministic replay of the Y.Doc op log at " +
    '`node.data.ops`, so it can be rebuilt from graph state alone. The CARD was ' +
    'the only thing that ever replayed it, which is why a saved rack rendered a ' +
    'blank white page (measured meanRGB 255,255,255 against the drawing\'s 255,0,0). ' +
    'The card still CLAIMS the binding while it is mounted, because its canvas is ' +
    'the live drawing surface and an in-progress stroke must show on the output ' +
    'before the op commits — same log, same replay, one of two surfaces bound.',
  signature(node) {
    const ops = (node.data as { ops?: unknown } | undefined)?.ops;
    // The op log is append-only per commit, so length + the last op's identity
    // is a faithful digest and is O(1) where JSON.stringify would be O(log).
    // UNDO pops, CLEAR empties — both move the length, so both are caught.
    if (!Array.isArray(ops)) return 'none';
    const last = ops.length > 0 ? ops[ops.length - 1] : null;
    return `${ops.length}:${last ? JSON.stringify(last) : ''}`;
  },
  produce(ctx: ProduceCtx) {
    const surface = ctx.surface();
    const c2d = ctx2dOf(surface);
    if (!c2d) return;
    replayPaintOps(
      c2d,
      coerceOps((ctx.node.data as { ops?: unknown } | undefined)?.ops),
      surface.width,
      surface.height,
    );
    (ctx.extras as PainterHandleExtras).setPaintCanvas(
      surface as unknown as HTMLCanvasElement,
    );
  },
};

// ── TEXTMARQUEE ──────────────────────────────────────────────────────────────

function runFont(run: RichRun, fpx: number, model: RichTextModel): string {
  const style = run.italic ? 'italic ' : '';
  const weight = run.bold ? '700 ' : '400 ';
  const family = normalizeFontFamily(model.fontFamily);
  return `${style}${weight}${fpx}px ${family}`;
}

/**
 * Rasterize a rich-text model into `surface` and return the CONTENT size the
 * module scrolls. Verbatim from TextmarqueeCard.renderTextCanvasToEngine —
 * moved, not reimplemented, so the picture cannot drift between the two.
 * Returns null when there is no context to draw into.
 */
export function rasterizeRichText(
  surface: ExtrasSurface,
  measureCtx: Ctx2D,
  model: RichTextModel,
): { width: number; height: number } | null {
  const fpx = clampFontPx(model.fontPx);
  const lineHeight = Math.round(fpx * LINE_HEIGHT_RATIO);
  const measure = (text: string, run: RichRun): number => {
    measureCtx.font = runFont(run, fpx, model);
    return measureCtx.measureText(text).width;
  };
  const layout = layoutModel(model, measure, lineHeight);

  const contentW = Math.max(1, Math.ceil(layout.width));
  const contentH = Math.max(lineHeight, Math.ceil(layout.height));
  const canvasW = contentW + TEXT_PAD * 2;
  const canvasH = contentH + TEXT_PAD * 2;
  surface.width = canvasW;
  surface.height = canvasH;
  const c2d = ctx2dOf(surface);
  if (!c2d) return null;

  c2d.fillStyle = model.bg;
  c2d.fillRect(0, 0, canvasW, canvasH);
  c2d.textBaseline = 'top';

  layout.lines.forEach((line, li) => {
    const ax = lineAlignOffset(line.width, layout.width, line.align);
    const y = TEXT_PAD + li * lineHeight;
    for (const pr of line.runs) {
      c2d.font = runFont(pr.run, fpx, model);
      c2d.fillStyle = pr.run.color ?? model.fg;
      const x = TEXT_PAD + ax + pr.x;
      c2d.fillText(pr.text, x, y);
      if (pr.run.underline) {
        const uy = y + fpx * 0.92;
        c2d.strokeStyle = pr.run.color ?? model.fg;
        c2d.lineWidth = Math.max(1, fpx * 0.06);
        c2d.beginPath();
        c2d.moveTo(x, uy);
        c2d.lineTo(x + pr.width, uy);
        c2d.stroke();
      }
    }
  });
  return { width: canvasW, height: canvasH };
}

const textmarqueeProducer: ExtrasProducer = {
  type: 'textmarquee',
  why:
    "TEXTMARQUEE's picture is `node.data.richText` rasterized to a canvas, and " +
    'the CRAWL is animated ENGINE-side from `frame.time` (textmarquee.ts ' +
    'computeDrawOffset) — the card\'s rAF loop is a PREVIEW blit of the engine ' +
    'output, not a producer, so there is no live loop to keep alive. Unmounted, ' +
    'the node showed its built-in "textmarquee" placeholder instead of the ' +
    "user's text (measured nonBlack 446/49152 against the text's 36992/49152).",
  signature(node) {
    const rich = (node.data as { richText?: unknown } | undefined)?.richText;
    // The model is small and bounded (MAX_CHARS), so a full digest is cheap and
    // catches every styling change a length-only digest would miss.
    try {
      return JSON.stringify(coerceRichTextModel(rich));
    } catch {
      return 'none';
    }
  },
  produce(ctx: ProduceCtx) {
    const extras = ctx.extras as TextmarqueeHandleExtras;
    const model = coerceRichTextModel(
      (ctx.node.data as { richText?: unknown } | undefined)?.richText,
    );
    if (modelPlainText(model).length === 0) {
      // EMPTY model → clear, so the module's own placeholder shows through. An
      // empty editor must not push a black layer.
      extras.setTextCanvas(null, 0, 0);
      return;
    }
    const measureCtx = ctx.measure() as Ctx2D | null;
    if (!measureCtx) return;
    const surface = ctx.surface();
    const size = rasterizeRichText(surface, measureCtx, model);
    if (!size) return;
    extras.setTextCanvas(
      surface as unknown as HTMLCanvasElement,
      size.width,
      size.height,
    );
  },
};

// ── PICTUREBOX ───────────────────────────────────────────────────────────────

interface PictureboxData {
  imageBytes?: string | null;
  imageMime?: string;
  imageName?: string | null;
  assets?: (string | null)[];
  assetMimes?: (string | null)[];
}

/** Per-NODE scratch PICTUREBOX keeps for the life of the node. */
interface PictureboxState {
  /** Rising-edge state for the ASSET GATE pump. */
  lastGate?: number;
  /** Has this producer ever uploaded an ACTIVE image for this node? See the
   *  clear-guard in `produce` — a blanket `setImage(null)` wipes the slot the
   *  gate just selected, because setImage writes into the ACTIVE SLOT. */
  pushedImage?: boolean;
}

const pictureboxProducer: ExtrasProducer = {
  type: 'picturebox',
  why:
    "PICTUREBOX's picture is `node.data.imageBytes` / `node.data.assets` decoded " +
    'and uploaded — pure persisted state, decoded identically on every peer. ' +
    'Unmounted, the node showed its idle field instead of the loaded image ' +
    '(measured meanRGB 5,15,20 against the image\'s 0,0,254). It also carries the ' +
    'only PUMP in this file: the ASSET GATE / ASSET PITCH cv inputs were polled ' +
    'by an interval on the CARD, so with no card the two jacks were patched, ' +
    'connected and inert and the displayed slot LATCHED at its last selection.',
  signature(node) {
    const d = (node.data ?? {}) as PictureboxData;
    const assets = Array.isArray(d.assets) ? d.assets : [];
    const mimes = Array.isArray(d.assetMimes) ? d.assetMimes : [];
    // Byte strings are large (base64 JPEGs), so digest LENGTHS rather than
    // contents: a different image is a different length in every practical case
    // and, more importantly, the MIME + name are included, so a re-encode of the
    // same source at the same size still re-pushes when anything else moved.
    const slot = assets.map((a, i) => `${a?.length ?? 0}/${mimes[i] ?? ''}`).join(',');
    return `${d.imageBytes?.length ?? 0}:${d.imageMime ?? ''}:${d.imageName ?? ''}|${slot}`;
  },
  async produce(ctx: ProduceCtx) {
    const extras = ctx.extras as PictureboxHandleExtras;
    const d = (ctx.node.data ?? {}) as PictureboxData;

    // ⚠ ORDER IS LOAD-BEARING: SLOTS FIRST, THE ACTIVE IMAGE LAST.
    // `setImage` uploads into the ACTIVE SLOT (picturebox.ts: "Back-compat:
    // setImage uploads into the ACTIVE slot"), so a slot pass that runs
    // AFTERWARDS and clears an empty slot 0 wipes the single-image path's
    // upload. Measured while building this: with the image first, the node
    // read meanRGB (5,15,20) — its idle field — with the image bytes present
    // and decoded, i.e. exactly the same reading as the bug this fixes.
    // The card got away with it only because its two `$effect`s raced through
    // separate retry timers; one function means one deterministic order.

    // ── the 7 SLOTS, pre-decoded so a gate switch is an index flip ─────────
    const assets = Array.isArray(d.assets) ? d.assets : [];
    const mimes = Array.isArray(d.assetMimes) ? d.assetMimes : [];
    for (let i = 0; i < ASSET_SLOTS; i++) {
      const slotBytes = assets[i] ?? null;
      if (!slotBytes) {
        extras.setAssetAtSlot(i, null);
        continue;
      }
      const mime = mimes[i] ?? 'image/jpeg';
      try {
        if (mime === GIF_MIME) {
          const frames = await decodeAnimatedGif(slotBytes, mime);
          if (frames && frames.length > 1) {
            extras.setAnimatedAtSlot(i, frames);
            continue;
          }
          extras.setAssetAtSlot(i, await base64ToImageBitmap(slotBytes, mime));
          continue;
        }
        extras.setAssetAtSlot(i, await base64ToImageBitmap(slotBytes));
      } catch (err) {
        console.warn(
          `[picturebox] slot ${i} decode failed:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    // ── the ACTIVE image ──────────────────────────────────────────────────
    const st = ctx.state as PictureboxState;
    const bytes = d.imageBytes ?? null;
    if (!bytes) {
      // ⚠ CLEAR ONLY WHAT WE PUSHED. `setImage(null)` uploads null into the
      // ACTIVE SLOT, so a node that only ever had SLOT assets would have the
      // gate-selected slot wiped by an unconditional clear. MEASURED: the
      // asset-select round trip failed on its first leg with exactly this.
      if (st.pushedImage) {
        extras.setImage(null);
        extras.setAnimatedImage(null);
        extras.setFilename(null);
        st.pushedImage = false;
      }
      return;
    }
    const mime = d.imageMime ?? 'image/jpeg';
    try {
      if (mime === GIF_MIME) {
        const frames = await decodeAnimatedGif(bytes, mime);
        if (frames && frames.length > 1) {
          extras.setAnimatedImage(frames);
        } else {
          // Degrade: a static first frame. No error — just no motion.
          extras.setImage(await base64ToImageBitmap(bytes, mime));
        }
      } else {
        extras.setImage(await base64ToImageBitmap(bytes));
      }
      extras.setFilename(d.imageName ?? null);
      st.pushedImage = true;
    } catch (err) {
      // A peer sent something we cannot parse. Do NOT clear the image — the
      // writer's local copy still works; log and leave what is there.
      console.warn('[picturebox] decode failed:', err instanceof Error ? err.message : err);
    }
  },
  pump(ctx: PumpCtx) {
    // Rising-edge detect on the raw (bridge-written) ASSET GATE level, then map
    // ASSET PITCH's V/oct to a slot and select it if that slot holds an asset.
    // A black-key pitch (slotForVOct → null) or an empty slot is ignored — keep
    // showing the current asset. The selection is purely LOCAL render state:
    // every peer computes it from the same synced gate + synced assets, so it
    // is never written to the Y.Doc (the cv-modulation write-storm rule).
    //
    // ⚠ This is a polled PARAM level, not an AnalyserNode buffer rescan, so the
    // `createEdgeCounter` rule (which exists because a 2048-sample ring overlaps
    // the scheduler tick and double-counts) does not apply: one sample per tick,
    // one compare, no window.
    const state = ctx.state as PictureboxState;
    const extras = ctx.extras as PictureboxHandleExtras;
    const g = ctx.engine.readParam(ctx.node, 'asset_gate') ?? 0;
    const last = state.lastGate ?? 0;
    state.lastGate = g;
    if (!(last < 0.5 && g >= 0.5)) return;
    const slot = slotForVOct(ctx.engine.readParam(ctx.node, 'asset_pitch') ?? 0);
    if (slot == null) return;
    if (extras.slotHasAsset?.(slot)) extras.selectSlot(slot);
  },
};

// ── TOYBOX (image layers only) ───────────────────────────────────────────────

const toyboxProducer: ExtrasProducer = {
  type: 'toybox',
  why:
    'A TOYBOX IMAGE layer is `node.data.layers[i].imageBytes` — a base64 JPEG on ' +
    'the Y.Doc — decoded and uploaded, which is PICTUREBOX wearing a layer index ' +
    '(toybox-content.ts says so: "base64-encoded JPEG bytes (PICTUREBOX-style, ' +
    'synced over Y.Doc) … The card decodes + uploads"), so the same node-lifetime ' +
    'owner reproduces it. Found while writing the deny-by-default verdict for ' +
    'this card and confirmed against toybox.ts renderImageLayer, which paints the ' +
    'idle pattern until `hasImage` — set ONLY inside setLayerImage. ' +
    '⚠ SCOPE, stated: the VIDEO half of this channel (`attachLayerVideo`) is NOT ' +
    'here and is not a defect. Those bytes are a user-picked LOCAL FILE that no ' +
    'peer and no reload can reconstruct, and within a session the attach already ' +
    'survives a card unmount — nothing detaches it (card-media-lifetime.test.ts ' +
    'forbids `attachLayerVideo(…, null)` in an unmount path and asserts ' +
    'ToyboxCard clean), and the element itself is node-owned by nodeMedia (#1589).',
  signature(node) {
    const layers = (node.data as { layers?: unknown } | undefined)?.layers;
    if (!Array.isArray(layers)) return 'none';
    return (layers as ToyboxLayer[])
      .slice(0, LAYER_COUNT)
      .map((l) => `${l?.kind ?? ''}:${l?.imageBytes?.length ?? 0}`)
      .join(',');
  },
  async produce(ctx: ProduceCtx) {
    const extras = ctx.extras as ToyboxHandleExtras;
    const st = ctx.state as { pushed?: boolean[] };
    const pushed = (st.pushed ??= new Array<boolean>(LAYER_COUNT).fill(false));
    const layers = ((ctx.node.data as { layers?: unknown } | undefined)?.layers ??
      []) as ToyboxLayer[];
    for (let i = 0; i < LAYER_COUNT; i++) {
      const layer = layers[i];
      const bytes = layer?.kind === 'image' ? (layer.imageBytes ?? null) : null;
      if (!bytes) {
        // CLEAR ONLY WHAT WE PUSHED — same rule as picturebox, and here it also
        // avoids allocating a per-layer image source for the (common) layers
        // that will never hold one.
        if (pushed[i]) {
          extras.setLayerImage(i, null);
          pushed[i] = false;
        }
        continue;
      }
      try {
        extras.setLayerImage(i, await base64ToImageBitmap(bytes));
        pushed[i] = true;
      } catch (err) {
        console.warn('[toybox] image decode failed:', err instanceof Error ? err.message : err);
      }
    }
  },
};

/**
 * The node-lifetime extras producers, DENY BY DEFAULT: a module type absent
 * from this table gets no node-lifetime producer, and
 * card-media-lifetime.test.ts is what refuses to let a card sit on the extras
 * channel without a declared owner.
 */
export const EXTRAS_PRODUCERS: readonly ExtrasProducer[] = [
  painterProducer,
  textmarqueeProducer,
  pictureboxProducer,
  toyboxProducer,
];

/** The module TYPES that have a node-lifetime producer. Derived — never a
 *  second hand-maintained list. */
export const EXTRAS_PRODUCER_TYPES: ReadonlySet<string> = new Set(
  EXTRAS_PRODUCERS.map((p) => p.type),
);

/** The engine-resolution surface PAINTER draws into (its output is the canvas
 *  1:1). TEXTMARQUEE sizes its own surface to the text block, so this is only
 *  the initial allocation there. */
export const PAINTER_SURFACE = { width: VIDEO_RES.width, height: VIDEO_RES.height };
