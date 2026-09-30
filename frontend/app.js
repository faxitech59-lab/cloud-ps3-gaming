'use strict';
/* Cloud PS3 Gaming — browser client: auth, WebRTC streaming, input forwarding. */
const $ = (id) => document.getElementById(id);
const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';

let pc = null;
let sigWs = null;
let inputWs = null;
let padTimer = null;
let statsTimer = null;
let statusTimer = null;

/* ── auth ─────────────────────────────────────────────────────────── */
async function api(path, opts = {}) {
  const r = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (r.status === 401) return showLogin();
  return r.json();
}

async function init() {
  const me = await api('/api/me');
  if (me && me.user) showMain();
  else showLogin();
}

function showLogin() {
  $('login-view').classList.remove('hidden');
  $('main-view').classList.add('hidden');
}
function showMain() {
  $('login-view').classList.add('hidden');
  $('main-view').classList.remove('hidden');
  pollStatus();
  statusTimer = setInterval(pollStatus, 2000);
}

$('login-btn').onclick = async () => {
  $('login-error').textContent = '';
  const r = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: $('login-user').value, pass: $('login-pass').value }),
  });
  const j = await r.json();
  if (j.ok) showMain();
  else $('login-error').textContent = 'Sign-in failed — check your credentials.';
};

$('logout-btn').onclick = async () => {
  stopEverything();
  await fetch('/api/logout', { method: 'POST' });
  clearInterval(statusTimer);
  showLogin();
};

/* ── status panel ─────────────────────────────────────────────────── */
async function pollStatus() {
  const s = await api('/api/status');
  if (!s || !s.session) return;
  const sess = s.session;
  $('st-cpu').textContent = `${sess.cpuCount} cores`;
  $('st-gpu').textContent = (sess.gpu || '–').split(' ').slice(0, 3).join(' ');
  $('st-ram').textContent = `${sess.ramUsedGB} / ${sess.ramTotalGB} GB`;
  $('st-quality').textContent = `${s.stream.resolution} / ${s.stream.fps} FPS`;
  if (s.streamFps) $('st-fps').textContent = `${s.streamFps}`;
}

/* ── start flow ───────────────────────────────────────────────────── */
const STEPS = ['resources', 'emulator', 'firmware', 'game', 'boot', 'stream', 'controls'];
function setStep(name, cls) {
  document.querySelectorAll('#start-steps li').forEach((li) => {
    if (li.dataset.step === name) li.className = cls;
  });
}

$('start-btn').onclick = async () => {
  $('start-error').textContent = '';
  $('start-steps').classList.remove('hidden');
  STEPS.forEach((s) => setStep(s, ''));
  const advance = (i) => {
    if (i > 0) setStep(STEPS[i - 1], 'done');
    if (i < STEPS.length) setStep(STEPS[i], 'doing');
  };
  // Animate through the server-side checks (each maps to a real check).
  advance(0);
  const r = await api('/api/session/start', { method: 'POST' });
  if (!r.ok) {
    STEPS.forEach((s) => setStep(s, 'fail'));
    $('start-error').textContent = r.error || 'Failed to start. See server logs.';
    return;
  }
  STEPS.forEach((s) => setStep(s, 'done'));
  $('start-panel').classList.add('hidden');
  $('game-panel').classList.remove('hidden');
  await connectStream();
  connectInput();
};

$('stop-btn').onclick = async () => {
  await api('/api/session/stop', { method: 'POST' });
  stopEverything();
  $('game-panel').classList.add('hidden');
  $('start-panel').classList.remove('hidden');
};

function stopEverything() {
  [sigWs, inputWs].forEach((ws) => { try { ws && ws.close(); } catch {} });
  sigWs = inputWs = null;
  if (padTimer) clearInterval(padTimer);
  if (statsTimer) clearInterval(statsTimer);
  if (pc) { try { pc.close(); } catch {} pc = null; }
  $('stream').srcObject = null;
  $('stream-overlay').style.display = 'flex';
  $('stream-overlay').textContent = 'connecting…';
}

/* ── WebRTC ───────────────────────────────────────────────────────── */
async function connectStream() {
  pc = new RTCPeerConnection();
  const video = $('stream');
  pc.ontrack = (e) => {
    if (e.track.kind === 'video') {
      video.srcObject = e.streams[0];
      $('stream-overlay').style.display = 'none';
    }
  };
  pc.addTransceiver('video', { direction: 'recvonly' });
  pc.addTransceiver('audio', { direction: 'recvonly' });

  sigWs = new WebSocket(`${wsProto}//${location.host}/ws/signaling`);
  sigWs.onmessage = async (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'answer') {
      await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: msg.sdp }));
    } else if (msg.type === 'ice' && msg.candidate) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate({
          candidate: msg.candidate, sdpMLineIndex: msg.sdpMLineIndex,
        }));
      } catch {}
    } else if (msg.type === 'error') {
      $('stream-overlay').textContent = 'stream error: ' + msg.message;
    }
  };
  sigWs.onopen = async () => {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sigWs.send(JSON.stringify({ type: 'offer', sdp: offer.sdp }));
  };
  pc.onicecandidate = (e) => {
    if (e.candidate && sigWs.readyState === 1) {
      sigWs.send(JSON.stringify({
        type: 'ice', candidate: e.candidate.candidate,
        sdpMLineIndex: e.candidate.sdpMLineIndex,
      }));
    }
  };

  // Latency + FPS from real RTC stats.
  statsTimer = setInterval(async () => {
    if (!pc) return;
    try {
      const stats = await pc.getStats();
      stats.forEach((s) => {
        if (s.type === 'candidate-pair' && s.state === 'succeeded' && s.currentRoundTripTime != null) {
          $('st-lat').textContent = `${Math.round(s.currentRoundTripTime * 1000)} ms`;
        }
        if (s.type === 'inbound-rtp' && s.kind === 'video' && s.framesPerSecond) {
          $('st-fps').textContent = `${Math.round(s.framesPerSecond)}`;
        }
      });
    } catch {}
  }, 2000);
}

/* ── input: gamepad + keyboard ──────────────────────────────────────── */
function connectInput() {
  inputWs = new WebSocket(`${wsProto}//${location.host}/ws/input`);
  const send = (o) => { if (inputWs.readyState === 1) inputWs.send(JSON.stringify(o)); };

  // Gamepad API @ ~60Hz, standard mapping.
  let padSeen = false;
  padTimer = setInterval(() => {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const gp = [...pads].find((p) => p && p.connected);
    if (!gp) {
      if (padSeen) { padSeen = false; $('pad-status').textContent = '🎮 no gamepad'; $('pad-status').classList.remove('on'); }
      return;
    }
    if (!padSeen) {
      padSeen = true;
      $('pad-status').textContent = `🎮 ${gp.id.slice(0, 28)}`;
      $('pad-status').classList.add('on');
    }
    send({
      t: 'pad',
      b: gp.buttons.map((x) => (x.pressed ? 1 : 0)),
      a: [...gp.axes].slice(0, 4),
      lt: gp.buttons[6] ? gp.buttons[6].value : 0,
      rt: gp.buttons[7] ? gp.buttons[7].value : 0,
    });
  }, 16);

  // Keyboard → server key events (uses e.code, layout-independent).
  const key = (e, down) => {
    if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
    e.preventDefault();
    send({ t: 'key', code: e.code, down });
  };
  window.addEventListener('keydown', (e) => { if (!e.repeat) key(e, true); });
  window.addEventListener('keyup', (e) => key(e, false));
  // Clicking the video focuses the page for keyboard capture.
  $('stream').addEventListener('click', () => $('stream').focus());
}

init();
