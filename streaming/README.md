# Streaming

Low-latency game streaming for this project is **WebRTC** (`webrtcbin`
from GStreamer), driven by `webrtc_streamer.py`.

## How it works

```
X display (emulator) → ximagesrc → videoconvert/videoscale
    → H.264 encoder → rtph264pay → webrtcbin ──► browser
PulseAudio → opusenc → rtpopuspay → webrtcbin ──► browser
```

Signaling (SDP offer/answer + ICE) travels as JSON lines over the
process's stdin/stdout. `server.js` spawns one streamer per gaming session
and proxies the browser's WebSocket signaling messages to it. No media
ports are exposed publicly — only the Node server's HTTPS/WSS endpoint.

## Encoder selection (automatic, honest)

1. **NVENC** (`nvh264enc`) — NVIDIA GPU present (`nvidia-smi` works)
2. **VA-API** (`vaapih264enc`) — Intel/AMD render node in `/dev/dri`
3. **x264** (`x264enc` ultrafast, zerolatency) — CPU fallback

The chosen encoder is reported in the `{"type":"ready"}` message and in
the server logs. If only x264 is available, expect higher latency and CPU
load — the hardware check (`npm run hwcheck`) will have warned you already.

## Requirements on the gaming server

- GStreamer 1.0 with plugins: base, good, bad (webrtcbin, ximagesrc),
  ugly (x264), libav — see `scripts/setup.sh`
- Python 3 with `python3-gi`
- An X display (`DISPLAY`) — `emulator/entrypoint.sh` starts Xvfb if needed
- PulseAudio (or set `PULSE_SERVER`); entrypoint starts a dummy sink
- For NVENC: NVIDIA driver + nvidia-container-toolkit on the host

## Stream FPS

The pipeline reports real encoder FPS every 2 seconds
(`{"type":"stats","fps":…}`), surfaced in the web UI as **Stream FPS**.
This is the rendered/streamed frame rate — an honest signal, not an
emulator-internal counter.
