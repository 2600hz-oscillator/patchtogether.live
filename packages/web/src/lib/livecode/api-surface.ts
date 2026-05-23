// packages/web/src/lib/livecode/api-surface.ts
//
// Single source of truth for what LIVECODE scripts can see at the
// `globalThis` of the sandboxed `new Function` runtime. Consumed by:
//
//   * runtime.ts        — builds the actual globals object handed into
//                         the function body
//   * completions.ts    — surfaces every entry as an autocomplete item
//                         + per-arg suggestion logic
//   * diagnostics.ts    — knows the signatures so it can lint arg types
//                         (e.g. patch's two args must be string ports)
//   * docs/livecode.md  — generated docs page reads the same array
//
// Keeping these in one place is the difference between an autocomplete
// that helps + a docs page that lies vs. drift between what we ship
// and what we say we ship.

/** Categories for the autocomplete dropdown grouping. */
export type ApiCategory =
  | 'transport' // clock/BPM/play
  | 'rack'      // spawn/patch/unpatch/set
  | 'state'     // read/listModules
  | 'schedule'  // clocked/every
  | 'util';     // log

/** One function entry exposed in the sandbox. */
export interface ApiFnSpec {
  kind: 'fn';
  name: string;
  category: ApiCategory;
  /** Compact signature shown in the autocomplete tooltip. */
  signature: string;
  /** One-line summary. Rendered as autocomplete info-tip + docs. */
  summary: string;
  /** Worked example. Rendered in docs only. */
  example?: string;
}

/** One global property — typically a namespace like `clock` exposing
 *  start()/stop()/bpm/etc. */
export interface ApiNamespaceSpec {
  kind: 'namespace';
  name: string;
  category: ApiCategory;
  summary: string;
  members: ApiFnSpec[];
}

/** One built-in identifier — typically a per-module-id at runtime
 *  (analogVco1, hydrogen1 …). Not statically known so completions.ts
 *  augments the list dynamically from the live patch graph. The static
 *  table just describes the SHAPE every module proxy carries. */
export interface ApiModuleProxyShape {
  kind: 'module-shape';
  /** Per-module proxy fields available on every spawned module
   *  identifier. Used to feed nested completions after the dot. */
  fields: string[];
}

export type ApiEntry = ApiFnSpec | ApiNamespaceSpec | ApiModuleProxyShape;

/** Authoritative API list. ORDER MATTERS for docs grouping; alphabetize
 *  within each category to keep diffs minimal when adding entries. */
export const LIVECODE_API: ApiEntry[] = [
  // ─── Rack mutation ────────────────────────────────────────────────
  {
    kind: 'fn',
    name: 'spawn',
    category: 'rack',
    signature: 'spawn(type, name?)',
    summary:
      "Create a new module of the given type. Optional `name` sets the script-facing identifier (e.g. spawn('analogVco', 'lead')). Returns the new module's name.",
    example: `const lead = spawn('analogVco', 'lead');\nspawn('audioOut');\npatch('lead.sine', 'audioOut1.L');`,
  },
  {
    kind: 'fn',
    name: 'patch',
    category: 'rack',
    signature: "patch('moduleA.outPort', 'moduleB.inPort')",
    summary:
      'Wire a cable. Order is forgiving — patch may be called source-first or destination-first; the runtime detects which is which from the module def and rejects type-incompatible pairs with a clear error.',
    example: `patch('vco1.sine', 'scope1.ch1');\n// equivalent:\npatch('scope1.ch1', 'vco1.sine');`,
  },
  {
    kind: 'fn',
    name: 'unpatch',
    category: 'rack',
    signature: "unpatch('moduleA.outPort', 'moduleB.inPort')",
    summary:
      'Remove a cable between two ports. Order-insensitive, like patch().',
    example: `unpatch('vco1.sine', 'scope1.ch1');`,
  },
  {
    kind: 'fn',
    name: 'set',
    category: 'rack',
    signature: "set('module', 'param', value)",
    summary:
      'Write a numeric param value. Clamped server-side by the module def.',
    example: `set('vco1', 'tune', 12); // up one octave`,
  },
  {
    kind: 'fn',
    name: 'setData',
    category: 'rack',
    signature: "setData('module', 'key', value)",
    summary:
      'Write an arbitrary JSON value to node.data[key]. Use for sequencer step arrays, hydrogen drum patterns, and other non-numeric module state — numeric knobs use set() instead.',
    example: `setData('seq', 'steps', [\n  { on: true, pitch: 60 },\n  { on: true, pitch: 64 },\n  { on: false }, { on: false },\n]);`,
  },

  // ─── State reads ──────────────────────────────────────────────────
  {
    kind: 'fn',
    name: 'read',
    category: 'state',
    signature: "read('module', 'key')",
    summary:
      "Read a module's runtime state. Common keys: 'step' (sequencer playhead), 'isPlaying', 'snapshot' (scope/wavviz), 'outputPeak.<portId>' (engine analyser tap).",
    example: `if (read('sequencer1', 'step') === 15) set('vca1', 'gain', 0);`,
  },
  {
    kind: 'fn',
    name: 'listModules',
    category: 'state',
    signature: 'listModules()',
    summary:
      'Returns the names of every spawned module on the rack — useful for diagnostic logging.',
  },

  // ─── Transport ────────────────────────────────────────────────────
  {
    kind: 'namespace',
    name: 'clock',
    category: 'transport',
    summary:
      'Master TIMELORDE clock. The clock is ALWAYS running so clocked() callbacks stay alive; clock.mute() / clock.unmute() only gate the gate outputs.',
    members: [
      {
        kind: 'fn',
        name: 'start',
        category: 'transport',
        signature: 'clock.start()',
        summary:
          'Unmute the master clock outputs (equivalent to clock.unmute()).',
      },
      {
        kind: 'fn',
        name: 'stop',
        category: 'transport',
        signature: 'clock.stop()',
        summary:
          'Mute the master clock outputs. The internal clock keeps running so clocked() callbacks continue to fire.',
      },
      {
        kind: 'fn',
        name: 'mute',
        category: 'transport',
        signature: 'clock.mute()',
        summary: 'Alias of clock.stop().',
      },
      {
        kind: 'fn',
        name: 'unmute',
        category: 'transport',
        signature: 'clock.unmute()',
        summary: 'Alias of clock.start().',
      },
      {
        kind: 'fn',
        name: 'bpm',
        category: 'transport',
        signature: 'clock.bpm(value?)',
        summary:
          'Get (no args) or set (one numeric arg) the master BPM. Clamped 10..300.',
        example: `clock.bpm(140);    // set\nconst bpm = clock.bpm();  // read`,
      },
    ],
  },

  // ─── Scheduling ───────────────────────────────────────────────────
  {
    kind: 'fn',
    name: 'clocked',
    category: 'schedule',
    signature: "clocked('division', () => { /* … */ })",
    summary:
      "Schedule a callback to fire every clock division. Divisions: '1/512', '1/256', '1/128', '1/64', '1/32', '1/16', '1', '2x', '4x'. Calling clocked() spawns a CLOCKED RUNNER module on the canvas that owns the subscription — delete the runner to cancel; edit its body inline to change the callback.",
    example: `clocked('1/16', () => {\n  if (sequencer1.step === 0) samsloop1.trigger();\n});`,
  },
  {
    kind: 'fn',
    name: 'every',
    category: 'schedule',
    signature: "every('division', () => { /* … */ })",
    summary: 'Alias of clocked().',
  },

  // ─── Persistent runner state ──────────────────────────────────────
  {
    kind: 'namespace',
    name: 'state',
    category: 'state',
    summary:
      'Per-runner key/value store. Survives across clocked() ticks, page reloads, and is visible to remote collaborators (lives on the owning runner\'s node.data.state). Use it for counters, phase accumulators, and other "I need this value next tick" needs.',
    members: [
      {
        kind: 'fn',
        name: 'get',
        category: 'state',
        signature: "state.get('key')",
        summary: 'Read a stored value (undefined if never set).',
        example: `const beat = state.get('beat') ?? 0;\nstate.set('beat', beat + 1);`,
      },
      {
        kind: 'fn',
        name: 'set',
        category: 'state',
        signature: "state.set('key', value)",
        summary: 'Write a value (any JSON-serializable type). Returns the written value.',
      },
      {
        kind: 'fn',
        name: 'has',
        category: 'state',
        signature: "state.has('key')",
        summary: 'Returns true iff `key` has been set (distinguishes a stored `undefined` from never-set).',
      },
      {
        kind: 'fn',
        name: 'keys',
        category: 'state',
        signature: 'state.keys()',
        summary: "Returns an array of every key stored on this runner's state bag.",
      },
      {
        kind: 'fn',
        name: 'clear',
        category: 'state',
        signature: 'state.clear()',
        summary: "Wipe this runner's state bag.",
      },
    ],
  },

  // ─── Utility ──────────────────────────────────────────────────────
  {
    kind: 'fn',
    name: 'log',
    category: 'util',
    signature: 'log(...values)',
    summary:
      "Push a line to the LIVECODE card's output panel. Replaces console.log inside the sandbox.",
  },

  // ─── Per-module proxy shape ───────────────────────────────────────
  // Every spawned module is exposed as a global identifier; completions.ts
  // augments the list dynamically from the live patch graph. The static
  // shape below lists fields available on every module proxy.
  {
    kind: 'module-shape',
    fields: ['step', 'isPlaying', 'outputs', 'params', 'name', 'type', 'id'],
  },
];

/** Names of the every clock-division string accepted by clocked(). */
export const CLOCKED_DIVISIONS = [
  '1/512',
  '1/256',
  '1/128',
  '1/64',
  '1/32',
  '1/16',
  '1',
  '2x',
  '4x',
] as const;

export type ClockedDivision = (typeof CLOCKED_DIVISIONS)[number];

/** Maps a clocked() division to a multiplier in TIMELORDE "1x = 1 beat"
 *  reference. e.g. 1/16 = 16 ticks per beat (so a multiplier of 16);
 *  '4x' = 0.25 beats per tick (multiplier 0.25). At a finer-than-1/64
 *  division (1/128/256/512) we derive from the worker scheduler tick
 *  (25 ms) since TIMELORDE doesn't expose those divisions on its output
 *  ports today. */
export function divisionToBeatsPerTick(d: ClockedDivision): number {
  switch (d) {
    case '4x':    return 4;
    case '2x':    return 2;
    case '1':     return 1;
    case '1/16':  return 1 / 4;
    case '1/32':  return 1 / 8;
    case '1/64':  return 1 / 16;
    case '1/128': return 1 / 32;
    case '1/256': return 1 / 64;
    case '1/512': return 1 / 128;
  }
}

/** Pull out every fn name across categories — used by the autocomplete
 *  static keyword list. */
export function listApiFunctionNames(): string[] {
  const out: string[] = [];
  for (const e of LIVECODE_API) {
    if (e.kind === 'fn') out.push(e.name);
    if (e.kind === 'namespace') {
      // The namespace itself is one identifier; members are reached via
      // dot completion.
      out.push(e.name);
    }
  }
  return out.sort();
}

/** Look up a namespace's members. Used by completions.ts on dot
 *  completion. */
export function listNamespaceMembers(name: string): string[] {
  const ns = LIVECODE_API.find(
    (e) => e.kind === 'namespace' && e.name === name,
  );
  if (!ns || ns.kind !== 'namespace') return [];
  return ns.members.map((m) => m.name);
}

/** Per-module proxy field names. Augmented dynamically by the runtime;
 *  the static list lets autocomplete suggest before-spawn fields too. */
export function listModuleProxyFields(): string[] {
  const shape = LIVECODE_API.find((e) => e.kind === 'module-shape');
  if (!shape || shape.kind !== 'module-shape') return [];
  return shape.fields;
}
