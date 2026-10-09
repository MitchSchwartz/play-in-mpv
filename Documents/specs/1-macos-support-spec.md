# macOS Support

**Issue:** #1
**Status:** Implemented
**Created:** 2026-10-09

## Problem Statement

Play in mpv works on Linux and Windows. macOS needs the native messaging manifest in macOS browser folders, and the helper must work when the browser is launched from the Dock (minimal PATH: `/usr/bin:/bin:/usr/sbin:/sbin`). Full detail in issue #1.

## Acceptance Criteria

| # | Criterion | Test Type |
|---|-----------|-----------|
| 1 | `install.sh` detects macOS (`uname`) and writes the manifest to `~/Library/Application Support/{Google/Chrome, Chromium, BraveSoftware/Brave-Browser}/NativeMessagingHosts/`; Linux folders/behavior unchanged | Manual |
| 2 | On macOS, `install.sh` finds a working `python3` (not Apple's `/usr/bin/python3` stub unless the Command Line Tools are actually installed), writes a gitignored wrapper script that execs that interpreter by absolute path with the helper, and points the manifest `path` at it. Fails loudly if no working Python 3 is found | Manual |
| 3 | macOS "mpv not found" hint suggests `brew install mpv` | Manual |
| 4 | `mpv_executable` on macOS falls back (after MPV_PATH and PATH) to `/opt/homebrew/bin/mpv`, `/usr/local/bin/mpv`, `/Applications/mpv.app/Contents/MacOS/mpv` | Unit |
| 5 | Linux and Windows behavior unchanged (existing tests pass; Linux install.sh still points manifest at the .py directly) | Unit + Manual |
| 6 | README: macOS ✅ in Supported systems with macOS install steps (Homebrew python + mpv, `./install.sh`, launch browser from Dock to test) | Manual |
| 7 | End to end on a Mac, browser launched from the Dock: mpv opens, stays open, hwdec active (videotoolbox), F5 works | Manual (needs a Mac) |

## Non-Goals

- Changes to `extension/` or `mpv/reload.lua`
- Moving the log to `~/Library/Logs`
- Firefox support

## Security Considerations

- **Data flow:** unchanged from Linux/Windows.
- **Trust boundaries:** wrapper script contains only the interpreter path and helper path, never message content; stream data arrives on stdin. Manifest `allowed_origins` fixed to the extension ID.
- **Auth model:** per-user folders only, no sudo.
- **Failure modes:** missing mpv → `{"ok": false}` + log; missing Python → installer fails with a clear message.
- **RLS:** N/A.

## Assumptions & Constraints

- Development happens on Windows; no Mac available for automated testing. Shell script verified by syntax check and logic review; criterion 7 needs a human on a Mac.
- Keep `install.sh` POSIX/bash-compatible with macOS's bash 3.2 (no associative arrays, no `readlink -f`).

## Technical Notes

- `mpv_executable` already takes `platform`, `which`, `exists` for testing (added for Windows/scoop).
- `--hwdec=auto-safe` already selects VideoToolbox on macOS.
- `start_new_session=True` already keeps mpv alive on macOS.

## Open Questions Resolved

- Python on macOS: installer-generated wrapper with absolute interpreter path (option A), chosen by user 2026-10-09.
- Issue #1 serves as the spec; interview skipped, direct implementation.
