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

type BodyRole = 'picture' | 'status-primitive' | 'control-grid';

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
  // ── MATRIXMIX (bespoke wave 4) — the roster's first CONTROL GRID ─────────
  //
  // TEXT ON THE SURFACE, exhaustively: the two axis corner labels (`Y↓` / `X→`),
  // and one PORT ID plus its direction (`CUTOFF` / `in`) per row and per column
  // head. Every one of those is a CONTROL CAPTION in substance — the name of the
  // jack that row or column IS — and the permitted-text list names captions
  // explicitly. There is no value, no measurement and no state word anywhere on
  // the plate. Nothing had to be removed on promotion either: the legacy card
  // never printed a readout.
  //
  // ⚠ AND THE ONE SENTENCE THIS MODULE HAS IS ON `aria-label`, WHICH IS THE
  // WHOLE POINT OF THE ROLE. A cross-point's visual is a coloured dot or a ✕;
  // what it MEANS — "input already patched from FILTER.cutoff — clicking replaces
  // it", "output already feeds VCA.in — clicking adds another cable" — is the
  // entire semantics of the control and cannot be inferred from the glyph. Under
  // the resting-text ruling that sentence must not become painted face text, and
  // it does not need to: the accessible name is exactly where the ruling puts
  // this class. The `aria-not-painted` leg below is what keeps it there.
  //
  // ⚠ THE EMPTY-STATE LINE ("Pick an X-axis + Y-axis module to build the patch
  // matrix.") is INSTRUCTIONAL COPY IN AN EMPTY STATE, not a value — the
  // samsloop / twotracks "NO SAMPLE LOADED" shape, and like those it is REPLACED
  // by the surface the moment the surface exists. It is drawn rather than left
  // blank so that "no axes picked yet" and "the body failed to mount" are
  // different pictures, which matters because the fresh-spawn empty state is
  // exactly what this module's dock baseline captures.
  matrixmix: { role: 'control-grid', why: 'the rack-wide PATCH MATRIX — a scrollable cross-point table over two OTHER modules\' jacks, where each cell is a cable that exists, could exist, or would replace one. ⚠ IT IS A CONTROL GRID, NOT A PICTURE: the table is the surface the module is OPERATED from (a click patches or unpatches through the shared validateEdge seam), not a preview of something happening elsewhere — which is also why it mounts no canvas and must not grow one, since attest basis membership is derived from CONTENT and a WebGL body would enrol a meta module in the GPU attest. ⚠ ALL PAINTED TEXT IS A CONTROL CAPTION: the two axis corner labels and one port id + direction per row/column head. No value, no measurement, no state word. ⚠ THE SEMANTICS LIVE ON aria-label, per the resting-text ruling — the dot/✕ glyph cannot say "clicking replaces the existing source", so the sentence is the accessible name and never a text node. ⚠ IT IS A BODY RATHER THAN A PANEL for two mechanical reasons: ShellPanelCell REQUIRES a minWidth NUMBER and this grid is 4 columns or 40 depending on two foreign modules (any number would be a fiction in a required field), and its required probe vocabulary is data/data-rev/text while this surface\'s observable is patch.edges BETWEEN TWO OTHER NODES — neither this node\'s data nor its text. ⚠ NO SCREEN SWITCH and NO WATCH MARK: the video-screen ruling runs over STRICT_FACES INTERSECT video defs and this is domain meta, and markWatched is a VideoEngine pull-set concept this module has no part in.' },
  // ── GAMEPAD (2026-08-24) — the roster's SECOND control grid, and the first
  //    whose cells are driven from OUTSIDE THE DOCUMENT ────────────────────
  //
  // matrixMix's cells reflect GRAPH state (`patch.edges`); these reflect LIVE
  // DEVICE state, read through `engine.read(node,'snapshot')` at rAF. The
  // predicate holds either way and the role's prose survives the substitution
  // intact — a cell is still the surface an output is REBOUND from, and its lit
  // state is still that cell's own state rather than a preview of something
  // elsewhere. It is named here rather than left for the third adopter to
  // discover.
  //
  // ⚠ IT IS ALSO THE FIRST BODY TO SATISFY **TWO** PREDICATES. Four `StatusLed`s
  // live on this surface, so `status-primitive` holds too. That is legal and
  // green — the gate checks `ROLE_PREDICATE[rule.role]` for the DECLARED role
  // only, and this roster's own header says the roles are not exclusive by
  // intent. The declared role is `control-grid` because the GRID is what the
  // module is operated from; the four lamps are cells on it, not the surface's
  // purpose. Stated because a reader who checked only the `status-primitive`
  // predicate would conclude the entry is mislabelled.
  //
  // ⚠ AND THE SPEAKABLE LEG BELOW GENUINELY BITES HERE. This body paints
  // `{btn.label}` on twelve tiles, so the naive port (`aria-label={btn.label}`
  // beside `>{btn.label}<`) is exactly the offence that leg was written for.
  // Every accessible name is routed through `./gamepad-board-model`, which makes
  // the two expressions structurally different rather than accidentally so.
  gamepad: { role: 'control-grid', why: 'the CONTROLLER MAPPING BOARD — twelve button cells, two trigger rows and two stick pads, where right-clicking a cell ARMS a remap and the next physical control the player moves binds that output, plus both stick calibrations, the four invert toggles, the two set-centre re-zeros and the save/load-mapping row with its preset picker. ⚠ IT IS A CONTROL GRID, NOT A PICTURE: a cell is the surface an OUTPUT is rebound FROM, and its lit state is that cell\'s own state rather than a preview of something happening elsewhere — which is also why it mounts no canvas and must not grow one, since WebGL attest basis membership is derived from CONTENT and a GL body would put every future face edit on the GPU-attest critical path (the sticks and the trigger bars are <svg>, deliberately, so their marks stay in the DOM where a source gate can see them). ⚠ IT IS THE FIRST CONTROL GRID WHOSE CELLS ARE DRIVEN FROM OUTSIDE THE DOCUMENT: matrixMix reflects patch.edges, these reflect a live navigator.getGamepads() poll published by the ENGINE NODE through read("snapshot") — which is also why no status registry is needed, the poll that writes the eighteen outputs is node-lifetime and survives every unmount by construction. ⚠ IT ALSO IMPORTS StatusLed, so the status-primitive predicate holds too; the declared role is control-grid because the grid is what the module is OPERATED from and the four lamps (PAD, CAL L, CAL R, MAPPING) are cells on it. ⚠ ALL PAINTED TEXT IS A CAPTION OR AN OPTION NAME: twelve LED captions read from GAMEPAD_OUTPUTS so a def-side label edit propagates, LT/RT, L/R, inv, x/y, the button captions, and the preset roster\'s own names. No value, no measurement, no state word — the pad id, both calibrated badges, the live sweep range and every mapping outcome are on StatusLed detail or on an aria-label. ⚠ THE ONE PAINTED SENTENCE is the EMPTY-STATE instruction ("press any button ON THE CONTROLLER"), which is instructional copy in an empty state (the midiclock precedent) and is unavoidable rather than chosen: the Gamepad API\'s gate is a physical button press, so no in-page affordance could replace it. ⚠ THE SWEEP EXTENT IS DRAWN, NOT PRINTED: a dashed rect inside the stick pad, in the same coordinate system as the live dot, replacing four live decimals with the picture of the quantity they reported. ⚠ IT IS A BODY RATHER THAN A PANEL for two mechanical reasons: ShellPanelCell REQUIRES a minWidth NUMBER and this surface is one calibration row or a twelve-cell grid depending on mode, and the required probe vocabulary is data/data-rev/text while the observable of an armed remap is a PHYSICAL BUTTON PRESS on hardware no runner has. ⚠ IT CARRIES A FILE INPUT (load mapping, .json) — precedented by picturebox\'s body — and owns a window keydown for Escape-cancels-remap whose teardown rides the component. ⚠ NO SCREEN SWITCH and NO WATCH MARK: the video-screen ruling runs over STRICT_FACES INTERSECT video defs and this is domain audio, and markWatched is a VideoEngine pull-set concept this module has no part in.' },
  // ── ELECTRA CONTROL — the roster's FOURTH meta body, and the only control
  //    grid whose cells drive params on OTHER NODES ─────────────────────────
  //
  // ⚠ IT IS THE THIRD BODY TO SATISFY THE ROLE ON ITS OWN TERMS RATHER THAN BY
  // ELIMINATION. matrixMix's grid reflects `patch.edges`; gamepad's reflects a
  // `navigator.getGamepads()` poll; this one reflects thirty-six POINTERS into
  // other nodes' params, and turning a cell writes the SOURCE node. All three
  // are "the surface the module is operated FROM", which is the definition
  // `control-grid` arrived with.
  //
  // ⚠ THE SPEAKABLE LEG BELOW BITES HERE AND IS ANSWERED STRUCTURALLY. The board
  // paints three bank labels and each filled knob's caption, and its accessible
  // names carry the FIRMWARE COORDINATE the caption cannot ("control set 2 pot
  // 10"). Those names are built in `./electra-board-model`, so the aria
  // expression and any painted expression are structurally different — the fix
  // gamepad's entry records for the same leg.
  electraControl: { role: 'control-grid', why: 'the ELECTRA ONE BOARD — a fixed 6×6 matrix of thirty-six slots, each holding a POINTER (moduleId + paramId + optional 14-char name) to a control on some other module, rendered as a proxied Knob that reads and writes the SOURCE node live, under a stripe of that source\'s own control colour resolved per render and never stored. ⚠ IT IS A CONTROL GRID, NOT A PICTURE: a cell is the surface another module\'s param is TURNED from, and the board is also the PRESET a physical Electra One is flashed with, so its geometry is the hardware\'s (three stacked 2-row banks = three 12-pot control sets) rather than a layout choice. It mounts no drawing surface and must not grow one — the role predicates GREP RAW SOURCE and cannot tell code from a comment, so this sentence spells the tag out in words — and beyond the gate, attest basis membership is derived from CONTENT, so a drawn body would enrol a meta module in the GPU attest. ⚠ ALL PAINTED TEXT IS A CONTROL CAPTION: three bank labels (TOP / MID / BOT) and each filled knob\'s own label, painted by Knob.svelte from a `label` prop. No value, no measurement, no state word — the flash outcome is on the ranked cell\'s accessible name and the slot VALUES are on Knob\'s own aria-valuetext. ⚠ THE SEMANTICS LIVE ON aria-label, per the resting-text ruling, and they are built in ./electra-board-model so the accessible expression is structurally distinct from anything painted: an EMPTY cell gains a name it never had (the card marked all thirty-six `aria-hidden`, so thirty of thirty-six PLACES on a board whose whole point is that empty slots are visible places were unspeakable), and the board container names the 6×6 shape plus a DERIVED assigned count read off the live slot map. ⚠ IT IS A BODY RATHER THAN A PANEL for the matrixMix reason, landing on the probe half: ShellPanelCell REQUIRES a probe speaking data/data-rev/text, and this surface\'s observable is a param on a DIFFERENT NODE — turning a proxy never touches this node\'s own data — so the only expressible probe is a revision counter, which is the dead-button hazard the registry warns about. ⚠ IT IS ALSO THE FIRST BODY THAT MUST PAINT IN THE WORKFLOW DRAWER: this module is the `E` of the M/E/C pin trio with surface `drawer` and is canvas-hidden, so the tray is its only surface, and dockFullViewHeadPlan gates the body on isFaceplateView(view) = view !== \'lane\' precisely so the pinned drawer gets it. ⚠ NO SCREEN SWITCH and NO WATCH MARK: the video-screen ruling runs over STRICT_FACES INTERSECT video defs and this is domain meta, and markWatched is a VideoEngine pull-set concept this module has no part in.' },
  // ── CONTROL SURFACE (2026-09-01) — electraControl's DYNAMIC sibling ──────
  //
  // The same pointer mechanism one entry up, minus the fixed geometry: groups
  // are first-seen per SOURCE module rather than a hardware matrix, and the
  // layout itself is a draggable, Y.Doc-persisted arrangement. `control-grid`
  // for the electraControl reason: a cell is the surface another module's
  // param is TURNED from, not a preview of something elsewhere.
  controlSurface: { role: 'control-grid', why: 'the POINTER BOARD — per-source group boxes with live display names, each holding proxied Knobs that read and write the SOURCE node\'s param through resolveSurfaceParam (flat node.params AND nested TOYBOX node.data both land on the live location the source\'s own knobs use), under a passthrough stripe of that source\'s control colour resolved per render and never stored, plus the per-knob ✎ rename (the Electra custom label, an inline <input type="text"> that is deliberately IN the fullViewBody file — the typed-entry parity leg reads only the directly-imported component) and the drag layout (unlocked: absolute boxes persisted to node.data.layout; locked: a flowing wrap — armed by the ranked LOCK cell, which is NOT duplicated here). ⚠ IT IS A CONTROL GRID, NOT A PICTURE: a knob is the surface another module\'s param is turned from, and it mounts no drawing surface and must not grow one — the role predicates GREP RAW SOURCE and cannot tell code from a comment, so this sentence spells the tag out in words; beyond the gate, attest basis membership is derived from CONTENT, so a drawn body would enrol a meta module in the GPU attest. ⚠ EVERY PROXIED KNOB PASSES AN EXPLICIT testid (cs-board-dial-*): Knob.svelte emits control-<paramId> whenever the MIDI-learn key is passed, and faces-parity asserts exact multiset equality against this def\'s params, which is []. For the same reason NO testid in the body starts with control- — the legacy card\'s control-surface-* vocabulary is deliberately not reused. ⚠ ALL PAINTED TEXT IS A CONTROL CAPTION, A SOURCE MODULE\'S NAME, OR EMPTY-STATE COPY: the group labels (names), each knob\'s own caption (a label prop consumed by Knob.svelte), the ✎ affordance, and the empty-state instruction naming the right-click "Send to …" gesture — the module\'s only discovery path, the midiclock licence. No value, no measurement, no state word; the control counts are DERIVED onto the board\'s aria-label and never painted. ⚠ THE PRUNE IS NOT HERE AND THAT IS THE POINT: pruneSurfaceDangling rides the tileBody (node-on-canvas lifetime), because this body mounts only while the dock full view is open and the card\'s $effect was the tree\'s only production caller — the ES-9 card-only-side-effect shape, which EXTENSION_BODY_ROLES itself cannot see (a tileBody is outside this gate\'s subject; controlsurface-face-model.test.ts pins the call at the source and the face e2e proves it with the dock CLOSED). ⚠ IT IS A BODY RATHER THAN A PANEL for the electraControl reason landing on both halves: ShellPanelCell.minWidth is a required NUMBER and this board\'s width is a function of how many sources are bound (360–760 px on the card), and the required probe speaks data/data-rev/text while this surface\'s observable is a param on a DIFFERENT NODE. ⚠ NO SCREEN SWITCH and NO WATCH MARK: the video-screen ruling runs over STRICT_FACES INTERSECT video defs and this is domain meta, and markWatched is a VideoEngine pull-set concept this module has no part in.' },

  // ── THE CODE-BUFFER PAIR — the roster's first TEXT EDITORS ───────────────
  //
  // ⚠ `control-grid` IS THE HONEST ROLE, AND THE ALTERNATIVES WERE CHECKED
  // RATHER THAN ELIMINATED BY DEFAULT. `picture` is false — CodeMirror mounts a
  // DOM tree of styled spans and no drawing surface, and both bodies must never
  // grow one (the predicates GREP RAW SOURCE and cannot tell code from a
  // comment, so this sentence spells the tag out in words). `status-primitive`
  // is TRUE of both — each imports StatusLed and each paints its measurements
  // through it — and it is not the DECLARED role, on the gamepad precedent:
  // the role names what the body IS, and these are surfaces the module is
  // OPERATED from with a lamp beside them, not measurement strips.
  //
  // The third role's own definition is what fits: "a DOM control surface that is
  // neither a preview of something nor a measurement of something, but the
  // surface the module is operated FROM". A code buffer is exactly that, and it
  // is the reason both modules need a body at all — `resolveFaceControl`
  // resolves a face key to a param, a `-{n}` family or a legend static, and a
  // text document is none of the three.
  clockedRunner: { role: 'control-grid', why: 'the CALLBACK BODY — a CodeMirror buffer holding the JavaScript this runner re-evaluates on every division boundary, edited in place and committed to node.data.source on a 250 ms debounce that FLUSHES on unmount (#1583, and this surface is where that matters most: the dock LRU-evicts a pane when a third module is expanded). ⚠ IT IS A CONTROL GRID, NOT A PICTURE: the buffer is the surface the module is operated from — it IS the program — and it mounts no drawing surface and must not grow one, since the role predicates read raw source and, beyond the gate, a drawn body would enrol an audio def in the GPU attest. ⚠ ALL PAINTED TEXT IS THE USER\'S OWN DOCUMENT plus two static lamp captions (FIRING, ERROR). The buffer is not derived state: it is the document the module runs, the way a fader position is the value it sets. No value, no measurement, no state word — the fire count, the tempo the period was derived from, the earlier-failure total and the current error text are all StatusLed detail, which reaches aria-label and title and never a text node. ⚠ WHAT IT REPLACED IS NAMED RATHER THAN QUIETLY DROPPED: the card painted `fired {n}x (every {division})`, a COUNT and a state sentence outside any control, which is the deleted-readout shape verbatim. ⚠ THE SEMANTICS LIVE ON aria-label, per the resting-text ruling: the buffer is a named group whose accessible name states what the document IS and how often it runs, which no visible caption says, and that expression is built in the script and never painted. ⚠ IT IS A BODY RATHER THAN A PANEL by the probe discriminator: ShellPanelProbe REQUIRES an element to click or drag with a data/data-rev/text observable, and this surface\'s observable is a document a keyboard edits. ⚠ NO RESIZE GRIP, unlike the card: node.data.width/height size the CARD, and a dock plate is sized by its pane, so a grip here would move numbers nothing reads (the videoOut ruling). ⚠ NO SCREEN SWITCH and NO WATCH MARK: the video-screen ruling runs over STRICT_FACES INTERSECT video defs and this is domain audio, and markWatched is a VideoEngine pull-set concept this module has no part in.' },
  livecode: { role: 'control-grid', why: 'the SCRIPT BUFFER and its OUTPUT LOG — a CodeMirror buffer holding the JavaScript that builds and patches the rack, plus the lines the last run printed through log(). ⚠ THIS BODY IS THE MODULE, not a surface beside it: livecodeDef.factory returns a no-op handle, so every evaluation this module ever performed happened inside its card, and migrated(type) stops both surfaces rendering a promoted module\'s card — the promotion moved the run out to livecode-cell-actions.ts, which the ranked RUN cell, this body and the legacy card all call. ⚠ IT IS A CONTROL GRID, NOT A PICTURE: the buffer is the surface the module is operated from, and it mounts no drawing surface and must not grow one (the predicates read raw source; and a drawn body would enrol an audio def in the GPU attest). ⚠ THE OUTPUT LOG IS THE SCRIPT\'S PRODUCT, NOT DERIVED STATE ABOUT A CONTROL. This module has no ports at all, so the log is literally its only output and deleting it would delete a documented API function\'s destination — and it is ABSENT AT REST, because node.data.lastRun is unset until a run happens, so the resting plate paints no log and no empty-state placeholder (the card\'s "output log appears here after Run" is GONE, not relocated: the plate has other content, so the empty-state-instruction licence midiclock and es9 hold does not reach it). ⚠ ALL OTHER PAINTED TEXT IS THE USER\'S OWN DOCUMENT plus one static lamp caption (RUN). The card\'s `OK - {n} mutations applied` and its line:col error sentence are StatusLed detail now, reaching aria-label and title only. ⚠ THE SEMANTICS LIVE ON aria-label: the buffer and the log are named groups whose accessible names say what each region IS, built in the script and never painted. ⚠ IT IS A BODY RATHER THAN A PANEL by the probe discriminator: ShellPanelProbe REQUIRES an element to click or drag, and neither a text document nor a console is one. ⚠ NO RESIZE GRIP, unlike the card, for the videoOut reason. ⚠ NO SCREEN SWITCH and NO WATCH MARK: domain audio, and markWatched is a VideoEngine concept this module has no part in.' },
  '4plexvid': { role: 'picture', why: 'the four-input video switcher\'s live output preview canvas and its SCREEN switch.' },
  // ── audioOut — the roster's first AUDIO METER, and the first body whose
  //    text-role question is about what it DOES NOT draw ────────────────────
  //
  // ⚠ THIS BODY DELIBERATELY PAINTS NO NUMBER INTO ITS CANVAS, and that is a
  // decision rather than an omission, because a meter is exactly the surface
  // where a dB scale looks like part of the instrument. It draws the two bars,
  // three UNLABELLED tick marks and the ceiling mark, and nothing else — the
  // measurement lives on `aria-valuetext`, which is speakable and assertable
  // and unpainted. The mock this face was built from DID carry a `-inf/-24/
  // -12/-6/-1` ruler and it was dropped: "a -1.0 dBFS label" is the hero
  // readout strip with a haircut, and this roster is the only gate that can see
  // canvas text at all.
  //
  // ⚠ THE ONE TEXT IN THE BODY IS DOM, NOT CANVAS, AND IT IS TRANSIENT: a
  // `setSinkId` REJECTION line that does not exist unless a pick failed —
  // feedback on a gesture, the same shape the platform's own `ShellFileCell`
  // paints under its button. At rest there is no error and therefore no text.
  audioOut: { role: 'picture', why: 'the rack\'s TERMINAL STEREO METER — two per-channel bars off the exact node feeding ctx.destination, with the brickwall ceiling mark read from MASTER_CEILING_DB — plus the setSinkId output-device picker, which is service state no ParamDef can express (the cameraInput precedent). ⚠ NO NUMBERS ARE PAINTED INTO THE CANVAS: no dB readout, no peak value, no axis labels, only unlabelled ticks and the ceiling mark; the measurement is on aria-valuetext. ⚠ IT READS THE PER-CHANNEL TAPS, never the mono one — an AnalyserNode analyses a mono downmix, so the mono key cannot tell only-L from only-R and reads ~0 for an anti-phase pair, which is the exact blindness the per-channel taps were added to remove. ⚠ NO SCREEN SWITCH and NO WATCH MARK, derived exactly as spectrograph\'s and samsloop\'s are: the video screen ruling runs over STRICT_FACES INTERSECT video defs and this is domain audio, and markWatched is a VideoEngine pull-set concept this module has no part in. On the merits it is videoOut\'s argument — with the meter collapsed this face is one fader, and seeing the level is the reason to open it.' },
  // ── audioIn — the roster's first CAPTURE BINDER, and the first body whose
  //    job is to make a picture SOMEWHERE ELSE possible ────────────────────
  //
  // ⚠ IT IS THE ONE ENTRY HERE THAT DELIBERATELY DRAWS NOTHING, and that is the
  // opposite decision from its twin one row up. `audioOut`'s body paints a meter
  // because `outputs: []` makes its glyph mechanically dead and the body is the
  // only place a level could go. `audioIn` declares two real audio outputs, so
  // `glyphBinding` returns a LIVE `live-audio` binding and the SHELL paints the
  // level on the lane tile. A meter in this body would be the same measurement
  // derived twice and would cost the role its own predicate.
  //
  // ⚠ ITS `tileBody` IS WHY THE ROLE FITS AT ALL. `EXTENSION_BODY_ROLES` cannot
  // see a `tileBody` (this file's own blind-spot list says so), and this
  // module's two slots mount ONE shared component, so what the predicate checks
  // on the full-view body is true of the tile by construction rather than by
  // two components happening to agree.
  audioIn: { role: 'status-primitive', why: 'the CAPTURE BINDER — the live enumerateDevices input roster, the ENABLE/RETRY/STOP gesture that is the only route to a first getUserMedia grant, the music-mode DSP switch, and TWO StatusLeds (LIVE, FAULT). ⚠ IT MOUNTS NO DRAWING SURFACE AND MUST NOT GROW ONE: the role predicate follows the mount and greps raw source (it cannot tell code from a comment, so the tag is spelled out in words), and beyond the gate a drawn body would enrol an audio def in the GPU attest for nothing. ⚠ NO METER HERE, UNLIKE audioOut\'s body one row up, and the difference is structural rather than stylistic: this def declares audio_l_out/audio_r_out, so primaryAudioOutPortId resolves and face.glyph:\'meter\' is a LIVE shell binding on the lane tile — the picture exists, it is the shell\'s, and drawing a second one here would derive the same level twice. ⚠ TWO LAMPS, NOT ONE, BECAUSE THE CAPTION IS STATIC BY CONTRACT: one lamp cannot separate "not running because nobody asked" (idle) from "not running because the browser refused" (permission-denied / device-in-use / no-inputs-found / unsupported / error), and those are the two states a player must tell apart before they can act. Both announce the same sentence through `detail`. ⚠ TWO RESTING READOUTS WERE DELETED RATHER THAN HIDDEN: the card\'s eight-word STATE LABEL and its stereo/mono CHANNEL BADGE, both derived values painted outside a control. They live in the pure audio-in-status.ts and reach aria-label/title only. ⚠ ALL PAINTED TEXT IS A CONTROL CAPTION OR AN OPTION NAME: the two static lamp captions, the music-mode caption, the action button\'s own caption (ENABLE/RETRY/STOP — the cameraInput precedent for a caption that names the gesture it performs), and the device roster\'s own names with the browser\'s pre-permission positional fallback. The one SENTENCE is the transient role="alert" error line, which does not exist unless something failed — the audioOut sink-error shape — and it is dropped on the compact tile where the FAULT lamp\'s title carries it verbatim. ⚠ IT IS A BODY RATHER THAN A PANEL by the probe discriminator: ShellPanelCell REQUIRES a minWidth NUMBER and a probe speaking data/data-rev/text, while this surface\'s observable is an OS permission decision and a MediaStreamTrack.readyState on a resource the node owns. ⚠ IT IS ALSO THE PINNED INSTANCE\'S ONLY SURFACE: pinned-audioIn is canvas-hidden and the 🎧 tray mounts it at view=\'drawer\', which dockFullViewHeadPlan treats as a faceplate view. ⚠ NO SCREEN SWITCH and NO WATCH MARK: the video-screen ruling runs over STRICT_FACES INTERSECT video defs and this is domain audio, markWatched is a VideoEngine pull-set concept this module has no part in, and there is no picture here to collapse.' },
  b3ntb0x: { role: 'picture', why: 'the feedback-bender\'s live output preview canvas and its SCREEN switch.' },
  // ── BLOOD — the roster's first GAME, and the first body whose failure mode
  //    is SILENCE rather than a missing picture ────────────────────────────
  //
  // ⚠ EVERY OTHER `picture` ENTRY HERE IS ABOUT A PREVIEW. This one is about a
  // BOOT. `BloodCard.svelte` mounts no canvas at all, so nothing visual is being
  // rescued from it — what it held was the tree's only `extras.ensureLoaded()`
  // call, and blood is in neither half of HEADLESS_MOUNT_LANE_TYPES, so a body
  // that mounted a beautiful canvas and forgot to boot would satisfy this gate's
  // predicate perfectly and ship a module that never starts.
  //
  // ⚠ IT ALSO CARRIES A CAPTURE-PHASE WINDOW KEYBOARD LISTENER, which no other
  // shipped `fullViewBody` does. `gamepad`'s Escape handler is the nearest
  // precedent and it is bubble-phase and single-key; this one claims a whole
  // scancode map ahead of xyflow's own document keydown. Its teardown rides the
  // component (onDestroy), like gamepad's.
  blood: { role: 'picture', why: 'the BUILD-ENGINE GAME VIEWPORT — the live NBlood framebuffer blitted from the engine, plus the SCREEN switch, the BOOT kick, the multiple+webkitdirectory folder picker for a full-game override, the actionable data/not-built error prose, and the capture-phase keyboard host that makes the game playable. ⚠ THIS BODY IS NOT A PREVIEW BEING RESCUED, IT IS THE MODULE BEING STARTED: BloodCard.svelte mounts NO canvas anywhere in it (the "its body is the viewport" line in the old migration entry described DoomCard), so the face ADDS blood\'s first picture — but what the card actually owned was the tree\'s ONLY `extras.ensureLoaded()` call, and blood is in neither half of HEADLESS_MOUNT_LANE_TYPES, so promotion with a body that failed to boot would leave a module DARK FOREVER while every def-reading gate stayed green. The boot is $lib/blood/blood-boot.ts, called by both surfaces. ⚠ ALL PAINTED TEXT IS A CONTROL CAPTION OR INSTRUCTIONAL COPY IN A FAILURE STATE: the SCREEN caption, BOOT, LOAD FULL DATA, a transient "loading…"/"reading data…" progress line, and the two error prompts (the required-file list and the BLOOD_LINK=1 build command) — instructions for a gesture, without which a local developer cannot act on the state at all. No value, no measurement. ⚠ ONE RESTING READOUT WAS DELETED, NOT HIDDEN: the card\'s "Running — click + use arrows/Ctrl/Space" state line is gone, and the fact it carried is on the frame\'s aria-label plus a data-blood-status attribute. ⚠ IT MUST STAY 2-D: blood.ts is in the WebGL attest basis and this file is deliberately outside it, so it blits the engine canvas through getContext("2d") and must never create a GL context — membership is derived from CONTENT, so a GL body would enrol every future face edit in the real-GPU attest. ⚠ SCREEN OFF KEEPS THE WATCH MARK, and the argument is WEAKER than acidwarp\'s and weaker than this entry\'s first draft claimed — which is recorded rather than quietly corrected. blood IS structurally pull-exempt via a non-empty audioSources map (video/engine.ts names it by name); the draft reasoned that blood.ts populates that map only inside `if (ctx.audioCtx)` and that a gesture-less rack would therefore have an empty one, and that is FALSE: PatchEngine.registerDomain injects the AudioContext into the VideoEngine whenever both domains are registered, an AudioContext constructs suspended with no gesture, and /rack always registers both. MEASURED: deleting the markWatched call leaves blood-face-screen.spec.ts green. It stays because it makes SCREEN OFF safe INDEPENDENT of the audio topology — surface.draw is what calls runtime.runFrame(), so on any future rack where the exemption does not hold the switch would stop the SIMULATION rather than a picture — but no gate covers that line and this sentence is the only place that says so.' },
  backdraft: { role: 'picture', why: 'the 3-D scene preview canvas plus the preview-collapse toggle that became the fleet-wide SCREEN ON/OFF standard.' },
  bentbox: { role: 'picture', why: 'the pixel-bender\'s live output preview canvas and its SCREEN switch.' },
  colourofmagic: { role: 'picture', why: 'the multi-colorspace processor\'s live preview canvas and its SCREEN switch (#2015: OFF stops the preview copy, never the engine).' },
  // ── FROGGER (2026-08-26) — the roster's first ARCADE BOARD ───────────────
  //
  // ⚠ THE ONE ENTRY HERE WHOSE CANVAS DELIBERATELY PAINTS NUMBERS, and it is
  // on the ALLOWED side of the resting-text ruling rather than an exception to
  // it. `drawFrogger` paints `LIVES n  LV n  T n` and `SCORE n` INTO THE
  // PLAYFIELD, by the module's own pure function — that is the game's own
  // artwork, part of the picture that earns the width, and it is what the
  // legacy card painted too. What is FORBIDDEN is a score or lives row rendered
  // as CHROME BESIDE the playfield, and this body renders none: its entire DOM
  // text is the SCREEN switch caption, asserted exhaustively (and
  // negative-controlled) in `frogger-face-model.test.ts`.
  //
  // ⚠ AND THE PAINTED NUMBERS ARE SPEAKABLE, which a canvas otherwise makes
  // impossible: the board frame carries `role="img"` with an `aria-label`
  // naming lives / level / seconds / score. That is where the ruling puts this
  // class, and the model test pins that it stays an ATTRIBUTE rather than
  // becoming a text node.
  frogger: { role: 'picture', why: 'the ARCADE BOARD — a 14x13 grid of traffic, river rafts and home pads painted every rAF from the engine snapshot by the module\'s own exported `drawFrogger`, plus its SCREEN switch. ⚠ IT IS THE MODULE\'S IDENTITY, NOT A PREVIEW OF SOMETHING ELSEWHERE: the board IS how you read what the gate outputs are doing, and before promotion it existed only on a legacy card the shipping shell does not mount (frogger is not in NON_SHELL_LANE_TYPES, not a CARD_PRODUCER and not in HEADLESS_MOUNT_LANE_TYPES, so its lane tile was a blank placeholder). ⚠ THE HUD NUMBERS ARE PAINTED INTO THE CANVAS BY THE GAME and are allowed as the game\'s own artwork; the face adds NO chrome row of its own, and the body\'s only DOM text is the SCREEN caption. The measurements reach the a11y tree through role="img" + aria-label on the board frame. ⚠ SCREEN OFF IS UNUSUALLY SAFE HERE and the reason is worth copying carefully: the game runs on the shared SCHEDULER CLOCK subscribed in the module\'s FACTORY — not in this component, not on rAF, and not gated on the AudioContext (the clock is a Web Worker setInterval) — so collapsing the board stops a drawFrogger call and NOTHING else: the timer counts, the traffic moves and HOME/DEAD/LEVEL keep firing. ⚠ THIS ENTRY USED TO ADD "`skifree`, one module away in the same family, does NOT have that property", and that clause is now FALSE and is struck: it was written before #2192 (868ddb9ee) moved skifree\'s bundle load, controller and disposal into ITS factory on node lifetime, so both games are now scheduler-clock modules whose SCREEN switch skips a blit and nothing else. ⚠ NO WATCH MARK: markWatched is a VideoEngine pull-set concept and this is domain audio with three gate outputs.' },
  // ── SKIFREE — frogger's sibling, and the roster's first SHARED body ───────
  //
  // ⚠ THE ONLY ENTRY WHOSE COMPONENT IS ALSO MOUNTED ON THE LANE TILE. This
  // extension fills BOTH wired slots from ONE surface component
  // (`SkifreeScreen.svelte`, rendered by `SkifreeSlopeBody` at 320 px and
  // steerable, and by `SkifreeTileBody` at 104 px and read-only), so the
  // `picture` predicate resolves through the mount rather than off a `<canvas>`
  // in this file — which is exactly the indirection `paintsCanvas` follows, and
  // the reason it follows it. This roster only covers `fullViewBody`; the tile
  // body's existence is pinned in `skifree-face-model.test.ts`, because nothing
  // here or in #1974's zero-lane clause can see it.
  skifree: { role: 'picture', why: 'the SKI SLOPE — the upstream skifree.js engine\'s own canvas, blitted every rAF from the NODE\'s detached game canvas, plus its SCREEN switch and the module\'s ONE direct-manipulation instrument: the mouse. ⚠ IT IS THE MODULE\'S IDENTITY AND ITS ONLY CONTROL SURFACE AT ONCE. skifree declares `params: []`, so no ranked cell exists at any tier and no ParamCellKind mounts a canvas; without this body a promoted skifree could not be steered by hand at all, and before promotion the picture existed only on a legacy card the shipping shell does not mount (not in NON_SHELL_LANE_TYPES, not a CARD_PRODUCER, not in HEADLESS_MOUNT_LANE_TYPES, so its lane tile was a blank placeholder). ⚠ TWO SHIPPING DEFECTS ARE FIXED IN THE BLIT AND THE STEERING RESPECTIVELY, and both are invisible to every gate in the repo: the card\'s three-argument drawImage painted the TOP-LEFT QUADRANT on any DPR >= 2 display (the bundle re-sizes the canvas it is handed by devicePixelRatio, and Playwright and VRT both run at deviceScaleFactor: 1), and the bundle\'s own enableMouse takes its rect from the FACTORY\'s DETACHED canvas — all zeros since #2192 — so the cursor received raw VIEWPORT coordinates. Both surfaces now map their own element\'s rect through the def\'s pure pointerToCanvasCoord and derive the destination rect from src.width/height. ⚠ THE CURSOR WRITE SITS ABOVE THE previewCollapsed BRANCH: player.isMoving latches ONLY through setCursor, so a write routed through the paint would make SCREEN OFF a play kill switch on an unpatched rack. ⚠ THE CARD\'S HUD ROW IS DELETED, NOT MOVED — `{distance}m · lives {n} · CV|MOUSE|IDLE · GAME OVER` is a measurement, a count, a state word and a status banner in DOM chrome, none of the four permitted roles. What survives: the distance and lives the bundle\'s own InfoBox paints INSIDE the picture (the game\'s artwork, the frogger licence), the same values plus the steering mode on the frame\'s aria-label, and the control mode as TWO StatusLed lamps (CV, MOUSE) whose captions are STATIC — a three-way CV|MOUSE|IDLE caption would be the deleted state word with a lamp drawn beside it, so both dark IS idle. ⚠ THE ONLY OTHER PAINTED TEXT is the SCREEN caption and two TRANSIENT overlays naming the surface\'s own condition (`Loading…` and the bundle-load failure, the samsloop NO SAMPLE LOADED shape), each replaced the moment a game exists. ⚠ SCREEN OFF IS SAFE FOR THE SAME STRUCTURAL REASON AS FROGGER: the game is created in the FACTORY and its snapshot is assembled on the shared SCHEDULER CLOCK, so collapsing skips a drawImage and nothing else — the skier skis, `gate` pulses on every crash and the `out` video port keeps carrying the slope, because drawFrame reads the factory\'s own controller and never this component. Its one named cost: with no picture there is nothing to point at, so a run that has never STARTED cannot be started by mouse while off (a run in progress continues, and CV steering is unaffected). ⚠ NO WATCH MARK: markWatched is a VideoEngine pull-set concept and this is domain audio with a gate output and a cross-domain video bridge port.' },
  foxy: { role: 'picture', why: 'the video-synth\'s live output preview canvas and its SCREEN switch.' },
  gibribbon: { role: 'picture', why: 'the GAME SCREEN — the Vib-Ribbon-spirit ribbon course rasterised by the module\'s own engine (score, combo, ATTRACT label, count-in and GAME OVER are painted INTO the frame — the game\'s own artwork, per the GAMES.md ruling), blitted by the SHARED GibribbonScreen component both surfaces mount, plus its SCREEN and MONITOR switches, the RESET action and the WAD warn lamp. ⚠ IT IS THE MODULE\'S IDENTITY, NOT A PREVIEW OF SOMETHING ELSEWHERE — and unlike frogger it also IS the video output a rack projects (domain video), which is what face.monitor cites. ⚠ THE BODY\'S ONLY DOM TEXT IS CONTROL CAPTIONS (SCREEN / MONITOR / RESET / WAD); the derived numbers reach the a11y tree through aria-label on the playfield (role application — it genuinely owns the keyboard), pinned + negative-controlled in gibribbon-face-model.test.ts. ⚠ SCREEN OFF IS SAFE FOR THE FROGGER REASON: the game steps on the shared SCHEDULER CLOCK subscribed in the module FACTORY (a Web Worker setInterval, not rAF, not the AudioContext), so collapsing the screen stops a putImageData and NOTHING else — attract keeps playing and the evt_* gates keep firing. ⚠ NO WATCH MARK NEEDED: the module publishes audioSources, so the engine\'s pull-eval already exempts it from unwatched-skip structurally.' },
  freezeframe: { role: 'picture', why: 'the frame-hold preview canvas — the one surface on which "is it frozen?" is answerable at all.' },
  frametable: { role: 'picture', why: 'the video wavetable oscillator\'s live scan preview and its SCREEN switch — a picture FrametableCard.svelte already drew at 176x92, so this slot is a PORT rather than an addition and promotion would have deleted the surface without it. ⚠ It is also the roster\'s strongest watch-mark case after `vdelay`: this module\'s subject is a SIXTY-LAYER RING advanced once per draw, so a lapsed mark does not merely pause a preview, it punches a permanent GAP in the history you scan back through — which is the exact seam `frametableDef.pullExempt` exists to prevent, in its own words.' },
  grainsOfVision: { role: 'picture', why: 'the video-granulator\'s live preview canvas and its SCREEN switch (#1928 — the toggle a promotion would otherwise delete with the card).' },
  mandelbulb: { role: 'picture', why: 'the raymarched fractal\'s live preview canvas and its SCREEN switch.' },
  mirrorpool: { role: 'picture', why: 'the kaleidoscopic reflector\'s live preview canvas and its SCREEN switch.' },
  //
  // ⚠ THE SECOND ENTRY WHOSE CANVAS DELIBERATELY PAINTS NUMBERS, and it lands
  // on the ALLOWED side of the resting-text ruling for the same reason frogger
  // does: `drawModtris` paints `NEXT`, the next-piece preview, `LN n` and `LV n`
  // INTO THE PLAYFIELD, by the module's own pure function, into a strip the
  // painter reserves at 30 % of the canvas by construction
  // (`wellWidthPx = w * 0.7`). What is FORBIDDEN is a `LINES 17` or `LEVEL 2`
  // row rendered as CHROME BESIDE the well, and this body renders none — its
  // entire DOM text is the SCREEN switch caption, asserted exhaustively and
  // negative-controlled in `modtris-face-model.test.ts`.
  //
  // ⚠ `LV` IS NEW IN THAT PAINTER AND THE REASON IS A WIRING FIX, not decoration:
  // `levelStep` was a declared, faded, contract-locked control that NOTHING read
  // until this promotion wired the ramp, and without the number the only evidence
  // a level advanced is that the pieces feel faster — indistinguishable from
  // someone having moved DROP.
  modtris: { role: 'picture', why: 'the TETRIS WELL — a 10x20 stack plus the NEXT-piece preview and the LN / LV counts, painted every rAF from the engine snapshot by the module\'s own exported `drawModtris`, plus its SCREEN switch. ⚠ IT IS THE MODULE\'S IDENTITY, NOT A PREVIEW OF SOMETHING ELSEWHERE: the well IS how you read what the gate outputs are doing — modtris is a gate-driven ACCUMULATOR whose output rate is a function of the stack you have built — and before promotion it existed only on a legacy card the shipping shell does not mount (modtris is not in NON_SHELL_LANE_TYPES, not a CARD_PRODUCER and not in HEADLESS_MOUNT_LANE_TYPES, so its lane tile was a blank placeholder). ⚠ THE COUNTS ARE PAINTED INTO THE CANVAS BY THE GAME and are allowed as the game\'s own artwork; the face adds NO chrome row of its own, and the body\'s only DOM text is the SCREEN caption. They reach the a11y tree through role="img" + aria-label on the well frame — and that frame sits OUTSIDE the collapse guard, so the accessible name genuinely tracks the game while the picture is off (frogger\'s puts it inside, so the same claim in that file is false there). ⚠ SCREEN OFF IS UNUSUALLY SAFE HERE for the same measured reason as frogger\'s: the game runs on the shared SCHEDULER CLOCK subscribed in the module\'s FACTORY — not in this component, not on rAF, and not gated on the AudioContext (the clock is a Web Worker setInterval) — so collapsing the well stops a drawModtris call and NOTHING else: pieces keep falling, lines keep clearing and LINE/OVERFILL keep firing. `skifree`, one module away in the same family, does NOT have that property. ⚠ NO WATCH MARK: markWatched is a VideoEngine pull-set concept and this is domain audio with two gate outputs.' },
  // ⚠ THE ONE `picture` BODY WHOSE PICTURE IS NOT THE ENGINE'S OUTPUT, because
  // this module HAS no output: `outToLaunchDef` declares `outputs: []` and its
  // surface is `{ fbo: null, texture: null }` — the only video def in the fleet
  // that is a pure SINK, whose "screen" is 81 physical LEDs. So there is nothing
  // for `blitOutputForPreview` to blit, and the canvas is drawn from the
  // module's own `read('grid9x9')` readback through the shared
  // `drawOutToLaunchPreview` that the LEGACY CARD also imports — which is what
  // makes "the preview shows exactly what the LEDs show" a structural fact
  // rather than two components that happen to agree today.
  //
  // ⚠ AND IT NEEDS NO `markWatched` DANCE, WHERE EVERY OTHER SCREEN-SWITCH BODY
  // HERE DOES. The siblings mark because their preview blit IS the watch mark
  // and a node drops out of the pull set 1.5 s after its last one; `isPullRoot`
  // returns true UNCONDITIONALLY for a `pullExempt` node before it ever consults
  // `watchedAt`, and this def declares `pullExempt: true` precisely so its
  // readback stays fresh with no observer. Recorded rather than inherited,
  // because the prediction was made from the sibling pattern and then checked
  // against `video/engine.ts` — the `scoreboard` row in `face-screen-render`
  // documents the same discipline.
  //
  // The painted TEXT is exhaustively: control captions (`SCREEN ON`/`OFF`,
  // `Unbind Launchpad`), OPTION NAMES (each Launchpad output's own name, with
  // the card's `(in use)` suffix that distinguishes a claimed one), an ERROR
  // line that is absent whenever nothing is wrong, an EMPTY-STATE line that is
  // replaced by the picker the moment there is a roster, and a static lamp
  // caption. No value, no measurement, no state word.
  outToLaunch: {
    role: 'picture',
    why:
      'the LIVE 9x9 MONITOR — the picture this module exists to put on a Launchpad Mini Mk3, '
      + 'drawn from the module\'s own GPU readback rather than from an output texture it does not '
      + 'have — plus its SCREEN switch, the per-machine Launchpad port picker, UNBIND, and the '
      + 'MONITOR lamp carrying the card\'s exclusivity warning in its accessible name.',
  },
  // ⚠ THE ONLY BODY IN THIS ROSTER THAT PAINTS **TWO** PICTURES, and the second
  // one is why the entry needs more than a line. VFPGA-RUNNER's body carries the
  // live output canvas plus the FABRIC floorplan — a read-only tile-grid + lit-
  // nets diagram of the loaded bitstream, drawn on its own Canvas2D by
  // `VfpgaFloorplan` — and the two SWAP: `showFabric` chooses which one occupies
  // the picture area, so there is never a third region and never a text column.
  //
  // TEXT ON THE SURFACE, exhaustively: `FABRIC` and `SCREEN ON`/`SCREEN OFF`,
  // both CONTROL CAPTIONS on their own buttons — the second is the fleet's
  // standard switch caption, unchanged from mirrorpool's. Nothing else is a text
  // node. What the floorplan CANVAS draws (tile-type letters and its own legend)
  // is the residue this file's header names and the dock VRT baseline sees.
  //
  // ⚠ AND WHAT IS DELIBERATELY *NOT* HERE: the loaded bitstream's NAME. It is
  // the picker's selected option label, one band below — permitted resting text
  // because it disambiguates that control's own position — and painting it a
  // second time over the picture would be a derived-state caption with no
  // control under it, which is the shape the 2026-08-19 rulings deleted.
  vfpgaRunner: { role: 'picture', why: 'the host\'s live output canvas for whatever bitstream is loaded, the FABRIC floorplan that swaps in for it, and the SCREEN switch.' },
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
  samsloop: { role: 'picture', why: 'the sample waveform, its START..END window wash and the live PLAYHEAD, carried onto the faceplate from a card promotion would otherwise delete. ⚠ THE SURFACE IS HOW TWO OF THE MODULE\'S PARAMS ARE OPERATED, not decoration beside them: START and END are positions IN this picture, so a promotion that dropped it would leave the player placing loop points blind — the same argument `shapedramps` makes about visibility, one step stronger because here the picture is the coordinate system for a control. ⚠ IT IS A BODY RATHER THAN A PANEL for two independent reasons, both worth naming because the discriminator alone would not settle it: the mid-take peak bar lives in the record registry\'s per-node CLOSURE (a take commits ONCE, on stop, so there is nothing on the node for a panel to derive it from) and the playhead is a per-frame read of a cursor on the audio thread; and `ShellPanelProbe` REQUIRES an element to click or drag, which this surface has never had — the canvas carries no pointer handler and the window is edited by the two faders beside it, so a panel could only have shipped by inventing a control the module does not have. ⚠ THE ONE TEXT IT PAINTS INTO THE CANVAS is the literal string NO SAMPLE LOADED, in the empty state — a placeholder naming the surface\'s own condition, not a measurement of any control, and it is REPLACED by the waveform the moment a sample exists. Named here because this roster is the only gate that can see canvas text at all. ⚠ NO SCREEN SWITCH and NO WATCH MARK, both derived exactly as spectrograph\'s are: the video screen ruling runs over `STRICT_FACES ∩ video defs` and this is `domain: audio`, and `markWatched` is a VideoEngine pull-set concept this module has no part in.' },
  spirographs: { role: 'picture', why: 'the harmonograph\'s live plot canvas and its SCREEN switch — the module whose right-hand TEXT column was deleted by the 2026-08-19 ruling, leaving the picture.' },
  videoOut: { role: 'picture', why: 'the rack video output\'s live preview canvas — the picture the whole module exists to produce.' },
  videocube: { role: 'picture', why: 'THREE surfaces, not one, which makes this the widest body in the roster: the volumetric RAY-MARCH, the SLICE cross-section (the only place "where am I cutting?" is answerable) and the derived WAVE trace (the only place this module\'s SOUND is visible) — plus its SCREEN switch. All three are ports from VideocubeCard, which promotion deletes. ⚠ The WAVE is the one a reader would drop as decoration and must not: this module\'s whole claim is that the picture and the drone are two readings of ONE field, and the wave beside the slice is where that claim is checkable. ⚠ Its watch-mark argument is the fleet\'s worst case — a lapsed mark stalls THREE 60-frame accumulator rings AND the audio drone derived from them, so the switch would punch holes in the recording and mute an output it does not even show.' },
  warrensvisions: { role: 'picture', why: 'the shader-visions preview canvas and its SCREEN switch.' },
  twotracks: { role: 'picture', why: 'TWO reel pictures, one per tape deck, each painting that reel\'s peak envelope, the wash over the tape OUTSIDE its loop window, the two draggable loop markers and the live PLAYHEAD — plus one control caption per reel (the letter A or B, which is the only thing separating two identical pictures) and the SCREEN switch. ⚠ THE SURFACE IS HOW FOUR OF THIS MODULE\'S PARAMS ARE OPERATED — start_a/end_a/start_b/end_b are positions IN these pictures — so it is samsloop\'s argument on two reels; the difference is that here the canvas CARRIES THE POINTER HANDLERS itself rather than being edited by faders beside it. ⚠ TWO GESTURES, TWO SEAMS, and the split is the reason it is worth reading: dragging a MARKER writes a param through setNodeParam (a durable setting: undoable, synced) while dragging anywhere else scrubs the PLAYHEAD through a `{type:seek}` engine message (transient performance state, in neither the Y.Doc nor the undo stack) — collapsing them would put a frame-rate cursor into the document. ⚠ IT IS A BODY RATHER THAN A PANEL by the mechanical discriminator: both the envelope and the playhead are PER-FRAME ENGINE READS (`engine.read(node,peaksA)`, `playheadA`) with nothing on the node to derive them from — the worklet owns the tape, and node.data deliberately carries only the transport state and the recorded LENGTH because a Float32Array cannot ride the Y.Doc envelope. ⚠ THE ONE TEXT IT PAINTS INTO A CANVAS is the literal string NO TAPE, in the empty state — a placeholder naming the surface\'s own condition, not a measurement of any control, and REPLACED by the waveform the moment a take exists. It is drawn rather than left blank precisely so that "no tape yet" and "the body failed to mount" are different pictures, which matters because the fresh-spawn empty state is what the dock baseline captures. ⚠ IT SHOWS BOTH REELS RATHER THAN THE ACTIVE TAB\'S, and that is forced rather than chosen: `ShellExtensionFullViewBodyProps` is `{ nodeId }` and ModuleShell renders the slot as `<ExtFullViewBody nodeId={id} />`, so a body is never told which tab is showing. It also happens to be the better answer on a face whose rank-1 control is the A/B crossfader — seeing both tapes is what tells you what it is blending. ⚠ A SCREEN SWITCH IS PRESENT, unlike samsloop\'s, and the difference is argued rather than inherited: samsloop refuses one because the picture IS the module, whereas here it is a preview beside twenty-nine params across seven bands, four of which are not about the tape at all — with it collapsed you still have a complete, usable tape machine. Nothing gates it either way (the video-screen ruling runs over `STRICT_FACES ∩ video defs` and this is `domain: audio`), so `twotracks-face-model.test.ts` asserts it at source, INCLUDING THE ORDER: the collapse skips the PAINT and never the per-frame engine read, so switching it back on shows the live tape rather than a stale frame. ⚠ NO WATCH MARK — `markWatched` is a VideoEngine pull-set concept this module has no part in.' },

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
  // ⚠ THE ROSTER'S MOST TEXT-HEAVY BODY, DECLARED AS SUCH RATHER THAN SLIPPED
  //    THROUGH. Every other `picture` here paints a canvas plus a switch caption.
  //    picturebox paints a canvas plus EIGHT file-pick controls, seven scale-degree
  //    tags and up to seven FILENAMES — and that is the point of the module, not
  //    decoration on it. Each of those is a permitted role in substance: the note
  //    tag (C D E F G A B) is an OPTION/LANDMARK NAME saying which pitch class
  //    reaches this slot; "Choose image…" / "Load file…" are CONTROL CAPTIONS on
  //    their own buttons; and the filename is the row's own caption — a file bank
  //    whose rows do not say which file is in them is not a file bank, and the
  //    name is what disambiguates seven otherwise-identical rows. What it does NOT
  //    paint is the one thing that WAS derived state: the card's
  //    `gif` / `synced (1024×768)` line is a state word and a measurement, and it
  //    is gone from this surface, living on the canvas's `aria-label` instead.
  picturebox: { role: 'picture', why: 'the image bank\'s LIVE ENGINE OUTPUT — deliberately not an <img> of node.data.imageBytes, because that field is the SINGLE-image slot while the displayed slot is gate-selected local render state, so a data: URL would show the wrong picture the moment a clip player selected slot 3 and would be blind to GAIN besides — plus the SCREEN switch, the single-file picker, and the 7-slot bank with its scale-degree tags and per-row filenames. ⚠ The bank is on this surface rather than behind a `panel` cell because its controls are `<input type="file">` elements: no ParamCellKind mounts one, so without this body a promoted picturebox would be a picture source with no way to be given a picture. ⚠ AND THE WATCH MARK IS RETAINED FOR A REASON THE STATELESS BODIES DO NOT HAVE: an animated gif\'s frame index is advanced INSIDE surface.draw off the engine clock, so a collapsed state that stopped marking would stop the gif\'s clock and SCREEN back ON would resume from a stale frame — the #1720/#1721 shape the ruling names (#2015).' },
  tvLibrarian: { role: 'picture', why: 'the STATION TUNER: a live 16:9 picture of the module\'s OWN engine output with its SCREEN switch, and beneath it the two-level browse this module exists for — a clickable equirectangular world map or a country dropdown, then that country\'s channel roster with random / next. \u26a0 THE PICTURE IS THE ENGINE OUTPUT, NOT THE NODE-OWNED <video>, and that is a choice with two consequences rather than a copy of loopback\'s constraint. The element has ONE parent and the LEGACY card adopts it under ?shell=legacy, so blitting cannot fight anything; and the output is what `gain` scales and what downstream modules receive, so the one ranked control on this face is visible in the body, which the card\'s raw-element preview structurally cannot show. \u26a0 THE BODY IS LOAD-BEARING, NOT ADDITIVE. tvLibrarian left DOM_SOURCE_LANE_TYPES when its stream became node-owned (LEG-02 P3, #2209), so there is no <HeadlessSourceHost> and under the shell NO card is mounted anywhere — without this surface a promoted tvLibrarian could not be tuned at all. \u26a0 THE ROSTER IS A BODY RATHER THAN A `selector` CELL BY NECESSITY: ShellSelectorCell.options is a pure synchronous (node) => SelectorOption[], and both rosters here are runtime network fetches against a third-party dataset (famelack, hotlinked at runtime, never bundled) with their own loading, error and empty states — and persisting that payload into node.data to make it expressible would sync a volatile third-party blob into every saved rack. \u26a0 WHAT IT PAINTS AS TEXT: the control captions on its own buttons (map / list / random / next / SCREEN), the country NAME as a section label over the list it heads, and one station NAME per roster row with its geo badge and language tag — option names INSIDE the control that selects them, the picturebox per-slot-filename precedent. \u26a0 NOTHING DERIVED IS PAINTED: the card\'s NOW PLAYING label — the station name restated OUTSIDE every control, beside the picture — is DELETED on BOTH surfaces and lives on the picture\'s aria-label; the roster\'s highlighted row, scrolled into view on tune, is the painted answer, and that scroll is what makes the removal safe rather than merely compliant. \u26a0 THE TRANSIENT OVERLAYS STAY (tuning\u2026, stream unavailable \u2014 skipping, and the empty-state placeholder \'pick a country, then a channel\'): outcomes and a placeholder naming the surface\'s own condition, the samsloop NO SAMPLE LOADED shape, each replaced the moment a stream exists. \u26a0 THE ONE TEXT WITH NO DECLARED ROLE IS THE LEGAL DISCLAIMER AND THE FAMELACK / IPTV-ORG ATTRIBUTION, kept because the dataset licence requires it and refused by no gate because body text is this roster\'s stated blind spot — named here as the only fleet text whose justification is legal rather than design, and an open owner question whether that is a permitted resting-text role. peertube carries the same shape.' },
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

  // ── CAMERA — the first card-owned-source promotion ────────────────────────
  cameraInput: { role: 'picture', why: 'the capture source\'s live preview, its SCREEN switch, the runtime-enumerated DEVICE PICKER, a capture lamp, the card\'s recovery text and the ACQUIRE gesture. ⚠ THE WIDEST BODY IN THIS ROSTER, and not by preference: promotion moves CAMERA\'s real card into `<HeadlessSourceHost>`, parked at `left:-9999px` with `pointer-events: none`, so the card is MOUNTED (which is what keeps getUserMedia and the MediaStream alive) but nothing on it is CLICKABLE. This body is the only surface a player can reach. ⚠ "Request access" above all: it is the sole route to getUserMedia for a visitor this origin has not granted before, since the card\'s auto-acquire fires only when `enumerateDevices()` already returns real labels. ⚠ None of the four can be a face cell — a runtime device roster is not a `ParamDef`, an acquire is an ACTION not a value, and `controlCell` renders a `static` cell as a dead dashed label by design. ⚠ The picture is BLITTED from the engine and the node-owned `<video>` is never adopted: a DOM node has one parent, and adopting it would steal the element from the card that owns the stream. ⚠ The lamp reads the card\'s REAL published state through `$lib/ui/media/camera-status-registry` rather than guessing from the graph — a graph-derived lamp cannot tell "armed" from "permission denied" and would point away from the problem. Its resting TEXT is the device NAME (a name, not a measurement — the cvBuddy precedent) plus an ERROR that is absent whenever nothing is wrong.' },

  // ── LOOPBACK — the second card-owned-source promotion ─────────────────────
  loopback: { role: 'picture', why: 'the tab capture\'s live preview, its SCREEN switch, a capture lamp, the card\'s recovery text and BOTH capture gestures — ACQUIRE and STOP. ⚠ SAME STRUCTURAL REASON AS `cameraInput` ABOVE: promotion moves the real card into `<HeadlessSourceHost>`, parked at `left:-9999px` with `pointer-events: none`, so the card is MOUNTED (which is what keeps the getDisplayMedia stream alive) but nothing on it is CLICKABLE, and this body is the only surface a player can reach. ⚠ THE ACQUIRE CASE IS STRICTLY HARDER HERE, and that is the one thing not to carry over by analogy: cameraInput\'s card auto-acquires once the origin has been granted, so its button is the FIRST-VISIT route. A display capture has NO already-granted state — every capture, for every user, forever, needs a fresh gesture and a fresh trip through the browser picker — so without this body a promoted LOOPBACK cannot be started at all, by anyone. ⚠ STOP is here rather than being a param because `loopback.ts` is in the WebGL attest basis (a new param costs a real-GPU re-attest window) and because a SYNCED param would let one collaborator stop a capture living in another person\'s browser. ⚠ The LAMP could not be graph-derived even badly: `gain` and `crop` are the only params and neither moves when a capture starts, stops, is refused, or is ended from the browser\'s own share bar — so it reads the card\'s REAL published state through `$lib/ui/media/loopback-status-registry`. ⚠ The picture is BLITTED from the engine and the node-owned `<video>` is never adopted; here that is unrecoverable rather than merely bad, since re-acquiring a stolen tab capture means sending the user back through the picker. Its only resting TEXT is button captions plus an ERROR that is absent whenever nothing is wrong — the capture state itself lives in the lamp\'s `aria-label`, unpainted.' },

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
  // ── GRAPHIC EQ — the meter, and the last MONITOR card ─────────────────────
  graphicEq: { role: 'picture', why: 'the live frequency meters — 8 bands, or 2x8 split L|R — plus its SCREEN switch and, unlike shapes above, a MONITOR toggle and a corner resize grip, because GraphicEqCard.svelte does mount `hideControls`. ⚠ THE PICTURE IS THE READING, not an illustration of it: nothing on this face reports a level (`gain` and `peak` set how the meters RESPOND, never what they currently show), so MONITOR mode costs the player no readout at all and buys the whole frame. ⚠ AND ITS #2015 ARGUMENT IS THE ACCUMULATOR ONE, not the output-only one its three MONITOR siblings use: `peakL[]`/`peakR[]` are per-band peak-hold state advanced once per draw by `decayPeak`, and both AnalyserNodes carry `smoothingTimeConstant = 0.7`. A lapsed mark freezes the caps and stales the smoothing history, so the returning frame asserts peaks belonging to whenever the mark expired — it corrupts what the meters MEAN rather than merely pausing them. The output argument holds on top, and pointedly for a chainable `output`-category module. Nothing on the surface is a derived value in a text node — the numbers are drawn INTO the canvas as the meters themselves, which is the picture, not resting chrome.' },
  // ── BATCH 24 — CUT A, batch 1. All four are pictures; none mounts
  // `hideControls`, so no MONITOR toggle or resize grip is declared, and nothing
  // on any of the four surfaces is a derived value in a text node.
  chroma: { role: 'picture', why: 'the single-input colour grade\'s live preview and its SCREEN switch. ⚠ NOT `chromakey` below — that is the two-input COMPOSITOR; this is the GRADE, and chroma.ts carries a header about earlier versions conflating exactly these two roles. Holds no history of any kind, so the retained watch mark is purely about the PULL: it sits mid-chain, and a lapsed mark idles the chain feeding its one video input.' },
  chromakey: { role: 'picture', why: 'the two-input chroma-key compositor\'s live preview and its SCREEN switch. The retained watch mark matters more here than on any sibling in its batch: this node is the pull root for TWO upstream chains (`fg` and `bg`), so a lapsed mark idles both branches of the composite rather than one.' },
  feedback: { role: 'picture', why: '⚠ THE ACCUMULATOR CASE of batch 24, and the reason its body does NOT carry its batch-mates\' "it would resume identically" argument. FEEDBACK re-samples its own previous output from a ping-pong framebuffer, so the retained watch mark is not how the picture stays fresh — it is how the TRAIL EXISTS. A lapsed mark decays the accumulated image out of the patch, turning SCREEN into a history eraser.' },
  mandleblot: { role: 'picture', why: 'the Mandelbrot explorer\'s live fractal and its SCREEN switch. ⚠ TIME-ANIMATED despite holding no accumulator: `uTime * 0.1 * uColorCycle` cycles the palette and `color_cycle` ships at 1, so it is never still at rest. Its only input is a CV, making it the ORIGIN of its chain — a lapsed mark would mute the generator every consumer samples. ⚠ Its legacy card painted a derived magnification readout; this body deliberately does not, and that finding moved into the def\'s `docs.controls.zoom`.' },

  // ── CUT B — the first body that OWNS NO STATE AND MIRRORS NO SEED ─────────
  spectrograph: { role: 'picture', why: 'the scrolling sonogram — 256 columns of FFT history, newest at the right — carried onto the faceplate from a card promotion would otherwise delete. ⚠ The thinnest body in this roster by construction: it owns NO state and mirrors NO determinism seam. The scroll buffer lives in the module\'s factory closure and `drawFrame` is the only door to it, so the body calls that rather than re-implementing a second accumulator that would advance at its own rate and disagree with the card about which moment of the signal is on screen (the module\'s own 16 ms column gate makes a second and third caller in one frame idempotent). And `__spectrographVrtFreeze` is read INSIDE the module, not in the card, so this surface inherits the frozen fill without duplicating a global — the opposite of dockscope. ⚠ NO SCREEN SWITCH and NO WATCH MARK, both derived: the video screen ruling runs over `STRICT_FACES ∩ video defs` and this is `domain: audio`, and when the picture IS the module collapsing it deletes the product; `markWatched` is a VideoEngine pull-set concept and this module\'s analyser is fed by the Web Audio graph, which runs whether or not anyone is looking. The only text on the surface is the `view` control\'s own option NAME (COLOR / B/W), which names a colormap rather than measuring anything.' },

  lushgarden: { role: 'picture', why: 'the generative garden\'s live CLEAN output and its SCREEN switch. ⚠ Its #2015 argument is TWO independent ones, not the generic pull case: it is a pure SOURCE (no input requirement), so a lapsed mark mutes the origin of the chain rather than stalling a preview — AND the picture is a running ACCUMULATION, so a collapse that stopped surface.draw would leave the garden younger than the rack when SCREEN came back on. Nothing on the surface is a derived value in a text node; the plant-count readout the legacy card carried is deliberately absent, and its finding moved into the def docs.' },

  pong: { role: 'picture', why: 'the arcade COURT — ball, paddles, centre dash and the two scores — drawn by `drawPong` from an engine snapshot. ⚠ NOT an engine blit like every other picture in this roster: pong is an AUDIO module with no video surface, so the body owns a 2D canvas and reads `read(node, \'snapshot\')`. ⚠ AND IT DELIBERATELY DOES NOT `markWatched`: the game is stepped by the shared scheduler clock regardless of what is mounted, so there is no pull set to stay in and SCREEN OFF costs a repaint rather than the simulation. The scores are painted INTO the canvas as part of the picture, not as resting chrome.' },

  // ── SCOPE (2026-08-23) — the AUDIO picture that DOES carry a SCREEN switch ─
  scope: { role: 'picture', why: 'the rack probe\'s live dual-trace / Lissajous screen, its TUNING GRATICULE, and its SCREEN switch — all three carried onto the faceplate from a card promotion would otherwise delete. ⚠ THE SWITCH IS THE ENTRY, because scope lands on the OPPOSITE side of the ruling from every other audio picture in this roster. dockscope, spectrograph and samsloop each refuse a SCREEN switch on `videoOut`\'s argument — when the picture IS the module, collapsing it deletes the product rather than reclaiming space beside it — and dockscope declares `outputs: []`, so that argument holds there exactly. SCOPE IS AN INLINE PROBE: `ch1_out`/`ch2_out` pass the signal onward untouched and the `out` mono-video texture keeps rendering from the module\'s own `drawFrame`, neither of which this body owns. So the screen here really is a preview sitting beside nine controls, which is the shape the ruling is about. ⚠ AND NO GATE SEES IT: `video-face-screen-source.test.ts` builds its subject from `listVideoModuleDefs() ∩ STRICT_FACES` and this is `domain: audio`, so the switch ships compliant and UNGUARDED and a future edit deleting it would go green — `scope-face-model.test.ts` asserts it at the source, which is the only thing that does. ⚠ THE TEXT ON THIS SURFACE IS ALL INSIDE THE CANVAS and this roster is the only gate that can see canvas text at all, so it is enumerated exhaustively: the `±1.0` / `±5V` corner scale labels `drawScope` has always drawn (which name the `ch{1,2}Range` control\'s own position rather than measuring anything), and the tuning strip\'s NOTE LETTER — a graticule annotation naming what the marker is measured against, the way a hardware scope prints its cursor readout on the CRT rather than on the bezel. ⚠ The tuner\'s NUMBERS are the thing that did NOT come across: `ScopeCard.svelte` paints `PITCH 440.0 Hz | NOTE A4` as a labelled row of derived values under the picture, which is the HERO READOUT STRIP deleted fleet-wide on 2026-08-19, and the Hz, cents and confidence now live only on the strip element\'s `aria-label` — speakable, assertable, unpainted. ⚠ NO WATCH MARK: `markWatched` is a VideoEngine pull-set concept and this module\'s two AnalyserNodes are fed by the Web Audio graph, which runs whether or not anyone is looking.' },

  timelorde: { role: 'picture', why: 'the 220x220 DISPLAY — the owner\'s owl painting, its eyes and border brightening on the beat, or the live VIDEO IN feed when one is patched — plus the SCREEN switch. ⚠ THE ONLY BODY IN THIS ROSTER THAT RENDERS NOTHING: it blits `video_out`\'s own drawFrame, i.e. the frame `TimelordeCard` composites and pushes from an off-screen HeadlessSourceHost, so the faceplate and every downstream video module see the same pixels by construction and the owl render has exactly one implementation. ⚠ THAT ALSO INVERTS THE COLLAPSE RULE relative to rasterize: the producer here is the CARD, alive for the whole session, so SCREEN OFF costs a blit and never the picture — `video_out` is untouched. It is the module this floor most needed, because the card\'s rAF is the SOLE writer of `displayFrame`: a SCREEN switch that stopped it would turn a preview toggle into a producer kill switch for the whole rack. No derived value is painted here; the transport strip and the BPM footer the legacy card carried are gone by the resting-text ruling, and what they said now lives in the two transport rosters and in this canvas\'s aria-label.' },

  wavesculpt: { role: 'picture', why: 'the 4-voice 3-D scene — four wave ribbons inside a room whose six walls can be live video, seen through a camera the player flies — plus the SCREEN switch and the MONITOR resize. ⚠ IT MOUNTS `WavesculptVizSurface`, THE SAME COMPONENT THE LEGACY CARD MOUNTS, so the faceplate and the card are two mounts of ONE renderer rather than two renderers drifting against one DSP; that extraction was its own PR and is the reason this module could be promoted at all. ⚠ THE PICTURE IS ALSO THE PAD: the camera pad is declared `surface: \'body\'` and is painted here as an overlay ON the render, because you fly a camera by watching where it goes — the gesture and its feedback are one surface, which no band cell can express. The pad shows the KNOB while CV moves the PICTURE; those are two different numbers and both are correct, and this body deliberately does NOT read the camera shadow to reconcile them (that shadow is an owner-listed defect). ⚠ SCREEN OFF HIDES WITH CSS AND NEVER UNMOUNTS THE SURFACE: unmounting would run its onDestroy, disposing the GL context and uninstalling the cross-domain frame drawer, so collapsing a preview would black out `video_out` for every module downstream — the module\'s own drawFrame fills solid black with no drawer installed. The renderer keeps running; only the view stops. ⚠ NO DERIVED VALUE IS PAINTED. The pad\'s X/Y live on its `aria-label`, and the only text nodes on the surface are the two switch captions (SCREEN ON/OFF, MONITOR ON/OFF), which are control captions on their own buttons. What the canvas draws is the render itself, and the dock VRT baselines are what see it.' },

  // ── MIDICLOCK — the SECOND status body, and the first BINDER ─────────────
  //
  // ⚠ IT IS A `status-primitive` FOR A DIFFERENT REASON THAN cvBuddy'S, and the
  // difference is worth recording because it is the shape the whole binder
  // cohort will arrive in. cvBuddy's subject is RACK-GLOBAL (which ES-9 jacks
  // this instance was allocated — a function of every CV Buddy present). This
  // one's subject is a BINDING to hardware that is not in the rack at all, and
  // it is not rack-global: two midiclocks can listen to two different devices
  // and neither is a property of the other. So this body declares NO
  // `face.rackStatus`, suppresses no band, and the FORWARD leg above does not
  // reach it — the ROSTERED leg is what covers it, which is exactly the case
  // that leg was added for.
  //
  // TEXT ON THE SURFACE, exhaustively: the DEVICE `<select>`'s option NAMES (the
  // cameraInput precedent — a runtime device roster is not a `ParamDef` and not
  // an `options` roster either, and the device's name is a NAME), the `Device`
  // control CAPTION, the `Connect MIDI…` button's own caption, and — only when
  // something is wrong — the ACCESS FAILURE message from the shared
  // `midiOutcomeMessage` seam. That last one stays LOUD deliberately: the seam
  // exists because a browser that quietly suppresses its own MIDI permission
  // prompt is indistinguishable from a broken button, and the legacy card's
  // comment records a one-line hint swap that users did not register.
  //
  // ⚠ NOT ON THE SURFACE, and this is the entry's interesting half: the legacy
  // card's TWO readout rows. `STATE — RUN / STOP` is the deleted hero strip's
  // exact shape and is now the RUN LAMP — which matters, because it is the ONLY
  // place in the product that says whether the EXTERNAL transport is rolling,
  // and `run` is a level a player may not have patched anywhere visible.
  // `TICKS — n` is a raw count and is gone entirely, NOT relocated to an aria
  // attribute: the module's CLOCK branch returns before `notify()` (correctly —
  // 24 PPQN at 120 BPM is 48 Hz of subscriber pressure), so the pushed count
  // freezes for a whole performance, which is what the card was painting while
  // its comment called it a "live activity indicator". A frozen number in an
  // `aria-label` is the same lie one layer down.
  midiclock: {
    role: 'status-primitive',
    why:
      'the DEVICE BINDING for the MIDI transport bridge: the runtime-enumerated input picker, the '
      + 'CONNECT gesture, the access-failure message, and the MIDI / RUN lamps. The picker is the '
      + 'one affordance on this module that cannot be a face cell — its roster lives on the engine '
      + 'handle behind `requestMIDIAccess()` and differs per machine, so it is neither a `ParamDef` '
      + 'nor an `options` roster, which is a fixed set known when the def is authored. ⚠ The '
      + 'DIVISION and CONNECT are NOT duplicated here: both are real ranked cells that reach the '
      + 'lane, and a body carrying them too would be a second implementation of controls the face '
      + 'already owns. ⚠ Unlike cameraInput this body needs no status registry, because promotion '
      + 'does not park a live card off-screen — the MIDI handler is installed engine-side through '
      + 'an identity-scoped claim in the factory, so there is no second owner. Every measurement '
      + 'goes through `StatusLed` into `aria-label`/`title`; the only text nodes are option NAMES, '
      + 'control captions, and an ERROR that is absent whenever nothing is wrong.',
  },

  // ── PTZCAM — the THIRD status body, the SECOND binder, and the first whose
  //    subject is a piece of hardware OUTSIDE the computer ────────────────────
  //
  // midiclock's subject is a MIDI device attached to this machine. This one's is
  // a physical PTZ camera reached through a native helper process (tools/pt-ptz)
  // that translates sysex into USB camera control — so there are TWO things that
  // must be true before anything works, and the body's whole job is saying which
  // of them is not.
  //
  // TEXT ON THE SURFACE, exhaustively: the camera `<select>`'s option NAMES
  // (`PT-PTZ-…` port names plus the `— first camera —` default and the
  // `(offline)` suffix on a saved-but-absent pick), the `Camera` control
  // CAPTION, four static lamp captions (LINK / PAN / TILT / ZOOM), and — only
  // when something is wrong — the FAULT line, `role="alert"`, absent whenever
  // nothing is wrong. Plus one EMPTY-STATE instruction before any grant, which
  // is the licence midiclock and es9 already hold and is unavoidable here for
  // the same reason: the gate is a browser permission prompt, and no in-page
  // affordance can substitute for saying "press it".
  //
  // ⚠ THE `(offline)` SUFFIX IS AN OPTION NAME, NOT A STATE WORD, and the
  // distinction is load-bearing rather than lawyerly. `node.data.device` is a
  // saved port NAME; a patch reloaded before the helper starts holds a name the
  // live roster does not contain, and a `<select>` bound to a missing value
  // silently renders its first option instead — so the player's saved camera
  // would be lost BY RENDERING. The synthetic row is what keeps the choice
  // visible, and it names the thing that is not there.
  //
  // ⚠ THE ONE DELETED READOUT IS THE AXIS-MODE LINE (`pan abs · tilt abs ·
  // zoom abs`), and it is the entry's interesting half twice over.
  //
  // It is not decoration: the axis mode is the SEMANTICS OF EVERY OTHER CONTROL
  // on the module. An ABSOLUTE axis reads knob+CV as a position and obeys SLEW;
  // a VELOCITY axis reads the same number as a rate, treats zero as an explicit
  // stop inside a deadzone, and ignores SLEW entirely (a commanded stop must
  // never be slewed). Deleting it outright would leave four knobs whose meaning
  // is unknowable from the face.
  //
  // So it is THREE LAMPS — PAN / TILT / ZOOM, lit on VELOCITY, sentence on
  // `aria-label` — and the block renders ONLY inside `{#if status.caps}`. That
  // guard is the part a naive port drops. The underlying fact is three-valued
  // (`abs | vel | none`) and ABSENT before the handshake, so three unguarded
  // booleans would paint pre-bind exactly as they paint for a bound all-absolute
  // NexiGo P610 — all dark — and the face would be asserting "all three axes are
  // positions" about a module that knows nothing about any camera yet. Hiding
  // the block makes "unknown" the indicator's ABSENCE rather than one of its
  // states, which is what the legacy card's `{#if modeLine !== null}` did.
  //
  // ⚠ NO CONNECT BUTTON HERE: the gesture is a ranked `action` cell that reaches
  // the LANE TILE, which is the whole reason it is a cell. ⚠ NO STATUS REGISTRY,
  // for midiclock's reason rather than cameraInput's — the sysex send loop lives
  // in the module FACTORY on the scheduler tick and has always run with no
  // surface mounted, so promotion parks no live card off-screen and there is no
  // second owner. ⚠ NO SCREEN SWITCH and NO WATCH MARK: `domain: 'audio'` with
  // `outputs: []`, no canvas, and no VideoEngine pull set to fall out of — there
  // is no producer here that hiding a surface could stop. ⚠ IT MUST NOT GROW A
  // CANVAS: the role predicate greps raw source, and beyond the gate, attest
  // basis membership is derived from CONTENT.
  ptzcam: {
    role: 'status-primitive',
    why:
      'the CAMERA BINDING for the PTZ head: the live `PT-PTZ-*` roster picker with its '
      + '`(offline)` synthetic row, the nine-kind LINK lamp, the `role="alert"` fault line, and '
      + 'the three per-axis mode lamps (lit = VELOCITY). The picker cannot be a face cell for the '
      + "reason midiclock states above — its roster lives on the app's sysex MIDI access behind "
      + '`requestMIDIAccess({sysex:true})`, differs per machine and changes when the helper '
      + 'starts, so it is neither a `ParamDef` nor an `options` roster (a fixed set known when '
      + 'the def is authored). ⚠ CONNECT and the four trim knobs are NOT duplicated here: all '
      + 'five are ranked cells that reach the lane, and a body carrying them too would be a '
      + 'second implementation of controls the face already owns. ⚠ The axis lamps replace the '
      + "card's `pan abs · tilt abs · zoom abs` line, and they render only inside `{#if caps}` "
      + 'because the fact is three-valued and ABSENT pre-handshake — unguarded booleans would '
      + 'make "no camera yet" pixel-identical to "all three axes absolute". ⚠ No status registry '
      + '(the sysex send loop is in the factory on the scheduler tick and runs with no surface '
      + 'mounted), no screen switch and no watch mark (domain audio, `outputs: []`, no canvas). '
      + 'Every measurement goes through `StatusLed` into `aria-label`/`title`; the only text '
      + 'nodes are option NAMES, control captions, an empty-state instruction, and an ERROR that '
      + 'is absent whenever nothing is wrong.',
  },

  // ── ES-9 — the LINK STATUS strip, and the first body in this roster that
  //    carries no picker at all ──────────────────────────────────────────────
  es9: {
    role: 'status-primitive',
    why:
      'the HARDWARE LINK strip for the ES-9: an empty-state hint and three lamps — BRIDGE (the '
      + 'es9-bridge companion app answered), XRUN (`tone: warn`; the stream under-ran or '
      + 'over-ran the ring) and CV BUDDY (a CV Buddy has claimed some out jacks). ⚠ IT CARRIES '
      + 'NO PICKER AND NO BUTTON, and unlike the MIDI binders one entry up that is not a '
      + 'constraint being worked around: `maxInstances` is 1 and the native app accepts a single '
      + 'client, so there is exactly one device and no roster to choose from, while CONNECT and '
      + 'DISCONNECT are real ranked `action` cells — which is what puts the gesture on the LANE '
      + 'TILE rather than behind the dock, on a module that is silent until it is pressed. ⚠ THE '
      + 'LAMPS ARE WHERE FOUR DELETED READOUTS WENT, each a picture with its sentence in '
      + '`aria-label`: BRIDGE replaces the seven-way state word AND the rate / channel-count / '
      + 'round-trip row, with the narrowing stated in es9-status-model.ts (eight connection '
      + 'states onto two lamp states, mitigated by naming the exact failure in the detail and '
      + 'refusing a second FAULT lamp that would read as a malfunction after a deliberate '
      + 'DISCONNECT); XRUN replaces the `underruns/overruns` COUNT, and it is the removal with a '
      + 'downstream dependant, because cvBuddy\'s shipped body names the ES-9\'s xruns as the '
      + 'other half of diagnosing an unstable clock and says the two have opposite fixes; '
      + 'CV BUDDY replaces the "jacks driven by CV Buddy" LIST, which the card undersold as '
      + 'purely informational — the reconciler OWNS those jacks\' out-class under '
      + 'CVBUDDY_JANITOR_ORIGIN, so a plate rendering eight identical editable class cells while '
      + 'three of them are silently reverted would be a control that looks alive and is not. '
      + '⚠ IT NEEDS NO STATUS REGISTRY, unlike cameraInput: es9 is in neither '
      + '`DOM_SOURCE_LANE_TYPES` nor `CARD_PRODUCER_LANE_TYPES`, so promotion parks no live card '
      + 'off-screen, and the connection already lives in a node-keyed engine-side registry on '
      + 'GRAPH lifetime ($lib/audio/es9/bridge-owner) that was built for exactly this — the '
      + 'registry cameraInput had to invent is the thing this module already had. The body '
      + 'SUBSCRIBES rather than polling, because that registry deliberately keeps listeners '
      + 'outside its entries so a view may pre-date the connection. ⚠ It mounts no canvas '
      + 'element and must not grow one (the role predicates GREP RAW SOURCE and cannot tell code '
      + 'from a comment, so this sentence deliberately spells the tag out in words), and it '
      + 'declares no `face.rackStatus`: `maxInstances` is 1, so there is no second instance and '
      + 'no band to suppress — the CV-Buddy relationship runs the other way, with that module '
      + 'declaring rackStatus and this being the shared hardware it points at. ⚠ NO SCREEN '
      + 'SWITCH and NO WATCH MARK — the video-screen ruling runs over STRICT_FACES intersect '
      + 'video defs and this is `domain: audio`. Every text node is either a lamp CAPTION or '
      + 'instructional copy in the EMPTY state where no link exists.',
  },

  // ── VST BRIDGE — ONE body for TWO defs, and the first entry in this roster
  //    whose module declares NO PARAMS AT ALL ─────────────────────────────────
  //
  // `vstInstrument` and `vstFx` both declare `face.extension: 'vstBridge'`.
  // That is legal by construction — `shell-extensions.test.ts` requires every
  // discovered extension to be declared by AT LEAST ONE def — and it is the
  // honest shape rather than a shortcut: the two modules already share one
  // engine factory, one worklet, one transport and one legacy card body, so a
  // second copy of this surface would be a second place for it to drift.
  //
  // ⚠ THIS ROSTER IS KEYED BY EXTENSION ID, NOT BY MODULE TYPE, so a shared
  // extension is ONE entry and the deny-by-default sweep still holds in both
  // directions.
  vstBridge: {
    role: 'status-primitive',
    why:
      'the PLUGIN surface for the two vst-bridge cards: the runtime-enumerated plugin picker, '
      + 'its text filter, the mount / swap / unmount and native-editor gestures, the pre-connect '
      + 'hint, and THREE lamps — BRIDGE (the helper app answered), PLUGIN (`tone: warn` while a '
      + 'mount has failed; which plugin is live, what latency it reports, and whether its own '
      + 'state travels with the patch) and LOAD (`tone: warn`; the helper cannot keep up). '
      + '⚠ THE PICKER CANNOT BE A FACE CELL, for the reason midiclock and midiLane state above and '
      + 'one degree more sharply: its roster is the USER\'S INSTALLED AU LIBRARY, enumerated by a '
      + 'native helper over a localhost WebSocket, so it is neither a `ParamDef` nor an `options` '
      + 'roster (a fixed set known when the def is authored) AND it is EMPTY on every CI runner — '
      + 'faces-parity\'s selector branch asserts the roster offers more than one option and then '
      + 'picks a different one, so a selector cell here would fail deterministically forever. '
      + '⚠ THE TEXT FILTER IS NOT AN `entry` CELL EITHER, and the face-migration inventory called '
      + 'it "the typed entry", which is corrected in the same diff: `ShellEntryProbe` requires the '
      + 'observable to be a `node.data` key, and `node.data` rides the Y.Doc, so persisting a '
      + 'search box would sync one player\'s keystrokes to every collaborator and dirty the patch '
      + 'per keystroke — the exact hazard ShellPanelProbe\'s `text` note is written about. It is a '
      + 'private view setting and lives beside the picker it narrows. ⚠ MOUNT / SWAP / UNMOUNT / '
      + 'OPEN EDITOR fail a third and simpler test: all four exist ONLY while the helper is '
      + 'connected and a plugin is selected, while a ranked `action` cell must render '
      + 'unconditionally and pass `toBeEnabled()`. ⚠ CONNECT AND DISCONNECT ARE NOT DUPLICATED '
      + 'HERE: both are real ranked `action` cells, which is what puts the gesture on the LANE '
      + 'TILE, and a body carrying them too would be a second implementation of controls the face '
      + 'already owns. ⚠ THE LAMPS ARE WHERE THREE DELETED READOUT ROWS WENT, each a picture with '
      + 'its sentence in `aria-label`: BRIDGE replaces the seven-way state word and the round-trip '
      + 'time, with the narrowing stated in vst-status-model.ts (seven connection states onto two '
      + 'lamp states, mitigated by naming the exact failure in the detail — which matters most for '
      + '`busy` and `evicted`, since both are recoverable by the CONNECT the plate already offers '
      + 'and a bare dark lamp would read as broken); LOAD replaces the `in dB / out dB / load %` '
      + 'meter row; PLUGIN replaces the `latency … smp` figure, the mount-error line AND the '
      + 'persisted-state size. ⚠ THAT LAST ONE WAS A FOURTH LAMP AND THE DOCK WIDTH GATE PRICED '
      + 'IT OUT: 44 CSS px of empty plate against a 40 px ceiling, because a lamp\'s dot and its '
      + 'flex gaps are chrome `contentW` cannot see (it walks cell boxes and TEXT ranges) while '
      + '`bodyW`\'s `max-content` includes them — on a TWO-cell face the lamp row is the widest '
      + 'thing on the plate. Folding it is also the better home, since "this blob is too large, '
      + 'so the plugin returns EMPTY on the next load" is a fact ABOUT the mounted plugin, and a '
      + 'two-state lamp could not say it anyway (its dark half was ambiguous between "nothing '
      + 'mounted yet" and "too large"). vst-face-model.test.ts asserts in BOTH directions that '
      + 'the warning is still reachable on the surviving lamp — relocation and deletion look '
      + 'identical from a green run. This body also paints NO border, background or horizontal '
      + 'padding, for the same measured reason; stripped, the face sits at 33 px of slack, the '
      + 'PLATFORM FLOOR that moog911 / vca / wavetableVco / unityscalemathematik all sit at, so '
      + 'it contributes zero of its own. ⚠ THE '
      + 'MOUNTED PLUGIN NAME IS NOT REPRODUCED as a text node — the picker directly above already '
      + 'shows it as its own selected OPTION NAME, a permitted role, and a second copy would '
      + 'restate a control rather than inform. ⚠ IT NEEDS NO STATUS REGISTRY, unlike cameraInput: '
      + 'neither def is in `DOM_SOURCE_LANE_TYPES` or `CARD_PRODUCER_LANE_TYPES`, so promotion '
      + 'parks no live card off-screen, and every connection, ring and the whole persistence '
      + 'driver already live in node-keyed ENGINE-side registries on GRAPH lifetime '
      + '($lib/audio/vst/bridge-owner, createVstHandle). The body SUBSCRIBES rather than polling, '
      + 'because that registry deliberately keeps listeners outside its entries so a view may '
      + 'pre-date the connection. ⚠ It mounts no canvas element and must not grow one (the role '
      + 'predicates GREP RAW SOURCE and cannot tell code from a comment, so this sentence '
      + 'deliberately spells the tag out in words). ⚠ NO SCREEN SWITCH and NO WATCH MARK — the '
      + 'video-screen ruling runs over STRICT_FACES intersect video defs and both these defs are '
      + '`domain: audio`. Every text node is a lamp CAPTION, a control caption on its own button, '
      + 'an option NAME in the picker, or instructional copy in the EMPTY state where no session '
      + 'exists.',
  },

  // ── MIDI LANE — the THIRD binder body, and the one whose lamps carry the
  //    most deleted text ─────────────────────────────────────────────────────
  midiLane: {
    role: 'status-primitive',
    why:
      'the DEVICE BINDING strip for the per-channel instrument bus: the runtime-enumerated input '
      + 'picker, the pre-connect hint, the access-failure message, and four lamps — MIDI, NOTE, '
      + 'CC A, CC B. The picker is the ONE affordance on this module that cannot be a face cell, '
      + 'for the reason midiclock states one entry up: its roster lives on the engine handle '
      + 'behind `requestMIDIAccess()` and differs per machine, so it is neither a `ParamDef` nor '
      + 'an `options` roster, which is a fixed set known when the def is authored. ⚠ NONE of the '
      + 'ten ranked cells is duplicated here — CONNECT in particular is a real `action` cell, '
      + 'which is what puts the permission gesture on the LANE TILE rather than behind the dock. '
      + '⚠ THE LAMPS ARE WHERE THREE DELETED READOUTS WENT, and each is a picture with its '
      + 'sentence in `aria-label`: NOTE replaces the card\'s `NOTE`/`VEL` rows and is the only '
      + 'thing in the product that says this lane is RECEIVING (a lane on the wrong channel is '
      + 'silent, and so is a correct one between notes) — it binds to `heldCount`, a field added '
      + 'for it, because `lastNote` is LATCHED and a lamp bound to it would light once and never '
      + 'go dark; CC A and CC B replace the two bound-controller NUMBERS the card printed and say '
      + 'strictly more, since they also carry the value the tap is receiving and whether it is '
      + 'ARMED. ⚠ Unlike cameraInput this body needs no status registry: midiLane is in neither '
      + '`DOM_SOURCE_LANE_TYPES` nor `CARD_PRODUCER_LANE_TYPES`, so promotion parks no live card '
      + 'off-screen and the MIDI handler is installed engine-side through an identity-scoped '
      + 'claim in the factory — there is no second owner to coordinate with. ⚠ It mounts no '
      + 'canvas element and must not grow one (the role predicates GREP RAW SOURCE and cannot '
      + 'tell code from a comment, so this sentence deliberately spells the tag out in words), '
      + 'and it declares no `face.rackStatus`: this module is '
      + 'deliberately multi-instance, every lane is independent, and there is no shared resource '
      + 'and no primary. ⚠ NO SCREEN SWITCH and NO WATCH MARK — the video-screen ruling runs over '
      + 'STRICT_FACES intersect video defs and this is `domain: audio`. Every text node is an '
      + 'option NAME (the device\'s own name, the cameraInput precedent), a control caption, '
      + 'instructional copy in the EMPTY pre-connect state, or an ERROR that is absent whenever '
      + 'nothing is wrong.',
  },

  // ── TEMPOLOCK — the lamp-only status body (the es9 shape, smaller) ───────
  //
  // Two `StatusLed`s and NOTHING else: no picker, no button, no empty-state
  // copy. Like es9's entry, "no picker" is not a constraint being worked
  // around — the module binds no hardware and enumerates no roster; its one
  // setting (BAND) is a real ranked cell on the face. The body exists because
  // the module's product is a JUDGEMENT no ParamDef can carry.
  tempolock: {
    role: 'status-primitive',
    why:
      'the LOCK + BEAT lamps for the beat-tracking clock. LOCK is lit while the tracker is '
      + 'confidently locked to the incoming onset train; BEAT blinks on each emitted quarter-note '
      + 'pulse. ⚠ THE LAMPS ARE WHERE THE ONE REFUSED READOUT WENT: the tracked BPM is derived '
      + 'state — the exact shape the resting-text rulings deleted fleet-wide, and TIMELORDE\'s own '
      + 'face dropped its BPM footer under the same rulings — so the value lives on the LOCK '
      + 'lamp\'s detail (aria-label/title), built in the pure tempolock-status-model beside the '
      + 'body and unit-tested there. The three tracker modes produce three DIFFERENT detail '
      + 'sentences, because a dark LOCK lamp is ambiguous between "never had input" and "input '
      + 'went away mid-set" and those need different player responses (the cvBuddy ROUTED-lamp '
      + 'collapse argument, run in reverse). The late-tick skip COUNT rides the BEAT lamp\'s '
      + 'detail — countable, never painted (the cvBuddy LATE discipline). ⚠ IT POLLS '
      + '`read("state")` at 150 ms — the engine node owns the tracker on the scheduler clock, so '
      + 'no status registry is needed: tempolock is in neither DOM_SOURCE_LANE_TYPES nor '
      + 'CARD_PRODUCER_LANE_TYPES, promotion parks no live card off-screen, and the tracking '
      + 'survives every unmount by construction. ⚠ It mounts no canvas element and must not grow '
      + 'one (the role predicates GREP RAW SOURCE and cannot tell code from a comment, so this '
      + 'sentence spells the tag out in words). ⚠ NO SCREEN SWITCH and NO WATCH MARK: the '
      + 'video-screen ruling runs over STRICT_FACES intersect video defs and this is '
      + '`domain: audio`, and markWatched is a VideoEngine pull-set concept this module has no '
      + 'part in. At rest (fresh spawn, nothing patched) the tracker is cold and both lamps are '
      + 'dark, which is what makes the dock VRT scene deterministic. Every text node is a lamp '
      + 'CAPTION; there are exactly two.',
  },

  // ── MIDI-CV-BUDDY — the FIFTH binder body, and the one whose deleted readout
  //    needed a NEW ENGINE FIELD to survive ──────────────────────────────────
  //
  // ⚠ THE NOTE LAMP COULD NOT BIND TO WHAT THE CARD PAINTED, and that is the
  // interesting half. The card printed `NOTE C4` off `lastNote`, which is
  // LATCHED on purpose — the module keeps it after every key is released so a
  // downstream VCO holds its pitch through the gate's fall — so a lamp bound to
  // it would light on the first note of a session and never go dark, i.e. a
  // lamp that says nothing. `heldCount` was added to the card state for this,
  // exactly as midiLane added the same field for the same reason. Reading a
  // readout's value and moving it is not enough; the QUESTION the lamp answers
  // is different from the one the number answered, and it needs its own source.
  midiCvBuddy: {
    role: 'status-primitive',
    why:
      'the DEVICE BINDING for the mono MIDI-to-CV bridge: the runtime-enumerated input picker, '
      + 'the pre-connect hint, the access-failure message, and two lamps — MIDI and NOTE. The '
      + 'picker is the ONE affordance on this module that cannot be a face cell, for the reason '
      + 'midiclock states above: its roster lives on the engine handle behind '
      + '`requestMIDIAccess()` and differs per machine, so it is neither a `ParamDef` nor an '
      + '`options` roster, which is a fixed set known when the def is authored. ⚠ NONE of the '
      + 'four ranked cells is duplicated here — CONNECT in particular is a real `action` cell, '
      + 'which is what puts the permission gesture on the LANE TILE rather than behind the dock. '
      + '⚠ THE NOTE LAMP IS WHERE TWO DELETED READOUT ROWS WENT (`NOTE` and `VEL`), and it says '
      + 'strictly more than they did: its `detail` carries the note, the velocity AND how many '
      + 'keys are down, and the dark-but-connected branch names the note the PITCH jack is still '
      + 'LATCHED at, which is a real behaviour a player can be surprised by and which nothing '
      + 'else on the surface explains. It binds to `heldCount`, a field added for it, because '
      + '`lastNote` is latched and a lamp bound to it would light once and never go dark. It is '
      + 'also the only thing on the promoted surface that says this module is RECEIVING, which '
      + 'matters because the two ways it disappoints — nothing patched to the keyboard, and a '
      + 'channel filter aimed at a channel the keyboard is not sending on — are both perfectly '
      + 'silent and look identical to a correct module between notes. ⚠ Unlike cameraInput this '
      + 'body needs no status registry: midiCvBuddy is in neither `DOM_SOURCE_LANE_TYPES` nor '
      + '`CARD_PRODUCER_LANE_TYPES`, so promotion parks no live card off-screen and the MIDI '
      + 'handler is installed engine-side through an identity-scoped claim in the factory — '
      + 'there is no second owner to coordinate with. ⚠ It mounts no canvas element and must not '
      + 'grow one (the role predicates GREP RAW SOURCE and cannot tell code from a comment, so '
      + 'this sentence deliberately spells the tag out in words), and it declares no '
      + '`face.rackStatus`: this module is deliberately multi-instance, every instance binds its '
      + 'own device, and there is no shared resource and no primary. ⚠ NO SCREEN SWITCH and NO '
      + 'WATCH MARK — the video-screen ruling runs over STRICT_FACES intersect video defs and '
      + 'this is `domain: audio`. Every text node is an option NAME (the device\'s own name, the '
      + 'cameraInput precedent), a control caption, instructional copy in the EMPTY pre-connect '
      + 'state, or an ERROR that is absent whenever nothing is wrong.',
  },

  // ── MIDI-OUT-BUDDY — the SIXTH binder body, and the first whose deleted
  //    warning was carried by a COLOUR rather than by prose ──────────────────
  //
  // ⚠ THE CH-vs-LANE WARNING IS THE AFFORDANCE MOST AT RISK IN THIS PROMOTION.
  // The card outlined itself in `--cable-video` and painted a `CH n != LANE m`
  // badge whenever the module routed off its lane. Both halves are derived
  // state — the badge in text, the outline in colour — and a resting faceplate
  // may paint neither. Neither is dropped: `tone="warn"` carries "this is a
  // fault rather than a readiness", `lit` carries the divergence itself, and
  // the badge's own sentence including HOW to undo it is the `detail`, which
  // `StatusLed` puts in both `aria-label` and `title`.
  //
  // ⚠ AND THE VIOLET SPECIFICALLY IS NOT PORTED, DELIBERATELY. `--cable-video`
  // means CABLE DOMAIN everywhere else in the product; the card borrowed it as
  // "the only purple in the token set", which is the collision
  // `rear-direction.test.ts` already refuses on the rear rails (no
  // direction-qualified rule may assign a domain hue). The lamp's warn amber is
  // the app's own fault colour and says the same thing without spending a
  // domain hue on it.
  midiOutBuddy: {
    role: 'status-primitive',
    why:
      'the OUTPUT BINDING for the rack\'s only outward-facing module: the runtime-enumerated '
      + 'output-port picker, the pre-connect hint, the access-failure message, and three lamps — '
      + 'MIDI, SEND and LANE. The picker is the ONE affordance here that cannot be a face cell, '
      + 'for the reason midiclock states above: its roster lives on the engine handle behind '
      + '`requestMIDIAccess()` and differs per machine, so it is neither a `ParamDef` nor an '
      + '`options` roster. ⚠ NEITHER ranked cell is duplicated here — CONNECT is a real `action` '
      + 'cell, which is what puts the permission gesture on the LANE TILE. ⚠ THE SEND LAMP is '
      + 'where the card\'s `NOTE` row and its lit dot went, and unlike the sibling module\'s it '
      + 'needs no companion field: `activeNote` is the tracker\'s `soundingNote`, set on the Note '
      + 'On this module sent and cleared on the matching Note Off, so it really does follow the '
      + 'note. Its detail names the CHANNEL in every branch, because "nothing is happening" and '
      + '"everything is happening on a channel your synth is not listening to" are the two states '
      + 'this module is most often in and are otherwise indistinguishable. ⚠ THE LANE LAMP is the '
      + 'card\'s violet CH-vs-LANE badge, as `tone="warn"` plus a detail that names both numbers '
      + 'and how to reconcile them; the un-diverged branches are not filler, because "follows its '
      + 'lane" and "has no lane" are two different facts a player acts on differently and a bare '
      + 'dark lamp cannot tell them apart. ⚠ Unlike cameraInput this body needs no status '
      + 'registry: midiOutBuddy is in neither `DOM_SOURCE_LANE_TYPES` nor '
      + '`CARD_PRODUCER_LANE_TYPES`, so promotion parks no live card off-screen and the note '
      + 'sender lives on the engine handle. ⚠ It mounts no canvas element and must not grow one '
      + '(the role predicates GREP RAW SOURCE and cannot tell code from a comment, so this '
      + 'sentence deliberately spells the tag out in words), and it declares no `face.rackStatus` '
      + '— every instance binds its own output port and none is a property of another. ⚠ NO '
      + 'SCREEN SWITCH and NO WATCH MARK: the video-screen ruling runs over STRICT_FACES '
      + 'intersect video defs and this is `domain: audio`. Every text node is an option NAME (the '
      + 'port\'s own name), a control caption, instructional copy in the EMPTY pre-connect state, '
      + 'or an ERROR that is absent whenever nothing is wrong.',
  },

  // ── LAUNCHPAD CONTROL — the second BINDER, and the body whose defining
  //    property is what it REFUSES to draw ───────────────────────────────────
  //
  // ⚠ BOTH `status-primitive` AND `control-grid` HOLD OF THIS SOURCE (it
  // imports StatusLed, it sets aria-label, and it mounts no canvas), and the
  // roles are not mutually exclusive by construction — the predicates are
  // ordered by the canvas test, not partitioned. `status-primitive` is the
  // honest one: `control-grid`'s own arrival note defines it as "a table of
  // clickable cross-points … the surface the module is OPERATED from", and this
  // is a device-status panel with three gestures on it, not a table. Declaring
  // `control-grid` here would dilute the role matrixMix added for a reason.
  launchpadControl: {
    role: 'status-primitive',
    why:
      'the LAUNCHPAD BINDING panel: the BIND / UNBIND control, the four-role single-unit view '
      + 'segment, the hardware and permission errors, the transient handshake instruction, and the '
      + 'LINK / CLIP lamps. ⚠ IT MOUNTS NO CANVAS AND MUST NOT GROW ONE. The 8x8 pad matrix this '
      + 'module drives is on the HARDWARE and is deliberately not mirrored: nothing in the app has '
      + 'ever painted it, so nothing loses a surface by its absence, and a half-fidelity mirror '
      + 'invented on a module PR would become the fleet\'s answer to "show me the device" by '
      + 'accident of being first. The firmware-accurate colour language already lives at '
      + '/docs/modules/launchpadControlLeft. ⚠ ALL PAINTED TEXT IS A CONTROL CAPTION, AN OPTION '
      + 'NAME, AN ERROR OR EMPTY-STATE COPY: the BIND caption (which names the action it will '
      + 'perform, and is why that control is not a cell — ShellActionCell.label is a plain '
      + 'string), the four role names GRID/CLIP/ARR/CTRL, the four hardware/permission error '
      + 'branches, one empty-state line replaced by the BIND control the moment a clip-player '
      + 'exists, and the pairing instruction that is reachable only mid-handshake and therefore '
      + 'never at rest. No value, no measurement, no state word. ⚠ THE CARD\'S NINE-BRANCH STATUS '
      + 'LINE IS WHAT THESE LAMPS ABSORBED, and the finding that lost its painted surface is named '
      + 'rather than allowed to lapse: WHICH clip-player node the pair drives was printed in the '
      + 'lane and is now the CLIP lamp\'s aria-label in the dock — on a rack with two clip-players '
      + 'that id is the only thing distinguishing them. Every string the surface can produce, '
      + 'painted or not, is decided in launchpad-binder-status-model.ts where a unit test reads '
      + 'them. ⚠ PAIR AND CONNECT ARE NOT HERE, deliberately: both are ranked action cells, which '
      + 'is what puts them on the lane tile at all. ⚠ NO SCREEN SWITCH AND NO WATCH MARK: the '
      + 'video-screen ruling runs over STRICT_FACES INTERSECT video defs and this is domain meta.',
  },

  // ── STATUS — the FIRST body whose subject is not a picture (midiclock above
  // is the second; this line used to say "the one", and it stopped being true
  // the moment a second binder arrived).
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
  // ── SYNESTHESIA (2026-08-24) — the roster's second AUDIO METER ────────────
  //
  // TEXT ON THE SURFACE, exhaustively: the SCREEN button's own caption. Nothing
  // else — the meters are bars, and `drawVuMeters` paints no numerals, no scale
  // and no axis labels into either canvas (it emits `fillRect` and `fillStyle`
  // and nothing else; the module's own face-model test reads the whole op
  // stream). ⚠ NOTHING HAD TO BE REMOVED ON PROMOTION EITHER: unlike scope's
  // `PITCH 440.0 Hz | NOTE A4` row, `SynesthesiaCard` printed no readout at all,
  // so there is no deleted finding whose surface lapsed here.
  //
  // ⚠ THE MEASUREMENT IS ON `aria-label`, WHICH IS THIS ENTRY'S ONE SUBTLETY.
  // Eight band levels drawn as bars are unreadable to a screen reader and
  // unassertable to a spec, so each canvas carries a `role="img"` name listing
  // its four levels — AND naming what the four lanes currently ARE, which is the
  // one fact the picture genuinely cannot show (in VIDEO mode column 0 is RED,
  // not bass). That name is never also a text node; `synesthesia-face-model`
  // asserts both halves, since the `control-grid` leg below does not run on a
  // `picture`.
  synesthesia: {
    role: 'picture',
    why:
      'the DUAL VU WALL — both copies\' four band meters, 10 segments each, drawn through the '
      + 'module\'s own `drawVuMeters` from the `read(\'snapshot\')` levels the worklet posts — plus '
      + 'the SCREEN switch. ⚠ THE PICTURE IS THE PRODUCT ARGUMENT ON THIS MODULE: twenty-two '
      + 'controls all balance an ANALYSIS, and "which quarter of this signal is loud" is not '
      + 'answerable from any dial reading, so a faced synesthesia without this slot would be '
      + 'twenty-two ways to adjust something invisible. ⚠ IT IS A READER, NOT A PRODUCER, and '
      + 'that distinction is load-bearing rather than descriptive: synesthesia is in '
      + 'CARD_PRODUCER_LANE_TYPES because its CARD runs the VIDEO-mode `video_levels_a/_b` pump, '
      + 'which lives nowhere else — so this body must never grow a second writer and the module '
      + 'must stay OUT of FACE_MOUNTS_PRODUCER, or opening the dock would drop the headless host '
      + 'and freeze VIDEO mode (the timelorde shape). ⚠ NO WATCH MARK: markWatched is a '
      + 'VideoEngine pull-set concept, and these levels come from an AudioWorklet the module\'s '
      + 'own muted keep-alive gain keeps processing regardless — there is no pull set to fall out '
      + 'of, so SCREEN OFF skips only the paint (#2015).',
  },
  // ── PUSH 2 CONTROL (2026-08-25) — the roster's THIRD meta body, and the only
  //    PICTURE in it that is a REPLICA OF A PHYSICAL OBJECT ────────────────────
  //
  // ⚠ THIS IS THE FLEET'S HARDEST IN-CANVAS-TEXT CASE AND ALSO ITS CLEAREST,
  // which is why the entry argues it rather than asserting it. The canvas is
  // 960×160 of names, bar graphs and FORMATTED NUMERIC READOUTS — under a
  // literal reading of the resting-text ruling, a wall of refused text. The
  // wave-5 games ruling already settled the shape ("pixels the MODULE renders
  // into its OWN surface are the module's artwork, not the face's chrome"), and
  // every prior instance was about pixels a module CHOSE to draw. These are a
  // byte-accurate copy of an op list already on its way to a physical OLED over
  // WebUSB. So deleting them would not remove a readout from the PRODUCT — the
  // hardware still paints it — it would only make the on-screen copy DISAGREE
  // with the panel, which is the single property the shared-seam design exists
  // to make impossible. A "compact" half-strip replica is "there but hidden"
  // applied to a picture of a real object, and additionally wrong.
  //
  // ⚠ NO GATE SEES ANY OF THAT. `face-resting-text-source` reads `ModuleFace`
  // FIELDS and is blind to a body's markup by its own admission, and canvas
  // pixels are invisible to every source gate in the tree. The enforcement is
  // the dock VRT baseline and a human reading it — which is exactly why this
  // roster requires the body to write down what its canvas draws.
  push2Control: {
    role: 'picture',
    why:
      'a PIXEL-EXACT REPLICA of the Push 2\'s physical 960×160 OLED, painted by '
      + '`paintPushOps(ctx, pushDisplayOps())` — the SAME op list already on its way to the '
      + 'hardware over WebUSB, so the plate and the panel cannot disagree about what is on screen '
      + '(hold the device\'s LEGEND button and this picture changes too) — plus the eight LANE '
      + 'buttons, the card ‹ › flip, the four-role view segment, BIND/UNBIND, the separate WebUSB '
      + 'display permission and the PUSH/SCREEN/BOUND lamps. ⚠ THE CANVAS PAINTS ANOTHER NODE\'S '
      + 'CONTROLS: eight strips of name + bar + formatted readout belonging to whichever module '
      + 'the selected lane is focused on, which is why this module\'s VRT exemption called its '
      + 'card patch-dependent — and why its VRT scene spawns it ALONE, so the lane resolves to '
      + 'this module itself and the picture is a function of code. Under the resting-text ruling '
      + 'those readouts are the MODULE\'S ARTWORK rather than the face\'s chrome, and here more '
      + 'strongly than anywhere else in the fleet, because deleting them would not remove a '
      + 'readout from the product (the hardware still paints it) but WOULD break the one-seam '
      + 'guarantee. ⚠ IT IS A 2-D CONTEXT AND MUST STAY ONE: WebGL attest basis membership is '
      + 'derived mechanically by walking lib/ui/modules for a GL context request, so a shader '
      + 'here would enrol a meta module in the GPU attest for a picture that is eight rectangles '
      + 'and some text. ⚠ NO STATE HERE IS IN THE Y.DOC — `mutateNode` and `setNodeParam` both '
      + 'appear ZERO times in the push2 layer; the selected lane is localStorage and the binding, '
      + 'focus and active view are module-level runes, deliberately, so two collaborators each '
      + 'drive their own Push on their own lane. That is ALSO why the lane select is a body '
      + 'control and not a selector cell: ModuleShell re-projects a cell only on `nodeVersion`, so '
      + 'a cell would never notice the eight buttons ON THE HARDWARE moving it. ⚠ IT ALSO IMPORTS '
      + 'StatusLed, so the status-primitive predicate would hold but for the canvas; the declared '
      + 'role is `picture` because the replica IS the surface. ⚠ ALL PAINTED DOM TEXT IS A CAPTION '
      + 'OR AN OPTION NAME: the eight lane digits, the four view names, ‹ ›, the BIND caption and '
      + '"Connect display" — plus errors that are absent whenever nothing is wrong and ONE empty '
      + 'state ("add a clip-player to drive") that is replaced by BIND the moment one exists. The '
      + 'card\'s "Not connected." and its "Driving clip-player {id} — {VIEW} view." sentence are '
      + 'DELETED; the finding they carried (WHICH clip-player, on a rack that can hold several) '
      + 'is the BOUND lamp\'s aria-label, and the flip\'s deleted i/N badge is the flip group\'s '
      + 'accessible name. Every string the surface can produce, painted or not, is decided in '
      + 'push2-binder-status-model.ts where a unit test reads them. ⚠ CONNECT PUSH 2 IS NOT HERE, '
      + 'deliberately: it is the ranked action cell, which is what puts it on the lane tile at '
      + 'all. ⚠ NO SCREEN SWITCH AND NO WATCH MARK: the video-screen ruling runs over STRICT_FACES '
      + 'INTERSECT video defs and this is domain meta — and the "screen" this module has is a '
      + 'physical panel over WebUSB, not a VideoEngine preview, so the ruling\'s subject does not '
      + 'exist here in either sense.',
  },

  // ── TEXTMARQUEE (2026-08-31) — the roster's first DOCUMENT EDITOR ─────────
  //
  // ⚠ EVERY OTHER `picture` ENTRY IN THIS ROSTER IS ABOUT A PREVIEW BEING
  // RESCUED, OR (blood) A BOOT. This one is about a WRITER. textmarquee's four
  // params only MOVE the ribbon; what it SAYS is `node.data.richText`, and the
  // only affordance in the tree that could write it was the card promotion
  // stops the shipping shell rendering. A body that mounted the preview and
  // forgot the editor would satisfy this gate's predicate perfectly and ship a
  // module whose text can never be changed again.
  //
  // ⚠ THE TEXT AUDIT IS UNUSUALLY EASY HERE AND IS STATED ANYWAY: the card
  // painted NO derived value at all — no size number beside the slider, no
  // colour hex, no character count. So this promotion deletes ZERO resting
  // readouts, which is worth recording precisely because every other row in
  // the face program deleted at least one.
  textmarquee: { role: 'picture', why: 'the RICH-TEXT EDITOR that is this module — a `contenteditable` document plus its toolbar (align left/centre/right, bold, italic, underline, the per-selection TEXT colour, a 12-entry FONT family picker and the SIZE range), the layer BACKGROUND swatch, the live OUT preview and the SCREEN switch. ⚠ THIS BODY IS NOT A PREVIEW BEING RESCUED, IT IS THE MODULE\'S ONLY WRITER: all four params (ScrlX/ScrlY/PosX/PosY) move the ribbon and none of them says what it READS, which is node.data.richText — thirteen of the card\'s fifteen data-testids are that writer and ZERO of them are expressible as a face cell, because they act on a live DOM Selection, or are `<input type="color">`, or are the document itself. `ShellEntryCell` (#1509) is real and shipped and is emphatically NOT the seam: it parses ONE SCALAR per cell. ⚠ AND RE-HOSTING THE EDITOR IS A SEMANTIC CHANGE UNLESS IT IS STOPPED — the sharpest finding in this promotion. `serializeEditor` reads getComputedStyle, so the editor\'s CASCADE is part of the persisted document: the card\'s `.editor` rule set color:#ffffff and white-space:pre-wrap, and `.dock-ext-body` sets neither and inherits the faceplate\'s var(--text,#eef1f5). A body that copied the markup would have stamped #eef1f5 onto every untouched run, `bold:true` under any ancestor at font-weight>=600 and `center` under any centred ancestor — written into Y.Doc-persisted data, synced to collaborators, rasterized into the video texture and read back by the still-live legacy card. The serializer is therefore extracted to $lib/graph/textmarquee-editor (outside lib/video/**, so it costs no attest) and BOTH surfaces stamp EDITOR_BASE_STYLE on the element explicitly. ⚠ IT IS NOT THE PRODUCER: the rasterize-and-push half moved to $lib/ui/media/extras-producers on NODE lifetime in #1720, so a saved rack shows your text with no UI mounted and textmarquee stays correctly out of CARD_PRODUCER_LANE_TYPES; this body writes the MODEL and blits. ⚠ SCREEN OFF KEEPS THE WATCH MARK, on acidwarp\'s argument in its strongest form: textmarquee is a pure SOURCE with no video input, so a lapsed mark would not stall a preview of somebody else\'s picture, it would MUTE the generator every downstream node is sampling. ⚠ WHAT IT PAINTS AS TEXT IS ALL CONTROL CAPTIONS — the six toolbar glyphs, the TEXT / FONT / SIZE / BG swatch labels, the twelve font NAMES inside the select that chooses them, and SCREEN ON/OFF — plus one empty-state badge, TYPE TEXT…, which names the surface\'s own condition (the samsloop NO SAMPLE LOADED shape) and tells the player that the "textmarquee" word in the picture is the factory placeholder rather than their document. ⚠ ZERO RESTING READOUTS WERE DELETED because the card painted none: no value, no measurement, not even a number beside the SIZE slider. ⚠ IT MUST STAY 2-D: textmarquee.ts is in the WebGL attest basis and this file is deliberately outside it, but resolveWebglBasis() step (2) sweeps lib/ui/modules/**/*.svelte by CONTENT, so a getContext("webgl") here would enrol it and put every future face edit on the real-GPU attest critical path.' },
};

/**
 * Does this body put a CANVAS on screen — directly, or through a component it
 * mounts?
 *
 * ⚠ THE SECOND CASE IS NOT A LOOPHOLE, IT IS THE ARCHITECTURE THE REPO WANTS.
 * `wavesculpt` is the first body whose picture comes from a SHARED surface
 * component (`WavesculptVizSurface`), mounted here and by the legacy card, so
 * that the faceplate and the card are two mounts of ONE renderer instead of two
 * renderers drifting against one DSP — the shape `cube` established. A
 * `/<canvas/` grep of the body alone reads that correct arrangement as "paints
 * nothing", which would push authors toward re-drawing the picture locally: the
 * exact drift this file's neighbours exist to prevent.
 *
 * So the check follows the mount ONE level, and only for components the body
 * actually RENDERS (`<Name`), imported by relative path from the module's own
 * directory. It is deliberately not transitive and deliberately not a
 * whole-tree search — a body that mounts something that mounts something is
 * far enough from its own picture that the claim should be written down again.
 */
/** Escape a captured source expression for use inside a RegExp. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function paintsCanvas(src: string, extId: string): boolean {
  if (/<canvas/.test(src)) return true;
  for (const m of src.matchAll(/import\s+([A-Z][A-Za-z0-9_]*)\s+from\s+'\.\/([^']+\.svelte)'/g)) {
    const [, name, rel] = m;
    // MOUNTED, not merely imported — an unused import paints nothing.
    if (!new RegExp(`<${name}[\\s/>]`).test(src)) continue;
    const file = resolve(MODULES_DIR, extId, rel!);
    if (existsSync(file) && /<canvas/.test(read(file))) return true;
  }
  return false;
}

/** The mechanical predicate each role claims about its own source. */
const ROLE_PREDICATE: Readonly<
  Record<BodyRole, { holds: (src: string, extId: string) => boolean; what: string }>
> = {
  picture: {
    holds: (src, extId) => paintsCanvas(src, extId),
    what:
      'mounts a <canvas>, directly or through a surface component it renders — a body claiming '
      + 'to be a PICTURE must have one',
  },
  'status-primitive': {
    // ⚠ The negative half follows the mount TOO. Before it did not, so a status
    // body could have grown a canvas by mounting one and stayed green — the
    // blind spot this role exists to leave open would have reopened silently.
    holds: (src, extId) => /StatusLed/.test(src) && !paintsCanvas(src, extId),
    what:
      'imports StatusLed and mounts NO <canvas>, directly or through a component it renders — a '
      + 'status body paints its measurements through the primitive, and a canvas would put it '
      + 'back in the blind spot this role exists to leave',
  },
  // ── THE THIRD ROLE, ADDED BY matrixMix (bespoke wave 4) ───────────────
  //
  // ⚠ IT EXISTS BECAUSE THE GATE REFUSED A BODY IT WAS RIGHT TO REFUSE, which
  // is worth stating because "the gate went red so I widened it" is usually the
  // wrong move. Both shipped predicates DENIED matrixMix's `fullViewBody`, and
  // both denials were correct: it mounts no `<canvas>` (so it is not a PICTURE)
  // and imports no `StatusLed` (so it is not a STATUS-PRIMITIVE surface). It is
  // a third thing the roster had not met — a DOM CONTROL GRID, a table of
  // clickable cross-points that is neither a preview of something nor a
  // measurement of something, but the surface the module is operated FROM.
  //
  // Mislabelling it `picture` would have meant weakening the picture predicate
  // to accept a body with no canvas, which is the one change that would let a
  // genuine picture-body skip its own check. The role is the honest repair.
  //
  // ⚠ THE PREDICATE IS THE RULING'S OWN MECHANISM, NOT A RUBBER STAMP. A grid
  // like this has exactly one text-shaped hazard: the sentence that says what a
  // cell MEANS. `aria-label=` is where the resting-text ruling puts that class
  // — "speakable and assertable but unpainted" — so a body claiming this role
  // must actually be setting accessible names, and must not have quietly become
  // a picture. The sharper half (that the sentence is NOT also painted as a text
  // node) is its own permanent leg below, because it is the failure this role
  // would otherwise hide.
  'control-grid': {
    holds: (src, extId) => /aria-label=/.test(src) && !paintsCanvas(src, extId),
    what:
      'sets aria-label on what it paints and mounts NO <canvas>, directly or through a component '
      + 'it renders — a control grid carries its MEANING in the accessible name, which is where '
      + 'the resting-text ruling puts a sentence that must be speakable and unpainted; a canvas '
      + 'would make it a picture, and no aria-label would mean the meaning went somewhere else',
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
      if (!pred.holds(src, id)) offenders.push(`${id}: declared '${rule.role}' but does not ${pred.what}`);
    }
    expect(offenders, 'a declared body role is not true of the body').toEqual([]);
  });

  it('every entry carries a REASON, not a shrug', () => {
    const thin = Object.entries(EXTENSION_BODY_ROLES)
      .filter(([, r]) => r.why.trim().length < 40)
      .map(([k]) => k);
    expect(thin, 'an entry without a stated reason is a suppression').toEqual([]);
  });

  it('EVERY DEFINED ROLE IS USED, and every used role is defined — no role is a decoration', () => {
    // A roster where every entry said `picture` would be a rename of the blind
    // spot rather than a narrowing of it, and the other predicates would never
    // run. This used to assert a hand-typed PAIR of role names, which went stale
    // the moment a third surface kind arrived (matrixMix's control grid) — so it
    // is now a SET IDENTITY between the roles the type defines and the roles the
    // roster actually uses, asserted in both directions. A role added to the
    // union and never adopted is a predicate nothing exercises; a role used by
    // an entry and absent from the union does not compile.
    const used = new Set(Object.values(EXTENSION_BODY_ROLES).map((r) => r.role));
    const defined = new Set(Object.keys(ROLE_PREDICATE) as BodyRole[]);
    expect(
      [...defined].filter((r) => !used.has(r)).sort(),
      'role(s) with a predicate that no body claims — an unexercised predicate proves nothing. '
        + 'Adopt it or delete it.',
    ).toEqual([]);
    expect(
      [...used].filter((r) => !defined.has(r)).sort(),
      'role(s) claimed by an entry with no predicate to check them',
    ).toEqual([]);
  });

  it('⚠ A CONTROL GRID\'S SENTENCE IS SPEAKABLE, NOT PAINTED', () => {
    // ── THE LEG THE `control-grid` ROLE OWES ──────────────────────────
    //
    // The role's own predicate proves the body sets accessible names and owns no
    // canvas. That is necessary and not sufficient: a body could set
    // `aria-label={cellTitle(...)}` AND ALSO render `{cellTitle(...)}` as a text
    // node, which is the resting-text violation wearing the ruling's own
    // mechanism as a disguise — and it is precisely the mistake a well-meaning
    // author makes ("the screen reader gets it, so the sighted user should too").
    //
    // So: whatever expression is bound to `aria-label={…}` must not also appear
    // in a bare text mustache. Source-level, because no runtime gate sees it —
    // `face-resting-text-source` reads FACE FIELDS and is blind to a body's
    // markup by its own admission.
    const offenders: string[] = [];
    for (const [id, rule] of Object.entries(EXTENSION_BODY_ROLES)) {
      if (rule.role !== 'control-grid') continue;
      const src = fullViewBodySource(id);
      if (src === null) continue; // the ANCHOR leg owns this failure
      for (const m of src.matchAll(/aria-label=\{([^}]+)\}/g)) {
        const expr = m[1]!.trim();
        // The same expression rendered as CONTENT: `>{expr}<` or `>{expr}</`.
        if (new RegExp(`>\\s*\\{\\s*${escapeRe(expr)}\\s*\\}`).test(src)) {
          offenders.push(
            `${id}: the accessible name \`${expr}\` is ALSO painted as a text node. The sentence `
              + 'a cell needs is speakable and unpainted — putting it in both places is the '
              + 'resting-text violation using the ruling\'s own mechanism as cover.',
          );
        }
      }
    }
    expect(offenders, 'a control grid paints its own accessible name').toEqual([]);
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
    expect(ROLE_PREDICATE.picture.holds(pic!, 'videoOut')).toBe(true);
    expect(
      ROLE_PREDICATE['status-primitive'].holds(pic!, 'videoOut'),
      'a canvas preview must NOT satisfy the status-primitive predicate',
    ).toBe(false);
    expect(ROLE_PREDICATE['status-primitive'].holds(real!, 'cvBuddy')).toBe(true);
    expect(
      ROLE_PREDICATE.picture.holds(real!, 'cvBuddy'),
      'the status body must NOT satisfy the picture predicate',
    ).toBe(false);

    // ⚠ AND THE MOUNT-FOLLOWING BRANCH DISCRIMINATES TOO, which the two bodies
    // above cannot show: videoOut owns its canvas directly and cvBuddy owns
    // none, so neither exercises the indirection wavesculpt introduced. A body
    // that mounts a canvas-bearing component IS a picture; one that merely
    // IMPORTS it is not, because an unused import paints nothing.
    const viaMount = fullViewBodySource('wavesculpt');
    expect(viaMount, 'wavesculpt fullViewBody source').not.toBeNull();
    expect(/<canvas/.test(viaMount!), 'the body owns no canvas of its own').toBe(false);
    expect(ROLE_PREDICATE.picture.holds(viaMount!, 'wavesculpt')).toBe(true);
    const importedNotMounted = viaMount!.replace(/<WavesculptVizSurface[^>]*\/>/, '');
    expect(
      ROLE_PREDICATE.picture.holds(importedNotMounted, 'wavesculpt'),
      'importing a canvas-bearing component without RENDERING it must not satisfy picture',
    ).toBe(false);

    // ⚠ AND THE THIRD ROLE DISCRIMINATES AGAINST BOTH OF THE OTHERS. Adding a
    // role is only a narrowing of the blind spot if the new predicate refuses
    // the bodies the old ones accept and vice versa; a role that everything
    // satisfies is a rename. All four directions, on real source.
    const grid = fullViewBodySource('matrixmix');
    expect(grid, 'matrixmix fullViewBody source').not.toBeNull();
    expect(ROLE_PREDICATE['control-grid'].holds(grid!, 'matrixmix')).toBe(true);
    expect(
      ROLE_PREDICATE.picture.holds(grid!, 'matrixmix'),
      'a DOM control grid must NOT satisfy the picture predicate — it mounts no canvas',
    ).toBe(false);
    expect(
      ROLE_PREDICATE['status-primitive'].holds(grid!, 'matrixmix'),
      'and must NOT satisfy status-primitive — it routes no measurement through StatusLed',
    ).toBe(false);
    expect(
      ROLE_PREDICATE['control-grid'].holds(pic!, 'videoOut'),
      'a canvas preview must NOT satisfy control-grid, whatever aria it sets',
    ).toBe(false);
    // …and the aria half of the predicate is load-bearing, not decorative: strip
    // the accessible names and the claim fails. Without this, `control-grid`
    // would be "any body with no canvas", which is most of the tree.
    const gridNoAria = grid!.replace(/aria-label=/g, 'data-was-aria=');
    expect(
      ROLE_PREDICATE['control-grid'].holds(gridNoAria, 'matrixmix'),
      'a body with no canvas AND no accessible names is not a control grid — its meaning went '
        + 'somewhere this gate cannot see',
    ).toBe(false);
  });
});
