// packages/web/src/lib/docs/doc-index-from-def.ts
//
// LIVE-REGISTRY adapter for buildDocIndex.
//
// The doc PAGE builds its DocIndex from the prerender-safe regex-parsed
// ManifestModule (it can't import the live registry from a server loader). On
// the CANVAS the live registry IS available, so the on-canvas "Annotate" mode
// resolves a hovered control/port straight from the live AudioModuleDef +
// MODULE_DOCS — but it must produce the SAME flat DocIndex shape so it can reuse
// the exact resolution + presentation pieces (use-doc-hover resolveHover /
// AnnotatePopover). This bridges the live def into the minimal ManifestModule
// slice buildDocIndex actually reads (params / docs / inputs / outputs /
// stereoPairs — NOT the doc-page-only io / description / sourceUrl fields), so
// there is ONE doc-index builder, no second source of truth.

import type { AudioModuleDef } from '$lib/audio/module-registry';
import { buildDocIndex, type DocIndex } from './doc-index';
import type { ManifestModule, ManifestPort, ManifestParam } from './module-manifest';

/**
 * Build the flat, client-resolvable DocIndex for a LIVE module def.
 *
 * Returns null when the def carries no authored `docs` — annotate mode is only
 * offered for documented modules, so callers treat null as "no docs".
 *
 * The live PortDef / ParamDef structurally satisfy the ManifestPort / Param
 * subset buildDocIndex reads (id / type / paramTarget / cvScale / accepts /
 * edge / adoptsUpstreamFrom for ports; id / label / defaultValue / min / max /
 * curve / units for params), so we shim the def into the ManifestModule shape
 * with only those fields populated and let buildDocIndex do the rest.
 */
export function buildDocIndexFromDef(def: AudioModuleDef | undefined): DocIndex | null {
  if (!def?.docs) return null;

  const inputs: ManifestPort[] = def.inputs.map((p) => ({
    id: p.id,
    type: p.type,
    paramTarget: p.paramTarget,
    cvScale: p.cvScale ? { mode: p.cvScale.mode } : undefined,
    accepts: p.accepts ? [...p.accepts] : undefined,
    edge: p.edge,
    adoptsUpstreamFrom: p.adoptsUpstreamFrom,
  }));
  const outputs: ManifestPort[] = def.outputs.map((p) => ({
    id: p.id,
    type: p.type,
    adoptsUpstreamFrom: p.adoptsUpstreamFrom,
  }));
  const params: ManifestParam[] = def.params.map((p) => ({
    id: p.id,
    label: p.label,
    defaultValue: p.defaultValue,
    min: p.min,
    max: p.max,
    curve: p.curve,
    units: p.units,
  }));

  // Only the fields buildDocIndex consumes are populated; the rest of the
  // ManifestModule contract (file / sourceUrl / category / description / io …)
  // is doc-page-only and never read here, so a cast over the partial is safe.
  const mod = {
    type: def.type,
    label: def.label,
    inputs,
    outputs,
    params,
    stereoPairs: def.stereoPairs?.map((pair) => [pair[0], pair[1]] as [string, string]),
    docs: def.docs,
  } as unknown as ManifestModule;

  return buildDocIndex(mod);
}
