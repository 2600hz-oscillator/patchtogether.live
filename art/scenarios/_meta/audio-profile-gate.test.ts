// art/scenarios/_meta/audio-profile-gate.test.ts
//
// THE AUDIO-PROFILE GATE (owner decision §6b.1 — "gate"; spec:
// .myrobots/plans/art-backfill-audio-profiles-2026-07-01.md).
//
// Registry-sweep: EVERY audio-domain module def must have ≥1 committed ART
// audio-profile baseline (`art/baselines/<group>/*.f32`, group = kebab-case
// module id) unless it is structurally excluded (ART_EXCLUDED, with a reason)
// or still on the backfill RATCHET (ART_BACKLOG). New audio modules are
// therefore gated IMMEDIATELY; the pre-existing gap only ever SHRINKS.
//
// Registry enumeration comes from the COMMITTED contract golden
// (`packages/web/src/lib/docs/contract-lock.txt` — `<id> meta domain=audio`
// lines). That file is generated from the live registry and its freshness is
// enforced by the required `unit` gate (contract-lock.test.ts), so this sweep
// can never drift from the real def list — and it needs no Vite/SvelteKit
// import machinery in the Node ART lane (same reasoning as the docs
// manifest's ?raw parser).
//
// Like the baseline-uniqueness honesty guard, this is a PURE fs test: no DSP
// build, ~0 CI wall-time, meaningful even on LFS pointer files.

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ART_BACKLOG, ART_BACKLOG_MAX, ART_EXCLUDED } from '../../setup/profile-coverage';
import { moduleIdToBaselineGroup } from '../../setup/capture';

const BASELINES_DIR = fileURLToPath(new URL('../../baselines/', import.meta.url));
const CONTRACT_LOCK = fileURLToPath(
  new URL('../../../packages/web/src/lib/docs/contract-lock.txt', import.meta.url),
);

/** Every audio-domain module id, from the committed contract golden. */
function listAudioModuleIds(): string[] {
  const text = readFileSync(CONTRACT_LOCK, 'utf8');
  const ids: string[] = [];
  for (const line of text.split('\n')) {
    const m = /^(\S+) meta domain=audio\b/.exec(line);
    if (m) ids.push(m[1]!);
  }
  return ids;
}

/** Baseline groups that contain ≥1 committed .f32 (recursive within group). */
function listProfiledGroups(): Set<string> {
  const groups = new Set<string>();
  const hasF32 = (dir: string): boolean =>
    readdirSync(dir, { withFileTypes: true }).some((ent) =>
      ent.isDirectory() ? hasF32(join(dir, ent.name)) : ent.isFile() && ent.name.endsWith('.f32'),
    );
  for (const ent of readdirSync(BASELINES_DIR, { withFileTypes: true })) {
    if (ent.isDirectory() && hasF32(join(BASELINES_DIR, ent.name))) groups.add(ent.name);
  }
  return groups;
}

describe('ART audio-profile coverage gate', () => {
  const moduleIds = listAudioModuleIds();
  const profiled = listProfiledGroups();
  const excludedIds = Object.keys(ART_EXCLUDED);
  const hasProfile = (id: string) => profiled.has(moduleIdToBaselineGroup(id));

  it('sanity: the registry golden + baselines dir are readable and populated', () => {
    expect(existsSync(CONTRACT_LOCK), `missing ${CONTRACT_LOCK}`).toBe(true);
    // 126 audio defs at seed time — a collapse here means the parse broke,
    // not that the registry shrank by half.
    expect(moduleIds.length).toBeGreaterThan(100);
    expect(profiled.size).toBeGreaterThan(0);
  });

  it('every audio module has ≥1 audio-profile baseline, is excluded (with a reason), or is on the ratchet', () => {
    const missing = moduleIds.filter(
      (id) => !hasProfile(id) && !(id in ART_EXCLUDED) && !ART_BACKLOG.includes(id),
    );
    expect(
      missing,
      `${missing.length} audio module(s) have NO committed audio profile and are not excluded/backlogged:\n` +
        missing.map((id) => `  - ${id} (expected art/baselines/${moduleIdToBaselineGroup(id)}/*.f32)`).join('\n') +
        '\nAdd a profile scenario (art/setup/capture.ts + drivers.ts — see art/scenarios/chowkick/profile.test.ts), ' +
        'or add a REASONED entry to ART_EXCLUDED in art/setup/profile-coverage.ts. ' +
        'Do NOT add to ART_BACKLOG — the backlog only shrinks.',
    ).toEqual([]);
  });

  it('RATCHET: a module with a baseline must NOT stay in ART_BACKLOG', () => {
    const stale = ART_BACKLOG.filter((id) => hasProfile(id));
    expect(
      stale,
      `These modules now have committed audio profiles — remove them from ART_BACKLOG ` +
        `(and lower ART_BACKLOG_MAX to the new length):\n${stale.map((id) => `  - ${id}`).join('\n')}`,
    ).toEqual([]);
  });

  it(`RATCHET: ART_BACKLOG can only shrink (cap tracks length exactly, = ${ART_BACKLOG_MAX})`, () => {
    expect(
      ART_BACKLOG.length,
      'ART_BACKLOG grew past the ratchet cap. New modules must ship WITH an audio profile ' +
        '(or a reasoned ART_EXCLUDED entry) — never join the backlog.',
    ).toBeLessThanOrEqual(ART_BACKLOG_MAX);
    // STRICT equality, not just ≤: if the cap merely bounded the length, every
    // batch that shrinks the list would leave HEADROOM a later addition could
    // hide in without touching this file's diff. Requiring MAX === length means
    // adding an id forces a loud, reviewable ART_BACKLOG_MAX bump — and batches
    // are forced to lower the cap as they land (the ratchet clicks).
    expect(
      ART_BACKLOG_MAX,
      `ART_BACKLOG_MAX (${ART_BACKLOG_MAX}) must equal ART_BACKLOG.length ` +
        `(${ART_BACKLOG.length}) — lower the cap with every batch; never leave headroom.`,
    ).toBe(ART_BACKLOG.length);
  });

  it('lists are well-formed: real registry ids, unique, and disjoint', () => {
    const idSet = new Set(moduleIds);
    const ghosts = [...ART_BACKLOG, ...excludedIds].filter((id) => !idSet.has(id));
    expect(ghosts, `list entries that are not audio-domain registry ids: ${ghosts.join(', ')}`).toEqual([]);
    expect(new Set(ART_BACKLOG).size, 'ART_BACKLOG contains duplicates').toBe(ART_BACKLOG.length);
    const overlap = ART_BACKLOG.filter((id) => id in ART_EXCLUDED);
    expect(overlap, `ids in BOTH ART_BACKLOG and ART_EXCLUDED: ${overlap.join(', ')}`).toEqual([]);
  });

  it('exclusions stay honest: an excluded module must not carry a baseline', () => {
    const contradictory = excludedIds.filter((id) => hasProfile(id));
    expect(
      contradictory,
      `These ART_EXCLUDED modules HAVE committed baselines — they are evidently profilable; ` +
        `remove them from ART_EXCLUDED:\n${contradictory.map((id) => `  - ${id}`).join('\n')}`,
    ).toEqual([]);
  });
});
