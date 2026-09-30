'use strict';
/*
 * server.js — cloud PS3 gaming server.
 *
 * ROLE=all    : web UI + emulator + streaming on one machine (GPU box)
 * ROLE=web    : web UI / API / auth only (e.g. Railway) → proxies to gaming server
 * ROLE=gaming : emulator + streaming + input only (GPU cloud VM)
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

// ── tiny .env loader (no extra dependency) ──────────────────────────────
(function loadEnv() {
  const p = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) {
      process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
})();

const ROLE = (process.env.ROLE || 'all').toLowerCase();
const PORT = parseInt(process.env.PORT || '8080', 10);

const auth = require('./auth');
const hw = require('./hardware-detection');
const sm = require('./session-manager');
const { attachInputSocket } = require('./input-manager');

const app = express();
app.use(express.json({ limit: '64kb' }));

// ── hardware snapshot (refreshed every 60s) ──────────────────────────────
let hwCache = null;
function refreshHw() {
  try {
    hwCache = hw.detect(process.env.GAME_DIRECTORY);
  } catch (e) {
    console.error('[hw] detection failed:', e.message);
  }
}
refreshHw();
setInterval(refreshHw, 60_000).unref();

// ── helpers ─────────────────────────────────────────────────────────────
function streamConfig() {
  const m = /^(\d+)x(\d+)$/.exec(process.env.VIDEO_RESOLUTION || '');
  return {
    resolution: process.env.VIDEO_RESOLUTION || '1280x720',
    width: m ? +m[1] : 1280,
    height: m ? +m[2] : 720,
    fps: parseInt(process.env.VIDEO_FPS || '30', 10),
    bitrateKbps: parseInt(process.env.VIDEO_BITRATE || '4000', 10),
  };
}

// ── auth routes (always local, even in web mode) ────────────────────────
app.post('/api/login', async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (!auth.rateLimitCheck(ip)) {
    return res.status(429).json({ error: 'too_many_attempts' });
  }
  try {
    const ok = await auth.checkCredentials(req.body.user, req.body.pass);
    if (!ok) return res.status(401).json({ error: 'bad_credentials' });
    const cookie = auth.createSession(req.body.user);
    res.setHeader(
      'Set-Cookie',
      `ps3sess=${encodeURIComponent(cookie)}; HttpOnly; Path=/; SameSite=Strict; Max-Age=43200`
    );
    res.json({ ok: true, user: req.body.user });
  } catch (e) {
    res.status(500).json({ error: 'auth_misconfigured', detail: e.message });
  }
});

app.post('/api/logout', (req, res) => {
  auth.destroySession(auth.parseCookies(req).ps3sess);
  res.setHeader('Set-Cookie', 'ps3sess=; HttpOnly; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const user = auth.verifySession(auth.parseCookies(req).ps3sess);
  res.json({ user: user || null });
});

// ── ROLE=web: proxy gaming routes to the GPU server ─────────────────────
if (ROLE === 'web') {
  const { proxyHttp, proxyWs } = require('./proxy');
  const server = http.createServer(app);

  // Local: frontend + auth. Everything else → gaming server (auth required).
  const gamingRoutes = ['/api/status', '/api/hardware', '/api/session', '/ws/'];
  app.use((req, res, next) => {
    if (gamingRoutes.some((r) => req.path === r || req.path.startsWith(r))) {
      const user = auth.verifySession(auth.parseCookies(req).ps3sess);
      if (!user) return res.status(401).json({ error: 'not_authenticated' });
      return proxyHttp(req, res);
    }
    next();
  });
  app.use(express.static(path.join(__dirname, '..', 'frontend')));

  server.on('upgrade', (req, socket, head) => {
    if (req.url.startsWith('/ws/')) {
      const user = auth.verifySession(auth.parseCookies(req).ps3sess);
      if (!user) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      proxyWs(req, socket, head);
    } else {
      socket.destroy();
    }
  });

  server.listen(PORT, () =>
    console.log(`[web] listening on :${PORT}, proxying to ${process.env.GAMING_SERVER_URL}`)
  );
  return;
}

// ── ROLE=all|gaming: full stack ─────────────────────────────────────────
const guard = ROLE === 'gaming' ? auth.requireGamingSecret : auth.requireAuth;

app.get('/api/hardware', guard, (req, res) => res.json(hwCache || { error: 'detecting' }));

app.get('/api/status', guard, (req, res) => {
  const user = ROLE === 'gaming' ? req.headers['x-user'] || 'gaming' : req.user;
  const s = sm.getSession(user);
  res.json({
    role: ROLE,
    stream: streamConfig(),
    session: s ? s.status(hwCache) : null,
    streamFps: s && s.streamFps ? s.streamFps : null,
  });
});

app.post('/api/session/start', guard, async (req, res) => {
  const user = ROLE === 'gaming' ? req.headers['x-user'] || 'gaming' : req.user;
  try {
    const info = await sm.startSession(user);
    res.json({ ok: true, ...info });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/session/stop', guard, (req, res) => {
  const user = ROLE === 'gaming' ? req.headers['x-user'] || 'gaming' : req.user;
  sm.stopSession(user, 'user');
  res.json({ ok: true });
});

// In gaming mode the web layer proxies with x-user; default it here too.
app.use((req, res, next) => {
  if (ROLE === 'gaming' && !req.headers['x-user']) req.headers['x-user'] = 'web-user';
  next();
});

if (ROLE === 'all') {
  app.use(express.static(path.join(__dirname, '..', 'frontend')));
} else {
  app.get('/', (req, res) => res.json({ role: 'gaming', ok: true }));
}

const server = http.createServer(app);

// ── WebSocket: signaling (browser ↔ webrtc_streamer.py stdio) ───────────
const sigWss = new WebSocketServer({ noServer: true });
sigWss.on('connection', (ws, req) => {
  const user = ROLE === 'gaming' ? req.headers['x-user'] || 'web-user' : req._user;
  const session = sm.getSession(user);
  if (!session || !session.streamer) {
    ws.close(1011, 'no active session');
    return;
  }
  const child = session.streamer;
  let buf = '';

  const onData = (data) => {
    buf += data.toString();
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.type === 'stats') {
          session.streamFps = msg.fps; // honest, labeled stream FPS
          continue;
        }
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
      } catch { /* ignore non-JSON log lines */ }
    }
  };
  child.stdout.on('data', onData);

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (!['offer', 'ice'].includes(msg.type)) return;
      session.touch();
      child.stdin.write(JSON.stringify(msg) + '\n');
    } catch { /* ignore malformed signaling */ }
  });

  const cleanup = () => child.stdout.off('data', onData);
  ws.on('close', cleanup);
  ws.on('error', cleanup);
});

// ── WebSocket: input (browser → virtual gamepad/keyboard) ───────────────
const inputWss = new WebSocketServer({ noServer: true });
inputWss.on('connection', (ws, req) => {
  const user = ROLE === 'gaming' ? req.headers['x-user'] || 'web-user' : req._user;
  attachInputSocket(ws, sm.getSession(user));
});

server.on('upgrade', (req, socket, head) => {
  const check = ROLE === 'gaming'
    ? auth.requireGamingSecret
    : (rq, rs, nx) => {
        const user = auth.verifySession(auth.parseCookies(rq).ps3sess);
        if (!user) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
        rq._user = user;
        nx();
      };
  check(req, {}, () => {
    if (req.url.startsWith('/ws/signaling')) sigWss.handleUpgrade(req, socket, head, (ws) => sigWss.emit('connection', ws, req));
    else if (req.url.startsWith('/ws/input')) inputWss.handleUpgrade(req, socket, head, (ws) => inputWss.emit('connection', ws, req));
    else socket.destroy();
  });
});

sm.startReaper();
server.listen(PORT, () => console.log(`[${ROLE}] listening on :${PORT}`));
