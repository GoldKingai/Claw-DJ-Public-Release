/**
 * AI DJ Service — Central brain for automated DJ mixing.
 *
 * Manages:
 * - Track queue (upcoming tracks)
 * - Single-deck playback (only one track plays at a time, no overlap)
 * - Crossfade transitions between tracks
 * - Auto-advance to next track when current ends
 * - Exposes analyser node for real-time spectrum visualization
 */

import audioEngine from '../playback/audio-engine.js';
import { DeckPlayer, type DeckId } from '../playback/deck-player.js';
import { libraryService, type TrackInfo } from '../library/library-service.js';

export interface QueuedTrack {
  id: string;
  title: string;
  artist: string;
  duration: number;
  bpm: number | null;
  genre: string;
}

export type DJState = 'IDLE' | 'PLAYING' | 'CROSSFADING' | 'LOADING';

type ChangeCallback = () => void;

class AiDjService {
  // ── State ──
  private _state: DJState = 'IDLE';
  private _queue: QueuedTrack[] = [];
  private _currentTrack: QueuedTrack | null = null;
  private _activeDeck: DeckId = 'A';
  private _playerA: DeckPlayer | null = null;
  private _playerB: DeckPlayer | null = null;
  private _initialized = false;
  private _crossfading = false;
  private _crossfadeTimer: number | null = null;
  private _progressTimer: number | null = null;
  private _currentTime = 0;
  private _duration = 0;
  private _listeners: Set<ChangeCallback> = new Set();

  // ── Crossfade settings ──
  crossfadeDuration = 6; // seconds

  // ── Ducking state ──
  private _isSpeaking = false;

  // ── Public getters ──

  get state(): DJState { return this._state; }
  get queue(): QueuedTrack[] { return [...this._queue]; }
  get currentTrack(): QueuedTrack | null { return this._currentTrack; }
  get activeDeck(): DeckId { return this._activeDeck; }
  get currentTime(): number { return this._currentTime; }
  get duration(): number { return this._duration; }
  get isPlaying(): boolean { return this._state === 'PLAYING' || this._state === 'CROSSFADING'; }

  /** Get the analyser node of the currently active deck for spectrum visualization */
  getActiveAnalyser(): AnalyserNode | null {
    const player = this._activeDeck === 'A' ? this._playerA : this._playerB;
    return player?.getAnalyserNode() ?? null;
  }

  /** Subscribe to state changes */
  onChange(cb: ChangeCallback): () => void {
    this._listeners.add(cb);
    return () => this._listeners.delete(cb);
  }

  private _notify() {
    this._listeners.forEach((cb) => cb());
  }

  // ── Initialization ──

  async init(): Promise<void> {
    if (this._initialized) return;

    await audioEngine.init();

    this._playerA = new DeckPlayer('A', {
      onEnded: () => this._onTrackEnded('A'),
      onTimeUpdate: (t) => {
        if (this._activeDeck === 'A') {
          this._currentTime = t;
          this._checkCrossfadePoint();
        }
      },
      onLoaded: (d) => {
        if (this._activeDeck === 'A') this._duration = d;
      },
    });

    this._playerB = new DeckPlayer('B', {
      onEnded: () => this._onTrackEnded('B'),
      onTimeUpdate: (t) => {
        if (this._activeDeck === 'B') {
          this._currentTime = t;
          this._checkCrossfadePoint();
        }
      },
      onLoaded: (d) => {
        if (this._activeDeck === 'B') this._duration = d;
      },
    });

    // Center crossfader — both decks audible during crossfade
    audioEngine.setCrossfade(0.5);

    this._initialized = true;
    this._startProgressUpdates();
  }

  // ── Queue Management ──

  /** Add a track to the end of the queue */
  enqueue(track: QueuedTrack): void {
    this._queue.push(track);
    this._notify();

    // If nothing is playing, auto-start
    if (this._state === 'IDLE') {
      this._playNext();
    }
  }

  /** Add multiple tracks to the queue */
  enqueueMany(tracks: QueuedTrack[]): void {
    this._queue.push(...tracks);
    this._notify();

    if (this._state === 'IDLE') {
      this._playNext();
    }
  }

  /** Remove a track from the queue by index */
  removeFromQueue(index: number): void {
    if (index >= 0 && index < this._queue.length) {
      this._queue.splice(index, 1);
      this._notify();
    }
  }

  /** Clear the entire queue */
  clearQueue(): void {
    this._queue = [];
    this._notify();
  }

  /** Shuffle the queue */
  shuffleQueue(): void {
    for (let i = this._queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this._queue[i], this._queue[j]] = [this._queue[j], this._queue[i]];
    }
    this._notify();
  }

  /** Auto-fill the queue from the library with random tracks */
  async autoFillQueue(count = 10): Promise<void> {
    try {
      const allTracks = await libraryService.getTracks();
      if (allTracks.length === 0) return;

      // Pick random tracks, avoiding duplicates with what's in queue
      const queueIds = new Set(this._queue.map((t) => t.id));
      if (this._currentTrack) queueIds.add(this._currentTrack.id);

      const available = allTracks.filter((t) => !queueIds.has(t.id));
      const shuffled = [...available].sort(() => Math.random() - 0.5);
      const picks = shuffled.slice(0, count);

      const queued: QueuedTrack[] = picks.map((t) => ({
        id: t.id,
        title: t.title,
        artist: t.artist,
        duration: t.duration,
        bpm: t.bpm,
        genre: t.genre,
      }));

      this.enqueueMany(queued);
    } catch (err) {
      console.error('[ai-dj] Failed to auto-fill queue:', err);
    }
  }

  // ── Playback Control ──

  /** Play a specific track immediately (stops current, skips queue) */
  async playNow(track: TrackInfo): Promise<void> {
    if (!this._initialized) await this.init();

    // Stop whatever is playing on both decks
    this._stopAll();

    const queued: QueuedTrack = {
      id: track.id,
      title: track.title,
      artist: track.artist,
      duration: track.duration,
      bpm: track.bpm,
      genre: track.genre,
    };

    this._currentTrack = queued;
    this._state = 'LOADING';
    this._notify();

    const player = this._getActivePlayer();
    const url = `/api/tracks/${track.id}/stream`;

    try {
      await player.loadTrack(url);
      this._duration = player.duration;

      // Set crossfader fully to active deck
      audioEngine.setCrossfade(this._activeDeck === 'A' ? 0 : 1);

      player.play();
      this._state = 'PLAYING';
      this._notify();
    } catch (err) {
      console.error('[ai-dj] Failed to play track:', err);
      this._state = 'IDLE';
      this._notify();
    }
  }

  /** Skip to the next track in the queue */
  async skipToNext(): Promise<void> {
    if (this._queue.length === 0) {
      // Auto-fill if queue is empty
      await this.autoFillQueue(5);
    }
    await this._playNext();
  }

  /** Pause the current track */
  pause(): void {
    const player = this._getActivePlayer();
    player.pause();
    this._state = 'IDLE';
    this._notify();
  }

  /** Resume the current track */
  resume(): void {
    if (!this._currentTrack) return;
    const player = this._getActivePlayer();
    player.play();
    this._state = 'PLAYING';
    this._notify();
  }

  /** Stop everything */
  stop(): void {
    this._stopAll();
    this._currentTrack = null;
    this._currentTime = 0;
    this._duration = 0;
    this._state = 'IDLE';
    this._notify();
  }

  // ── Ducking (DJ talk-over) ──

  /**
   * Duck the music for TTS/speech — drops music volume so the AI voice is clear.
   * Call this when TTS audio starts playing.
   */
  startSpeaking(): void {
    if (this._isSpeaking) return;
    this._isSpeaking = true;
    audioEngine.duck();
    this._notify();
  }

  /**
   * Restore music volume after TTS/speech ends.
   * Call this when TTS audio finishes.
   */
  stopSpeaking(): void {
    if (!this._isSpeaking) return;
    this._isSpeaking = false;
    audioEngine.unduck();
    this._notify();
  }

  /** Whether the AI is currently speaking (music is ducked). */
  get isSpeaking(): boolean { return this._isSpeaking; }

  /**
   * Configure how much the music ducks.
   * @param level Volume while ducked (0-1, default 0.20 = 20%)
   * @param rampDown Seconds to fade music down (default 0.4)
   * @param rampUp Seconds to fade music back up (default 0.8)
   */
  setDuckingConfig(level?: number, rampDown?: number, rampUp?: number): void {
    audioEngine.setDuckingConfig(level, rampDown, rampUp);
  }

  /** Get the TTS audio input node — connect TTS audio sources here. */
  getTtsInput(): GainNode {
    return audioEngine.getTtsInput();
  }

  // ── Internal: Playback ──

  private async _playNext(): Promise<void> {
    if (this._queue.length === 0) {
      // Try auto-fill
      await this.autoFillQueue(5);
      if (this._queue.length === 0) {
        this._state = 'IDLE';
        this._notify();
        return;
      }
    }

    if (!this._initialized) await this.init();

    const nextTrack = this._queue.shift()!;
    const inactiveDeck = this._activeDeck === 'A' ? 'B' : 'A';
    const inactivePlayer = inactiveDeck === 'A' ? this._playerA! : this._playerB!;

    // If currently playing, do a crossfade
    if (this._state === 'PLAYING' || this._state === 'CROSSFADING') {
      this._state = 'CROSSFADING';
      this._notify();

      // Load next track on the inactive deck
      const url = `/api/tracks/${nextTrack.id}/stream`;
      try {
        await inactivePlayer.loadTrack(url);
        inactivePlayer.play();

        // Perform crossfade
        await this._doCrossfade(inactiveDeck);

        // Now stop the old deck
        const oldPlayer = this._getActivePlayer();
        oldPlayer.stop();

        // Swap active deck
        this._activeDeck = inactiveDeck;
        this._currentTrack = nextTrack;
        this._duration = inactivePlayer.duration;
        this._state = 'PLAYING';
        this._notify();
      } catch (err) {
        console.error('[ai-dj] Crossfade failed:', err);
        this._state = 'PLAYING';
        this._notify();
      }
    } else {
      // Nothing playing — just load and play
      this._currentTrack = nextTrack;
      this._state = 'LOADING';
      this._notify();

      const player = this._getActivePlayer();
      const url = `/api/tracks/${nextTrack.id}/stream`;

      try {
        await player.loadTrack(url);
        this._duration = player.duration;
        audioEngine.setCrossfade(this._activeDeck === 'A' ? 0 : 1);
        player.play();
        this._state = 'PLAYING';
        this._notify();
      } catch (err) {
        console.error('[ai-dj] Failed to play next:', err);
        this._state = 'IDLE';
        this._notify();
      }
    }
  }

  private _doCrossfade(targetDeck: DeckId): Promise<void> {
    return new Promise((resolve) => {
      const steps = 60; // ~1 step per 100ms for smooth crossfade
      const stepDuration = (this.crossfadeDuration * 1000) / steps;
      let step = 0;

      const startValue = this._activeDeck === 'A' ? 0 : 1;
      const endValue = targetDeck === 'A' ? 0 : 1;

      if (this._crossfadeTimer) clearInterval(this._crossfadeTimer);

      this._crossfadeTimer = window.setInterval(() => {
        step++;
        const progress = step / steps;
        // Smooth ease (sine curve)
        const eased = (1 - Math.cos(progress * Math.PI)) / 2;
        const value = startValue + (endValue - startValue) * eased;
        audioEngine.setCrossfade(value);

        if (step >= steps) {
          if (this._crossfadeTimer) clearInterval(this._crossfadeTimer);
          this._crossfadeTimer = null;
          audioEngine.setCrossfade(endValue);
          resolve();
        }
      }, stepDuration);
    });
  }

  private _checkCrossfadePoint(): void {
    // Auto-crossfade when nearing end of track
    if (this._state !== 'PLAYING') return;
    if (this._duration <= 0) return;

    const remaining = this._duration - this._currentTime;

    // Start crossfade when remaining time equals crossfade duration + 1s buffer
    if (remaining <= this.crossfadeDuration + 1 && remaining > this.crossfadeDuration && this._queue.length > 0) {
      this._playNext();
    }
  }

  private _onTrackEnded(deck: DeckId): void {
    // Only act if this was the active deck
    if (deck !== this._activeDeck) return;
    if (this._state === 'CROSSFADING') return; // Already transitioning

    console.log(`[ai-dj] Track ended on deck ${deck}, advancing queue`);
    this._playNext();
  }

  private _stopAll(): void {
    if (this._crossfadeTimer) {
      clearInterval(this._crossfadeTimer);
      this._crossfadeTimer = null;
    }
    this._playerA?.stop();
    this._playerB?.stop();
    this._crossfading = false;
  }

  private _getActivePlayer(): DeckPlayer {
    return this._activeDeck === 'A' ? this._playerA! : this._playerB!;
  }

  private _startProgressUpdates(): void {
    // Update current time at ~20fps for UI
    if (this._progressTimer) clearInterval(this._progressTimer);
    this._progressTimer = window.setInterval(() => {
      if (this._state === 'PLAYING' || this._state === 'CROSSFADING') {
        const player = this._getActivePlayer();
        this._currentTime = player.currentTime;
      }
    }, 50);
  }
}

/** Singleton AI DJ service */
export const aiDjService = new AiDjService();
