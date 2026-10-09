#!/usr/bin/env python3
"""Native messaging helper: receives a stream URL from the extension and launches mpv."""
import json
import os
import struct
import subprocess
import sys

LOG = os.path.expanduser("~/.cache/play-in-mpv.log")


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


def main():
    msg = read_message()
    url = msg.get("url", "")
    if not url.startswith(("http://", "https://")):
        send_message({"ok": False, "error": "Bad URL"})
        return

    headers = []
    if msg.get("origin"):
        headers.append("Origin: " + msg["origin"])

    cmd = [
        "mpv",
        "--hwdec=vaapi",
        "--cache=yes",
        "--demuxer-readahead-secs=10",
        "--network-timeout=15",
        "--force-window=immediate",
        "--keep-open=no",
        "--force-media-title=" + msg.get("title", "Stream"),
    ]
    if msg.get("referrer"):
        cmd.append("--referrer=" + msg["referrer"])
    if msg.get("userAgent"):
        cmd.append("--user-agent=" + msg["userAgent"])
    if headers:
        cmd.append("--http-header-fields=" + ",".join(headers))
    cmd.append(url)

    os.makedirs(os.path.dirname(LOG), exist_ok=True)
    log = open(LOG, "a")
    log.write("\n=== " + " ".join(cmd) + "\n")
    log.flush()
    try:
        subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
    except Exception as e:
        send_message({"ok": False, "error": str(e)})
        return
    send_message({"ok": True})


if __name__ == "__main__":
    main()
