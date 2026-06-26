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
  schemaVersion: 1,
  inputs: [],
  outputs: [],
  params: [],

  docs: {
    explanation:
      "A self-contained mini-LIVECODE that owns a single clocked() callback. You don't add it from the palette — a LIVECODE module spawns one for you when your script calls clocked(division, fn), and the runner stores that function body plus its musical division (e.g. 1/16) on its own state. It subscribes to the rack's shared clock and re-runs the body on every tick that crosses the next division boundary, locked to TIMELORDE's tempo (so a clock.bpm(140) call retimes it on the next tick, and a MIDI-locked tempo follows automatically). Its card shows the body in a code editor with a status line, and you can edit the body inline — it recompiles on change. It has no audio jacks: like LIVECODE itself, it acts by mutating the rack through the patch graph each tick. Deleting it cancels its clock subscription.",
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
