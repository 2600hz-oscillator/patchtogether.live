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
// and <Fader> instance, and asserts each one declares moduleId + paramId.
// It runs at ~zero cost (pure string scan, no jsdom mount, no WASM) and both
// (a) audits the whole module surface today and (b) prevents regressions:
// any newly-added un-wired control fails this test.
//
// EXCEPTIONS — 2D joystick / XY pads are not single-CC params, so they are
// NOT MIDI-learnable and don't render as <Knob>/<Fader> at all (they are
// bespoke pad <div>s). The allowlist below is a belt-and-suspenders guard
// so that IF someone ever expresses one of these as a Knob/Fader, the
// exemption is explicit and reviewed — not an accidental silent skip:
//   * JoystickCard   — the joystick pad(s) (X/Y)
//   * WavesculptCard — camera pos x/y pad + zoom/rot pad
//
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
  // e.g. 'SomeCard.svelte': { count: 1, reason: 'XY pad, not a single CC param' },
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
  kind: 'Knob' | 'Fader';
  tag: string;
  hasModuleId: boolean;
  hasParamId: boolean;
}

/** Parse every <Knob ...> / <Fader ...> opening tag, walking to the tag's
 *  closing '>' while respecting nested `{...}` Svelte expressions and
 *  '/" / backtick string literals (so attribute values like
 *  paramId={`trk${t}_x`} don't end the tag early). */
function parseControls(src: string): ControlInstance[] {
  const out: ControlInstance[] = [];
  const re = /<(Knob|Fader)[\s/>]/g;
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
      kind: m[1] as 'Knob' | 'Fader',
      tag,
      hasModuleId: /\bmoduleId\b/.test(tag),
      hasParamId: /\bparamId\b/.test(tag),
    });
  }
  return out;
}

function cardFiles(): string[] {
  return readdirSync(__dirname)
    .filter((f) => f.endsWith('.svelte'))
    .sort();
}

describe('MIDI Learn wiring audit (static scan of every module card)', () => {
  it('every <Knob> / <Fader> in every card passes moduleId + paramId', () => {
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

    // Sanity: the scan actually found the module surface (guards against a
    // refactor that moves cards and silently makes this test vacuous).
    expect(cardsWithControls, 'cards containing Knob/Fader controls').toBeGreaterThan(50);
    expect(totalControls, 'total Knob/Fader instances scanned').toBeGreaterThan(400);

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

  it('confirms the joystick / XY-pad controls are NOT expressed as Knob/Fader', () => {
    // The camera pads + joystick are custom <div> pads, so they should NOT
    // appear in the Knob/Fader scan at all. If a future refactor turns one
    // into a Knob/Fader, this test flags it so the author makes a deliberate
    // decision (wire it, or add it to ALLOWED_UNWIRED).
    for (const file of ['JoystickCard.svelte', 'WavesculptCard.svelte']) {
      const path = join(__dirname, file);
      const src = stripComments(readFileSync(path, 'utf8'));
      const unwired = parseControls(src).filter((c) => !(c.hasModuleId && c.hasParamId));
      expect(
        unwired,
        `${file}: XY/joystick pads should remain custom <div>s, not Knob/Fader. ` +
          `If this changed intentionally, update ALLOWED_UNWIRED.`,
      ).toEqual([]);
    }
  });
});
