// packages/web/src/lib/ui/workflow/face-monitor-source.test.ts
//
// THE #2009 / #1865 CLOSE — MONITOR MODE, the "hide the controls and watch the
// picture" affordance, cannot be silently deleted by a promotion again.
//
// ── THE DEFECT ─────────────────────────────────────────────────────────────
//
// `node.data.hideControls` turns a video module into a resizable monitor. Five
// modules carried it before their faces, and it is NOT a `ParamDef`, so a
// `FaceReadoutValue`
// cannot see it, `contract-lock` cannot see it, and `module-face-lint`'s
// completeness sweep — which enumerates params, declared families and numbered
// legends — cannot see it either. #1865 measured the consequence: "a face over
// any of those modules silently removes a documented, user-facing capability",
// and every def-reading gate stays green while it happens.
//
// On `ruttetra` it is worse than silent, because the def's own `docs` ADVERTISE
// the gesture in the player's words. Promoting without a home for it ships
// documentation describing a control that does not exist — and no def-reading
// gate can catch that, since each reads the same def that tells the lie.
//
// ── ⚠ TWO CORRECTIONS THIS GATE ENCODES ────────────────────────────────────
//
// 1. #1865 proposed that the SCREEN ON/OFF ruling "subsumes `hideControls`".
//    It does not, and the two are checked separately here and in
//    `video-face-screen-source.test.ts` for that reason. SCREEN OFF hides the
//    PICTURE and keeps the controls; MONITOR hides the CONTROLS and keeps the
//    picture. They are opposite directions of one question, and a face wanting
//    one usually wants both. A gate that accepted a SCREEN switch as proof of
//    a monitor would be a gate certifying the absence it was written to find.
//
// 2. #2009 nominated the `editorSurface` extension slot as the home. It is not
//    one: that slot is specced for "controls that are not cell-shaped at all"
//    and is a STATIC structural choice, while monitor mode is a TOGGLE over
//    bands whose controls are perfectly ordinary. `editorSurface` remains
//    UNWIRED, and `shell-extensions.test.ts` still refuses an extension that
//    exports it — asserted below, so this file cannot drift from that.
//
// ── THE SHAPE OF THE CHECK ─────────────────────────────────────────────────
//
// DENY BY DEFAULT, in BOTH directions, because either alone is blind:
//
//   FORWARD  a face that DECLARES `monitor` must own a `fullViewBody` that can
//            actually drive it (reads the key, writes the key, has a button).
//            Without this, `monitor` is a declaration with no way to reach it.
//   INVERSE  a FACED module that still mounted `hideControls` on an un-migrated
//            surface had to DECLARE `monitor`. That was the half that caught the
//            next
//            promotion — `monoglitch`, `milkdrop`, `reshaper`, `graphicEq` —
//            and it is the one #1865 actually asked for. A named exemption is
//            allowed and must carry an argument.
//
// MEMBERSHIP IS DERIVED, never listed: the subject is "every registered def
// whose conventionally-resolved card source mounts `hideControls`", read off
// the tree. So a sixth card growing the affordance is in scope the moment it
// exists, and a card that loses it drops out without anyone editing this file.
//
// ── ⚠ WHAT THIS GATE STRUCTURALLY CANNOT SEE ───────────────────────────────
//
//   * IT READS SOURCE, NOT A RENDER. It cannot tell you the bands actually
//     disappear, that the button is visible, or that the picture survives —
//     only that the declaration, the toggle and the shell's guard all exist.
//     The render half is `video-hide-controls.spec.ts`'s faced leg, and the
//     look is the dock VRT baseline's.
//   * IT CANNOT PROVE THE GUARDS WRAP THE RIGHT REGIONS. Leg 3 asserts
//     ModuleShell calls `faceMonitorPlan` and guards two regions on
//     `!monitorPlan.bandsHidden`; a refactor that moved a guard onto the wrong
//     block would still pass here. Again: the e2e leg is what sees that.
//   * IT CANNOT SEE A CARD THAT HIDES CONTROLS BY ANOTHER SPELLING. The
//     predicate is the literal `hideControls` key, which is what makes the
//     population derivable at all. A module inventing `collapseKnobs` is
//     invisible here — and would also be a second truth for one idea, which is
//     the thing the shared-key argument below exists to prevent.
//   * IT SAYS NOTHING ABOUT UN-FACED MODULES. Their card still renders on both
//     surfaces, so nothing is lost yet; the inverse leg arms itself the moment
//     the module joins STRICT_FACES, which is exactly when the loss would
//     happen.

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripSourceComments } from '$lib/source-guards/strip-source-comments';
import { listModuleDefs } from '$lib/audio/module-registry';
import { listVideoModuleDefs } from '$lib/video/module-registry';
import { listMetaModuleDefs } from '$lib/meta/module-registry';
import { STRICT_FACES } from './strict-faces';
import { WIRED_SHELL_EXTENSION_SLOTS } from './shell-extensions';
import '$lib/audio/modules';
import '$lib/video/modules';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULES_DIR = resolve(HERE, '../modules');
const SHELL = resolve(MODULES_DIR, 'ModuleShell.svelte');

/** The persisted key. ONE spelling across every surface, deliberately — a rack
 *  saved before a promotion already carries it, and
 *  reading a different key on the face would silently forget every monitor a
 *  player had open. */
const KEY = 'hideControls';

interface DefLike {
  type: string;
  face?: { extension?: string; monitor?: { why: string } };
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

// ⚠ THE INVERSE HALF OF THIS GATE RETIRED WITH THE SURFACES IT READ, and it is
// worth writing down rather than quietly deleting, because it was the half that
// caught the NEXT promotion rather than the current one.
//
// It resolved each def's un-migrated surface by convention and derived the
// population that mounted `hideControls` off the TREE — no roster to go stale.
// Three legs rested on it:
//
//   * "a FACED module that still mounts hideControls declares `monitor`" — the
//     #1865 shape: promotion stops that surface rendering, so the affordance is
//     deleted by the very change meant to keep it, invisibly, because it is not
//     a ParamDef.
//   * "every exemption still names a faced module that mounts the monitor" —
//     the anchoring on NO_MONITOR_MODE, which is EMPTY today.
//   * "the resolver DISCRIMINATES" — its own instrument control, with ruttetra
//     as the positive case and adsr as the negative.
//
// ⚠ THE CLAIM IS NOT WEAKENED, IT IS FINISHED. That leg was a MIGRATION check:
// its subject is "an affordance an un-migrated surface has and a face does not
// yet", and it can only fire while such a surface exists to compare against.
// There is no before-state left to lose an affordance from — every module IS its
// face. NAMED, so nobody reads its absence as an oversight: the
// migration-era comparison has no successor, and what remains is the FORWARD
// direction (a declared monitor must be reachable and the shell must really
// suppress on it), which is what protects the affordance from here on.

/** The component file a `shell-extension.ts` names for its fullViewBody slot.
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
  const file = resolve(MODULES_DIR, extId, imported[1]);
  return existsSync(file) ? read(file) : null;
}

function defsDeclaringMonitor(): DefLike[] {
  return allDefs().filter((d) => !!d.face?.monitor);
}

/**
 * FACED modules that carried `hideControls` before their face and legitimately
 * do NOT carry monitor mode onto it.
 *
 * Each entry is a `(type, why)` pair. EMPTY TODAY, and that is the point: the
 * rule holds with no carve-outs, so adding one is a visible decision rather
 * than a quiet default. #1865 says an exemption is an acceptable outcome —
 * *"A written exemption with an argument is an acceptable STOP 2 outcome;
 * silence is not"* — and this is where the argument goes.
 */
const NO_MONITOR_MODE: readonly { type: string; why: string }[] = [];

describe('#2009 — MONITOR MODE survives promotion', () => {
  it('has a subject at all (vacuity control)', () => {
    // The way this file could be green while measuring nothing: no def declares
    // `monitor`, so every sweep below iterates an empty set. It fails HERE
    // rather than letting them pass over one.
    expect(defsDeclaringMonitor().length, 'defs declaring `face.monitor`').toBeGreaterThan(0);
  });

  // ── FORWARD: a declaration must be REACHABLE ─────────────────────────────
  it('every face declaring `monitor` owns a fullViewBody that can drive it', () => {
    const offenders: string[] = [];
    for (const def of defsDeclaringMonitor()) {
      const extId = def.face?.extension;
      if (!extId) {
        offenders.push(
          `${def.type}: declares face.monitor but no face.extension — the toggle has nowhere to live`,
        );
        continue;
      }
      const src = fullViewBodySource(extId);
      if (src === null) {
        offenders.push(`${def.type}: extension '${extId}' has no resolvable fullViewBody component`);
        continue;
      }
      // The SAME three semantic legs `video-face-screen-source.test.ts` uses,
      // and semantic for the same measured reason: that gate first demanded a
      // testid NAME and reported a false positive against a module that had the
      // behaviour spelled differently. What matters is what the source can DO.
      if (!src.includes(KEY)) {
        offenders.push(`${def.type}: fullViewBody never reads \`${KEY}\``);
      }
      if (!new RegExp(`\\.data\\.${KEY}\\s*=`).test(src)) {
        offenders.push(`${def.type}: fullViewBody never WRITES \`${KEY}\` — it cannot toggle`);
      }
      if (!/<button/.test(src)) {
        offenders.push(`${def.type}: fullViewBody exposes no <button> to toggle it`);
      }
    }
    expect(
      offenders,
      'MONITOR MODE is declared on a face that cannot reach it. The shell SUPPRESSES the bands ' +
        '(`faceMonitorPlan`); the module owns the BUTTON, on its own `fullViewBody`, over the same ' +
        `\`${KEY}\` key the legacy card uses — a different key silently forgets every monitor a ` +
        'player already had open.',
    ).toEqual([]);
  });

  it('every `monitor` declaration carries an argument, not a label', () => {
    const thin = defsDeclaringMonitor()
      .filter((d) => (d.face?.monitor?.why ?? '').trim().length < 40)
      .map((d) => d.type);
    expect(
      thin,
      'the burden of proof is on the face claiming its picture is worth watching alone',
    ).toEqual([]);
  });

  // ── LEG 3 · THE RENDER SITE IS REAL ──────────────────────────────────────
  it('ModuleShell actually SUPPRESSES on the plan — a declaration cannot be inert', () => {
    // Without this the whole contract is decoration: a def could declare
    // `monitor`, a body could toggle the key, and the bands would never move.
    // Same argument shell-extensions.test.ts makes for `fullViewBody` — a slot
    // that is declared and unrendered is a silent no-op.
    const src = stripSourceComments(read(SHELL));
    expect(
      /faceMonitorPlan\(\{/.test(src),
      'ModuleShell must CALL faceMonitorPlan, not merely import it',
    ).toBe(true);
    const guards = src.split('!monitorPlan.bandsHidden').length - 1;
    expect(
      guards,
      'the plan must gate BOTH suppressible regions — the dock HERO band and the `.dock-pages` ' +
        'control bands. One guard means half the faceplate still paints in monitor mode, which ' +
        'is not the affordance.',
    ).toBeGreaterThanOrEqual(2);
    // Positive controls: the regions being guarded still EXIST. Two absence
    // checks over a mis-read file would otherwise look identical to a pass.
    expect(src.includes('data-testid="face-pages"'), 'the bands container still exists').toBe(true);
    expect(src.includes('dock-hero'), 'the hero band still exists').toBe(true);
  });

  // ── LEG 4 · #2009's NOMINATED ROUTE STAYS CLOSED ─────────────────────────
  it('`editorSurface` is still UNWIRED — monitor mode did not become its fake adopter', () => {
    // #2009 proposed wiring `editorSurface` for this. Doing so would have made
    // ruttetra the "first adopter" of a slot for controls that are not
    // cell-shaped, which its twelve ordinary scalars plainly are — and would
    // have left the actual blocker (bands that cannot be suppressed) standing.
    // If a LATER module genuinely needs that slot it wires its own render site,
    // and this assertion is what makes doing so a deliberate, visible act.
    expect(WIRED_SHELL_EXTENSION_SLOTS).not.toContain('editorSurface');
    expect(WIRED_SHELL_EXTENSION_SLOTS).toContain('fullViewBody');
  });

  // ── The exemption list is ANCHORED, not a bucket ─────────────────────────
  it('every exemption still names a faced module', () => {
    // ⚠ THE SECOND HALF OF THIS ANCHOR read the card ("…whose card mounts the
    // monitor"), which is what made an exemption impossible to leave behind
    // after the affordance moved. The list is EMPTY and stays anchored on the
    // half that survives: an exemption for something that is not a faced module
    // quietly pre-approves whatever takes that name next.
    const faced = NO_MONITOR_MODE.filter((e) => !STRICT_FACES.has(e.type)).map((e) => e.type);
    expect(faced, 'an exemption naming a module that is not faced is stale — delete it')
      .toEqual([]);
  });

  it('every exemption carries a real reason', () => {
    const thin = NO_MONITOR_MODE.filter((e) => (e.why ?? '').trim().length < 40).map((e) => e.type);
    expect(thin, 'an exemption needs an argument, not a label').toEqual([]);
  });

  // ── The instrument's own negative controls ───────────────────────────────
  it('the DECLARATION sweep DISCRIMINATES — it is not matching everything or nothing', () => {
    // The population is derived, so a broken predicate would report an empty set
    // (silently green above) or every module (silently green too, since most
    // declare no monitor). Both directions are pinned against the real tree.
    //
    // ⚠ THIS USED TO BE THE CARD RESOLVER'S control, with ruttetra as the
    // positive case and adsr as the negative. The resolver retired with the
    // fleet; the same two modules make the same point about the DECLARATION,
    // which is the surviving subject.
    const withMonitor = new Set(defsDeclaringMonitor().map((d) => d.type));
    const all = allDefs().map((d) => d.type);
    expect(withMonitor.size, 'not everything declares a monitor').toBeLessThan(all.length);
    expect(withMonitor.has('ruttetra'), 'positive control: ruttetra declares one').toBe(true);
    expect(withMonitor.has('adsr'), 'negative control: adsr does not').toBe(false);
  });

  it('the fullViewBody resolver DISCRIMINATES (negative control)', () => {
    expect(fullViewBodySource('definitely-not-a-module')).toBeNull();
    const real = fullViewBodySource('ruttetra');
    expect(real, 'ruttetra fullViewBody source').not.toBeNull();
    expect(real!.includes(KEY)).toBe(true);
    // ⚠ AND THE DISCRIMINATION THAT MATTERS MOST: a body carrying the SCREEN
    // switch is NOT thereby carrying a monitor. `grainsOfVision` is a faced
    // video module with a full `previewCollapsed` implementation and no
    // monitor mode, so if the two predicates were ever conflated — the #1865
    // "SCREEN subsumes hideControls" claim, in code — this would go red.
    const gov = fullViewBodySource('grainsOfVision');
    expect(gov, 'grainsOfVision fullViewBody source').not.toBeNull();
    expect(gov!.includes('previewCollapsed'), 'it does carry SCREEN ON/OFF').toBe(true);
    expect(
      gov!.includes(KEY),
      'a SCREEN switch is not a MONITOR — the two keys must stay distinguishable',
    ).toBe(false);
  });
});
