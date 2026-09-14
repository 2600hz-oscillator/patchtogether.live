// THE PERMANENT NEGATIVE CONTROLS for the LINNSTRUMENT faceplate.
//
// The registry sweeps (`module-face-lint`, `shell-extensions`, `shell-cells`,
// `face-rack-status-source`, `faces-parity`) enrol this module automatically
// and ask GENERIC questions. This file asks the ones only true of THIS module
// — the ones a plausible edit would defeat while every sweep stayed green.
//
// ⚠ IT MATTERS MORE HERE THAN ON MOST FACES: no runner has a LinnStrument on
// USB or a granted MIDI origin, and no LinnStrument was connected while the
// module was built, so every behavioural gate on the BINDING stops at
// `disconnected`. What is left to hold structurally — the rank, the tier
// ladder, the shape (no pads declared, not tabbed, grouped by lane), the
// seams, the body's cell-contract absences — is what this file pins.

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import '$lib/audio/modules';
import { linnstrumentDef, LINNSTRUMENT_FACE } from '$lib/audio/modules/linnstrument';
import { STRICT_FACES } from './strict-faces';
import { shellCellFor, shellActionProbes } from './shell-cells';
import { glyphBinding } from './shell-glyph-live';
import { loadShellExtension, shellExtensionIds } from './shell-extensions';
import { curatedFace, dockFacePlan, dockPlanControls, laneOrder } from './curated-face';
import { DOCK_TAB_MIN_BANDS, faceForcesTabs } from './dock-tabs-model';
import { looksLikeSwitch } from './shell-control-kind';

const FACE = () => linnstrumentDef.face!;
const EXT_DIR = new URL('../modules/linnstrument/', import.meta.url);
const readExt = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, EXT_DIR)), 'utf8');
const readActions = (): string => readFileSync(fileURLToPath(new URL('../modules/linnstrument-cell-actions.ts', import.meta.url)), 'utf8');

describe('linnstrument face — the promotion itself', () => {
  it('is PROMOTED, not merely authored, and the face is the exported constant', () => {
    expect(linnstrumentDef.face).toBe(LINNSTRUMENT_FACE);
    expect(STRICT_FACES.has('linnstrument')).toBe(true);
  });

  it('`glyph: none` is RUN through glyphBinding, and `algorithm` would have passed silently', () => {
    expect(FACE().glyph).toBe('none');
    expect(glyphBinding(linnstrumentDef).kind).toBe('none');
    expect(linnstrumentDef.outputs.filter((o) => o.type === 'audio')).toEqual([]);
    const asAlgorithm = { ...linnstrumentDef, face: { ...FACE(), glyph: 'algorithm' as const } };
    expect(glyphBinding(asAlgorithm).kind, 'would pass the dead-glyph clause on an empty plate').toBe('algorithm');
  });
});

describe('linnstrument face — NEGATIVE CONTROLS on the shape', () => {
  it('declares NO xyPads — the joystick shape, three times', () => {
    // A declared pad names the two params its axes DRIVE and moves both off
    // the lane; a pad-only face resolves to zero lane controls (#1974). The
    // six axes are ordinary cells and the pads are the body.
    expect(FACE().xyPads).toBeUndefined();
    expect([...laneOrder(FACE())]).toEqual([...FACE().order]);
  });

  it('is NOT tabbed — six honest bands, under the rail threshold, no owner instruction', () => {
    expect(FACE().tabbed).toBeUndefined();
    expect(faceForcesTabs(linnstrumentDef)).toBe(false);
    expect(FACE().pages!.length).toBeLessThan(DOCK_TAB_MIN_BANDS);
    // …and nothing is padded to reach it: every band carries ≥ 3 real controls.
    for (const p of FACE().pages!) expect(p.controls.length, `band ${p.id}`).toBeGreaterThanOrEqual(3);
  });

  it('bands are grouped BY LANE, never by control type (owner ruling 2026-09-04)', () => {
    const byId = new Map(FACE().pages!.map((p) => [p.id, [...p.controls]]));
    for (const s of ['r', 'g', 'b'] as const) {
      expect(byId.get(s), `the ${s} band is everything about ${s}`).toEqual([`sel_${s}`, `pos_${s}_x`, `pos_${s}_y`]);
    }
    expect(byId.get('keys')).toEqual(['keys_root', 'keys_arp_on', 'keys_arp_dir', 'keys_arp_div', 'keys_arp_range', 'keys_arp_latch']);
    expect(byId.get('pad')).toEqual(['pad_root', 'pad_arp_on', 'pad_arp_dir', 'pad_arp_div', 'pad_arp_range', 'pad_arp_latch']);
    // NEGATIVE CONTROL: no band is "all the toggles" or "all the X axes".
    for (const p of FACE().pages!) {
      const ids = p.controls;
      expect(ids.every((k) => k.startsWith('sel_')), `${p.id} is not a toggle bucket`).toBe(false);
      expect(ids.every((k) => k.endsWith('_x')), `${p.id} is not an axis bucket`).toBe(false);
    }
  });

  it('the pages cover `order` EXACTLY — nothing orphaned, nothing doubled', () => {
    const paged = FACE().pages!.flatMap((p) => [...p.controls]);
    expect([...paged].sort()).toEqual([...FACE().order].sort());
    expect(new Set(paged).size).toBe(paged.length);
  });

  it('every switch-shaped param is a LATCHING selector or mode — none is a strike pad', () => {
    // The module has no momentary gesture as a PARAM: Center and Panic are
    // families. A `face.momentary` entry here would be the tidyVco `hold`
    // mistake in reverse.
    expect(FACE().momentary).toBeUndefined();
    const switches = linnstrumentDef.params.filter((p) => looksLikeSwitch(p)).map((p) => p.id);
    expect(switches.sort()).toEqual(['join_policy', 'keys_arp_latch', 'keys_arp_on', 'pad_arp_latch', 'pad_arp_on', 'sel_b', 'sel_g']);
  });

  it('the arp rosters are BOUND to the engine tables, never re-typed', () => {
    const byId = new Map(linnstrumentDef.params.map((p) => [p.id, p]));
    for (const region of ['keys', 'pad'] as const) {
      expect(byId.get(`${region}_arp_div`)!.options!.map((o) => o.label)).toEqual(['8x', '4x', '2x', '1x', '1/2', '1/4', '1/8']);
      expect(byId.get(`${region}_arp_range`)!.options!.map((o) => o.label)).toEqual(['1 oct', '+1..-1', '+2..-2']);
      expect(byId.get(`${region}_arp_dir`)!.options!.map((o) => o.label)).toEqual(['up', 'down', 'up/dn']);
    }
  });
});

describe('linnstrument face — CONNECT ranks FIRST and every family is a live cell', () => {
  it('is rank 0 in face.order, and survives at MINI', () => {
    expect(FACE().order[0]).toBe('linnstrument-connect-{n}');
    expect(curatedFace(linnstrumentDef, 'mini')?.controls.map((c) => c.key)).toEqual(['linnstrument-connect-{n}']);
  });

  it('the COMPACT tile is CONNECT + the R selector + R X', () => {
    const compact = curatedFace(linnstrumentDef, 'compact')?.controls.map((c) => c.key) ?? [];
    expect(compact).toEqual(['linnstrument-connect-{n}', 'sel_r', 'pos_r_x']);
  });

  it('all three families resolve to ACTION cells with an engine-message audition probe', () => {
    const probes = shellActionProbes().linnstrument ?? {};
    for (const id of ['connect', 'center', 'panic']) {
      const key = `linnstrument-${id}-{n}`;
      expect(linnstrumentDef.controlFamilies!.some((f) => f.id === `linnstrument-${id}`), `${id} is a declared family`).toBe(true);
      expect(FACE().order).toContain(key);
      const cell = shellCellFor('linnstrument', { kind: 'family', key, label: id } as never);
      expect(cell?.kind, `${id} is an action cell`).toBe('action');
      expect(probes[key]?.effect).toEqual({ kind: 'audition', seam: 'engine-message' });
    }
    // Exactly these three — a fourth action cell would need its own argument.
    expect(Object.keys(probes).sort()).toEqual(['linnstrument-center-{n}', 'linnstrument-connect-{n}', 'linnstrument-panic-{n}']);
  });

  it('the dock plan renders every param and family exactly once', () => {
    const plan = dockFacePlan(linnstrumentDef)!;
    const flat = dockPlanControls(plan);
    const params = flat.filter((c) => c.kind === 'param').map((c) => c.paramId).sort();
    expect(params).toEqual(linnstrumentDef.params.map((p) => p.id).sort());
    expect(flat.filter((c) => c.kind === 'family').length).toBe(3);
  });
});

describe('linnstrument face — the seams are HONEST', () => {
  it('connect is called SYNCHRONOUSLY and records delivered:false on its fallback', () => {
    const src = readActions();
    const body = src.slice(src.indexOf('export function linnstrumentConnect'));
    expect(body.slice(0, body.indexOf('\n}\n'))).not.toMatch(/\bawait\b/);
    expect(src).toMatch(/recordAudition\(\{ nodeId, seam: 'engine-message', delivered: false \}\)/);
    expect(src).toMatch(/recordAudition\(\{ nodeId, seam: 'engine-message', delivered: true \}\)/);
  });

  it('center and panic are REDUCER INTENTS, never param writes of their own', () => {
    const src = readActions();
    expect(src).toMatch(/api\.dispatch\(\{ kind: 'center' \}\)/);
    expect(src).toMatch(/api\.dispatch\(\{ kind: 'panic' \}\)/);
    // The pad's set_pair rides the same door.
    expect(src).toMatch(/api\.dispatch\(\{ kind: 'set_pair', selector, x, y \}\)/);
  });
});

describe('linnstrument face — the extension body', () => {
  it('the declared extension resolves to a fullViewBody and nothing else', async () => {
    expect(FACE().extension).toBe('linnstrument');
    expect(shellExtensionIds()).toContain('linnstrument');
    const ext = await loadShellExtension('linnstrument');
    expect(ext?.fullViewBody).toBeTruthy();
    expect(ext?.glyph).toBeUndefined();
    expect(ext?.tileBody).toBeUndefined();
    expect(existsSync(fileURLToPath(new URL('LinnstrumentPadsBody.svelte', EXT_DIR)))).toBe(true);
  });

  it('the body carries NO cell contract and NO canvas, and its meaning is on aria-label', () => {
    const src = readExt('LinnstrumentPadsBody.svelte');
    expect(src).not.toMatch(/data-control-params\s*=/);
    expect(src).not.toMatch(/data-testid="control-/);
    expect(src).not.toMatch(/data-cell-(kind|control|key)\s*=/);
    expect(src).not.toMatch(/<canvas/);
    expect(src).not.toMatch(/getContext\(/);
    expect(src).toMatch(/aria-label=\{padLabel\(s\)\}/);
    // …and that expression is never painted as a text node.
    expect(src).not.toMatch(/>\s*\{\s*padLabel\(s\)\s*\}/);
    // No resting prose: no paragraph, no readout mustache outside a control.
    const markup = src.slice(src.indexOf('</script>'));
    expect(markup).not.toMatch(/<p[\s>]/);
    expect(markup).not.toMatch(/\{fmt\(/);
    expect(markup).not.toMatch(/\{pairOf\(/);
    // Its testids are module-owned.
    expect(src).toMatch(/data-testid="linnstrument-face-pad-\{s\}"/);
    expect(src).toMatch(/data-testid="linnstrument-face-dot-\{s\}"/);
  });

  it('every pad drag goes through the cell-action seam, never a param write in the body', () => {
    const src = readExt('LinnstrumentPadsBody.svelte');
    expect(src).toMatch(/linnstrumentSetPair\(nodeId, s,/);
    expect(src).not.toMatch(/setNodeParam\(/);
    expect(src).not.toMatch(/createDragCommit\(/);
    // Gesture end flushes — the final value persists (#1963).
    expect(src).toMatch(/linnstrumentFlush\(nodeId\)/);
  });
});
