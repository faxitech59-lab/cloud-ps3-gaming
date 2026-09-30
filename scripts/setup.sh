#!/usr/bin/env bash
# setup.sh — prepare a bare Ubuntu 22.04 VM (gaming role) for cloud PS3 gaming.
# Installs: Node 20, RPCS3 deps, GStreamer, Xvfb, PulseAudio, python3-evdev,
# vulkan tools, and the official RPCS3 AppImage. No games. No firmware.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run as root (sudo ./scripts/setup.sh)"; exit 1
fi

echo "==> Installing system packages…"
apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates curl wget gnupg pciutils \
  libvulkan1 libgl1 libsm6 libxext6 libx11-6 \
  xvfb x11-utils pulseaudio \
  gstreamer1.0-tools gstreamer1.0-plugins-base gstreamer1.0-plugins-good \
  gstreamer1.0-plugins-bad gstreamer1.0-plugins-ugly gstreamer1.0-libav \
  python3-gi gir1.2-gstreamer-1.0 python3-evdev \
  vulkan-tools mesa-vulkan-drivers \
  openssl

echo "==> Installing Node.js 20…"
if ! command -v node >/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

echo "==> Downloading official RPCS3 AppImage…"
mkdir -p /opt/rpcs3
RPCS3_URL="$(curl -s https://api.github.com/RPCS3/rpcs3-binaries-linux/releases/latest \
  | grep -o 'https://[^"]*linux64\.AppImage' | head -1)"
echo "    $RPCS3_URL"
wget -qO /opt/rpcs3/rpcs3.AppImage "$RPCS3_URL"
chmod +x /opt/rpcs3/rpcs3.AppImage

echo "==> Creating data directories…"
mkdir -p /data/games /data/firmware
chmod +x "$(dirname "$0")/../emulator/entrypoint.sh" 2>/dev/null || true

echo "==> Installing Node dependencies…"
cd "$(dirname "$0")/.."
npm install --omit=dev

echo "==> Generating secrets…"
if [ ! -f .env ]; then
  cp .env.example .env
  SECRET="$(openssl rand -hex 32)"
  sed -i "s/^SESSION_SECRET=$/SESSION_SECRET=$SECRET/" .env
  echo "    SESSION_SECRET generated."
fi

echo
echo "Next steps:"
echo "  1. Set a password hash in .env:"
echo "       node -e \"console.log(require('bcryptjs').hashSync('YOUR_PASSWORD', 10))\""
echo "     then paste it as AUTH_PASS_HASH=..."
echo "  2. Place YOUR legally owned game dump in /data/games"
echo "     and install YOUR dumped firmware via RPCS3 (File -> Install Firmware)."
echo "  3. Run: ./scripts/start.sh"
