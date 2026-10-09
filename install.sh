#!/usr/bin/env bash
# Registers the native messaging helper so the extension can launch mpv.
set -euo pipefail

HOST_NAME="local.play_in_mpv"
EXTENSION_ID="coiofchhcnfpogppabiheboajgpmhcki"  # fixed by the "key" in extension/manifest.json
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_PATH="$DIR/play_in_mpv_host.py"

command -v mpv >/dev/null || echo "warning: mpv not found — install it with: sudo apt install mpv"
chmod +x "$HOST_PATH"

installed=0
for browser_dir in \
  "$HOME/.config/BraveSoftware/Brave-Browser" \
  "$HOME/.config/google-chrome" \
  "$HOME/.config/chromium"; do
  [ -d "$browser_dir" ] || continue
  mkdir -p "$browser_dir/NativeMessagingHosts"
  cat > "$browser_dir/NativeMessagingHosts/$HOST_NAME.json" <<EOF
{
  "name": "$HOST_NAME",
  "description": "Launch mpv for Play in mpv extension",
  "path": "$HOST_PATH",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXTENSION_ID/"]
}
EOF
  echo "Registered helper for $browser_dir"
  installed=1
done

[ "$installed" = 1 ] || { echo "No Brave/Chrome/Chromium profile found."; exit 1; }
echo "Now load $DIR/extension via chrome://extensions → Developer mode → Load unpacked, then restart the browser."
