# Auto-Reload Toggle

**Issue:** none (requested directly)
**Status:** Implemented
**Created:** 2026-10-09

## Problem Statement

`mpv/reload.lua` always reloads a stream after a 5-second stall or an unexpected end. Users
want to switch that off (e.g. on a slow connection where long buffering pauses are normal)
from the extension, and have the change apply to mpv windows that are already playing.

## Acceptance Criteria

| # | Criterion | Test Type |
|---|-----------|-----------|
| 1 | Popup shows an "Auto-reload" toggle switch, visible whether or not a stream was found; state persists in `chrome.storage.local` (default on) | Manual |
| 2 | Toggling sends `{action: "settings", autoReload}` to the helper, which writes `~/.cache/play-in-mpv-settings` atomically and does not launch mpv | Unit |
| 3 | Launch messages carry `autoReload`; the helper refreshes the settings file before launching | Manual |
| 4 | mpv is launched with `--script-opts=play_in_mpv-settings=<path>` | Unit |
| 5 | `reload.lua` polls the file every second; turning off cancels any pending stall/retry reload in open windows, turning on resumes stall detection | Manual (mpv lavfi test) |
| 6 | With auto-reload off, an ended stream shows "Stream ended — press F5 to reload"; F5 / Ctrl+R always work | Manual |
| 7 | Missing or unreadable settings file → auto-reload stays on (previous behavior) | Manual |

## Non-Goals

- Making stall timeout / retry count configurable from the popup
- IPC sockets to mpv (file polling is simpler and identical on Linux/Windows/macOS)

## Security Considerations

- **Data flow:** Popup → native message (boolean only) → helper writes a fixed path under
  `~/.cache`. No message content reaches a file path or the command line beyond the boolean.
- **Trust boundaries:** Unchanged; native messaging limited to the fixed extension ID.
- **Failure modes:** Helper unreachable → popup saves the choice and shows an error; it's
  re-sent on the next launch. File write failure on launch is ignored (playback not blocked).

## Technical Notes

- File format is a single `auto_reload=yes|no` line so Lua can parse it without a JSON library.
- Written via temp file + `os.replace` so a poll never sees a partial write.
- `--script-opts` is comma-separated; a settings path containing a comma would break parsing.
  `~/.cache/...` makes that unlikely.
