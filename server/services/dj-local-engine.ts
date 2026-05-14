import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { TrackStore } from "../utils/music-scanner.js";
import { mpvService } from "./mpv-service.js";
import { deckStreamService } from "./deck-stream-service.js";
import type { WorkerState } from "./dj-local-worker-protocol.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, "../data/dj-local-engine.json");
const POLL_INTERVAL_MS = 500; // Faster poll so EOS → queue advance is responsive

export interface QueueItem {
  queueItemId: string;
  trackId: string;
  title: string;
  artist: string;
  duration: number;
  enqueuedAt: number;
  source: "manual" | "auto";
}

export interface LocalEngineState {
  authority: "local-engine";
  backend: "browser-deck";
  mode: "idle" | "loading" | "playing" | "paused" | "error";
  queue: QueueItem[];
  queueRevision: number;
  currentQueueItemId: string | null;
  currentTrackId: string | null;
  currentTrackTitle: string | null;
  currentTrackArtist: string | null;
  nextQueueItemId: string | null;
  crossfadeSeconds: number;
  workerConnected: boolean;
  workerStateAgeMs: number;
  workerState: WorkerState | null;
  lastError: string;
  updatedAt: number;
  deckDebug: {
    preloadedTrackId: string | null;  // track currently loaded on spare deck
    crossfadeTriggered: boolean;       // crossfade in flight
    preloadWindowActive: boolean;      // within 30s preload window
    nextTrackId: string | null;        // next queued track ID
  };
}

let _queueItemCounter = 0;
function nextQueueItemId(): string {
  return `qi_${Date.now()}_${++_queueItemCounter}`;
}

class DjLocalEngineService {
  private state: LocalEngineState = {
    authority: "local-engine",
    backend: "browser-deck",
    mode: "idle",
    queue: [],
    queueRevision: 0,
    currentQueueItemId: null,
    currentTrackId: null,
    currentTrackTitle: null,
    currentTrackArtist: null,
    nextQueueItemId: null,
    crossfadeSeconds: 6,
    workerConnected: false,
    workerStateAgeMs: 0,
    workerState: null,
    lastError: "",
    updatedAt: Date.now(),
    deckDebug: { preloadedTrackId: null, crossfadeTriggered: false, preloadWindowActive: false, nextTrackId: null },
  };

  private lastHandledEosCount = 0;
  private wasWorkerConnected = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private _refreshing = false;

  // Save-throttle: avoid writeFileSync on every 500ms position poll
  private _savedMode = '';
  private _savedQueueRevision = -1;
  private _savedCurrentTrackId: string | null = null;
  private _savedWorkerConnected = false;
  private _dataDirEnsured = false;

  // Auto-crossfade tracking
  private _lastBrowserTrackId: string | null = null;
  private _preloadedSpareId: string | null = null;
  private _crossfadeTriggered = false;
  // Late-preload crossfade: set to crossfade duration when we need to fire
  // crossfade but spare is still loading. We retry each poll cycle.
  private _pendingCrossfadeSecs: number | null = null;

  constructor() {
    this.load();
    this.startPolling();
  }

  // ── Persistence ─────────────────────────────────────────────────────────────

  private load(): void {
    try {
      if (fs.existsSync(STATE_FILE)) {
        const saved = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")) as Partial<LocalEngineState>;
        this.state.queue = saved.queue ?? this.state.queue;
        this.state.queueRevision = saved.queueRevision ?? this.state.queueRevision;
        this.state.nextQueueItemId = saved.nextQueueItemId ?? this.state.nextQueueItemId;
        this.state.crossfadeSeconds = saved.crossfadeSeconds ?? this.state.crossfadeSeconds;
        this.lastHandledEosCount = saved.workerState?.eosCount ?? 0;
      }
    } catch (err) {
      console.warn("[DJ Local Engine] Failed to load state:", err);
    }
  }

  private save(): void {
    try {
      if (!this._dataDirEnsured) {
        fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
        this._dataDirEnsured = true;
      }
      fs.writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 2), "utf-8");
    } catch (err) {
      console.warn("[DJ Local Engine] Failed to save state:", err);
      this._dataDirEnsured = false;
    }
  }

  /** Save only when meaningful state changes — skips position/rms-only updates from the 500ms poll. */
  private saveIfChanged(): void {
    if (
      this.state.mode !== this._savedMode ||
      this.state.queueRevision !== this._savedQueueRevision ||
      this.state.currentTrackId !== this._savedCurrentTrackId ||
      this.state.workerConnected !== this._savedWorkerConnected
    ) {
      this._savedMode = this.state.mode;
      this._savedQueueRevision = this.state.queueRevision;
      this._savedCurrentTrackId = this.state.currentTrackId;
      this._savedWorkerConnected = this.state.workerConnected;
      this.save();
    }
  }

  // ── Background polling ───────────────────────────────────────────────────────

  private startPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      this.refreshWorkerState().catch(() => {/* swallow */});
    }, POLL_INTERVAL_MS);
    if (this.pollTimer?.unref) this.pollTimer.unref();
  }

  // ── State access ─────────────────────────────────────────────────────────────

  snapshot(): LocalEngineState {
    const snap = JSON.parse(JSON.stringify(this.state)) as LocalEngineState;
    const nextItem = this.state.queue[0] ?? null;
    const ws2 = this.state.workerState;
    const remaining = ws2 ? Math.max(0, ws2.durationSeconds - ws2.positionSeconds) : 999;
    snap.deckDebug = {
      preloadedTrackId: this._preloadedSpareId,
      crossfadeTriggered: this._crossfadeTriggered,
      preloadWindowActive: remaining <= 30 && remaining > 0,
      nextTrackId: nextItem?.trackId ?? null,
    };
    return snap;
  }

  async refreshWorkerState(): Promise<LocalEngineState> {
    if (this._refreshing) return this.snapshot();
    this._refreshing = true;
    try {
      const isConnected = mpvService.isConnected();
      const ws = mpvService.toWorkerState();
      const eosCount = ws.eosCount ?? 0;

      const justReconnected = isConnected && !this.wasWorkerConnected;
      const workerRestarted = eosCount < this.lastHandledEosCount;

      if (workerRestarted) {
        console.warn("[DJ Local Engine] Browser source restart detected (eosCount reset). Reconciling state.");
        this.lastHandledEosCount = eosCount;
      }

      this.state.workerConnected = isConnected;
      this.wasWorkerConnected = isConnected;
      this.state.workerState = ws;
      this.state.workerStateAgeMs = ws.updatedAt > 0 ? Date.now() - ws.updatedAt : -1;

      // Reconciliation: engine was active but browser went idle (source reload / OBS scene switch)
      const playbackLost =
        (workerRestarted || justReconnected) &&
        (this.state.mode === "playing" || this.state.mode === "paused" || this.state.mode === "loading") &&
        ws.mode === "idle";

      if (playbackLost) {
        console.warn("[DJ Local Engine] Playback lost: browser source restarted or reconnected.");
        this.state.mode = "error";
        this.state.lastError = "playback lost: browser source restarted";
        this.state.currentQueueItemId = null;
        this.state.currentTrackId = null;
        this.state.currentTrackTitle = null;
        this.state.currentTrackArtist = null;
        if (this.state.queue.length > 0) {
          console.log("[DJ Local Engine] Auto-recovering: advancing to next queued track.");
          await this._advanceQueue();
        } else {
          this.state.mode = "idle";
          this.state.lastError = "";
        }
      } else {
        // Reattach after server restart
        const workerIsActive = ws.mode === "playing" || ws.mode === "paused";
        if (justReconnected && workerIsActive && this.state.currentTrackId === null) {
          console.log("[DJ Local Engine] Reattaching to live browser deck after restart.");
          this.state.currentTrackId = ws.currentTrack?.trackId ?? null;
          this.state.currentTrackTitle = ws.currentTrack?.title ?? null;
          this.state.currentTrackArtist = ws.currentTrack?.artist ?? null;
          this.state.currentQueueItemId = null;
        }
        // Only sync mode from worker when:
        //   1. Not mid-command (loading)
        //   2. mpv is actually connected (otherwise ws.mode is stuck at 'idle'
        //      forever and would overwrite our optimistic "playing" state
        //      every tick — causing the watchdog to think the engine is idle
        //      and re-trigger playback in an infinite loop). The browser-deck
        //      is the audio path on Windows; we trust the engine's own state
        //      machine instead of mpv's worker state in that case.
        if (this.state.mode !== "loading" && isConnected) {
          this.state.mode = ws.mode as LocalEngineState["mode"];
          this.state.lastError = ws.lastError || "";
        } else if (!isConnected) {
          // mpv unavailable — clear any stale "mpv not ready" errors
          if (this.state.lastError.toLowerCase().includes("mpv")) {
            this.state.lastError = "";
          }
        }
      }

      // EOS → auto-advance queue
      if (!playbackLost && eosCount > this.lastHandledEosCount) {
        this.lastHandledEosCount = eosCount;
        if (this._crossfadeTriggered) {
          // EOS from the old active deck during an in-flight crossfade — expected.
          // The queue and track identity are already updated; don't touch them.
          console.log("[DJ Local Engine] EOS during crossfade — consumed without queue advance.");
        } else {
          this.state.currentQueueItemId = null;
          this.state.currentTrackId = null;
          this.state.currentTrackTitle = null;
          this.state.currentTrackArtist = null;
          if (this.state.queue.length > 0) {
            await this._advanceQueue();
          } else {
            this.state.mode = "idle";
          }
        }
      }

      // ── Auto-crossfade: seamless track transitions ───────────────────────────
      // Reset tracking flags when browser moves to a new track.
      // Guard: ignore transient null trackId (e.g. briefly after a seek) so we
      // don't clear _preloadedSpareId and lose the already-loaded spare deck.
      const _newTrackId = ws.currentTrack?.trackId ?? null;
      if (_newTrackId !== null && _newTrackId !== this._lastBrowserTrackId) {
        this._lastBrowserTrackId = _newTrackId;
        this._crossfadeTriggered = false;
        this._pendingCrossfadeSecs = null;
        this._preloadedSpareId = null;
      }

      if (
        ws.mode === "playing" &&
        ws.durationSeconds > 0 &&
        this.state.queue.length > 0 &&
        mpvService.isConnected()
      ) {
        const remaining = ws.durationSeconds - ws.positionSeconds;
        const nextItem = this.state.queue[0];
        const PRELOAD_AHEAD_SECS = 30;

        // Preload spare deck when 30s remain (only once per track).
        // Guard !_crossfadeTriggered: spare deck is actively playing during a crossfade;
        // preloading onto it would overwrite the new track, killing the crossfade audio.
        if (remaining <= PRELOAD_AHEAD_SECS && this._preloadedSpareId !== nextItem.trackId && !this._crossfadeTriggered) {
          const nextTrack = TrackStore.getInstance().getById(nextItem.trackId);
          if (nextTrack) {
            console.log(`[DJ Local Engine] Auto-preload: "${nextTrack.title}" (${remaining.toFixed(0)}s remaining)`);
            mpvService.dispatch({
              type: "preload",
              trackId: nextTrack.id,
              audioUrl: `/api/tracks/${nextTrack.id}/stream`,
              title: nextTrack.title,
              artist: nextTrack.artist,
              duration: nextTrack.duration,
            });
            deckStreamService.dispatch({
              type: "preload",
              trackId: nextTrack.id,
              audioUrl: `/api/tracks/${nextTrack.id}/stream`,
              title: nextTrack.title,
              artist: nextTrack.artist,
              duration: nextTrack.duration,
            });
            this._preloadedSpareId = nextItem.trackId;
          }
        }

        // Trigger crossfade when crossfadeSeconds remain and spare is ready.
        // If the spare wasn't preloaded in time (queue arrived late), the preload
        // block above will have just dispatched it. We enter a pending state and
        // retry every poll tick — mpv-service internally aborts if spare isn't
        // paused yet, so retrying is safe. Once spare is paused the crossfade fires.
        if (
          remaining <= this.state.crossfadeSeconds + 0.5 &&
          !this._crossfadeTriggered
        ) {
          if (this._preloadedSpareId === nextItem.trackId) {
            // Spare was preloaded at least one tick ago — attempt crossfade.
            // mpv-service will abort silently if spare is still buffering, so
            // we keep retrying (don't set _crossfadeTriggered) until it accepts.
            // We detect acceptance by checking the spare deck's mode directly
            // via the mpv-service internal guard log, OR we check _pendingCrossfadeSecs
            // to know when to give up and fall back.
            const accepted = mpvService.dispatchCrossfade(this.state.crossfadeSeconds);
            if (accepted) {
              deckStreamService.dispatch({ type: "crossfade", durationSeconds: this.state.crossfadeSeconds });
              console.log(`[DJ Local Engine] Auto-crossfade → "${nextItem.title}" (${remaining.toFixed(1)}s remaining)`);
              this._crossfadeTriggered = true;
              this._preloadedSpareId = null;
              this._pendingCrossfadeSecs = null;

              // Advance queue now — spare deck is the new active track
              if (this.state.queue.length > 0) {
                const advancedItem = this.state.queue.shift()!;
                this.state.queueRevision++;
                this.state.nextQueueItemId = this.state.queue[0]?.queueItemId ?? null;
                this.state.currentQueueItemId = advancedItem.queueItemId;
                this.state.currentTrackId = advancedItem.trackId;
                this.state.currentTrackTitle = advancedItem.title;
                this.state.currentTrackArtist = advancedItem.artist;
              }
            } else {
              // Spare not ready yet — track how long we've been waiting
              if (this._pendingCrossfadeSecs === null) {
                console.log(`[DJ Local Engine] Crossfade pending (spare loading) → "${nextItem.title}" (${remaining.toFixed(1)}s remaining)`);
                this._pendingCrossfadeSecs = this.state.crossfadeSeconds;
              }
              // Fall back to direct play if spare never becomes ready in time
              if (remaining <= 0.5) {
                console.warn(`[DJ Local Engine] Crossfade timed out — falling back to direct play for "${nextItem.title}"`);
                this._crossfadeTriggered = true;
                this._pendingCrossfadeSecs = null;
                this._preloadedSpareId = null;
                if (this.state.queue.length > 0) {
                  await this._advanceQueue();
                }
              }
            }
          } else {
            // Preload dispatched this same tick — spare needs at least one poll
            // cycle to load. Set pending so we retry next tick.
            if (this._pendingCrossfadeSecs === null) {
              console.log(`[DJ Local Engine] Late-preload crossfade pending → "${nextItem.title}" (${remaining.toFixed(1)}s remaining)`);
              this._pendingCrossfadeSecs = this.state.crossfadeSeconds;
            }
            // Fall back to direct play if out of time
            if (remaining <= 0.5) {
              console.warn(`[DJ Local Engine] Crossfade timed out (no preload) — falling back to direct play for "${nextItem.title}"`);
              this._crossfadeTriggered = true;
              this._pendingCrossfadeSecs = null;
              this._preloadedSpareId = null;
              if (this.state.queue.length > 0) {
                await this._advanceQueue();
              }
            }
          }
        }
      }

      // Reconciliation: if the worker's active track differs from engine state
      // and no crossfade is in flight, adopt it. Catches manual crossfades or any
      // other case where the deck changes without going through the auto-advance path.
      if (
        !this._crossfadeTriggered &&
        ws.currentTrack?.trackId &&
        ws.currentTrack.trackId !== this.state.currentTrackId &&
        (ws.mode === "playing" || ws.mode === "paused")
      ) {
        const newTrackId = ws.currentTrack.trackId;
        const queueIdx = this.state.queue.findIndex((q) => q.trackId === newTrackId);
        if (queueIdx >= 0) {
          const consumed = this.state.queue.splice(0, queueIdx + 1);
          const item = consumed[consumed.length - 1];
          this.state.queueRevision++;
          this.state.nextQueueItemId  = this.state.queue[0]?.queueItemId ?? null;
          this.state.currentQueueItemId = item.queueItemId;
          this.state.currentTrackId    = item.trackId;
          this.state.currentTrackTitle = item.title;
          this.state.currentTrackArtist = item.artist;
        } else {
          // Not in queue — sync identity from worker
          this.state.currentTrackId    = newTrackId;
          this.state.currentTrackTitle  = ws.currentTrack.title ?? null;
          this.state.currentTrackArtist = ws.currentTrack.artist ?? null;
        }
        console.log(`[DJ Local Engine] Reconciled active track → "${this.state.currentTrackTitle}"`);
      }

      this.state.updatedAt = Date.now();
      this.saveIfChanged();
      return this.snapshot();
    } finally {
      this._refreshing = false;
    }
  }

  // ── Queue operations ─────────────────────────────────────────────────────────

  enqueue(trackId: string, source: QueueItem["source"] = "manual"): LocalEngineState {
    const track = TrackStore.getInstance().getById(trackId);
    if (!track) {
      this.state.lastError = "Track not found";
      this.state.updatedAt = Date.now();
      this.save();
      return this.snapshot();
    }
    const item: QueueItem = {
      queueItemId: nextQueueItemId(),
      trackId: track.id,
      title: track.title,
      artist: track.artist,
      duration: track.duration,
      enqueuedAt: Date.now(),
      source,
    };
    this.state.queue.push(item);
    this.state.queueRevision++;
    this.state.nextQueueItemId = this.state.queue[0]?.queueItemId ?? null;
    this.state.lastError = "";
    this.state.updatedAt = Date.now();
    this.save();
    return this.snapshot();
  }

  removeQueueIndex(index: number): LocalEngineState {
    if (index >= 0 && index < this.state.queue.length) {
      this.state.queue.splice(index, 1);
      this.state.queueRevision++;
      this.state.nextQueueItemId = this.state.queue[0]?.queueItemId ?? null;
      this.state.updatedAt = Date.now();
      this.save();
    }
    return this.snapshot();
  }

  removeQueueById(queueItemId: string): LocalEngineState {
    const idx = this.state.queue.findIndex((item) => item.queueItemId === queueItemId);
    if (idx !== -1) {
      this.state.queue.splice(idx, 1);
      this.state.queueRevision++;
      this.state.nextQueueItemId = this.state.queue[0]?.queueItemId ?? null;
      this.state.updatedAt = Date.now();
      this.save();
    }
    return this.snapshot();
  }

  moveQueueItem(fromIndex: number, toIndex: number): LocalEngineState {
    const len = this.state.queue.length;
    if (fromIndex < 0 || fromIndex >= len || toIndex < 0 || toIndex >= len) {
      return this.snapshot();
    }
    const [item] = this.state.queue.splice(fromIndex, 1);
    this.state.queue.splice(toIndex, 0, item);
    this.state.queueRevision++;
    this.state.nextQueueItemId = this.state.queue[0]?.queueItemId ?? null;
    this.state.updatedAt = Date.now();
    this.save();
    return this.snapshot();
  }

  clearQueue(): LocalEngineState {
    this.state.queue = [];
    this.state.queueRevision++;
    this.state.nextQueueItemId = null;
    this.state.lastError = "";
    this.state.updatedAt = Date.now();
    this.save();
    return this.snapshot();
  }

  setCrossfadeSeconds(seconds: number): LocalEngineState {
    this.state.crossfadeSeconds = Math.max(1, Math.min(30, seconds));
    this.state.updatedAt = Date.now();
    this.save();
    return this.snapshot();
  }

  // ── Playback commands ────────────────────────────────────────────────────────

  async playNow(trackId: string): Promise<LocalEngineState> {
    const track = TrackStore.getInstance().getById(trackId);
    if (!track) {
      this.state.lastError = "Track not found";
      this.state.mode = "error";
      this.state.updatedAt = Date.now();
      this.save();
      return this.snapshot();
    }

    // Remove this track from the queue if present — prevents it appearing as "next"
    this.state.queue = this.state.queue.filter(q => q.trackId !== trackId);
    this.state.queueRevision++;
    this.state.nextQueueItemId = this.state.queue[0]?.queueItemId ?? null;

    this.state.mode = "loading";
    this.state.updatedAt = Date.now();

    // Dual-dispatch: mpv (when available — Flow's setup) and browser-deck
    // (universal — works on any platform, plays through the dashboard browser
    // tab's Web Audio context). Browser-deck is the only audio path on
    // Windows-without-mpv, so it MUST be dispatched regardless of mpv state.
    const playCmd = {
      type: "play" as const,
      trackId: track.id,
      audioUrl: `/api/tracks/${track.id}/stream`,
      title: track.title,
      artist: track.artist,
      duration: track.duration,
    };
    if (mpvService.isConnected()) {
      mpvService.dispatch(playCmd);
    }
    deckStreamService.dispatch(playCmd);

    // Optimistic update — browser state will confirm on next poll
    this.state.mode = "playing";
    this.state.currentQueueItemId = null;
    this.state.currentTrackId = track.id;
    this.state.currentTrackTitle = track.title;
    this.state.currentTrackArtist = track.artist;
    this.state.workerConnected = true;
    this.state.lastError = "";

    this.state.updatedAt = Date.now();
    this.save();
    return this.snapshot();
  }

  async pause(): Promise<LocalEngineState> {
    // Browser-deck always dispatched (works without mpv); mpv if connected.
    if (mpvService.isConnected()) mpvService.dispatch({ type: "pause" });
    deckStreamService.dispatch({ type: "pause" });
    this.state.mode = "paused";
    this.state.lastError = "";
    this.state.updatedAt = Date.now();
    this.save();
    return this.snapshot();
  }

  async resume(): Promise<LocalEngineState> {
    if (mpvService.isConnected()) mpvService.dispatch({ type: "resume" });
    deckStreamService.dispatch({ type: "resume" });
    this.state.mode = "playing";
    this.state.lastError = "";
    this.state.updatedAt = Date.now();
    this.save();
    return this.snapshot();
  }

  async stop(): Promise<LocalEngineState> {
    if (mpvService.isConnected()) {
      mpvService.dispatch({ type: "stop" });
    }
    deckStreamService.dispatch({ type: "stop" });
    this._preloadedSpareId = null;
    this._crossfadeTriggered = false;
    this._pendingCrossfadeSecs = null;
    this.state.mode = "idle";
    this.state.currentQueueItemId = null;
    this.state.currentTrackId = null;
    this.state.currentTrackTitle = null;
    this.state.currentTrackArtist = null;
    this.state.lastError = "";
    this.state.updatedAt = Date.now();
    this.save();
    return this.snapshot();
  }

  async skip(): Promise<LocalEngineState> {
    if (this.state.queue.length === 0) {
      return this.stop();
    }
    return this._advanceQueue();
  }

  async seek(positionSeconds: number): Promise<LocalEngineState> {
    if (mpvService.isConnected()) mpvService.dispatch({ type: "seek", positionSeconds });
    deckStreamService.dispatch({ type: "seek", positionSeconds });
    this.state.lastError = "";
    this.state.updatedAt = Date.now();
    this.save();
    return this.snapshot();
  }

  async setVolume(volume: number): Promise<LocalEngineState> {
    if (mpvService.isConnected()) mpvService.dispatch({ type: "set-volume", volume });
    // deckStreamService doesn't currently expose set-volume (browser handles its
    // own volume), so omitting that dispatch here is intentional.
    this.state.lastError = "";
    this.state.updatedAt = Date.now();
    this.save();
    return this.snapshot();
  }

  async preload(trackId: string): Promise<LocalEngineState> {
    const track = TrackStore.getInstance().getById(trackId);
    if (!track) {
      this.state.lastError = "Track not found";
      this.state.updatedAt = Date.now();
      this.save();
      return this.snapshot();
    }
    const preloadCmd = {
      type: "preload" as const,
      trackId: track.id,
      audioUrl: `/api/tracks/${track.id}/stream`,
      title: track.title,
      artist: track.artist,
      duration: track.duration,
    };
    if (mpvService.isConnected()) mpvService.dispatch(preloadCmd);
    deckStreamService.dispatch(preloadCmd);
    this.state.lastError = "";
    this.state.updatedAt = Date.now();
    this.save();
    return this.snapshot();
  }

  async crossfade(durationSeconds = 6): Promise<LocalEngineState> {
    if (mpvService.isConnected()) mpvService.dispatch({ type: "crossfade", durationSeconds });
    deckStreamService.dispatch({ type: "crossfade", durationSeconds });
    this._crossfadeTriggered = true;
    // Advance the queue if the spare was preloaded — keeps engine state in sync
    // whether the crossfade was triggered automatically or manually via API.
    if (
      this._preloadedSpareId &&
      this.state.queue.length > 0 &&
      this.state.queue[0].trackId === this._preloadedSpareId
    ) {
      const advancedItem = this.state.queue.shift()!;
      this.state.queueRevision++;
      this.state.nextQueueItemId = this.state.queue[0]?.queueItemId ?? null;
      this.state.currentQueueItemId = advancedItem.queueItemId;
      this.state.currentTrackId    = advancedItem.trackId;
      this.state.currentTrackTitle = advancedItem.title;
      this.state.currentTrackArtist = advancedItem.artist;
      this._preloadedSpareId = null;
    }
    this.state.lastError = "";
    this.state.updatedAt = Date.now();
    this.save();
    return this.snapshot();
  }

  /** Duck music volume — used before TTS or on-command. */
  duck(targetVol = 0.18, rampSecs = 0.4): void {
    mpvService.dispatch({ type: "duck", targetVol, rampSecs });
  }

  /** Restore music volume after ducking. */
  unduck(rampSecs = 0.8): void {
    mpvService.dispatch({ type: "unduck", rampSecs });
  }

  /** Ramp music to a specific volume level over rampSecs (fade-in / fade-out). */
  fadeTo(volume: number, rampSecs = 1): void {
    mpvService.dispatch({ type: "fade-to", volume, rampSecs });
  }

  // ── Internal ─────────────────────────────────────────────────────────────────

  private async _advanceQueue(): Promise<LocalEngineState> {
    const next = this.state.queue.shift()!;
    this.state.queueRevision++;
    this.state.nextQueueItemId = this.state.queue[0]?.queueItemId ?? null;

    const track = TrackStore.getInstance().getById(next.trackId);
    if (!track) {
      this.state.lastError = `Queue track not found: ${next.trackId}`;
      this.state.mode = "error";
      this.state.updatedAt = Date.now();
      this.save();
      return this.snapshot();
    }

    this.state.mode = "loading";
    this.state.updatedAt = Date.now();

    // Dual-dispatch to mpv (when available) AND browser-deck (universal).
    const playCmd = {
      type: "play" as const,
      trackId: track.id,
      audioUrl: `/api/tracks/${track.id}/stream`,
      title: track.title,
      artist: track.artist,
      duration: track.duration,
    };
    if (mpvService.isConnected()) mpvService.dispatch(playCmd);
    deckStreamService.dispatch(playCmd);

    this.state.mode = "playing";
    this.state.currentQueueItemId = next.queueItemId;
    this.state.currentTrackId = track.id;
    this.state.currentTrackTitle = track.title;
    this.state.currentTrackArtist = track.artist;
    this.state.workerConnected = true;
    this.state.lastError = "";

    this.state.updatedAt = Date.now();
    this.save();
    return this.snapshot();
  }
}

export const djLocalEngine = new DjLocalEngineService();
