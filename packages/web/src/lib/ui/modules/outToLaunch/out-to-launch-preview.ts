// packages/web/src/lib/ui/modules/outToLaunch/out-to-launch-preview.ts
//
// THE 9×9 MONITOR PREVIEW, drawn once and imported twice.
//
// This is the picture OUT TO LAUNCH is FOR: the def's own docs call it "the 9x9
// preview shows exactly what the LEDs show, so you can dial it in without
// hardware", which is the module's only surface on a machine with no Launchpad
// attached.
//
// ⚠ IT LIVES HERE, NOT IN THE COMPONENT THAT DRAWS IT. The arithmetic used to
// belong to whichever surface painted the preview, and re-typing the geometry
// or the transform in a second one would be the "a surface must never RE-TYPE
// what its def declares" defect one layer over: no runtime gate compares two
// `.svelte` files, so a divergence would be invisible and a surface would
// quietly show a DIFFERENT picture than the hardware.
//
// Everything here is pure 2-D canvas + arithmetic — no WebGL context is created,
// so this file stays out of the WebGL attest basis (which takes from
// `lib/ui/modules` only cards whose source creates one).

import {
  LP_MONITOR_COLS,
  LP_MONITOR_ROWS,
  lpMonitorIndex,
  rgb8ToLp,
  CC_LOGO,
  LP_RGB_MAX,
} from '$lib/control/launchpad/launchpad-sysex';

/** Preview geometry, lifted verbatim from the card so the two surfaces are
 *  pixel-identical rather than merely similar. */
export const OTL_PREVIEW_CELL = 22;
export const OTL_PREVIEW_GAP = 3;
export const OTL_PREVIEW_PAD = 7;

/** The preview canvas is SQUARE: nine cells, eight gaps, two pads. */
export const OTL_PREVIEW_PX =
  LP_MONITOR_COLS * OTL_PREVIEW_CELL +
  (LP_MONITOR_COLS - 1) * OTL_PREVIEW_GAP +
  OTL_PREVIEW_PAD * 2;

/** Display value for an 8-bit channel through the SAME transform the LEDs get
 *  (so the preview matches the hardware), then scaled back to 0..255. */
function disp(v8: number, bright: number, gamma: number): number {
  return Math.round((rgb8ToLp(v8, bright, gamma) / LP_RGB_MAX) * 255);
}

/** Top-origin canvas position of a cell. `row` counts BOTTOM→top, matching the
 *  engine's upright bottom-origin readback and the Launchpad's own pad 11. */
function cellXY(col: number, row: number): { x: number; y: number } {
  return {
    x: OTL_PREVIEW_PAD + col * (OTL_PREVIEW_CELL + OTL_PREVIEW_GAP),
    y: OTL_PREVIEW_PAD + (LP_MONITOR_ROWS - 1 - row) * (OTL_PREVIEW_CELL + OTL_PREVIEW_GAP),
  };
}

/** Pads render as rounded squares; the top row, right column and logo render as
 *  circles, mirroring the Launchpad's round buttons. */
function paintCell(
  c2d: CanvasRenderingContext2D,
  x: number,
  y: number,
  isPad: boolean,
  index: number,
): void {
  c2d.beginPath();
  if (isPad) {
    c2d.roundRect(x, y, OTL_PREVIEW_CELL, OTL_PREVIEW_CELL, 4);
  } else {
    const cx = x + OTL_PREVIEW_CELL / 2;
    const cy = y + OTL_PREVIEW_CELL / 2;
    const rad = index === CC_LOGO ? OTL_PREVIEW_CELL * 0.32 : OTL_PREVIEW_CELL * 0.42;
    c2d.arc(cx, cy, rad, 0, Math.PI * 2);
  }
  c2d.fill();
}

/**
 * Paint one frame of the 9×9 monitor preview.
 *
 * `grid` is the module's `read('grid9x9')` readback — 81 RGBA texels,
 * bottom-origin, row-major. `undefined` (no engine, no node yet) paints the
 * unlit surface, which is also exactly what a node with nothing patched into
 * `in` produces: the def's shader writes constant black when `uHasInput < 0.5`,
 * so an unpatched preview is DETERMINISTIC rather than merely dark.
 */
export function drawOutToLaunchPreview(
  c2d: CanvasRenderingContext2D,
  grid: Uint8Array | undefined,
  bright: number,
  gamma: number,
): void {
  c2d.fillStyle = '#060608';
  c2d.fillRect(0, 0, OTL_PREVIEW_PX, OTL_PREVIEW_PX);
  for (let row = 0; row < LP_MONITOR_ROWS; row++) {
    for (let col = 0; col < LP_MONITOR_COLS; col++) {
      const p = (row * LP_MONITOR_COLS + col) * 4;
      const r = grid ? disp(grid[p] ?? 0, bright, gamma) : 0;
      const g = grid ? disp(grid[p + 1] ?? 0, bright, gamma) : 0;
      const b = grid ? disp(grid[p + 2] ?? 0, bright, gamma) : 0;
      const { x, y } = cellXY(col, row);
      const index = lpMonitorIndex(col, row);
      const isPad = col < 8 && row < 8;
      // Socket (unlit) first, then the lit colour on top, so the 9×9 is always
      // legible as a grid even on a black frame.
      c2d.fillStyle = '#131318';
      paintCell(c2d, x, y, isPad, index);
      if (r + g + b > 0) {
        c2d.fillStyle = `rgb(${r}, ${g}, ${b})`;
        paintCell(c2d, x, y, isPad, index);
      }
    }
  }
}
