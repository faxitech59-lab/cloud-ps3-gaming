# ── Gaming image: emulator + streaming + input ──────────────────────────
# Build:  docker build -t cloud-ps3-gaming .
# Run with a GPU: needs the NVIDIA Container Toolkit on the host + `--gpus all`
# (see docker-compose.yml). CPU-only hosts will run, but RPCS3 will NOT be
# playable — the hardware check will tell you so honestly.
FROM ubuntu:22.04
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl wget gnupg \
    # RPCS3 runtime deps
    libvulkan1 libgl1 libsm6 libxext6 libx11-6 \
    # X + audio for the virtual display
    xvfb x11-utils pulseaudio \
    # GStreamer (webrtcbin lives in -bad; encoders across bad/ugly/libav)
    gstreamer1.0-tools gstreamer1.0-plugins-base gstreamer1.0-plugins-good \
    gstreamer1.0-plugins-bad gstreamer1.0-plugins-ugly gstreamer1.0-libav \
    python3-gi gir1.2-gstreamer-1.0 \
    # input bridge
    python3-evdev \
    # hardware detection helpers
    pciutils vulkan-tools mesa-vulkan-drivers \
    # node
    nodejs npm \
 && rm -rf /var/lib/apt/lists/*

# RPCS3 official AppImage (the emulator only — no games, no firmware).
# Fetched from RPCS3's official binary releases at build time.
RUN mkdir -p /opt/rpcs3 && \
    RPCS3_URL="$(curl -s https://api.github.com/RPCS3/rpcs3-binaries-linux/releases/latest \
      | grep -o 'https://[^"]*linux64\.AppImage' | head -1)" && \
    echo "Downloading RPCS3: $RPCS3_URL" && \
    wget -qO /opt/rpcs3/rpcs3.AppImage "$RPCS3_URL" && \
    chmod +x /opt/rpcs3/rpcs3.AppImage

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server/ ./server/
COPY streaming/ ./streaming/
COPY input/ ./input/
COPY emulator/ ./emulator/
COPY frontend/ ./frontend/
COPY scripts/ ./scripts/
RUN chmod +x emulator/entrypoint.sh scripts/*.sh streaming/*.py input/*.py

ENV ROLE=all \
    PORT=8080 \
    GAME_DIRECTORY=/data/games \
    FIRMWARE_DIRECTORY=/data/firmware \
    EMULATOR_DIRECTORY=/opt/rpcs3 \
    RPCS3_APPIMAGE=/opt/rpcs3/rpcs3.AppImage \
    DISPLAY_NUM=99 \
    NVIDIA_DRIVER_CAPABILITIES=all \
    NVIDIA_VISIBLE_DEVICES=all

VOLUME ["/data/games", "/data/firmware"]
EXPOSE 8080
CMD ["node", "server/server.js"]
