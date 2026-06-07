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
  schemaVersion: 1,

  // No I/O. The card body holds the editor + run button + output log.
  // The io-spec-consistency e2e test allows zero-port modules.
  inputs: [],
  outputs: [],

  // No knob-driven params. The card stores its DSL source text and
  // editor state on `node.data` (text, lastError, lastLog) so it
  // syncs to other rack-mates via Y.Doc.
  params: [],

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
