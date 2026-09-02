// packages/web/src/lib/ui/modules/peertube-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS for the PEERTUBE faceplate.
//
// Everything here is a claim the shipped face MAKES and that no other gate can
// check. `videobox-face-model.test.ts` and the tvLibrarian suite are the
// template — same audio plumbing, same one-fader face, literally the same
// node-owned HLS controller. What is specific to this module:
//
//   1. ⚠ THE BODY IS THE ONLY SEARCH BOX THAT EXISTS. peertube left
//      `DOM_SOURCE_LANE_TYPES` in LEG-02 P3 (#1511) and is in neither half of
//      `HEADLESS_MOUNT_LANE_TYPES`, so promotion stops the card mounting
//      ANYWHERE. videobox's body rescues a file picker; this one rescues the
//      only way to name a video at all.
//
//   2. ⚠ ONE COMPONENT, TWO MOUNTS. The search box, the roster, the transport,
//      the attribution anchor and the legal disclaimer are `PeerTubePicker`,
//      imported by BOTH surfaces. This module pair has a documented case of
//      correctness travelling by hand-copy and arriving late (the
//      `muted = false` audio trap, #785 -> #786), so the no-drift property is
//      pinned rather than trusted.
//
//   3. THE GLYPH DECISION IS A REAL ONE — this def HAS two audio outputs, so a
//      glyph literal would resolve to a LIVE binding (a VU of the federated
//      video's soundtrack over the module's own picture) and the dead-glyph
//      clause would NOT catch it.
//
//   4. THE BODY MUST NOT ADOPT THE NODE-OWNED `<video>` — one parent, and the
//      legacy card adopts it under `?shell=legacy`. It blits the module's own
//      output instead, which also shows what `gain` does.
//
//   5. A DEAD CONTROL IS DELETED AND ITS TYPE IS DELIBERATELY KEPT. The
//      "instance (optional)" input wrote `node.data.instanceHost` and nothing
//      read it; `PeerTubeData.instanceHost` stays because `peertube-query.ts`
//      is in the WebGL attest basis, where TYPE declarations are not
//      hash-transparent. Both halves pinned, so neither can be undone by
//      accident.
//
//   6. THE VRT ENTRY RESTS ON TWO MEASURED FACTS — a time-invariant idle
//      picture and `autoLoadCatalogue === false` (zero network at spawn).
//      Pinned where the claims are made.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripSourceComments } from '$lib/source-guards/strip-source-comments';
import { peertubeDef } from '$lib/video/modules/peertube';
import { curatedFace, type FaceDefLike } from '$lib/ui/workflow/curated-face';
import { hasVideoSurface } from '$lib/ui/workflow/module-shell-model';
import { STRICT_FACES } from '$lib/ui/workflow/strict-faces';
import {
  noUserControlIds,
  noUserControlProblems,
} from '$lib/ui/workflow/no-user-control';
import type { NoUserControlDefLike } from '$lib/graph/types';
import { PEERTUBE_PROFILE } from '$lib/ui/media/node-hls-source-registry';

const def = peertubeDef as unknown as FaceDefLike & { type: string };

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(HERE, rel), 'utf8');

const defSource = read('../../video/modules/peertube.ts');
const querySource = read('../../video/modules/peertube-query.ts');
const bodySource = read('peertube/PeerTubeBrowseBody.svelte');
const pickerSource = read('peertube/PeerTubePicker.svelte');
const cardSource = read('PeerTubeCard.svelte');

// The code-only views. A raw grep cannot tell code from a comment, and several
// legs below forbid a construct whose natural explanation NAMES it.
const bodyCode = stripSourceComments(bodySource);
const pickerCode = stripSourceComments(pickerSource);
const cardCode = stripSourceComments(cardSource);

/** The LIVE `ParamDef`. */
function param(id: string) {
  const p = peertubeDef.params.find((x) => x.id === id);
  if (!p) throw new Error(`peertube has no param '${id}'`);
  return p;
}

/** The shader body, as the def declares it. */
const fragSrc = /const FRAG_SRC = `([\s\S]*?)`;/.exec(defSource)?.[1] ?? '';

describe('peertube face — promoted, and the tile shows the module', () => {
  it('is promoted', () => {
    expect(STRICT_FACES.has('peertube')).toBe(true);
    expect(def.face).toBeTruthy();
  });

  it("declares glyph 'none' AND still has a live picture", () => {
    expect(def.face?.glyph).toBe('none');
    expect(hasVideoSurface(def)).toBe(true);
  });

  it('the glyph choice is a DECISION, not a forced one — this def HAS audio outputs', () => {
    // The dead-glyph clause enforces 'none' for free only on defs with no
    // `type: 'audio'` output. Here two exist, so a literal would bind LIVE and
    // ship a soundtrack VU competing with the picture, green all the way.
    const audioOuts = peertubeDef.outputs.filter((o) => o.type === 'audio').map((o) => o.id);
    expect(audioOuts).toEqual(['audio_l', 'audio_r']);
  });

  it('owns a fullViewBody extension — without it the module cannot be SEARCHED at all', () => {
    // ⚠ THE STOP-2 ASSERTION. Promotion stops the card mounting, and peertube
    // keeps no off-screen headless host, so this body is the only surface with
    // a search box, a roster or a transport on the whole page.
    expect(def.face?.extension).toBe('peertube');
    expect(bodyCode).toMatch(/PeerTubePicker/);
    expect(pickerCode).toMatch(/data-testid="\{testidPrefix\}-search"/);
    expect(pickerCode).toMatch(/data-testid="\{testidPrefix\}-result"/);
  });
});

describe('peertube face — the tier ladder, and why it is ONE control', () => {
  const keysAt = (t: 'mini' | 'compact' | 'full' | 'dock') =>
    curatedFace(def, t)!.controls.map((c) => c.key);

  it('every tier shows exactly GAIN — the module has one control and says so', () => {
    for (const tier of ['mini', 'compact', 'full', 'dock'] as const) {
      expect(keysAt(tier), `tier ${tier}`).toEqual(['gain']);
    }
  });

  it('neither synthetic param reaches ANY tier', () => {
    // The failure this forbids is concrete: an undeclared `cv_next_trigger`
    // renders as a continuous rotary over a raw gate level, turnable, and
    // stomped by the next bridge write.
    for (const tier of ['mini', 'compact', 'full', 'dock'] as const) {
      expect(keysAt(tier), `tier ${tier}`).not.toContain('cv_play_trigger');
      expect(keysAt(tier), `tier ${tier}`).not.toContain('cv_next_trigger');
    }
  });

  it('declares NO pages, so no tab rail is manufactured', () => {
    expect(def.face?.pages).toBeUndefined();
  });

  it('GAIN is a FADER, because unity is at the MIDDLE of a 0..2 throw', () => {
    expect(def.face?.paramCells?.gain).toBe('fader');
    const gain = param('gain');
    expect(gain.min).toBe(0);
    expect(gain.max).toBe(2);
    expect(gain.defaultValue).toBe(1);
    expect((gain.defaultValue - gain.min) / (gain.max - gain.min)).toBeCloseTo(0.5, 10);
  });
});

describe('the ranked cell is HONEST — the shader really reads `gain`', () => {
  it('FRAG_SRC declares a uGain uniform and multiplies the sample by it', () => {
    expect(fragSrc).toMatch(/uniform float uGain;/);
    expect(fragSrc).toMatch(/texture\(uTex, vUv\)\.rgb \* uGain/);
  });

  it('draw() pushes the param into that uniform', () => {
    expect(stripSourceComments(defSource)).toMatch(/uniform1f\(uGain, params\.gain\)/);
  });
});

describe('the noUserControl declaration, driven in BOTH directions', () => {
  const nucDef = peertubeDef as unknown as NoUserControlDefLike;

  it('declares exactly the two synthetic params, and neither is ranked', () => {
    expect([...noUserControlIds(nucDef)].sort()).toEqual(['cv_next_trigger', 'cv_play_trigger']);
    const ranked = def.face?.order ?? [];
    expect(ranked).not.toContain('cv_play_trigger');
    expect(ranked).not.toContain('cv_next_trigger');
  });

  it("the declaration is SOUND against peertube's own ports (positive control)", () => {
    expect(noUserControlProblems(nucDef)).toEqual([]);
  });

  it('every param is EITHER ranked OR declared — nothing falls through', () => {
    const ranked = new Set(def.face?.order ?? []);
    const declared = noUserControlIds(nucDef);
    const orphans = peertubeDef.params
      .map((p) => p.id)
      .filter((id) => !ranked.has(id) && !declared.has(id));
    expect(orphans).toEqual([]);
  });

  it("REJECTS writer 'internal' on cv_next_trigger — a port DOES target it", () => {
    const problems = noUserControlProblems({
      ...nucDef,
      noUserControl: [
        { param: 'cv_play_trigger', writer: 'cv-port', why: 'y'.repeat(40) },
        { param: 'cv_next_trigger', writer: 'internal', why: 'y'.repeat(40) },
      ],
    } as NoUserControlDefLike);
    expect(problems.join('\n')).toMatch(/internal/);
  });
});

describe('⚠ ONE PICKER, TWO MOUNTS — the no-drift property, pinned', () => {
  it('BOTH surfaces import the SAME picker component', () => {
    // The alternative is two copies, and this module pair has a documented
    // instance of correctness travelling by hand-copy and arriving a day late.
    expect(cardCode).toMatch(/from '\.\/peertube\/PeerTubePicker\.svelte'/);
    expect(bodyCode).toMatch(/from '\.\/PeerTubePicker\.svelte'/);
  });

  it('the CARD no longer carries its own search box, roster or disclaimer', () => {
    // If any of these came back the two surfaces would be free to diverge
    // again, and a strict locator would break the moment both mount.
    for (const marker of [
      'data-testid="peertube-search"',
      'data-testid="peertube-result"',
      'data-testid="peertube-results"',
      'data-testid="peertube-disclaimer"',
      'data-testid="peertube-play"',
    ]) {
      expect(cardCode, `the card re-grew ${marker}`).not.toContain(marker);
    }
  });

  it('the picker takes node.data LEAVES, never the enclosing `data` object', () => {
    // ⚠ The Yjs proxy-identity trap: `patch.nodes[id].data` never changes
    // identity, so a child `$derived` that stops at `.data` never re-runs.
    // Passing `data` "works" in the card and silently breaks the body.
    expect(pickerCode).toMatch(/selectedHost: string \| null;/);
    expect(pickerCode).toMatch(/uuid: string \| null;/);
    expect(pickerCode).not.toMatch(/data:\s*(Partial<)?PeerTubeData/);
    expect(bodyCode).toMatch(/<PeerTubePicker \{nodeId\} \{selectedHost\} \{uuid\} \/>/);
  });
});

describe('⚠ THE RATE LIMITER MOVED WITH THE BOX, refusal message and all', () => {
  it('keeps the ~50 calls / 10 s window', () => {
    expect(pickerCode).toMatch(/RATE_WINDOW_MS = 10_000/);
    expect(pickerCode).toMatch(/RATE_MAX = 50/);
  });

  it('SAYS it refused — a held-down key must not be a silent no-op', () => {
    expect(pickerSource).toMatch(/Slow down — too many searches/);
  });

  it('keeps the 350 ms debounce and the Enter short-circuit', () => {
    expect(pickerCode).toMatch(/setTimeout\(\(\) => \{ runSearch\(\); \}, 350\)/);
    expect(pickerCode).toMatch(/ev\.key === 'Enter'/);
  });

  it('rehydrates the persisted searchTerm at mount', () => {
    // Without it a reloaded rack shows an empty box while the persisted term
    // still drives `advance()`'s on-demand fetch — an input that lies.
    expect(pickerCode).toMatch(/onMount\(\(\) => \{[\s\S]{0,240}searchTerm = t;/);
  });
});

describe('⚠ THE BODY BLITS AND NEVER ADOPTS THE NODE-OWNED <video>', () => {
  it('never calls nodeMedia.adopt — one element, one parent', () => {
    // The legacy card adopts it under `?shell=legacy` or in a dock rail mount;
    // a second adopter would move it out from under that mount.
    expect(bodyCode).not.toMatch(/nodeMedia/);
    expect(bodyCode).not.toMatch(/\badopt\(/);
  });

  it('blits the module OWN output, which is what `gain` scales', () => {
    expect(bodyCode).toMatch(/blitOutputForPreview\(nodeId\)/);
  });

  it('the CARD still adopts — the legacy surface is unchanged in that respect', () => {
    expect(cardCode).toMatch(/nodeMedia\.adopt\(id, HLS_SOURCE_SLOT/);
  });

  it('neither surface owns the stream: no attach, no hls teardown, no extras read', () => {
    for (const [name, code] of [['body', bodyCode], ['card', cardCode], ['picker', pickerCode]] as const) {
      expect(code, name).not.toMatch(/attachExternalSource/);
      expect(code, name).not.toMatch(/destroyNodeHls|teardownHls/);
      expect(code, name).not.toMatch(/read\(\s*\w+\s*,\s*'extras'\s*\)/);
    }
  });
});

describe('⚠ SCREEN ON/OFF — collapses the COPY, never the producer', () => {
  it('persists on the shared node.data key, tracked', () => {
    expect(bodyCode).toMatch(/previewCollapsed/);
    expect(bodyCode).toMatch(/mutateNode\(nodeId/);
  });

  it('KEEPS MARKING THE NODE WATCHED while collapsed', () => {
    // ⚠ peertube is a SOURCE feeding video AND audio_l/audio_r. A lapsed watch
    // mark drops the node from the pull set, so the picture every downstream
    // consumer samples would idle while the element went on decoding.
    expect(bodyCode).toMatch(/if \(previewCollapsed\) \{[\s\S]{0,200}markWatched\(nodeId\)/);
  });

  it('never consults the stream — SCREEN is not a transport control', () => {
    const drawFn = /function draw\(\)[\s\S]*?\n  \}/.exec(bodyCode)?.[0] ?? '';
    expect(drawFn.length).toBeGreaterThan(200);
    expect(drawFn).not.toMatch(/nodeHlsSource|togglePlay|pause/);
  });
});

describe('⚠ THE DEAD instanceHost CONTROL IS GONE — and its TYPE deliberately is not', () => {
  it('no surface writes node.data.instanceHost any more', () => {
    for (const [name, code] of [['body', bodyCode], ['card', cardCode], ['picker', pickerCode]] as const) {
      expect(code, name).not.toContain('instanceHost');
    }
  });

  it('nothing in the query core ever read it — the reason it could go', () => {
    // `buildSearchUrl(query, { count, start })` takes no host, and the profile's
    // `fetchCatalogue` never looks at `data`. Pinned at the signature so a
    // future host-scoped search has to come back through this test.
    const queryCode = stripSourceComments(querySource);
    expect(queryCode).toMatch(/export function buildSearchUrl\(query: string, opts: SearchOpts = \{\}\)/);
    const buildFn = /export function buildSearchUrl[\s\S]*?\n\}/.exec(queryCode)?.[0] ?? '';
    expect(buildFn.length).toBeGreaterThan(120);
    expect(buildFn).not.toContain('instanceHost');
    expect(buildFn).not.toContain('host');
  });

  it('the PeerTubeData FIELD survives, because deleting it would buy a GPU re-attest', () => {
    // `peertube-query.ts` is in the WebGL attest basis and TYPE declarations
    // are deliberately NOT hash-transparent there (scripts/attest-code-basis.ts,
    // "WHAT IS STILL HASHED"). The key also still sits in saved racks.
    expect(querySource).toMatch(/instanceHost: string;/);
    expect(querySource).toMatch(/VESTIGIAL AND DELIBERATELY NOT DELETED/);
  });

  it('the def docs no longer claim an instance scopes the search', () => {
    const explanation = peertubeDef.docs?.explanation ?? '';
    expect(explanation.length).toBeGreaterThan(400);
    expect(explanation).not.toMatch(/instance host|instance-host|scoped to one instance/i);
  });
});

describe('⚠ THE DELETED READOUT AND THE KEPT ATTRIBUTION', () => {
  it('the now-playing NAME is gone from BOTH surfaces', () => {
    for (const [name, code] of [['body', bodyCode], ['card', cardCode], ['picker', pickerCode]] as const) {
      expect(code, name).not.toContain('peertube-now-playing');
    }
  });

  it('the identity survives on the picture accessible name, on BOTH surfaces', () => {
    for (const [name, code] of [['body', bodyCode], ['card', cardCode]] as const) {
      expect(code, name).toMatch(/aria-label=\{pictureLabel\}/);
      expect(code, name).toMatch(/role="img"/);
    }
  });

  it('⚠ it is sourced from selectionLabel, NOT from a highlighted roster row', () => {
    // The one place this differs from tvLibrarian's identical deletion:
    // `autoLoadCatalogue` is FALSE here, so a reloaded rack restores a
    // selection with an EMPTY catalogue and no row to highlight. Pinned
    // together so the two facts cannot drift apart.
    expect(PEERTUBE_PROFILE.autoLoadCatalogue).toBe(false);
    for (const [name, code] of [['body', bodyCode], ['card', cardCode]] as const) {
      expect(code, name).toMatch(/src\.selectionLabel/);
    }
  });

  it('the per-video attribution ANCHOR survives — a control, not a readout', () => {
    expect(pickerCode).toMatch(/watchUrl\(selectedHost, uuid\)/);
    expect(pickerCode).toMatch(/data-testid="\{testidPrefix\}-watch-link"/);
    expect(pickerCode).toMatch(/rel="noopener noreferrer"/);
  });

  it('the PeerTube / Sepia Search legal disclaimer survives', () => {
    expect(pickerSource).toMatch(/joinpeertube\.org/);
    expect(pickerSource).toMatch(/sepiasearch\.org/);
  });
});

describe('⚠ THE VRT ARGUMENT, pinned where the claims are made', () => {
  it('the idle picture is a pure function of position — no clock, no accumulator', () => {
    const idle = /if \(uHasInput < 0\.5\) \{([\s\S]*?)\}/.exec(fragSrc)?.[1] ?? '';
    expect(idle).toMatch(/vUv\.y \* 0\.06/);
    expect(idle).toMatch(/vec4\(0\.05, 0\.04, 0\.09 \+ v, 1\.0\)/);
    // The only uniforms the shader has are the sampler, the has-input flag and
    // a declared param. Nothing time-varying can reach the idle branch.
    const uniforms = [...fragSrc.matchAll(/^uniform .*? (\w+);/gm)].map((m) => m[1]).sort();
    expect(uniforms).toEqual(['uGain', 'uHasInput', 'uTex']);
  });

  it('a fresh spawn issues ZERO network requests — stronger than tvLibrarian', () => {
    // tvLibrarian needs `__tvLibrarianTestCountries` because its picker fetches
    // a roster AT MOUNT. peertube fetches only on a search, so its face scenes
    // need no simPin at all.
    expect(PEERTUBE_PROFILE.autoLoadCatalogue).toBe(false);
    expect(pickerCode).not.toMatch(/onMount\([\s\S]{0,400}fetch/);
  });
});
