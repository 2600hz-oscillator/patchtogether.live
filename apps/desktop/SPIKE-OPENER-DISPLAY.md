# Opener→popup display spike — hardware review before P4

**Status: awaiting the owner's two-monitor review.** This harness tests the
output-window premise in the [active native-shell plan](../../evidence/active/2026-09-04-native-shell-plan/plan.md).
It uses the shipped loopback server, security policy, preload and `/present`
sink. The opener installs the drawing callback; the sink's own animation frames
call it. Helpers and the native menu/command bridge are outside this experiment.

The [earlier P2 probe](../../evidence/archive/2026/2026-09-04-native-shell-plan/p2-notes.md)
established single-display DOM access. Its archived record is unchanged.

## Run on the hardware

```sh
flox activate -- task desktop:install
flox activate -- task desktop:build:web
flox activate -- task desktop:spike
```

Connect two physical displays and disable mirroring. The harness prints display
IDs, labels, bounds and scale factors, and chooses the first eligible extended
display. To choose a particular target from that listing:

```sh
flox activate -- task desktop:spike -- --display-id=2
```

Use the actual printed ID; it is not a one-based display index. Missing, invalid,
known unified-virtual, mirrored and overlapping targets cannot establish a pass.
Electron's display list can still include remote or virtual displays, so the
operator confirms the physical target.

The popup shows magenta, a moving white marker, and an advancing frame number.
After the automatic checks, a dialog on the main window asks you to confirm that
these are visible on the target physical monitor. Check the mirroring-off box and
choose **Confirm visible motion** only after looking at that monitor. Cancel,
closing the dialog, or leaving the box unchecked fails the operator step. The
machine watchdog pauses for this human review, so the pattern stays available.
The harness samples frames and checks placement again after your confirmation.

## What each check establishes

| Step | Evidence |
|---|---|
| `displays` | An eligible extended target exists. The operator separately confirms physical hardware. |
| `placement` | The popup is visible, not minimized, and contained on the target after rendering and page captures. Checked again after review. The initial features-string placement and any main-process correction are recorded. |
| `domAccess` | The opener reached the real sink canvas and installed the same-origin frame callback. |
| `blitPixels` | Every sampled canvas background is magenta and its encoded counter matches the frame count read in the same popup-renderer turn. |
| `motion` | A window of real sink frames advances. Blank, corrupt or frozen samples cannot pass by merely differing from the first image. |
| `composited` | Two saved page captures show magenta and advancing encoded counters, separated by another observed frame window. This catches hidden canvases and a frozen composited image even when the canvas buffer is updating. |
| `operator` | You saw the moving picture on the target physical display with mirroring off. Required for a real-mode pass. |

Canvas `getImageData()` measures the backing store. Electron's
[`capturePage()`](https://www.electronjs.org/docs/latest/api/web-contents#contentscapturepagerect-opts)
measures the web page. Neither establishes what a physical projector or monitor
actually shows. The operator check covers that remaining gap. Display IDs also
have [documented virtual/headless limitations](https://www.electronjs.org/docs/latest/api/structures/display).

Readiness and sampling run in renderer animation frames. Main-process timeouts
bound failures; they never supply a passing sample. Fullscreen/DPR geometry
changes restart the sampling window, and a zero-sample run fails with tick and
elapsed-time diagnostics.

All steps must pass in real mode. A failure needs diagnosis from its recorded
step and images; a confirmed cross-display failure returns the output design to
review before P4. A dry-run never certifies hardware or unblocks P4.

## Records and optional crash observation

Each run writes a JSON record and up to two page-capture PNGs in
`apps/desktop/spike-results/`. Failure to save the record fails the run. The JSON
contains the actual observations, sampled frames, placement before/after review,
operator response, and the final exit code. Keep the PNGs with the JSON.

```sh
flox activate -- task desktop:spike -- --crash-probe
```

After verification, this optional probe crashes the opener renderer and records
the popup's fate under the shipped window handler. It is an observation for the
[interruption matrix](../../evidence/active/2026-09-04-native-shell-plan/interruption-matrix.md),
not an extra architecture verdict or a test of a different window policy.

## Check the instrument without hardware

```sh
flox activate -- task desktop:spike -- --dry-run
flox activate -- task desktop:spike:check
flox activate -- env REPEAT=3 task desktop:spike:check
```

`spike:check` runs the pure unit tests and the actual Electron harness against the
built sink. A healthy run must pass. Hidden output, a frozen composited image,
a later blank frame, frozen drawing, zero samples and an unwritable result
directory must fail. It also proves fault injection is refused in real mode.
These are local checks; this PR adds no required CI job. The self-test prints
its temporary result directory, containing each case's logs and records.

## Hardware result

Record the verdict here and attach the JSON and PNGs to the
[active planning package](../../evidence/active/2026-09-04-native-shell-plan/).
Update the active plan's output-window row with the recorded result.

```text
date / Electron version:
physical target / printed display ID:
mirroring off:
visible moving marker and advancing frame number:
automatic verdict / operator verdict:
placement or fullscreen problems:
optional crash observation:
JSON and PNG paths:
P4 decision after reviewing the evidence:
```
