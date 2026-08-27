// Display identity for "Present on …".
//
// The web platform exposes NO persistent per-monitor id. `ScreenDetailed`
// carries `label` (spec-permitted to be an empty string), geometry,
// `devicePixelRatio`, `colorDepth` and two booleans — nothing an OS guarantees
// across a reboot. So a saved display binding cannot be an id lookup; it is a
// fingerprint match with a fallback ladder, the same shape `resolveMidiDeviceId`
// uses for MIDI hardware.

export interface ScreenDescriptor {
  label: string;
  isInternal: boolean;
  width: number;
  height: number;
  dpr: number;
  /** Arrangement origin in the multi-screen coordinate space. */
  left: number;
  top: number;
}

interface ScreenLike {
  readonly label?: string;
  readonly isInternal?: boolean;
  readonly width?: number;
  readonly height?: number;
  readonly devicePixelRatio?: number;
  readonly left?: number;
  readonly top?: number;
}

export function describeScreen(s: ScreenLike): ScreenDescriptor {
  return {
    label: s.label ?? '',
    isInternal: s.isInternal === true,
    width: s.width ?? 0,
    height: s.height ?? 0,
    dpr: s.devicePixelRatio ?? 1,
    left: s.left ?? 0,
    top: s.top ?? 0,
  };
}

/** Identity excluding everything the OS can change while the monitor stays the
 *  same: position (rearranged in Display settings) and primary-ness (moving the
 *  menu bar). Two identical monitors legitimately share a key. */
export function screenKey(d: ScreenDescriptor): string {
  return `${d.label}|${d.width}x${d.height}|@${d.dpr}|${d.isInternal ? 'int' : 'ext'}`;
}

/** Stable ids aligned to the input order. Screens sharing a key are
 *  disambiguated by arrangement order, so the suffix survives a reload as long
 *  as the physical layout does. */
export function assignScreenIds(screens: ScreenDescriptor[]): string[] {
  const byKey = new Map<string, ScreenDescriptor[]>();
  for (const s of screens) {
    const k = screenKey(s);
    const group = byKey.get(k);
    if (group) group.push(s);
    else byKey.set(k, [s]);
  }
  for (const group of byKey.values()) {
    group.sort((a, b) => a.left - b.left || a.top - b.top);
  }
  return screens.map((s) => {
    const k = screenKey(s);
    const group = byKey.get(k)!;
    if (group.length === 1) return k;
    return `${k}#${group.indexOf(s)}`;
  });
}

type Tier = (saved: ScreenDescriptor, live: ScreenDescriptor) => boolean;

const sameGeometry = (a: ScreenDescriptor, b: ScreenDescriptor) =>
  a.width === b.width && a.height === b.height && a.dpr === b.dpr;

/** Strongest first. A tier that matches more than one unclaimed live screen is
 *  SKIPPED for that binding rather than guessed at — the next tier gets to
 *  break the tie, and an unresolvable binding stays unresolved. */
const TIERS: Tier[] = [
  (s, l) => screenKey(s) === screenKey(l) && s.left === l.left && s.top === l.top,
  (s, l) => screenKey(s) === screenKey(l),
  (s, l) => s.label !== '' && s.label === l.label && sameGeometry(s, l),
  (s, l) => s.label !== '' && s.label === l.label,
  (s, l) => sameGeometry(s, l) && s.isInternal === l.isInternal,
  (s, l) => s.left === l.left && s.top === l.top,
];

/**
 * Match saved descriptors against the live display set. Returns, per saved
 * entry, the index of the live screen it resolved to, or -1.
 *
 * Resolution is over the SET, not per binding: each live screen is claimed at
 * most once, so two outputs saved to two monitors cannot both land on one.
 */
export function resolveScreens(
  saved: ScreenDescriptor[],
  live: ScreenDescriptor[],
): number[] {
  const result = new Array<number>(saved.length).fill(-1);
  const claimed = new Set<number>();

  for (const tier of TIERS) {
    for (let i = 0; i < saved.length; i++) {
      if (result[i] !== -1) continue;
      const candidates: number[] = [];
      for (let j = 0; j < live.length; j++) {
        if (!claimed.has(j) && tier(saved[i], live[j])) candidates.push(j);
      }
      if (candidates.length === 1) {
        result[i] = candidates[0];
        claimed.add(candidates[0]);
      }
    }
  }
  return result;
}
