'use strict';
/*
 * auth.js — minimal authentication.
 * Single user from env (AUTH_USER / AUTH_PASS_HASH bcrypt).
 * Sessions are random tokens HMAC-signed with SESSION_SECRET,
 * stored server-side with expiry, sent as HttpOnly cookies.
 */
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const sessions = new Map(); // token -> { user, expiresAt }
const loginAttempts = new Map(); // ip -> { count, resetAt }

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function getSecret() {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error('SESSION_SECRET is not set — refusing to run without it.');
  return s;
}

function signToken(token) {
  return crypto.createHmac('sha256', getSecret()).update(token).digest('hex');
}

function createSession(user) {
  const token = crypto.randomBytes(32).toString('hex');
  const sig = signToken(token);
  sessions.set(token, { user, sig, expiresAt: Date.now() + SESSION_TTL_MS });
  return `${token}.${sig}`;
}

function verifySession(cookieValue) {
  if (!cookieValue) return null;
  const [token, sig] = cookieValue.split('.');
  if (!token || !sig) return null;
  const rec = sessions.get(token);
  if (!rec) return null;
  if (rec.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }
  const expected = signToken(token);
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  return rec.user;
}

function destroySession(cookieValue) {
  if (!cookieValue) return;
  sessions.delete(cookieValue.split('.')[0]);
}

function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  header.split(';').forEach((part) => {
    const [k, ...v] = part.trim().split('=');
    out[k] = decodeURIComponent(v.join('='));
  });
  return out;
}

function rateLimitCheck(ip) {
  const now = Date.now();
  const rec = loginAttempts.get(ip) || { count: 0, resetAt: now + 60_000 };
  if (now > rec.resetAt) {
    rec.count = 0;
    rec.resetAt = now + 60_000;
  }
  rec.count += 1;
  loginAttempts.set(ip, rec);
  return rec.count <= 10; // 10 login attempts / minute / IP
}

async function checkCredentials(user, pass) {
  const envUser = process.env.AUTH_USER || 'admin';
  const envHash = process.env.AUTH_PASS_HASH;
  if (!envHash) throw new Error('AUTH_PASS_HASH is not set.');
  if (user !== envUser) {
    // Burn equal time to avoid user enumeration via timing.
    await bcrypt.compare(pass || '', envHash);
    return false;
  }
  return bcrypt.compare(pass || '', envHash);
}

function requireAuth(req, res, next) {
  const user = verifySession(parseCookies(req).ps3sess);
  if (!user) return res.status(401).json({ error: 'not_authenticated' });
  req.user = user;
  next();
}

// Used by the gaming server in split deployments: trusts the web layer's secret.
function requireGamingSecret(req, res, next) {
  const secret = process.env.GAMING_API_SECRET;
  if (!secret) return res.status(500).json({ error: 'gaming_secret_not_configured' });
  const got = req.headers['x-gaming-secret'];
  if (!got || !crypto.timingSafeEqual(Buffer.from(String(got)), Buffer.from(secret))) {
    return res.status(403).json({ error: 'forbidden' });
  }
  next();
}

module.exports = {
  createSession,
  verifySession,
  destroySession,
  parseCookies,
  rateLimitCheck,
  checkCredentials,
  requireAuth,
  requireGamingSecret,
};
