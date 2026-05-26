// Tracks which keyboard codes are currently held on a DOOM card so we can
// synthesise key-up for everything still pressed when the card stops
// owning the keyboard. The card claims keys via a window capture-phase
// listener gated on focus/selection; if the card is deselected (click
// another node) or the window loses focus (alt-tab) while a key is held,
// the matching keyup is either dropped by the claim gate or never fires
// at all — leaving the key asserted in the WASM input queue and movement
// stuck. The tracker lets us release exactly the keys we pressed.

/** Pushes a key press/release downstream. Returns true if the code maps
 *  to a DOOM key (so the caller knows whether to track it). */
export type KeySink = (code: string, pressed: boolean) => boolean;

export class HeldKeyTracker {
  private readonly held = new Set<string>();

  constructor(private readonly sink: KeySink) {}

  /** Handle a keydown. `repeat` is the KeyboardEvent.repeat flag — OS
   *  auto-repeat re-fires keydown ~30×/s for an already-held key, which
   *  we ignore (the key is already down + it floods the relay). Returns
   *  true if the key was mapped + tracked. */
  down(code: string, repeat = false): boolean {
    if (repeat) return false;
    const handled = this.sink(code, true);
    if (handled) this.held.add(code);
    return handled;
  }

  /** Handle a keyup. Forwards the release + stops tracking. */
  up(code: string): boolean {
    this.held.delete(code);
    return this.sink(code, false);
  }

  /** Whether this code is currently held (so a keyup for it must be
   *  routed even if the card no longer claims the keyboard). */
  has(code: string): boolean {
    return this.held.has(code);
  }

  /** Release every still-held key (call on blur / tab-hide). */
  releaseAll(): void {
    if (this.held.size === 0) return;
    for (const code of this.held) this.sink(code, false);
    this.held.clear();
  }

  get size(): number {
    return this.held.size;
  }
}
