// packages/present-shell/parse-features.cjs
//
// Parse the web app's window.open() "features" string into display bounds.
// The web present flow (lib/ui/modules/present-window.ts → computePopupFeatures)
// emits "popup,left=<x>,top=<y>,width=<w>,height=<h>" carrying the TARGET
// display's working-area rect. The shell turns each such window.open into a
// borderless fullscreen native window at those bounds, so a multi-projector
// "Present on all displays" lands one chrome-less, overlay-free window per
// display. Pure (no Electron) so it runs under `node --test`.

/** @typedef {{ left: number, top: number, width: number, height: number }} Bounds */

/** Parse a window.open features string into integer bounds. Unknown/garbage
 *  keys are ignored; missing numerics stay 0 (the caller treats 0 w/h as
 *  "no rect → fall back to fullscreen on the current display"). Negative
 *  left/top are preserved (a display positioned left of / above the primary). */
function parseFeatures(features) {
  /** @type {Bounds} */
  const out = { left: 0, top: 0, width: 0, height: 0 };
  for (const part of String(features || '').split(',')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k in out && /^-?\d+$/.test(v)) out[k] = parseInt(v, 10);
  }
  return out;
}

/** Returns a placement rect ({x,y,width,height}) from a features string, or
 *  null when no usable size was present (caller fullscreens the current display). */
function boundsFromFeatures(features) {
  const f = parseFeatures(features);
  if (f.width > 0 && f.height > 0) {
    return { x: f.left, y: f.top, width: f.width, height: f.height };
  }
  return null;
}

module.exports = { parseFeatures, boundsFromFeatures };
