# Emulator

This project uses **RPCS3**, the legitimate open-source PlayStation 3
emulator (https://rpcs3.net). Nothing copyrighted is bundled here — no
games, no firmware, no BIOS. You provide everything yourself, from
hardware and dumps you legally own.

## What you need (your responsibility)

1. **RPCS3 itself** — `scripts/setup.sh` downloads the official AppImage
   from RPCS3's GitHub releases. Or install it manually to
   `/opt/rpcs3/rpcs3.AppImage` (override with `RPCS3_APPIMAGE`).
2. **PS3 firmware** — dump `PS3UPDAT.PUP` from a PlayStation 3 console
   you own (RPCS3's official quickstart guide explains dumping), then in
   RPCS3 go to **File → Install Firmware** and install it. The server
   checks for the installed result at:
   `FIRMWARE_DIRECTORY/dev_flash` (default `/data/firmware/dev_flash`).
3. **Your game** — dump your legally owned disc with a PS3 + compatible
   Blu-ray drive (again: RPCS3's official guide covers this). Place the
   result in `GAME_DIRECTORY` (default `/data/games`):
   - a folder containing `PS3_GAME/` (folder dumps), or
   - a `.pkg` file.

## How the server finds your files

On **START GAME** the server runs these checks in order and shows a clear
error if anything is missing:

1. Server resources (free RAM)
2. Emulator binary (`RPCS3_APPIMAGE` exists and is executable)
3. Firmware (`FIRMWARE_DIRECTORY/dev_flash` exists)
4. Game (a `PS3_GAME` folder or `.pkg` in `GAME_DIRECTORY`;
   `GAME_ID` env var selects a specific one, otherwise the first found)

## Input

`input/virtual_gamepad.py` creates a virtual Xbox 360 pad ("CloudPad 360")
via Linux uinput. In RPCS3, open **Configuration → Pads** once and select
the pad handler for the CloudPad device; the mapping is standard XInput so
it works out of the box afterwards. Keyboard input goes through the
"CloudPad Keyboard" device.

## Saves

RPCS3 keeps saves under its data directory (`~/.config/rpcs3` by default,
or `RPCS3_HOME`). Mount it as a Docker volume if you want saves to
survive container restarts (see `docker-compose.yml`).

## Performance notes

- God of War III is a demanding title. RPCS3 needs a **Vulkan-capable GPU**
  for playable frame rates — run `npm run hwcheck` (or
  `node server/hardware-detection.js --cli`) and believe its verdict.
- First boot of a game compiles shaders and is slow; subsequent runs are
  faster as the shader cache builds up.
