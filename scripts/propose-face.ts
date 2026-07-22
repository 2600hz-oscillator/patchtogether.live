// scripts/propose-face.ts
//
// AUTO-PROPOSE a DRAFT `face` (the workflow-mode UI-curation ranking) for a
// module, from the best available signal — for HUMAN review. It NEVER mutates a
// def and NEVER auto-accepts: it prints (or writes) a `face: { … }` snippet the
// author pastes into the def, edits, then promotes into STRICT_FACES + bumps the
// ratchet floor (module-face-lint.test.ts). See the workflow-mode UI refactor
// plan §5 in .myrobots/plans.
//
// Signal priority (per §5), best-effort + node-safe (parses SOURCE files with
// tolerant regex — it does NOT import the live registry, whose factories pull in
// worklet ?url / .wasm and break outside Vite):
//   1. CARD-SOURCE render order — the document order of `paramId="…"` and control
//      `data-testid`s in the module's `.svelte` card IS the reading order = the
//      initial ranking. `<section>`/`<header>` structure → dock `pages`;
//      `<ScopeScreen>`/`<VuMeter>`/`<WaveformGlyph>` presence → `face.glyph`.
//   2. DEF param order — every `def.params` id not seen in the card is appended
//      (front-loaded importance), so `order` covers the full param roster.
//
// Usage (via flox):
//   node --import tsx scripts/propose-face.ts <type> [--out <dir>]
//   node --import tsx scripts/propose-face.ts --all [--out <dir>]
//   (or `flox activate -- task face:propose -- <type>`)
//
// Default prints the draft to stdout. `--out <dir>` writes `<dir>/<type>.face.draft.ts`.

import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const MODULE_DIRS = [
  'packages/web/src/lib/audio/modules',
  'packages/web/src/lib/video/modules',
  'packages/web/src/lib/meta/modules',
];
const CARD_DIR = 'packages/web/src/lib/ui/modules';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function pascalCard(type: string): string {
  return type.charAt(0).toUpperCase() + type.slice(1) + 'Card';
}

/** Strip `${…}` interpolations from a card-source test id and collapse the
 *  placeholder like control-doc-resolver.staticKey collapses the literal `{id}`,
 *  yielding a stable static key. `kickdrum-${id}-hard-toggle` → `kickdrum-hard-toggle`. */
function cardStaticKey(testid: string): string {
  const withId = testid.replace(/\$\{[^}]*\}/g, '{id}');
  return withId
    .split('-{id}-').join('-')
    .split('-{id}').join('')
    .split('{id}-').join('')
    .split('{id}').join('');
}

function slug(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'page';
}

// ---------------------------------------------------------------------------
// Def-source parsing
// ---------------------------------------------------------------------------

interface DefInfo {
  type: string;
  file: string;
  src: string;
  card: string | null;
  /** best-effort param-id order from the `params:` literal block */
  paramIds: string[];
}

/** Locate the def source file for a module type by grepping for `type: '<type>'`. */
function findDefFile(type: string): string | null {
  for (const d of MODULE_DIRS) {
    const abs = join(REPO_ROOT, d);
    if (!existsSync(abs)) continue;
    for (const f of readdirSync(abs)) {
      if (!f.endsWith('.ts') || f.endsWith('.test.ts')) continue;
      const p = join(abs, f);
      const src = readFileSync(p, 'utf8');
      if (new RegExp(`type:\\s*['"\`]${type}['"\`]`).test(src)) return `${d}/${f}`;
    }
  }
  return null;
}

/** Extract the balanced `[ … ]` that follows `key:` in `src` (best-effort). */
function extractArrayBlock(src: string, key: string): string | null {
  const m = new RegExp(`${key}\\s*:\\s*\\[`).exec(src);
  if (!m) return null;
  let depth = 0;
  const start = m.index + m[0].length - 1; // at the '['
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) return src.slice(start + 1, i);
    }
  }
  return null;
}

function parseDef(type: string): DefInfo | null {
  const file = findDefFile(type);
  if (!file) return null;
  const src = readFileSync(join(REPO_ROOT, file), 'utf8');
  const cardM = new RegExp(`card:\\s*['"\`]([^'"\`]+)['"\`]`).exec(src);
  const paramsBlock = extractArrayBlock(src, 'params');
  const paramIds: string[] = [];
  if (paramsBlock) {
    for (const m of paramsBlock.matchAll(/\bid:\s*['"`]([^'"`]+)['"`]/g)) paramIds.push(m[1]);
  }
  return { type, file, src, card: cardM ? cardM[1] : null, paramIds };
}

// ---------------------------------------------------------------------------
// Card-source parsing
// ---------------------------------------------------------------------------

interface CardSignals {
  cardFile: string | null;
  /** reading-order keys (paramIds + static control keys), deduped */
  order: string[];
  glyph: 'scope' | 'meter' | 'waveform' | 'none';
  pages: { id: string; label: string; controls: string[] }[];
}

const PARAMID_RE = /paramId=(?:"([^"]+)"|'([^']+)'|\{['"]([^'"]+)['"]\})/g;
// A control-ish testid on a <select>/<button>/<input> (not a container/region).
const CONTROL_TESTID_RE = /data-testid=(?:"([^"]+)"|'([^']+)'|\{`([^`]+)`\}|\{['"]([^'"]+)['"]\})/g;

function parseCard(def: DefInfo): CardSignals {
  const cardBase = def.card ?? pascalCard(def.type);
  const cardFile = `${CARD_DIR}/${cardBase}.svelte`;
  const abs = join(REPO_ROOT, cardFile);
  if (!existsSync(abs)) {
    return { cardFile: null, order: [], glyph: 'none', pages: [] };
  }
  const src = readFileSync(abs, 'utf8');

  // Reading-order scan: collect { index, key } for every paramId + control testid,
  // then sort by index and dedup → the visual reading order.
  const hits: { i: number; key: string }[] = [];
  for (const m of src.matchAll(PARAMID_RE)) {
    hits.push({ i: m.index ?? 0, key: m[1] ?? m[2] ?? m[3] ?? '' });
  }
  for (const m of src.matchAll(CONTROL_TESTID_RE)) {
    const raw = m[1] ?? m[2] ?? m[3] ?? m[4] ?? '';
    const key = cardStaticKey(raw);
    // skip empty + obvious container/region ids (kept for review; keep control-like)
    if (key) hits.push({ i: m.index ?? 0, key });
  }
  hits.sort((a, b) => a.i - b.i);
  const seen = new Set<string>();
  const order: string[] = [];
  for (const h of hits) {
    if (h.key && !seen.has(h.key)) {
      seen.add(h.key);
      order.push(h.key);
    }
  }

  // Glyph from live-glyph primitive presence.
  const glyph: CardSignals['glyph'] = src.includes('<ScopeScreen')
    ? 'scope'
    : src.includes('<VuMeter')
      ? 'meter'
      : src.includes('<WaveformGlyph')
        ? 'waveform'
        : 'none';

  // Pages from <section> … <header>LABEL</header> structure (best-effort): for
  // each <header> capture its label + the paramIds that follow it up to the next
  // <header>.
  const pages: CardSignals['pages'] = [];
  const headerRe = /<header[^>]*>([^<]+)<\/header>/g;
  const headers = [...src.matchAll(headerRe)].map((m) => ({ i: m.index ?? 0, label: m[1].trim() }));
  for (let h = 0; h < headers.length; h++) {
    const from = headers[h].i;
    const to = h + 1 < headers.length ? headers[h + 1].i : src.length;
    const slice = src.slice(from, to);
    const controls: string[] = [];
    for (const m of slice.matchAll(PARAMID_RE)) {
      const k = m[1] ?? m[2] ?? m[3] ?? '';
      if (k && !controls.includes(k)) controls.push(k);
    }
    if (controls.length) pages.push({ id: slug(headers[h].label), label: headers[h].label, controls });
  }

  return { cardFile, order, glyph, pages };
}

// ---------------------------------------------------------------------------
// Draft assembly + emit
// ---------------------------------------------------------------------------

function buildDraft(def: DefInfo, card: CardSignals): { order: string[]; glyph: string; pages: CardSignals['pages']; notes: string[] } {
  const notes: string[] = [];
  const order: string[] = [...card.order];
  // Append any def param not already ranked (front-loaded importance fallback).
  for (const id of def.paramIds) {
    if (!order.includes(id)) order.push(id);
  }
  if (!card.cardFile) notes.push('no card found (override/canvas card?) — ranking is DEF PARAM ORDER only; review hard');
  else if (card.order.length === 0) notes.push('card had no paramId="…" controls — ranking is def param order');
  if (def.paramIds.length === 0) notes.push('could not parse def params literal (helper-built?) — completeness unknown');
  // Only keep pages whose controls are all present in order (they always are —
  // pages are built from the same card paramIds).
  const pages = card.pages.filter((p) => p.controls.every((c) => order.includes(c)));
  return { order, glyph: card.glyph, pages, notes };
}

function emit(def: DefInfo, card: CardSignals): string {
  const d = buildDraft(def, card);
  const q = (s: string) => `'${s}'`;
  const orderLines = d.order.map(q).join(', ');
  const lines: string[] = [];
  lines.push(`// DRAFT face for '${def.type}' — AUTO-PROPOSED, review before use. NEVER auto-accepted.`);
  lines.push(`//   def:  ${def.file}`);
  lines.push(`//   card: ${card.cardFile ?? '(none)'}`);
  for (const n of d.notes) lines.push(`//   note: ${n}`);
  lines.push(`face: {`);
  lines.push(`  order: [${orderLines}],`);
  if (d.pages.length) {
    lines.push(`  pages: [`);
    for (const p of d.pages) {
      lines.push(`    { id: ${q(p.id)}, label: ${q(p.label)}, controls: [${p.controls.map(q).join(', ')}] },`);
    }
    lines.push(`  ],`);
  }
  lines.push(`  glyph: ${q(d.glyph)},`);
  lines.push(`},`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function allTypes(): string[] {
  const types: string[] = [];
  for (const d of MODULE_DIRS) {
    const abs = join(REPO_ROOT, d);
    if (!existsSync(abs)) continue;
    for (const f of readdirSync(abs)) {
      if (!f.endsWith('.ts') || f.endsWith('.test.ts')) continue;
      const src = readFileSync(join(abs, f), 'utf8');
      const m = /type:\s*['"`]([^'"`]+)['"`]/.exec(src);
      if (m) types.push(m[1]);
    }
  }
  return [...new Set(types)].sort();
}

function main(): void {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const outDir = outIdx >= 0 ? args[outIdx + 1] : null;
  const wantAll = args.includes('--all');
  const positional = args.filter((a, i) => !a.startsWith('--') && !(i === outIdx + 1 && outDir));

  const types = wantAll ? allTypes() : positional;
  if (types.length === 0) {
    process.stderr.write(
      'usage: node --import tsx scripts/propose-face.ts <type> [--out <dir>]\n' +
        '       node --import tsx scripts/propose-face.ts --all [--out <dir>]\n',
    );
    process.exit(2);
  }

  if (outDir) mkdirSync(join(REPO_ROOT, outDir), { recursive: true });

  for (const type of types) {
    const def = parseDef(type);
    if (!def) {
      process.stderr.write(`[propose-face] no def found for '${type}' — skipping\n`);
      continue;
    }
    const card = parseCard(def);
    const snippet = emit(def, card);
    if (outDir) {
      const p = join(REPO_ROOT, outDir, `${type}.face.draft.ts`);
      writeFileSync(p, snippet + '\n');
      process.stdout.write(`[propose-face] wrote ${outDir}/${type}.face.draft.ts\n`);
    } else {
      process.stdout.write(snippet + '\n\n');
    }
  }
}

main();
