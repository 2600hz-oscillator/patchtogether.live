// packages/web/src/lib/audio/modules/clocked-runner.ts
//
// CLOCKED RUNNER — a self-contained mini-LIVECODE that owns a single
// clocked() callback. Spawned by the parent LIVECODE card when the
// user invokes `clocked(division, fn)`; the runner stores the
// function body + the division on `node.data`, subscribes to the
// shared scheduler-clock, and re-fires the body on every tick that
// crosses the next division boundary.
//
// The runner is its own first-class module:
//   * Has a card UI (ClockedRunnerCard.svelte) that shows the body in
//     a CodeMirror editor + a status line.
//   * Body can be edited inline; the factory recompiles on data.source
//     change.
//   * Deleting the runner cancels the subscription (dispose
//     unsubscribes from the scheduler-clock).
//   * Has NO audio I/O — it mutates the rack via the patch graph
//     (same shape as LIVECODE itself).
//
// Division-to-period derivation reads TIMELORDE's bpm from the live
// patch graph each tick (so a clock.bpm(140) call from the parent
// LIVECODE takes effect on the next runner tick without a restart).
// MIDI-locked tempo follows automatically once TIMELORDE's bpm param
// reflects the locked rate.
//
// Inputs: none.
// Outputs: none.
// Params: none. (Body source + division live in node.data, mutated by the
//   parent LIVECODE on `clocked()` invocations.)

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import { patch as livePatch, ydoc } from '$lib/graph/store';
import { getSchedulerClock } from '$lib/audio/scheduler-clock';
import { run as runLivecode } from '$lib/livecode/runtime';
import { applyMutations } from '$lib/livecode/apply';
import { divisionToBeatsPerTick, CLOCKED_DIVISIONS } from '$lib/livecode/api-surface';

export const CLOCKED_RUNNER_TYPE = 'clockedRunner';
export const CLOCKED_RUNNER_DEFAULT_DIVISION = '1/16';

export const clockedRunnerDef: AudioModuleDef = {
  // Literals (not CLOCKED_RUNNER_TYPE) so the manifest's static-literal
  // extractor in module-manifest.ts picks the field up. The constant
  // re-export above stays for runtime consumers.
  type: 'clockedRunner',
  palette: { top: 'livecode', sub: 'livecode' },
  domain: 'audio',
  label: 'clocked',
  category: 'utilities',
  inputs: [],
  outputs: [],
  params: [],

  // ⚠ ONE FAMILY, AND THE COUNT IS FORCED BY THE RESOLVER. `resolveFaceControl`
  // resolves a face key to a PARAM id, a family TEMPLATE (`<id>-{n}`) or a legend
  // STATIC — and this def declares `params: []`, so the division can only reach
  // the plate as a family. It is not a workaround: the division is a real named
  // affordance the module owns, and the `testidPrefix` is a literal the LEGACY
  // CARD already emits (`ClockedRunnerCard.svelte`,
  // `data-testid="clocked-runner-division"`), which is what module-docs-lint's
  // card-drift grep checks — so a rename on either surface is RED. The card file
  // survives promotion: `?shell=legacy` still renders it.
  //
  // ⚠ THE CALLBACK BODY IS NOT A FAMILY, and declaring one for it would be the
  // mistake. A family is a promise to RANK, and module-face-lint requires every
  // declared family to appear in `face.order` AND render exactly one cell — so
  // declaring the buffer here would force it into a cell kind that does not
  // exist. It rides the extension body instead.
  controlFamilies: [
    {
      id: 'clocked-runner-division',
      label: 'Division',
      kind: 'other',
      testidPrefix: 'clocked-runner-division',
    },
  ],

  docs: {
    explanation:
      "A self-contained mini-LIVECODE that owns a single clocked() callback. You don't add it from the palette — a LIVECODE module spawns one for you when your script calls clocked(division, fn), and the runner stores that function body plus its musical division (e.g. 1/16) on its own state. It subscribes to the rack's shared clock and re-runs the body on every tick that crosses the next division boundary, locked to TIMELORDE's tempo (so a clock.bpm(140) call retimes it on the next tick, and a MIDI-locked tempo follows automatically). Its faceplate shows the body in a code editor with a DIVISION picker beside it, and you can edit the body inline — it recompiles on change, and the next tick runs the new version. It has no audio jacks: like LIVECODE itself, it acts by mutating the rack through the patch graph each tick. The clock subscription belongs to the module rather than to any window onto it, so the body keeps firing whether or not its faceplate is open; deleting the module is what cancels it.",
    controls: {
      'clocked-runner-division-{n}':
        "How often the callback body runs, as a division of TIMELORDE's beat. 1/16 is sixteen evaluations per beat, 1 is once per beat, and 2x and 4x are SLOWER than a beat — one evaluation every two or four. The period is re-derived from the live tempo on every tick rather than latched when the runner was made, so a clock.bpm(140) from the parent LIVECODE, or a tempo locked to incoming MIDI clock, retimes this runner on its next boundary with no restart. Changing the division takes effect the same way, on the next boundary. The finest three settings (1/128, 1/256, 1/512) are derived from the worker scheduler's own 25 ms tick rather than from a TIMELORDE output port, because the master clock does not publish divisions that fine — so at a fast tempo they approach the scheduler's own resolution and stop getting proportionally faster.",
    },
  },

  // ── THE FACEPLATE (PF-20) ───────────────────────────────────────────────
  //
  // WHAT IT IS FOR, IN ONE PARAGRAPH. This is the only module in the fleet a
  // PLAYER never adds: a LIVECODE script writes it into existence by calling
  // `clocked(division, fn)`, and what it owns from then on is ONE callback body
  // and the rate that body runs at. Everything else about a rack — the patching,
  // the params, the spawning — is something this body DOES rather than something
  // the module has. The verb a player performs on it is RETIME: the code is
  // usually right and the question is how fast it should be happening.
  //
  // THE LADDER, read back as a sentence: at every tier you get the DIVISION, the
  // one thing about this runner that is a setting rather than a program; at the
  // dock you additionally get the body itself, editable in place, and the two
  // lamps that say whether it is firing and whether it is throwing.
  //
  // ⚠ WHY THE DIVISION IS THE ONE RANKED CELL. It is the only affordance here
  // that is not a document. It is also the only one that means anything at a
  // 192 px lane tile: a callback body is unreadable at that size, and a rate is
  // a single word.
  //
  // ⚠ `glyph: 'none'` IS THE ONLY LITERAL THAT COMPILES INTO A GREEN RUN, and
  // the premise is true by inspection rather than by luck. `glyphBinding`'s
  // live-audio arms all reach through `primaryAudioOutPortId`, which matches
  // `type === 'audio'` exactly; `outputs` is EMPTY, so every one of them
  // short-circuits. 'envelope' needs a/d/s/r params and there are none. Each
  // falls to `{kind:'static'}`, which module-face-lint reddens by name with no
  // exemption list. ('algorithm' would resolve, since it accepts a
  // `face.extension` — but it demands a `glyph` SLOT on that extension, and this
  // module's picture-of-itself is its own source code, which is not a glyph.)
  //
  // ⚠ NO `pages`. One ranked cell is one band, and a section header reading
  // 'clock' over a single cell captioned DIV adds a ~81 px band to say nothing
  // the cell has not said. `face.pages` is for a face with more than one IDEA in
  // it; `DOCK_TAB_MIN_BANDS` is 7 and nothing here is padded toward a rail.
  //
  // ⚠ NO `rear` GROUPS: `inputs` and `outputs` are both empty, so there is no
  // jack for a group to name and module-face-lint refuses a group that resolves
  // to no port at all.
  //
  // ⚠ NO HERO. A hero promotes a CONTROL, and there is exactly one — promoting
  // it would EMPTY its band (`heroFacePlan` MOVES the key), leaving a plate with
  // a hero rail and no sections. There is no derived quantity wanting a stage
  // either: the fire count and the tempo are on the FIRING lamp's accessible
  // name, which is where the 2026-08-19 rulings put a measurement.
  //
  // The callback body, the FIRING lamp and the ERROR lamp are the extension's
  // `fullViewBody` — see $lib/ui/modules/clockedRunner/shell-extension.ts.
  face: {
    glyph: 'none',
    order: ['clocked-runner-division-{n}'],
    extension: 'clockedRunner',
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    const nodeId = node.id;
    let alive = true;
    let unsubscribeTick: (() => void) | null = null;
    let lastError: string | null = null;
    let lastBpm = 120;
    let lastFiredAtCtxTime = ctx.currentTime;
    let firesSinceMount = 0;
    let errorsSinceMount = 0;

    function readData(): { division: string; source: string; ownerNodeId: string | undefined } {
      const live = livePatch.nodes[nodeId];
      const d = (live?.data as Record<string, unknown> | undefined) ?? {};
      const division = typeof d.division === 'string' ? d.division : CLOCKED_RUNNER_DEFAULT_DIVISION;
      const source = typeof d.source === 'string' ? d.source : '';
      const ownerNodeId = typeof d.ownerNodeId === 'string' ? d.ownerNodeId : undefined;
      return { division, source, ownerNodeId };
    }

    function readTimelordeBpm(): number {
      for (const n of Object.values(livePatch.nodes)) {
        if (n?.type === 'timelorde') {
          const bpm = n.params?.bpm;
          if (typeof bpm === 'number' && bpm > 0) return bpm;
        }
      }
      return 120;
    }

    function tick(): void {
      if (!alive) return;
      const { source, division, ownerNodeId } = readData();
      if (!source.trim()) return;

      const bpm = readTimelordeBpm();
      lastBpm = bpm;
      const beatsPerTick = divisionToBeatsPerTick(division as never) ?? 1 / 4;
      const periodSec = 60 / bpm / beatsPerTick;
      const nowAt = ctx.currentTime;
      const elapsed = nowAt - lastFiredAtCtxTime;
      if (elapsed < periodSec) return;
      lastFiredAtCtxTime = nowAt;

      // Run the body as a top-level script via the same runtime as
      // LIVECODE itself. Any mutations come back in result.mutations;
      // we apply them under one ydoc.transact so collaborators see
      // the rack change atomically per tick.
      const result = runLivecode({
        src: source,
        liveNodes: livePatch.nodes,
        liveEdges: livePatch.edges,
        ownerNodeId,
      });
      if (!result.ok) {
        errorsSinceMount += 1;
        lastError = `${result.error.line}:${result.error.col}: ${result.error.message}`;
        return;
      }
      lastError = null;
      firesSinceMount += 1;
      if (result.mutations.length > 0) {
        try {
          ydoc.transact(() => applyMutations(result.mutations));
        } catch (e) {
          errorsSinceMount += 1;
          lastError = `apply: ${(e as Error).message}`;
        }
      }
    }

    const clock = getSchedulerClock();
    unsubscribeTick = clock.subscribe(tick);

    return {
      domain: 'audio',
      inputs: new Map(),
      outputs: new Map(),
      setParam() { /* no params */ },
      readParam() { return undefined; },
      read(key: string): unknown {
        if (key === 'lastError') return lastError;
        if (key === 'bpm') return lastBpm;
        if (key === 'firesSinceMount') return firesSinceMount;
        if (key === 'errorsSinceMount') return errorsSinceMount;
        return undefined;
      },
      dispose() {
        alive = false;
        unsubscribeTick?.();
      },
    };
  },
};

export { CLOCKED_DIVISIONS };
