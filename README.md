# Play in mpv

A Brave/Chrome extension that finds the live HLS (`.m3u8`) stream on a page and plays it in
[mpv](https://mpv.io) with hardware video decoding, then pauses the browser's player.

## Why

Browsers can silently fall back to **CPU video decoding** after a stream glitch and never
switch back. On older machines (e.g. Intel Haswell integrated graphics) that means a hot CPU
and choppy playback for the rest of the session. mpv keeps using VA-API hardware decoding,
recovers from glitches, and skips the page's ad scripts entirely.

## Supported systems

| System | Status |
|---|---|
| Linux | ✅ |
| Windows 10/11 | ✅ |
| macOS | ✅ |

Browsers: Brave, Chrome, Chromium.

## How it picks the right feed

Streaming pages often load several playlists — backups, decoys, dead mirrors. Each one is
scored from real network activity:

- **Video chunks downloaded from its server** — strongest signal; only the live feed gets these.
- **Successful playlist reloads** — live players re-fetch the active playlist every few seconds.
- **Timeouts / errors** — marked dead and never chosen.

The popup lists every link with its counts and marks the chosen one with ★. You can still play
any link manually.

## How this compares to similar tools

| Tool | How it finds the video | Best for |
|---|---|---|
| **[ff2mpv](https://github.com/woodruffw/ff2mpv)** | Sends the *page URL* to mpv, which extracts the video with yt-dlp | YouTube, Twitch, Vimeo and the thousands of sites yt-dlp supports |
| **Stream detector extensions** (e.g. The Stream Detector) | Sniffs `.m3u8` requests and copies a URL or command for you to run | Grabbing stream URLs manually |
| **Video DownloadHelper / HLS downloaders** | Sniffs streams for saving to disk | Downloading, not live playback |
| **Play in mpv** (this) | Sniffs `.m3u8` requests, scores them to find the live one, launches mpv with the right referrer/origin/user-agent | Sites yt-dlp doesn't support — embedded players, iframes from other domains, referrer-checked streams, pages full of decoy playlists |

These complement each other: ff2mpv is the better choice on mainstream sites, while this
handles pages where yt-dlp's generic extractor can't find the stream. Both can be installed
side by side — each uses its own native messaging host.

## Install (Linux)

```bash
sudo apt install mpv
./install.sh
```

Then in `brave://extensions` (or `chrome://extensions`): enable **Developer mode** →
**Load unpacked** → select the `extension/` folder → restart the browser.

`install.sh` registers the native messaging helper for Brave, Chrome and Chromium, pointing at
this folder — re-run it if you move the repo.

## Install (macOS)

1. **Install Python 3 and mpv** with [Homebrew](https://brew.sh):
   ```bash
   brew install python mpv
   ```
2. **Register the helper** from the repo folder:
   ```bash
   ./install.sh
   ```
   It finds a working Python 3 (Homebrew first; Apple's `/usr/bin/python3` only if the Command
   Line Tools are installed) and writes `play_in_mpv_host_macos.sh` into this folder, a small
   wrapper that runs the helper with that Python by absolute path. Browsers launched from the
   Dock don't see Homebrew's `PATH`, so the wrapper and the helper both use absolute paths.
3. In `brave://extensions` (or `chrome://extensions`): enable **Developer mode** →
   **Load unpacked** → select the `extension/` folder.
4. **Fully quit the browser** (Cmd+Q, not just closing the window) and relaunch it from the
   Dock.

`install.sh` registers the helper for Brave, Chrome and Chromium under
`~/Library/Application Support/` — re-run it if you move the repo or reinstall Python.

## Install (Windows)

1. **Install Python 3.** Either route works — the helper only needs `python` (or `py -3`) on
   `PATH`:
   - [scoop](https://scoop.sh): `scoop install python`
   - [uv](https://docs.astral.sh/uv/): `uv python install 3.13 --default`

   The Microsoft Store `python` alias that ships with Windows is only a stub that opens the
   Store — it won't work. Check with `python --version` in a new terminal.
2. **Install mpv** (mpv.io has no official Windows installer):
   ```powershell
   scoop bucket add extras
   scoop install mpv
   ```
   Or download a build from [mpv.io/installation](https://mpv.io/installation/) and either add
   its folder to `PATH` or set the `MPV_PATH` environment variable to the full path of `mpv.exe`.

   The helper finds scoop's mpv automatically even if the browser was open during install;
   otherwise restart the browser or set `MPV_PATH`.
3. **Register the helper** from the repo folder:
   ```powershell
   powershell -ExecutionPolicy Bypass -File install.ps1
   ```
   (Or allow local scripts once with `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`,
   then run `.\install.ps1`.) It warns if mpv or a working Python 3 is missing.

Then load the `extension/` folder unpacked as above and **fully quit the browser** — Brave and
Chrome keep running in the system tray after the window closes, so quit from the tray icon or
end it in Task Manager — then reopen it.

`install.ps1` writes `local.play_in_mpv.json` into this folder and registers it under
`HKCU` for Chrome, Chromium and Brave (per-user, no admin needed) — re-run it if you move the
repo.

## Use

Start the video, let it play ~10 seconds, click the extension → **▶ Play in mpv**.

mpv output is logged to `~/.cache/play-in-mpv.log` (`%USERPROFILE%\.cache\play-in-mpv.log` on
Windows).

To check your setup, the [hls.js demo page](https://hlsjs.video-dev.org/demo/) plays a public
HLS test stream.

### Troubleshooting

| Popup error | Fix |
|---|---|
| `Specified native messaging host not found` | Re-run the installer, then fully quit and reopen the browser (system tray on Windows, Cmd+Q on macOS). |
| `The system cannot find the file specified` / `No such file or directory` | mpv wasn't found. The browser was probably started before mpv was installed: fully restart it, or set `MPV_PATH` to mpv's full path. |
| `No response from helper` / `Native host has exited` | Python failed to start. Re-run the installer and read its warnings. |

### Reloading a jammed stream

- **F5** or **Ctrl+R** in the mpv window reloads the stream (jumps back to the live edge,
  keeping the referrer and headers).
- mpv **reloads automatically** if playback freezes for 5 seconds or the stream ends
  unexpectedly. After 5 failed attempts in a row it stops and shows "Stream lost — press F5
  to retry". Tune the timings at the top of `mpv/reload.lua`.

## Files

- `extension/` — the browser extension (Manifest V3)
- `play_in_mpv_host.py` — native messaging helper that launches mpv
- `play_in_mpv_host.bat` — Windows wrapper that runs the helper with Python
- `mpv/reload.lua` — mpv script for manual and automatic stream reloading
- `install.sh` — registers the helper with Brave/Chrome/Chromium (Linux and macOS)
- `install.ps1` — registers the helper with Brave/Chrome/Chromium (Windows)
- `tests/` — unit tests for the helper: `python -m unittest discover -s tests`

## Contributing

A pre-push hook scans outgoing commits with [gitleaks](https://github.com/gitleaks/gitleaks)
and blocks the push if it finds secrets. Enable it once per clone:

```bash
git config core.hooksPath .githooks
```

## License

[PolyForm Noncommercial 1.0.0](LICENSE.md) — free for personal, hobby, research, educational
and other noncommercial use. Commercial use is not permitted. Note that this makes the project
*source-available* rather than OSI-approved open source.
