# Play in mpv

A Brave/Chrome extension that finds the live HLS (`.m3u8`) stream on a page and plays it in
[mpv](https://mpv.io) with hardware video decoding, then pauses the browser's player.

## Why

Browsers can silently fall back to **CPU video decoding** after a stream glitch and never
switch back. On older machines (e.g. Intel Haswell integrated graphics) that means a hot CPU
and choppy playback for the rest of the session. mpv keeps using VA-API hardware decoding,
recovers from glitches, and skips the page's ad scripts entirely.

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

## Use

Start the video, let it play ~10 seconds, click the extension → **▶ Play in mpv**.

mpv output is logged to `~/.cache/play-in-mpv.log`.

### Reloading a jammed stream

- **F5** or **Ctrl+R** in the mpv window reloads the stream (jumps back to the live edge,
  keeping the referrer and headers).
- mpv **reloads automatically** if playback freezes for 5 seconds or the stream ends
  unexpectedly. After 5 failed attempts in a row it stops and shows "Stream lost — press F5
  to retry". Tune the timings at the top of `mpv/reload.lua`.

## Files

- `extension/` — the browser extension (Manifest V3)
- `play_in_mpv_host.py` — native messaging helper that launches mpv
- `mpv/reload.lua` — mpv script for manual and automatic stream reloading
- `install.sh` — registers the helper with Brave/Chrome/Chromium

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
