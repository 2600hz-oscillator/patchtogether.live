// packages/web/src/lib/ui/modules/midi-learn-wiring-audit.test.ts
//
// STATIC AUDIT — "every knob/fader is MIDI-learnable" invariant.
//
// MIDI Learn is a first-class feature: a plain right-click on ANY Knob or
// Fader opens a control menu with "MIDI Learn" / "Forget MIDI". That only
// works when the card passes BOTH `moduleId` and `paramId` to the control
// (the engine keys bindings by `moduleId:paramId`). A control missing either
// prop silently drops the feature.
//
// This test scans every module card's .svelte source, finds every <Knob>
// and <NeonFader> instance, and asserts each one declares moduleId + paramId.
// It runs at ~zero cost (pure string scan, no jsdom mount, no WASM) and both
// (a) audits the whole module surface today and (b) prevents regressions:
// any newly-added un-wired control fails this test.
//
// EXCEPTIONS — a 2D joystick / XY pad is not a single-CC param, so it doesn't
// render as a <Knob>/<NeonFader> at all (bespoke pad <div>s). Two cases:
//   * The shared <XyPad> control (VideoCube) exposes a PER-AXIS MIDI/Electra
//     assign button, so its TWO axes ARE assignable — the third test below
//     (`every <XyPad> axis is MIDI-assignable`) COVERS them: every XyPad in a
//     card must pass moduleId + xParamId + yParamId (no silent skip).
//   * JoystickCard / WavesculptCard are fully-custom pad <div>s (no XyPad, no
//     Knob/Fader) — the fourth test asserts they stay that way.
//
// The allowlist below is a belt-and-suspenders guard so that IF someone ever
// expresses a pad axis as a Knob/Fader, the exemption is explicit + reviewed.
// To intentionally exempt a control, add `moduleId`/`paramId`-free Knob/Fader
// usage to ALLOWED_UNWIRED below WITH a justification. Do not add audio/CV
// params here — wire them instead.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Card-file basenames that are allowed to contain un-wired Knob/Fader
 *  instances, with the count expected and the reason. Empty today: every
 *  XY/joystick exception is a custom pad, NOT a Knob/Fader, so none of them
 *  match the scan. Listed here only as the documented seam for future
 *  exemptions. */
const ALLOWED_UNWIRED: Record<string, { count: number; reason: string }> = {
  // A CLASS THE ALLOWLIST DID NOT ANTICIPATE, so it is spelled out rather than
  // squeezed into "XY pad": this Fader edits `node.data.wsBands[i][field]`, not
  // a `ParamDef`. MIDI Learn binds a (moduleId, paramId) pair — there is no
  // paramId here to bind, and inventing one would be a lie the assign flow
  // would then fail to honour.
  //
  // ⚠ This is a REAL, PRE-EXISTING limitation, not something the faceplate
  // introduced: the WARRENSSPECTRUM card's own bank editor was equally
  // unreachable from MIDI, and the panel preserves that parity exactly. Making
  // the 8×5 band grid MIDI-assignable means giving the bands ParamDefs — a
  // contract change, tracked as #1673, not something to smuggle in behind a
  // faceplate promotion.
  //
  // The count is the ratchet: one source `<NeonFader>` rendered per FIELDS entry.
  // If it moves, this entry reddens and someone re-reads the reason instead of
  // inheriting it.
  'WarrensspectrumBankPanel.svelte': {
    count: 1,
    reason:
      'per-band filterbank editor writes node.data.wsBands, not a ParamDef — ' +
      'MIDI Learn has no paramId to bind; same limitation as the card it replaces',
  },
};

/** Strip HTML comments + JS `//` line comments so commented-out or
 *  doc-mention `<Knob>` tokens don't register as real instances. */
function stripComments(src: string): string {
  const noHtml = src.replace(/<!--[\s\S]*?-->/g, '');
  return noHtml
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
}

interface ControlInstance {
  kind: 'Knob' | 'NeonFader';
  tag: string;
  hasModuleId: boolean;
  hasParamId: boolean;
}

/** Parse every <Knob ...> / <NeonFader ...> opening tag, walking to the tag's
 *  closing '>' while respecting nested `{...}` Svelte expressions and
 *  '/" / backtick string literals (so attribute values like
 *  paramId={`trk${t}_x`} don't end the tag early).
 *
 * ⚠ THE ALTERNATION IS THE WHOLE AUDIT'S SUBJECT, AND #1794 NEARLY EMPTIED IT.
 * This read `/<(Knob|Fader)[\s/>]/`, and `<NeonFader` DOES NOT MATCH THAT — the
 * `<` must sit immediately before the name. Migrating every card off
 * `Fader.svelte` would therefore have removed ~460 controls from the audit
 * silently, leaving a green gate that had stopped looking at faders entirely.
 * The two anti-vacuity floors at the bottom of this file are what would have
 * turned that from invisible into red; they are the reason this was caught. */
function parseControls(src: string): ControlInstance[] {
  const out: ControlInstance[] = [];
  const re = /<(Knob|NeonFader)[\s/>]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    let i = re.lastIndex - 1; // back up onto the delimiter char
    let inStr: string | null = null;
    let brace = 0;
    let end = -1;
    while (i < src.length) {
      const c = src[i]!;
      if (inStr) {
        if (c === inStr) inStr = null;
      } else if (c === '"' || c === "'" || c === '`') {
        inStr = c;
      } else if (c === '{') {
        brace++;
      } else if (c === '}') {
        if (brace > 0) brace--;
      } else if (c === '>' && brace === 0) {
        end = i;
        break;
      }
      i++;
    }
    const tag = src.slice(m.index, end >= 0 ? end + 1 : m.index + 200);
    out.push({
      kind: m[1] as 'Knob' | 'NeonFader',
      tag,
      hasModuleId: /\bmoduleId\b/.test(tag),
      hasParamId: /\bparamId\b/.test(tag),
    });
  }
  return out;
}

/**
 * Every module-owned surface: the flat `.svelte` in this directory AND one level
 * of module subdirectory beneath it.
 *
 * ⚠ THE SECOND LEVEL IS WHERE THE CONTROLS WENT. This walk was flat, which was
 * right while every knob lived on a `*Card.svelte` beside it. MEASURED now: the
 * surviving Knob/Fader render sites are `ModuleShell.svelte`,
 * `VfpgaModulationPanel`, `WarrensspectrumBankPanel` — and
 * `toybox/ToyboxConsole.svelte` (17 of them), `electraControl/ElectraGridBody`
 * and `controlSurface/ControlSurfaceBoardBody`, none of which a flat readdir can
 * see. One level is the depth the shell-extension glob itself loads from.
 */
function cardFiles(): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(__dirname, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      for (const inner of readdirSync(join(__dirname, entry.name))) {
        if (inner.endsWith('.svelte')) out.push(`${entry.name}/${inner}`);
      }
      continue;
    }
    if (entry.name.endsWith('.svelte')) out.push(entry.name);
  }
  return out.sort();
}

interface XyPadInstance {
  tag: string;
  hasModuleId: boolean;
  hasXParamId: boolean;
  hasYParamId: boolean;
}

/** Parse every `<XyPad ...>` opening tag (the shared draggable joystick pad),
 *  walking to the tag's closing '>' with the SAME brace/string awareness the
 *  Knob/Fader scan uses. The pad's two AXES are MIDI/Electra-assignable via its
 *  per-axis assign buttons, but ONLY when the card passes moduleId + xParamId +
 *  yParamId — so this feeds the coverage gate below. */
function parseXyPads(src: string): XyPadInstance[] {
  const out: XyPadInstance[] = [];
  const re = /<XyPad[\s/>]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    let i = re.lastIndex - 1;
    let inStr: string | null = null;
    let brace = 0;
    let end = -1;
    while (i < src.length) {
      const c = src[i]!;
      if (inStr) {
        if (c === inStr) inStr = null;
      } else if (c === '"' || c === "'" || c === '`') {
        inStr = c;
      } else if (c === '{') {
        brace++;
      } else if (c === '}') {
        if (brace > 0) brace--;
      } else if (c === '>' && brace === 0) {
        end = i;
        break;
      }
      i++;
    }
    const tag = src.slice(m.index, end >= 0 ? end + 1 : m.index + 400);
    out.push({
      tag,
      hasModuleId: /\bmoduleId\b/.test(tag),
      hasXParamId: /\bxParamId\b/.test(tag),
      hasYParamId: /\byParamId\b/.test(tag),
    });
  }
  return out;
}

describe('MIDI Learn wiring audit (static scan of every module card)', () => {
  it('every <Knob> / <NeonFader> in every card passes moduleId + paramId', () => {
    const offenders: string[] = [];
    let totalControls = 0;
    let cardsWithControls = 0;

    for (const file of cardFiles()) {
      const src = stripComments(readFileSync(join(__dirname, file), 'utf8'));
      const controls = parseControls(src);
      if (controls.length > 0) cardsWithControls++;

      let unwiredInFile = 0;
      for (const c of controls) {
        totalControls++;
        if (!(c.hasModuleId && c.hasParamId)) {
          unwiredInFile++;
        }
      }

      const allowed = ALLOWED_UNWIRED[file]?.count ?? 0;
      if (unwiredInFile > allowed) {
        // Re-list the specific offending tags for a useful failure message.
        for (const c of controls) {
          if (!(c.hasModuleId && c.hasParamId)) {
            const missing = [
              c.hasModuleId ? null : 'moduleId',
              c.hasParamId ? null : 'paramId',
            ].filter(Boolean).join(' + ');
            offenders.push(
              `${file}: <${c.kind}> missing ${missing} — ${c.tag.replace(/\s+/g, ' ').slice(0, 100)}`,
            );
          }
        }
      }
    }

    // Sanity: the scan actually found the module surfaces (guards against a
    // refactor that moves them and silently makes this test vacuous).
    //
    // ⚠ THE TWO FLOORS HERE WERE `> 50` FILES AND `> 400` CONTROLS, AND BOTH
    // WERE MEASURING THE LEGACY FLEET. They are magnitudes of a population that
    // is going away — the shell renders one generic cell for every faced
    // module's knobs, so the honest post-migration numbers are single digits,
    // and a floor re-typed to fit them would be a ratchet nobody could reason
    // about. Anchored on NAMES instead, the way present-lifetime's subject set
    // is: `ModuleShell` is the ONE render site every faced module's controls go
    // through, so a walk that cannot see it is measuring the wrong tree, and the
    // subdirectory leg pins the half a flat readdir loses.
    const scanned = cardFiles();
    expect(
      scanned,
      'ModuleShell is the single render site for every faced module knob and fader — a scan ' +
        'that misses it is measuring nothing that matters',
    ).toContain('ModuleShell.svelte');
    expect(
      scanned.filter((f) => f.includes('/')).length,
      'the walk found NO module subdirectory surfaces — the second level has stopped resolving',
    ).toBeGreaterThan(0);
    expect(cardsWithControls, 'surfaces containing Knob/Fader controls').toBeGreaterThan(1);
    expect(totalControls, 'total Knob/Fader instances scanned').toBeGreaterThan(0);

    expect(
      offenders,
      `Un-wired MIDI controls found. Every Knob/Fader must pass moduleId={id} + ` +
        `paramId="...". Add an ALLOWED_UNWIRED entry only for genuine XY/joystick ` +
        `pads with justification.\n` + offenders.join('\n'),
    ).toEqual([]);
  });

  it('enforces the joystick / XY-pad exception allowlist (no stale entries)', () => {
    // Each allowlisted card must still exist AND still have exactly the
    // expected number of un-wired controls — so an exemption can't silently
    // cover a newly-added un-wired knob, and removing a pad cleans up here.
    for (const [file, { count }] of Object.entries(ALLOWED_UNWIRED)) {
      const path = join(__dirname, file);
      let src: string;
      try {
        src = stripComments(readFileSync(path, 'utf8'));
      } catch {
        throw new Error(`ALLOWED_UNWIRED references missing card ${file} — remove the stale entry.`);
      }
      const unwired = parseControls(src).filter((c) => !(c.hasModuleId && c.hasParamId)).length;
      expect(unwired, `${file} allowlisted un-wired control count`).toBe(count);
    }
  });

  it('every <XyPad> axis is MIDI-assignable (moduleId + xParamId + yParamId — covers the joystick axes)', () => {
    // The shared XyPad joystick exposes a per-axis MIDI/Electra assign button, so
    // BOTH its axes ARE learnable — but only when the card wires the params. This
    // gate makes those axes COVERED (no silent skip): every XyPad in a card must
    // pass moduleId + xParamId + yParamId, or it fails here (the pad-equivalent of
    // the Knob/Fader moduleId+paramId rule above).
    const offenders: string[] = [];
    let totalPads = 0;

    for (const file of cardFiles()) {
      const src = stripComments(readFileSync(join(__dirname, file), 'utf8'));
      for (const pad of parseXyPads(src)) {
        totalPads++;
        const missing = [
          pad.hasModuleId ? null : 'moduleId',
          pad.hasXParamId ? null : 'xParamId',
          pad.hasYParamId ? null : 'yParamId',
        ].filter(Boolean).join(' + ');
        if (missing) {
          offenders.push(`${file}: <XyPad> missing ${missing} — ${pad.tag.replace(/\s+/g, ' ').slice(0, 120)}`);
        }
      }
    }

    // Sanity: the pads are scanned + covered — guards against a refactor that
    // renames/moves XyPad and makes this test vacuous.
    //
    // ⚠ THE FLOOR WAS `>= 3` AND IT MEANT "VideoCube's three joystick pads".
    // Those three are card instances; the shell renders ONE generic `xy` cell
    // that every faced module's declared `face.xyPads` goes through, so the
    // honest post-migration population is that one. Pinning the SITE instead of
    // the count keeps the claim falsifiable — if the shell's pad stops being
    // scanned, or stops being wired, this reddens — where a re-typed `>= 1`
    // would pass on any single pad anywhere.
    expect(totalPads, 'XyPad instances scanned across the module surfaces').toBeGreaterThan(0);
    const shellPads = parseXyPads(
      stripComments(readFileSync(join(__dirname, 'ModuleShell.svelte'), 'utf8')),
    );
    expect(
      shellPads.length,
      "ModuleShell renders no <XyPad> — every faced module's declared xyPads go through that " +
        'one cell, so its absence means the pads have no MIDI-assignable render site at all',
    ).toBeGreaterThan(0);

    expect(
      offenders,
      `Un-covered joystick axes found. Every <XyPad> must pass moduleId={id} + ` +
        `xParamId="…" + yParamId="…" so BOTH axes are MIDI/Electra-assignable via ` +
        `the per-axis assign buttons.\n` + offenders.join('\n'),
    ).toEqual([]);
  });

  it('confirms the joystick / XY-pad controls are NOT expressed as Knob/Fader', () => {
    // A pad axis is a two-dimensional gesture; expressed as a Knob or a Fader it
    // becomes two unrelated one-dimensional controls, and MIDI Learn would bind
    // them as such. If a refactor turns a pad into a Knob/Fader, this flags it
    // so the author makes a deliberate decision (wire it, or add it to
    // ALLOWED_UNWIRED).
    //
    // ⚠ THIS USED TO NAME `JoystickCard.svelte` AND `WavesculptCard.svelte`, the
    // two cards that hand-rolled custom `<div>` pads. Every pad now renders
    // through the shell's ONE `xy` cell, so the subject is that cell: it must
    // reach `<XyPad>` and must NOT have grown a Knob/Fader standing in for a
    // pad axis. Naming the surface that actually renders is what keeps this
    // falsifiable — the two card names would resolve to nothing at all.
    const shell = stripComments(readFileSync(join(__dirname, 'ModuleShell.svelte'), 'utf8'));
    expect(parseXyPads(shell).length, 'the shell still renders a real <XyPad>').toBeGreaterThan(0);
    const unwired = parseControls(shell).filter((c) => !(c.hasModuleId && c.hasParamId));
    expect(
      unwired.length,
      'ModuleShell grew un-wired Knob/Fader instances beyond its allowlisted ones — a pad axis ' +
        'expressed as a one-dimensional control is two bindings where there should be one gesture',
    ).toBe(ALLOWED_UNWIRED['ModuleShell.svelte']?.count ?? 0);
  });
});
