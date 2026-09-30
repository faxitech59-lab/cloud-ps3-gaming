#!/usr/bin/env python3
"""
webrtc_streamer.py — capture the emulator's X display and stream it to the
browser over WebRTC with low latency.

Signaling protocol (JSON lines on stdin/stdout, driven by server.js):
  in:  {"type": "offer", "sdp": "<SDP offer>"}
  in:  {"type": "ice", "candidate": "<candidate>", "sdpMLineIndex": N}
  out: {"type": "answer", "sdp": "<SDP answer>"}
  out: {"type": "ice", "candidate": "<candidate>", "sdpMLineIndex": N}
  out: {"type": "stats", "fps": <encoder fps>}        (every 2s, honest stream FPS)
  out: {"type": "error", "message": "<what failed>"}

Video:  ximagesrc -> videoconvert -> videoscale -> <encoder> -> rtph264pay -> webrtcbin
Audio:  pulsesrc -> audioconvert -> opusenc -> rtpopuspay -> webrtcbin
Encoder auto-select: NVENC (nvh264enc) -> VA-API (vaapih264enc) -> x264enc.
"""
import argparse
import json
import os
import shutil
import sys
import threading
import time

import gi
gi.require_version('Gst', '1.0')
gi.require_version('GstWebRTC', '1.0')
gi.require_version('GstSdp', '1.0')
from gi.repository import Gst, GstWebRTC, GstSdp, GLib  # noqa: E402

Gst.init(None)


def pick_encoder():
    """Return (element_name, extra_properties). Honest: report what we chose."""
    if shutil.which('nvidia-smi'):
        try:
            import subprocess
            subprocess.run(['nvidia-smi', '-L'], check=True,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                           timeout=5)
            return ('nvh264enc', {'preset': 'low-latency-hq', 'zerolatency': True})
        except Exception:
            pass
    dri = '/dev/dri'
    if os.path.isdir(dri) and any(f.startswith('renderD') for f in os.listdir(dri)):
        return ('vaapih264enc', {'rate-control': 'cbr'})
    return ('x264enc', {'tune': 'zerolatency', 'speed-preset': 'ultrafast'})


def emit(obj):
    sys.stdout.write(json.dumps(obj) + '\n')
    sys.stdout.flush()


class Streamer:
    def __init__(self, args):
        self.args = args
        self.pipe = None
        self.webrtc = None
        self.loop = GLib.MainLoop()
        self.frame_count = 0
        self.last_stat = time.time()
        enc_name, enc_props = pick_encoder()
        self.enc_name = enc_name
        self.enc_props = enc_props

    def build(self):
        a = self.args
        enc_props_str = ' '.join(f'{k}={v}' for k, v in self.enc_props.items())
        desc = (
            f'ximagesrc use-damage=false ! '
            f'videoconvert ! videoscale ! '
            f'video/x-raw,width={a.width},height={a.height},framerate={a.fps}/1 ! '
            f'{a.enc_name} {enc_props_str} bitrate={a.bitrate} ! '
            f'h264parse ! rtph264pay config-interval=-1 name=payv ! '
            f'webrtcbin name=webrtc bundle-policy=max-bundle stun-server={a.stun} '
            f'pulsesrc ! audioconvert ! audioresample ! opusenc bitrate=64000 ! '
            f'rtpopuspay name=paya ! webrtc.'
        )
        self.pipe = Gst.parse_launch(desc)
        self.webrtc = self.pipe.get_by_name('webrtc')

        # Pad probe -> honest stream FPS stats
        enc = self.pipe.get_by_name(a.enc_name)
        sinkpad = enc.get_static_pad('sink')
        sinkpad.add_probe(Gst.PadProbeType.BUFFER, self._on_buffer)

        self.webrtc.connect('on-negotiation-needed', lambda *_: None)
        self.webrtc.connect('on-ice-candidate', self._on_ice_candidate)
        bus = self.pipe.get_bus()
        bus.add_signal_watch()
        bus.connect('message', self._on_bus)

    def _on_buffer(self, pad, info):
        self.frame_count += 1
        now = time.time()
        if now - self.last_stat >= 2.0:
            fps = self.frame_count / (now - self.last_stat)
            self.frame_count = 0
            self.last_stat = now
            emit({'type': 'stats', 'fps': round(fps, 1)})
        return Gst.PadProbeReturn.OK

    def _on_ice_candidate(self, _webrtc, mlineindex, candidate):
        emit({'type': 'ice', 'candidate': candidate, 'sdpMLineIndex': mlineindex})

    def _on_bus(self, _bus, msg):
        if msg.type == Gst.MessageType.ERROR:
            err, dbg = msg.parse_error()
            emit({'type': 'error', 'message': f'GStreamer error: {err} ({dbg})'})

    def handle_offer(self, sdp_str):
        res, sdp = GstSdp.SDPMessage.new_from_text(sdp_str)
        assert res == GstSdp.SDPResult.OK
        offer = GstWebRTC.WebRTCSessionDescription.new(
            GstWebRTC.WebRTCSDPType.OFFER, sdp)
        promise = Gst.Promise.new_with_change_func(self._on_offer_set, None, None)
        self.webrtc.emit('set-remote-description', offer, promise)

    def _on_offer_set(self, promise, _ud):
        promise.wait()
        reply = promise.get_reply()
        # create-answer
        promise2 = Gst.Promise.new_with_change_func(self._on_answer_created, None, None)
        self.webrtc.emit('create-answer', None, promise2)

    def _on_answer_created(self, promise, _ud):
        promise.wait()
        reply = promise.get_reply()
        answer = reply.get_value('answer')
        promise3 = Gst.Promise.new()
        self.webrtc.emit('set-local-description', answer, promise3)
        promise3.wait()
        text = answer.sdp.as_text()
        emit({'type': 'answer', 'sdp': text})

    def handle_ice(self, candidate, mlineindex):
        self.webrtc.emit('add-ice-candidate', mlineindex, candidate)

    def run(self):
        self.build()
        emit({'type': 'ready', 'encoder': self.enc_name,
              'note': 'waiting for SDP offer on stdin'})
        self.pipe.set_state(Gst.State.PLAYING)

        def stdin_loop():
            for line in sys.stdin:
                line = line.strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                except json.JSONDecodeError:
                    continue
                try:
                    if msg.get('type') == 'offer':
                        GLib.idle_add(self.handle_offer, msg['sdp'])
                    elif msg.get('type') == 'ice':
                        GLib.idle_add(self.handle_ice, msg['candidate'],
                                      int(msg.get('sdpMLineIndex', 0)))
                except Exception as e:  # never die on a bad message
                    emit({'type': 'error', 'message': f'signaling failed: {e}'})

        threading.Thread(target=stdin_loop, daemon=True).start()
        try:
            self.loop.run()
        except KeyboardInterrupt:
            pass
        finally:
            self.pipe.set_state(Gst.State.NULL)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--width', type=int, default=1280)
    ap.add_argument('--height', type=int, default=720)
    ap.add_argument('--fps', type=int, default=30)
    ap.add_argument('--bitrate', type=int, default=4000,
                    help='video bitrate in kbps')
    ap.add_argument('--stun', default='stun://stun.l.google.com:19302')
    args = ap.parse_args()
    # encoder name resolved inside Streamer; stash for build()
    enc_name, _ = pick_encoder()
    args.enc_name = enc_name
    try:
        Streamer(args).run()
    except Exception as e:
        emit({'type': 'error', 'message': f'fatal: {e}'})
        sys.exit(1)


if __name__ == '__main__':
    main()
