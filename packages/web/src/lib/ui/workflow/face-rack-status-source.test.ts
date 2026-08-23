// packages/web/src/lib/ui/workflow/face-rack-status-source.test.ts
//
// THE #2024 CLOSE — RACK-GLOBAL STATUS has a face home, and the home cannot
// become a fourth resting-text mechanism.
//
// ── THE DEFECT ─────────────────────────────────────────────────────────────
//
// `cvBuddy` / `cvBuddyMini` share one card body, and nearly everything that
// body shows is a property of THE RACK: which ES-9 jacks this instance was
// allocated (a function of every CV Buddy present, of either kind), whether an
// ES-9 exists at all, and a CLOCK SECTION rendered only on the id-smallest
// instance because RUN and CLOCK are single-source. #2024 measured that none of
// it is reachable by a param-reading resolver and none of it may be PAINTED as
// text — a collision between a module's design and a ruling that post-dates it,
// which blocked the face outright until the owner ruled "close the gap".
//
// ── WHAT THIS GATE HOLDS ───────────────────────────────────────────────────
//
// DENY BY DEFAULT, in three directions, because each alone is blind:
//
//   FORWARD   a face that DECLARES `rackStatus` must own a `fullViewBody` that
//             can actually carry it: it reads the PATCH (the rack-global fact)
//             and paints its status through `StatusLed` (the shape that keeps a
//             measurement out of a text node). Without this the declaration is
//             a band-suppression with nothing left on the plate.
//   COHERENT  its `primaryOnlyBands` name bands the face really declares, and
//             its `peers` name types really registered — INCLUDING itself.
//             ⚠ This one matters more than it looks: a renamed band leaves the
//             suppression pointing at nothing and FAILS OPEN, painting exactly
//             the dead controls the field exists to hide, with no symptom.
//   ROSTERED  every `fullViewBody` in the tree declares what its own canvas
//             PAINTS. This is the half that converts `face-resting-text-source`'s
//             largest named blind spot — "an extension body can `fillText()`
//             anything and no gate will ever see it" — from an unbounded
//             admission into an enumerated, anchored population.
//
// ⚠ AND THE ROLE IS VERIFIED, NOT TRUSTED. A roster where an author writes
// `role: 'picture'` beside a body that paints a paragraph would be a ledger of
// claims. Each role therefore carries a MECHANICAL predicate that must hold of
// the source: a `picture` body really mounts a `<canvas>`; a `status-primitive`
// body really imports `StatusLed` and really has no canvas. An entry cannot be
// wrong in the direction that matters without reddening.
//
// ── ⚠ WHAT THIS GATE STRUCTURALLY CANNOT SEE ───────────────────────────────
//
//   * WHAT A CANVAS PAINTS. This is the irreducible residue of the blind spot
//     and it is NOT closed here. A body declared `picture` may `fillText` a
//     live decimal into its own canvas and every check in this file stays
//     green. The dock VRT baseline is the only thing that sees those pixels and
//     a human reviewing it is the only thing that judges them. What changed is
//     that the population is now NAMED and ANCHORED: a new body with no entry
//     is red, and an entry for a body that no longer exists is red.
//   * WHETHER THE BAND ACTUALLY LEAVES. It reads SOURCE, not a render. The
//     browser half is `cv-buddy-face.spec.ts`, which drives a real SECOND
//     instance; the pure half is `rack-status-model.test.ts`.
//   * WHETHER "PRIMARY" IS THE RIGHT NODE. That is a claim about a MODULE's own
//     allocator, and it is asserted where the allocator lives —
//     `cv-buddy-face-model.test.ts`, exhaustively.
//   * A BODY THAT PAINTS STATUS WITHOUT THE PRIMITIVE. A hand-rolled
//     `<span>{skips}</span>` inside a body declared `picture` is invisible
//     here. That is the same residue as the first bullet, by another route.

import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripSourceComments } from '$lib/source-guards/strip-source-comments';
import { listModuleDefs } from '$lib/audio/module-registry';
import { listVideoModuleDefs } from '$lib/video/module-registry';
import { listMetaModuleDefs } from '$lib/meta/module-registry';
import '$lib/audio/modules';
import '$lib/video/modules';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULES_DIR = resolve(HERE, '../modules');
const SHELL = resolve(MODULES_DIR, 'ModuleShell.svelte');

interface DefLike {
  type: string;
  face?: {
    extension?: string;
    pages?: readonly { id: string }[];
    rackStatus?: { why: string; peers: readonly string[]; primaryOnlyBands: readonly string[] };
  };
}

function allDefs(): DefLike[] {
  return [
    ...(listModuleDefs() as unknown as DefLike[]),
    ...(listVideoModuleDefs() as unknown as DefLike[]),
    ...(listMetaModuleDefs() as unknown as DefLike[]),
  ];
}

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

/**
 * Every extension id in the tree that fills the `fullViewBody` slot, READ OFF
 * THE DIRECTORY. There is no list to go stale: a new module dropping a
 * `shell-extension.ts` at the conventional path is in scope the moment it
 * exists, which is the property that makes the roster below deny-by-default
 * rather than a snapshot.
 */
function extensionsWithBody(): string[] {
  return readdirSync(MODULES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((id) => {
      const f = resolve(MODULES_DIR, id, 'shell-extension.ts');
      return existsSync(f) && /fullViewBody:/.test(read(f));
    })
    .sort();
}

/** The component file an extension names for its `fullViewBody` slot.
 *  `import.meta.glob` is LAZY, so the component object is unreachable from a
 *  node-env test; the FILE the declaration names is what can be read. */
function fullViewBodySource(extId: string): string | null {
  const ext = resolve(MODULES_DIR, extId, 'shell-extension.ts');
  if (!existsSync(ext)) return null;
  const src = read(ext);
  const m = /fullViewBody:\s*([A-Za-z0-9_]+)/.exec(src);
  if (!m) return null;
  const imported = new RegExp(`import\\s+${m[1]}\\s+from\\s+'\\./([^']+)'`).exec(src);
  if (!imported) return null;
  const file = resolve(MODULES_DIR, extId, imported[1]!);
  return existsSync(file) ? read(file) : null;
}

function defsDeclaringRackStatus(): DefLike[] {
  return allDefs().filter((d) => !!d.face?.rackStatus);
}

// ── THE EXTENSION-BODY TEXT ROLE ROSTER ─────────────────────────────────────
//
// One entry per `fullViewBody` in the tree. `role` says what the body's surface
// IS, and each role carries a mechanical predicate (below) that the source must
// satisfy — so the entry is a claim the gate checks, not a claim it records.

type BodyRole = 'picture' | 'status-primitive';

interface BodyRule {
  role: BodyRole;
  /** What this body paints, in one line. Required — `tsc` refuses the bare form. */
  why: string;
}

const EXTENSION_BODY_ROLES: Readonly<Record<string, BodyRule>> = {
  // ── PICTURES — a live preview canvas, plus the switches that steer it.
  // Everything each of these paints as TEXT is a control caption on its own
  // button (SCREEN, MONITOR, a resize grip). What their canvases draw is the
  // residue named in this file's header, and the dock VRT baselines are what
  // see it.
  '4plexvid': { role: 'picture', why: 'the four-input video switcher\'s live output preview canvas and its SCREEN switch.' },
  b3ntb0x: { role: 'picture', why: 'the feedback-bender\'s live output preview canvas and its SCREEN switch.' },
  backdraft: { role: 'picture', why: 'the 3-D scene preview canvas plus the preview-collapse toggle that became the fleet-wide SCREEN ON/OFF standard.' },
  bentbox: { role: 'picture', why: 'the pixel-bender\'s live output preview canvas and its SCREEN switch.' },
  colourofmagic: { role: 'picture', why: 'the multi-colorspace processor\'s live preview canvas and its SCREEN switch (#2015: OFF stops the preview copy, never the engine).' },
  foxy: { role: 'picture', why: 'the video-synth\'s live output preview canvas and its SCREEN switch.' },
  freezeframe: { role: 'picture', why: 'the frame-hold preview canvas — the one surface on which "is it frozen?" is answerable at all.' },
  grainsOfVision: { role: 'picture', why: 'the video-granulator\'s live preview canvas and its SCREEN switch (#1928 — the toggle a promotion would otherwise delete with the card).' },
  mandelbulb: { role: 'picture', why: 'the raymarched fractal\'s live preview canvas and its SCREEN switch.' },
  mirrorpool: { role: 'picture', why: 'the kaleidoscopic reflector\'s live preview canvas and its SCREEN switch.' },
  // ⚠ THE THIRD BODY CAUGHT ON A MERGE IN AS MANY ROUNDS — monoglitch (#2081),
  // reshaper (#2086), now milkdrop (#2087). Three unrelated PRs in two days,
  // each named on first contact. Membership is derived off the DIRECTORY for
  // exactly this reason: a hand-kept list of these would have been wrong three
  // times already.
  //
  // ⚠ AND THIS ONE IS THE CASE THAT MOST NEEDS A DECLARED ROLE, because it is
  // the one VRT cannot see: milkdrop is in `EXEMPT_FROM_VRT` and carries a
  // `FACES_WITHOUT_SCENES` entry, so NO dock baseline exists for it. The
  // "residue" this roster's header defers to the baselines — what a canvas
  // actually paints — has no baseline here at all. The declared role is
  // therefore the ONLY statement on record about what this surface shows.
  milkdrop: { role: 'picture', why: 'the butterchurn preset visualiser\'s live preview canvas, its SCREEN switch and the MONITOR toggle from the ruttetra seam. ⚠ Unbaselinable (EXEMPT_FROM_VRT + FACES_WITHOUT_SCENES), so this declaration is the only record of what it paints — no dock baseline can contradict it.' },
  // ⚠ ADDED BY A MERGE, NOT BY THIS PR'S AUTHOR — and that is the roster
  // earning its keep on its first unrelated encounter. monoglitch (#2081)
  // landed on main as the second MONITOR MODE adopter while this branch was
  // open, bringing a new `fullViewBody` with it. The deny-by-default leg went
  // RED on the merge and named the file, which is exactly the behaviour that
  // makes this a gate rather than a snapshot: a body cannot enter the tree
  // without someone writing down what it paints.
  monoglitch: { role: 'picture', why: 'the luma-driven scanline glitch\'s live preview canvas, its SCREEN switch and the MONITOR toggle it inherited from ruttetra (#2009 / #2053).' },
  outlines: { role: 'picture', why: 'the edge-detector\'s live preview canvas and its SCREEN switch.' },
  rasterize: { role: 'picture', why: 'the rasteriser\'s live preview canvas and its SCREEN switch.' },
  // ⚠ THE SECOND BODY THIS ROSTER CAUGHT ON A MERGE, one absorbing round after
  // monoglitch. reshaper (#2086) is the third MONITOR MODE adopter and arrived
  // on main while this branch was open. Two unrelated PRs in two days, each
  // caught on first contact — the population really does grow faster than
  // anyone would remember to update a snapshot, which is the argument for
  // deriving membership off the directory and denying by default.
  reshaper: { role: 'picture', why: 'the coordinate-remapper\'s live preview canvas, its SCREEN switch and the MONITOR toggle inherited from the ruttetra seam (#2009 / #2053).' },
  ruttetra: { role: 'picture', why: 'the Rutt/Etra scan processor\'s live raster preview, its SCREEN switch, the MONITOR toggle that hides the control bands (#2009) and the corner resize.' },
  spirographs: { role: 'picture', why: 'the harmonograph\'s live plot canvas and its SCREEN switch — the module whose right-hand TEXT column was deleted by the 2026-08-19 ruling, leaving the picture.' },
  videoOut: { role: 'picture', why: 'the rack video output\'s live preview canvas — the picture the whole module exists to produce.' },
  warrensvisions: { role: 'picture', why: 'the shader-visions preview canvas and its SCREEN switch.' },

  // ── BATCH 22 · GROUP 1 — the video thin tail, four fader banks ────────────
  //
  // Four bodies at once, all the same shape and all PICTURES: a live preview
  // canvas plus ONE control caption (the SCREEN button). None is a MONITOR-mode
  // module — `hideControls` appears in zero of their four cards — so there is no
  // second switch and no resize grip to declare. Nothing on any of these
  // surfaces is a derived value in a text node.
  //
  // ⚠ THEY ARE GROUPED RATHER THAN INTERLEAVED ALPHABETICALLY ON PURPOSE. This
  // roster has been caught by a merge three rounds running (monoglitch,
  // reshaper, milkdrop), and four separate alphabetical insertions are four
  // separate conflict sites in the file most likely to take a concurrent edit.
  // One block is one hunk.
  colorizer: { role: 'picture', why: 'the mono-to-colour tinter\'s live preview canvas and its SCREEN switch. Sits mid-chain by construction (mono-video in, video out), which is why its body keeps the engine\'s watch mark alive while the screen is off (#2015).' },
  edges: { role: 'picture', why: 'the Sobel outline filter\'s live preview canvas and its SCREEN switch. Stateless — the outline is a pure per-pixel function of (input, threshold, thickness) — so SCREEN OFF costs it nothing but the OUTPUT, which is what the retained watch mark protects (#2015).' },
  inwards: { role: 'picture', why: 'the concentric-ring generator\'s live preview canvas and its SCREEN switch. The only SOURCE of the four: it has no video input, so a lapsed watch mark would mute the generator every downstream node samples rather than merely stalling a preview (#2015).' },
  // ── SCOREBOARD (2026-08-22, #2089) — a picture that is a NUMBER ──────────
  //
  // ⚠ THE ENTRY WHERE "TEXT ON THE SURFACE" NEEDS ITS SHARPEST READING, which
  // is why it is spelled out. The body's canvas paints FOUR DIGITS, and digits
  // are the thing this roster's rulings are usually about. They are permitted
  // here — indeed unavoidable — because they are not a READOUT OF A CONTROL:
  // they are the module's OUTPUT PICTURE, the very frame the `out` port emits
  // to whatever is patched downstream. Suppressing them would not tidy a
  // faceplate, it would delete the module's product. The resting-text ruling is
  // about derived state printed BESIDE a control; this is the signal itself.
  //
  // Everything the body paints as CHROME is one control caption: the SCREEN
  // button. The card has no readout row, no state word and no decimal, so
  // unlike most entries here nothing had to be removed on promotion.
  scoreboard: { role: 'picture', why: 'the 4-digit neon counter\'s live display and its SCREEN switch — the module\'s entire product, since it has no video input and no audio path: two gates in, four digits out. ⚠ The DIGITS are the OUTPUT PICTURE (what `out` emits), not a readout of a control, which is why numerals on this surface are correct rather than a resting-text violation. ⚠ SCREEN OFF keeping the watch mark is load-bearing on STATE here, not just on the picture: the counter advances on gate edges the factory detects during draw, so a lapsed mark would leave SCORE edges UNCOUNTED and the number WRONG when the screen returns — not merely stale (#2015).' },
  // ── ACIDWARP (2026-08-22, #2111) — the module that IS its display ────────
  //
  // TEXT ON THE SURFACE, exhaustively: the SCREEN button's own caption. Nothing
  // else. ⚠ NOT on it, deliberately, and this is the entry where that absence
  // is the interesting part — the legacy card printed TWO resting readouts
  // (`SCENE n/41` and a live speed multiplier like `2.4x`), and neither is
  // ported. The scene index is spoken by its control's `aria-valuetext`; the
  // speed mapping's one non-obvious fact (NATIVE 1x is the knob's MIDPOINT)
  // moved onto the param as landmark NAMES.
  acidwarp: { role: 'picture', why: 'the 320x240 plasma generator\'s live display and its SCREEN switch — on this module the picture is not a monitor of the work, it IS the work: a pure-GPU SOURCE with no input and no audio path. ⚠ SCREEN OFF keeping the watch mark alive matters more here than on a filter (#2015): acidwarp is the ORIGIN of the signal, so a lapsed mark would not stall a preview, it would MUTE the generator every downstream node is sampling. ⚠ It is also the first body whose module\'s own `freeze` param is a USER CONTROL rather than a determinism hook, which is why this face is unbaselinable and lives in FACES_WITHOUT_SCENES.' },
  vdelay: { role: 'picture', why: 'the video delay line\'s live preview canvas and its SCREEN switch. ⚠ The ACCUMULATOR of the four — a 32-slot frame ring advanced by every draw — so SCREEN OFF retaining the watch mark is load-bearing on the PICTURE here, not just the output: a stalled pull would let the echo chain decay out of the ring (#2015).' },
  // ── BATCH 22 · GROUP 2a — the video thin tail, card-checked cells ─────────
  //
  // Both PICTURES: a live preview canvas plus ONE control caption (the SCREEN
  // button). Neither card mounts `hideControls`, so neither body carries a
  // MONITOR toggle or a resize grip to declare. Nothing on either surface is a
  // derived value in a text node.
  //
  // Grouped rather than interleaved alphabetically for the reason this roster
  // already documents about itself: it has been caught by a merge three rounds
  // running, and separate alphabetical insertions are separate conflict sites.
  lumakey: { role: 'picture', why: 'the luminance-key compositor\'s live preview canvas and its SCREEN switch. A KEYER exists to be composited downstream, so its body keeps the engine\'s watch mark alive while the screen is off — a lapsed mark would change what the DOWNSTREAM sees, not just the preview (#2015).' },
  // ── THE ONE BODY THAT IS ALSO A CONTROL (2026-08-22, #2102) ──────────────
  //
  // ⚠ IT IS STILL A `picture`, AND THE ROLE PREDICATE IS WHY THAT IS THE HONEST
  // ANSWER RATHER THAN A CONVENIENT ONE: this body mounts canvases, so the
  // `status-primitive` predicate (`StatusLed` and NO canvas) would refuse it,
  // and the role that describes what a reviewer will see on the surface is the
  // picture one. What makes it unlike the twenty-six above is not the role but
  // the CONTROL it carries: `face.xyPads[0].surface: 'body'` hands the joystick
  // itself to this file, so the dock renders NO band cell for `pos_x`/`pos_y`
  // and this surface is the only place they can be operated at the dock. That
  // claim is checked in both directions by `face-xy-body-source.test.ts`, which
  // is the gate this entry should be read alongside.
  //
  // TEXT ON THE SURFACE, exhaustively, and every item is a NAME or a caption:
  // the four corner labels `IN1`..`IN4` (which INPUT each quadrant and each
  // corner is — names, and the only thing distinguishing four identical
  // quadrants), the SCREEN button's own caption, and the two `x`/`y` assign
  // handles. ⚠ NOT on the surface, deliberately: the legacy card's
  // `x: 0.00  y: 0.00` row, which is deleted rather than hidden — the pad's
  // position lives in `aria-label` (this is `role="application"`, which has no
  // `aria-valuetext`), together with the name of the input the composite
  // currently favours, a fact the card carried only as a colour.
  quadralogical: { role: 'picture', why: 'the 4-input XY crossfader\'s joystick field — a live 2×2 preview of the four inputs (its own `preview` port) with the diamond, the corner labels and the puck overlaid, plus its SCREEN switch. ⚠ The only body that is also a CONTROL: `face.xyPads[0].surface: \'body\'` means the dock paints no band cell for pos_x/pos_y, so this surface IS the joystick. The puck is a window onto the MIX, which is what keeps the module\'s own output on the plate after the standalone preview screen was removed. SCREEN OFF keeps the watch mark alive on a MIXER feeding two outputs (#2015).' },
  shapegen: { role: 'picture', why: 'the generative 3-D shape synthesiser\'s live preview canvas and its SCREEN switch. A GENERATOR whose `out` is the reason to patch it, so the retained watch mark is what stops a control labelled SCREEN behaving as a MUTE downstream (#2015).' },
  // ── BATCH 22 · GROUP 4 — the video thin tail, the REMAINDER ───────────────
  //
  // All four PICTURES: a live preview canvas plus ONE control caption (the
  // SCREEN button). ⚠ AND ALL FOUR ARE SURFACES THEIR MODULES NEVER HAD — none
  // of `MapperCard` / `DestructorCard` / `LumaCard` / `VideoMixerCard` draws a
  // canvas, so these bodies are ADDITIONS rather than ports of a card preview.
  // That makes the declared role the FIRST statement on record about what each
  // one paints. None of the four cards mounts `hideControls`, so none carries a
  // MONITOR toggle or a resize grip to declare. Nothing on any of the four
  // surfaces is a derived value in a text node.
  //
  // Grouped rather than interleaved alphabetically for the reason this roster
  // already documents about itself three entries up: it has been caught by a
  // merge on three consecutive rounds, and four separate alphabetical
  // insertions are four separate conflict sites in the file most likely to take
  // a concurrent edit. One block is one hunk.
  mapper: { role: 'picture', why: 'the luminance-gated keyer\'s live MATTE preview and its SCREEN switch — and on a one-param module this canvas IS the merit argument, because "did the key cut where I wanted?" is not answerable from a fader reading 0.5. Stateless, so SCREEN OFF costs it only the OUTPUT, which is what the retained watch mark protects: the matte is produced FOR something downstream to composite (#2015).' },
  destructor: { role: 'picture', why: 'the glitch/decay stack\'s live preview canvas and its SCREEN switch. Its four faders are DEGRADATION AMOUNTS whose only description is a look, so the picture is what makes them legible. Stateless — the scanline grid is a function of vUv.y, not of a clock — so the retained watch mark is about the OUTPUT of a chain effect, never an accumulator (#2015).' },
  luma: { role: 'picture', why: 'the luminance-domain grade\'s live preview canvas and its SCREEN switch. ⚠ Do not confuse the directory with `lumakey` above: this is the single-input TONE PROCESSOR, that one is the two-input COMPOSITOR. The picture earns its place because the module ships a BIT-EXACT IDENTITY at its defaults, so the frame is the only thing distinguishing graded from untouched. Stateless mid-chain, so the watch mark protects the OUTPUT (#2015).' },
  videoMixer: { role: 'picture', why: 'the 4-channel additive mixer\'s live COMPOSITE preview and its SCREEN switch — four faders that SUM have no per-channel observable, so this canvas is where "which sources am I actually seeing, and is it clipping to white?" is answered. Stateless (its own header records that binding its own output as a spare sampler was rejected as a feedback loop), and the JOIN of the graph: a lapsed watch mark would black out up to FOUR upstream chains at once (#2015).' },

  // ── BATCH 22 · GROUP 2b — the two faces that cost an attest ───────────────
  //
  // Both PICTURES: a live preview canvas plus ONE control caption (the SCREEN
  // button). Neither card mounts `hideControls`, so neither body declares a
  // MONITOR toggle or a resize grip, and nothing on either surface is a derived
  // value in a text node.
  tempest: { role: 'picture', why: 'the vector-well render — rim ring, pit ring, radial lanes and the player claw — plus its SCREEN switch. A SOURCE with no video input, so the retained watch mark is what stops SCREEN OFF muting the well for everything downstream (#2015).' },
  fader: { role: 'picture', why: 'the main OUT mix preview and its SCREEN switch. ⚠ This module has TWO outputs — `out` and the `send` feeding an external FX loop — so the retained watch mark protects an output the switch does not even show, and a loop the player is mixing against (#2015).' },

  // ── BATCH 22 · GROUP 3 — the screens ──────────────────────────────────────
  //
  // All four PICTURES: a live preview canvas plus ONE control caption (the
  // SCREEN button). None of the four cards mounts `hideControls`, so none of
  // these bodies declares a MONITOR toggle or a resize grip, and nothing on any
  // of the surfaces is a derived value in a text node.
  posterbox: { role: 'picture', why: 'the colour-quantised picture and its SCREEN switch. A stateless per-pixel reduction, so the retained watch mark protects the OUTPUT of a chainable mid-graph effect rather than any accumulated state (#2015).' },
  tiler: { role: 'picture', why: 'the tiled-grid picture and its SCREEN switch. Stateless re-sampling per frame, so SCREEN OFF costs only the OUTPUT — which is why the body keeps marking the node watched (#2015).' },
  sourcery: { role: 'picture', why: 'the keyed/skewed picture and its SCREEN switch. Derived per frame from its two thresholds, the colour skew and the rotation, so the retained watch mark protects the OUTPUT (#2015).' },
  onetonine: { role: 'picture', why: 'the MONITOR surface — the 3x3 grid plus the 1..9 digits saying which cell feeds which output — and its SCREEN switch. ⚠ The picture this hides is a DIAGNOSTIC, not the module product: nine clean crop outputs run behind it, so a lapsed watch mark would unpatch a nine-way splitter to hide one overlay (#2015).' },

  // ── BATCH 21 · CELLSHADE ──────────────────────────────────────────────────
  //
  // A PICTURE: the live toon render plus ONE control caption (the SCREEN
  // button). The card mounts no `hideControls`, so this body declares no
  // MONITOR toggle and no resize grip, and nothing on the surface is a derived
  // value in a text node — ⚠ notably NOT the card's `{bands} BANDS` readout,
  // which is exactly the resting derived text the 2026-08-17 ruling removes.
  // The band count reaches the player as the `bits` option LABEL instead.
  cellshade: { role: 'picture', why: 'the cel-shaded toon render and its SCREEN switch. Stateless per frame by the def\'s own account (bilateral smooth → luma quantise → Sobel ink, no feedback), so the retained watch mark protects the OUTPUT of a chainable effect rather than any accumulated state (#2015).' },
  // ── BATCH 23a — the zero-attest pair (SPLIT-ON-THE-ATTEST-LINE) ───────────
  //
  // Both PICTURES: a live preview canvas plus ONE control caption (the SCREEN
  // button). Neither card mounts `hideControls`, so neither body declares a
  // MONITOR toggle or a resize grip, and nothing on either surface is a derived
  // value in a text node.
  //
  // ⚠ ONE IS A PORT AND ONE IS AN ADDITION, which is unusual for a pair and
  // worth having on record: `PeakstateCard.svelte` already draws a 144x144
  // preview (so its body preserves a picture promotion would delete),
  // `LinesCard.svelte` draws none (so its body is new). Grouped as one block
  // rather than interleaved alphabetically, for the reason this roster
  // documents about itself above.
  peakstate: { role: 'picture', why: 'the kaleidoscope pen-trace\'s live mandala and its SCREEN switch. ⚠ THE ACCUMULATOR CASE, and the strongest in the fleet: the picture IS a pen ring of trace history, and the def keeps the state advance UNCONDITIONAL while per-port rasterization is gated precisely so a re-patched output "resumes at the correct phase with the whole trail already in the ring". A lapsed watch mark drops the node from the pull set and stops the ADVANCE, not merely a rasterize — so the mandala freezes mid-figure for all THREE outputs, which share one ring (#2015). ⚠ Its body also swaps the card\'s ungated `read(\'previewCanvas\')` 30 Hz poll for the fleet `blitOutputForPreview`, which is the same surface but gated AND legible to the port seam.' },
  lines: { role: 'picture', why: 'the procedural grating\'s live preview canvas and its SCREEN switch. ⚠ NOT a stateless sibling despite having no accumulator: its shader reads a time term and the pattern auto-scrolls at rest ("visibly alive without touching a knob"), so a lapsed watch mark freezes a MOVING picture that every downstream consumer is sampling rather than merely pausing a preview (#2015). The switch is an ADDITION — its card never drew a preview.' },

  // ── BATCH 23b — the attest half ───────────────────────────────────────────
  shapes: { role: 'picture', why: 'the SDF primitive generator\'s live stamp preview and its SCREEN switch. ⚠ NOT `shapegen` above — that is the 3-D shape synthesiser; this is the 2-D primitive source, and the ids differ by three characters. A SOURCE with no input at all, so the retained watch mark is the sharpest form of the #2015 argument: a lapsed mark would not stall a preview, it would MUTE the origin of everything downstream. Its card mounts no `hideControls`, so no MONITOR toggle or resize grip is declared, and nothing on the surface is a derived value in a text node.' },

  // ── CUT A · BATCH 2 — a video ADDITION and the first AUDIO picture ────────
  //
  // Both PICTURES. Grouped as one block rather than interleaved alphabetically,
  // for the reason this roster documents about itself above.
  //
  // ⚠ NEITHER IS A PORT OF A CARD PREVIEW, and they are not-a-port in two
  // DIFFERENT ways, which is why they are annotated separately rather than as a
  // pair. `ShapedrampsCard.svelte` draws no canvas at all, so its body is an
  // ADDITION — the declared role below is the first statement on record about
  // what that surface paints. `DockscopeCard.svelte` draws the trace this body
  // carries forward, but through a slot no video body uses.
  shapedramps: { role: 'picture', why: 'the parametric ramp generator\'s live output preview and its SCREEN switch. ⚠ An ADDITION, not a port — its card mounts NO canvas (vrt-exemptions records it among the "confirmed 0 canvases each"), so this is the first surface on which what this module emits is visible without patching it into an OUTPUT. ⚠ The retained watch mark (#2015) is the widest-tap form of the argument in this roster: SIX outputs, four of them pure functions of vUv with no input, and THE PREVIEW SHOWS ONLY `h_out` — five of the six are invisible on the very surface whose switch would mute them. Its two identity ramps are invariant to every knob and CV, so if they went dark nothing on the plate would move to say why. No accumulator: all three programs are pure per-frame functions, so SCREEN OFF costs it only the OUTPUT. Its card mounts no `hideControls`, so no MONITOR toggle or resize grip is declared, and nothing on the surface is a derived value in a text node.' },
  dockscope: { role: 'picture', why: 'the 1u rail scope\'s live time-domain trace — the FIRST AUDIO-domain picture in this roster, and the one body here with NO SCREEN SWITCH AND NO WATCH MARK, both by derivation rather than omission. No switch: dockscope declares `outputs: []`, so the trace is not a monitor OF the work, it IS the work, and collapsing it would leave two faders over nothing — `videoOut`\'s exemption argument exactly, on a def the video gate does not reach. No watch mark: `markWatched` is a VideoEngine PULL-SET concept and this module\'s AnalyserNode is fed by the Web Audio graph, which runs whether or not anything is looking, so there is no pull set to fall out of. ⚠ It is also the face that REFUSED the `scope` glyph its inventory note recommends: with no audio output `glyphBinding` falls to `{ kind: \'static\' }`, so the glyph would have painted a placeholder waveform that is not this module\'s signal. The only text on the surface is inside the canvas — the `±1.0` / `±5V` scale annotation `drawDockscope` has always drawn, which names the `range` control\'s own position rather than measuring anything.' },

  // ── STATUS — the one body whose subject is not a picture.
  cvBuddy: {
    role: 'status-primitive',
    why:
      'RACK-GLOBAL STATUS for both CV Buddy kinds (#2024): the ES-9 slot NAME this instance owns, '
      + 'and the ROUTED / LATE lamps. It is the first non-picture adopter of this slot, and the '
      + 'reason the roster around it exists — everything it shows is a property of the RACK, so '
      + 'no param cell can carry it, and all of it would be forbidden as resting TEXT. It paints '
      + 'through `StatusLed`, which puts every measurement in `aria-label`/`title`; the only text '
      + 'node on the surface is the slot name, which is a NAME (two CV Buddies are otherwise '
      + 'identical plates, and the jacks they own is the only thing that tells them apart).',
  },
};

/** The mechanical predicate each role claims about its own source. */
const ROLE_PREDICATE: Readonly<Record<BodyRole, { holds: (src: string) => boolean; what: string }>> = {
  picture: {
    holds: (src) => /<canvas/.test(src),
    what: 'mounts a <canvas> — a body claiming to be a PICTURE must have one',
  },
  'status-primitive': {
    holds: (src) => /StatusLed/.test(src) && !/<canvas/.test(src),
    what:
      'imports StatusLed and mounts NO <canvas> — a status body paints its measurements through '
      + 'the primitive, and a canvas would put it back in the blind spot this role exists to leave',
  },
};

describe('#2024 — RACK-GLOBAL STATUS has a reachable home', () => {
  it('has a subject at all (vacuity control)', () => {
    // Three ways this file could be green while measuring nothing: no def
    // declares the field, no extension body exists, or the directory scan
    // resolves nothing. All three fail HERE rather than letting the sweeps
    // below pass over an empty set.
    expect(defsDeclaringRackStatus().length, 'defs declaring `face.rackStatus`').toBeGreaterThan(0);
    expect(extensionsWithBody().length, 'extensions filling `fullViewBody`').toBeGreaterThan(0);
    expect(Object.keys(EXTENSION_BODY_ROLES).length).toBeGreaterThan(0);
  });

  // ── FORWARD: a declaration must be REACHABLE ─────────────────────────────
  it('every face declaring `rackStatus` owns a body that can carry it', () => {
    const offenders: string[] = [];
    for (const def of defsDeclaringRackStatus()) {
      const extId = def.face?.extension;
      if (!extId) {
        offenders.push(
          `${def.type}: declares face.rackStatus but no face.extension — suppressing its band `
            + 'would leave a plate with nothing on it',
        );
        continue;
      }
      const src = fullViewBodySource(extId);
      if (src === null) {
        offenders.push(`${def.type}: extension '${extId}' has no resolvable fullViewBody component`);
        continue;
      }
      // SEMANTIC legs, not a testid name — the same correction
      // `face-monitor-source` records: an earlier gate demanded a testid and
      // reported a false positive against a module that spelled it differently.
      // What matters is what the source can DO.
      if (!/patch\.nodes/.test(src)) {
        offenders.push(
          `${def.type}: its fullViewBody never reads \`patch.nodes\` — rack-global status that `
            + 'never looks at the rack is not rack-global status',
        );
      }
      if (!/StatusLed/.test(src)) {
        offenders.push(
          `${def.type}: its fullViewBody does not paint through \`StatusLed\` — a status surface `
            + 'that hand-rolls its own text is the shape the resting-text ruling denies',
        );
      }
    }
    expect(
      offenders,
      'RACK-GLOBAL STATUS is declared on a face that cannot reach it. The SHELL suppresses the '
        + 'primary-only bands (`rackStatusPlan`); the MODULE owns the surface that says what the '
        + 'rack-global state is, on its own `fullViewBody`, through the `StatusLed` primitive.',
    ).toEqual([]);
  });

  // ── COHERENT: the declaration names real things ──────────────────────────
  it('`primaryOnlyBands` names bands the face actually declares', () => {
    // ⚠ THE FAILURE THIS CATCHES IS SILENT AND FAILS OPEN. A renamed page id
    // leaves the suppression naming nothing, so the shell hides nothing, so a
    // non-primary instance paints exactly the dead controls the declaration
    // exists to remove — and the plate still looks plausible.
    const offenders: string[] = [];
    for (const def of defsDeclaringRackStatus()) {
      const declared = new Set((def.face?.pages ?? []).map((p) => p.id));
      for (const band of def.face!.rackStatus!.primaryOnlyBands) {
        if (!declared.has(band)) {
          offenders.push(`${def.type}: primaryOnlyBands names '${band}', which is not a declared page`);
        }
      }
    }
    expect(offenders, 'a primary-only band that does not exist suppresses nothing').toEqual([]);
  });

  it('`peers` names registered types, and INCLUDES the declaring module', () => {
    // Excluding itself would make every instance "primary" (its own id is never
    // in the peer set), which is a suppression that can never fire — green, and
    // exactly as wrong as naming no bands at all.
    const known = new Set(allDefs().map((d) => d.type));
    const offenders: string[] = [];
    for (const def of defsDeclaringRackStatus()) {
      const peers = def.face!.rackStatus!.peers;
      for (const p of peers) {
        if (!known.has(p)) offenders.push(`${def.type}: peers names unregistered type '${p}'`);
      }
      if (!peers.includes(def.type)) {
        offenders.push(
          `${def.type}: peers does not include the module itself, so it can never be anything but `
            + 'primary and the declaration is inert',
        );
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every `rackStatus` declaration carries an argument, not a label', () => {
    const thin = defsDeclaringRackStatus()
      .filter((d) => (d.face?.rackStatus?.why ?? '').trim().length < 40)
      .map((d) => d.type);
    expect(
      thin,
      'the burden of proof is on the face claiming a control belongs to one instance only',
    ).toEqual([]);
  });

  it('a declaring body passes LITERAL captions — the call-site half of the primitive', () => {
    // `status-led-source.test.ts` proves the COMPONENT cannot paint a
    // measurement. It cannot see what a caller passes, and
    // `caption={lit ? 'LATE 3' : 'OK'}` defeats the whole design from outside.
    // A caption is a name, so it is a string literal.
    const offenders: string[] = [];
    for (const def of defsDeclaringRackStatus()) {
      const src = fullViewBodySource(def.face?.extension ?? '');
      if (!src) continue;
      for (const m of src.matchAll(/caption=\{([^}]*)\}/g)) {
        offenders.push(`${def.type}: caption={${m[1]!.trim()}} — a caption is a NAME, so it is a literal`);
      }
    }
    expect(
      offenders,
      'a StatusLed caption is being computed. The caption must read identically lit and unlit; a '
        + 'caption that changes with the state IS state painted as text, under a new spelling.',
    ).toEqual([]);
  });

  // ── LEG 2 · THE RENDER SITE IS REAL ──────────────────────────────────────
  it('ModuleShell actually FILTERS on the plan — a declaration cannot be inert', () => {
    // Without this the whole contract is decoration: a def could declare the
    // field, a body could paint its lamps, and the band would never move.
    const src = stripSourceComments(read(SHELL));
    expect(
      /rackStatusPlan\(\{/.test(src),
      'ModuleShell must CALL rackStatusPlan, not merely import it',
    ).toBe(true);
    expect(
      /hiddenBands\.has\(/.test(src),
      'the plan\'s hidden set must actually filter the band list',
    ).toBe(true);
    // Positive controls: the things being filtered still EXIST. Two absence
    // checks over a mis-read file would otherwise look identical to a pass.
    expect(src.includes('dockBands'), 'the band list still exists').toBe(true);
    expect(src.includes('data-testid="face-pages"'), 'the bands container still exists').toBe(true);
    // ⚠ AND IT FILTERS THE *INPUT* TO THE ROW PLAN, not its output: `dockRowPlan`
    // PACKS bands into rows, so filtering afterwards leaves a row sized for a
    // band that is no longer in it.
    expect(
      src.indexOf('let dockBands') < src.indexOf('dockRowPlan('),
      'the rack-status filter must run BEFORE the row packing',
    ).toBe(true);
  });
});

// ── LEG 3 · THE BLIND-SPOT CONVERSION ───────────────────────────────────────

describe('#2024 — every extension body declares what its canvas PAINTS', () => {
  it('DENY BY DEFAULT: a fullViewBody with no declared text role is RED', () => {
    const undeclared = extensionsWithBody().filter((id) => !(id in EXTENSION_BODY_ROLES));
    expect(
      undeclared,
      'a new `fullViewBody` exists with no EXTENSION_BODY_ROLES entry. This slot is the largest '
        + 'blind spot in `face-resting-text-source.test.ts` — a body can paint anything, into DOM '
        + 'or into a canvas, and no source gate sees it. Adding one therefore means writing down '
        + 'what it paints: a PICTURE (a live canvas plus its own control captions), or a '
        + 'STATUS-PRIMITIVE surface (measurements through `StatusLed`, where they reach '
        + '`aria-label` and never a text node). A derived value in a text node is neither.',
    ).toEqual([]);
  });

  it('ANCHOR: every roster entry still names a live body — a dead entry is RED', () => {
    const live = new Set(extensionsWithBody());
    const dead = Object.keys(EXTENSION_BODY_ROLES).filter((id) => !live.has(id));
    expect(
      dead,
      'a roster entry names an extension body that no longer exists. Delete it — a stale entry '
        + 'silently pre-approves whatever takes that name next.',
    ).toEqual([]);
  });

  it('⚠ THE ROLE IS VERIFIED, NOT TRUSTED — each claim holds of the source', () => {
    // The difference between this and a ledger of claims. An author who writes
    // `picture` beside a body that mounts no canvas is caught here, and so is a
    // `status-primitive` body that grew a canvas (which would move its
    // measurements back into the unseeable region).
    const offenders: string[] = [];
    for (const [id, rule] of Object.entries(EXTENSION_BODY_ROLES)) {
      const src = fullViewBodySource(id);
      if (src === null) continue; // the ANCHOR leg above owns this failure
      const pred = ROLE_PREDICATE[rule.role];
      if (!pred.holds(src)) offenders.push(`${id}: declared '${rule.role}' but does not ${pred.what}`);
    }
    expect(offenders, 'a declared body role is not true of the body').toEqual([]);
  });

  it('every entry carries a REASON, not a shrug', () => {
    const thin = Object.entries(EXTENSION_BODY_ROLES)
      .filter(([, r]) => r.why.trim().length < 40)
      .map(([k]) => k);
    expect(thin, 'an entry without a stated reason is a suppression').toEqual([]);
  });

  it('the roster covers BOTH roles — it is not one role with a decoration', () => {
    // A roster where every entry said `picture` would be a rename of the blind
    // spot rather than a narrowing of it, and the `status-primitive` predicate
    // would never run.
    const roles = new Set(Object.values(EXTENSION_BODY_ROLES).map((r) => r.role));
    expect([...roles].sort()).toEqual(['picture', 'status-primitive']);
  });

  it('the body resolver DISCRIMINATES (negative controls)', () => {
    // The population is derived, so a broken path reports an empty set
    // (silently green) or resolves nothing per entry (silently green again).
    expect(fullViewBodySource('definitely-not-a-module')).toBeNull();
    // `dx7` HAS a shell-extension.ts and deliberately does NOT fill this slot —
    // it fills `glyph`. So it must be absent from the derived population, which
    // proves the scan is reading the SLOT and not merely the directory.
    expect(existsSync(resolve(MODULES_DIR, 'dx7', 'shell-extension.ts'))).toBe(true);
    expect(extensionsWithBody()).not.toContain('dx7');
    // …and a real one resolves to real source.
    const real = fullViewBodySource('cvBuddy');
    expect(real, 'cvBuddy fullViewBody source').not.toBeNull();
    expect(real!.includes('StatusLed')).toBe(true);
    // ⚠ THE DISCRIMINATION THAT MATTERS MOST: a PICTURE body is not thereby a
    // status body. If the two predicates were ever conflated, the roster would
    // stop distinguishing the surface that must route through the primitive
    // from the one that cannot.
    const pic = fullViewBodySource('videoOut');
    expect(pic, 'videoOut fullViewBody source').not.toBeNull();
    expect(ROLE_PREDICATE.picture.holds(pic!)).toBe(true);
    expect(
      ROLE_PREDICATE['status-primitive'].holds(pic!),
      'a canvas preview must NOT satisfy the status-primitive predicate',
    ).toBe(false);
    expect(ROLE_PREDICATE['status-primitive'].holds(real!)).toBe(true);
    expect(
      ROLE_PREDICATE.picture.holds(real!),
      'the status body must NOT satisfy the picture predicate',
    ).toBe(false);
  });
});
