#!/usr/bin/env python3
"""
DJ Local Worker — GStreamer dual-deck audio engine.
Transport: newline-delimited JSON over TCP (127.0.0.1:3011).
Protocol version: 2

Decks:
  Deck A and Deck B are independent GStreamer playbin pipelines.
  One deck is "active" (on air); the other is "standby" (preload target).
  Crossfade: volume fade from active -> standby over a configurable duration,
  then standby becomes the new active deck.
"""
import json
import os
import signal
import socketserver
import threading
import time
from pathlib import Path

import gi

try:
    gi.require_version('Gst', '1.0')
    from gi.repository import Gst
except Exception as e:
    raise SystemExit(f'Failed to load GStreamer bindings: {e}')

Gst.init(None)

PROTOCOL_VERSION = 2
WORKER_ID = 'dj-worker-1'
STATE_PATH = Path('$HOME/claw-dj/server/data/dj-local-worker-state.json')
HOST = '127.0.0.1'
PORT = int(os.environ.get('DJ_LOCAL_WORKER_PORT', '3011'))


class DeckState:
    def __init__(self, deck_id: str):
        self.deck_id = deck_id
        self.mode = 'idle'
        self.current_track = None
        self.position_seconds = 0.0
        self.duration_seconds = 0.0
        self.volume = 1.0
        self.eos_count = 0
        self.current_playback_token = None
        self.last_error = ''

    def to_dict(self):
        return {
            'deckId': self.deck_id,
            'mode': self.mode,
            'currentTrack': self.current_track,
            'positionSeconds': self.position_seconds,
            'durationSeconds': self.duration_seconds,
            'volume': self.volume,
            'eosCount': self.eos_count,
            'currentPlaybackToken': self.current_playback_token,
            'lastError': self.last_error,
        }


class Deck:
    """A single GStreamer playbin pipeline representing one DJ deck."""

    def __init__(self, deck_id: str, on_eos=None):
        self.deck_id = deck_id
        self.state = DeckState(deck_id)
        self._on_eos = on_eos
        self.lock = threading.Lock()
        self._player = Gst.ElementFactory.make('playbin', f'player_{deck_id}')
        if not self._player:
            raise RuntimeError(f'Could not create playbin for deck {deck_id}')
        self._player.set_property('volume', 1.0)
        bus = self._player.get_bus()
        bus.add_signal_watch()
        bus.connect('message', self._on_message)

    def _ts(self):
        return int(time.time() * 1000)

    def _on_message(self, _bus, message):
        t = message.type
        with self.lock:
            if t == Gst.MessageType.EOS:
                self.state.mode = 'idle'
                self.state.current_track = None
                self.state.current_playback_token = None
                self.state.position_seconds = self.state.duration_seconds
                self.state.eos_count += 1
                if self._on_eos:
                    threading.Thread(target=self._on_eos, args=(self.deck_id,), daemon=True).start()
            elif t == Gst.MessageType.ERROR:
                err, debug = message.parse_error()
                self.state.mode = 'error'
                self.state.last_error = f'{err}: {debug}'

    def play(self, uri: str, playback_token: str = '', track_meta: dict = None):
        with self.lock:
            self._player.set_state(Gst.State.NULL)
            self._player.set_property('uri', uri)
            self._player.set_property('volume', self.state.volume)
            self._player.set_state(Gst.State.PLAYING)
            self.state.mode = 'playing'
            self.state.current_playback_token = playback_token or f'play_{self._ts()}'
            self.state.current_track = track_meta or {'uri': uri}
            self.state.last_error = ''
            self.state.position_seconds = 0.0
            self.state.duration_seconds = 0.0

    def preload(self, uri: str, playback_token: str = '', track_meta: dict = None):
        """Load track onto standby deck silently, ready for crossfade."""
        with self.lock:
            self._player.set_state(Gst.State.NULL)
            self._player.set_property('uri', uri)
            self._player.set_property('volume', 0.0)
            self._player.set_state(Gst.State.PAUSED)
            self.state.mode = 'loading'
            self.state.current_playback_token = playback_token or f'preload_{self._ts()}'
            self.state.current_track = track_meta or {'uri': uri}
            self.state.last_error = ''
            self.state.position_seconds = 0.0
            self.state.duration_seconds = 0.0

    def pause(self):
        with self.lock:
            if self.state.mode not in ('playing',):
                raise ValueError(f'INVALID_STATE: cannot pause from {self.state.mode}')
            self._refresh_position_locked()
            self._player.set_state(Gst.State.PAUSED)
            self.state.mode = 'paused'

    def resume(self):
        with self.lock:
            if self.state.mode not in ('paused', 'loading'):
                raise ValueError(f'INVALID_STATE: cannot resume from {self.state.mode}')
            self._player.set_state(Gst.State.PLAYING)
            self.state.mode = 'playing'

    def stop(self):
        with self.lock:
            self._player.set_state(Gst.State.NULL)
            self.state.mode = 'idle'
            self.state.current_track = None
            self.state.current_playback_token = None
            self.state.position_seconds = 0.0
            self.state.duration_seconds = 0.0
            self.state.last_error = ''

    def set_volume(self, volume: float):
        volume = max(0.0, min(1.0, volume))
        with self.lock:
            self._player.set_property('volume', volume)
            self.state.volume = volume

    def seek(self, position_seconds: float):
        with self.lock:
            if self.state.mode not in ('playing', 'paused'):
                raise ValueError(f'INVALID_STATE: cannot seek from {self.state.mode}')
            ns = int(position_seconds * Gst.SECOND)
            ok = self._player.seek_simple(
                Gst.Format.TIME,
                Gst.SeekFlags.FLUSH | Gst.SeekFlags.KEY_UNIT,
                ns,
            )
            if not ok:
                raise ValueError('SEEK_ERROR: GStreamer seek failed')
            self.state.position_seconds = position_seconds

    def _refresh_position_locked(self):
        try:
            ok, pos = self._player.query_position(Gst.Format.TIME)
            if ok:
                self.state.position_seconds = pos / Gst.SECOND
        except Exception:
            pass
        try:
            ok, dur = self._player.query_duration(Gst.Format.TIME)
            if ok:
                self.state.duration_seconds = dur / Gst.SECOND
        except Exception:
            pass

    def snapshot(self) -> dict:
        with self.lock:
            self._refresh_position_locked()
            return self.state.to_dict()


class DualDeckEngine:
    """
    Manages two decks (A and B).
    active_deck: deck currently on air.
    standby_deck: deck available for preload/incoming track.
    """

    def __init__(self):
        self.deck_a = Deck('a', on_eos=self._on_active_eos)
        self.deck_b = Deck('b', on_eos=self._on_active_eos)
        self.active_deck_id = 'a'
        self.eos_count = 0
        self.last_command_at = 0
        self.updated_at = 0
        self.last_error = ''
        self.muted = False
        self._crossfade_thread = None
        self._global_volume = 1.0
        self._lock = threading.Lock()

    @property
    def active(self) -> Deck:
        return self.deck_a if self.active_deck_id == 'a' else self.deck_b

    @property
    def standby(self) -> Deck:
        return self.deck_b if self.active_deck_id == 'a' else self.deck_a

    def _ts(self):
        return int(time.time() * 1000)

    def _on_active_eos(self, deck_id: str):
        with self._lock:
            if deck_id == self.active_deck_id:
                self.eos_count += 1
                self.updated_at = self._ts()
                self._save()

    def _save(self):
        STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
        STATE_PATH.write_text(json.dumps(self._to_dict(), indent=2))

    def _to_dict(self) -> dict:
        active_snap = self.active.snapshot()
        return {
            'protocolVersion': PROTOCOL_VERSION,
            'workerId': WORKER_ID,
            'mode': active_snap['mode'],
            'currentTrack': active_snap['currentTrack'],
            'positionSeconds': active_snap['positionSeconds'],
            'durationSeconds': active_snap['durationSeconds'],
            'volume': self._global_volume,
            'muted': self.muted,
            'buffering': False,
            'eosCount': self.eos_count,
            'currentPlaybackToken': active_snap['currentPlaybackToken'],
            'lastError': active_snap['lastError'] or self.last_error,
            'updatedAt': self.updated_at,
            'lastCommandAt': self.last_command_at,
            'activeDeck': self.active_deck_id,
            'decks': {
                'a': self.deck_a.snapshot(),
                'b': self.deck_b.snapshot(),
            },
        }

    def snapshot(self) -> dict:
        self.updated_at = self._ts()
        data = self._to_dict()
        self._save()
        return data

    def play(self, uri: str, playback_token: str = '', track_meta: dict = None):
        with self._lock:
            self.active.stop()
            self.active.set_volume(self._global_volume)
            self.active.play(uri, playback_token, track_meta)
            self.last_command_at = self.updated_at = self._ts()
            self._save()

    def preload(self, uri: str, playback_token: str = '', track_meta: dict = None):
        with self._lock:
            self.standby.stop()
            self.standby.preload(uri, playback_token, track_meta)
            self.last_command_at = self.updated_at = self._ts()
            self._save()

    def crossfade(self, duration_seconds: float = 6.0):
        with self._lock:
            if self.standby.state.mode not in ('loading', 'paused', 'playing'):
                raise ValueError('INVALID_STATE: standby deck has no preloaded track')
            if self._crossfade_thread and self._crossfade_thread.is_alive():
                raise ValueError('INVALID_STATE: crossfade already in progress')
            self.standby.set_volume(0.0)
            if self.standby.state.mode in ('loading', 'paused'):
                self.standby.resume()
            t = threading.Thread(
                target=self._do_crossfade,
                args=(self.active_deck_id, duration_seconds),
                daemon=True,
            )
            self._crossfade_thread = t
        t.start()

    def _do_crossfade(self, outgoing_id: str, duration_seconds: float):
        steps = max(int(duration_seconds * 20), 1)
        sleep_time = duration_seconds / steps
        outgoing = self.deck_a if outgoing_id == 'a' else self.deck_b
        incoming = self.deck_b if outgoing_id == 'a' else self.deck_a
        for i in range(steps + 1):
            frac = i / steps
            outgoing.set_volume(max(0.0, self._global_volume * (1.0 - frac)))
            incoming.set_volume(min(self._global_volume, self._global_volume * frac))
            time.sleep(sleep_time)
        outgoing.stop()
        with self._lock:
            self.active_deck_id = 'b' if outgoing_id == 'a' else 'a'
            self.last_command_at = self.updated_at = self._ts()
            self._save()

    def pause(self):
        with self._lock:
            self.active.pause()
            self.last_command_at = self.updated_at = self._ts()
            self._save()

    def resume(self):
        with self._lock:
            self.active.resume()
            self.last_command_at = self.updated_at = self._ts()
            self._save()

    def stop(self):
        with self._lock:
            self.active.stop()
            self.standby.stop()
            self.last_command_at = self.updated_at = self._ts()
            self._save()

    def seek(self, position_seconds: float):
        with self._lock:
            self.active.seek(position_seconds)
            self.last_command_at = self.updated_at = self._ts()
            self._save()

    def set_volume(self, volume: float):
        volume = max(0.0, min(1.0, volume))
        with self._lock:
            self._global_volume = volume
            self.active.set_volume(volume)
            self.last_command_at = self.updated_at = self._ts()
            self._save()


ENGINE = DualDeckEngine()


def make_response(ok: bool, req_id: str, req_type: str, state: dict, error=None):
    resp = {'ok': ok, 'requestId': req_id, 'type': req_type, 'state': state}
    if error:
        resp['error'] = error
    return resp


class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        line = self.rfile.readline().decode('utf-8').strip()
        if not line:
            return
        req_id = '?'
        req_type = '?'
        try:
            req = json.loads(line)
            req_id = req.get('requestId', '?')
            req_type = req.get('type') or req.get('action', '?')

            if req_type in ('ping', 'status'):
                resp = make_response(True, req_id, req_type, ENGINE.snapshot())
            elif req_type == 'play':
                uri = req.get('uri')
                if not uri:
                    raise ValueError('INVALID_PARAMS: uri required')
                meta = {k: req[k] for k in ('trackId', 'title', 'artist', 'duration') if k in req}
                meta['uri'] = uri
                meta['loadedAt'] = int(time.time() * 1000)
                ENGINE.play(uri, req.get('playbackToken', ''), meta)
                resp = make_response(True, req_id, req_type, ENGINE.snapshot())
            elif req_type == 'preload':
                uri = req.get('uri')
                if not uri:
                    raise ValueError('INVALID_PARAMS: uri required')
                meta = {k: req[k] for k in ('trackId', 'title', 'artist', 'duration') if k in req}
                meta['uri'] = uri
                meta['loadedAt'] = int(time.time() * 1000)
                ENGINE.preload(uri, req.get('playbackToken', ''), meta)
                resp = make_response(True, req_id, req_type, ENGINE.snapshot())
            elif req_type == 'crossfade':
                duration = float(req.get('durationSeconds', 6.0))
                ENGINE.crossfade(duration)
                resp = make_response(True, req_id, req_type, ENGINE.snapshot())
            elif req_type == 'pause':
                ENGINE.pause()
                resp = make_response(True, req_id, req_type, ENGINE.snapshot())
            elif req_type == 'resume':
                ENGINE.resume()
                resp = make_response(True, req_id, req_type, ENGINE.snapshot())
            elif req_type == 'stop':
                ENGINE.stop()
                resp = make_response(True, req_id, req_type, ENGINE.snapshot())
            elif req_type == 'seek':
                pos = float(req.get('positionSeconds', 0))
                ENGINE.seek(pos)
                resp = make_response(True, req_id, req_type, ENGINE.snapshot())
            elif req_type == 'set-volume':
                vol = float(req.get('volume', 1.0))
                ENGINE.set_volume(vol)
                resp = make_response(True, req_id, req_type, ENGINE.snapshot())
            else:
                resp = make_response(False, req_id, req_type, ENGINE.snapshot(),
                                     {'code': 'UNKNOWN_ACTION', 'message': f'unknown action: {req_type}'})

        except ValueError as e:
            msg = str(e)
            code = ('INVALID_STATE' if 'INVALID_STATE' in msg
                    else 'SEEK_ERROR' if 'SEEK_ERROR' in msg
                    else 'INVALID_PARAMS')
            resp = make_response(False, req_id, req_type, ENGINE.snapshot(),
                                 {'code': code, 'message': msg})
        except Exception as e:
            resp = make_response(False, req_id, req_type, ENGINE.snapshot(),
                                 {'code': 'PLAYBACK_ERROR', 'message': str(e)})

        self.wfile.write((json.dumps(resp) + '\n').encode('utf-8'))


def shutdown(*_args):
    try:
        ENGINE.stop()
    finally:
        raise SystemExit(0)


signal.signal(signal.SIGINT, shutdown)
signal.signal(signal.SIGTERM, shutdown)

socketserver.ThreadingTCPServer.allow_reuse_address = True
with socketserver.ThreadingTCPServer((HOST, PORT), Handler) as server:
    server.allow_reuse_address = True
    server.serve_forever()
