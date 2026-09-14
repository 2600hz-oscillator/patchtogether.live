# Backdraft: Crutchfield mode

The owner requested an analog camera–monitor feedback mode after reading
James P. Crutchfield, *Space-time dynamics in video feedback*, Physica D 10
(1984), 229–245, DOI 10.1016/0167-2789(84)90264-1. The follow-up request was a
way to reroll and save the camera's sensor geometry. These requests authorize
the new mode and reroll action; the numerical choices below are implementation
approximations, not owner rulings or values fitted to the experimental hardware.

## What the existing phosphor control could not do

The current `phosphor` control blends the completed image with the previous
output at the same coordinates. Its unit DC gain leaves a settled image
unchanged. It does not distinguish stored camera charge from monitor emission.
Some older comments still describe a gain ceiling in VIRTUAL CAMERA; the code
removed that ceiling and permits white-out. Modes 0–2 retain their behavior.

## Physical path

The new fourth mode executes this loop once per rendered field:

1. The delayed camera signal drives monitor brightness, contrast, RGB levels,
   luminance and chroma, followed by clipping and CRT gamma.
2. Scan-line and RGB-triad emission excites a persistent display image.
3. A perspective camera photographs that display, bezel and surrounding room.
   Zoom can cross unity; rotation, tilt, position and distance reuse Backdraft's
   existing camera projection. Light outside the display does not come from
   a clamped display-edge pixel.
4. Spatial diffusion, lens distortion, colour coupling and a nonlinear pickup
   response produce incoming charge. The sensor integrates this with its own
   previous charge at the same sensor coordinates.
5. The captured image enters Backdraft's existing output/delay ring.

The two separate histories are the important distinction. Turning the camera
reprojects the glowing monitor but does not move already-stored sensor charge.
Changing a response curve affects later passes, rather than recolouring a
finished image.

Equations 4–5 (pp.235–236) motivate spatial diffusion, temporal storage and RGB
coupling. Appendix A (pp.243–245) gives a rough 1/3-second camera storage time,
roughly 250–300-element spatial resolution, gamma in the 0.6–0.9 range, and
spatially nonuniform sensitivity. It identifies the camera as the dominant
storage element, with a shorter-lived monitor phosphor.

## Controls and reproducibility

Select **CRUTCHFIELD** under **switches → TV Mode**. Its dedicated tab contains:

| Control | Effect |
| --- | --- |
| Defocus | Widens the camera's spatial diffusion kernel |
| Sensor lag | Camera-charge time constant, default 0.333 s |
| Tube decay | Display-emission time constant, default 0.025 s |
| Exposure | Manual incident-light gain, before nonlinear capture |
| Brightness | Monitor DC offset / black cutoff |
| Contrast | Monitor gain around mid-grey |
| Variation | Strength of fixed lens and sensor imperfections |
| Sensor seed | Reproducible camera identity |

**REROLL SENSOR** changes only the saved seed, in one undoable patch operation.
It does not clear the running image. Reloading the same seed reproduces the
camera profile; transient feedback history is not serialized. Variation zero
removes every seeded difference. No frame clock enters the camera profile.

The existing feedback, colour, geometry, camera, source-mix, mask and delay
controls remain available. PHOS and DRIVE belong to the older TV modes; use
the separate physical storage controls in CRUTCHFIELD. PANIC resets the new
controls through its existing definition-derived reset.

## Approximation boundaries

- The display uses a chosen gamma of 2.2 and a field-averaged RGB raster model.
  This is not a complete NTSC encoder, electron-beam or interlace simulation.
- Spatial diffusion is a nine-tap Gaussian approximation with an intrinsic
  pickup blur; it does not solve the paper's PDE or reproduce a measured lens.
- Channel lifetimes, 2.5% colour cross-talk and smooth seeded lens/sensitivity
  fields are illustrative engineering choices. High Variation and long Tube
  decay deliberately exaggerate the hardware effects.
- The camera is manually exposed. CRITICAL's automatic servo is not part of
  this mode, and no particular chaotic attractor is guaranteed.
- A rendered step represents one virtual 60 Hz field, matching the existing
  delay ring. Slow rendering slows the simulation rather than catching up.
- Four lazy intermediate textures retain the two histories. Float targets
  avoid quantized decay plateaus when supported; the engine's RGBA8 fallback
  has reduced precision. Targets are released on mode exit and recreated when
  resolution changes. The published delay ring remains RGBA8.

## Verification and its limits

Unit tests check mode-number compatibility, physical decay coefficients,
seed reproducibility, full-period rerolling, Yjs replication and undo. These
cannot see disconnected shader uniforms.

The focused browser test drives the real factory and shaders for exact frame
counts, reads their actual output textures, and checks seeded differences
against identical-seed and zero-variation controls. It also checks camera
angle, focus, colour gain, independent monitor/camera tails, freeze and the
shipping face's reroll action. These establish mechanism and reproducibility;
they do not establish fidelity to the paper's experimental attractors.

No locally captured VRT baseline is accepted. Visual review and the repository's
release checks remain distinct from these behavioral measurements.

Local validation: the changed unit tests and all five GPU/face scenarios passed
three consecutive runs. Type checking, module-face lint, module documentation
and the regenerated parameter contract passed. The contract diff contains only
the eight added Backdraft controls and the appended TV-mode value. A fresh full
WebGL release attestation is still required before shipping.
