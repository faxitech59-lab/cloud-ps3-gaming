#!/usr/bin/env bash
# entrypoint.sh — boot RPCS3 with the user's game on a virtual display.
# Usage: entrypoint.sh <path-to-game>
# Environment: RPCS3_APPIMAGE, DISPLAY_NUM, FIRMWARE_DIRECTORY
set -euo pipefail

GAME_PATH="${1:?usage: entrypoint.sh <path-to-game>}"
APPIMAGE="${RPCS3_APPIMAGE:-/opt/rpcs3/rpcs3.AppImage}"
DISP=":${DISPLAY_NUM:-99}"

echo "[entrypoint] game: $GAME_PATH"
echo "[entrypoint] emulator: $APPIMAGE"

if [ ! -x "$APPIMAGE" ]; then
  echo "[entrypoint] ERROR: RPCS3 not found/executable at $APPIMAGE" >&2
  exit 1
fi
if [ ! -e "$GAME_PATH" ]; then
  echo "[entrypoint] ERROR: game path does not exist: $GAME_PATH" >&2
  exit 1
fi

# Firmware sanity check (user-installed, never bundled).
if [ ! -d "${FIRMWARE_DIRECTORY:-/data/firmware}/dev_flash" ]; then
  echo "[entrypoint] ERROR: no installed firmware under ${FIRMWARE_DIRECTORY:-/data/firmware}/dev_flash" >&2
  echo "[entrypoint] Install YOUR OWN dumped firmware via RPCS3 (File -> Install Firmware)." >&2
  exit 1
fi

# X display: reuse if alive, else start Xvfb.
if ! xdpyinfo -display "$DISP" >/dev/null 2>&1; then
  echo "[entrypoint] starting Xvfb on $DISP"
  rm -f "/tmp/.X${DISP#:}-lock"
  Xvfb "$DISP" -screen 0 1280x720x24 +extension GLX +render -noreset &
  for _ in $(seq 1 30); do
    xdpyinfo -display "$DISP" >/dev/null 2>&1 && break
    sleep 1
  done
fi
export DISPLAY="$DISP"

# Audio: make sure *something* provides a PulseAudio sink for the streamer.
if ! pactl info >/dev/null 2>&1; then
  echo "[entrypoint] starting dummy PulseAudio"
  pulseaudio --start --exit-idle-time=-1 >/dev/null 2>&1 || true
  pactl load-module module-null-sink sink_name=game >/dev/null 2>&1 || true
fi

# RPCS3 home (configs, installed firmware link, saves)
export HOME="${RPCS3_HOME:-/root}"
export QT_QPA_PLATFORM=xcb
export SDL_VIDEODRIVER=x11

echo "[entrypoint] booting RPCS3…"
# Passing the game path makes RPCS3 boot it directly on the virtual display.
# NOTE: stock RPCS3 builds open their GUI on the display; there is no
# official --headless flag — the window simply stays on the virtual screen
# while its output is captured for streaming.
exec "$APPIMAGE" "$GAME_PATH"
