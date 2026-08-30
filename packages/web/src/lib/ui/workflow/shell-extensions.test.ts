// packages/web/src/lib/ui/workflow/shell-extensions.test.ts
//
// LINT for the module-extension registry (#1512) — deny by default, anchored
// to the artifact in BOTH directions:
//
//   1. Every def-declared `face.extension` id resolves to a DISCOVERED
//      extension module (a typo cannot ship as a silently-generic shell).
//   2. Every discovered extension module is DECLARED by at least one def (an
//      extension no def references is a dead file wearing a registration —
//      red, exactly like a ledger entry naming a vanished subject).
//   3. A def declaring `glyph: 'algorithm'` MUST resolve an extension
//      exporting the `glyph` slot — the topology plate has no generic picture
//      to fall back to, so the miss would render an empty frame forever.
//   4. A loaded extension may export ONLY the contract's slot keys, and none
//      that the shell does not RENDER yet (`WIRED_SHELL_EXTENSION_SLOTS`) —
//      an unwired slot is a silent no-op, refused until the render site
//      exists. The wired list itself is ANCHORED to ModuleShell's source
//      below, so it cannot drift from the render reality it names.
//
// SCOPE (what this gate cannot see): it proves resolution and slot shape, not
// pixels — the DX7 VRT scenes pin what the resolved glyph paints; and it
// reads `face.extension` declarations, so a bespoke component wired around
// the registry entirely is module-shell-import-guard's subject, not this one's.

import { describe, it, expect } from 'vitest';

import '$lib/audio/modules';
import '$lib/video/modules';
import '$lib/meta/modules';
import { listModuleDefs } from '$lib/audio/module-registry';
import { listVideoModuleDefs } from '$lib/video/module-registry';
import { listMetaModuleDefs } from '$lib/meta/module-registry';
import type { ModuleFace } from '$lib/graph/types';
import {
  SHELL_EXTENSION_SLOTS,
  WIRED_SHELL_EXTENSION_SLOTS,
  loadShellExtension,
  shellExtensionIds,
  unknownSlotKeys,
  unwiredSlotKeys,
  type ShellExtension,
} from './shell-extensions';

interface ExtDefLike {
  type: string;
  face?: ModuleFace;
}

function allDefs(): ExtDefLike[] {
  return [
    ...(listModuleDefs() as unknown as ExtDefLike[]),
    ...(listVideoModuleDefs() as unknown as ExtDefLike[]),
    ...(listMetaModuleDefs() as unknown as ExtDefLike[]),
  ].sort((a, b) => a.type.localeCompare(b.type));
}

// ModuleShell's raw source — the anchor for the WIRED slot list.
const MODULE_SHELL_SRC = Object.values(
  import.meta.glob('../modules/ModuleShell.svelte', {
    eager: true,
    query: '?raw',
    import: 'default',
  }),
)[0] as string;

/** The testid the `fullViewBody` render site puts on its container. Named here
 *  (not re-typed at each assertion) so the source anchor and any DOM-level
 *  consumer read the SAME string. */
const FULL_VIEW_BODY_TESTID = 'face-full-view-body';

/** Strip Svelte markup comments, block comments and line comments so a source
 *  anchor cannot be satisfied by PROSE ABOUT the thing it is anchoring. The
 *  wired-slot anchor below deliberately does NOT use this — its unwired half
 *  must refuse even a mention, so that a half-written render site cannot sit in
 *  the file commented out. Mirrors webgl-attest-lib's stripComments. */
function stripSourceComments(src: string): string {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

describe('shell-extensions registry lint (#1512)', () => {
  it('every declared face.extension resolves to a discovered extension module', () => {
    const ids = new Set(shellExtensionIds());
    const orphans = allDefs()
      .filter((d) => d.face?.extension && !ids.has(d.face.extension))
      .map((d) => `${d.type} declares extension '${d.face!.extension}' (discovered: ${[...ids].join(', ') || 'none'})`);
    expect(orphans).toEqual([]);
  });

  it('every discovered extension module is declared by at least one def', () => {
    const declared = new Set(
      allDefs()
        .map((d) => d.face?.extension)
        .filter((x): x is string => !!x),
    );
    const dead = shellExtensionIds().filter((id) => !declared.has(id));
    expect(dead, 'an extension module no def declares is a dead registration').toEqual([]);
  });

  it("every 'algorithm' glyph resolves an extension exporting the glyph slot", async () => {
    const missing: string[] = [];
    for (const d of allDefs()) {
      if (d.face?.glyph !== 'algorithm') continue;
      const extId = d.face.extension;
      if (!extId) {
        missing.push(`${d.type}: glyph 'algorithm' with no face.extension`);
        continue;
      }
      const ext = await loadShellExtension(extId);
      if (!ext || typeof ext.glyph !== 'function') {
        missing.push(`${d.type}: extension '${extId}' loads ${ext ? 'without a glyph slot' : 'nothing'}`);
      }
    }
    expect(missing).toEqual([]);
  });

  // ⚠ EXPLICIT BUDGET, AND IT IS ABOUT COMPILE COST, NOT THE ASSERTION. This is
  // the only test here that dynamically imports EVERY extension module, so it
  // pays for compiling each one's Svelte component graph — a cost that grows
  // with the roster, not with what is being checked. Measured 2026-08-27: 2.2s
  // warm before cameraInput's tileBody, and a 5007ms COLD-CACHE timeout against
  // the 5s default right after adding it. That is a slow test, not a flaky one,
  // and CI is colder than a dev box.
  it('every loaded extension exports only known, WIRED slots', { timeout: 30_000 }, async () => {
    const bad: string[] = [];
    for (const id of shellExtensionIds()) {
      const ext = await loadShellExtension(id);
      if (!ext) {
        bad.push(`${id}: default export missing`);
        continue;
      }
      for (const k of unknownSlotKeys(ext)) bad.push(`${id}: unknown slot '${k}'`);
      for (const k of unwiredSlotKeys(ext)) {
        bad.push(
          `${id}: slot '${k}' has NO render site in ModuleShell yet — wire it (and move it to WIRED_SHELL_EXTENSION_SLOTS) in the same diff, or it is a silent no-op`,
        );
      }
    }
    expect(bad).toEqual([]);
  });

  it('the tileBody site is gated on !extBody, so it never doubles fullViewBody', () => {
    // A faced module's LANE TILE and its DOCK FULL VIEW can be on screen at the
    // same time. `fullViewBody` and `tileBody` are counterparts carrying the
    // same controls at two sizes — cameraInput's picker, lamp and acquire — so
    // rendering both would put two live pickers on one node AND two elements
    // behind every testid that surface emits, which turns every Playwright
    // strict locator over them into a throw.
    const site = MODULE_SHELL_SRC.slice(
      MODULE_SHELL_SRC.indexOf('ext?.tileBody') - 200,
      MODULE_SHELL_SRC.indexOf('ext?.tileBody') + 40,
    );
    // Stated as "wherever the full-view body is NOT painting" rather than as a
    // view comparison: a raw `view !== 'dock-full'` is a drawer falling into the
    // lane branch, which `module-shell-drawer-view` refuses (#1739).
    expect(site, "tileBody's render site must be gated on !extBody")
      .toMatch(/!extBody\s*&&\s*ext\?\.tileBody/);
  });

  it('WIRED_SHELL_EXTENSION_SLOTS is anchored to ModuleShell source, both directions', () => {
    expect(MODULE_SHELL_SRC, 'the raw glob must find ModuleShell').toBeTruthy();
    for (const slot of WIRED_SHELL_EXTENSION_SLOTS) {
      expect(
        new RegExp(`\\bext\\??\\.${slot}\\b`).test(MODULE_SHELL_SRC),
        `wired slot '${slot}' must be read as ext?.${slot} in ModuleShell`,
      ).toBe(true);
    }
    for (const slot of SHELL_EXTENSION_SLOTS) {
      if ((WIRED_SHELL_EXTENSION_SLOTS as readonly string[]).includes(slot)) continue;
      expect(
        MODULE_SHELL_SRC.includes(slot),
        `unwired slot '${slot}' must not appear in ModuleShell — if you wired it, move it to WIRED_SHELL_EXTENSION_SLOTS`,
      ).toBe(false);
    }
  });

  // ── THE fullViewBody RENDER SITE (#1726) ──────────────────────────────────
  //
  // The anchor test above proves the slot is READ in ModuleShell. Reading is
  // not rendering: `let x = ext?.fullViewBody` alone would satisfy a substring
  // anchor while painting nothing, which is the precise silent no-op the wired
  // list exists to forbid. So this pins the three parts a render site actually
  // has — the read, the MOUNT, and the queryable element the DOM-level gates
  // (and the first video face's e2e) will look for — against a
  // COMMENT-STRIPPED source, so prose about the slot cannot green any of them.
  it('fullViewBody has a real render site: read, mounted, and queryable', () => {
    const src = stripSourceComments(MODULE_SHELL_SRC);
    expect(WIRED_SHELL_EXTENSION_SLOTS).toContain('fullViewBody');
    expect(/\bext\??\.fullViewBody\b/.test(src), 'the slot must be READ in code, not only in a comment').toBe(true);
    expect(/<ExtFullViewBody\b/.test(src), 'the resolved component must be MOUNTED, not merely read').toBe(true);
    expect(
      src.includes(FULL_VIEW_BODY_TESTID),
      `the mounted body must be queryable as "${FULL_VIEW_BODY_TESTID}" — a surface no gate can select is a surface no gate can prove`,
    ).toBe(true);
  });

  it('the fullViewBody site is DOCK-GATED in ONE place (dockFullViewHeadPlan)', () => {
    // The lane tile is 192×180 and already carries the thumbnail glyph; a
    // module's full surface has no business there. That policy lives in the
    // pure plan (module-shell-model.test.ts drives it), and this asserts the
    // shell does not carry a SECOND copy of it that could drift — the shell
    // reads `headPlan.extBody`, never re-tests the view for this slot.
    const src = stripSourceComments(MODULE_SHELL_SRC);
    expect(/dockFullViewHeadPlan\(/.test(src)).toBe(true);
    const extBodyDecl = /let\s+extBody\s*=\s*\$derived\(([^;]*)\)/.exec(src)?.[1] ?? '';
    expect(extBodyDecl, 'extBody must be derived from the plan').toContain('headPlan.extBody');
    expect(
      /view\s*===\s*'dock-full'/.test(extBodyDecl),
      'the dock gate must not be re-typed at the extBody call site — it is the plan\'s job',
    ).toBe(false);
  });

  it('dx7 is the proof: declared, discovered, loads a glyph component lazily', async () => {
    // Derived membership, not a count: the def that declares glyph 'algorithm'
    // is the def that must resolve — asserted generically above; this pins the
    // concrete migration #1512 shipped so a silent unhooking of dx7 is loud.
    const dx7 = allDefs().find((d) => d.type === 'dx7');
    expect(dx7?.face?.extension).toBe('dx7');
    const ext = await loadShellExtension('dx7');
    expect(typeof ext?.glyph).toBe('function');
  });

  // ── NEGATIVE CONTROLS — permanent legs calling the SAME predicates ────────
  it('NEGATIVE CONTROL: an unknown id resolves null; unknown/unwired slots redden', async () => {
    expect(await loadShellExtension('no-such-extension')).toBeNull();

    const bogus = { glyph: (() => {}) as unknown, bogusSlot: 1 } as unknown as ShellExtension;
    expect(unknownSlotKeys(bogus)).toEqual(['bogusSlot']);

    // STILL UNWIRED: `editorSurface` has no render site, so exporting it is
    // still refused. This is the leg that keeps `unwiredSlotKeys` honest now
    // that fullViewBody has moved — a predicate whose refusal set has gone
    // empty is a predicate nobody would notice breaking.
    const premature = { editorSurface: (() => {}) as unknown } as unknown as ShellExtension;
    expect(unwiredSlotKeys(premature)).toEqual(['editorSurface']);

    // NEWLY WIRED (#1726): fullViewBody now HAS a render site, so the same
    // predicate must let it through — asserted in both directions so "wired"
    // and "refused" cannot both be true of one slot.
    const body = { fullViewBody: (() => {}) as unknown } as unknown as ShellExtension;
    expect(unwiredSlotKeys(body)).toEqual([]);
    expect(unknownSlotKeys(body)).toEqual([]);

    // the other direction: the sanctioned shape passes both predicates.
    const ok = { glyph: (() => {}) as unknown } as unknown as ShellExtension;
    expect(unknownSlotKeys(ok)).toEqual([]);
    expect(unwiredSlotKeys(ok)).toEqual([]);
  });
});
