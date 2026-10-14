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

Browsers: Brave, Chrome, Chromium. On Linux they must be regular system packages
(`.deb`/`.rpm`/AUR) — **Flatpak and Snap** browsers are sandboxed and can't launch mpv. Firefox
isn't supported (this is a Chromium Manifest V3 extension).

## How it picks the right feed

Streaming pages often load several playlists — backups, decoys, dead mirrors. Each one is
scored from real network activity:

- **Video chunks downloaded** — strongest signal; only the live feed gets these. A chunk is
  credited to a playlist in the same folder, or else to the playlist loaded just before it
  (players often fetch chunks from a different CDN server than the playlist).
- **Successful playlist reloads** — live players re-fetch the active playlist every few seconds.
- **Timeouts / errors** — marked dead and never chosen.

Scores **fade within seconds** when a feed goes quiet, so the pick reflects what's playing *now*.
If you switch feeds on a page that doesn't reload, the new feed takes over the ★ within a few
seconds instead of losing to the old feed's history.

The popup lists every link — strongest first, marked **live** or **idle** with its counts — and
marks the chosen one with ★. You can still play any link manually.

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

Install mpv and Python 3 with your package manager:

```bash
# Ubuntu / Debian / Mint / Pop!_OS
sudo apt install mpv python3

# Fedora (mpv is in RPM Fusion: https://rpmfusion.org/Configuration)
sudo dnf install mpv python3

# Arch / Manjaro
sudo pacman -S mpv python
```

Open your browser at least once (so its profile folder exists), then register the helper from
the repo folder:

```bash
./install.sh
```

Then in `brave://extensions` (or `chrome://extensions`): enable **Developer mode** →
**Load unpacked** → select the `extension/` folder → restart the browser.

`install.sh` registers the native messaging helper for Brave, Chrome and Chromium, pointing at
this folder — re-run it if you move the repo.

## Install (macOS)

1. **Install Python 3** with [Homebrew](https://brew.sh): `brew install python`
2. **Install mpv.** Which route works depends on your Mac (see
   [Which mpv for my Mac?](#which-mpv-for-my-mac) below). On Apple silicon it's just:
   ```bash
   brew install mpv
   ```
3. **Register the helper** from the repo folder:
   ```bash
   ./install.sh
   ```
   It finds a working Python 3 (Homebrew first; Apple's `/usr/bin/python3` only if the Command
   Line Tools are installed) and writes `play_in_mpv_host_macos.sh` into this folder, a small
   wrapper that runs the helper with that Python by absolute path. Browsers launched from the
   Dock don't see Homebrew's `PATH`, so the wrapper and the helper both use absolute paths.
4. In `brave://extensions` (or `chrome://extensions`): enable **Developer mode** →
   **Load unpacked** → select the `extension/` folder.
5. **Fully quit the browser** (Cmd+Q, not just closing the window) and relaunch it from the
   Dock.

`install.sh` registers the helper for Brave, Chrome and Chromium under
`~/Library/Application Support/` — re-run it if you move the repo or reinstall Python.

### Which mpv for my Mac?

Check your graphics chip first: Apple menu → **About This Mac** → **More Info** → **System
Report** → **Graphics/Displays**, and look at **Metal Support**. Or run
`system_profiler SPDisplaysDataType | grep -E "Chipset|Metal"`.

| Your Mac | Install mpv with |
|---|---|
| **Apple silicon** (M1 and later) | `brew install mpv` |
| **Intel, Metal Support: Metal 3** (roughly 2018 and later: Intel UHD 630, Iris Plus, or an AMD GPU) | The official build: download `mpv-<version>-macos-15-intel.zip` from [mpv's GitHub releases](https://github.com/mpv-player/mpv/releases). It unzips to `mpv.tar.gz`, which holds `mpv.app`. Move `mpv.app` into `/Applications`. |
| **Intel, Metal 2 or older** (most Intel Macs from 2017 and earlier, e.g. Intel HD Graphics 6000) | mpv **0.39** from [stolendata](https://laboratory.stolendata.net/~djinn/mpv_osx/): download `mpv-0.39.0.tar.gz` (not the `arm64` files) and move `mpv.app` into `/Applications`. |

Why Intel Macs can't use the common route:

- **Homebrew** no longer ships prebuilt mpv for Intel Macs on current macOS. `brew install mpv`
  ends with "Homebrew no longer builds bottles for this configuration" and would have to compile
  mpv and FFmpeg from source, which needs the Xcode Command Line Tools and a long build.
- **The official mpv build** (0.41) draws video only through Vulkan, using MoltenVK to
  translate Vulkan to Metal. Its MoltenVK calls a Metal 3 function
  (`setVertexBuffer:offset:attributeStride:atIndex:`) that older Intel GPUs don't have. mpv
  crashes when it shows the first frame, and the log at `~/.cache/play-in-mpv.log` ends in an
  `unrecognized selector` or `Placement heap type is not supported` error. No mpv option avoids
  it. The stolendata 0.39 build uses mpv's older macOS renderer instead and plays fine on these
  GPUs, still with VideoToolbox hardware decoding.

The helper finds `/Applications/mpv.app` and Homebrew's mpv (Apple silicon or Intel) on its own;
set `MPV_PATH` to use an mpv somewhere else.

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
| (macOS) mpv window flashes and closes; log ends in `unrecognized selector` or `Placement heap type is not supported` | Your Mac's GPU lacks Metal 3. Install mpv 0.39 instead; see [Which mpv for my Mac?](#which-mpv-for-my-mac). |

### Reloading a jammed stream

- **F5**, **Ctrl+R** or **Cmd+R** (macOS) in the mpv window reloads the stream (jumps back to
  the live edge, keeping the referrer and headers).
- mpv **reloads automatically** if playback freezes for 5 seconds or the stream ends
  unexpectedly. After 5 failed attempts in a row it stops and shows "Stream lost — press F5
  to retry". Tune the timings at the top of `mpv/reload.lua`.
- Turn automatic reloading **off or on with the toggle in the extension popup**. The change
  applies within a second to mpv windows that are already open, as well as new ones. F5 still
  works when it's off. (The choice is stored in `~/.cache/play-in-mpv-settings`, which each mpv
  window checks.)

## Files

- `extension/` — the browser extension (Manifest V3)
- `play_in_mpv_host.py` — native messaging helper that launches mpv
- `play_in_mpv_host.bat` — Windows wrapper that runs the helper with Python
- `mpv/reload.lua` — mpv script for manual and automatic stream reloading
- `install.sh` — registers the helper with Brave/Chrome/Chromium (Linux and macOS)
- `install.ps1` — registers the helper with Brave/Chrome/Chromium (Windows)
- `extension/scoring.js` — feed scoring shared by the background worker and popup
- `tests/` — unit tests: `python -m unittest discover -s tests` (helper) and
  `node --test tests/test_scoring.js` (feed scoring)

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
