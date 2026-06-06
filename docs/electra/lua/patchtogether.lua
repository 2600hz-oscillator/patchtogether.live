-- docs/electra/lua/patchtogether.lua
--
-- Electra One Lua layer for the patchtogether MULTI-VIEW preset.
-- Uploaded to the device via SysEx 01 0C (the editor "Lua" pane).
--
-- WHAT LUA CAN / CANNOT DO HERE
--   - CAN: format displayed values (units, curves), gate (grey/show) controls,
--     handle pad onChange (mute/solo), draw a custom VU (Option 2).
--   - CANNOT: create controls or pages at runtime (all defined in the .epr),
--     and has NO sub-second timer — all timing/animation is host-driven.
--     => Tap-tempo MATH is done in the APP (tap-tempo.ts), not here; the pad
--        just sends a momentary note the app times.
--
-- The host (the web app) pushes:
--   - per-control value/meter CCs (parameter-map auto-sync) for the displays,
--   - info.setText("INT 120" / "EXT 128") for the SYSTEM source banner (08 0D),
--   - pt_setExternal(true/false) to gate the TAP pad + BPM encoder in EXT mode.

-- ───────────────────────── formatters ─────────────────────────

-- %+.1f dB — for EQ bands, thresholds, etc. (units == 'dB').
function fmtDb(valueObject, value)
  return string.format("%+.1f dB", value)
end

-- N.N:1 — compressor ratio.
function fmtRatio(valueObject, value)
  return string.format("%.1f:1", value)
end

-- BPM, applying the log map 10..300 the param uses (the device pot is linear
-- 0..127; the app's setter applies the same log curve on write, so this just
-- mirrors it for the DISPLAY).
function fmtBpm(valueObject, value)
  -- value arrives already in BPM units (the app pushes the mapped value back as
  -- feedback), so a plain integer render is correct.
  return string.format("%d BPM", math.floor(value + 0.5))
end

-- "measured vs internal" BPM readout — the host pushes the effective BPM; this
-- just labels it. The SRC banner (INT/EXT) carries the source.
function fmtBpmDisplay(valueObject, value)
  return string.format("%d", math.floor(value + 0.5))
end

-- ───────────────────────── source banner ─────────────────────────
--
-- The host calls info.setText("INT 120") / ("EXT 128") via Execute-Lua (08 0D).
-- Nothing to do here beyond providing the entry point the host invokes:
function pt_setBanner(text)
  info.setText(text)
end

-- ───────────────────────── tap-pad / BPM gating ─────────────────────────
--
-- The host pushes the external-clock flag. In EXT mode the hardware clock is
-- master, so the TAP pad + BPM encoder are inert — grey them out so the player
-- isn't misled into thinking a tap will retempo.
--
-- Control ids below MUST match the generated .epr (the app keeps them stable;
-- update if you re-lay-out the SYSTEM page). Defaults assume TAP + BPM are the
-- first two SYSTEM-page controls.
local TAP_CONTROL_ID = nil   -- set to the .epr control id of the TAP pad
local BPM_CONTROL_ID = nil   -- set to the .epr control id of the BPM encoder

function pt_setExternal(isExternal)
  local variant = isExternal and "outline" or "default"
  if TAP_CONTROL_ID then
    local tap = controls.get(TAP_CONTROL_ID)
    if tap then tap:setActive(not isExternal) end
  end
  if BPM_CONTROL_ID then
    local bpm = controls.get(BPM_CONTROL_ID)
    if bpm then bpm:setActive(not isExternal) end
  end
end

-- ───────────────────────── MIXMASTER mute / solo ─────────────────────────
--
-- PAN/MUTE/SOLO are GAPs in the DSP (no such params). MUTE is EMULATED here:
-- the pad onChange writes the channel-volume CC to 0 and restores the saved
-- value on un-mute. SOLO zeroes the OTHER channels. These round-trip to the app
-- (-> chN_volume), so the state stays Yjs-synced + reconciled.
--
-- savedVol[ch] holds the pre-mute volume CC so un-mute restores it.
local savedVol = {}

-- chCcForVolume(ch) must return the CC the .epr assigned to chN_volume.
-- The host can patch these at upload time; left as a table to fill in.
local VOLUME_CC = { [1] = nil, [2] = nil, [3] = nil, [4] = nil }

function pt_muteChannel(ch, muted)
  local cc = VOLUME_CC[ch]
  if not cc then return end
  if muted then
    savedVol[ch] = parameterMap.get(PORT_CTRL, MIDI_CHANNEL, cc) or 127
    parameterMap.set(PORT_CTRL, MIDI_CHANNEL, cc, 0)
  else
    parameterMap.set(PORT_CTRL, MIDI_CHANNEL, cc, savedVol[ch] or 100)
  end
end

function pt_soloChannel(soloCh)
  for ch = 1, 4 do
    pt_muteChannel(ch, ch ~= soloCh)
  end
end

-- PORT_CTRL / MIDI_CHANNEL mirror the .epr device 1 (PT-CTRL, port 2, ch 1).
PORT_CTRL = 2
MIDI_CHANNEL = 1
