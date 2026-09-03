// packages/web/src/lib/ui/workflow/trails-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS for the TRAILS faceplate.
//
// The registry-driven sweeps (`module-face-lint`, `shell-extensions`,
// `shell-cells`, `face-rack-status-source`, `faces-parity`) enrol this module
// automatically and ask GENERIC questions: does every key resolve, does every
// cell operate, does the declared body role hold. This file asks the ones that
// are only true of THIS module — the ones that, if they silently stopped being
// true, would leave every one of those sweeps green.
//
// ⚠ AND IT MATTERS MORE HERE THAN ON MOST FACES, because of what CI cannot
// reach. No runner has a Bela Trails on USB or a granted MIDI origin, so every
// behavioural gate on the BINDING stops at `idle`. What is left to hold
// structurally — the rank, the tier ladder, the seam, the cell kind, the two
// body slots and the shared mirror — is what this file pins.
//
// ⚠ EACH ASSERTION EXISTS BECAUSE A PLAUSIBLE EDIT WOULD DEFEAT IT QUIETLY, and
// the comment on each says which edit.

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import '$lib/audio/modules';
import { trailsDef } from '$lib/audio/modules/trails';
import { STRICT_FACES } from './strict-faces';
import { shellCellFor, shellActionProbes } from './shell-cells';
import { glyphBinding } from './shell-glyph-live';
import { shellExtensionIds } from './shell-extensions';
import { curatedFace, dockFacePlan, dockPlanControls, laneOrder } from './curated-face';

const FACE = () => trailsDef.face!;

const EXT_DIR = new URL('../modules/trails/', import.meta.url);
const readExt = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, EXT_DIR)), 'utf8');

describe('trails face — the promotion itself', () => {
  it('is PROMOTED, not merely authored', () => {
    // An authored `face` that is not in STRICT_FACES is INERT: it ships as a
    // no-op while looking complete, because `migrated()` is what decides which
    // component the player actually operates.
    expect(trailsDef.face, 'a face is declared').toBeTruthy();
    expect(STRICT_FACES.has('trails'), 'and it is promoted').toBe(true);
  });

  it('`glyph: none` is RUN through glyphBinding, not argued from the module', () => {
    // ⚠ TWO WAYS TO GET THIS WRONG, and only one is caught by the registry lint.
    //
    //   1. Any literal except 'algorithm' falls through to `{ kind: 'static' }`
    //      here, which module-face-lint's dead-glyph clause reddens. Loud.
    //   2. ⚠ `glyph: 'algorithm'` would RESOLVE — the `layoutSource: <ext>`
    //      branch fires for any def carrying a `face.extension`, which this one
    //      does — so it PASSES the dead-glyph clause and paints an EMPTY
    //      topology plate, because this extension exports no `glyph` slot.
    //      Silent. That is the edit this assertion exists for.
    expect(FACE().glyph).toBe('none');
    expect(glyphBinding(trailsDef).kind).toBe('none');
    // …and the REASON, asserted from the def rather than restated: a live glyph
    // binds to `primaryAudioOutPortId`, which is the first `type: 'audio'`
    // output. Twenty-one jacks and not one of them is audio.
    expect(trailsDef.outputs.length, 'the module is jack-rich…').toBeGreaterThan(20);
    expect(
      trailsDef.outputs.filter((o) => o.type === 'audio'),
      '…and has nothing for a live glyph to bind to',
    ).toEqual([]);
    // The trap, demonstrated rather than described.
    const asAlgorithm = { ...trailsDef, face: { ...FACE(), glyph: 'algorithm' as const } };
    expect(glyphBinding(asAlgorithm).kind, 'would pass the dead-glyph clause').toBe('algorithm');
  });
});

describe('trails face — CONNECT ranks FIRST, and reaches every lane tier', () => {
  // The module is INERT before this gesture: a browser publishes no MIDI port
  // until a click asks it to, so a fresh spawn is three knobs over twenty-one
  // jacks emitting a flat zero. Under the default shell an un-migrated module
  // renders a lane PLACEHOLDER, so before this face the grant required finding
  // the dock full view first.
  it('is rank 0 in face.order — not merely present', () => {
    // ⚠ THE PLAUSIBLE EDIT IS A TIDY, NOT A DELETION: someone groups the three
    // knobs first "because they are the controls" and moves CONNECT to the end.
    // `faceTierCap` caps a glyph-less COMPACT tile at 3, so rank 4 puts the
    // gesture behind the dock full view again and every other gate stays green
    // (the dock plan is still perfect, and the lane still paints three cells).
    expect(FACE().order[0]).toBe('trails-connect-{n}');
  });

  it('survives at MINI — the tightest tier, where only rank 0 fits', () => {
    const mini = curatedFace(trailsDef, 'mini');
    expect(mini?.controls.map((c) => c.key)).toEqual(['trails-connect-{n}']);
  });

  it('the COMPACT tile is CONNECT + RANGE + SMOOTH, and DIV is the one that falls', () => {
    // ⚠ THE LADDER IS ASSERTED, not the cap. This pins WHICH control drops at
    // the compact tier so a future re-rank cannot silently trade the gesture for
    // a knob: CLOCK DIV is the one control that means anything only once a
    // transport is running, and the dock is one click away — but an inversion
    // that kept DIV on the tile would push CONNECT off it, which is the exact
    // defect midiclock's promotion existed to fix.
    const compact = curatedFace(trailsDef, 'compact')?.controls.map((c) => c.key) ?? [];
    expect(compact).toEqual(['trails-connect-{n}', 'range', 'smooth']);
    expect(compact, 'CLOCK DIV is the one that falls off').not.toContain('divisor');
  });

  it('no lane tier is empty, and every one of them keeps the gesture', () => {
    for (const tier of ['mini', 'compact', 'full'] as const) {
      const keys = curatedFace(trailsDef, tier)?.controls.map((c) => c.key) ?? [];
      expect(keys.length, `${tier} paints something`).toBeGreaterThan(0);
      expect(keys, `${tier} keeps the gesture`).toContain('trails-connect-{n}');
    }
  });

  it('laneOrder drops nothing — no hero cell, no pad', () => {
    // `laneOrder` removes exactly a declared `hero.cell` and each xyPad's `x`.
    // This face declares neither — ⚠ and the pad half is the load-bearing one:
    // the mirror is deliberately NOT an `xyPads` cell, because a declared pad
    // names the two params its axes DRIVE and these axes drive nothing, they
    // report. Declaring one would move two knobs off the lane AND claim the
    // mirror is a control.
    expect([...laneOrder(FACE())]).toEqual([
      'trails-connect-{n}',
      'range',
      'smooth',
      'divisor',
    ]);
  });

  it('the connect cell is an ACTION, not a PANEL — panels are the dock-only kind', () => {
    const cell = shellCellFor('trails', {
      kind: 'family',
      key: 'trails-connect-{n}',
      label: 'Connect Trails',
    } as never);
    expect(cell?.kind, 'an action cell, which lane tiers render').toBe('action');
  });
});

describe('trails face — the CONNECT probe reads a SEAM, not a device state', () => {
  it('declares an audition probe on the engine-message seam', () => {
    // ⚠ A `data`/`data-rev` probe would be wrong in BOTH directions here. The
    // natural observable is `status().kind === 'bound'`, which needs a granted
    // origin AND a physical Bela Trails on USB — so it would be permanently RED
    // on a perfectly live control. A revision counter would be the opposite
    // failure: green on a button that bumps a number and reaches nothing.
    const probe = shellActionProbes().trails?.['trails-connect-{n}'];
    expect(probe, 'the connect cell declares a probe').toBeTruthy();
    expect(probe!.effect.kind).toBe('audition');
    expect((probe!.effect as { seam: string }).seam).toBe('engine-message');
  });

  it('NEGATIVE CONTROL: no OTHER trails cell shares that seam on the same node', () => {
    // The `twotracks-save` lesson applied before it can bite: two cells on one
    // node declaring the same audition seam means a probe for either is
    // satisfied by a press on the other, so one could be completely dead and
    // stay green.
    const cells = shellActionProbes().trails ?? {};
    const engineSeamKeys = Object.entries(cells).filter(
      ([, p]) =>
        p.effect.kind === 'audition' && (p.effect as { seam: string }).seam === 'engine-message',
    );
    expect(engineSeamKeys.map(([k]) => k)).toEqual(['trails-connect-{n}']);
  });

  it('the seam is called SYNCHRONOUSLY — no `await` above the MIDI request', () => {
    // ⚠ NOT STYLE. An `await` above `requestMIDIAccess` spends the user
    // activation and Chromium then refuses to prompt at all, so the button
    // becomes a silent no-op on a first press — with the audition ledger still
    // reporting `delivered: true`, because the seam WAS reached. Nothing
    // downstream could catch it. Held at the source, the way the card's own
    // header holds it.
    const src = readFileSync(
      fileURLToPath(new URL('../modules/trails-cell-actions.ts', import.meta.url)),
      'utf8',
    );
    const body = src.slice(src.indexOf('export function trailsConnect'));
    expect(body.slice(0, body.indexOf('\n}\n'))).not.toMatch(/\bawait\b/);
  });

  it('the fallback branch records `delivered: false` rather than claiming a delivery', () => {
    // `connectTrails()` is APP-LEVEL — one Web MIDI access for the whole app,
    // fanned out to every trails node — so a click that races the reconciler
    // must still reach the browser (dropping it is the measured "frozen at idle
    // forever" bug ptzcam paid for). But it did NOT reach this node's own seam,
    // and "the button was never pressed" and "the button was pressed and reached
    // nothing" are different failures a probe must be able to tell apart.
    const src = readFileSync(
      fileURLToPath(new URL('../modules/trails-cell-actions.ts', import.meta.url)),
      'utf8',
    );
    expect(src).toMatch(/recordAudition\(\{ nodeId, seam: 'engine-message', delivered: false \}\)/);
    expect(src).toMatch(/recordAudition\(\{ nodeId, seam: 'engine-message', delivered: true \}\)/);
    // …and the fallback really calls the app-level connect rather than bailing.
    expect(src).toMatch(/void connectTrails\(\)/);
  });
});

describe('trails face — the DOCK plan covers exactly what is ranked', () => {
  it('the two pages cover `order` EXACTLY — nothing orphaned, nothing doubled', () => {
    const paged = FACE().pages!.flatMap((p) => [...p.controls]);
    expect([...paged].sort()).toEqual([...FACE().order].sort());
    expect(new Set(paged).size, 'no key appears on two pages').toBe(paged.length);
  });

  it('is TWO bands and is NOT padded toward a tab rail', () => {
    // ⚠ THE OWNER RULING IS "never pad pages to force the rail".
    // `DOCK_TAB_MIN_BANDS` is 7 and this face has four ranked keys, so a rail is
    // unreachable honestly — the assertion is that nobody TRIED, by splitting
    // three knobs across five bands to get there.
    expect(FACE().pages).toHaveLength(2);
    expect(FACE().pages!.map((p) => p.id)).toEqual(['device', 'signal']);
  });

  it('every ranked control reaches the dock plan', () => {
    const plan = dockFacePlan(trailsDef);
    expect(plan, 'the dock resolves a plan').toBeTruthy();
    const keys = dockPlanControls(plan!).map((c) => c.key).sort();
    expect(keys).toEqual([...FACE().order].sort());
  });
});

describe('trails face — the extension: TWO slots, ONE mirror', () => {
  it('declares an extension id the glob actually discovered', () => {
    expect(FACE().extension).toBe('trails');
    expect(shellExtensionIds()).toContain('trails');
  });

  it('fills BOTH wired body slots', () => {
    // ⚠ THE TILE SLOT IS THE ONE A TIDY WOULD DROP, and `shell-extensions.test.ts`
    // would not notice: it checks that every EXPORTED slot is known and wired,
    // never that a module exports the ones it needs. Without `tileBody` the
    // promoted lane tile is three control cells over a jack rail, and the
    // module's one live picture — the thing that answers "did my hardware just
    // do something" — would exist only behind the dock, on a module whose whole
    // claim is that you can see what the rack is receiving without looking down
    // at the panel.
    const src = readExt('shell-extension.ts');
    expect(src).toMatch(/fullViewBody:\s*TrailsPadBody/);
    expect(src).toMatch(/tileBody:\s*TrailsTileBody/);
  });

  it('BOTH bodies mount the SAME mirror component', () => {
    // ⚠ THIS IS WHAT CARRIES THE `picture` PROOF TO THE TILE.
    // `face-rack-status-source`'s roster is structurally blind to a `tileBody`
    // (its own blind-spot list), so its predicate runs against the dock body
    // alone. Two components that happened to draw the same thing would leave the
    // tile unproven; one shared component makes it true by construction — the
    // audioIn argument. A "tidy" that inlined a second canvas into the tile
    // would pass every gate in the tree and quietly reopen the gap.
    for (const f of ['TrailsPadBody.svelte', 'TrailsTileBody.svelte']) {
      const src = readExt(f);
      expect(src, `${f} imports the shared mirror`).toMatch(
        /import TrailsPadMirror from '\.\/TrailsPadMirror\.svelte'/,
      );
      expect(src, `${f} MOUNTS it`).toMatch(/<TrailsPadMirror\s/);
      expect(src, `${f} owns no canvas of its own`).not.toMatch(/<canvas/);
    }
    expect(readExt('TrailsPadMirror.svelte')).toMatch(/<canvas/);
  });

  it('the mirror is 2-D — a GL context here would enrol an AUDIO def in the GPU attest', () => {
    // WebGL attest-basis membership is derived from CONTENT over
    // `lib/ui/modules/**/*.svelte` (`scripts/webgl-attest-lib.ts`), so this is
    // not a style preference: a `getContext('webgl')` in a picture that is a
    // rectangle, a centre cross, a hatch and four dots would put an audio module
    // into the GPU attest and cost a real-GPU re-attest window on every later
    // edit to it.
    const src = readExt('TrailsPadMirror.svelte');
    expect(src).toMatch(/getContext\('2d'\)/);
    expect(src).not.toMatch(/getContext\(\s*['"]webgl2?['"]/);
    expect(trailsDef.domain).toBe('audio');
  });

  it('the mirror carries NO pointer handler — it is a MIRROR, not a control', () => {
    // ⚠ AN EXPLICIT NON-AFFORDANCE, and the property the whole disposition rests
    // on: read-only is what makes it honest to call this a body rather than an
    // `xyPads` cell. It matters MORE on the tile than the dock, because a lane
    // tile and an open dock pane for one node are mounted at once and two
    // steering surfaces over one cursor is the trap skifree measured.
    for (const f of ['TrailsPadMirror.svelte', 'TrailsTileBody.svelte']) {
      const src = readExt(f);
      expect(src, `${f} has no pointer handler`).not.toMatch(
        /on(pointerdown|pointermove|mousedown|click|touchstart)=/,
      );
    }
  });

  it('the two bodies NAMESPACE their testids — they are mounted at the same time', () => {
    // `ModuleShell` gates `tileBody` on `!extBody`, so the two slots are
    // counterparts per shell instance — but a lane tile and an open dock pane
    // for the SAME node are two instances at once, so a shared stem would put
    // two elements behind one selector.
    expect(readExt('TrailsPadBody.svelte')).toMatch(/testidPrefix="trails-face"/);
    expect(readExt('TrailsTileBody.svelte')).toMatch(/testidPrefix="trails-tile"/);
  });

  it('NEITHER body writes to the graph — the module makes NO node.data writes at all', () => {
    // ⚠ THE DATA-FLOW LAW IS THE ONE THING A PROMOTION COULD BREAK SILENTLY. A
    // live gesture is 100-250 messages a second (trails.ts:44-51); routing any of
    // it through the Y.Doc would be 250 CRDT transactions a second broadcast to
    // every collaborator — the cv-modulation live-store-write-storm class. The
    // cheapest way to hold it is to make the surfaces structurally incapable:
    // they import no mutator and no store write. `monOpen` is component state
    // for the same reason, and persisting it would be this module's FIRST
    // `node.data` key.
    for (const f of ['TrailsPadBody.svelte', 'TrailsTileBody.svelte', 'TrailsPadMirror.svelte']) {
      const src = readExt(f);
      expect(src, `${f} makes no node mutation`).not.toMatch(
        /mutateNode|setNodeParam|updateNodeData|patch\.nodes\[[^\]]+\]\s*\./,
      );
    }
  });

  it('NO SCREEN switch and NO watch mark — derived, not omitted', () => {
    // The fleet-wide "all video cards get SCREEN ON/OFF" ruling runs over
    // `STRICT_FACES ∩ video defs`. This is `domain: 'audio'` and declares no
    // video port — skifree HAS one and therefore has a switch; dockscope,
    // spectrograph and samsloop do not and therefore do not. And on the merits
    // there is no producer a switch could stop: the decode runs in the FACTORY
    // on the MIDI callback and the scheduler tick, and the paint loop already
    // skips every frame in which nothing moved.
    expect(trailsDef.domain).toBe('audio');
    expect(trailsDef.outputs.filter((o) => o.type === 'video')).toEqual([]);
    for (const f of ['TrailsPadBody.svelte', 'TrailsTileBody.svelte']) {
      expect(readExt(f), `${f} declares no preview collapse`).not.toMatch(/previewCollapsed|markWatched/);
    }
  });

  it('the legacy card and the cell call ONE seam — no second connect implementation', () => {
    // Promotion does not remove `TrailsCard.svelte` from `?shell=legacy`, so two
    // surfaces ship at once. A body that grew its own `requestMIDIAccess` path
    // would be a second owner of a gesture with a user-activation constraint,
    // and the two could drift on the fallback branch alone.
    expect(existsSync(fileURLToPath(new URL('../modules/trails-cell-actions.ts', import.meta.url))))
      .toBe(true);
    // ⚠ AND THE DOCK BODY HAS NO CONNECT BUTTON. The gesture is a ranked action
    // cell — that is what puts it on the lane tile — so a second button on the
    // same plate would be one gesture with two affordances.
    expect(readExt('TrailsPadBody.svelte')).not.toMatch(/trailsConnect|Connect Trails/);
  });
});
