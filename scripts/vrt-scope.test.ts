// scripts/vrt-scope.test.ts
//
// Guards the DERIVED capture scope (#1795) — the thing that turns a bare
// `task vrt:commit` from a 41-56 minute full sweep into a ~3 minute scoped one.
//
// WHAT HAS TO BE TRUE, and none of it is checkable from a capture's own green
// run (a capture that rendered a third of what moved looks exactly like one
// that rendered everything and found no drift):
//
//   1. the decision is DENY-BY-DEFAULT — a file this file's rules do not
//      recognise sends the branch to the FULL sweep, never to a narrow scope;
//   2. the multi-population case FALLS BACK, loudly, rather than picking one of
//      the modules (#1822's three populations cannot be one token);
//   3. the verdict does not depend on the ORDER git listed the files in;
//   4. the token is a single shell-safe word, because the capture step puts it
//      through go-task's unquoted CLI_ARGS join;
//   5. a comment that merely NAMES another module does not implicate it — the
//      prose in this repo cites other modules constantly, and scanning raw
//      hunks implicated six modules on a textbook one-module PR.
//
// The instrument is negative-controlled in both directions: (5) is a permanent
// leg here, and `derives nothing when it has no module universe` proves the
// matcher cannot manufacture a scope out of an empty registry.
//
// ⚠ WHAT THIS FILE CANNOT SEE: whether Playwright selects what `selectionFor`
// models. That model is shared with `vrt-shard-plan.mjs`, which probed it
// against @playwright/test 1.59 and is re-checked per shard on every CI run of
// the required lane; here it is asserted only against discovered title paths.
// And nothing outside a real capture proves the CHOSEN scope covers what moved
// — `vrt-strict` is what says so, by reddening and naming the file.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// @ts-expect-error — plain .mjs with JSDoc types, no declaration file
import {
  deriveVrtScope,
  ignorableReason,
  selectionFor,
  TOKEN_RE,
  typeForms,
  typesInPath,
  words,
} from './vrt-scope.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** A stand-in registry universe. Chosen to carry every hazard the real one has:
 *  camelCase, an all-lowercase concatenation, digits, a shared prefix pair, and
 *  a type that is also an ordinary English/code word. */
const TYPES = [
  'adsr',
  'analogLogicMaths',
  'analogVco',
  'destroy',
  'filter',
  'moog921a',
  'moog921b',
  'scope',
  'slewSwitch',
  'tidyVco',
];

type Decision = ReturnType<typeof deriveVrtScope>;
const derive = (files: string[]): Decision => deriveVrtScope({ files, types: TYPES });

describe('words()', () => {
  it('splits on separators AND camelCase boundaries', () => {
    expect(words('analog-logic-maths-face-model.ts')).toEqual(['analog', 'logic', 'maths', 'face', 'model', 'ts']);
    expect(words('AnalogLogicMathsCard.svelte')).toEqual(['analog', 'logic', 'maths', 'card', 'svelte']);
    expect(words('Moog921aCard.svelte')).toEqual(['moog921a', 'card', 'svelte']);
  });
});

describe('typesInPath()', () => {
  it('attributes a def, a card, a panel and a face-model to the same module', () => {
    for (const p of [
      'packages/web/src/lib/audio/modules/analog-logic-maths.ts',
      'packages/web/src/lib/ui/modules/AnalogLogicMathsCard.svelte',
      'packages/web/src/lib/ui/workflow/panels/AnalogLogicMathsTransferPanel.svelte',
      'packages/web/src/lib/ui/modules/analog-logic-maths-face-model.ts',
      'packages/dsp/src/analog-logic-maths.ts',
    ]) {
      expect(typesInPath(p, TYPES), p).toEqual(['analogLogicMaths']);
    }
  });

  it('matches the ALL-ONE-WORD spelling the dsp + face-model files use', () => {
    // Measured: without this, `packages/dsp/src/slewswitch.ts` and
    // `slewswitch-face-model.ts` attributed to nothing and sent a single-module
    // PR (c04e6b2a0) to the full sweep.
    expect(typesInPath('packages/dsp/src/slewswitch.ts', TYPES)).toEqual(['slewSwitch']);
    expect(typesInPath('packages/web/src/lib/ui/modules/slewswitch-face-model.ts', TYPES)).toEqual(['slewSwitch']);
    expect(typeForms('slewSwitch')).toEqual([['slew', 'switch'], ['slewswitch']]);
  });

  it('does NOT attribute a shared component whose name merely contains a word', () => {
    for (const p of [
      'packages/web/src/lib/ui/workflow/RearCard.svelte',
      'packages/web/src/lib/ui/dock/_dock-faceplate.css',
      'packages/web/src/lib/ui/modules/_module-card.css',
      'package-lock.json',
    ]) {
      expect(typesInPath(p, TYPES), p).toEqual([]);
    }
  });

  it('keeps two types that occupy DISJOINT spans (which forces the full sweep)', () => {
    expect(typesInPath('packages/web/src/lib/audio/modules/analog-vco-scope.ts', TYPES)).toEqual([
      'analogVco',
      'scope',
    ]);
  });
});

describe('deriveVrtScope()', () => {
  it('scopes a single-module change to that module', () => {
    const d = derive([
      'packages/web/src/lib/audio/modules/analog-logic-maths.ts',
      'packages/web/src/lib/ui/modules/AnalogLogicMathsCard.svelte',
      'docs/design/face-migration.generated.md',
      'packages/web/src/lib/ui/modules/card-range-source.test.ts',
    ]);
    expect(d.mode).toBe('scoped');
    expect(d.token).toBe('analogLogicMaths');
  });

  it('⚠ A SHARED ROSTER FILE IS NOW A BLOCKER — the derivation reads PATHS ONLY', () => {
    // This used to be scoped: the content tokenizer read strict-faces.ts's
    // diff, found `'destroy'`, and cleared it. That inference is deleted
    // (2026-08-23), so the honest answer is a LOUD full sweep naming the file
    // — and the operator passes GREP=destroy if they know better.
    //
    // ⚠ THIS IS THE COMMON CASE, not an edge one: every face PR touches a
    // shared roster file. The cost is real and was accepted deliberately —
    // the heuristic that avoided it inferred modules from prose and from
    // ordinary identifiers (`.filter((e) => …)` implicated the `filter`
    // MODULE) and forced full sweeps three times in the week of 2026-08-16.
    const d = derive([
      'packages/web/src/lib/ui/modules/DestroyCard.svelte',
      'packages/web/src/lib/ui/workflow/strict-faces.ts',
    ]);
    expect(d.mode).toBe('full');
    expect(d.blockers.map((b: { file: string }) => b.file)).toEqual([
      'packages/web/src/lib/ui/workflow/strict-faces.ts',
    ]);
    // …and it still names what it DID attribute, so the report can print the
    // GREP= line the operator most likely wants.
    expect(d.tokens).toEqual(['destroy']);
  });

  it('FALLS BACK TO FULL when two modules are implicated — never picks one', () => {
    const d = derive([
      'packages/web/src/lib/audio/modules/moog921a.ts',
      'packages/web/src/lib/audio/modules/moog921b.ts',
    ]);
    expect(d.mode).toBe('full');
    expect(d.token).toBeNull();
    expect(d.tokens).toEqual(['moog921a', 'moog921b']);
    expect(d.reason).toContain('SINGLE token');
  });

  it('FALLS BACK TO FULL on a renderable file it cannot attribute — with the file named', () => {
    const d = derive([
      'packages/web/src/lib/ui/modules/AdsrCard.svelte',
      'packages/web/src/lib/ui/workflow/Fader.svelte',
    ]);
    expect(d.mode).toBe('full');
    expect(d.blockers.map((b: { file: string }) => b.file)).toEqual(['packages/web/src/lib/ui/workflow/Fader.svelte']);
  });

  it('refuses to dispatch at all when nothing changed can move a baseline', () => {
    const d = derive(['.github/workflows/ci.yml', 'scripts/vrt-scope.mjs', 'docs/process/issue-workflow.md']);
    expect(d.mode).toBe('none');
  });

  it('does not depend on the ORDER the files arrive in', () => {
    const files = [
      'packages/web/src/lib/ui/modules/DestroyCard.svelte',
      'packages/web/src/lib/ui/workflow/strict-faces.ts',
      'packages/web/src/lib/ui/workflow/face-readout-values.ts',
      'packages/web/src/lib/audio/modules/filter.ts',
    ];
    const forward = derive(files);
    const reverse = derive([...files].reverse());
    expect(reverse.mode).toBe(forward.mode);
    expect(reverse.tokens).toEqual(forward.tokens);
    expect(reverse.blockers.map((b: { file: string }) => b.file).sort()).toEqual(
      forward.blockers.map((b: { file: string }) => b.file).sort(),
    );
  });

  it('NEGATIVE CONTROL: cannot manufacture a scope from an empty module universe', () => {
    const d = deriveVrtScope({
      files: ['packages/web/src/lib/ui/modules/AdsrCard.svelte'],
      types: [],
    });
    expect(d.mode).toBe('full');
    expect(d.token).toBeNull();
  });
});

describe('the ignorable list is a NAMED exemption set, not a wildcard', () => {
  it('never ignores a def, a card, a face model or a VRT spec', () => {
    for (const p of [
      'packages/web/src/lib/audio/modules/adsr.ts',
      'packages/web/src/lib/ui/modules/AdsrCard.svelte',
      'packages/web/src/lib/ui/modules/adsr-face-model.ts',
      'e2e/vrt/vrt.spec.ts',
      'e2e/vrt/_shell-faces.ts',
      'e2e/tests/_helpers.ts',
      'packages/web/src/lib/ui/workflow/DockFullView.svelte',
      'package-lock.json',
    ]) {
      expect(ignorableReason(p), p).toBeNull();
    }
  });

  it('ignores only things that cannot move a pixel, each with a stated reason', () => {
    for (const p of [
      'README.md',
      // ⚠ NOT a `.myrobots/<name>.md` literal: scripts/agent-context.test.ts
      // reddens on any tracked file citing a `.myrobots` record that does not
      // exist, and a fixture path never will. The prefix rule is exercised
      // through its `.claude/` half instead.
      '.claude/agents/example.json',
      'art/baselines/adsr/sum.sha',
      'db/schema.sql',
      '.github/workflows/ci.yml',
      'scripts/vrt-scope.mjs',
      'Taskfile.yml',
      'packages/web/src/lib/ui/modules/card-range-source.test.ts',
      'e2e/vrt/__screenshots__/vrt.spec.ts/adsr.png',
      'e2e/e2e-timings.generated.json',
      'packages/web/src/lib/docs/contract-lock.txt',
      'ci-webgl-attest/deadbeef.json',
      'e2e/tests/card-producer-lifetime.spec.ts',
    ]) {
      const why = ignorableReason(p);
      expect(why, p).toBeTruthy();
      expect(String(why).length, `${p} states no reason`).toBeGreaterThan(10);
    }
  });
});

describe('TOKEN_RE', () => {
  it('accepts the token shapes the registry produces', () => {
    for (const t of ['adsr', 'analogLogicMaths', 'moog921a', 'tidy-vco', '4plexvid', 'face-adsr']) {
      expect(TOKEN_RE.test(t), t).toBe(true);
    }
  });

  it('rejects anything that would not survive an unquoted CLI_ARGS join', () => {
    // `task vrt:update -- --grep "$GREP"` is joined into a shell line by
    // go-task WITHOUT quoting. `a|b` there is a PIPE, and the likely outcome is
    // a capture with no grep at all — i.e. a silent full rewrite.
    for (const t of ['a|b', 'a b', '(a)', '$(x)', 'a;b', 'a&b', 'a*']) {
      expect(TOKEN_RE.test(t), t).toBe(false);
    }
  });
});

describe('selectionFor()', () => {
  const tests = [
    { file: 'vrt.spec.ts', title: 'adsr card matches baseline', titlePath: ['vrt.spec.ts', 'VRT', 'adsr card matches baseline'] },
    {
      file: 'vrt.spec.ts',
      title: 'depolarizer card matches baseline',
      titlePath: ['vrt.spec.ts', 'VRT', 'depolarizer card matches baseline'],
    },
    {
      file: 'workflow-shell-faces.spec.ts',
      title: 'face-adsr-dock: the dock full-view faceplate matches baseline',
      titlePath: ['workflow-shell-faces.spec.ts', 'faces', 'face-adsr-dock: the dock full-view faceplate matches baseline'],
    },
    {
      file: 'landing.spec.ts',
      title: 'landing page matches baseline',
      titlePath: ['landing.spec.ts', 'landing', 'landing page matches baseline'],
    },
  ];

  it('selects a module across every spec that renders it', () => {
    const sel = selectionFor('adsr', tests);
    expect(sel.tests).toHaveLength(2);
    expect(sel.files).toEqual(['vrt.spec.ts', 'workflow-shell-faces.spec.ts']);
  });

  it('OVER-captures a sibling name, which is the safe direction', () => {
    // ` polarizer` also matches `depolarizer` (vrt-shard-plan.mjs probed this
    // exact pair). For a CAPTURE that costs one extra scene; for a SHARD it
    // would have been a double-render, which is why that file anchors and this
    // one does not.
    expect(selectionFor('polarizer', tests).tests).toHaveLength(1);
  });

  it('reports zero when the token names nothing — the case the CI check refuses', () => {
    expect(selectionFor('doom', tests).tests).toHaveLength(0);
  });
});

describe('the wiring is anchored to the callers, not merely intended', () => {
  const taskfile = readFileSync(join(ROOT, 'Taskfile.yml'), 'utf8');
  const workflow = readFileSync(join(ROOT, '.github/workflows/vrt-update.yml'), 'utf8');
  const vrtCommit = taskfile.slice(taskfile.indexOf('\n  vrt:commit:'), taskfile.indexOf('\n  vrt:docker:'));

  it('vrt:commit derives the scope and offers ALL=1 as the opt-in full sweep', () => {
    expect(vrtCommit).toContain('vrt-scope.mjs decide');
    expect(vrtCommit).toMatch(/ALL=\{0,0\}|ALL="\$\{ALL:-\}"/);
    expect(vrtCommit).toContain('ALL=1');
  });

  it('vrt:commit still dispatches the BRANCH\'s own copy of the workflow (#1458)', () => {
    // The scoping work must not regress the `--ref "$BRANCH"` that makes a PR
    // changing the capture run its own capture.
    expect(vrtCommit).toContain('gh workflow run vrt-update.yml --ref "$BRANCH"');
  });

  it('the capture workflow resolves the scope before it spends the runner', () => {
    expect(workflow).toContain('vrt-scope.mjs check');
    // Compare STEP positions: `task vrt:update` is also named in this
    // workflow's prose, and matching that would make the ordering assertion
    // pass for a reason that has nothing to do with the steps.
    expect(workflow.indexOf('vrt-scope.mjs check')).toBeLessThan(
      workflow.indexOf('- name: Regenerate VRT baselines'),
    );
  });
});
