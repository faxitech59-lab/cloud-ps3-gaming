'use strict';
/*
 * input-manager.js — forwards browser input to the virtual-device bridge.
 * The browser sends compact gamepad/keyboard frames over WS; we pipe them
 * as JSON lines to input/virtual_gamepad.py, which owns the uinput devices.
 */
function attachInputSocket(ws, session) {
  if (!session || !session.input || !session.input.stdin) {
    ws.close(1011, 'input bridge not running');
    return;
  }
  const stdin = session.input.stdin;

  ws.on('message', (raw) => {
    try {
      // Validate shape, then pass through. Keep it small and fast.
      const msg = JSON.parse(raw.toString());
      if (msg.t !== 'pad' && msg.t !== 'key') return;
      session.touch();
      stdin.write(JSON.stringify(msg) + '\n');
    } catch {
      /* ignore malformed frames — never crash on input */
    }
  });

  ws.on('close', () => {
    // Tell the bridge to release all buttons/keys (avoid stuck inputs).
    try {
      stdin.write(JSON.stringify({ t: 'reset' }) + '\n');
    } catch { /* bridge may be gone */ }
  });
}

module.exports = { attachInputSocket };
