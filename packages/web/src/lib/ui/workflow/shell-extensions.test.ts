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

  it('every loaded extension exports only known, WIRED slots', async () => {
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

    const premature = { fullViewBody: (() => {}) as unknown } as unknown as ShellExtension;
    expect(unwiredSlotKeys(premature)).toEqual(['fullViewBody']);
    expect(unwiredSlotKeys({ editorSurface: 1 } as unknown as ShellExtension)).toEqual([
      'editorSurface',
    ]);

    // the other direction: the sanctioned shape passes both predicates.
    const ok = { glyph: (() => {}) as unknown } as unknown as ShellExtension;
    expect(unknownSlotKeys(ok)).toEqual([]);
    expect(unwiredSlotKeys(ok)).toEqual([]);
  });
});
