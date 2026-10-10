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
| 7 | End to end on a Mac, browser launched from the Dock: mpv opens, stays open, hwdec active (videotoolbox), F5 works | Manual — verified 2026-10-10 on an Intel MacBook (HD Graphics 6000, macOS 15.7) with mpv 0.39 |
| 8 | Cmd+R reloads the stream in mpv on macOS (alongside F5 / Ctrl+R) | Manual — verified 2026-10-10 |
| 9 | README explains which mpv build to install per Mac type (Apple silicon / Intel with Metal 3 / Intel without) and why | Manual |

## Non-Goals

- Changes to `extension/`; `mpv/reload.lua` only gains the Cmd+R binding
- Moving the log to `~/Library/Logs`
- Firefox support

## Security Considerations

- **Data flow:** unchanged from Linux/Windows.
- **Trust boundaries:** wrapper script contains only the interpreter path and helper path, never message content; stream data arrives on stdin. Manifest `allowed_origins` fixed to the extension ID.
- **Auth model:** per-user folders only, no sudo.
- **Failure modes:** missing mpv → `{"ok": false}` + log; missing Python → installer fails with a clear message.
- **RLS:** N/A.

## Assumptions & Constraints

- Initially developed on Windows without a Mac; criterion 7 was later verified on a Mac.
- Keep `install.sh` POSIX/bash-compatible with macOS's bash 3.2 (no associative arrays, no `readlink -f`).

## Technical Notes

- `mpv_executable` already takes `platform`, `which`, `exists` for testing (added for Windows/scoop).
- `--hwdec=auto-safe` already selects VideoToolbox on macOS.
- `start_new_session=True` already keeps mpv alive on macOS.

## Open Questions Resolved

- Python on macOS: installer-generated wrapper with absolute interpreter path (option A), chosen by user 2026-10-09.
- Issue #1 serves as the spec; interview skipped, direct implementation.
- mpv on Intel Macs (found during Mac testing, 2026-10-10): Homebrew has no Intel bottles on macOS 15 (Tier 3, would build from source and needs the Command Line Tools). The official mpv 0.41 `macos-15-intel` build is Vulkan/MoltenVK-only and aborts on the first frame on GPUs without Metal 3 (`-[MTLIGAccelRenderCommandEncoder setVertexBuffer:offset:attributeStride:atIndex:]: unrecognized selector`; with default MoltenVK settings, an earlier `Placement heap type is not supported` assertion). `MVK_CONFIG_USE_MTLHEAP=0` gets past the first error but not the second. The stolendata mpv 0.39 Intel build works (VO `libmpv`/cocoa-cb, hwdec videotoolbox). Documented in the README rather than worked around in code.
