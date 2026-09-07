# `trails` bespoke surface — OPEN QUESTIONS

Four owner calls. Each has a **recommended default the build can proceed on**
without an answer; none of them blocks. Everything else in
[`spec.md`](./spec.md) is derived from the tree or from a shipped precedent and
is not offered as a choice.

---

## Q1 — Does the SCREEN ON/OFF convention apply to the pad mirror?

**Recommended default: NO — no SCREEN switch, and it is a derivation rather than
a preference.**

The fleet-wide ruling ("all video cards get SCREEN ON/OFF, and the module keeps
rendering while OFF") runs over `STRICT_FACES ∩ video defs`. `trails` is
`domain: 'audio'` and declares no video port, so the ruling does not reach it —
the same sentence `spectrograph`, `samsloop`, `audioOut`, `dockscope` and
`graphicEq` each write in their `EXTENSION_BODY_ROLES` entry.

The two nearest precedents differ, and the difference is the whole answer:

| module | domain | video port | SCREEN |
|---|---|---|---|
| `skifree` | audio | ✅ `out` — the slope IS a video source the rack consumes | ✅ has one |
| `dockscope` / `spectrograph` / `samsloop` | audio | ❌ | ❌ none |
| **`trails`** | audio | ❌ | **none recommended** |

And on the merits, independent of the ruling: **there is nothing for a switch to
turn off.** The decode, the monitor and all 21 jacks live in the FACTORY, on the
WebMIDI callback and the shared scheduler tick — they run with no surface
mounted, which is the property SCREEN OFF exists to protect on a video module.
The paint loop already self-suppresses: an idle mirror costs one integer compare
per frame, not a repaint. A toggle would add a control, a `node.data` key on a
module that deliberately writes none, and a second state for VRT to capture, in
exchange for a saving the dirty check already makes.

**If the owner wants one anyway:** it is a small change — a `previewCollapsed`
flag on `node.data`, honoured by both bodies (skifree's shape: one flag, two
surfaces, no way for them to disagree). The cost is the `node.data` write, which
breaks the module's "no `node.data` writes at all" property, and one extra VRT
state.

---

## Q2 — How wide should the dock pad mirror be?

**Recommended default: 140 px — exactly the card's `max-width`, kept.**

The card caps the mirror at 140 px because a full-width pad would push a 260 px
card past its declared rack tier. **The dock plate does not have that
constraint**, so the cap is now a parity choice rather than a fit constraint,
and 140 px makes this one of the narrowest plates in the fleet.

* **140 px (default)** — pixel-for-pixel the picture the owner has been using.
  Four dots and their trails resolve fine at this size; the card's own comment
  says so.
* **200-240 px** — the pad is 85 mm square in real life and a bigger mirror
  reads more like the panel; it also gives the fading trail room to be legible
  as a *gesture* rather than a smear. Costs one CSS value and a re-baseline.

This is a look change, so it wants an owner preview before merge either way
(the standing "look changes = review before merge" discipline). Building at
140 px keeps the first baseline honest to the card, and widening later is a
one-line diff plus a scoped `GREP=trails` VRT re-pin.

---

## Q3 — `bar — not sent over USB-MIDI`: DOM text, or painted into the canvas?

**Recommended default: keep it as DOM text under the mirror, verbatim.**

It is a sentence on a resting faceplate, which is not obviously one of the four
permitted text roles — so it needs an argument, and it has one (spec.md §6.3):
it *names the surface's own condition*, which is the ground `samsloop`'s
in-canvas `NO SAMPLE LOADED` and `dockscope`'s `±5V` annotation already stand
on. It measures nothing, it never changes, and it is gated on the same
`TRAILS_BAR_TRANSMITS_MIDI` flag as the hatch, so a firmware that starts
transmitting the Bar removes the hatch and the denial in one edit rather than
leaving a stale denial under a live strip.

**The alternative, if that reads as too much prose on the plate:** draw the
words INSIDE the canvas as the strip's own label — strictly safer under the
resting-text gate (which is blind to canvas text by design), strictly less 1:1
with the card, and it would shrink to ~6 px at the lane tier, which is why the
tile carries the hatch alone in either case.

⚠ Note for the record: `face-resting-text-source` **cannot see** this string
either way, because it lives in an extension body. The `EXTENSION_BODY_ROLES`
`why` is the only gate that names it, which is why spec.md §7 spells it out
there in full.

---

## Q4 — Should MON be reachable from the lane tile?

**Recommended default: NO — dock only.**

Not a taste call as written: the tile's body budget is
`LANE_BODY_H (112) − LANE_KNOB_READOUT_H (57) − 4 px gap ≈ 51 px`, and the MON
panel alone is taller than that. The readout is a 22-character padded label plus
a count and a value per row, rendered `pre-wrap` at 172 px of inner width, and
its entire value is that it can be **selected and pasted** into a message.

Every other affordance the card has is on the tile: CONNECT (ranked first, so it
survives every tier), the LINK lamp with its sentence on `title`, and the pad
mirror at 46 px. MON is the one that is a sit-down activity — you open it when
you are already asking a question about the hardware — and the dock is one click
away.

**If the owner wants MON on the tile:** the honest version is a MON *button* on
the tile that expands the module into the dock with the panel already open,
rather than a 172 px-wide log nobody can read. That is a new interaction, so it
is offered rather than assumed.
