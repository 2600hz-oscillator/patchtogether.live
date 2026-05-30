#!/usr/bin/env node --experimental-strip-types
// scripts/new-module.ts
//
// New-module scaffolder. Emits the smallest typecheck-clean stub for a
// new patchtogether.live module (audio / video / meta domain) and wires
// it into every registry the codebase expects a new module to land in.
//
// Usage:
//   flox activate -- node --experimental-strip-types scripts/new-module.ts \
//       <type> <domain> [options]
//
// <type>    kebab-case module id (e.g. 'compressor', 'mybassdrum',
//           'analog-vco'). Converted to camelCase for the variable name
//           + StandardModuleType union entry, PascalCase for the card
//           component name.
// <domain>  audio | video | meta
//
// Options:
//   --from <existing-type>     clone the registry shape (inputs/outputs/
//                              params) from an EXISTING module def. The
//                              existing def is parsed best-effort with a
//                              tolerant regex (matches the literal-init
//                              pattern the codebase uses); helper-built
//                              shapes abort with a friendly message.
//   --label <UPPERCASE>        display label (default: TYPE in CAPS).
//   --category <name>          category bucket. Audio defaults:
//                              'utility'. Video defaults: 'Sources'.
//                              Meta defaults: 'tools'.
//   --no-card                  skip the ModuleCard.svelte stub.
//   --undo <type>              REMOVE everything a previous run of this
//                              scaffolder added for <type>. Idempotent;
//                              tolerates missing files.
//   --no-typecheck             skip the final `task typecheck` step.
//
// What it emits:
//   1. packages/web/src/lib/<domain>/modules/<file>.ts        (module def)
//   2. packages/web/src/lib/ui/modules/<Type>Card.svelte      (card stub)
//   3. packages/web/src/lib/<domain>/modules/<file>.test.ts   (shape test)
//   4. packages/web/src/lib/docs/module-manifest.ts           (DESCRIPTIONS entry)
//   5. e2e/vrt/vrt-exemptions.ts                              (pending baseline)
//   6. packages/web/src/lib/<domain>/modules/index.ts         (registry)
//   7. packages/web/src/lib/graph/types.ts                    (StandardModuleType)
//   8. packages/web/src/lib/ui/Canvas.svelte                  (card router)
//      + packages/web/src/lib/ui/module-categories.ts         (palette)
//
// Anti-patterns (per Codex finding #12 spec):
//   * The output is COMPILABLE STUBS only. We do not invent worklet code
//     or param math; the human writes those in the follow-up commits.
//   * We never touch files outside the additive edits above. Editing a
//     sibling for --from is explicitly not supported.
//   * No sweep-exempt entry is added — the new module's tests should
//     pass real assertions, and if a sweep needs an exemption for
//     legitimate reasons (silent until gate, etc.) the human adds it
//     explicitly with a reason.

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

// ───────────────────────────────────────────────────────────────────────────
// Repo + path helpers.

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(SCRIPT_DIR, '..');

function rp(...parts: string[]): string {
  return resolvePath(REPO_ROOT, ...parts);
}

// File targets (absolute paths derived from the repo root).
function audioModulePath(type: string): string {
  return rp('packages/web/src/lib/audio/modules', `${type}.ts`);
}
function videoModulePath(type: string): string {
  return rp('packages/web/src/lib/video/modules', `${type}.ts`);
}
function metaModulePath(type: string): string {
  return rp('packages/web/src/lib/meta/modules', `${type}.ts`);
}
function moduleTestPath(domain: Domain, type: string): string {
  return rp(`packages/web/src/lib/${domain}/modules`, `${type}.test.ts`);
}
function moduleSourcePath(domain: Domain, type: string): string {
  if (domain === 'audio') return audioModulePath(type);
  if (domain === 'video') return videoModulePath(type);
  return metaModulePath(type);
}
function cardPath(pascal: string): string {
  return rp('packages/web/src/lib/ui/modules', `${pascal}Card.svelte`);
}
const REGISTRY_PATHS = {
  audio: rp('packages/web/src/lib/audio/modules/index.ts'),
  video: rp('packages/web/src/lib/video/modules/index.ts'),
  meta: rp('packages/web/src/lib/meta/modules/index.ts'),
} as const;
const GRAPH_TYPES_PATH = rp('packages/web/src/lib/graph/types.ts');
const CANVAS_PATH = rp('packages/web/src/lib/ui/Canvas.svelte');
const MODULE_CATEGORIES_PATH = rp('packages/web/src/lib/ui/module-categories.ts');
const MANIFEST_PATH = rp('packages/web/src/lib/docs/module-manifest.ts');
const VRT_EXEMPTIONS_PATH = rp('e2e/vrt/vrt-exemptions.ts');

// ───────────────────────────────────────────────────────────────────────────
// CLI parsing.

type Domain = 'audio' | 'video' | 'meta';

interface ScaffoldOpts {
  type: string;
  domain: Domain;
  label: string;
  category: string;
  fromType: string | null;
  noCard: boolean;
  noTypecheck: boolean;
}

interface UndoOpts {
  type: string;
  noTypecheck: boolean;
}

interface ParsedArgs {
  mode: 'scaffold' | 'undo';
  scaffold?: ScaffoldOpts;
  undo?: UndoOpts;
}

function parseArgs(argv: string[]): ParsedArgs {
  const a = [...argv];
  let undoType: string | null = null;
  let fromType: string | null = null;
  let label: string | null = null;
  let category: string | null = null;
  let noCard = false;
  let noTypecheck = false;
  const positional: string[] = [];

  while (a.length) {
    const tok = a.shift()!;
    switch (tok) {
      case '--undo':
        undoType = a.shift() ?? null;
        if (!undoType) throw new Error('--undo requires a module type id');
        break;
      case '--from':
        fromType = a.shift() ?? null;
        if (!fromType) throw new Error('--from requires an existing module type id');
        break;
      case '--label':
        label = a.shift() ?? null;
        if (!label) throw new Error('--label requires a value');
        break;
      case '--category':
        category = a.shift() ?? null;
        if (!category) throw new Error('--category requires a value');
        break;
      case '--no-card':
        noCard = true;
        break;
      case '--no-typecheck':
        noTypecheck = true;
        break;
      case '-h':
      case '--help':
        printUsage();
        process.exit(0);
      default:
        if (tok.startsWith('--')) throw new Error(`unknown flag: ${tok}`);
        positional.push(tok);
    }
  }

  if (undoType !== null) {
    return { mode: 'undo', undo: { type: undoType, noTypecheck } };
  }

  const [type, domain] = positional;
  if (!type || !domain) {
    printUsage();
    throw new Error('missing required positional args: <type> <domain>');
  }
  if (domain !== 'audio' && domain !== 'video' && domain !== 'meta') {
    throw new Error(`<domain> must be one of audio|video|meta (got: ${domain})`);
  }

  return {
    mode: 'scaffold',
    scaffold: {
      type,
      domain,
      label: label ?? type.replace(/-/g, '').toUpperCase(),
      category: category ?? defaultCategory(domain),
      fromType,
      noCard,
      noTypecheck,
    },
  };
}

function defaultCategory(domain: Domain): string {
  if (domain === 'audio') return 'utility';
  if (domain === 'video') return 'Sources';
  return 'tools';
}

function printUsage(): void {
  console.log(`
new-module.ts — scaffold a new patchtogether.live module

Usage:
  node --experimental-strip-types scripts/new-module.ts <type> <domain> [options]
  node --experimental-strip-types scripts/new-module.ts --undo <type>

Required positional:
  <type>     kebab-case module id (e.g. 'compressor', 'mybassdrum')
  <domain>   audio | video | meta

Options:
  --from <existing-type>   clone inputs/outputs/params verbatim
  --label <UPPERCASE>      display label (default: TYPE in caps)
  --category <name>        palette bucket
  --no-card                skip the ModuleCard.svelte stub
  --no-typecheck           skip the final 'task typecheck' step
  --undo <type>            remove everything the scaffolder added for <type>
`.trim());
}

// ───────────────────────────────────────────────────────────────────────────
// Name conversion helpers. Mirror the conventions already in the registry.

/** kebab-case 'analog-vco' → camelCase 'analogVco'. Single-word ids
 *  pass through ('compressor' → 'compressor'). */
function toCamel(kebab: string): string {
  return kebab.replace(/-([a-z0-9])/g, (_, c) => (c as string).toUpperCase());
}

/** kebab-case 'analog-vco' → PascalCase 'AnalogVco'. */
function toPascal(kebab: string): string {
  const camel = toCamel(kebab);
  return camel.charAt(0).toUpperCase() + camel.slice(1);
}

// ───────────────────────────────────────────────────────────────────────────
// Shape parsing — only used when --from is set. Tolerant regex matching the
// AudioModuleDef / VideoModuleDef literal-init pattern the codebase uses.
// We extract a verbatim slice of the `inputs:`, `outputs:`, and `params:`
// array bodies so the new stub mirrors the source's port surface.

interface ClonedShape {
  inputsBody: string;  // text between [ and ] for inputs, no brackets
  outputsBody: string; // text between [ and ] for outputs
  paramsBody: string;  // text between [ and ] for params
  domain: Domain;      // source's domain (also used for sanity)
  stereoPairs: string | null; // verbatim `[['out_l','out_r']]` or null
  sourceType: string;  // the --from type id (for the cloned-from banner)
}

/** Extract a top-level matched-bracket slice starting AFTER the opening
 *  bracket. Handles nested brackets in nested literals (e.g. `cvScale: {…}`,
 *  `stereoPairs: [['a','b']]`). Returns the text BETWEEN the outermost
 *  pair, exclusive. */
function sliceMatchedBrackets(src: string, openIdx: number, open: string, close: string): {
  body: string;
  endIdx: number;
} {
  if (src[openIdx] !== open) throw new Error(`expected '${open}' at ${openIdx}`);
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return { body: src.slice(openIdx + 1, i), endIdx: i };
    }
  }
  throw new Error(`unmatched '${open}' starting at ${openIdx}`);
}

/** Find the body of a top-level array field `field: [ … ]` inside the def
 *  object literal. Returns null if not found. */
function findArrayField(defBody: string, field: string): string | null {
  // Match `<field>:` followed by optional whitespace then `[`. Tolerates
  // `readonly` modifiers, multi-line layout, and trailing commas.
  const re = new RegExp(`\\b${field}\\s*:\\s*\\[`);
  const m = defBody.match(re);
  if (!m || m.index === undefined) return null;
  const openIdx = defBody.indexOf('[', m.index);
  if (openIdx === -1) return null;
  return sliceMatchedBrackets(defBody, openIdx, '[', ']').body.trim();
}

/** Best-effort clone of an existing module's port + param shape. Aborts
 *  with a helpful message if the source uses helper functions to build
 *  its surface (e.g. mixmstrs, which is mentioned in the manifest header
 *  as a "computed-shape" case). */
function loadCloneShape(fromType: string): ClonedShape {
  // Search across the three module dirs (audio first, then video, then
  // meta) for a file whose default-export def has `type: '<fromType>'`.
  // We accept either kebab-case file name OR camelCase — most modules use
  // kebab-case file with camelCase variable, but a few are kebab-equal
  // to the type id ('compressor.ts').
  for (const domain of ['audio', 'video', 'meta'] as const) {
    const dir = rp('packages/web/src/lib', domain, 'modules');
    // Try a handful of file candidates.
    const fileGuesses = [
      `${fromType}.ts`,
      `${toCamel(fromType)}.ts`,
      // Some modules have dashed filenames whose `type:` is camelCase
      // (e.g. analog-vco.ts → type: 'analogVco'). We do a directory scan
      // fallback if the guesses miss.
    ];
    for (const fname of fileGuesses) {
      const fp = join(dir, fname);
      if (existsSync(fp)) {
        const cloned = tryExtractShape(readFileSync(fp, 'utf8'), fromType, domain);
        if (cloned) return cloned;
      }
    }
    // Directory scan fallback — read every .ts that isn't a test/helper
    // and probe for the matching `type:` line.
    if (existsSync(dir)) {
      for (const ent of readdirSync(dir)) {
        if (!ent.endsWith('.ts') || ent.endsWith('.test.ts')) continue;
        const fp = join(dir, ent);
        const src = readFileSync(fp, 'utf8');
        const typeRe = new RegExp(`type\\s*:\\s*['\"]${fromType}['\"]`);
        if (typeRe.test(src)) {
          const cloned = tryExtractShape(src, fromType, domain);
          if (cloned) return cloned;
        }
      }
    }
  }
  throw new Error(`--from: could not find an existing module with type '${fromType}'`);
}

function tryExtractShape(src: string, fromType: string, domain: Domain): ClonedShape | null {
  // Locate the `export const <name>Def: <DomainModuleDef> = {` opening,
  // then slice to the matching `};`. Tolerant of TS type-annotation /
  // `satisfies` / multi-line declarations.
  const defRe = /export\s+const\s+\w+Def(?:\s*:\s*[A-Z]\w+)?\s*=\s*{/g;
  let m: RegExpExecArray | null;
  while ((m = defRe.exec(src))) {
    const openIdx = src.indexOf('{', m.index);
    if (openIdx === -1) continue;
    const { body } = sliceMatchedBrackets(src, openIdx, '{', '}');
    // Confirm this is the def for the requested type.
    const typeRe = new RegExp(`type\\s*:\\s*['\"]${fromType}['\"]`);
    if (!typeRe.test(body)) continue;

    const inputsBody = findArrayField(body, 'inputs');
    const outputsBody = findArrayField(body, 'outputs');
    const paramsBody = findArrayField(body, 'params');
    if (inputsBody === null || outputsBody === null || paramsBody === null) {
      throw new Error(
        `--from ${fromType}: shape uses computed inputs/outputs/params ` +
        `(helper-built, like mixmstrs). Clone manually + edit the stub.`,
      );
    }

    // stereoPairs is optional. Extract verbatim if present.
    let stereoPairs: string | null = null;
    const spRe = /\bstereoPairs\s*:\s*\[/;
    const spM = body.match(spRe);
    if (spM && spM.index !== undefined) {
      const spOpen = body.indexOf('[', spM.index);
      const spSlice = sliceMatchedBrackets(body, spOpen, '[', ']');
      stereoPairs = `[${spSlice.body}]`;
    }

    return { inputsBody, outputsBody, paramsBody, domain, stereoPairs, sourceType: fromType };
  }
  return null;
}

// ───────────────────────────────────────────────────────────────────────────
// Stub generators.

function defaultInputsBody(): string {
  return `
    // TODO: declare input ports here, e.g.
    //   { id: 'audio',     type: 'audio' },
    //   { id: 'cutoff_cv', type: 'cv', paramTarget: 'cutoff', cvScale: { mode: 'linear' } },
  `.replace(/^\s*\n/, '').trimEnd();
}
function defaultOutputsBody(): string {
  return `
    // TODO: declare output ports here, e.g.
    //   { id: 'out', type: 'audio' },
  `.replace(/^\s*\n/, '').trimEnd();
}
function defaultParamsBody(): string {
  return `
    // TODO: declare params here, e.g.
    //   { id: 'gain', label: 'Gain', defaultValue: 1, min: 0, max: 2, curve: 'linear' },
  `.replace(/^\s*\n/, '').trimEnd();
}

/** When a cloned shape references identifiers we can't resolve (uppercase
 *  module-local constants like RESOFILTER_MAX_MODE), wrap the body in a
 *  block comment + drop in a TODO note. Keeps the file typecheck-clean
 *  while preserving the cloned shape as a guide the human edits. */
function maybeCommentOut(body: string, sourceModule: string | null): { body: string; commented: boolean } {
  if (!sourceModule) return { body, commented: false };
  // Heuristic: any UPPER_SNAKE_CASE bare identifier (presumed to be a
  // module-local constant we can't carry over) → wrap the body in a
  // block comment. We strip:
  //   1. `//` line comments (so doc lines mentioning a constant don't
  //      trigger a spurious false-positive — though false-positives are
  //      safer than false-negatives, this keeps the common case clean).
  //   2. Quoted strings (so port ids like 'AUDIO_OUT' wouldn't trigger,
  //      though we don't actually use those in port ids by convention).
  // We DON'T use a quote-stripping regex like /'[^']*'/g because
  // apostrophes inside `//` comments ('Resonarium's') collapse adjacent
  // strings together and eat the identifier we care about. Stripping
  // the `//` comment first sidesteps that entirely.
  const stripped = body
    .replace(/\/\/[^\n]*/g, '')      // strip line comments
    .replace(/'[^'\n]*'/g, "''")     // strip single-line single-quoted strings
    .replace(/"[^"\n]*"/g, '""');    // strip single-line double-quoted strings
  const upperConstRe = /\b[A-Z][A-Z0-9_]{2,}\b/;
  if (!upperConstRe.test(stripped)) return { body, commented: false };
  const banner =
    `    // ▼ CLONED FROM '${sourceModule}' — contains references to module-local\n` +
    `    // constants that did not carry over. Uncomment + fix references, or\n` +
    `    // rewrite by hand. The stub typechecks as-is so you can iterate.\n` +
    `    /*\n${body}\n    */`;
  return { body: banner, commented: true };
}

function audioStub(type: string, label: string, category: string, shape: ClonedShape | null): string {
  const varName = `${toCamel(type)}Def`;
  const sourceModule = shape?.sourceType ?? null;
  const rawInputs = shape?.inputsBody ?? defaultInputsBody();
  const rawOutputs = shape?.outputsBody ?? defaultOutputsBody();
  const rawParams = shape?.paramsBody ?? defaultParamsBody();
  const inputs = maybeCommentOut(rawInputs, sourceModule).body;
  const outputs = maybeCommentOut(rawOutputs, sourceModule).body;
  const params = maybeCommentOut(rawParams, sourceModule).body;
  const stereo = shape?.stereoPairs ? `\n  stereoPairs: ${shape.stereoPairs},` : '';
  return `// packages/web/src/lib/audio/modules/${type}.ts
//
// ${label} — TODO write a one-line description.
//
// Generated by scripts/new-module.ts. The stub compiles, registers, and
// passes shape tests; the human fills in the worklet + param math.
//
// Inputs: TODO.
// Outputs: TODO.
// Params: TODO.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';

export const ${varName}: AudioModuleDef = {
  type: '${toCamel(type)}',
  domain: 'audio',
  label: '${label}',
  category: '${category}',
  schemaVersion: 1,${stereo}

  inputs: [
${inputs}
  ],
  outputs: [
${outputs}
  ],
  params: [
${params}
  ],

  async factory(ctx, _node): Promise<AudioDomainNodeHandle> {
    // TODO: implement the audio-thread wiring. The minimal handle below
    // keeps the engine happy until the real worklet lands. A
    // ConstantSourceNode at 0 acts as a no-op pass-through node.
    const silence = ctx.createConstantSource();
    silence.offset.value = 0;
    silence.start();
    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>(),
      outputs: new Map<string, { node: AudioNode; output: number }>(),
      setParam(_paramId, _value) {
        // TODO: route ${varName}.params writes into the worklet AudioParams.
      },
      readParam(_paramId) {
        return undefined;
      },
      dispose() {
        try { silence.stop(); } catch { /* */ }
        try { silence.disconnect(); } catch { /* */ }
      },
    };
  },
};
`;
}

function videoStub(type: string, label: string, category: string, shape: ClonedShape | null): string {
  const varName = `${toCamel(type)}Def`;
  const sourceModule = shape?.sourceType ?? null;
  const rawInputs = shape?.inputsBody ?? defaultInputsBody();
  const rawOutputs = shape?.outputsBody ?? defaultOutputsBody();
  const rawParams = shape?.paramsBody ?? defaultParamsBody();
  const inputs = maybeCommentOut(rawInputs, sourceModule).body;
  const outputs = maybeCommentOut(rawOutputs, sourceModule).body;
  const params = maybeCommentOut(rawParams, sourceModule).body;
  return `// packages/web/src/lib/video/modules/${type}.ts
//
// ${label} — TODO write a one-line description.
//
// Generated by scripts/new-module.ts. The stub compiles, registers, and
// passes shape tests; the human fills in the shader + param math.

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle } from '$lib/video/engine';

export const ${varName}: VideoModuleDef = {
  type: '${toCamel(type)}',
  domain: 'video',
  label: '${label}',
  category: '${category}',
  schemaVersion: 1,

  inputs: [
${inputs}
  ],
  outputs: [
${outputs}
  ],
  params: [
${params}
  ],

  async factory(_gl, _node): Promise<VideoNodeHandle> {
    // TODO: build the FBO + program + drawFrame. The stub returns a
    // no-op handle so the engine can reconcile without crashing.
    return {
      domain: 'video',
      drawFrame(_now, _inputs) {
        // no-op until the real shader lands.
      },
      inputs: new Map(),
      outputs: new Map(),
      setParam(_paramId, _value) {
        // TODO
      },
      readParam(_paramId) {
        return undefined;
      },
      dispose() {
        // TODO: delete GL resources here when they exist.
      },
    };
  },
};
`;
}

function metaStub(type: string, label: string, category: string): string {
  const varName = `${toCamel(type)}Def`;
  return `// packages/web/src/lib/meta/modules/${type}.ts
//
// ${label} — TODO write a one-line description. (meta domain — no engine
// binding, no ports.)
//
// Generated by scripts/new-module.ts.

import type { MetaModuleDef } from '$lib/meta/module-registry';

export const ${varName}: MetaModuleDef = {
  type: '${toCamel(type)}',
  domain: 'meta',
  label: '${label}',
  category: '${category}',
  inputs: [],
  outputs: [],
  params: [],
  schemaVersion: 1,
};
`;
}

function shapeTestStub(type: string, domain: Domain): string {
  const varName = `${toCamel(type)}Def`;
  return `// packages/web/src/lib/${domain}/modules/${type}.test.ts
//
// Shape tests for ${varName}. Generated by scripts/new-module.ts.
// Add behavioral assertions (DSP / shader output, param sweeps, etc.)
// as you flesh out the module.

import { describe, it, expect } from 'vitest';
import { ${varName} } from './${type}';

describe('${varName}: shape', () => {
  it('declares the expected meta fields', () => {
    expect(${varName}.type).toBe('${toCamel(type)}');
    expect(${varName}.domain).toBe('${domain}');
    expect(typeof ${varName}.label).toBe('string');
    expect(${varName}.label.length).toBeGreaterThan(0);
    expect(typeof ${varName}.category).toBe('string');
    expect(${varName}.category.length).toBeGreaterThan(0);
    expect(${varName}.schemaVersion).toBeGreaterThanOrEqual(1);
  });

  it('exposes inputs / outputs / params arrays', () => {
    expect(Array.isArray(${varName}.inputs)).toBe(true);
    expect(Array.isArray(${varName}.outputs)).toBe(true);
    expect(Array.isArray(${varName}.params)).toBe(true);
  });

  it('every port has an id + cable type', () => {
    for (const p of [...${varName}.inputs, ...${varName}.outputs]) {
      expect(typeof p.id).toBe('string');
      expect(p.id.length).toBeGreaterThan(0);
      expect(typeof p.type).toBe('string');
      expect(p.type.length).toBeGreaterThan(0);
    }
  });

  it('every param has id + label + numeric range', () => {
    for (const p of ${varName}.params) {
      expect(typeof p.id).toBe('string');
      expect(p.id.length).toBeGreaterThan(0);
      expect(typeof p.label).toBe('string');
      expect(typeof p.defaultValue).toBe('number');
      expect(typeof p.min).toBe('number');
      expect(typeof p.max).toBe('number');
      expect(p.max).toBeGreaterThanOrEqual(p.min);
    }
  });
});
`;
}

function cardStub(type: string, pascal: string, label: string, domain: Domain): string {
  // Skeletal card with PatchPanel scaffold + a data-card-type hook so e2e
  // tests can locate it. We DON'T import the def to read inputs/outputs:
  // the stub keeps the inputs/outputs arrays empty so a brand-new card
  // compiles even with the empty TODO arrays in the matching def. The
  // human edits both files in lockstep.
  const stripeCable = domain === 'video' ? 'video' : 'audio';
  return `<script lang="ts">
  // ${pascal}Card — generated by scripts/new-module.ts. Replace the
  // empty PatchPanel inputs/outputs with the real ones as you flesh
  // out the module def.

  import type { NodeProps } from '@xyflow/svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import ModuleTitle from './ModuleTitle.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';

  let { id, data }: NodeProps = $props();

  // TODO: derive these from \`${toCamel(type)}Def.inputs/outputs\` once the
  // module's ports are filled in. Keeping them empty here is the shape
  // that compiles regardless of the (still-empty) def arrays.
  const inputs: PortDescriptor[] = [];
  const outputs: PortDescriptor[] = [];
</script>

<div class="mod-card ${type}-card" data-card-type="${toCamel(type)}" data-testid="${type}-card">
  <div class="stripe" style="background: var(--cable-${stripeCable});"></div>
  <ModuleTitle {id} {data} defaultLabel="${label}" />
  <PatchPanel nodeId={id} {inputs} {outputs} panelWidth={240}>
    <div class="body">
      <!-- TODO: knobs + per-module UI go here -->
      <div class="todo" data-testid="${type}-todo">${label} — scaffolded; UI TODO</div>
    </div>
  </PatchPanel>
</div>

<style>
  .${type}-card {
    width: 240px;
    min-height: 120px;
    background: #1a1d24;
    color: #ece8e2;
  }
  .body {
    padding: 8px 10px;
    font-family: var(--font-mono, monospace);
    font-size: 0.7rem;
  }
  .todo {
    opacity: 0.7;
  }
</style>
`;
}

// ───────────────────────────────────────────────────────────────────────────
// In-place file editors. Every edit goes through these helpers so the
// undo path can reliably remove what scaffold added.
//
// MARKER convention: every block we append carries a unique
// `// [new-module:<type>]` line as a sentinel for the undo pass. We don't
// modify any existing line in-place except to splice these markers in.

function appendBeforeMatch(filePath: string, pattern: RegExp, block: string): void {
  const src = readFileSync(filePath, 'utf8');
  const m = src.match(pattern);
  if (!m || m.index === undefined) {
    throw new Error(`could not find anchor ${pattern} in ${filePath}`);
  }
  const next = src.slice(0, m.index) + block + src.slice(m.index);
  writeFileSync(filePath, next);
}

function addStandardModuleTypeEntry(type: string): void {
  // Append to the union: insert a new `| '<camel>'` line with a
  // trailing `// [new-module:<type>]` marker comment so the undo pass
  // can remove the SINGLE line it added. Without the marker on the
  // union line itself, undo would have to know how many lines of
  // generated comment were preceeding the union entry — fragile.
  //
  // Anchor: the closing `;` that ends the union, just before
  // `export type ModuleType = StandardModuleType`. We insert our line
  // BEFORE the `;` so the union grows.
  const camel = toCamel(type);
  const src = readFileSync(GRAPH_TYPES_PATH, 'utf8');
  if (src.includes(`'${camel}'`) && src.includes(`StandardModuleType`)) {
    const unionRe = /\| '([a-zA-Z0-9]+)'(\s*;\s*\n\s*export type ModuleType)/;
    const m = src.match(unionRe);
    if (m && m[1] === camel) return;
  }
  // One-line union extension. The marker comment lives on the SAME line
  // as the `| '<camel>'` payload (after a /* … */ block comment, NOT a
  // `//` line comment) so the closing `;` can sit on the next line
  // without becoming part of a `//` comment trailer. removeMarkerLines()
  // matches the marker text anywhere on a line, so undo deletes the
  // single line cleanly.
  const unionLine = `  | '${camel}' /* [new-module:${type}] */`;
  const anchorRe = /(;\s*\nexport type ModuleType\s*=\s*StandardModuleType)/;
  const am = src.match(anchorRe);
  if (!am || am.index === undefined) {
    throw new Error(`could not find StandardModuleType closing anchor in ${GRAPH_TYPES_PATH}`);
  }
  // Insertion point: just BEFORE the `;` so the new `| '<camel>'` line
  // sits as the last union member with the `;` on its own line below.
  // Result:
  //   | 'scoreboard'
  //   | 'mytestmod' /* [new-module:mytestmod] */
  // ;
  // export type ModuleType = StandardModuleType | (string & {});
  // Trailing `\n` before `;` is legal TypeScript.
  const next = src.slice(0, am.index) + '\n' + unionLine + '\n' + src.slice(am.index);
  writeFileSync(GRAPH_TYPES_PATH, next);
}

function addRegistryEntry(domain: Domain, type: string): void {
  const path = REGISTRY_PATHS[domain];
  const camel = toCamel(type);
  const varName = `${camel}Def`;
  const src = readFileSync(path, 'utf8');

  // 1) Append the import line. We anchor on the first
  //    `let registered = false;` line so the import block ends right
  //    before it.
  const importBlock = `import { ${varName} } from './${type}'; // [new-module:${type}]\n`;
  const importAnchor = /\nlet registered = false;/;
  const im = src.match(importAnchor);
  if (!im || im.index === undefined) {
    throw new Error(`could not find import-anchor in ${path}`);
  }
  let next = src.slice(0, im.index + 1) + importBlock + src.slice(im.index + 1);

  // 2) Append the registerModule line. We anchor on the
  //    `exposeModuleSpecsForTests();` call which closes the register
  //    function — our `registerXModule(...)` lands just BEFORE it.
  const registerFn = domain === 'audio'
    ? 'registerModule'
    : domain === 'video'
      ? 'registerVideoModule'
      : 'registerMetaModule';
  const registerBlock =
    `  ${registerFn}(${varName}); // [new-module:${type}]\n`;
  const registerAnchor = /\n(\s*)(exposeModuleSpecsForTests\(\);)/;
  const rm = next.match(registerAnchor);
  if (!rm || rm.index === undefined) {
    throw new Error(`could not find exposeModuleSpecsForTests anchor in ${path}`);
  }
  next = next.slice(0, rm.index + 1) + registerBlock + next.slice(rm.index + 1);
  writeFileSync(path, next);
}

function addCanvasEntry(type: string, pascal: string): void {
  const src = readFileSync(CANVAS_PATH, 'utf8');
  // 1) Import. Anchor: the StickyCard import line is a stable late-in-list
  //    sentinel, but the safest universal anchor is the comment block right
  //    above `// Meta-domain` or the StickyCard import.
  const importLine =
    `  import ${pascal}Card from '$lib/ui/modules/${pascal}Card.svelte'; // [new-module:${type}]\n`;
  // Anchor on the first occurrence of `import StickyCard from` — it's
  // present in every checkout and lives near the end of the import block.
  const importAnchor = /\n(\s*)(import StickyCard from)/;
  const im = src.match(importAnchor);
  if (!im || im.index === undefined) {
    throw new Error(`could not find StickyCard import anchor in ${CANVAS_PATH}`);
  }
  let next = src.slice(0, im.index + 1) + importLine + src.slice(im.index + 1);

  // 2) Router entry. Find the `// Meta-domain (no engine binding):` comment
  //    and inject just BEFORE it. That keeps meta entries at the bottom of
  //    the router and our entry above them.
  const routerLine =
    `    ${toCamel(type)}: ${pascal}Card, // [new-module:${type}]\n`;
  const routerAnchor = /\n(\s*)(\/\/ Meta-domain \(no engine binding\):)/;
  const rm = next.match(routerAnchor);
  if (!rm || rm.index === undefined) {
    // Fallback anchor: the StickyCard router entry (which is always present).
    const altAnchor = /\n(\s*)(sticky: StickyCard,)/;
    const am = next.match(altAnchor);
    if (!am || am.index === undefined) {
      throw new Error(`could not find Canvas router anchor in ${CANVAS_PATH}`);
    }
    next = next.slice(0, am.index + 1) + routerLine + next.slice(am.index + 1);
  } else {
    next = next.slice(0, rm.index + 1) + routerLine + next.slice(rm.index + 1);
  }
  writeFileSync(CANVAS_PATH, next);
}

function addModuleCategoriesEntry(type: string, domain: Domain): void {
  // Append a single entry inside the MODULE_CATEGORIES object literal.
  // Default sub-bucket = a permissive but legal bucket per domain.
  const camel = toCamel(type);
  const entry = domain === 'audio'
    ? `  ${camel}: { top: 'Audio modules', sub: 'Utility' }, // [new-module:${type}]\n`
    : domain === 'video'
      ? `  ${camel}: { top: 'Video modules', sub: 'Utilities' }, // [new-module:${type}]\n`
      : `  ${camel}: { top: 'Hybrid', sub: 'Hybrid' }, // [new-module:${type}]\n`;

  const src = readFileSync(MODULE_CATEGORIES_PATH, 'utf8');
  // Anchor on the closing `};` of MODULE_CATEGORIES — locate the `export
  // const MODULE_CATEGORIES` block and inject before its closing brace.
  const startRe = /export const MODULE_CATEGORIES\s*:\s*Record<string, CategoryEntry>\s*=\s*{/;
  const startM = src.match(startRe);
  if (!startM || startM.index === undefined) {
    throw new Error(`could not find MODULE_CATEGORIES start in ${MODULE_CATEGORIES_PATH}`);
  }
  const openIdx = src.indexOf('{', startM.index);
  const { endIdx } = sliceMatchedBrackets(src, openIdx, '{', '}');
  const next = src.slice(0, endIdx) + entry + src.slice(endIdx);
  writeFileSync(MODULE_CATEGORIES_PATH, next);
}

function addManifestDescriptionEntry(type: string, label: string): void {
  // Inject a one-line description in the DESCRIPTIONS map of
  // module-manifest.ts. This satisfies the
  // "NO module falls through to the description placeholder" assertion
  // in module-manifest.test.ts.
  const camel = toCamel(type);
  // Only audio defs flow through buildModuleManifest()'s glob; video +
  // meta don't, so the test only asserts on audio. We add the entry
  // regardless because future-proofing (the same map is used to render
  // any module page that the docs site picks up).
  const entry =
    `  ${camel}: '${label} — TODO write a one-line description. Scaffolded by scripts/new-module.ts.', // [new-module:${type}]\n`;
  const src = readFileSync(MANIFEST_PATH, 'utf8');
  const startRe = /const DESCRIPTIONS\s*:\s*Record<string, string>\s*=\s*{/;
  const startM = src.match(startRe);
  if (!startM || startM.index === undefined) {
    throw new Error(`could not find DESCRIPTIONS start in ${MANIFEST_PATH}`);
  }
  const openIdx = src.indexOf('{', startM.index);
  const { endIdx } = sliceMatchedBrackets(src, openIdx, '{', '}');
  const next = src.slice(0, endIdx) + entry + src.slice(endIdx);
  writeFileSync(MANIFEST_PATH, next);
}

function addVrtExemption(type: string): void {
  // Inject an EXEMPT_FROM_VRT entry with a "pending baseline" reason so
  // CI doesn't fail. The vrt-meta test enforces reason length ≥ 10
  // chars; ours is well over that threshold.
  const camel = toCamel(type);
  const today = new Date().toISOString().slice(0, 10);
  const entry =
    `  ${camel}: 'pending baseline — generated by new-module.ts ${today}; promote into MODULES once a darwin baseline is captured + reviewed.', // [new-module:${type}]\n`;
  const src = readFileSync(VRT_EXEMPTIONS_PATH, 'utf8');
  const startRe = /export const EXEMPT_FROM_VRT\s*:\s*Record<string, string>\s*=\s*{/;
  const startM = src.match(startRe);
  if (!startM || startM.index === undefined) {
    throw new Error(`could not find EXEMPT_FROM_VRT start in ${VRT_EXEMPTIONS_PATH}`);
  }
  const openIdx = src.indexOf('{', startM.index);
  const { endIdx } = sliceMatchedBrackets(src, openIdx, '{', '}');
  const next = src.slice(0, endIdx) + entry + src.slice(endIdx);
  writeFileSync(VRT_EXEMPTIONS_PATH, next);
}

// ───────────────────────────────────────────────────────────────────────────
// Undo. Removes every `// [new-module:<type>]` line from the registry-edit
// files and deletes the four newly-created files. Tolerates missing
// files / missing lines for a clean re-run after a half-baked scaffold.

function removeMarkerLines(filePath: string, marker: string): boolean {
  if (!existsSync(filePath)) return false;
  const src = readFileSync(filePath, 'utf8');
  const lines = src.split('\n');
  let changed = 0;
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i] ?? '';
    if (ln.includes(marker)) {
      changed++;
      continue;
    }
    kept.push(ln);
  }
  if (changed === 0) return false;

  // Post-process: graph/types.ts's StandardModuleType union has a sole
  // `;` on its own line whenever a scaffolded entry sat above it (the
  // scaffolder splits `'scoreboard';` into `'scoreboard'\n  | 'new'\n;`
  // so the marker line owns its line for clean removal). If undo
  // leaves a sole `;` on its own line, merge it back onto the
  // preceding `| '...'` line so the file matches its pre-scaffold
  // shape exactly.
  const merged: string[] = [];
  for (let i = 0; i < kept.length; i++) {
    const ln = kept[i] ?? '';
    if (/^\s*;\s*$/.test(ln) && merged.length > 0) {
      const prev = merged[merged.length - 1] ?? '';
      // Only fuse if the prior line ends with a union member
      // (`| 'something'` with no trailing `;`) — defensive.
      if (/\|\s*'[a-zA-Z0-9_]+'\s*$/.test(prev)) {
        merged[merged.length - 1] = `${prev.replace(/\s+$/, '')};`;
        continue;
      }
    }
    merged.push(ln);
  }
  writeFileSync(filePath, merged.join('\n'));
  return true;
}

function deleteFileIfExists(filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  unlinkSync(filePath);
  return true;
}

interface UndoResult {
  filesDeleted: string[];
  filesEdited: string[];
}

function undo(type: string): UndoResult {
  const marker = `[new-module:${type}]`;
  const camel = toCamel(type);
  const pascal = toPascal(type);
  const filesDeleted: string[] = [];
  const filesEdited: string[] = [];

  // Delete the four newly-created files (across all three domains — only
  // one will exist for a given module, but defending against half-undone
  // states is cheap).
  for (const domain of ['audio', 'video', 'meta'] as const) {
    if (deleteFileIfExists(moduleSourcePath(domain, type))) {
      filesDeleted.push(moduleSourcePath(domain, type));
    }
    if (deleteFileIfExists(moduleTestPath(domain, type))) {
      filesDeleted.push(moduleTestPath(domain, type));
    }
  }
  if (deleteFileIfExists(cardPath(pascal))) {
    filesDeleted.push(cardPath(pascal));
  }

  // Strip marker lines from the in-place edit files.
  for (const f of [
    REGISTRY_PATHS.audio,
    REGISTRY_PATHS.video,
    REGISTRY_PATHS.meta,
    GRAPH_TYPES_PATH,
    CANVAS_PATH,
    MODULE_CATEGORIES_PATH,
    MANIFEST_PATH,
    VRT_EXEMPTIONS_PATH,
  ]) {
    if (removeMarkerLines(f, marker)) filesEdited.push(f);
  }

  // Hush eslint about the implicit name dependency for the undo report.
  void camel;
  return { filesDeleted, filesEdited };
}

// ───────────────────────────────────────────────────────────────────────────
// Scaffold orchestrator.

interface ScaffoldResult {
  filesCreated: string[];
  filesEdited: string[];
}

function scaffold(opts: ScaffoldOpts): ScaffoldResult {
  const camel = toCamel(opts.type);
  const pascal = toPascal(opts.type);

  // Pre-flight: refuse if the module is already registered (= the
  // StandardModuleType union, the registry, or the source file already
  // mentions it). Keeps re-runs from creating duplicate registrations.
  const graphSrc = readFileSync(GRAPH_TYPES_PATH, 'utf8');
  const camelInUnion = new RegExp(`\\|\\s*'${camel}'`).test(graphSrc);
  const fileExists = existsSync(moduleSourcePath(opts.domain, opts.type));
  if (camelInUnion || fileExists) {
    throw new Error(
      `type '${opts.type}' (camelCase '${camel}') already exists in the registry — ` +
      `run \`--undo ${opts.type}\` to remove the previous scaffold first, ` +
      `or pick a different module id.`,
    );
  }

  const shape = opts.fromType ? loadCloneShape(opts.fromType) : null;
  if (shape && shape.domain !== opts.domain) {
    console.warn(
      `[new-module] warning: --from '${opts.fromType}' is a ${shape.domain}-domain module; ` +
      `cloning its port shape into your ${opts.domain}-domain stub anyway.`,
    );
  }

  const filesCreated: string[] = [];
  const filesEdited: string[] = [];

  // 1) Module def file.
  const modulePath = moduleSourcePath(opts.domain, opts.type);
  const moduleStub =
    opts.domain === 'audio' ? audioStub(opts.type, opts.label, opts.category, shape)
    : opts.domain === 'video' ? videoStub(opts.type, opts.label, opts.category, shape)
    : metaStub(opts.type, opts.label, opts.category);
  mkdirSync(dirname(modulePath), { recursive: true });
  writeFileSync(modulePath, moduleStub);
  filesCreated.push(modulePath);

  // 2) Card (skipped with --no-card).
  if (!opts.noCard) {
    const cp = cardPath(pascal);
    mkdirSync(dirname(cp), { recursive: true });
    writeFileSync(cp, cardStub(opts.type, pascal, opts.label, opts.domain));
    filesCreated.push(cp);
  }

  // 3) Shape test.
  const testPath = moduleTestPath(opts.domain, opts.type);
  writeFileSync(testPath, shapeTestStub(opts.type, opts.domain));
  filesCreated.push(testPath);

  // 4) Manifest description (DESCRIPTIONS map in module-manifest.ts).
  addManifestDescriptionEntry(opts.type, opts.label);
  filesEdited.push(MANIFEST_PATH);

  // 5) VRT exemption (pending baseline).
  addVrtExemption(opts.type);
  filesEdited.push(VRT_EXEMPTIONS_PATH);

  // 6) Registry barrel + StandardModuleType union + module-categories.
  addRegistryEntry(opts.domain, opts.type);
  filesEdited.push(REGISTRY_PATHS[opts.domain]);
  addStandardModuleTypeEntry(opts.type);
  filesEdited.push(GRAPH_TYPES_PATH);
  addModuleCategoriesEntry(opts.type, opts.domain);
  filesEdited.push(MODULE_CATEGORIES_PATH);

  // 7) Canvas card router (skipped with --no-card).
  if (!opts.noCard) {
    addCanvasEntry(opts.type, pascal);
    filesEdited.push(CANVAS_PATH);
  }

  return { filesCreated, filesEdited };
}

function runTypecheck(): { ok: boolean; out: string } {
  try {
    const out = execFileSync('flox', ['activate', '--', 'task', 'typecheck'], {
      cwd: REPO_ROOT,
      stdio: 'pipe',
      env: process.env,
    });
    return { ok: true, out: String(out) };
  } catch (e) {
    const err = e as { stdout?: Buffer; stderr?: Buffer; message: string };
    const out = String(err.stdout ?? '') + String(err.stderr ?? '') + err.message;
    return { ok: false, out };
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Entry point.

function main(): void {
  let args: ParsedArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`[new-module] ${(e as Error).message}`);
    process.exit(2);
  }

  if (args.mode === 'undo' && args.undo) {
    const { filesDeleted, filesEdited } = undo(args.undo.type);
    console.log(`[new-module] --undo ${args.undo.type}`);
    for (const f of filesDeleted) console.log(`  deleted: ${f}`);
    for (const f of filesEdited) console.log(`  edited:  ${f} (stripped markers)`);
    if (filesDeleted.length === 0 && filesEdited.length === 0) {
      console.log(`  (nothing to do — no scaffold artifacts found for '${args.undo.type}')`);
    }
    if (!args.undo.noTypecheck) {
      const tc = runTypecheck();
      if (tc.ok) console.log('[new-module] typecheck clean after undo');
      else {
        console.error('[new-module] typecheck FAILED after undo:');
        console.error(tc.out);
        process.exit(1);
      }
    }
    return;
  }

  if (args.mode !== 'scaffold' || !args.scaffold) {
    console.error('[new-module] internal error: parsed args missing scaffold opts');
    process.exit(2);
  }
  const opts = args.scaffold;
  let result: ScaffoldResult;
  try {
    result = scaffold(opts);
  } catch (e) {
    console.error(`[new-module] scaffold failed: ${(e as Error).message}`);
    process.exit(1);
  }

  console.log(`[new-module] scaffolded ${opts.type} (${opts.domain}, label=${opts.label})`);
  for (const f of result.filesCreated) console.log(`  created: ${f}`);
  for (const f of result.filesEdited) console.log(`  edited:  ${f}`);

  if (!opts.noTypecheck) {
    console.log('[new-module] running typecheck …');
    const tc = runTypecheck();
    if (tc.ok) {
      console.log('✓ typecheck clean');
    } else {
      console.error('✗ typecheck FAILED — see output below:');
      console.error(tc.out);
      process.exit(1);
    }
  }
}

// Only run main() when invoked directly. Tests import this module and
// poke its internals through the `__test_internals` export below.
const invokedDirectly = process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();

// Test surface. Only used by scripts/new-module.test.ts.
export const __test_internals = {
  toCamel,
  toPascal,
  parseArgs,
  scaffold,
  undo,
  loadCloneShape,
  REGISTRY_PATHS,
  GRAPH_TYPES_PATH,
  CANVAS_PATH,
  MODULE_CATEGORIES_PATH,
  MANIFEST_PATH,
  VRT_EXEMPTIONS_PATH,
  audioModulePath,
  videoModulePath,
  metaModulePath,
  moduleTestPath,
  cardPath,
};
