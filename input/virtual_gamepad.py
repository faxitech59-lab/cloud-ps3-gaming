#!/usr/bin/env python3
"""
virtual_gamepad.py — exposes virtual input devices to the emulator.

Creates two uinput devices:
  1. "CloudPad 360" — virtual Xbox 360-style gamepad (buttons + sticks +
     analog triggers + dpad). RPCS3 sees it as a regular SDL/evdev pad.
  2. "CloudPad Keyboard" — virtual keyboard for keyboard control.

Protocol: JSON lines on stdin (written by server/input-manager.js):
  {"t": "pad", "b": [0/1 x17], "a": [lx,ly,rx,ry], "lt": 0..1, "rt": 0..1}
     b = standard Gamepad API buttons: A,B,X,Y,LB,RB,LT,RT,Back,Start,
         LStick,RStick,DUp,DDown,DLeft,DRight,Guide
     a = sticks as floats in [-1, 1] (with deadzone applied here)
  {"t": "key", "code": "KeyW", "down": true}   (KeyboardEvent.code)
  {"t": "reset"}                                (release everything)

Requires /dev/uinput (root, or user in the `input` group).
"""
import json
import sys

from evdev import UInput, AbsInfo, ecodes as E

# ── virtual Xbox 360 pad ──────────────────────────────────────────────────
PAD_BUTTONS = [
    E.BTN_A, E.BTN_B, E.BTN_X, E.BTN_Y,          # 0-3
    E.BTN_TL, E.BTN_TR,                            # 4-5 (LB/RB)
    # 6-7 are analog triggers -> ABS_Z / ABS_RZ
    E.BTN_SELECT, E.BTN_START,                     # 8-9
    E.BTN_THUMBL, E.BTN_THUMBR,                    # 10-11
    # 12-15 dpad -> ABS_HAT0X/Y
    E.BTN_MODE,                                    # 16 (Guide)
]
# index in b[] -> evdev code (None = handled as analog/hat)
BTN_INDEX = {0: E.BTN_A, 1: E.BTN_B, 2: E.BTN_X, 3: E.BTN_Y,
             4: E.BTN_TL, 5: E.BTN_TR,
             8: E.BTN_SELECT, 9: E.BTN_START,
             10: E.BTN_THUMBL, 11: E.BTN_THUMBR, 16: E.BTN_MODE}

ABS_CAPS = {
    E.ABS_X: (-32768, 32767, 16, 128),
    E.ABS_Y: (-32768, 32767, 16, 128),
    E.ABS_RX: (-32768, 32767, 16, 128),
    E.ABS_RY: (-32768, 32767, 16, 128),
    E.ABS_Z: (0, 255, 0, 0),     # left trigger
    E.ABS_RZ: (0, 255, 0, 0),    # right trigger
    E.ABS_HAT0X: (-1, 1, 0, 0),
    E.ABS_HAT0Y: (-1, 1, 0, 0),
}

pad_caps = {
    E.EV_KEY: list(set(BTN_INDEX.values())),
    E.EV_ABS: [(code, AbsInfo(*vals)) for code, vals in ABS_CAPS.items()],
}

# ── virtual keyboard ──────────────────────────────────────────────────────
CODE_MAP = {
    # letters / digits
    **{f'Key{c}': getattr(E, f'KEY_{c}') for c in 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'},
    **{f'Digit{d}': getattr(E, f'KEY_{d}') for d in '0123456789'},
    'Space': E.KEY_SPACE, 'Enter': E.KEY_ENTER, 'Tab': E.KEY_TAB,
    'Escape': E.KEY_ESC, 'Backspace': E.KEY_BACKSPACE,
    'ArrowUp': E.KEY_UP, 'ArrowDown': E.KEY_DOWN,
    'ArrowLeft': E.KEY_LEFT, 'ArrowRight': E.KEY_RIGHT,
    'ShiftLeft': E.KEY_LEFTSHIFT, 'ShiftRight': E.KEY_RIGHTSHIFT,
    'ControlLeft': E.KEY_LEFTCTRL, 'ControlRight': E.KEY_RIGHTCTRL,
    'AltLeft': E.KEY_LEFTALT, 'AltRight': E.KEY_RIGHTALT,
    'MetaLeft': E.KEY_LEFTMETA, 'MetaRight': E.KEY_RIGHTMETA,
    'Minus': E.KEY_MINUS, 'Equal': E.KEY_EQUAL,
    'BracketLeft': E.KEY_LEFTBRACE, 'BracketRight': E.KEY_RIGHTBRACE,
    'Backslash': E.KEY_BACKSLASH, 'Semicolon': E.KEY_SEMICOLON,
    'Quote': E.KEY_APOSTROPHE, 'Backquote': E.KEY_GRAVE,
    'Comma': E.KEY_COMMA, 'Period': E.KEY_DOT, 'Slash': E.KEY_SLASH,
}
for fn in range(1, 13):
    CODE_MAP[f'F{fn}'] = getattr(E, f'KEY_F{fn}')

kbd_caps = {E.EV_KEY: sorted(set(CODE_MAP.values()))}


def deadzone(v, dz=0.12):
    return 0.0 if abs(v) < dz else v


def main():
    try:
        pad = UInput(pad_caps, name='CloudPad 360', version=0x1)
        kbd = UInput(kbd_caps, name='CloudPad Keyboard', version=0x1)
    except OSError as e:
        sys.stderr.write(f'FATAL: cannot open /dev/uinput: {e}\n'
                         'Run as root or add the user to the `input` group.\n')
        sys.exit(1)

    print('input bridge ready: CloudPad 360 + CloudPad Keyboard', flush=True)
    hat_x = hat_y = 0

    def emit_pad(b, a, lt, rt):
        for idx, code in BTN_INDEX.items():
            pad.write(E.EV_KEY, code, 1 if (b[idx] if idx < len(b) else 0) else 0)
        sticks = [deadzone(float(a[i]) if i < len(a) else 0.0) for i in range(4)]
        for code, v in zip((E.ABS_X, E.ABS_Y, E.ABS_RX, E.ABS_RY), sticks):
            pad.write(E.EV_ABS, code, int(v * 32767))
        pad.write(E.EV_ABS, E.ABS_Z, int(max(0.0, min(1.0, lt)) * 255))
        pad.write(E.EV_ABS, E.ABS_RZ, int(max(0.0, min(1.0, rt)) * 255))
        hx = (1 if (b[15] if len(b) > 15 else 0) else 0) - (1 if (b[14] if len(b) > 14 else 0) else 0)
        hy = (1 if (b[13] if len(b) > 13 else 0) else 0) - (1 if (b[12] if len(b) > 12 else 0) else 0)
        pad.write(E.EV_ABS, E.ABS_HAT0X, hx)
        pad.write(E.EV_ABS, E.ABS_HAT0Y, hy)
        pad.syn()

    def reset_all():
        for code in set(BTN_INDEX.values()):
            pad.write(E.EV_KEY, code, 0)
        for code in (E.ABS_X, E.ABS_Y, E.ABS_RX, E.ABS_RY,
                     E.ABS_Z, E.ABS_RZ, E.ABS_HAT0X, E.ABS_HAT0Y):
            pad.write(E.EV_ABS, code, 0)
        pad.syn()
        for code in kbd_caps[E.EV_KEY]:
            kbd.write(E.EV_KEY, code, 0)
        kbd.syn()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        try:
            t = msg.get('t')
            if t == 'pad':
                emit_pad(msg.get('b', []), msg.get('a', []),
                         msg.get('lt', 0), msg.get('rt', 0))
            elif t == 'key':
                code = CODE_MAP.get(msg.get('code', ''))
                if code is not None:
                    kbd.write(E.EV_KEY, code, 1 if msg.get('down') else 0)
                    kbd.syn()
            elif t == 'reset':
                reset_all()
        except Exception as e:
            sys.stderr.write(f'input error: {e}\n')


if __name__ == '__main__':
    main()
