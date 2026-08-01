// packages/web/src/lib/ui/workflow/shell-param-writes.test.ts
//
// PF-13's registry. Small surface, but the WIRING is the whole thing: unhook
// `cloudseed.preset_index` and the shell silently falls back to writing one
// number, which is the shipped bug in a different disguise (the graph then
// holds a preset INDEX that names a space none of its other 45 values are in).
// So the clauses are (a) the entry exists on the pair that needs it, (b) it
// exists on NOTHING else — an override is a param whose write stops being the
// write every other param uses, and that must never spread by accident.

import { describe, expect, it } from 'vitest';
import { listModuleDefs } from '$lib/audio/module-registry';
import { SHELL_PARAM_WRITES, shellParamWrite } from './shell-param-writes';
import '$lib/audio/modules';

describe('SHELL_PARAM_WRITES — the macro-write registry', () => {
  it("cloudseed's preset_index is overridden (the whole-space recall)", () => {
    expect(typeof shellParamWrite('cloudseed', 'preset_index')).toBe('function');
  });

  it('nothing else is overridden — an override is not the default', () => {
    const pairs = Object.entries(SHELL_PARAM_WRITES).flatMap(([type, m]) =>
      Object.keys(m).map((pid) => `${type}.${pid}`),
    );
    expect(pairs.sort()).toEqual(['cloudseed.preset_index']);
  });

  it('an unlisted param / module falls through to the normal setter (null)', () => {
    expect(shellParamWrite('cloudseed', 'late_out')).toBeNull();
    expect(shellParamWrite('reverb', 'preset_index')).toBeNull();
    expect(shellParamWrite('not-a-module', 'preset_index')).toBeNull();
  });

  it('every override key names a REAL param on a REAL module', () => {
    // An override on a renamed/typo'd param is a silent no-op that reads like a
    // shipped decision — the same trap `face.paramCells` is linted for.
    const defs = new Map(
      (listModuleDefs() as unknown as { type: string; params?: { id: string }[] }[]).map((d) => [
        d.type,
        new Set((d.params ?? []).map((p) => p.id)),
      ]),
    );
    const bad: string[] = [];
    for (const [type, m] of Object.entries(SHELL_PARAM_WRITES)) {
      const ids = defs.get(type);
      if (!ids) { bad.push(`${type}: not a registered module`); continue; }
      for (const pid of Object.keys(m)) {
        if (!ids.has(pid)) bad.push(`${type}.${pid}: not a declared param`);
      }
    }
    expect(bad).toEqual([]);
  });
});
