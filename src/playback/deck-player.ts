/**
 * Per-deck audio player.
 * Signal chain: AudioBufferSourceNode → AnalyserNode → EQ → deck GainNode → (crossfader in audio-engine).
 */
import audioEngine from './audio-engine';
import { EQProcessor } from './eq-processor';
import { WaveformAnalyzer } from './waveform-analyzer';

export type DeckId = 'A' | 'B';

export interface DeckCallbacks {
  onTimeUpdate?: (currentTime: number) => void;
  onEnded?: () => void;
  onLoaded?: (duration: number) => void;
}

export class DeckPlayer {
  readonly deck: DeckId;

  // Audio nodes
  private source: AudioBufferSourceNode | null = null;
  private analyserNode: AnalyserNode | null = null;
  private deckGain: GainNode | null = null;
  private eq: EQProcessor | null = null;
  private waveform: WaveformAnalyzer | null = null;

  // State
  private _buffer: AudioBuffer | null = null;
  private _isPlaying: boolean = false;
  private _startedAt: number = 0;   // context.currentTime when playback started
  private _offsetTime: number = 0;  // offset into the buffer (for seek / resume)
  private _playbackRate: number = 1;
  private _volume: number = 1;

  // Timer for time-update callbacks
  private timeUpdateInterval: ReturnType<typeof setInterval> | null = null;

  // Callbacks
  onTimeUpdate: ((currentTime: number) => void) | null = null;
  onEnded: (() => void) | null = null;
  onLoaded: ((duration: number) => void) | null = null;

  constructor(deck: DeckId, callbacks?: DeckCallbacks) {
    this.deck = deck;
    if (callbacks) {
      this.onTimeUpdate = callbacks.onTimeUpdate ?? null;
      this.onEnded = callbacks.onEnded ?? null;
      this.onLoaded = callbacks.onLoaded ?? null;
    }
  }

  // ── Public properties ────────────────────────────────────────────

  /** Current playback position in seconds. */
  get currentTime(): number {
    if (!this._isPlaying) return this._offsetTime;
    const ctx = audioEngine.getContext();
    const elapsed = (ctx.currentTime - this._startedAt) * this._playbackRate;
    return this._offsetTime + elapsed;
  }

  /** Duration of the loaded buffer in seconds (0 if nothing loaded). */
  get duration(): number {
    return this._buffer?.duration ?? 0;
  }

  get isPlaying(): boolean {
    return this._isPlaying;
  }

  get buffer(): AudioBuffer | null {
    return this._buffer;
  }

  // ── Lifecycle ────────────────────────────────────────────────────

  /**
   * Fetch and decode an audio file, then prepare internal nodes.
   * @param url URL or path to an audio file.
   */
  async loadTrack(url: string): Promise<void> {
    const ctx = audioEngine.getContext();

    const response = await fetch(url);
    const arrayBuffer = await response.arrayBuffer();
    this._buffer = await ctx.decodeAudioData(arrayBuffer);

    // (Re)create persistent nodes: analyser, EQ, deck gain
    this.analyserNode = ctx.createAnalyser();
    this.analyserNode.fftSize = 2048;
    this.analyserNode.smoothingTimeConstant = 0.8;

    this.eq = new EQProcessor(ctx);

    this.deckGain = ctx.createGain();
    this.deckGain.gain.value = this._volume;

    // Wire: analyser → EQ → deckGain → engine deck input (crossfader)
    this.eq.connect(this.analyserNode, this.deckGain);
    this.deckGain.connect(audioEngine.getDeckInput(this.deck));

    this.waveform = new WaveformAnalyzer(this.analyserNode);

    this._offsetTime = 0;
    this._isPlaying = false;

    this.onLoaded?.(this._buffer.duration);
  }

  // ── Transport ────────────────────────────────────────────────────

  /** Start or resume playback from the current offset. */
  play(): void {
    if (!this._buffer || this._isPlaying) return;

    const ctx = audioEngine.getContext();

    this.createSource();
    this.source!.start(0, this._offsetTime);

    this._startedAt = ctx.currentTime;
    this._isPlaying = true;

    this.startTimeUpdates();
  }

  /** Pause playback, retaining the current position. */
  pause(): void {
    if (!this._isPlaying) return;

    // Snapshot current position before stopping
    this._offsetTime = this.currentTime;
    this.destroySource();
    this._isPlaying = false;

    this.stopTimeUpdates();
  }

  /** Stop playback and reset position to the beginning. */
  stop(): void {
    this.destroySource();
    this._offsetTime = 0;
    this._isPlaying = false;

    this.stopTimeUpdates();
  }

  /**
   * Seek to a position in seconds.
   * If currently playing, playback continues from the new position.
   */
  seek(time: number): void {
    const wasPlaying = this._isPlaying;
    if (wasPlaying) {
      this.destroySource();
    }
    this._offsetTime = Math.max(0, Math.min(time, this.duration));
    if (wasPlaying) {
      const ctx = audioEngine.getContext();
      this.createSource();
      this.source!.start(0, this._offsetTime);
      this._startedAt = ctx.currentTime;
      this._isPlaying = true;
    }
  }

  // ── Volume & Pitch ──────────────────────────────────────────────

  /** Set deck volume (0-1). */
  setVolume(value: number): void {
    this._volume = Math.max(0, Math.min(1, value));
    if (this.deckGain) {
      this.deckGain.gain.value = this._volume;
    }
  }

  /** Set playback rate / pitch. 1 = normal, 0.5 = half speed, 2 = double speed. */
  setPitch(rate: number): void {
    this._playbackRate = Math.max(0.25, Math.min(4, rate));
    if (this.source) {
      this.source.playbackRate.value = this._playbackRate;
    }
  }

  // ── EQ access ───────────────────────────────────────────────────

  /** Get the EQ processor for this deck (available after loadTrack). */
  getEQ(): EQProcessor | null {
    return this.eq;
  }

  // ── Waveform / Analyser access ──────────────────────────────────

  /** Get the WaveformAnalyzer for this deck (available after loadTrack). */
  getWaveformAnalyzer(): WaveformAnalyzer | null {
    return this.waveform;
  }

  /** Get the raw AnalyserNode (available after loadTrack). */
  getAnalyserNode(): AnalyserNode | null {
    return this.analyserNode;
  }

  // ── Internal helpers ────────────────────────────────────────────

  /** Create a fresh AudioBufferSourceNode and wire it into the chain. */
  private createSource(): void {
    if (!this._buffer || !this.analyserNode) return;
    const ctx = audioEngine.getContext();

    this.source = ctx.createBufferSource();
    this.source.buffer = this._buffer;
    this.source.playbackRate.value = this._playbackRate;
    this.source.connect(this.analyserNode);

    this.source.onended = () => {
      // Only fire if we didn't manually stop
      if (this._isPlaying) {
        this._isPlaying = false;
        this._offsetTime = 0;
        this.stopTimeUpdates();
        this.onEnded?.();
      }
    };
  }

  /** Safely stop and disconnect the current source node. */
  private destroySource(): void {
    if (this.source) {
      try {
        this.source.onended = null;
        this.source.stop();
      } catch {
        // Already stopped — ignore
      }
      this.source.disconnect();
      this.source = null;
    }
  }

  private startTimeUpdates(): void {
    this.stopTimeUpdates();
    if (this.onTimeUpdate) {
      this.timeUpdateInterval = setInterval(() => {
        if (this._isPlaying) {
          this.onTimeUpdate?.(this.currentTime);
        }
      }, 50); // ~20 fps
    }
  }

  private stopTimeUpdates(): void {
    if (this.timeUpdateInterval !== null) {
      clearInterval(this.timeUpdateInterval);
      this.timeUpdateInterval = null;
    }
  }
}
