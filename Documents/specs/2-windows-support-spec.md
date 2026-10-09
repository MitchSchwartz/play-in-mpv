# Windows Support

**Issue:** #2
**Status:** Implemented
**Created:** 2026-10-09

## Problem Statement

Play in mpv only works on Linux. The extension is cross-platform; the native messaging helper setup and a few POSIX assumptions in `play_in_mpv_host.py` block Windows users. Full detail in issue #2.

## Acceptance Criteria

| # | Criterion | Test Type |
|---|-----------|-----------|
| 1 | `install.ps1` writes a native messaging manifest (via `ConvertTo-Json`, `path` → `play_in_mpv_host.bat`) and registers it under HKCU for Chrome, Chromium, and Brave | Manual |
| 2 | `install.ps1` warns (does not fail) if `mpv` or a working Python 3 is not on PATH | Manual |
| 3 | `play_in_mpv_host.bat` launches `play_in_mpv_host.py` with the Python interpreter, passing args through | Manual |
| 4 | On Windows, mpv is launched with `CREATE_BREAKAWAY_FROM_JOB \| CREATE_NEW_PROCESS_GROUP`; on Linux/macOS, `start_new_session=True` is kept | Unit |
| 5 | Hardware decoding uses `--hwdec=auto-safe` on all platforms (replaces `vaapi`) | Unit |
| 6 | Helper honors an `MPV_PATH` env var, falling back to `mpv` on PATH | Unit |
| 7 | mpv opens from the extension on Windows and stays open after the popup closes; F5 reload works | Manual |
| 8 | README: Windows marked ✅ in Supported systems, Windows install steps added (scoop route, execution policy note) | Manual |
| 9 | Linux behavior unchanged apart from the hwdec flag; `install.sh` untouched | Manual |

## Non-Goals

- macOS support (issue #1)
- Changes to `extension/` or `mpv/reload.lua`
- An installer for mpv or Python themselves

## Security Considerations

- **Data flow:** Extension sends URL/title/referrer/userAgent/origin → helper → mpv argv. Unchanged from Linux.
- **Trust boundaries:** Native messaging restricted to the fixed extension ID via `allowed_origins`. URL must start with http(s). Args passed as a list (no shell), so no injection via `.bat` — the `.bat` must not interpolate message content.
- **Auth model:** HKCU only (per-user), no admin rights needed.
- **Failure modes:** mpv missing → helper returns `{"ok": false, "error": ...}` and logs.
- **RLS:** N/A — no database.

## Assumptions & Constraints

- Python 3 and mpv installed by the user (recommended: `scoop install python mpv`).
- Log path stays `~/.cache/play-in-mpv.log` (works via `expanduser`).

## Technical Notes

- Reference: ff2mpv's host script uses the same creationflags approach.
- Keep files flat and explicit; pick behavior by `sys.platform`.
- mpv lookup order: `MPV_PATH`, `shutil.which("mpv")`, then on Windows scoop's `apps\mpv\current\mpv.exe` / `shims\mpv.exe` (honors `SCOOP`), else bare `mpv`. Needed because a browser started before scoop installed mpv has a stale PATH, and scoop creates no shim for mpv.
- mpv is launched with `--msg-level=statusline=no` so its terminal status line doesn't flood the redirected log file.

## Open Questions Resolved

- Workflow: issue #2 is detailed enough to serve as the spec; interview skipped (user approved 2026-10-09).
- hwdec: `auto-safe` everywhere rather than per-platform values (user approved).
- Path: Direct implementation, with a unit test for the platform-specific command/launch logic.
