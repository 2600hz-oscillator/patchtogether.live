// packages/web/src/lib/ui/workflow/ptzcam-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS for PTZ CAM's faceplate.
//
// The registry-driven sweeps (`module-face-lint`, `shell-cells`,
// `face-rack-status-source`, `faces-parity`) enrol this module automatically and
// ask GENERIC questions: does every key resolve, does every cell operate, does
// the declared body role hold. This file asks the ones that are only true of
// THIS module — the ones that, if they silently stopped being true, would leave
// every one of those sweeps green.
//
// ⚠ AND IT MATTERS MORE HERE THAN ON MOST FACES, because of what CI cannot
// reach. No runner has a PT-PTZ camera, a running native helper, or a granted
// sysex MIDI origin, so every behavioural gate on this module stops at
// `status().kind === 'idle'`. What is left to hold structurally — the rank, the
// seam, the cell kind, the guard on the axis lamps — is what this file pins.
//
// ⚠ EACH ASSERTION EXISTS BECAUSE A PLAUSIBLE EDIT WOULD DEFEAT IT QUIETLY, and
// the comment on each says which edit.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import '$lib/audio/modules';
import { ptzcamDef } from '$lib/audio/modules/ptzcam';
import { STRICT_FACES } from './strict-faces';
import { shellCellFor, shellActionProbes } from './shell-cells';
import { glyphBinding } from './shell-glyph-live';
import { curatedFace, dockFacePlan, dockPlanControls, laneOrder } from './curated-face';

const FACE = () => ptzcamDef.face!;

describe('ptzcam face — the promotion itself', () => {
  it('is PROMOTED, not merely authored', () => {
    // An authored `face` that is not in STRICT_FACES is INERT: it ships as a
    // no-op while looking complete, because `migrated()` is what decides which
    // component the player actually operates.
    expect(ptzcamDef.face, 'a face is declared').toBeTruthy();
    expect(STRICT_FACES.has('ptzcam'), 'and it is promoted').toBe(true);
  });

  it('`glyph: none` is RUN through glyphBinding, not argued from the module', () => {
    // ⚠ TWO WAYS TO GET THIS WRONG, and only one of them is caught by the
    // registry lint.
    //
    //   1. Any literal except 'algorithm' falls through to `{ kind: 'static' }`
    //      here (`outputs: []` ⇒ `primaryAudioOutPortId` is null), which
    //      module-face-lint's dead-glyph clause reddens. Loud.
    //   2. ⚠ `glyph: 'algorithm'` would RESOLVE — the `layoutSource: <ext>`
    //      branch fires for any def carrying a `face.extension` string, which
    //      this one does — so it PASSES the dead-glyph clause and paints an
    //      empty topology plate, because this extension exports no `glyph`
    //      slot. Silent. That is the edit this assertion exists for.
    expect(FACE().glyph).toBe('none');
    expect(glyphBinding(ptzcamDef).kind).toBe('none');
    expect(ptzcamDef.outputs.length, 'nothing for a live glyph to bind to').toBe(0);
    // The trap, demonstrated rather than described: the same def with
    // 'algorithm' resolves a LIVE binding pointed at a slot that does not exist.
    const asAlgorithm = { ...ptzcamDef, face: { ...FACE(), glyph: 'algorithm' as const } };
    expect(glyphBinding(asAlgorithm).kind, 'would pass the dead-glyph clause').toBe('algorithm');
  });
});

describe('ptzcam face — CONNECT ranks FIRST, and reaches every lane tier', () => {
  // The module is inert TWICE over before this gesture: Web MIDI publishes no
  // port until the browser consents, and the native PT-PTZ helper is what
  // publishes the virtual camera pair at all. Under the default shell an
  // un-migrated module renders a lane PLACEHOLDER, so before this face the grant
  // required finding the dock full view first — on a module that until then is
  // four knobs sending nothing.
  it('is rank 0 in face.order — not merely present', () => {
    // ⚠ THE PLAUSIBLE EDIT IS A TIDY, NOT A DELETION: someone groups the four
    // knobs first "because they are the controls" and moves CONNECT to the end.
    // `faceTierCap` caps a glyph-less COMPACT tile at 3, so rank 4 puts the
    // gesture behind the dock full view again and every other gate stays green
    // (the dock plan is still perfect, and the lane still paints three cells).
    expect(FACE().order[0]).toBe('ptzcam-connect-{n}');
  });

  it('survives at MINI — the tightest tier, where only rank 0 fits', () => {
    const mini = curatedFace(ptzcamDef, 'mini');
    expect(mini?.controls.map((c) => c.key)).toEqual(['ptzcam-connect-{n}']);
  });

  it('survives at COMPACT and FULL, and no lane tier is empty', () => {
    for (const tier of ['mini', 'compact', 'full'] as const) {
      const keys = curatedFace(ptzcamDef, tier)?.controls.map((c) => c.key) ?? [];
      expect(keys.length, `${tier} paints something`).toBeGreaterThan(0);
      expect(keys, `${tier} keeps the gesture`).toContain('ptzcam-connect-{n}');
    }
  });

  it('laneOrder drops nothing — no hero cell, no pad', () => {
    // `laneOrder` removes exactly a declared `hero.cell` and each xyPad's `x`.
    // This face declares neither, so the lane roster IS `face.order`.
    expect([...laneOrder(FACE())]).toEqual([
      'ptzcam-connect-{n}',
      'pan',
      'tilt',
      'zoom',
      'slew',
    ]);
  });

  it('the connect cell is an ACTION, not a PANEL — panels are the dock-only kind', () => {
    const cell = shellCellFor('ptzcam', {
      kind: 'family',
      key: 'ptzcam-connect-{n}',
      label: 'Connect camera',
    } as never);
    expect(cell?.kind, 'an action cell, which lane tiers render').toBe('action');
  });
});

describe('ptzcam face — the CONNECT probe reads a SEAM, not a device state', () => {
  it('declares an audition probe on the engine-message seam', () => {
    // ⚠ A `data`/`data-rev` probe would be wrong in BOTH directions here. The
    // natural observable is `status().kind === 'bound'`, which needs a granted
    // origin AND a running native helper AND a physical camera on USB — so it
    // would be permanently RED on a perfectly live control. A revision counter
    // would be the opposite failure: green on a button that bumps a number and
    // reaches nothing.
    const probe = shellActionProbes().ptzcam?.['ptzcam-connect-{n}'];
    expect(probe, 'the connect cell declares a probe').toBeTruthy();
    expect(probe!.effect.kind).toBe('audition');
    expect((probe!.effect as { seam: string }).seam).toBe('engine-message');
  });

  it('NEGATIVE CONTROL: no OTHER ptzcam cell shares that seam on the same node', () => {
    // The `twotracks-save` lesson applied before it can bite: two cells on one
    // node declaring the same audition seam means a probe for either is
    // satisfied by a press on the other, so one could be completely dead and
    // stay green.
    const cells = shellActionProbes().ptzcam ?? {};
    const engineSeamKeys = Object.entries(cells).filter(
      ([, p]) =>
        p.effect.kind === 'audition' && (p.effect as { seam: string }).seam === 'engine-message',
    );
    expect(engineSeamKeys.map(([k]) => k)).toEqual(['ptzcam-connect-{n}']);
  });
});

describe('ptzcam face — two honest bands, no tab rail', () => {
  it('renders exactly the five ranked controls, nothing unbacked', () => {
    const controls = dockPlanControls(dockFacePlan(ptzcamDef) ?? []);
    expect(controls.map((c) => c.key).sort()).toEqual([
      'pan',
      'ptzcam-connect-{n}',
      'slew',
      'tilt',
      'zoom',
    ]);
  });

  it('is TWO bands and is NOT tab-railed — nothing is padded to reach a rail', () => {
    // The rail engages at DOCK_TAB_MIN_BANDS = 7 and `face.tabbed` is
    // owner-instruction-only. The split is by KIND — one band reaches hardware,
    // the other is stage trim — not to manufacture headings.
    expect(FACE().pages?.length).toBe(2);
    expect(FACE().tabbed).toBeUndefined();
    expect(dockFacePlan(ptzcamDef)?.length).toBe(2);
  });

  it('declares NO hero — there is no picture and no control to promote', () => {
    expect(FACE().hero).toBeUndefined();
  });

  it('declares NO rackStatus — this binding is not a property of the rack', () => {
    // Two ptzcams can drive two different cameras (`maxInstances: 4`), and
    // neither is a property of the other. Declaring the field would suppress a
    // band on the second instance for no reason.
    expect(FACE().rackStatus).toBeUndefined();
  });
});

describe('ptzcam face — the DEVICE BODY, and what only IT can carry', () => {
  const BODY = resolve(
    __dirname,
    '../modules/ptzcam/PtzcamDeviceBody.svelte',
  );
  const body = () => readFileSync(BODY, 'utf8');

  it('declares the extension by id', () => {
    expect(FACE().extension).toBe('ptzcam');
  });

  it('⚠ THE AXIS LAMPS ARE GUARDED ON `caps` — absence, not three dark lamps', () => {
    // THE ASSERTION THIS FILE EXISTS FOR, and it is source-level because no
    // runtime gate in this tree can reach the state it protects.
    //
    // The axis mode is three-valued per axis (`abs | vel | none`) and ABSENT
    // until a real camera answers the caps handshake. Lit = VELOCITY. So three
    // UNGUARDED boolean lamps would render pre-bind exactly as they render for
    // a bound all-absolute NexiGo P610 — all dark — and the face would be
    // asserting "all three axes are positions" about a module that knows
    // nothing about any camera yet.
    //
    // ⚠ NO CI RUNNER CAN CATCH THIS. Reaching a populated `caps` needs a
    // granted sysex origin, a running native helper and a physical camera; the
    // VRT scene photographs only the unbound state; and the legacy card's own
    // `{#if modeLine !== null}` is the behaviour being carried forward. Remove
    // the guard and every gate stays green while the face lies.
    const src = body();
    expect(src, 'the lamp block is conditional at all').toMatch(/\{#if axisLamps\.length > 0\}/);
    expect(
      /ptzcamAxisLamps\(status\?\.caps\)/.test(src),
      'and the condition is derived from caps, not from a truthy default',
    ).toBe(true);
  });

  it('carries NO connect button — the gesture is the ranked cell', () => {
    // A second affordance for one gesture is clutter under "compact is the
    // default" and a second thing to keep in sync — and, worse, it would make
    // the cell look optional to the next reader, who might then unrank it.
    //
    // ⚠ THE PREDICATE IS THE BUTTON AND THE IMPORT, NOT THE PHRASE. The
    // empty-state hint NAMES the cell ("Press Connect camera to…") exactly as
    // midiclock's does, and it has to — the whole point of the empty state is
    // telling the player which gesture to reach for. Matching on the words
    // would forbid the instruction rather than the duplicate control.
    const src = body();
    expect(/<button/.test(src), 'no button element on this plate').toBe(false);
    expect(/ptzcamConnect/.test(src), 'and the connect seam is not imported here').toBe(false);
  });

  it('mounts NO canvas — the declared body role is status-primitive', () => {
    // Basis membership for the WebGL attest is derived from CONTENT, so a
    // drawing surface here would enrol an audio module in the GPU attest and
    // move every future face edit onto that critical path. It would also move
    // this body's measurements back into the region no source gate can read.
    expect(/<canvas/.test(body())).toBe(false);
  });

  it('subscribes at INIT and RELEASES — not inside an $effect', () => {
    // ⚠ MEASURED, at `PtzcamCard.svelte:39-51`: neither store auto-subscription
    // sugar nor `$effect(() => store.subscribe(...))` delivered `ptzMidiVersion`
    // bumps — the binds that appeared to work were riding incidental xyflow
    // data-prop churn, which a shell body does not have at all. And a
    // subscription without a teardown is the node-resource-leak class from the
    // other side.
    const src = body();
    expect(src).toMatch(/onDestroy\(\s*ptzMidiVersion\.subscribe\(/);
  });
});
