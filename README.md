# 🎮 Cloud PS3 Gaming

Play **your own legally owned** PlayStation 3 games remotely: a cloud server
runs the RPCS3 emulator and streams the gameplay to your browser with low
latency over WebRTC. Keyboard and gamepad input goes back the other way.

> **Legal notice — read this first.** This project contains **no games, no
> firmware, no BIOS, and no download links**. Everything copyrighted must be
> provided by **you**, dumped from hardware and discs **you legally own**.
> RPCS3's official guides explain how to dump your own firmware
> (`PS3UPDAT.PUP`) and your own discs. If you don't own it, don't add it.

---

## 1. How the architecture works

```
Your browser  ──WebRTC (video/audio)──▶  Cloud gaming server
     │                                       │
     │◀── keyboard / gamepad input ──         ▼
     │                                  RPCS3 emulator
     │                                       ▼
     │                              YOUR game files (you provide)
     └─────────── HTTPS/WSS signaling ────────┘
```

- **Browser** — dark gaming UI: START GAME, live video/audio, controller
  input, latency, FPS, stream quality.
- **Node server** (`server/`) — auth, sessions (one per user, auto-expiry),
  hardware detection, WebRTC signaling gateway, input forwarding.
- **Streaming** (`streaming/webrtc_streamer.py`) — GStreamer `webrtcbin`
  pipeline: captures the emulator's X display (`ximagesrc`), encodes H.264
  (NVENC → VA-API → x264, auto-selected), Opus audio. Signaling travels as
  JSON over stdin/stdout — no media ports are exposed publicly.
- **Input** (`input/virtual_gamepad.py`) — creates virtual Xbox 360 pad +
  keyboard via Linux `uinput`; browser Gamepad API / key events are
  forwarded at 60 Hz.
- **Emulator** (`emulator/entrypoint.sh`) — boots the official RPCS3
  AppImage on a virtual display with **your** game.

The server runs in three roles (`ROLE` env var):

| ROLE     | Runs where          | Contains                              |
|----------|---------------------|---------------------------------------|
| `all`    | One GPU box         | Web UI + emulator + streaming         |
| `web`    | Railway (no GPU)    | Web UI + API + auth, proxies to GPU   |
| `gaming` | GPU cloud VM        | Emulator + streaming + input          |

---

## 2. Which cloud server is required (honest version)

PS3 emulation is **heavy**. For God of War III-class titles you realistically
need:

- **x86-64 CPU**, 4+ cores (6+ preferred)
- **8 GB+ RAM** (16 GB preferred)
- **A real GPU with Vulkan support** — NVIDIA GTX 1060 / RTX 2060 class or
  better, 4 GB+ VRAM
- **Hardware video encoder** (NVENC / VA-API) for low-latency streaming
- **20 GB+ free disk** (emulator + shader cache + your game dumps)
- **Good network**: 15+ Mbps up/down, low jitter

Run the built-in check on any candidate machine — it will not flatter a
weak box:

```bash
npm run hwcheck        # or: node server/hardware-detection.js --cli
```

It prints `Your server appears suitable` or `may be insufficient`, with
reasons. **Believe the insufficient verdict.**

### GPU cloud options (examples, check current pricing yourself)

Vast.ai, RunPod, Lambda Labs, Paperspace, AWS `g4dn`, GCP — any VM where
you get an NVIDIA GPU with the container toolkit. This project does not
endorse any provider.

---

## 3. Why GPU acceleration matters

Two separate jobs need the GPU:

1. **Emulation** — RPCS3 translates PS3 Cell/RSX workloads to Vulkan. On a
   CPU-only box (or SwiftShader software Vulkan) a demanding game runs at
   single-digit FPS. There is no software trick around this.
2. **Streaming** — encoding 1080p60 H.264 in software (`x264`) costs
   multiple CPU cores and adds latency. NVENC/VA-API encode on dedicated
   silicon in ~5 ms.

No GPU → not playable. The hardware check enforces this honestly.

---

## 4. Deploy the web interface (Railway)

Railway hosts the **web layer only**. It has no GPU, no Vulkan, and cannot
run RPCS3 — and this project will tell you so instead of pretending
otherwise.

1. Push this repo to GitHub, create a Railway project from it.
2. Set the Dockerfile path to `Dockerfile.web` (or create a Railway
   service with `Dockerfile.web`).
3. Environment variables: `ROLE=web`, `PORT` (Railway injects it),
   `AUTH_USER`, `AUTH_PASS_HASH`, `SESSION_SECRET`,
   `GAMING_SERVER_URL=https://your-gpu-server`, `GAMING_API_SECRET`
   (same value as on the gaming server).
4. Railway terminates TLS for you — the app speaks plain HTTP behind it,
   and WebSockets upgrade normally.

> "Railway deployment can host the web/control layer, but this environment
> may not be suitable for GPU-accelerated PS3 emulation." — the gaming
> server below is the part that actually emulates.

---

## 5. Configure the gaming server

On your GPU VM (Ubuntu 22.04):

```bash
sudo ./scripts/setup.sh     # deps + official RPCS3 AppImage + dirs
# set AUTH_PASS_HASH in .env:
node -e "console.log(require('bcryptjs').hashSync('YOUR_PASSWORD', 10))"
./scripts/start.sh           # hardware check, then launch
```

Or with Docker (needs NVIDIA Container Toolkit on the host):

```bash
cp .env.example .env   # then edit: secrets, paths
# in docker-compose.yml, uncomment the `gpus: all` line
USE_DOCKER=1 ./scripts/start.sh
```

Key variables (see `.env.example` for all):

| Variable           | Default        | Notes                              |
|--------------------|----------------|------------------------------------|
| `ROLE`             | `all`          | `all` / `web` / `gaming`           |
| `MAX_SESSION_TIME` | `120`          | minutes per session                |
| `IDLE_TIMEOUT`     | `15`           | idle minutes before auto-kill      |
| `VIDEO_RESOLUTION` | `1280x720`     | stability-first default            |
| `VIDEO_FPS`        | `30`           | `60` if your GPU keeps up          |
| `VIDEO_BITRATE`    | `4000`         | kbps                               |
| `WEBRTC_PORT`      | `8889`         | reserved for TURN/STUN relay setups|
| `GAME_DIRECTORY`   | `/data/games`  | your dumps go here                 |
| `EMULATOR_DIRECTORY`| `/opt/rpcs3`  |                                    |

---

## 6. Where your legally obtained files go

```
/data/games/                  ← YOUR game dumps
    GodOfWarIII/              ← folder containing PS3_GAME/
    some-game.pkg             ← …or .pkg files
/data/firmware/               ← YOUR installed firmware
    dev_flash/                ← created by RPCS3's "Install Firmware"
```

**Firmware:** dump `PS3UPDAT.PUP` from a PS3 you own (see RPCS3's official
quickstart guide), then install it inside RPCS3 via **File → Install
Firmware**. The server only checks that `dev_flash/` exists afterwards —
it never downloads firmware for you.

**Games:** dump your own discs (PS3 + compatible Blu-ray drive, per
RPCS3's guide) into `/data/games`. Set `GAME_ID` to pick a specific one;
otherwise the first found game boots.

On **START GAME**, the server verifies in order — resources → emulator →
firmware → game — and shows a plain-language error naming exactly what's
missing.

---

## 7. Connect the browser

1. Open `https://your-server:8080` (or your Railway URL).
2. Sign in with `AUTH_USER` / your password.
3. Hit **▶ START GAME** and watch the checks pass.
4. The stream appears as the main element. Click it once so keyboard
   input is captured.

---

## 8. Connect a controller

- **Gamepad:** connect your USB/Bluetooth controller, open the page in
  Chrome/Edge, and press any button — the pill in the header lights up
  with its name. Input follows the standard Gamepad API mapping and is
  forwarded to the virtual Xbox 360 pad at 60 Hz.
- **Keyboard:** click the video, then type — keys are sent using
  `KeyboardEvent.code` (layout-independent) to the virtual keyboard.

In RPCS3, open **Configuration → Pads** once and make sure the pad
handler is pointed at "CloudPad 360".

---

## 9. Troubleshooting

**Black screen after START**
- The game is likely still shader-compiling (first boot is slow — wait
  2–5 minutes).
- Check server logs: `[emulator]` lines show RPCS3's output.
- Confirm the virtual display is up: `xdpyinfo -display :99` on the server.

**Low FPS**
- Run `npm run hwcheck`. If it says insufficient — it means it.
- Lower `VIDEO_RESOLUTION` to `1280x720` and `VIDEO_FPS` to `30`.
- Check the UI's **Stream FPS** (encoder FPS) vs game smoothness: if
  stream FPS is fine but the game stutters, the emulator (not the
  network) is the bottleneck → you need a stronger GPU.

**High latency**
- Use a wired connection or 5 GHz Wi-Fi; check the **Latency** readout
  (WebRTC round-trip from `getStats`).
- Make sure the encoder is NVENC/VA-API, not x264 (server logs print the
  chosen encoder on session start).
- Lower `VIDEO_BITRATE` if your uplink is the bottleneck.

**Missing Vulkan / GPU**
- In Docker: the host needs the NVIDIA Container Toolkit and the
  compose file's `gpus: all` uncommented.
- On a bare VM: install the NVIDIA driver, then `vulkaninfo` should list
  your GPU. Without it, God of War III will not be playable — the
  hardware check says so explicitly.

**"Firmware not found" / "No games found"**
- Re-read section 6. The paths must contain *your* dumped files;
  empty folders are the usual cause.

**Session dies after 15 idle minutes**
- That's `IDLE_TIMEOUT` working as intended. Any input resets the timer.

---

## 10. Platform validation (read before you deploy anywhere)

| Platform | Web/UI layer | GPU emulation | Verdict |
|----------|--------------|---------------|---------|
| Railway  | ✅ Yes       | ❌ No GPU / no Vulkan | Web layer only — pair with a GPU VM |
| Vast.ai / RunPod / Lambda | ✅ | ✅ (pick a GPU) | Good fit for the gaming server |
| AWS g4dn / GCP GPU VMs | ✅ | ✅ | Good fit, pricier |
| Any CPU-only VPS | ✅ | ❌ | Will fail the hardware check — don't bother |

**Do not** try to run the emulator on Railway, Heroku, or a CPU-only
VPS and expect God of War III to work. The `hardware-detection.js`
verdict exists precisely to stop you from wasting time there.

---

## Security notes

- Auth required for everything; passwords are bcrypt hashes in env vars.
- The emulator and its X display bind to localhost / the container
  network only — never exposed publicly.
- Serve behind HTTPS (Railway/Caddy/Traefik); WebSockets upgrade to WSS.
- One session per user; idle and max-time reapers kill abandoned sessions.
- Secrets live in environment variables, never in the repo (`.env` is
  gitignored — check in only `.env.example`).

## Project structure

```
cloud-ps3-gaming/
├── Dockerfile            # gaming image (emulator + streaming)
├── Dockerfile.web        # web-only image (Railway)
├── docker-compose.yml
├── README.md
├── .env.example
├── server/
│   ├── server.js         # Express + WS, ROLE-aware (all/web/gaming)
│   ├── auth.js           # bcrypt login, signed sessions, rate limits
│   ├── session-manager.js# start/stop, pre-flight checks, reaper
│   ├── hardware-detection.js # honest capability verdict (+ CLI)
│   ├── input-manager.js  # WS → virtual-device bridge pipe
│   └── proxy.js          # web → gaming server proxy (split mode)
├── streaming/
│   ├── webrtc_streamer.py# GStreamer webrtcbin capture + encode
│   └── README.md
├── input/
│   └── virtual_gamepad.py# uinput Xbox 360 pad + keyboard
├── emulator/
│   ├── entrypoint.sh     # X display, checks, RPCS3 boot
│   └── README.md         # where YOUR files go
├── frontend/
│   ├── index.html
│   ├── style.css
│   └── app.js            # WebRTC client, gamepad/keyboard, stats
└── scripts/
    ├── setup.sh
    └── start.sh
```

## License

MIT — for the code in this repo. RPCS3 is GPLv2 (separate project).
Your games and firmware remain yours and are never included here.
