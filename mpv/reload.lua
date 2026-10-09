-- Reloads the stream on F5 / Ctrl+R, and automatically when a live stream stalls
-- or ends unexpectedly. Network options (referrer, user agent, headers) are global,
-- so they carry over to the reloaded stream.

local STALL_SECONDS = 5    -- frozen this long while not paused -> reload
local MAX_RETRIES = 5      -- consecutive failed reloads before giving up
local RETRY_DELAY = 2      -- seconds to wait after the stream ends/errors
local HEALTHY_SECONDS = 30 -- playback this long resets the retry count

local stream_url = nil
local retries = 0
local stall_timer = nil

local function cancel_stall()
  if stall_timer then
    stall_timer:kill()
    stall_timer = nil
  end
end

local function reload(reason)
  cancel_stall()
  if not stream_url then return end
  mp.osd_message("Reloading stream (" .. reason .. ")…", 3)
  mp.msg.info("reloading: " .. reason)
  mp.commandv("loadfile", stream_url, "replace")
end

local function manual_reload()
  retries = 0
  reload("manual")
end

mp.add_key_binding("F5", "reload-stream", manual_reload)
mp.add_key_binding("ctrl+r", "reload-stream-alt", manual_reload)

mp.register_event("start-file", function()
  stream_url = mp.get_property("path") or stream_url
end)

-- Only count the stream as recovered after it has played for a while, so a
-- stream that dies right after every reconnect still hits MAX_RETRIES.
local healthy_timer = nil
mp.register_event("playback-restart", function()
  if healthy_timer then healthy_timer:kill() end
  healthy_timer = mp.add_timeout(HEALTHY_SECONDS, function()
    healthy_timer = nil
    retries = 0
  end)
end)

-- core-idle is true whenever playback isn't advancing (buffering, frozen
-- demuxer, etc.). Ignore it when the user paused on purpose.
local function check_stall()
  local idle = mp.get_property_bool("core-idle")
  local paused = mp.get_property_bool("pause")
  if idle and not paused then
    if not stall_timer then
      stall_timer = mp.add_timeout(STALL_SECONDS, function()
        stall_timer = nil
        reload("stalled " .. STALL_SECONDS .. "s")
      end)
    end
  else
    cancel_stall()
  end
end
mp.observe_property("core-idle", "bool", check_stall)
mp.observe_property("pause", "bool", check_stall)

-- A live stream "ending" or erroring usually means a hiccup, not the end of the game.
mp.register_event("end-file", function(event)
  cancel_stall()
  if healthy_timer then
    healthy_timer:kill()
    healthy_timer = nil
  end
  if event.reason ~= "eof" and event.reason ~= "error" then return end
  if retries >= MAX_RETRIES then
    mp.osd_message("Stream lost — press F5 to retry", 999)
    return
  end
  retries = retries + 1
  mp.add_timeout(RETRY_DELAY, function()
    reload("stream ended, retry " .. retries .. "/" .. MAX_RETRIES)
  end)
end)
