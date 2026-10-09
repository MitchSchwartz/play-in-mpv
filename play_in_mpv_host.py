#!/usr/bin/env python3
"""Native messaging helper: receives a stream URL from the extension and launches mpv."""
import json
import ntpath
import os
import shutil
import struct
import subprocess
import sys

LOG = os.path.expanduser("~/.cache/play-in-mpv.log")

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


def build_command(msg, mpv):
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
    url = msg.get("url", "")
    if not url.startswith(("http://", "https://")):
        send_message({"ok": False, "error": "Bad URL"})
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
