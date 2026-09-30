'use strict';
/*
 * proxy.js — ROLE=web (e.g. Railway).
 * The web layer owns auth and the UI; everything gaming-related
 * (/api/session/*, /api/hardware, /ws/*) is proxied to the GPU server.
 * The shared GAMING_API_SECRET authenticates the proxy, never the browser.
 */
const httpProxy = require('http-proxy');

function target() {
  const url = process.env.GAMING_SERVER_URL;
  if (!url) throw new Error('GAMING_SERVER_URL is not set (ROLE=web requires it).');
  return url.replace(/\/$/, '');
}

function gamingHeaders() {
  return { 'x-gaming-secret': process.env.GAMING_API_SECRET || '' };
}

const proxy = httpProxy.createProxyServer({ ws: true, changeOrigin: true });

proxy.on('error', (err, req, res) => {
  console.error('[proxy] error:', err.message);
  if (res && !res.headersSent) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'gaming_server_unreachable', detail: err.message }));
  }
});

function proxyHttp(req, res) {
  proxy.web(req, res, { target: target(), headers: gamingHeaders() }, (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'gaming_server_unreachable' }));
    }
  });
}

function proxyWs(req, socket, head) {
  proxy.ws(req, socket, head, { target: target(), headers: gamingHeaders() });
}

module.exports = { proxyHttp, proxyWs };
