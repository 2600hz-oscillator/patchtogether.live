// packages/web/src/lib/ui/modules/outToLaunch/out-to-launch-status-model.test.ts
//
// WHERE THE CARD'S FOUR SENTENCES WENT — asserted, because a promotion that
// silently drops one of them looks exactly like a promotion that relocated it.
//
// ⚠ THE HIGH-VALUE ONE IS THE EXCLUSIVITY WARNING. The card painted "MONITOR
// ACTIVE — this Launchpad's LEDs mirror the video. It can't be used for control
// while bound." That is DERIVED RESTING PROSE, which a faceplate may not paint —
// but it is not decoration either: it describes a real mechanism
// (`isOutputClaimed`, one owner per physical surface), so dropping it would lose
// a fact the player needs. It survives as the MONITOR lamp's `detail`, which
// `StatusLed` puts in BOTH `aria-label` and `title`.

import { describe, expect, it } from 'vitest';
import type { LaunchpadPort } from '$lib/control/launchpad/launchpad-device.svelte';
import {
  outToLaunchEmptyLine,
  outToLaunchErrorLine,
  outToLaunchMonitorDetail,
  outToLaunchPickerVisible,
  outToLaunchPortLabel,
  outToLaunchPortTitle,
  outToLaunchUnbindVisible,
  type OutToLaunchBinderView,
} from './out-to-launch-status-model';

const PORT: LaunchpadPort = { outputId: 'lp-1', name: 'Launchpad Mini MK3' } as LaunchpadPort;

function view(over: Partial<OutToLaunchBinderView> = {}): OutToLaunchBinderView {
  return { supported: true, bound: false, outputId: null, outcome: 'idle', ports: [], ...over };
}

describe('the MONITOR lamp carries the card banner', () => {
  it('names WHICH device and what binding costs — the exclusivity warning', () => {
    const detail = outToLaunchMonitorDetail(view({ bound: true, outputId: 'lp-1' }));
    expect(detail, 'the device, which a two-state picture cannot carry').toContain('lp-1');
    expect(detail, 'and the warning the card painted').toMatch(/cannot be used for control/i);
  });

  it('never restates the lamp — `lit` already says "something is bound"', () => {
    // A lamp's whole job is to be a picture; a `detail` that repeated the
    // boolean would be a state word smuggled through the accessible name.
    const bound = outToLaunchMonitorDetail(view({ bound: true, outputId: 'lp-1' }));
    expect(bound).not.toMatch(/^bound\b/i);
    expect(outToLaunchMonitorDetail(view({ bound: false }))).toMatch(/no launchpad is bound/i);
  });
});

describe('errors are absent whenever nothing is wrong', () => {
  it('a healthy browser with a device produces NO error line, ever', () => {
    expect(outToLaunchErrorLine(view())).toBeNull();
    expect(outToLaunchErrorLine(view({ ports: [PORT] }))).toBeNull();
    expect(outToLaunchErrorLine(view({ bound: true, outputId: 'lp-1' }))).toBeNull();
  });

  it('carries the card\'s two warnings, and they are different conditions', () => {
    expect(outToLaunchErrorLine(view({ supported: false }))).toMatch(/web midi isn't available/i);
    expect(outToLaunchErrorLine(view({ outcome: 'no-device' }))).toMatch(/no launchpad detected/i);
  });

  it('NO WEB MIDI wins over NO DEVICE — the roster question is moot without the capability', () => {
    expect(outToLaunchErrorLine(view({ supported: false, outcome: 'no-device' }))).toMatch(
      /web midi isn't available/i,
    );
  });
});

describe('the empty state names a missing condition and claims nothing about behaviour', () => {
  it('shows only before anything is enumerated or bound', () => {
    expect(outToLaunchEmptyLine(view())).toMatch(/no launchpad connected/i);
    expect(outToLaunchEmptyLine(view({ ports: [PORT] })), 'replaced by the picker').toBeNull();
    expect(outToLaunchEmptyLine(view({ bound: true })), 'replaced by the lit lamp').toBeNull();
    expect(outToLaunchEmptyLine(view({ outcome: 'listing' })), 'a gesture is in flight').toBeNull();
    expect(outToLaunchEmptyLine(view({ supported: false })), 'the ERROR owns this state').toBeNull();
  });
});

describe('the two body controls appear exactly when they have something to act on', () => {
  it('the PICKER needs a roster and no existing claim', () => {
    expect(outToLaunchPickerVisible(view({ ports: [PORT] }))).toBe(true);
    expect(outToLaunchPickerVisible(view()), 'nothing to pick').toBe(false);
    expect(
      outToLaunchPickerVisible(view({ ports: [PORT], bound: true })),
      'already bound — UNBIND is the control here, not a second pick',
    ).toBe(false);
    expect(outToLaunchPickerVisible(view({ ports: [PORT], supported: false }))).toBe(false);
  });

  it('UNBIND needs a claim — it is ABSENT rather than disabled', () => {
    // An action with nothing to act on is the "looks alive and is not" defect
    // that keeps BIND/UNBIND off the ranked cells in the first place. On a
    // surface we can simply not render it.
    expect(outToLaunchUnbindVisible(view({ bound: true }))).toBe(true);
    expect(outToLaunchUnbindVisible(view())).toBe(false);
  });

  it('the two are MUTUALLY EXCLUSIVE — no state offers both', () => {
    for (const v of [
      view(),
      view({ ports: [PORT] }),
      view({ bound: true, outputId: 'lp-1' }),
      view({ bound: true, outputId: 'lp-1', ports: [PORT] }),
      view({ supported: false }),
      view({ outcome: 'no-device' }),
    ]) {
      expect(
        outToLaunchPickerVisible(v) && outToLaunchUnbindVisible(v),
        `a plate offering both a pick and a release: ${JSON.stringify(v)}`,
      ).toBe(false);
    }
  });
});

describe('a port button is an OPTION NAME, suffix included', () => {
  it('distinguishes a claimed port, which renders disabled', () => {
    expect(outToLaunchPortLabel(PORT, false)).toBe('Launchpad Mini MK3');
    expect(outToLaunchPortLabel(PORT, true)).toBe('Launchpad Mini MK3 (in use)');
    expect(outToLaunchPortTitle(true)).toMatch(/already in use/i);
    expect(outToLaunchPortTitle(false)).toMatch(/bind as monitor/i);
  });
});
