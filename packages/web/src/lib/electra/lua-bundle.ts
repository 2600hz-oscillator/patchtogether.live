// packages/web/src/lib/electra/lua-bundle.ts
//
// The Lua layer the broker uploads to the device (SysEx 01 0C). Kept as a TS
// string constant (rather than a ?raw import of docs/electra/lua/*) so it bundles
// cleanly in the web build and the docs templates stay editable independently.
// Mirrors docs/electra/lua/patchtogether.lua — when you change the device-facing
// behaviour, update BOTH (the docs copy is the human-readable reference + the
// starting point the owner iterates on the device).

const lua = `-- patchtogether Electra Lua layer (auto-uploaded)

-- formatters
function fmtDb(vo, v) return string.format("%+.1f dB", v) end
function fmtRatio(vo, v) return string.format("%.1f:1", v) end
function fmtBpm(vo, v) return string.format("%d BPM", math.floor(v + 0.5)) end
function fmtBpmDisplay(vo, v) return string.format("%d", math.floor(v + 0.5)) end
-- VU meter dBFS readout (host streams a -60..0 dBFS-mapped CC 0..127)
function fmtMeterDb(vo, v)
  if v <= 0 then return "-inf dB" end
  return string.format("%.0f dB", -60.0 + (v / 127.0) * 60.0)
end

-- source banner (host pushes text via info.setText / Execute-Lua)
function pt_setBanner(text) info.setText(text) end

-- tap-pad + BPM gating: host pushes the external-clock flag
PT_TAP_CONTROL_ID = nil
PT_BPM_CONTROL_ID = nil
function pt_setExternal(isExternal)
  if PT_TAP_CONTROL_ID then
    local c = controls.get(PT_TAP_CONTROL_ID)
    if c then c:setActive(not isExternal) end
  end
  if PT_BPM_CONTROL_ID then
    local c = controls.get(PT_BPM_CONTROL_ID)
    if c then c:setActive(not isExternal) end
  end
end

-- MIXMASTER mute (emulated: write channel volume to 0, restore on un-mute)
PORT_CTRL = 2
MIDI_CHANNEL = 1
local savedVol = {}
local VOLUME_CC = {}
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
  for ch = 1, 4 do pt_muteChannel(ch, ch ~= soloCh) end
end
`;

export default lua;
