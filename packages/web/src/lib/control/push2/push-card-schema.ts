// packages/web/src/lib/control/push2/push-card-schema.ts
//
// WHICH eight controls a module's PUSH CARD shows — the resolver behind
// push-card-config.ts. PURE: it reads only the passed def (its `face`,
// `params`, `controlFamilies`), so it is node-testable with no DOM, no
// registry and no engine.
//
// Three tiers, first match wins (the owner-facing statement of this ladder
// lives in push-card-config.ts — keep the two in step):
//
//   1. OVERRIDE — a `PUSH_CARD_CONTROLS` entry. REPLACES, never merges.
//   2. FACE     — the first 8 TURNABLE params of `face.order`, the same
//                 curated ranking the lane tile and dock faceplate use.
//   3. GENERIC  — declaration order, plain on/off switches demoted to the tail.
//                 This is the "general audio module" / "general video module"
//                 card: ONE rule for both domains (the domain is carried on the
//                 spec so the card can style itself, but it never changes WHICH
//                 controls are chosen — two selection rules would be two things
//                 to keep in sync for no gain).
//
// WHY THE FACE TIER READS `curatedFace`, NOT `face.order` DIRECTLY: re-parsing
// the ranking here would let the Push card and the dock disagree about what the
// ranking even means (which keys are params vs families vs static buttons).
// Going through the shell's own selector inherits its key resolution and its
// tests, so the push card cannot drift from the tile. Same reason the bar math
// in push-card-model.ts goes through `knobValueToFrac`.
//
// SKIP, DON'T STRETCH: a face key that is not a turnable param (a preset
// family, a static button, a declared momentary press-pad, a degenerate range)
// is SKIPPED and recorded in `spec.skipped` — the scan then keeps walking the
// ranking for the next real param. Recording them is what lets a test assert
// WHICH keys were dropped instead of watching the card silently shrink.

import type { ParamDef, NoUserControlParam } from '$lib/graph/types';
import { curatedFace, type FaceDefLike } from '$lib/ui/workflow/curated-face';
import { momentaryParamIds } from '$lib/ui/workflow/shell-control-kind';
import { looksLikeToggle } from '$lib/graph/group-controls';
import { PUSH_CARD_CONTROLS } from './push-card-config';

/** Strips on a push card = display encoders on a Push 2. Fixed by hardware. */
export const PUSH_CARD_SLOTS = 8;

/** Which tier answered. Surfaced so the card can say so and a test can pin it. */
export type PushCardSource = 'override' | 'face' | 'generic';

/** One strip of a push card: a turnable param, or a deliberately blank slot.
 *  A blank slot is the COMMON case, not an error — 9 of the 17 curated modules
 *  have fewer than 8 controls in total. */
export type PushCardSlot =
  | { kind: 'param'; paramId: string; label: string; param: ParamDef }
  | { kind: 'empty' };

/** The resolved control roster for one module type. */
export interface PushCardSpec {
  moduleType: string;
  /** 'audio' | 'video' | 'meta' — presentation only (header hue / subtitle).
   *  It NEVER changes which controls are selected. */
  domain: string;
  source: PushCardSource;
  /** ALWAYS length PUSH_CARD_SLOTS — padded with `{ kind: 'empty' }`. */
  slots: readonly PushCardSlot[];
  /** Keys examined while filling the window and rejected (a control family, a
   *  static button, a declared momentary pad, a degenerate range, an override
   *  id that does not resolve). Keys BEYOND the window are simply never
   *  reached and are not listed. */
  skipped: readonly string[];
}

/** The minimum a def must expose to resolve a push card. Satisfied by
 *  AudioModuleDef / VideoModuleDef / MetaModuleDef and by a hand-built test
 *  fixture — deliberately structural so this file imports no registry. */
export interface PushCardDefLike extends FaceDefLike {
  type: string;
  domain?: string;
  label?: string;
  category?: string;
  params?: readonly ParamDef[];
  /** #1726 — params the module gives the player NO control over. An encoder is
   *  a control, so none of these may reach a strip; see `noControlOf` below. */
  noUserControl?: readonly NoUserControlParam[];
}

/**
 * #1726 — the params NO tier may put under an encoder, because the module has
 * declared that a player never sets them (a synthetic gate param a CV bridge
 * writes; a determinism toggle). They are `isTurnable` — the six on `backdraft`
 * are 0..1 `curve: 'linear'` — so nothing else in this file can see them, and
 * `looksLikeToggle` cannot either: they would rank as CONTINUOUS params and
 * take an encoder ahead of real switches.
 *
 * ⚠ Checked in ALL THREE tiers, including `override`. An override REPLACES the
 * ranking, so it is exactly where a bad id would otherwise get through — and
 * `push-card-schema.test.ts` reddens on an override naming one, the same way it
 * reddens on a typo.
 */
function noControlOf(def: PushCardDefLike): ReadonlySet<string> {
  return new Set((def.noUserControl ?? []).map((e) => e.param));
}

/**
 * Can this param drive a bar graph AND an encoder at all? A range with no
 * width has no bar position to draw and no direction to turn — every value
 * maps to the same pixel, so the strip would be a lie. (No shipped module has
 * one today; the check is what keeps that true.)
 */
export function isTurnable(p: ParamDef): boolean {
  return Number.isFinite(p.min) && Number.isFinite(p.max) && p.max > p.min;
}

// ── Runtime typo guard (layer 2; the unit gate is layer 1) ─────────────────
// An override id that does not resolve is dropped with ONE warning per
// (module, id) and leaves a blank strip — a config typo must never blank the
// whole screen. push-card-schema.test.ts makes this path unreachable in a
// shipped build; it exists so a hand-edit in a running dev session degrades
// legibly instead of silently.
const warned = new Set<string>();

function warnBadOverride(type: string, id: string, params: readonly ParamDef[]): void {
  const key = `${type}|${id}`;
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(
    `[push-card-config] ${type} → unknown or unturnable control '${id}' (strip left blank).\n` +
      `  valid params: ${params.map((p) => p.id).join(', ') || '(none)'}`,
  );
}

/** TEST-ONLY: clear the once-per-(module,id) warning cache so a spec can
 *  observe the warning deterministically regardless of file order. */
export function resetPushCardWarnings(): void {
  warned.clear();
}

// ── The three tiers ────────────────────────────────────────────────────────

function pad(picked: readonly ParamDef[]): PushCardSlot[] {
  const slots: PushCardSlot[] = picked.map((p) => ({
    kind: 'param' as const,
    paramId: p.id,
    label: p.label,
    param: p,
  }));
  while (slots.length < PUSH_CARD_SLOTS) slots.push({ kind: 'empty' });
  return slots;
}

/** Tier 1 — the owner's text config. Replaces; never merges. */
function overrideControls(
  def: PushCardDefLike,
  ids: readonly string[],
  momentary: ReadonlySet<string>,
  noControl: ReadonlySet<string>,
  skipped: string[],
): ParamDef[] {
  const params = def.params ?? [];
  const byId = new Map(params.map((p) => [p.id, p]));
  const picked: ParamDef[] = [];
  const taken = new Set<string>();
  for (const id of ids.slice(0, PUSH_CARD_SLOTS)) {
    const p = byId.get(id);
    if (!p || momentary.has(id) || noControl.has(id) || !isTurnable(p) || taken.has(id)) {
      skipped.push(id);
      warnBadOverride(def.type, id, params);
      continue;
    }
    taken.add(id);
    picked.push(p);
  }
  return picked;
}

/** Tier 2 — the curated `face.order` ranking, turnable params only. */
function faceControls(
  def: PushCardDefLike,
  momentary: ReadonlySet<string>,
  noControl: ReadonlySet<string>,
  skipped: string[],
): ParamDef[] | null {
  // 'dock' = the tier that resolves EVERY ranked key (the lane tiers cap at
  // 2/3/6), so the walk sees the whole ranking and can skip past non-params.
  const face = curatedFace(def, 'dock');
  if (!face) return null;
  const byId = new Map((def.params ?? []).map((p) => [p.id, p]));
  const picked: ParamDef[] = [];
  for (const c of face.controls) {
    if (picked.length >= PUSH_CARD_SLOTS) break;
    const p = c.kind === 'param' && c.paramId ? byId.get(c.paramId) : undefined;
    if (!p || momentary.has(p.id) || noControl.has(p.id) || !isTurnable(p)) {
      skipped.push(c.key);
      continue;
    }
    picked.push(p);
  }
  return picked;
}

/**
 * Tier 3 — the GENERIC card, for both domains.
 *
 * DECLARATION ORDER IS THE RANKING. `def.params` is an ARRAY (`ParamSchema =
 * Readonly<ParamDef[]>`), never an object whose key order could vary, and
 * module authors put the important params first — so this is deterministic by
 * construction and trivially explainable ("it's the order the module declares
 * them").
 *
 * ONE demotion, and it is principled rather than a name guess: a plain 0/1
 * switch sinks below the continuous params, because a bar graph with two
 * states wastes an encoder that a real value could have had. `looksLikeToggle`
 * is the repo's single canonical switch detector (shared with the auto-expose
 * bar, the Toggle primitive and shell-control-kind), so the Push agrees with
 * every other surface about what a switch is. String heuristics like
 * `/_cv_amt$/` were deliberately rejected — filter's own curated face ranks
 * `cutoff_cv_amt` FOURTH, so the humans disagree with that heuristic.
 *
 * `[...continuous, ...switches]` rather than `.sort()`: concatenation has no
 * stability question to argue about.
 */
function genericControls(
  def: PushCardDefLike,
  momentary: ReadonlySet<string>,
  noControl: ReadonlySet<string>,
  skipped: string[],
): ParamDef[] {
  const usable: ParamDef[] = [];
  for (const p of def.params ?? []) {
    if (momentary.has(p.id) || noControl.has(p.id) || !isTurnable(p)) {
      skipped.push(p.id);
      continue;
    }
    usable.push(p);
  }
  const continuous = usable.filter((p) => !looksLikeToggle(p));
  const switches = usable.filter((p) => looksLikeToggle(p));
  return [...continuous, ...switches].slice(0, PUSH_CARD_SLOTS);
}

/**
 * Resolve the push card control roster for a module def.
 *
 * `overrides` is injectable so the resolver itself is testable without the
 * shipped config (and so a future per-rack override table can slot in).
 *
 * FALL-THROUGH RULE: a tier that yields ZERO turnable controls is not an
 * answer — an override whose every id is a typo, or a face whose whole ranking
 * is preset families, falls through to the next tier rather than shipping a
 * blank card. A module with genuinely no turnable params ends at `generic`
 * with eight empty slots, which the model renders as "no turnable controls".
 */
export function resolvePushCardControls(
  def: PushCardDefLike,
  overrides: Readonly<Record<string, readonly string[]>> = PUSH_CARD_CONTROLS,
): PushCardSpec {
  const momentary = momentaryParamIds(def);
  const noControl = noControlOf(def);
  const domain = def.domain ?? 'audio';

  const ids = overrides[def.type];
  if (ids && ids.length) {
    const skipped: string[] = [];
    const picked = overrideControls(def, ids, momentary, noControl, skipped);
    if (picked.length) {
      return { moduleType: def.type, domain, source: 'override', slots: pad(picked), skipped };
    }
  }

  {
    const skipped: string[] = [];
    const picked = faceControls(def, momentary, noControl, skipped);
    if (picked && picked.length) {
      return { moduleType: def.type, domain, source: 'face', slots: pad(picked), skipped };
    }
  }

  const skipped: string[] = [];
  const picked = genericControls(def, momentary, noControl, skipped);
  return { moduleType: def.type, domain, source: 'generic', slots: pad(picked), skipped };
}

/** The param slots of a spec, in encoder order, with the empties removed.
 *  Convenience for callers that want "the N real controls". */
export function pushCardParams(spec: PushCardSpec): ParamDef[] {
  return spec.slots.flatMap((s) => (s.kind === 'param' ? [s.param] : []));
}
