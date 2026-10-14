#!/usr/bin/env python3
"""Native messaging helper: receives a stream URL from the extension and launches mpv."""
import json
import ntpath
import os
import shutil
import struct
import subprocess
import sys
import urllib.parse
import urllib.request

LOG = os.path.expanduser("~/.cache/play-in-mpv.log")
# Shared with every running mpv window: reload.lua polls it, so a toggle in the
# popup applies to windows that are already open.
SETTINGS = os.path.expanduser("~/.cache/play-in-mpv-settings")

# Windows process creation flags (spelled out so this file imports on any OS).
# Chrome runs native hosts inside a job object and kills the whole tree when the
# host exits; breaking away from the job keeps mpv alive after we return.
CREATE_BREAKAWAY_FROM_JOB = 0x01000000
CREATE_NEW_PROCESS_GROUP = 0x00000200


def read_message():
    raw_len = sys.stdin.buffer.read(4)
    if len(raw_len) < 4:
        sys.exit(0)
    length = struct.unpack("<I", raw_len)[0]
    return json.loads(sys.stdin.buffer.read(length))


def send_message(obj):
    data = json.dumps(obj).encode()
    sys.stdout.buffer.write(struct.pack("<I", len(data)) + data)
    sys.stdout.buffer.flush()


def mpv_executable(environ, platform=sys.platform, which=shutil.which, exists=os.path.exists):
    """MPV_PATH if set, then `mpv` on PATH, then known install dirs, else bare `mpv`.

    Windows: scoop's install dirs cover a browser started before mpv was installed: its stale
    PATH lacks scoop's mpv folder (scoop adds it via env_add_path and creates no shim).
    macOS: Homebrew and mpv.app locations cover a browser launched from the Dock, whose PATH
    lacks /opt/homebrew/bin and /usr/local/bin.
    """
    if environ.get("MPV_PATH"):
        return environ["MPV_PATH"]
    found = which("mpv")
    if found:
        return found
    if platform == "win32":
        scoop_root = environ.get("SCOOP") or ntpath.join(environ.get("USERPROFILE", ""), "scoop")
        for candidate in (
            ntpath.join(scoop_root, "apps", "mpv", "current", "mpv.exe"),
            ntpath.join(scoop_root, "shims", "mpv.exe"),
        ):
            if exists(candidate):
                return candidate
    if platform == "darwin":
        # A browser launched from the Dock gets PATH=/usr/bin:/bin:/usr/sbin:/sbin,
        # which misses Homebrew (Apple Silicon, then Intel) and the mpv.app bundle.
        for candidate in (
            "/opt/homebrew/bin/mpv",
            "/usr/local/bin/mpv",
            "/Applications/mpv.app/Contents/MacOS/mpv",
        ):
            if exists(candidate):
                return candidate
    # Not found: return the bare name so the launch error stays loud and gets logged.
    return "mpv"


# Magic bytes of image formats some feeds use to hide video chunks. Only the site's
# own player can unpack those, so mpv would just fail on them.
IMAGE_SIGNATURES = (
    (b"\x89PNG\r\n\x1a\n", "png"),
    (b"\xff\xd8\xff", "jpeg"),
    (b"GIF87a", "gif"),
    (b"GIF89a", "gif"),
)
PROBE_TIMEOUT = 6


def sniff_image(head):
    """Return the image format name if these leading bytes are an image, else None."""
    for sig, name in IMAGE_SIGNATURES:
        if head.startswith(sig):
            return name
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "webp"
    return None


def first_uri(playlist_text, base_url):
    """First URI in an HLS playlist (a variant in a master playlist, else a segment),
    resolved against the playlist URL. Returns (uri, is_master)."""
    lines = [l.strip() for l in playlist_text.splitlines()]
    is_master = any(l.startswith("#EXT-X-STREAM-INF") for l in lines)
    for l in lines:
        if l and not l.startswith("#"):
            return urllib.parse.urljoin(base_url, l), is_master
    return None, is_master


def probe_headers(msg):
    headers = {"User-Agent": msg.get("userAgent") or "Mozilla/5.0"}
    if msg.get("referrer"):
        headers["Referer"] = msg["referrer"]
    if msg.get("origin"):
        headers["Origin"] = msg["origin"]
    return headers


def fetch(url, headers, limit=None):
    req = urllib.request.Request(url, headers=dict(headers, **({"Range": "bytes=0-%d" % (limit - 1)} if limit else {})))
    with urllib.request.urlopen(req, timeout=PROBE_TIMEOUT) as resp:
        return resp.read(limit) if limit else resp.read(2_000_000)


def probe_stream(msg, fetch=fetch):
    """Check the feed's first chunk. Returns an image format name if the video is
    disguised as images (mpv can't play it), else None. Network problems return
    None so mpv still gets a try."""
    headers = probe_headers(msg)
    url = msg["url"]
    try:
        for _ in range(3):  # master -> variant -> segment
            text = fetch(url, headers).decode("utf-8", "replace")
            if "#EXT-X-KEY" in text and "METHOD=NONE" not in text:
                return None  # encrypted chunks can't be sniffed
            nxt, is_master = first_uri(text, url)
            if not nxt:
                return None
            if not is_master:
                return sniff_image(fetch(nxt, headers, limit=16))
            url = nxt
    except Exception:
        return None
    return None


def write_settings(path, auto_reload):
    """Write the settings file atomically so reload.lua never reads a half-written file."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        f.write("auto_reload=" + ("yes" if auto_reload else "no") + "\n")
    os.replace(tmp, path)


def build_command(msg, mpv, settings=SETTINGS):
    headers = []
    if msg.get("origin"):
        headers.append("Origin: " + msg["origin"])

    cmd = [
        mpv,
        "--hwdec=auto-safe",
        "--cache=yes",
        "--demuxer-readahead-secs=10",
        "--network-timeout=15",
        "--force-window=immediate",
        # Output is redirected to the log file; the status line would flood it.
        "--msg-level=statusline=no",
        # Stay open when the stream drops so reload.lua can reconnect.
        "--idle=yes",
        "--script=" + os.path.join(os.path.dirname(os.path.realpath(__file__)), "mpv", "reload.lua"),
        "--script-opts=play_in_mpv-settings=" + settings,
        "--force-media-title=" + msg.get("title", "Stream"),
    ]
    if msg.get("referrer"):
        cmd.append("--referrer=" + msg["referrer"])
    if msg.get("userAgent"):
        cmd.append("--user-agent=" + msg["userAgent"])
    if headers:
        cmd.append("--http-header-fields=" + ",".join(headers))
    cmd.append(msg["url"])
    return cmd


def popen_kwargs(platform):
    """Launch options that let mpv outlive this helper process."""
    if platform == "win32":
        return {"creationflags": CREATE_BREAKAWAY_FROM_JOB | CREATE_NEW_PROCESS_GROUP}
    return {"start_new_session": True}


def main():
    msg = read_message()

    # Settings change from the popup: no mpv launch, open windows pick it up.
    if msg.get("action") == "settings":
        try:
            write_settings(SETTINGS, bool(msg.get("autoReload", True)))
        except OSError as e:
            send_message({"ok": False, "error": str(e)})
            return
        send_message({"ok": True})
        return

    url = msg.get("url", "")
    if not url.startswith(("http://", "https://")):
        send_message({"ok": False, "error": "Bad URL"})
        return

    # Refresh the settings file on every launch so it matches the popup even if
    # it was deleted or the toggle was changed while the helper was missing.
    if "autoReload" in msg:
        try:
            write_settings(SETTINGS, bool(msg["autoReload"]))
        except OSError:
            pass  # reload.lua defaults to on; don't block playback over this

    # Don't open an mpv window for a feed whose video is hidden in images.
    if msg.get("probe", True):
        image = probe_stream(msg)
        if image:
            send_message({"ok": False, "browserOnly": True,
                          "error": "This feed hides its video in %s images; mpv can't play it" % image})
            return

    cmd = build_command(msg, mpv_executable(os.environ))

    os.makedirs(os.path.dirname(LOG), exist_ok=True)
    log = open(LOG, "a")
    log.write("\n=== " + " ".join(cmd) + "\n")
    log.flush()
    try:
        subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=log, stderr=log, **popen_kwargs(sys.platform))
    except Exception as e:
        log.write("launch failed: " + str(e) + "\n")
        send_message({"ok": False, "error": str(e)})
        return
    send_message({"ok": True})


if __name__ == "__main__":
    main()
