-- docs/electra/lua/custom-vu.lua
--
-- OPTION 2 (advanced) — a custom Lua VU tile for the MIXMASTER meter row.
--
-- The recommended path (Option 1) is a read-only `vfader` (variant thin/outline)
-- bound to a unique cc7 whose fill animates as the host streams the level CC at
-- ~30Hz — no Lua needed, 1 small CC per update. THIS file is the alternative for
-- when you want a bar + dB ticks + peak-hold drawn yourself.
--
-- Requires FW 3.6+ (type:custom + setPaintCallback). Note FW 4.1.4's
-- single-pot limit means one NARROW custom tile per channel (fine for read-only).
--
-- The host feeds the level either via parameterMap.set(...) on the tile's CC, or
-- a bespoke meter SysEx parsed in midi.onSysex; either way call control:repaint()
-- after updating the stored level so the paint callback redraws.

local peak = {}        -- per-control peak-hold level (0..1)
local peakDecay = 0.02 -- subtracted each repaint (host-driven cadence)

-- Map a 0..1 level to a dB string for the tick labels.
local function levelToDb(level)
  if level <= 0 then return "-inf" end
  return string.format("%.0f", 20 * math.log(level, 10))
end

-- Paint callback: draw a vertical bar + a peak-hold cap + a couple of dB ticks.
-- `level` is read from the control's current value (0..127 from the CC), scaled
-- to 0..1.
function vuPaint(displayObject, control)
  local cv = control:getValue()                 -- 0..127 (the streamed level CC)
  local level = (cv and cv / 127) or 0
  local id = control:getId()
  peak[id] = math.max((peak[id] or 0) - peakDecay, level)

  local bounds = control:getBounds()            -- {x, y, width, height}
  local x, y, w, h = bounds.x, bounds.y, bounds.width, bounds.height

  -- Background.
  displayObject:setColor(0x202020)
  displayObject:fillRect(x, y, w, h)

  -- Bar (green→amber→red by level).
  local barH = math.floor(h * level)
  local color = 0x33cc33
  if level > 0.85 then color = 0xcc3333 elseif level > 0.6 then color = 0xccaa33 end
  displayObject:setColor(color)
  displayObject:fillRect(x, y + (h - barH), w, barH)

  -- Peak-hold cap.
  local peakY = y + math.floor(h * (1 - (peak[id] or 0)))
  displayObject:setColor(0xffffff)
  displayObject:fillRect(x, peakY, w, 2)

  -- A single dB tick label at the current level.
  displayObject:setColor(0x808080)
  displayObject:print(x, y + 2, levelToDb(level))
end

-- Wire the paint callback to each VU tile. Fill the ids in to match the .epr.
local VU_CONTROL_IDS = {}  -- e.g. { 101, 102, 103, 104, 105 }
function pt_initVu()
  for _, cid in ipairs(VU_CONTROL_IDS) do
    local c = controls.get(cid)
    if c then c:setPaintCallback(vuPaint) end
  end
end
