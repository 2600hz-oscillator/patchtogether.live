// packages/web/src/lib/audio/modules/livecode.ts
//
// LIVECODE — text-DSL module that spawns + patches modules from a small
// scripting language. The module itself has NO audio I/O — it's a side
// tool that mutates the rack via the patch graph. Card UI lives in
// LivecodeCard.svelte; the parser/evaluator live in $lib/livecode.
//
// We register it in the AUDIO domain (rather than inventing a new one)
// because the existing PatchEngine dispatches by domain — and the rack
// already requires an audio engine, so reusing it keeps the boot path
// uncomplicated. The factory returns a no-op handle (no AudioNode work).
//
// Inputs: none.
// Outputs: none.
// Params: none. (User-edited source code lives in node.data.source, not as a ParamDef.)

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';

export const livecodeDef: AudioModuleDef = {
  type: 'livecode',
  palette: { top: 'livecode', sub: 'livecode' },
  domain: 'audio',
  label: 'livecode',
  category: 'utilities',

  // No I/O. The card body holds the editor + run button + output log.
  // The io-spec-consistency e2e test allows zero-port modules.
  inputs: [],
  outputs: [],

  // No knob-driven params. The script text and the last run's outcome live on
  // `node.data` (`text`, `lastRun`) so they survive a remount and sync to
  // rack-mates via Y.Doc.
  params: [],

  // ⚠ ONE FAMILY, AND THE COUNT IS FORCED BY THE RESOLVER. `resolveFaceControl`
  // resolves a face key to a PARAM id, a family TEMPLATE (`<id>-{n}`) or a legend
  // STATIC — and this def declares `params: []`, so RUN can only reach the plate
  // as a family. ⚠ NO SURFACE EMITS `livecode-run` AS A LITERAL — MEASURED.
  // `ModuleShell` stamps a family generically from this declaration, so
  // module-docs-lint holds it through the CELL arm (`livecode-run-{n}` ranked
  // on the face plan and resolving to a live shell cell), never through a
  // source grep.
  //
  // ⚠ NEITHER THE BUFFER NOR THE LOG IS A FAMILY, and declaring one for either
  // would be the mistake. A family is a promise to RANK, and module-face-lint
  // requires every declared family to appear in `face.order` AND render exactly
  // one cell — so declaring them here would force a text document and a console
  // into cell kinds that do not exist. Both ride the extension body.
  controlFamilies: [
    { id: 'livecode-run', label: 'Run', kind: 'other', testidPrefix: 'livecode-run' },
  ],

  docs: {
    explanation:
      "A live-coding module: a small JavaScript sandbox that builds and patches the rack from text. Its faceplate is a code editor with an output log and a RUN control; the script can spawn modules, set parameters, and wire cables, and it can register clocked(division, fn) callbacks that run in time with the rack clock (each one spawns its own CLOCKED runner module, which then keeps firing on its own whether or not anything is open). It has no audio jacks of its own — it's a side tool that mutates the patch graph, and its changes sync to other people in the rackspace through the shared document like any other edit. The script itself and the last run's outcome are saved with the patch, so reopening a rack shows you both. It's registered in the audio domain only because the rack already has an audio engine; its factory does no audio work.",
    controls: {
      'livecode-run-{n}':
        "Evaluates the script in the editor and applies whatever it produced to the rack, in ONE transaction — so a script that spawns five modules and wires them together is a single undo away from never having happened. Anything the script printed with log() lands in the output pane above, and a script that throws reports the failing line and column on this control's own accessible name rather than in the rack. A partial failure keeps what already landed: if the script created three modules and then hit a bad patch() pair, the three stay, which is usually what you want while you are still writing it. Because RUN is ranked rather than buried in the editor, it is also on the module\'s lane tile — so re-running a script you have already written is one click from the rack, without opening anything.",
    },
  },

  // ── THE FACEPLATE (PF-20) ───────────────────────────────────────────────
  //
  // WHAT IT IS FOR, IN ONE PARAGRAPH. Every other module in the fleet is a thing
  // you patch; this one is a thing that patches. Its subject is THE RACK — it
  // spawns modules, names them, sets their params and draws their cables from
  // text, and the one thing only it does is let a musician build a patch
  // FASTER THAN BY HAND and rebuild it identically later. The verb a player
  // performs is RUN: you write the rack you want and then you make it exist.
  //
  // THE LADDER, read back as a sentence: at every tier you get RUN, because a
  // script you have already written is worth re-running from the rack without
  // opening anything; at the dock you additionally get the script itself, the
  // output it printed, and the lamp that says the last run threw.
  //
  // ⚠ RUN IS RANK 1 AND THAT IS THE POINT OF THE PROMOTION, not a nicety. This
  // module's factory is a NO-OP handle — no node, no timer, no subscription — so
  // `runScript` on `LivecodeCard.svelte` was, literally, everything the module
  // did. `migrated(type)` stops BOTH surfaces rendering a promoted module's
  // card, so leaving the gesture there would have deleted the module while every
  // def-reading gate stayed green, because the def has nothing to read. The
  // evaluation now lives in `$lib/ui/modules/livecode-cell-actions.ts` and this
  // cell is one of its three callers. An `action` cell is not dock-restricted
  // (only `panel` is), so it lands on the lane tile too — which is strictly more
  // reachable than before, where running a script meant first discovering that
  // the dock full view exists.
  //
  // ⚠ `glyph: 'none'` IS THE ONLY LITERAL THAT COMPILES INTO A GREEN RUN, for
  // the reason spelled out on this module's own child: `glyphBinding`'s
  // live-audio arms reach through `primaryAudioOutPortId` and `outputs` is
  // EMPTY, 'envelope' needs a/d/s/r params and there are none, so every other
  // literal falls to `{kind:'static'}` — the dead binding module-face-lint
  // reddens by name.
  //
  // ⚠ NO `pages`. One ranked cell is one band, and a section header over a
  // single cell captioned Run adds a ~81 px band to say nothing the cell has not
  // said (the electraControl precedent, which is this exact shape).
  //
  // ⚠ NO `rear` GROUPS: `inputs` and `outputs` are both empty, so there is no
  // jack for a group to name and module-face-lint refuses a group that resolves
  // to no port at all.
  //
  // ⚠ NO HERO. There is one control, so promoting it would EMPTY its band
  // (`heroFacePlan` MOVES the key) and leave a plate with a hero rail and no
  // sections. The run outcome is on the RUN lamp's accessible name, which is
  // where the 2026-08-19 rulings put a measurement.
  //
  // The script buffer, the output log and the RUN lamp are the extension's
  // `fullViewBody` — see $lib/ui/modules/livecode/shell-extension.ts.
  face: {
    glyph: 'none',
    order: ['livecode-run-{n}'],
    extension: 'livecode',
  },

  async factory(_ctx, _node): Promise<AudioDomainNodeHandle> {
    return {
      domain: 'audio',
      inputs: new Map(),
      outputs: new Map(),
      setParam(_paramId, _value) {
        // no-op — LIVECODE has no params
      },
      readParam(_paramId) {
        return undefined;
      },
      dispose() {
        // no-op
      },
    };
  },
};
