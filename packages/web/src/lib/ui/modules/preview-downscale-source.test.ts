// packages/web/src/lib/ui/modules/preview-downscale-source.test.ts
//
// THE GATE FOR "A CARD NEVER SHRINKS A PICTURE IN ONE TAP" (#1846).
//
// ── WHY A SOURCE GATE ──────────────────────────────────────────────────────
//
// The defect is invisible to every runtime gate this repo has. `drawImage` with
// a smaller destination rect is a legal call that returns nothing and throws
// nothing; the only evidence it was wrong is a comb pattern in pixels, and the
// only place pixels are compared is VRT — where the preview canvases are the
// one region a baseline cannot pin, because they carry live engine content.
// So the rule has to be held where it is written: in the source.
//
// Deny-by-default, per CALL, not per file. A card is allowed a 1:1 blit
// (`drawImage(img, dx, dy)` — three arguments, no resampling, cannot alias);
// anything that names a destination WIDTH AND HEIGHT is a resample and must go
// through `drawPreviewDownscaled`, which shrinks in ≤2× steps. Each exception
// is named by its `(file, receiver, first argument)` triple rather than by
// filename, so a NEW single-tap downscale in an already-listed file still
// reddens — WavesculptVizSurface has four exempt calls and a fifth would fail
// here.
//
// ── ⚠ WHAT THIS GATE STRUCTURALLY CANNOT SEE ───────────────────────────────
//
//   * ANYTHING OUTSIDE `packages/web/src/lib/ui/modules/**/*.svelte`. A `.ts`
//     module, a worker, the recorder registry, `e2e/` — all invisible. The
//     rule is written where the cards are because that is where the class
//     lives; a downscale added elsewhere is not covered by anything here.
//   * WHETHER THE RESULT LOOKS RIGHT. It reads argument COUNTS. A card could
//     call the helper with the wrong rect and this stays green;
//     `preview-downscale.test.ts` holds the ratio maths, and only an eye holds
//     "does the picture look like the source".
//   * A RESAMPLE EXPRESSED SOME OTHER WAY — `ctx.scale()` then a 3-arg draw,
//     `createImageBitmap({ resizeWidth })`, a CSS-scaled canvas. Those are real
//     ways to alias and none of them are drawImage calls.
//   * WHETHER AN EXEMPT CALL IS STILL A GOOD IDEA. It only asserts the call is
//     still THERE, so the list cannot rot into names of nothing.

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The shared helper every resampling preview must route through. */
const HELPER = 'drawPreviewDownscaled';

/**
 * A `drawImage` call that resamples, identified by where it is and what it
 * draws — never by filename alone, so an already-listed file is still guarded
 * against a NEW single-tap downscale.
 */
interface ExemptCall {
  /** Path relative to this directory. */
  file: string;
  /** The receiver: `ctx2d` in `ctx2d.drawImage(...)`. */
  receiver: string;
  /** The first argument's source text, whitespace-collapsed. */
  firstArg: string;
  /** ⚠ REQUIRED, and `tsc` refuses the entry without it. Why this particular
   *  call must NOT be routed through the shared downscale. */
  why: string;
}

const EXEMPT_CALLS: readonly ExemptCall[] = [
  {
    file: 'FoxyCard.svelte',
    receiver: 'c',
    firstArg: 'stage',
    why:
      'DELIBERATELY CRISP. The line above sets imageSmoothingEnabled = false: FOXY is ' +
      'pixel art and hard edges are the look. A box-filtered downscale would soften ' +
      'exactly what the card exists to show, and #1846 says so by name.',
  },
  {
    file: 'RasterizeCard.svelte',
    receiver: 'ctx2d',
    firstArg: 'stage',
    why:
      'DELIBERATELY CRISP, same as FOXY — imageSmoothingEnabled = false two lines above. ' +
      'RASTERIZE renders a coarse pixel grid on purpose; smoothing it is the bug, not the fix.',
  },
  {
    file: 'rasterize/RasterizeOutputBody.svelte',
    receiver: 'ctx2d',
    firstArg: 'stage',
    why:
      'DELIBERATELY CRISP — the RasterizeCard entry above, on the FACE surface. Promotion ' +
      'moves this module from its card to a fullViewBody extension, and the picture is the ' +
      'same coarse pixel grid for the same reason, so the same exemption applies: ' +
      'imageSmoothingEnabled = false two lines above, and smoothing it is the bug. ⚠ It is ' +
      'also OUT of scope for the #1846 defect on its merits, not merely by preference — that ' +
      'bug is aliasing when a card resamples the SHARED WebGL DRAWING BUFFER, and these ' +
      'pixels never come from it: they are a Uint8ClampedArray painted by RasterPainter on ' +
      'the audio side and handed over as ImageData.',
  },
  {
    file: 'foxy/FoxyOutputBody.svelte',
    receiver: 'ctx2d',
    firstArg: 'stage',
    why:
      'DELIBERATELY CRISP — the FoxyCard entry above, on the FACE surface, and it is here for ' +
      'the reason the DELIBERATELY_CRISP header states rather than by analogy: promotion makes ' +
      "`migrated()` true, so from this PR onward nothing renders FoxyCard on either default " +
      'surface and an assertion about ITS smoothing stops protecting anything a player can ' +
      'see. The three rasters are a 256x256 Uint8ClampedArray of hard pixels painted by ' +
      'RasterPainter, scaled into 72x72 with imageSmoothingEnabled = false two lines above; a ' +
      'box-filtered downscale would soften exactly the banding the picture exists to show. ' +
      'It is also OUT of scope for the #1846 defect on its merits: that bug is aliasing when a ' +
      'card resamples the SHARED WebGL DRAWING BUFFER, and these pixels never touch it — foxy ' +
      'is an AUDIO def whose rasters are painted on the audio side and handed over as ImageData.',
  },
  // ── SKIFREE — the pair added BY the bug this form fixes ──────────────────
  //
  // ⚠ THESE TWO ENTRIES EXIST BECAUSE THE THREE-ARGUMENT FORM WAS THE DEFECT
  // HERE, WHICH IS THE OPPOSITE OF EVERY OTHER ROW ABOVE. `SkifreeCard` drew
  // `drawImage(src, 0, 0)` under a comment arguing it was "genuinely 1:1, both
  // canvases are sized from the SAME exported constant". The premise is FALSE:
  // the vendored bundle OVERWRITES the canvas it is handed —
  // `canvas.width = Math.round(width * dpr)` — so the source is 640x640 on any
  // DPR >= 2 display while the destination is 320x320, and a three-argument
  // draw paints the source at NATIVE size into a quarter of the area. The
  // player saw the TOP-LEFT QUADRANT of the ski slope with the skier in the
  // corner. ⚠ NEITHER THIS GATE NOR ANY OTHER COULD SEE IT: this file reads
  // argument COUNTS (and the three-arg form is the one it blesses), and
  // Playwright and VRT both run at `deviceScaleFactor: 1`, where the two
  // numbers coincide and the bug does not exist. The honest spelling names the
  // destination, and the destination is derived from `src.width/height` rather
  // than from `SKIFREE_CANVAS_SIZE`, because the source size is the bundle's to
  // choose.
  {
    file: 'SkifreeCard.svelte',
    receiver: 'c2d',
    firstArg: 'src',
    why:
      'DELIBERATELY CRISP, and the resample is REAL rather than incidental — the source is the '
      + 'vendored skifree.js bundle\'s own canvas, which it sizes to `width * devicePixelRatio`, '
      + 'so this is a genuine 2:1 downscale on a retina display and a 1:1 copy elsewhere. SKIFREE '
      + 'is 1991 pixel art (imageSmoothingEnabled = false three lines above) and a box-filtered '
      + 'downscale would soften exactly the sprite grid the game exists to show — the FOXY / '
      + 'RASTERIZE argument, on a source this repo does not own. ⚠ It is also OUT of scope for '
      + 'the #1846 defect on its merits, not merely by preference: that bug is aliasing when a '
      + 'card resamples the SHARED WebGL DRAWING BUFFER, and these pixels never touch it — '
      + 'skifree is an AUDIO def whose canvas is painted by a 2-D context inside a committed '
      + 'third-party IIFE.',
  },
  {
    file: 'skifree/SkifreeScreen.svelte',
    receiver: 'c2d',
    firstArg: 'src',
    why:
      'DELIBERATELY CRISP — the SkifreeCard entry above, on the FACE surface, and the shared one: '
      + 'this ONE component is both the dock `fullViewBody` (320 CSS px, steerable) and the lane '
      + '`tileBody` (104 CSS px, read-only), so the lane tile is a genuine ~6:1 downscale of the '
      + 'bundle\'s 640-px canvas and smoothing it would turn a sprite field into grey mush. '
      + 'imageSmoothingEnabled = false two lines above. Promotion makes `migrated()` true, so '
      + 'from this PR onward nothing renders SkifreeCard on either default surface and an '
      + 'assertion about ITS smoothing stops protecting anything a player can see — the '
      + 'FoxyOutputBody situation exactly. ⚠ Also out of scope for #1846 on its merits: an AUDIO '
      + 'def whose pixels come from a 2-D context in a vendored bundle, never from the shared '
      + 'WebGL drawing buffer.',
  },
  {
    file: 'SynesthesiaCard.svelte',
    receiver: 'ctx2d',
    firstArg: 'imageSource',
    why:
      'NOT A DISPLAY — an ANALYSIS readback. The very next lines getImageData() this ' +
      'canvas and run videoChannelLevels() over it to derive audio levels. Changing the ' +
      'resampling filter changes those NUMBERS, which is a behaviour change wearing a ' +
      'quality fix as a disguise.',
  },
  // ⚠ THE FOUR WAVESCULPT ENTRIES MOVED FILE, NOT SUBSTANCE. The renderer was
  // extracted from WavesculptCard.svelte into
  // wavesculpt/WavesculptVizSurface.svelte, and every one of these calls went
  // with it — so did the WebGL context, and therefore so did the attest-basis
  // membership each `why` below rests on. The ANCHOR clause caught all four in
  // the same run, which is the deny-by-default list behaving correctly: an
  // exemption naming a call that no longer exists is RED, not quietly ignored.
  {
    file: 'wavesculpt/WavesculptVizSurface.svelte',
    receiver: 'ctx2d',
    firstArg: 'src',
    why:
      'NOT A DISPLAY — the LUMA_GRID analysis readback feeding the bandpass feature ' +
      'detector. Same class as SYNESTHESIA: the output is numbers, and a different ' +
      'filter is a different measurement.',
  },
  {
    file: 'wavesculpt/WavesculptVizSurface.svelte',
    receiver: 'tc2d',
    firstArg: 'renderCanvas as CanvasImageSource',
    why:
      'A genuine preview downscale that WOULD benefit — but this file is one of only two ' +
      'card-tree files in the WebGL ATTEST BASIS (it creates the WebGL context), so ' +
      'editing it forces a trusted-GPU re-attest for a change that moves zero GL pixels. ' +
      'Deferred deliberately; it is a separate, owner-scheduled change.',
  },
  {
    file: 'wavesculpt/WavesculptVizSurface.svelte',
    receiver: 'ctx2d',
    firstArg: 'spectrographScratch',
    why:
      'The spectrograph scratch is SPEC_W x SPEC_H and is drawn to the presentation canvas, ' +
      'which is normally LARGER — an upscale, where a single tap is already correct. Also in ' +
      'the WebGL attest basis (see above).',
  },
  {
    file: 'wavesculpt/WavesculptVizSurface.svelte',
    receiver: 'dc2',
    firstArg: 'renderCanvas as CanvasImageSource',
    why:
      'The flipped display blit (translate + scale(1,-1)). Same attest-basis cost as the ' +
      'other wavesculpt entries, and the transform means any change here needs its own ' +
      'visual check rather than a mechanical swap.',
  },
  {
    file: 'cube/CubeVizSurface.svelte',
    receiver: 'c2d',
    firstArg: 'offscreen as CanvasImageSource',
    why:
      'The other card file IN THE WEBGL ATTEST BASIS. blitCube() copies its own offscreen ' +
      'render target to a same-purpose target, so the reduction is small or none; not worth ' +
      'a GPU re-attest.',
  },
  {
    file: 'cube/CubeVizSurface.svelte',
    receiver: 'ctx2d',
    firstArg: 'sliceScratch as CanvasImageSource',
    why:
      'SLICE_RES scratch drawn UP to the slice viewport (it already sets ' +
      'imageSmoothingEnabled = true for exactly that reason). An upscale needs no ' +
      'progressive halving, and this file is in the WebGL attest basis.',
  },
  {
    file: 'TimelordeCard.svelte',
    receiver: 'ctx2d',
    firstArg: 'img',
    why:
      'NOT A DISPLAY — this paints an UPSTREAM frame into TIMELORDE\'s own scratch, which ' +
      'is then pushed back into the graph as displayFrame. It is a CONTENT path: changing ' +
      'the filter changes what downstream modules receive, not how a preview looks.',
  },
  {
    file: 'TimelordeCard.svelte',
    receiver: 'ctx2d',
    firstArg: 'owlImg',
    why:
      'A decorative still image (the idle owl) aspect-fitted into the frame, not the shared ' +
      'engine drawing buffer. It already sets imageSmoothingEnabled = true, and the reduction ' +
      'from the asset to the frame is small.',
  },
  {
    file: 'TimelordeCard.svelte',
    receiver: 'sctx',
    firstArg: 'displayCanvas',
    why:
      'NOT A DISPLAY — the DISPLAY_W x DISPLAY_H staging copy that becomes an ImageBitmap ' +
      'written back to the engine as displayFrame. Content path, same as the img entry above.',
  },
];

/** The cards the owner reported in #1846. Anchoring the fix itself: if any of
 *  these stops routing through the helper the gate is red, whatever the rest of
 *  the tree does. */
const REPORTED_IN_1846 = [
  'VideoOutCard.svelte',
  'BentboxCard.svelte',
  'VideoTileThumb.svelte',
] as const;

/** Surfaces whose whole point is hard pixels. Named here so "foxy and rasterize
 *  are unchanged" is a PERMANENT assertion rather than a claim in a PR body.
 *
 *  ⚠ THE FACE BODY IS IN THIS LIST FOR A REASON THAT WOULD OTHERWISE HAVE BEEN
 *  LOST. Promoting a module makes `migrated()` true, and neither surface renders
 *  its card after that — so from the promotion onward `RasterizeCard.svelte` is
 *  code nobody looks at, and an assertion about ITS smoothing stops protecting
 *  anything a user can see. The face body is where the guarantee has to live to
 *  keep meaning what it meant. The card stays listed too: it is still the
 *  `?shell=legacy` surface, and dropping it would quietly narrow the claim. */
const DELIBERATELY_CRISP = [
  'FoxyCard.svelte',
  'foxy/FoxyOutputBody.svelte',
  'RasterizeCard.svelte',
  'rasterize/RasterizeOutputBody.svelte',
] as const;

// ---------------------------------------------------------------------------
// The scanner. ONE predicate, used by the sweep AND by its negative controls.
// ---------------------------------------------------------------------------

interface FoundCall {
  file: string;
  line: number;
  receiver: string;
  firstArg: string;
  argCount: number;
}

/** Split a call's top-level arguments starting at the index of its '('. */
function splitArgs(src: string, open: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let start = open + 1;
  let quote: string | null = null;
  for (let i = open; i < src.length; i++) {
    const c = src[i]!;
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) {
        args.push(src.slice(start, i));
        return args;
      }
    } else if (c === ',' && depth === 1) {
      args.push(src.slice(start, i));
      start = i + 1;
    }
  }
  return args;
}

const DRAW_IMAGE = /([A-Za-z_$][\w$]*)\s*\??\.\s*drawImage\s*\(/g;

/**
 * Every RESAMPLING `drawImage` in `src`. A 3-argument call is a 1:1 blit and is
 * not one; 5 and 9 argument calls name a destination width and height and are.
 */
function findResamplingDraws(src: string, file: string): FoundCall[] {
  const out: FoundCall[] = [];
  DRAW_IMAGE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DRAW_IMAGE.exec(src))) {
    const open = m.index + m[0].length - 1;
    const args = splitArgs(src, open);
    if (args.length <= 3) continue;
    out.push({
      file,
      line: src.slice(0, m.index).split('\n').length,
      receiver: m[1]!,
      firstArg: args[0]!.trim().replace(/\s+/g, ' '),
      argCount: args.length,
    });
  }
  return out;
}

function cardFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && p.endsWith('.svelte')) out.push(p);
    }
  };
  walk(HERE);
  return out.sort();
}

const key = (c: { file: string; receiver: string; firstArg: string }): string =>
  `${c.file} :: ${c.receiver}.drawImage(${c.firstArg}, …)`;

const ALL_DRAWS: FoundCall[] = cardFiles().flatMap((abs) =>
  findResamplingDraws(readFileSync(abs, 'utf8'), relative(HERE, abs).split('\\').join('/')),
);

describe('#1846 — no card resamples a picture in a single drawImage tap', () => {
  it('the scanner is looking at cards at all', () => {
    // Vacuity leg with real slack: the sweep below asserts an EMPTY offender
    // list, which a scanner that found no files would also produce.
    expect(cardFiles().length).toBeGreaterThan(EXEMPT_CALLS.length);
    expect(ALL_DRAWS.length).toBeGreaterThan(0);
  });

  it('every resampling drawImage is either routed through the helper or NAMED here', () => {
    const declared = new Set(EXEMPT_CALLS.map(key));
    const offenders = ALL_DRAWS.filter((c) => !declared.has(key(c))).map(
      (c) =>
        `${c.file}:${c.line} — ${c.receiver}.drawImage(${c.firstArg}, …) ` +
        `(${c.argCount} args) resamples in ONE tap. Route it through ${HELPER}() ` +
        `from ./preview-downscale, or add a NAMED entry with a why.`,
    );
    expect(offenders).toEqual([]);
  });

  it('ANCHOR: every named exemption still resolves to a call that exists', () => {
    const found = new Set(ALL_DRAWS.map(key));
    const stale = EXEMPT_CALLS.filter((e) => !found.has(key(e))).map(
      (e) => `${key(e)} — no such call. Delete the entry; do not maintain it.`,
    );
    expect(stale).toEqual([]);
    const missingFiles = EXEMPT_CALLS.map((e) => e.file).filter(
      (f) => !existsSync(join(HERE, f)),
    );
    expect(missingFiles).toEqual([]);
  });

  it('every exemption carries a real reason', () => {
    const thin = EXEMPT_CALLS.filter((e) => e.why.trim().length < 60).map(key);
    expect(thin).toEqual([]);
  });

  it('the cards reported in #1846 route through the helper', () => {
    const missing = REPORTED_IN_1846.filter(
      (f) => !readFileSync(join(HERE, f), 'utf8').includes(HELPER),
    );
    expect(missing).toEqual([]);
  });

  it('NEGATIVE CONTROL: the deliberately-crisp cards stay crisp and stay OUT', () => {
    // The claim "#1846 did not touch foxy/rasterize", pinned. Both halves: the
    // smoothing is still off, AND neither imports the smoothing helper.
    for (const f of DELIBERATELY_CRISP) {
      const src = readFileSync(join(HERE, f), 'utf8');
      expect(src, `${f} must keep imageSmoothingEnabled = false`).toMatch(
        /imageSmoothingEnabled\s*=\s*false/,
      );
      expect(src.includes(HELPER), `${f} must NOT import ${HELPER}`).toBe(false);
    }
  });

  it('NEGATIVE CONTROL: the predicate can tell a resample from a 1:1 blit', () => {
    // The SAME function the sweep calls, driven both directions. Without this a
    // scanner that matched nothing would report a clean sweep forever.
    const resample = findResamplingDraws('ctx2d.drawImage(src, 0, 0, 160, 120);', 'x');
    expect(resample.map((c) => [c.receiver, c.firstArg, c.argCount])).toEqual([
      ['ctx2d', 'src', 5],
    ]);
    const nineArg = findResamplingDraws(
      'c.drawImage(src, 0, 0, 1024, 768, 0, 0, 160, 120);',
      'x',
    );
    expect(nineArg).toHaveLength(1);
    expect(findResamplingDraws('cx.drawImage(bmp, 0, 0);', 'x')).toEqual([]);
    expect(findResamplingDraws(`${HELPER}(ctx2d, src, 0, 0, 160, 120);`, 'x')).toEqual([]);
  });
});
