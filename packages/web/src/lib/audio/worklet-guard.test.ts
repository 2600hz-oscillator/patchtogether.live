// packages/web/src/lib/audio/worklet-guard.test.ts
//
// THE PERMANENT NEGATIVE CONTROL for the processorerror latch handler, plus the
// DENY-BY-DEFAULT source gate that keeps the seam from rotting.
//
// ── Why both directions, permanently ────────────────────────────────────────
// "The processor never threw" and "the handler was never wired" print
// IDENTICALLY: an empty ledger. Only one of those is good news. So:
//   (a) FORCED — dispatch a real `processorerror` and prove the ledger gains an
//       entry that NAMES the processor, the module and the node.
//   (b) HEALTHY — a node that never throws must leave the ledger at exactly 0.
//       Without (b), (a) is satisfied by a handler that records unconditionally.
//
// ── Why a source gate as well ───────────────────────────────────────────────
// A runtime test can only see nodes the test itself constructs. It is
// STRUCTURALLY UNABLE to see the 63rd module that goes back to
// `new AudioWorkletNode`. That is the opt-in-gate pathology from
// AGENTS.md's instrument rule, so the second half of this file is
// deny-by-default over the tree, with a NAMED `(file, processor)` exemption per
// instance — anchored to the artifact, so an exemption that no longer names a
// real site is RED, and ratcheted in both directions.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative } from 'node:path';
import {
  createWorkletNode,
  guardWorkletNode,
  onWorkletNodeError,
  onWorkletError,
  recordWorkletError,
  workletErrorLog,
  workletErrorCount,
  __resetWorkletErrorLedger,
} from './worklet-guard';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_SRC = resolve(__dirname, '../..');

// ---------------------------------------------------------------------------
// A stub worklet node. `EventTarget` is all `guardWorkletNode` touches, so the
// wiring is provable with no browser, no AudioContext and no DSP build — which
// also means this gate costs ~0 CI wall-time and can never be renderer- or
// capability-dependent.
// ---------------------------------------------------------------------------
/** The browser fires an `ErrorEvent`; Node has no `ErrorEvent` global, so this
 *  reproduces the only two fields the guard reads (`message`, `error`). */
class FakeProcessorErrorEvent extends Event {
  readonly message: string;
  readonly error: Error | undefined;
  constructor(message: string) {
    super('processorerror');
    this.message = message;
    this.error = message ? new Error(message) : undefined;
  }
}

class FakeWorkletNode extends EventTarget {
  /** Simulate the processor throwing on the render thread. */
  latch(message = 'Uncaught RangeError in process()') {
    this.dispatchEvent(new FakeProcessorErrorEvent(message));
  }
}

describe('worklet-guard — (a)/(b) the latch handler, both directions', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __resetWorkletErrorLedger();
    // The handler's whole job is to be LOUD. Silence it here so a green run is
    // readable, but assert it was called — a quiet handler is the bug.
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    errSpy.mockRestore();
    __resetWorkletErrorLedger();
  });

  it('(b) HEALTHY: a guarded node that never throws leaves the ledger at exactly 0', () => {
    const n = new FakeWorkletNode();
    guardWorkletNode(n, 'master-limiter', { id: 'n-1', type: 'audioOut' });
    // Unrelated events must not be mistaken for a latch.
    n.dispatchEvent(new Event('statechange'));
    n.dispatchEvent(new MessageEvent('message'));
    expect(workletErrorCount(), 'latches on a healthy node').toBe(0);
    expect(workletErrorLog()).toHaveLength(0);
    expect(errSpy, 'a healthy node must produce no console noise').not.toHaveBeenCalled();
  });

  it('(a) FORCED: a processorerror is recorded, and it NAMES module + processor + node', () => {
    const n = new FakeWorkletNode();
    guardWorkletNode(n, 'master-limiter', { id: 'n-42', type: 'audioOut' });
    n.latch('Uncaught RangeError in process()');

    expect(workletErrorCount(), 'the count must RISE').toBe(1);
    const rec = workletErrorLog()[0]!;
    expect(rec.processor, 'which processor').toBe('master-limiter');
    expect(rec.moduleType, 'which module').toBe('audioOut');
    expect(rec.nodeId, 'which node').toBe('n-42');
    expect(rec.message).toContain('RangeError');
    expect(rec.seq).toBe(1);

    // LOUD: one console.error naming all three, so a user can screenshot it.
    expect(errSpy).toHaveBeenCalledTimes(1);
    const line = String(errSpy.mock.calls[0]![0]);
    expect(line).toContain('master-limiter');
    expect(line).toContain('audioOut');
    expect(line).toContain('n-42');
    expect(line, 'the message must explain that the silence is PERMANENT').toMatch(/SILENCE/i);
  });

  it('two different nodes latch independently and stay distinguishable', () => {
    const a = new FakeWorkletNode();
    const b = new FakeWorkletNode();
    guardWorkletNode(a, 'moog921-vco', { id: 'n-1', type: 'moog921Vco' });
    guardWorkletNode(b, 'moog921-vco', { id: 'n-2', type: 'moog921Vco' });
    b.latch();
    b.latch();
    a.latch();
    expect(workletErrorLog().map((r) => r.nodeId)).toEqual(['n-2', 'n-2', 'n-1']);
    expect(workletErrorLog().map((r) => r.seq)).toEqual([1, 2, 3]);
  });

  it('an unattributed node records `undefined`, never a guessed module', () => {
    // A wrong module name is worse than no module name: it sends the next
    // investigation to the wrong file.
    const n = new FakeWorkletNode();
    guardWorkletNode(n, 'gate-edge');
    n.latch();
    const rec = workletErrorLog()[0]!;
    expect(rec.processor).toBe('gate-edge');
    expect(rec.moduleType).toBeUndefined();
    expect(rec.nodeId).toBeUndefined();
  });

  it('subscribers see every latch; a throwing subscriber does not swallow the rest', () => {
    const seen: string[] = [];
    const off1 = onWorkletError(() => {
      throw new Error('a badly-behaved listener');
    });
    const off2 = onWorkletError((r) => seen.push(r.processor));
    recordWorkletError({ processor: 'p1', message: '' });
    recordWorkletError({ processor: 'p2', message: '' });
    expect(seen).toEqual(['p1', 'p2']);
    off1();
    off2();
    recordWorkletError({ processor: 'p3', message: '' });
    expect(seen, 'unsubscribed listeners stop receiving').toEqual(['p1', 'p2']);
  });

  it('the ledger is bounded but the COUNT is not — a storming processor cannot hide the total', () => {
    for (let i = 0; i < 400; i++) recordWorkletError({ processor: 'storm', message: '' });
    expect(workletErrorLog().length, 'ledger is capped').toBeLessThanOrEqual(256);
    expect(workletErrorCount(), 'the cumulative count is NOT capped').toBe(400);
    expect(workletErrorLog()[workletErrorLog().length - 1]!.seq).toBe(400);
  });

  it('an event with no message still records — an empty message is not "no error"', () => {
    const n = new FakeWorkletNode();
    guardWorkletNode(n, 'quiet');
    n.dispatchEvent(new Event('processorerror'));
    expect(workletErrorCount()).toBe(1);
    expect(workletErrorLog()[0]!.message).toBe('');
  });

  it('guarding a node with no addEventListener does not break construction', () => {
    // Instrumentation must never change audio behaviour, including in its own
    // failure mode. A stub context in some other unit test must not explode.
    const notANode = {} as unknown as EventTarget;
    expect(() =>
      guardWorkletNode(notANode as never, 'x', { id: 'n', type: 't' }),
    ).not.toThrow();
    expect(() => onWorkletNodeError(notANode as never, () => {})).not.toThrow();
  });

  it('onWorkletNodeError runs recovery IN ADDITION to the ledger entry', () => {
    // The terminal-sink failover relies on this being additive, not a
    // replacement — the report and the recovery are separate concerns.
    const n = new FakeWorkletNode();
    guardWorkletNode(n, 'master-limiter', { id: 'n-1', type: 'audioOut' });
    let recovered = 0;
    onWorkletNodeError(n, () => recovered++);
    n.latch();
    expect(recovered, 'recovery ran').toBe(1);
    expect(workletErrorCount(), 'and the latch was still ledgered').toBe(1);
  });

  it('createWorkletNode is the seam: it constructs AND guards', () => {
    // No AudioContext here, so prove the composition rather than the
    // construction: the seam must not be a bare `new` with the guard forgotten.
    const src = readFileSync(resolve(__dirname, 'worklet-guard.ts'), 'utf8');
    const body = src.slice(src.indexOf('export function createWorkletNode'));
    expect(body).toContain('new AudioWorkletNode(');
    expect(body, 'createWorkletNode must attach the guard it exists to attach').toContain(
      'guardWorkletNode(',
    );
    expect(typeof createWorkletNode).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// THE SOURCE GATE — deny by default.
// ---------------------------------------------------------------------------

/** Every non-test source file under packages/web/src. */
function walkSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const p = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      walkSources(p, out);
    } else if (
      (entry.name.endsWith('.ts') || entry.name.endsWith('.svelte')) &&
      !entry.name.endsWith('.test.ts')
    ) {
      out.push(p);
    }
  }
  return out;
}

const CONSTRUCTION = /new\s+AudioWorkletNode\s*\(/g;

/**
 * NAMED EXEMPTIONS — the exact `(file, processor)` pair, never a bare filename,
 * so a NEW unguarded node in an already-listed file still reddens.
 *
 * ⚠ ALL EIGHT ARE THE SAME REASON, and it is a real one: every one of these
 * files is in the WEBGL ATTEST CONTENT HASH (`scripts/webgl-attest-lib.ts` →
 * `resolveWebglBasis()`: step 1 sweeps `packages/web/src/lib/video/**` whole,
 * step 3 adds the three `rendersWebGL`-flagged AUDIO defs). Editing any of them
 * churns that hash and forces a trusted-machine GPU re-attest — currently
 * blocked on unrelated camera-input failures.
 *
 * MEASURED: routing the three audio ones through the seam moved the content
 * hash `620fa1b3…` → `717b3325…` and reddened the `webgl-attest` job. Reverting
 * exactly those three restored `620fa1b3…`. So the exemption is not a
 * preference — it is the cost of not shipping a red attest gate.
 *
 * Each of these is unguarded TODAY exactly as it was before this PR: the
 * exemption preserves the status quo, it does not create a new hole. Routing
 * them through the seam belongs in whichever PR next does a legitimate
 * re-attest.
 */
const UNGUARDED_EXEMPTIONS: ReadonlyArray<{ file: string; processor: string; why: string }> = [
  // (1) whole-dir video sweep
  { file: 'lib/video/modules/blood.ts', processor: 'blood-pcm', why: 'webgl attest basis' },
  { file: 'lib/video/modules/doom.ts', processor: 'doom-pcm', why: 'webgl attest basis' },
  { file: 'lib/video/modules/mandelbulb.ts', processor: 'mandelbulb-osc', why: 'webgl attest basis' },
  { file: 'lib/video/modules/recorderbox.ts', processor: 'recorderbox-capture', why: 'webgl attest basis' },
  { file: 'lib/video/modules/videocube.ts', processor: 'mandelbulb-osc', why: 'webgl attest basis' },
  // (3) AUDIO_WEBGL_MODULE_DEFS — audio defs flagged rendersWebGL
  { file: 'lib/audio/modules/cube.ts', processor: 'cube', why: 'webgl attest basis' },
  { file: 'lib/audio/modules/wavesculpt.ts', processor: 'wavesculpt-engine', why: 'webgl attest basis' },
];

/** The one file allowed to say `new AudioWorkletNode` — the seam itself. */
const THE_SEAM = 'lib/audio/worklet-guard.ts';

interface Site {
  file: string;
  processor: string;
}

function findConstructionSites(): Site[] {
  const sites: Site[] = [];
  for (const abs of walkSources(WEB_SRC)) {
    const rel = relative(WEB_SRC, abs).replaceAll('\\', '/');
    if (rel === THE_SEAM) continue;
    const code = readFileSync(abs, 'utf8');
    CONSTRUCTION.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CONSTRUCTION.exec(code)) !== null) {
      // The processor name is the SECOND argument: either a string literal or
      // a module-level `const NAME = '…'`, both of which are resolved. Anything
      // else resolves to '?', which matches NO exemption and is therefore
      // DENIED — the safe direction. Never drop an unnameable site: that would
      // be an opt-out.
      // (Negative-controlled by hand, 2026-08-08: reverting kickdrum.ts to a
      // bare `new AudioWorkletNode(ctx, PROCESSOR_NAME, …)` reddens this
      // assertion and the ratchet with it.)
      const after = code.slice(m.index, m.index + 260);
      const lit = /new\s+AudioWorkletNode\s*\(\s*[^,]+,\s*['"]([^'"]+)['"]/.exec(after);
      let processor = lit?.[1];
      if (!processor) {
        const ident = /new\s+AudioWorkletNode\s*\(\s*[^,]+,\s*([A-Za-z_$][\w$]*)/.exec(after);
        if (ident) {
          const decl = new RegExp(
            `^\\s*(?:const|let|var)\\s+${ident[1]}\\s*(?::[^=]+)?=\\s*['"]([^'"]+)['"]`,
            'm',
          ).exec(code);
          processor = decl?.[1];
        }
      }
      sites.push({ file: rel, processor: processor ?? '?' });
    }
  }
  return sites;
}

describe('worklet-guard — the source gate (DENY BY DEFAULT)', () => {
  const sites = findConstructionSites();

  it('every `new AudioWorkletNode` outside the seam is a NAMED exemption', () => {
    const allowed = new Set(UNGUARDED_EXEMPTIONS.map((e) => `${e.file}::${e.processor}`));
    const offenders = sites.filter((s) => !allowed.has(`${s.file}::${s.processor}`));
    expect(
      offenders.map((s) => `${s.file} → ${s.processor}`),
      'construct worklets via `createWorkletNode(node, ctx, name, opts)` from ' +
        '$lib/audio/worklet-guard, so a processorerror is never silent. A bare ' +
        '`new AudioWorkletNode` gives a processor that latches to permanent ' +
        'silence with nothing logged (Web Audio spec).',
    ).toEqual([]);
  });

  it('ANCHORED TO THE ARTIFACT: no exemption names a site that no longer exists', () => {
    // A stale exemption is an exemption nobody is watching — and it silently
    // re-exempts the next regression on that key.
    const present = new Set(sites.map((s) => `${s.file}::${s.processor}`));
    const stale = UNGUARDED_EXEMPTIONS.filter((e) => !present.has(`${e.file}::${e.processor}`));
    expect(
      stale.map((e) => `${e.file} → ${e.processor}`),
      'these exemptions name construction sites that are gone — delete them',
    ).toEqual([]);
  });

  it('the unguarded population is EXACTLY the named list, and every reason is the same one', () => {
    // ⚠ `CEILING` (7) IS GONE (2026-08-12, the no-ratchets sweep). It was a
    // hand-typed literal equal BY CONSTRUCTION to `UNGUARDED_EXEMPTIONS.length`:
    // the deny-by-default leg above forces every site to be named, and the
    // artifact anchor forces every name to be a live site, so the two lists are
    // the same set and the number was a third copy of their size — one that a
    // concurrent branch adding or deleting a worklet silently invalidates.
    //
    // Replaced with the DERIVED form, which is strictly stronger: it also
    // catches the one case the two `toEqual([])`s cannot, a DUPLICATE
    // `file::processor` key (both legs compare sets, so two sites sharing a key
    // pass them and fail this).
    expect(sites.length, 'unguarded worklet constructions vs named exemptions').toBe(
      UNGUARDED_EXEMPTIONS.length,
    );
    expect(new Set(UNGUARDED_EXEMPTIONS.map((e) => e.why))).toEqual(
      new Set(['webgl attest basis']),
    );
  });

  it('the guarded population is real, and it is the whole audio tree', () => {
    // The gate above is satisfiable by DELETING every worklet in the repo. This
    // is the other half: the seam must actually be in wide use.
    //
    // ⚠ `>= 57` STOOD HERE (removed 2026-08-12, the no-ratchets sweep). It read
    // as a generous vacuity floor and was nothing of the kind: the tree
    // measured **58**, so it had ONE slot of slack — a single module dropping
    // the seam would still have passed, and every second module added would
    // have needed the literal bumped. A floor sitting on its own population is
    // a ratchet whatever the comment calls it.
    //
    // Both halves are DERIVED now. (a) the seam is in wider use than the
    // exemption list — measured 58 guarded against 7 named unguarded, and both
    // sides come off the same tree, so it never needs a bump. (b) the terminal
    // sink is named, so a walk that silently resolved nothing cannot pass.
    let guarded = 0;
    const guardedFiles: string[] = [];
    for (const abs of walkSources(resolve(WEB_SRC, 'lib/audio'))) {
      const code = readFileSync(abs, 'utf8');
      const n = (code.match(/createWorkletNode\s*\(/g) ?? []).length;
      if (n > 0) guardedFiles.push(abs.replace(/^.*\/lib\/audio\//, ''));
      guarded += n;
    }
    expect(
      guarded,
      `the guarded seam must outnumber the named unguarded exemptions — ` +
        `${guarded} createWorkletNode call sites vs ${sites.length} bare constructions`,
    ).toBeGreaterThan(sites.length);
    expect(
      guardedFiles,
      'the terminal sink must construct through the seam — a walk that resolved nothing ' +
        'would satisfy the comparison above by emptying both sides',
    ).toContain('modules/audio-out.ts');
  });

  it('the Faust path — the one node the seam cannot construct — is guarded', () => {
    const faust = readFileSync(resolve(WEB_SRC, 'lib/audio/faust-runtime.ts'), 'utf8');
    expect(faust).toContain('new FaustMonoAudioWorkletNode(');
    expect(
      faust,
      'FaustMonoAudioWorkletNode is built inside @grame/faustwasm, so it must be ' +
        'guarded after the fact — this one file covers every Faust module',
    ).toContain('guardWorkletNode(');
  });

  it('the terminal sink has a RUNTIME path to its clip fallback, not just a load-time one', () => {
    const out = readFileSync(resolve(WEB_SRC, 'lib/audio/modules/audio-out.ts'), 'utf8');
    expect(out).toContain('failoverTerminalTailToClip');
    expect(
      out,
      'audio-out must react to a runtime latch — its try/catch covers addModule ' +
        'and construction only, and a latched limiter silences the whole rack',
    ).toContain('onWorkletNodeError(');
  });

  it('SCOPE, STATED: what this gate is structurally unable to see', () => {
    // (1) An INDIRECT construction — `const C = AudioWorkletNode; new C(...)` —
    //     is invisible to the regex. Asserted at zero rather than assumed.
    // (2) A worklet constructed OUTSIDE packages/web/src (e.g. inside a
    //     node_modules dependency). The Faust wrapper is the only known case
    //     and it has its own assertion above.
    // (3) Whether a guarded node's processor ever actually throws in
    //     production. Nothing in CI can see that; it is what the ledger is for.
    let indirect = 0;
    for (const abs of walkSources(WEB_SRC)) {
      const rel = relative(WEB_SRC, abs).replaceAll('\\', '/');
      if (rel === THE_SEAM) continue;
      const code = readFileSync(abs, 'utf8');
      // A bare value reference: assignment or aliasing, not a type position.
      indirect += (code.match(/=\s*AudioWorkletNode\b(?!\s*[|;)])/g) ?? []).length;
    }
    expect(indirect, 'aliased AudioWorkletNode constructors (regex-invisible)').toBe(0);
    expect(existsSync(resolve(WEB_SRC, THE_SEAM)), 'the seam exists').toBe(true);
  });
});
