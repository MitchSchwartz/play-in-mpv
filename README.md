# Play in mpv

A Brave/Chrome extension that finds the HLS (`.m3u8`) stream on a page and plays it in
[mpv](https://mpv.io) with hardware video decoding, then pauses the browser's player.

Built for older machines (e.g. Intel Haswell iGPUs) where the browser falls back to CPU
video decoding after a stream glitch, causing heat and choppy playback. mpv keeps using
VA-API hardware decoding and skips the page's ad scripts entirely.

## How it picks the right feed

Pages often load several playlists (backups, decoys, dead mirrors). Each one is scored from
network activity:

- **Video chunks downloaded from its server** — strongest signal; only the live feed gets these.
- **Successful playlist reloads** — live players re-fetch the active playlist every few seconds.
- **Timeouts / errors** — marked dead and never chosen.

The popup shows each link's counts and marks the chosen one with ★.

## Install (Linux)

```bash
sudo apt install mpv
./install.sh
```

Then in `brave://extensions`: enable **Developer mode** → **Load unpacked** → select the
`extension/` folder → restart the browser.

## Use

Start the video, wait ~10 seconds, click the extension → **▶ Play in mpv**.

mpv output is logged to `~/.cache/play-in-mpv.log`.

## Files

- `extension/` — the browser extension (Manifest V3)
- `play_in_mpv_host.py` — native messaging helper that launches mpv
- `install.sh` — registers the helper with Brave/Chrome/Chromium
