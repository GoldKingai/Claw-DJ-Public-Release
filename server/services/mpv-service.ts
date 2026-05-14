/**
 * mpv-service.ts — Server-side dual-deck audio engine via mpv IPC.
 *
 * Drop-in replacement for deckStreamService: exposes dispatch(),
 * isConnected(), and toWorkerState() with identical semantics.
 *
 * Audio flows: mpv → PipeWire dj-audio null sink → OBS monitor capture.
 * This eliminates the browser deck SSE connection for audio playback.
 */

import { spawn, type ChildProcess } from 'child_process';
import net from 'net';
import fs from 'fs';
import type { WorkerState } from './dj-local-worker-protocol.js';
import type { DeckCommand } from './deck-stream-service.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const IS_WIN = process.platform === 'win32';
// On Linux: route through PipeWire dj-audio sink (Flow's setup, OBS captures it).
// On Windows: use mpv's auto-detected default device (laptop speakers / default WASAPI).
// Override either with MPV_AUDIO_DEVICE env var.
const AUDIO_DEVICE = process.env.MPV_AUDIO_DEVICE
  || (IS_WIN ? 'auto' : 'pipewire/dj-audio');
const MPV_BASE_URL = 'http://127.0.0.1:3001';
const POLL_MS = 200;
const CONNECT_RETRY_MS = 300;
const CONNECT_ATTEMPTS = 40; // 12 seconds total
const VOL_MAX = 100; // mpv volume scale (100 = normal, we cap at 100)

/**
 * IPC socket/pipe path — Unix domain socket on Linux/macOS, named pipe on Windows.
 * mpv's --input-ipc-server flag accepts both forms natively.
 */
function sockPath(id: 'a' | 'b'): string {
  if (IS_WIN) {
    return `\\\\.\\pipe\\mpv-deck-${id}`;
  }
  return `/tmp/mpv-deck-${id}.sock`;
}

function toAbsUrl(url: string): string {
  return url.startsWith('http') ? url : `${MPV_BASE_URL}${url}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ── Per-deck state ────────────────────────────────────────────────────────────

interface DeckState {
  mode: 'idle' | 'playing' | 'paused' | 'error';
  position: number;
  duration: number;
  mpvVolume: number;    // 0–100, what we last SET (avoids extra IPC round-trip)
  eosCount: number;
  trackId: string | null;
  trackTitle: string | null;
  trackArtist: string | null;
  lastError: string;
  updatedAt: number;
}

function freshDeckState(): DeckState {
  return {
    mode: 'idle', position: 0, duration: 0, mpvVolume: VOL_MAX,
    eosCount: 0, trackId: null, trackTitle: null, trackArtist: null,
    lastError: '', updatedAt: Date.now(),
  };
}

// ── MpvDeck: one mpv process + IPC socket ─────────────────────────────────────

class MpvDeck {
  readonly id: 'a' | 'b';
  private proc: ChildProcess | null = null;
  private sock: net.Socket | null = null;
  private _connected = false;
  private _starting = false;
  private buf = '';
  private reqCounter = 1;
  private pending = new Map<number, (data: unknown) => void>();
  private _pauseOverrideUntil = 0;
  state: DeckState;

  constructor(id: 'a' | 'b') {
    this.id = id;
    this.state = freshDeckState();
  }

  isConnected(): boolean { return this._connected; }

  async start(): Promise<void> {
    if (this._starting) return;
    this._starting = true;
    // Unix sockets need stale-file cleanup; named pipes don't (auto-cleanup).
    if (!IS_WIN) {
      try { fs.unlinkSync(sockPath(this.id)); } catch { /* no prior socket */ }
    }

    const mpvBin = process.env.MPV_BIN || (IS_WIN ? 'mpv.exe' : 'mpv');

    try {
      this.proc = spawn(mpvBin, [
        '--idle=yes',
        '--no-video',
        `--audio-device=${AUDIO_DEVICE}`,
        `--input-ipc-server=${sockPath(this.id)}`,
        `--volume=${VOL_MAX}`,
        '--volume-max=100',
        '--cache=yes',
        '--really-quiet',
        '--no-terminal',
      ], { detached: false });
    } catch (e) {
      console.warn(`[mpv deck-${this.id}] spawn failed (${(e as Error).message}). Browser-deck will handle playback.`);
      this._starting = false;
      this.state.lastError = 'mpv binary not found — running in browser-deck-only mode';
      return;
    }

    this.proc.on('error', (err: NodeJS.ErrnoException) => {
      // Triggered when mpv binary doesn't exist (ENOENT) — common on Windows
      // without mpv installed. Don't crash, don't retry — let browser-deck handle audio.
      this._connected = false;
      this._starting = false;
      if (err.code === 'ENOENT') {
        console.warn(`[mpv deck-${this.id}] mpv binary not found on PATH (set MPV_BIN env var to override). Browser-deck handles audio instead.`);
        this.state.lastError = 'mpv binary not installed';
      } else {
        console.warn(`[mpv deck-${this.id}] spawn error:`, err.message);
        this.state.lastError = err.message;
      }
    });

    this.proc.stderr?.on('data', (d: Buffer) => {
      const msg = d.toString().trim();
      if (msg) console.warn(`[mpv deck-${this.id}]`, msg);
    });

    this.proc.on('exit', (code) => {
      this._connected = false;
      this.sock = null;
      this._starting = false;
      // If mpv exited because the binary wasn't there (ENOENT path), don't keep retrying forever.
      if (this.state.lastError.includes('not installed') || this.state.lastError.includes('not found')) {
        return;
      }
      console.warn(`[mpv deck-${this.id}] exited (code=${code}), restarting in 2s`);
      setTimeout(() => { this.start().catch(console.error); }, 2000);
    });

    await this._waitConnect();
    this._starting = false;
  }

  private async _waitConnect(): Promise<void> {
    for (let i = 0; i < CONNECT_ATTEMPTS; i++) {
      try {
        await this._doConnect();
        return;
      } catch {
        await sleep(CONNECT_RETRY_MS);
      }
    }
    console.error(`[mpv deck-${this.id}] Could not connect to IPC socket after ${CONNECT_ATTEMPTS} attempts`);
  }

  private _doConnect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const sock = net.createConnection(sockPath(this.id));
      const t = setTimeout(() => { sock.destroy(); reject(new Error('timeout')); }, 2000);

      sock.once('connect', () => {
        clearTimeout(t);
        this.sock = sock;
        this._connected = true;
        this.buf = '';
        console.log(`[mpv deck-${this.id}] IPC connected`);
        resolve();
      });

      sock.on('data', (d: Buffer) => this._onData(d.toString()));

      sock.on('error', (e: Error) => {
        clearTimeout(t);
        if (!this._connected) reject(e);
      });

      sock.on('close', () => {
        clearTimeout(t);
        this._connected = false;
        this.sock = null;
        for (const cb of this.pending.values()) cb(null);
        this.pending.clear();
      });
    });
  }

  private _onData(raw: string): void {
    this.buf += raw;
    const lines = this.buf.split('\n');
    this.buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as Record<string, unknown>;
        if (typeof msg.request_id === 'number') {
          const cb = this.pending.get(msg.request_id as number);
          if (cb) {
            this.pending.delete(msg.request_id as number);
            cb(msg.error === 'success' ? msg.data : null);
          }
        } else if (typeof msg.event === 'string') {
          this._onEvent(msg.event as string, msg);
        }
      } catch { /* ignore malformed */ }
    }
  }

  private _onEvent(event: string, msg: Record<string, unknown>): void {
    switch (event) {
      case 'end-file':
        if (msg.reason === 'eof') {
          this.state.eosCount++;
          this.state.mode = 'idle';
          this.state.position = 0;
          this.state.updatedAt = Date.now();
        } else if (msg.reason === 'stop' || msg.reason === 'error') {
          this.state.mode = 'idle';
          if (msg.reason === 'error') {
            this.state.lastError = String(msg['file_error'] ?? 'playback error');
            // Preload failed — clear track identity so state is honest
            this.state.trackId = null;
            this.state.trackTitle = null;
            this.state.trackArtist = null;
          }
          this.state.updatedAt = Date.now();
        }
        break;
      case 'file-loaded':
        if (this.state.mode !== 'paused') this.state.mode = 'playing';
        this.state.updatedAt = Date.now();
        break;
      case 'playback-restart':
        if (this.state.mode !== 'paused') this.state.mode = 'playing';
        this.state.updatedAt = Date.now();
        break;
    }
  }

  /** Send IPC command, return response data. */
  cmd(args: unknown[]): Promise<unknown> {
    return new Promise(resolve => {
      if (!this._connected || !this.sock) { resolve(null); return; }
      const id = this.reqCounter++;
      this.pending.set(id, resolve);
      this.sock!.write(JSON.stringify({ command: args, request_id: id }) + '\n', err => {
        if (err) { this.pending.delete(id); resolve(null); }
      });
    });
  }

  /**
   * Unpause and guard against poll() overwriting mode for guardMs milliseconds.
   * Use this instead of raw cmd(['set_property','pause',false]) whenever we
   * explicitly start playback, to prevent the poll race from flipping mode back
   * to 'paused' before mpv has processed the command.
   */
  unpause(guardMs: number): void {
    this._pauseOverrideUntil = Date.now() + guardMs;
    void this.cmd(['set_property', 'pause', false]);
    this.state.mode = 'playing';
    this.state.updatedAt = Date.now();
  }

  /** Set volume and cache locally (avoids a get_property round-trip). */
  setVol(vol: number): void {
    const v = Math.max(0, Math.min(VOL_MAX, vol));
    this.state.mpvVolume = v;
    void this.cmd(['set_property', 'volume', v]);
  }

  /** Poll position/duration/pause from mpv. */
  async poll(): Promise<void> {
    if (!this._connected) return;
    const [pos, dur, paused] = await Promise.all([
      this.cmd(['get_property', 'time-pos']),
      this.cmd(['get_property', 'duration']),
      this.cmd(['get_property', 'pause']),
    ]);
    if (typeof pos === 'number') this.state.position = pos;
    if (typeof dur === 'number') this.state.duration = dur;
    if (typeof paused === 'boolean' && Date.now() >= this._pauseOverrideUntil) {
      if (paused && this.state.mode === 'playing') this.state.mode = 'paused';
      else if (!paused && this.state.mode === 'paused') this.state.mode = 'playing';
    }
    this.state.updatedAt = Date.now();
  }
}

// ── MpvService ────────────────────────────────────────────────────────────────

class MpvService {
  private readonly deckA = new MpvDeck('a');
  private readonly deckB = new MpvDeck('b');
  private _activeDeck: 'a' | 'b' = 'a';
  private _masterVolume = 1.0;           // 0.0–1.0 logical scale
  private _globalEosCount = 0;
  private _lastSeenEos = 0;
  private _crossfadeTimer: ReturnType<typeof setInterval> | null = null;
  private _rampTimer: ReturnType<typeof setInterval> | null = null; // cancels in-flight ramp on next call

  constructor() {
    this.deckA.start().catch(e => console.error('[mpv-service] deck-a start failed:', e));
    this.deckB.start().catch(e => console.error('[mpv-service] deck-b start failed:', e));
    const timer = setInterval(() => { this._poll().catch(() => {}); }, POLL_MS);
    if (timer.unref) timer.unref();
  }

  private active(): MpvDeck { return this._activeDeck === 'a' ? this.deckA : this.deckB; }
  private spare():  MpvDeck { return this._activeDeck === 'a' ? this.deckB : this.deckA; }

  private swapDecks(): void {
    this._activeDeck = this._activeDeck === 'a' ? 'b' : 'a';
    this._lastSeenEos = this.active().state.eosCount;
  }

  private async _poll(): Promise<void> {
    await Promise.all([this.deckA.poll(), this.deckB.poll()]);
    const eos = this.active().state.eosCount;
    if (eos > this._lastSeenEos) {
      this._globalEosCount += eos - this._lastSeenEos;
      this._lastSeenEos = eos;
    }
  }

  isConnected(): boolean {
    return this.active().isConnected();
  }

  dispatch(command: DeckCommand): boolean {
    const active = this.active();
    const spare  = this.spare();

    switch (command.type) {
      case 'play': {
        if (this._crossfadeTimer) { clearInterval(this._crossfadeTimer); this._crossfadeTimer = null; }
        void spare.cmd(['stop']);
        spare.state.mode = 'idle';
        void active.cmd(['loadfile', toAbsUrl(command.audioUrl), 'replace']);
        active.setVol(this._masterVolume * VOL_MAX);
        active.state.trackId    = command.trackId;
        active.state.trackTitle = command.title ?? null;
        active.state.trackArtist = command.artist ?? null;
        active.state.mode = 'playing';
        active.state.updatedAt = Date.now();
        break;
      }

      case 'preload': {
        // Load on spare deck, paused at volume 0 so it buffers without sound
        void spare.cmd(['loadfile', toAbsUrl(command.audioUrl), 'replace']);
        void spare.cmd(['set_property', 'pause', true]);
        spare.setVol(0);
        spare.state.trackId    = command.trackId;
        spare.state.trackTitle = command.title ?? null;
        spare.state.trackArtist = command.artist ?? null;
        spare.state.mode = 'paused';
        spare.state.updatedAt = Date.now();
        break;
      }

      case 'crossfade':
        this._doCrossfade(command.durationSeconds);
        break;

      case 'pause':
        void active.cmd(['set_property', 'pause', true]);
        active.state.mode = 'paused';
        break;

      case 'resume':
        void active.cmd(['set_property', 'pause', false]);
        active.state.mode = 'playing';
        break;

      case 'stop':
        if (this._crossfadeTimer) { clearInterval(this._crossfadeTimer); this._crossfadeTimer = null; }
        void active.cmd(['stop']);
        void spare.cmd(['stop']);
        active.state.mode = 'idle'; active.state.trackId = null;
        spare.state.mode  = 'idle'; spare.state.trackId  = null;
        break;

      case 'seek':
        void active.cmd(['seek', command.positionSeconds, 'absolute']);
        break;

      case 'set-volume':
        this._masterVolume = Math.max(0, Math.min(1, command.volume));
        active.setVol(this._masterVolume * VOL_MAX);
        break;

      case 'duck': {
        const duckTarget = (command.targetVol ?? 0.18) * VOL_MAX;
        console.log(`[mpv-service] Duck → ${duckTarget.toFixed(0)}% (from ${active.state.mpvVolume.toFixed(0)}%)`);
        this._ramp(active, duckTarget, (command.rampSecs ?? 0.4) * 1000);
        break;
      }

      case 'unduck': {
        const unduckTarget = this._masterVolume * VOL_MAX;
        console.log(`[mpv-service] Unduck → ${unduckTarget.toFixed(0)}%`);
        this._ramp(active, unduckTarget, (command.rampSecs ?? 0.8) * 1000);
        break;
      }

      case 'fade-to':
        this._ramp(active, command.volume * VOL_MAX, command.rampSecs * 1000);
        break;
    }
    return true;
  }

  /**
   * Attempt crossfade. Returns true if the crossfade was accepted (spare was
   * ready), false if aborted because the spare deck isn't loaded yet.
   * Safe to call repeatedly — will succeed once the spare deck finishes loading.
   */
  dispatchCrossfade(durationSeconds: number): boolean {
    return this._doCrossfade(durationSeconds);
  }

  private _doCrossfade(durationSeconds: number): boolean {
    if (this._crossfadeTimer) clearInterval(this._crossfadeTimer);
    const active = this.active();
    const spare  = this.spare();

    // Guard: if spare never loaded a track (preload failed), abort — keep current track playing
    if (spare.state.mode !== 'paused' || !spare.state.trackId) {
      console.warn(`[mpv-service] Crossfade aborted — spare not ready (mode=${spare.state.mode} trackId=${spare.state.trackId ?? 'null'})`);
      return false;
    }

    // Unpause spare (was preloaded paused at vol=0); guard covers full crossfade + 2s buffer
    spare.unpause(durationSeconds * 1000 + 2000);

    // Equal-power (constant-power) crossfade — professional standard.
    // gainA = cos(t × π/2), gainB = sin(t × π/2) where t: 0→1
    // This keeps perceived loudness constant throughout the blend (no midpoint dip).
    // 50ms steps = 20 Hz update rate — imperceptibly smooth at any duration.
    const STEP_MS = 50;
    const totalSteps = Math.max(20, Math.round((durationSeconds * 1000) / STEP_MS));
    const interval = (durationSeconds * 1000) / totalSteps;
    const target = this._masterVolume * VOL_MAX;
    let step = 0;

    this._crossfadeTimer = setInterval(() => {
      step++;
      const t = step / totalSteps;
      // Equal-power curve
      const gainB = Math.sin(t * Math.PI / 2);
      const gainA = Math.cos(t * Math.PI / 2);
      spare.setVol(gainB * target);
      active.setVol(gainA * target);

      if (step >= totalSteps) {
        clearInterval(this._crossfadeTimer!);
        this._crossfadeTimer = null;
        void active.cmd(['stop']);
        active.state.mode = 'idle';
        active.state.trackId = null;
        this.swapDecks();
        // Re-guard the new active deck so poll() can't flip it back to 'paused'
        this.active().unpause(3000);
        console.log(`[mpv-service] Crossfade complete → active=deck-${this._activeDeck} (${durationSeconds}s equal-power)`);
      }
    }, interval);
    return true;
  }

  private _ramp(deck: MpvDeck, targetVol: number, durationMs: number): void {
    // Cancel any in-flight ramp so the new target takes effect immediately
    if (this._rampTimer) { clearInterval(this._rampTimer); this._rampTimer = null; }
    const start = deck.state.mpvVolume;
    const STEPS = 10;
    const interval = Math.max(16, durationMs / STEPS);
    let step = 0;
    const timer = setInterval(() => {
      step++;
      deck.setVol(start + (targetVol - start) * (step / STEPS));
      if (step >= STEPS) {
        clearInterval(timer);
        if (this._rampTimer === timer) this._rampTimer = null;
      }
    }, interval);
    this._rampTimer = timer;
  }

  toWorkerState(): WorkerState {
    const s = this.active().state;
    return {
      protocolVersion: 2,
      workerId: 'mpv-deck',
      mode: s.mode,
      currentTrack: s.trackId
        ? {
            trackId: s.trackId,
            uri: `${MPV_BASE_URL}/api/tracks/${s.trackId}/stream`,
            title: s.trackTitle ?? undefined,
            artist: s.trackArtist ?? undefined,
            loadedAt: s.updatedAt,
          }
        : null,
      positionSeconds: s.position,
      durationSeconds: s.duration,
      volume: s.mpvVolume / VOL_MAX,
      muted: false,
      buffering: false,
      eosCount: this._globalEosCount,
      currentPlaybackToken: null,
      lastError: s.lastError,
      updatedAt: s.updatedAt,
      lastCommandAt: 0,
    };
  }
}

export const mpvService = new MpvService();
