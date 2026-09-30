'use strict';
/*
 * session-manager.js — one gaming session per user.
 *
 * START GAME flow:
 *   check server resources → check emulator → check firmware →
 *   check game → start emulator → start streaming → connect controls
 *
 * Sessions auto-terminate after MAX_SESSION_TIME or IDLE_TIMEOUT minutes.
 * The emulator is never exposed to the public internet: it only listens on
 * localhost / the docker network, and all access goes through this server.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { detect } = require('./hardware-detection');

const sessions = new Map(); // user -> Session

function parseResolution(s) {
  const m = /^(\d+)x(\d+)$/.exec(s || '');
  return m ? { w: +m[1], h: +m[2] } : { w: 1280, h: 720 };
}

function findGames(gameDir) {
  const found = [];
  if (!gameDir || !fs.existsSync(gameDir)) return found;
  for (const entry of fs.readdirSync(gameDir, { withFileTypes: true })) {
    const full = path.join(gameDir, entry.name);
    if (entry.isDirectory()) {
      if (fs.existsSync(path.join(full, 'PS3_GAME'))) {
        found.push({ id: entry.name, path: full, kind: 'folder' });
      }
    } else if (/\.pkg$/i.test(entry.name)) {
      found.push({ id: entry.name, path: full, kind: 'pkg' });
    }
  }
  return found;
}

function checkFirmware(firmwareDir) {
  // RPCS3 installs firmware into <data>/dev_flash. We only check for the
  // user's own installed firmware — we never ship or download it.
  if (!firmwareDir) return { ok: false, error: 'FIRMWARE_DIRECTORY is not set.' };
  const devFlash = path.join(firmwareDir, 'dev_flash');
  if (fs.existsSync(devFlash)) return { ok: true };
  return {
    ok: false,
    error:
      'PS3 firmware not found. Install YOUR OWN legally dumped firmware in RPCS3 ' +
      '(File → Install Firmware) using a PS3UPDAT.PUP you dumped from a console you own. ' +
      `Expected installed firmware at: ${devFlash}`,
  };
}

function checkEmulator() {
  const appImage = process.env.RPCS3_APPIMAGE || '/opt/rpcs3/rpcs3.AppImage';
  if (!fs.existsSync(appImage)) {
    return {
      ok: false,
      error: `RPCS3 not found at ${appImage}. Run scripts/setup.sh or set RPCS3_APPIMAGE.`,
    };
  }
  return { ok: true, path: appImage };
}

class Session {
  constructor(user) {
    this.user = user;
    this.id = `${user}-${Date.now()}`;
    this.createdAt = Date.now();
    this.lastInputAt = Date.now();
    this.state = 'starting'; // starting → running → stopping → stopped
    this.procs = [];
    this.game = null;
    this.streamer = null; // child_process for webrtc_streamer.py (stdio signaling)
    this.input = null; // child_process for virtual_gamepad.py
  }

  touch() {
    this.lastInputAt = Date.now();
  }

  elapsedMin() {
    return (Date.now() - this.createdAt) / 60000;
  }

  idleMin() {
    return (Date.now() - this.lastInputAt) / 60000;
  }

  _spawn(cmd, args, opts, tag) {
    const p = spawn(cmd, args, { ...opts, stdio: ['pipe', 'pipe', 'pipe'] });
    p._tag = tag;
    p.stdout.on('data', (d) => process.stdout.write(`[${tag}] ${d}`));
    p.stderr.on('data', (d) => process.stderr.write(`[${tag}ERR] ${d}`));
    p.on('exit', (code) => console.log(`[${tag}] exited with code ${code}`));
    this.procs.push(p);
    return p;
  }

  async start() {
    const gameDir = process.env.GAME_DIRECTORY || '/data/games';
    const firmwareDir = process.env.FIRMWARE_DIRECTORY || '/data/firmware';

    // 1. Server resources — refuse if the box is already exhausted.
    const freeGB = os.freemem() / 1024 ** 3;
    if (freeGB < 1) {
      throw new Error(`Insufficient free RAM (${freeGB.toFixed(1)} GB). Free memory and try again.`);
    }

    // 2. Emulator installation.
    const emu = checkEmulator();
    if (!emu.ok) throw new Error(emu.error);

    // 3. User-provided firmware.
    const fw = checkFirmware(firmwareDir);
    if (!fw.ok) throw new Error(fw.error);

    // 4. User-provided game.
    const games = findGames(gameDir);
    if (games.length === 0) {
      throw new Error(
        `No games found in ${gameDir}. Place your legally owned PS3 game dump there ` +
          '(a folder containing PS3_GAME, or a .pkg file). See emulator/README.md.'
      );
    }
    const wanted = process.env.GAME_ID;
    const game = (wanted && games.find((g) => g.id === wanted)) || games[0];
    if (wanted && !games.find((g) => g.id === wanted)) {
      throw new Error(`GAME_ID="${wanted}" not found. Available: ${games.map((g) => g.id).join(', ')}`);
    }
    this.game = game;

    // 5. Start the emulator (entrypoint handles X display + boot).
    const entrypoint = path.join(__dirname, '..', 'emulator', 'entrypoint.sh');
    const res = parseResolution(process.env.VIDEO_RESOLUTION);
    const emuProc = this._spawn(
      'bash',
      [entrypoint, game.path],
      {
        env: {
          ...process.env,
          DISPLAY: `:${process.env.DISPLAY_NUM || '99'}`,
          RPCS3_APPIMAGE: emu.path,
          FIRMWARE_DIRECTORY: firmwareDir,
        },
      },
      'emulator'
    );
    this.emuProc = emuProc;

    // 6. Start the WebRTC streamer (waits on stdin for the browser's SDP offer).
    const streamerPath = path.join(__dirname, '..', 'streaming', 'webrtc_streamer.py');
    this.streamer = this._spawn(
      'python3',
      [
        streamerPath,
        '--width', String(res.w),
        '--height', String(res.h),
        '--fps', String(process.env.VIDEO_FPS || '30'),
        '--bitrate', String(process.env.VIDEO_BITRATE || '4000'),
      ],
      { env: { ...process.env, DISPLAY: `:${process.env.DISPLAY_NUM || '99'}` } },
      'streamer'
    );

    // 7. Start the input bridge (browser gamepad/keyboard → virtual devices).
    const inputPath = path.join(__dirname, '..', 'input', 'virtual_gamepad.py');
    this.input = this._spawn('python3', [inputPath], {}, 'input');

    this.state = 'running';
    this.touch();
    console.log(`[session] started for ${this.user}, game=${game.id}`);
    return { game: game.id };
  }

  stop(reason = 'user') {
    if (this.state === 'stopped') return;
    this.state = 'stopping';
    console.log(`[session] stopping (${reason})`);
    for (const p of this.procs) {
      try {
        p.kill('SIGTERM');
      } catch { /* already dead */ }
    }
    // Force-kill stragglers.
    setTimeout(() => {
      for (const p of this.procs) {
        try {
          if (!p.killed) p.kill('SIGKILL');
        } catch { /* ignore */ }
      }
    }, 4000).unref();
    this.state = 'stopped';
  }

  status(hwCache) {
    const totalGB = os.totalmem() / 1024 ** 3;
    const freeGB = os.freemem() / 1024 ** 3;
    return {
      state: this.state,
      game: this.game ? this.game.id : null,
      uptimeMin: +this.elapsedMin().toFixed(1),
      idleMin: +this.idleMin().toFixed(1),
      cpuCount: os.cpus().length,
      ramUsedGB: +(totalGB - freeGB).toFixed(1),
      ramTotalGB: +totalGB.toFixed(1),
      gpu: hwCache && hwCache.gpu ? hwCache.gpu.name : 'unknown',
    };
  }
}

async function startSession(user) {
  const existing = sessions.get(user);
  if (existing && existing.state !== 'stopped') {
    throw new Error('A gaming session is already running for this user.');
  }
  const s = new Session(user);
  sessions.set(user, s);
  try {
    const info = await s.start();
    return { sessionId: s.id, ...info };
  } catch (err) {
    s.stop('failed');
    sessions.delete(user);
    throw err;
  }
}

function stopSession(user, reason) {
  const s = sessions.get(user);
  if (s) {
    s.stop(reason);
    sessions.delete(user);
  }
}

function getSession(user) {
  const s = sessions.get(user);
  return s && s.state !== 'stopped' ? s : null;
}

// Reaper: enforce MAX_SESSION_TIME and IDLE_TIMEOUT.
function startReaper() {
  const maxMin = parseFloat(process.env.MAX_SESSION_TIME || '120');
  const idleMin = parseFloat(process.env.IDLE_TIMEOUT || '15');
  setInterval(() => {
    for (const [user, s] of sessions) {
      if (s.elapsedMin() > maxMin) {
        console.log(`[reaper] session for ${user} exceeded MAX_SESSION_TIME`);
        stopSession(user, 'max_time');
      } else if (s.idleMin() > idleMin) {
        console.log(`[reaper] session for ${user} idle too long`);
        stopSession(user, 'idle');
      }
    }
  }, 60_000).unref();
}

module.exports = {
  startSession,
  stopSession,
  getSession,
  startReaper,
  findGames,
  checkFirmware,
  checkEmulator,
};
