// packages/web/src/lib/ui/modules/mixmstrs-sections.ts
//
// MIXMSTRS' patch-panel SECTION list, extracted from the card so it can be
// tested.
//
// WHY IT LIVES HERE. MIXMSTRS is the only card that HAND-PICKS its port ids by
// name (101 inputs across Ch1..Ch8 / Ret1..Ret2 / Master), and the picker
// SILENTLY DROPS an id the def does not declare:
//
//     ids.map((id) => byId.get(id)).filter((p) => p !== undefined)
//
// A typo, a renamed port, or a channel count change therefore removes a jack
// from the panel and NOTHING goes red — the panel just renders one row fewer.
// Inside a `.svelte` file that list is unreachable from the unit lane, so the
// only gate was "somebody notices a missing jack". Pulling the builder into a
// module makes it a testable artifact: `mixmstrs-sections.test.ts` asserts
// every picked id resolves AND counts the rendered rows per section.
//
// PURE — no Svelte, no registry lookup beyond the def it is handed.

import type { PortDef } from '$lib/graph/types';
import type { PortDescriptor } from '$lib/ui/patch-panel-labels';

export interface MixmstrsSection {
  label: string;
  inputs?: PortDescriptor[];
  outputs?: PortDescriptor[];
}

/** An id the section list asked for that the def does not declare. Returned
 *  rather than thrown so the CARD still renders (a missing jack is bad, a
 *  blank card is worse) and the TEST is what makes it red. */
export interface MixmstrsSectionPlan {
  sections: MixmstrsSection[];
  /** `<section>:<direction>:<portId>` for every dropped pick. Empty in a
   *  healthy tree; the gate asserts exactly that. */
  missing: string[];
}

interface MixmstrsDefLike {
  inputs: readonly PortDef[];
  outputs: readonly PortDef[];
}

/**
 * Build MIXMSTRS' sections from the live def.
 *
 * The rows are RAW per-leg descriptors — `ch1L` and `ch1R` are both here.
 * PatchPanel collapses derived stereo pairs centrally, so this list stays a
 * faithful statement of "which ports belong to which strip" and the card needs
 * no knowledge of stereo at all.
 */
export function mixmstrsSectionPlan(
  def: MixmstrsDefLike,
  channels: readonly number[],
  returns: readonly number[],
): MixmstrsSectionPlan {
  const inputById = new Map<string, PortDescriptor>(
    def.inputs.map((p) => [p.id, { id: p.id, cable: p.type as string }] as const),
  );
  const outputById = new Map<string, PortDescriptor>(
    def.outputs.map((p) => [p.id, { id: p.id, cable: p.type as string }] as const),
  );
  const missing: string[] = [];

  const pick = (
    by: Map<string, PortDescriptor>,
    ids: readonly string[],
    where: string,
    direction: 'input' | 'output',
  ): PortDescriptor[] => {
    const out: PortDescriptor[] = [];
    for (const id of ids) {
      const p = by.get(id);
      if (!p) {
        missing.push(`${where}:${direction}:${id}`);
        continue;
      }
      out.push(p);
    }
    return out;
  };

  const sections: MixmstrsSection[] = [
    ...channels.map((ch) => ({
      label: `Ch${ch}`,
      inputs: pick(
        inputById,
        [
          `ch${ch}L`,
          `ch${ch}R`,
          `ch${ch}_volume`,
          `ch${ch}_low`,
          `ch${ch}_mid`,
          `ch${ch}_high`,
          `ch${ch}_thresh`,
          `ch${ch}_ratio`,
          `ch${ch}_compEnable`,
          `comp${ch}`,
          `ch${ch}_send1`,
          `ch${ch}_send2`,
        ],
        `Ch${ch}`,
        'input',
      ),
    })),
    // Each aux RETURN is a strip of its own (volume + 3-band EQ), so it gets
    // its own patch-panel section instead of four bare jacks under Master.
    ...returns.map((r) => ({
      label: `Ret${r}`,
      inputs: pick(
        inputById,
        [`ret${r}L`, `ret${r}R`, `ret${r}_volume`, `ret${r}_low`, `ret${r}_mid`, `ret${r}_high`],
        `Ret${r}`,
        'input',
      ),
    })),
    {
      label: 'Master',
      inputs: pick(
        inputById,
        ['master_volume', 'send1Pre', 'send2Pre'],
        'Master',
        'input',
      ),
      outputs: pick(
        outputById,
        ['masterL', 'masterR', 'send1L', 'send1R', 'send2L', 'send2R'],
        'Master',
        'output',
      ),
    },
  ];

  return { sections, missing };
}
