#!/usr/bin/env bash
# start.sh — hardware check, then launch the server.
# Set USE_DOCKER=1 to run via docker compose instead of node directly.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo ".env not found — copying from .env.example. Edit it before continuing."
  cp .env.example .env
  exit 1
fi
set -a; source .env; set +a

echo "==> Hardware check…"
if node server/hardware-detection.js --cli; then
  echo "==> Verdict: suitable — starting server."
else
  echo
  echo "WARNING: this machine may be insufficient for PS3 emulation."
  read -r -p "Start anyway? [y/N] " ans
  [[ "$ans" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 1; }
fi

if [ "${USE_DOCKER:-0}" = "1" ]; then
  echo "==> docker compose up…"
  docker compose up --build
else
  echo "==> node server/server.js (ROLE=${ROLE:-all})"
  exec node server/server.js
fi
