// packages/web/src/lib/ui/workflow/param-override-badges.ts
//
// PER-PARAM LIVE-OVERRIDE BADGES for the generic faceplate — the declaration
// that lets a module say "this param's control is currently being IGNORED by
// the engine, show it". First (and so far only) adopter: backdraft's DELAY
// fader, which a patched DELAY CLOCK makes inert entirely (owner ruling: "if
// delay clock is patched this is a case where we should ignore the fader
// entirely"). The legacy card has carried the equivalent CLK badge for months;
// this registry is the faceplate's half of the same fact, driven by the SAME
// predicate, so the two surfaces cannot disagree.
//
// DIMMED, NOT DISABLED — deliberately. The repo's dim ruling (BackdraftCard's
// mode-dim banks): a control that currently does nothing stays draggable,
// resettable and MIDI-learnable; only its LOOK says it is out of the loop. The
// engine is what ignores the writes (backdraftEffectiveDelayMs never reads the
// knob while the clock is patched), so blocking the pointer would add nothing
// but take the context menu and MIDI-learn with it. Unpatching hands control
// back to wherever the fader then sits — including moves made while dimmed.
//
// Deny-by-default in both directions: an entry names its exact (module, param)
// pair, `why` is required by the TYPE, and param-override-badges.test.ts
// anchors every entry to a live def + a real ParamDef, so a rename reddens the
// registry instead of silently orphaning it.
//
// SCOPE, stated so an unstated scope cannot read as full coverage: ModuleShell
// consults this in its FADER cell arm only — the sole adopter is fader-shaped.
// A knob/segmented adopter wires its own arm (and widens this note) then.

import { backdraftDelayClockPatched } from '$lib/ui/modules/backdraft-clocked-delay';

export interface ParamOverrideBadge {
  /** Short badge text painted beside the control while active (e.g. 'CLK'). */
  badge: string;
  /** Hover title explaining the override. */
  title: string;
  /** LIVE predicate — true while the engine is ignoring this control. Callers
   *  pair it with a graph version signal for reactivity. */
  isActive: (nodeId: string) => boolean;
  /** Why this control can be overridden at all — required by the type. */
  why: string;
}

const PARAM_OVERRIDE_BADGES: Record<string, Record<string, ParamOverrideBadge>> = {
  backdraft: {
    delay: {
      badge: 'CLK',
      title:
        'DELAY CLOCK is patched — this fader is ignored entirely: the delay holds, '
        + 'then tracks one clock-pulse duration. Unpatch the clock to hand control '
        + 'back to the fader at its current position.',
      isActive: backdraftDelayClockPatched,
      why:
        'a patched delay_clock cable makes the engine ignore the DELAY fader entirely '
        + '(backdraftEffectiveDelayMs never reads the knob while clocked), so an undimmed '
        + 'fader would silently diverge from the delay the picture actually uses',
    },
  },
};

/** The override declaration for one (module type, param), or null. */
export function paramOverrideBadge(
  moduleType: string,
  paramId: string,
): ParamOverrideBadge | null {
  return PARAM_OVERRIDE_BADGES[moduleType]?.[paramId] ?? null;
}

/** Every registered (module, param) pair — the test anchor. */
export function paramOverrideEntries(): Array<{ moduleType: string; paramId: string; entry: ParamOverrideBadge }> {
  return Object.entries(PARAM_OVERRIDE_BADGES).flatMap(([moduleType, params]) =>
    Object.entries(params).map(([paramId, entry]) => ({ moduleType, paramId, entry })),
  );
}
